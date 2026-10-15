"use strict";

let socket = null;
let peerConnection = null;
let iceServers = [];
let pendingCandidates = [];
let isDisconnecting = false;
let activeRoom = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let iceRestartRequests = 0;

const remote = qs("remote");
const connectButton = qs("connect");
const disconnectButton = qs("disconnect");

function closePeerConnection() {
  if (peerConnection) peerConnection.close();
  peerConnection = null;
  pendingCandidates = [];
  remote.srcObject = null;
  qs("video-info").textContent = "";
}

function createPeerConnection() {
  closePeerConnection();
  peerConnection = new RTCPeerConnection({ iceServers });
  peerConnection.ontrack = (event) => {
    remote.srcObject = event.streams[0];
    setStatus("Vídeo recibido. Cámara conectada.", "ok");
  };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(socket, { type: "ice", candidate: event.candidate.toJSON() });
    }
  };
  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === "connected") {
      iceRestartRequests = 0;
      setStatus("Conectado: vídeo en directo.", "ok");
    } else if (peerConnection.connectionState === "failed") {
      if (iceRestartRequests < 2 && socket?.readyState === WebSocket.OPEN) {
        iceRestartRequests += 1;
        sendSignal(socket, { type: "restart" });
        setStatus(`Solicitando recuperar el vídeo (${iceRestartRequests}/2)…`);
      } else {
        setStatus("No se pudo restablecer el vídeo. Comprueba la red o configura un servidor TURN.", "error");
      }
    } else if (peerConnection.connectionState === "disconnected") {
      setStatus("La conexión de vídeo se ha interrumpido; esperando recuperación de la red.");
    }
  };
}

async function addRemoteCandidate(candidate) {
  if (!peerConnection || !peerConnection.remoteDescription) {
    if (pendingCandidates.length >= 256) {
      throw new Error("Se recibieron demasiados candidatos ICE antes de la oferta. Reinicia el emparejamiento.");
    }
    pendingCandidates.push(candidate);
    return;
  }
  await peerConnection.addIceCandidate(candidate);
}

async function flushRemoteCandidates() {
  const candidates = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of candidates) {
    await peerConnection.addIceCandidate(candidate);
  }
}

async function handleSignal(message) {
  if (message.type === "joined") {
    reconnectAttempts = 0;
    setStatus("Esperando a la cámara del teléfono…");
    return;
  }
  if (message.type === "peer-present" && message.role === "phone") {
    setStatus("Teléfono detectado. Esperando la oferta de vídeo…");
    return;
  }
  if (message.type === "peer-joined" && message.role === "phone") {
    setStatus("Teléfono conectado. Preparando vídeo…");
    return;
  }
  if (message.type === "ice") {
    await addRemoteCandidate(message.candidate || null);
    return;
  }
  if (message.type === "offer") {
    const earlyCandidates = pendingCandidates;
    createPeerConnection();
    pendingCandidates = earlyCandidates;
    await peerConnection.setRemoteDescription(message.sdp);
    await flushRemoteCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignal(socket, { type: "answer", sdp: peerConnection.localDescription });
    return;
  }
  if (message.type === "hangup") {
    closePeerConnection();
    setStatus("El teléfono ha detenido el vídeo.");
    return;
  }
  if (message.type === "peer-left") {
    closePeerConnection();
    setStatus("El teléfono se ha desconectado. Esperando reconexión…");
  }
}

function finishConnection(closedSocket, event) {
  if (socket !== closedSocket) return;
  socket = null;
  closePeerConnection();
  if (isDisconnecting) return;
  if (event.code === 1008) {
    activeRoom = null;
    connectButton.disabled = false;
    disconnectButton.disabled = true;
    setStatus("No se pudo emparejar. Comprueba el código privado y que no haya otro receptor conectado.", "error");
    return;
  }
  const delay = reconnectDelay(reconnectAttempts++);
  setStatus(`Se perdió la señalización. Reconectando en ${Math.ceil(delay / 1000)} s…`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectToRoom, delay);
}

async function connectToRoom() {
  if (isDisconnecting || !activeRoom || socket) return;
  connectButton.disabled = true;
  disconnectButton.disabled = false;
  try {
    iceServers = await loadIceServers();
    if (isDisconnecting || !activeRoom) return;
    socket = connectSignaling(activeRoom, "viewer", handleSignal, finishConnection);
    disconnectButton.disabled = false;
  } catch (error) {
    if (isDisconnecting || !activeRoom) return;
    console.error("Viewer setup failed:", error);
    const delay = reconnectDelay(reconnectAttempts++);
    setStatus(`${error.message || "No se pudo conectar al servidor."} Se reintentará en ${Math.ceil(delay / 1000)} s.`, "error");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectToRoom, delay);
  }
}

function connect() {
  const room = getRoom();
  if (!hasValidRoom(room)) {
    setStatus("Introduce el código privado generado en el teléfono (mínimo 22 caracteres).", "error");
    return;
  }
  activeRoom = room;
  isDisconnecting = false;
  reconnectAttempts = 0;
  connectToRoom();
}

function disconnect() {
  isDisconnecting = true;
  activeRoom = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    sendSignal(socket, { type: "hangup" });
    const currentSocket = socket;
    socket = null;
    currentSocket.close();
  }
  closePeerConnection();
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  setStatus("Desconectado.");
}

remote.addEventListener("loadedmetadata", () => {
  if (remote.videoWidth && remote.videoHeight) {
    qs("video-info").textContent =
      `Resolución de vídeo recibida: ${remote.videoWidth} × ${remote.videoHeight}.`;
  }
});
connectButton.addEventListener("click", connect);
disconnectButton.addEventListener("click", disconnect);
window.addEventListener("beforeunload", disconnect);
