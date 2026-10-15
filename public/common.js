"use strict";

const MIN_PAIRING_CODE_LENGTH = 22;
const ERROR_MESSAGES = {
  already_joined: "Esta conexión ya estaba emparejada. Desconecta y vuelve a intentarlo.",
  invalid_pairing_code: "Código privado inválido. Genera uno nuevo en el teléfono y cópialo.",
  invalid_role: "Rol de conexión inválido.",
  invalid_signal: "El otro dispositivo envió un mensaje de conexión inválido.",
  peer_not_connected: "El otro dispositivo aún no está conectado.",
  role_already_connected: "Ya hay un dispositivo de este tipo conectado con ese código.",
};

function qs(id) {
  return document.getElementById(id);
}

function setStatus(message, kind = "") {
  const element = qs("status");
  if (element) element.textContent = message;
  if (element) element.className = `status ${kind}`;
}

function getRoom() {
  return qs("room").value.trim();
}

function hasValidRoom(room = getRoom()) {
  return /^[A-Za-z0-9_-]{22,128}$/.test(room);
}

function generateRoomCode() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wsUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

async function loadIceServers() {
  const response = await fetch("/api/ice-servers", { cache: "no-store" });
  if (!response.ok) throw new Error("No se pudo cargar la configuración ICE del servidor.");
  const configuration = await response.json();
  if (!Array.isArray(configuration.iceServers)) {
    throw new Error("La configuración ICE del servidor no es válida.");
  }
  return configuration.iceServers;
}

function sendSignal(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function listenForMessages(socket, handler, onClose) {
  let messageQueue = Promise.resolve();

  socket.addEventListener("message", (event) => {
    messageQueue = messageQueue
      .then(async () => {
        const message = JSON.parse(event.data);
        if (message.type === "error") {
          const text = ERROR_MESSAGES[message.code] || "Error en la conexión de señalización.";
          setStatus(text, "error");
          if (message.code === "role_already_connected"
            || message.code === "invalid_pairing_code"
            || message.code === "invalid_role"
            || message.code === "already_joined") {
            socket.close();
          }
          return;
        }
        await handler(message);
      })
      .catch((error) => {
        console.error("WebRTC signaling failed:", error);
        setStatus(error.message || "Error durante la negociación WebRTC.", "error");
      });
  });

  socket.addEventListener("close", (event) => onClose(socket, event));
  socket.addEventListener("error", () => {
    setStatus("No se pudo conectar al servidor. Comprueba HTTPS, el dominio y WebSockets.", "error");
  });
}

function reconnectDelay(attempt) {
  return Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
}

function connectSignaling(room, role, onMessage, onClose) {
  const socket = new WebSocket(wsUrl());
  let joined = false;

  listenForMessages(socket, async (message) => {
    if (message.type === "server-ready" && !joined) {
      joined = true;
      sendSignal(socket, { type: "join", role, room });
      return;
    }
    await onMessage(message);
  }, (closedSocket, event) => onClose(closedSocket, event));

  return socket;
}

async function copyRoomCode() {
  try {
    await navigator.clipboard.writeText(getRoom());
    setStatus("Código privado copiado. Compártelo solo con tu ordenador.", "ok");
  } catch {
    qs("room").focus();
    qs("room").select();
    setStatus("Selecciona y copia manualmente el código privado del teléfono.", "ok");
  }
}
