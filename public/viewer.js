"use strict";

let socket = null;
let peerConnection = null;
let iceServers = [];
let pendingCandidates = [];
let isDisconnecting = false;

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
      setStatus("Conectado: vídeo en directo.", "ok");
    } else if (["failed", "disconnected"].includes(peerConnection.connectionState)) {
      setStatus("Conexión interrumpida. Comprueba la red o configura un servidor TURN.", "error");
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

function finishConnection(closedSocket) {
  if (socket !== closedSocket) return;
  socket = null;
  closePeerConnection();
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  if (!isDisconnecting) setStatus("Conexión cerrada. Pulsa Conectar para volver a emparejar.");
}

async function connect() {
  const room = getRoom();
  if (!hasValidRoom(room)) {
    setStatus("Introduce el código privado generado en el teléfono (mínimo 22 caracteres).", "error");
    return;
  }
  isDisconnecting = false;
  connectButton.disabled = true;
  disconnectButton.disabled = true;
  try {
    iceServers = await loadIceServers();
    socket = connectSignaling(room, "viewer", handleSignal, finishConnection);
    disconnectButton.disabled = false;
  } catch (error) {
    console.error("Viewer setup failed:", error);
    connectButton.disabled = false;
    disconnectButton.disabled = true;
    setStatus(error.message || "No se pudo conectar al servidor.", "error");
  }
}

function disconnect() {
  if (socket) {
    isDisconnecting = true;
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
