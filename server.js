"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const WebSocket = require("ws");

const APP_NAME = "Matrix PhoneCam";
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_ROOM_LENGTH = 128;
const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];
const HEARTBEAT_INTERVAL_MS = 30_000;

function parseList(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function createIceServers(env = process.env) {
  const urls = parseList(env.STUN_URLS, DEFAULT_STUN_URLS);
  const servers = urls.map((url) => ({ urls: url }));
  const turnUrls = parseList(env.TURN_URLS, []);

  if (turnUrls.length === 0) return servers;
  if (!env.TURN_SHARED_SECRET) {
    throw new Error("TURN_URLS requires TURN_SHARED_SECRET.");
  }

  const ttl = Number(env.TURN_CREDENTIAL_TTL_SECONDS || 3600);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new Error("TURN_CREDENTIAL_TTL_SECONDS must be between 60 and 86400.");
  }

  const username = `${Math.floor(Date.now() / 1000) + ttl}:phonecam`;
  const credential = crypto
    .createHmac("sha1", env.TURN_SHARED_SECRET)
    .update(username)
    .digest("base64");
  servers.push({ urls: turnUrls, username, credential });
  return servers;
}

function createApp(env = process.env) {
  const app = express();
  const publicDirectory = path.join(__dirname, "public");

  app.disable("x-powered-by");
  app.use(express.static(publicDirectory));
  app.get("/", (_request, response) => response.redirect("/viewer.html"));
  app.get("/health", (_request, response) => {
    response.json({ ok: true, app: APP_NAME });
  });
  app.get("/api/ice-servers", (_request, response, next) => {
    try {
      response.set("Cache-Control", "no-store").json({ iceServers: createIceServers(env) });
    } catch (error) {
      next(error);
    }
  });
  app.use((error, _request, response, _next) => {
    console.error("Application configuration error:", error.message);
    response.status(500).json({ error: "server_configuration_error" });
  });

  return app;
}

function originIsAllowed(request, expectedOrigin) {
  const origin = request.headers.origin;
  if (!origin) return true;

  try {
    const parsedOrigin = new URL(origin);
    if (expectedOrigin) {
      return parsedOrigin.origin === new URL(expectedOrigin).origin;
    }
    return parsedOrigin.host === request.headers.host;
  } catch {
    return false;
  }
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendError(socket, code) {
  send(socket, { type: "error", code });
}

function rejectJoin(socket, code) {
  sendError(socket, code);
  socket.close(1008, code);
}

function validSignalMessage(socket, message) {
  if (message.type === "restart") return socket.role === "viewer";
  if (message.type === "hangup") return true;

  if (message.type === "offer" || message.type === "answer") {
    const expectedRole = message.type === "offer" ? "phone" : "viewer";
    return socket.role === expectedRole
      && message.sdp
      && message.sdp.type === message.type
      && typeof message.sdp.sdp === "string"
      && message.sdp.sdp.length > 0
      && message.sdp.sdp.length <= 128 * 1024;
  }

  if (message.type === "ice") {
    if (message.candidate === null) return true;
    const candidate = message.candidate;
    return candidate
      && typeof candidate === "object"
      && typeof candidate.candidate === "string"
      && candidate.candidate.length <= 4096
      && (candidate.sdpMid === null || typeof candidate.sdpMid === "string")
      && (candidate.sdpMLineIndex === null
        || Number.isInteger(candidate.sdpMLineIndex));
  }

  return false;
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const port = options.port ?? Number(env.PORT || 3000);
  const host = options.host || "0.0.0.0";
  const expectedOrigin = env.PUBLIC_ORIGIN || "";

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  if (expectedOrigin) {
    const parsedOrigin = new URL(expectedOrigin);
    if (!["http:", "https:"].includes(parsedOrigin.protocol)
      || parsedOrigin.pathname !== "/"
      || parsedOrigin.search
      || parsedOrigin.hash) {
      throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a path.");
    }
  }
  createIceServers(env);

  const server = http.createServer(createApp(env));
  const wss = new WebSocket.Server({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  const rooms = new Map();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  server.once("close", () => clearInterval(heartbeat));

  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== "/ws" || !originIsAllowed(request, expectedOrigin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  });

  wss.on("connection", (socket) => {
    socket.role = null;
    socket.room = null;
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });
    send(socket, { type: "server-ready" });

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        sendError(socket, "binary_messages_not_supported");
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendError(socket, "invalid_json");
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        sendError(socket, "invalid_message");
        return;
      }

      if (message.type === "join") {
        if (socket.room) {
          rejectJoin(socket, "already_joined");
          return;
        }
        if (message.role !== "phone" && message.role !== "viewer") {
          rejectJoin(socket, "invalid_role");
          return;
        }
        if (typeof message.room !== "string"
          || message.room.length > MAX_ROOM_LENGTH
          || !ROOM_CODE_PATTERN.test(message.room)) {
          rejectJoin(socket, "invalid_pairing_code");
          return;
        }

        const room = rooms.get(message.room) || new Set();
        if ([...room].some((peer) => peer.role === message.role)) {
          rejectJoin(socket, "role_already_connected");
          return;
        }

        rooms.set(message.room, room);
        socket.role = message.role;
        socket.room = message.room;
        room.add(socket);
        send(socket, { type: "joined", role: socket.role });
        for (const peer of room) {
          if (peer === socket) continue;
          send(peer, { type: "peer-joined", role: socket.role });
          send(socket, { type: "peer-present", role: peer.role });
        }
        return;
      }

      if (!socket.room || !socket.role) {
        sendError(socket, "join_required");
        return;
      }
      if (!validSignalMessage(socket, message)) {
        sendError(socket, "invalid_signal");
        return;
      }

      const room = rooms.get(socket.room);
      const peer = room && [...room].find((candidate) => candidate !== socket);
      if (message.type === "hangup") {
        if (peer) send(peer, { type: "hangup", role: socket.role });
        return;
      }
      if (!peer) {
        if (message.type === "offer" || message.type === "answer" || message.type === "restart") {
          sendError(socket, "peer_not_connected");
        }
        return;
      }
      if ((message.type === "offer" && peer.role !== "viewer")
        || (message.type === "answer" && peer.role !== "phone")) {
        sendError(socket, "invalid_signal");
        return;
      }

      send(peer, message);
    });

    socket.on("close", () => {
      if (!socket.room) return;
      const room = rooms.get(socket.room);
      if (!room) return;
      room.delete(socket);
      for (const peer of room) {
        send(peer, { type: "peer-left", role: socket.role });
      }
      if (room.size === 0) rooms.delete(socket.room);
    });
  });

  return { server, wss, rooms };
}

if (require.main === module) {
  const { server } = createServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Matrix PhoneCam listening on 0.0.0.0:${server.address().port}`);
  });
  server.on("error", (error) => {
    console.error("HTTP server failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { createIceServers, createServer };
