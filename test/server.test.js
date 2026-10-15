"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, afterEach, before, test } = require("node:test");
const WebSocket = require("ws");
const { createServer } = require("../server");

const sockets = new Set();
const pairingCode = "a".repeat(36);
let application;
let baseUrl;
let webSocketUrl;

function openSocket(code = pairingCode, role = null) {
  const socket = new WebSocket(webSocketUrl, {
    headers: { Origin: baseUrl },
  });
  socket.on("error", () => {});
  sockets.add(socket);
  if (role) {
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "join", role, room: code }));
    });
  }
  return socket;
}

function nextMessage(socket, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for WebSocket message "${type}".`));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.once("open", () => socket.close());
      socket.once("unexpected-response", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    } else {
      socket.close();
    }
  });
}

before(async () => {
  application = createServer({
    port: 0,
    env: { STUN_URLS: "stun:stun.example.test:3478" },
  });
  await new Promise((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = application.server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  webSocketUrl = `ws://127.0.0.1:${port}/ws`;
});

afterEach(async () => {
  await Promise.all([...sockets].map(closeSocket));
  sockets.clear();
});

after(async () => {
  await new Promise((resolve) => {
    application.wss.close(() => application.server.close(resolve));
  });
});

test("serves the health check, application pages, and ICE configuration", async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, app: "Matrix PhoneCam" });

  const root = await fetch(baseUrl, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/viewer.html");

  for (const page of ["phone.html", "viewer.html"]) {
    const response = await fetch(`${baseUrl}/${page}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Matrix PhoneCam/);
  }

  const configuration = await fetch(`${baseUrl}/api/ice-servers`);
  assert.equal(configuration.headers.get("cache-control"), "no-store");
  const config = await configuration.json();
  assert.deepEqual(config, {
    iceServers: [{ urls: "stun:stun.example.test:3478" }],
  });
});

test("requires a private code and valid role, and permits only one device per role", async () => {
  const invalidRole = openSocket();
  await nextMessage(invalidRole, "server-ready");
  const invalidRoleError = nextMessage(invalidRole, "error");
  invalidRole.send(JSON.stringify({ type: "join", role: "admin", room: pairingCode }));
  assert.equal((await invalidRoleError).code, "invalid_role");
  await new Promise((resolve) => invalidRole.once("close", resolve));

  const invalid = openSocket();
  await nextMessage(invalid, "server-ready");
  const invalidRoomError = nextMessage(invalid, "error");
  invalid.send(JSON.stringify({ type: "join", role: "phone", room: "matrix-phonecam" }));
  assert.equal((await invalidRoomError).code, "invalid_pairing_code");
  await new Promise((resolve) => invalid.once("close", resolve));

  const phone = openSocket(pairingCode, "phone");
  await nextMessage(phone, "joined");

  const duplicatePhone = openSocket(pairingCode, "phone");
  assert.equal((await nextMessage(duplicatePhone, "error")).code, "role_already_connected");
  await new Promise((resolve) => duplicatePhone.once("close", resolve));

  const viewer = openSocket(pairingCode, "viewer");
  await nextMessage(viewer, "joined");

  const duplicateViewer = openSocket(pairingCode, "viewer");
  assert.equal((await nextMessage(duplicateViewer, "error")).code, "role_already_connected");
  await new Promise((resolve) => duplicateViewer.once("close", resolve));
});

test("relays valid WebRTC messages only between paired roles", async () => {
  const phone = openSocket(pairingCode, "phone");
  await nextMessage(phone, "joined");
  const viewerJoined = nextMessage(phone, "peer-joined");
  const viewer = openSocket(pairingCode, "viewer");
  await nextMessage(viewer, "joined");
  assert.equal((await viewerJoined).role, "viewer");

  const offer = { type: "offer", sdp: { type: "offer", sdp: "v=0\r\n" } };
  const receivedOffer = nextMessage(viewer, "offer");
  phone.send(JSON.stringify(offer));
  assert.deepEqual(await receivedOffer, offer);

  const candidate = {
    type: "ice",
    candidate: {
      candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    },
  };
  const receivedCandidate = nextMessage(viewer, "ice");
  phone.send(JSON.stringify(candidate));
  assert.deepEqual(await receivedCandidate, candidate);

  const answer = { type: "answer", sdp: { type: "answer", sdp: "v=0\r\n" } };
  const invalidSignal = nextMessage(viewer, "error");
  viewer.send(JSON.stringify(offer));
  assert.equal((await invalidSignal).code, "invalid_signal");

  const receivedAnswer = nextMessage(phone, "answer");
  viewer.send(JSON.stringify(answer));
  assert.deepEqual(await receivedAnswer, answer);

  const receivedRestart = nextMessage(phone, "restart");
  viewer.send(JSON.stringify({ type: "restart" }));
  assert.deepEqual(await receivedRestart, { type: "restart" });
  const invalidRestart = nextMessage(phone, "error");
  phone.send(JSON.stringify({ type: "restart" }));
  assert.equal((await invalidRestart).code, "invalid_signal");
});

test("isolates different private codes and rejects cross-origin WebSockets", async () => {
  const phone = openSocket(pairingCode, "phone");
  await nextMessage(phone, "joined");
  const otherPhone = openSocket("b".repeat(36), "phone");
  await nextMessage(otherPhone, "joined");

  const otherViewer = openSocket("b".repeat(36), "viewer");
  await nextMessage(otherViewer, "joined");
  const isolatedOffer = nextMessage(otherViewer, "offer");
  otherPhone.send(JSON.stringify({
    type: "offer",
    sdp: { type: "offer", sdp: "v=0\r\n" },
  }));
  assert.equal((await isolatedOffer).type, "offer");

  const rejected = new WebSocket(webSocketUrl, {
    headers: { Origin: "https://attacker.example" },
  });
  rejected.on("error", () => {});
  sockets.add(rejected);
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Origin check timed out.")), 2000);
    rejected.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      resolve(response.statusCode);
    });
    rejected.once("open", () => {
      clearTimeout(timeout);
      reject(new Error("Cross-origin WebSocket unexpectedly opened."));
    });
  });
  assert.equal(status, 403);
});

test("issues expiring TURN REST credentials without returning the shared secret", async () => {
  const sharedSecret = "test-secret-not-for-production";
  const serverWithTurn = createServer({
    port: 0,
    env: {
      STUN_URLS: " ",
      TURN_URLS: "turn:turn.example.test:3478?transport=udp",
      TURN_SHARED_SECRET: sharedSecret,
      TURN_CREDENTIAL_TTL_SECONDS: "600",
    },
  });
  await new Promise((resolve, reject) => {
    serverWithTurn.server.once("error", reject);
    serverWithTurn.server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = serverWithTurn.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ice-servers`);
    const payload = await response.json();
    const turnServer = payload.iceServers[0];
    const expectedCredential = crypto.createHmac("sha1", sharedSecret)
      .update(turnServer.username)
      .digest("base64");
    assert.deepEqual(turnServer.urls, ["turn:turn.example.test:3478?transport=udp"]);
    assert.match(turnServer.username, /^\d+:phonecam$/);
    assert.equal(turnServer.credential, expectedCredential);
    const expiration = Number(turnServer.username.split(":")[0]) * 1000;
    assert.ok(expiration >= Date.now() + 598_000);
    assert.ok(expiration <= Date.now() + 600_000);
    assert.equal(JSON.stringify(payload).includes(sharedSecret), false);
  } finally {
    await new Promise((resolve) => {
      serverWithTurn.wss.close(() => serverWithTurn.server.close(resolve));
    });
  }
});
