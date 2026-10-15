"use strict";

let socket = null;
let peerConnection = null;
let localStream = null;
let iceServers = [];
let isStopping = false;
let creatingOffer = false;
let pendingCandidates = [];
let activeRoom = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let iceRestartAttempts = 0;

const preview = qs("preview");
const connectButton = qs("connect");
const stopButton = qs("stop");

function cameraConstraints(width, height) {
  return {
    audio: false,
    video: {
      facingMode: { ideal: qs("camera").value },
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 30, max: 30 },
    },
  };
}

async function captureCamera() {
  const requested = qs("resolution").value.split("x").map(Number);
  const fallbacks = requested[0] === 3840
    ? [[1920, 1080], [1280, 720]]
    : requested[0] === 1920
      ? [[1280, 720]]
      : [];

  try {
    return await navigator.mediaDevices.getUserMedia(
      cameraConstraints(requested[0], requested[1]),
    );
  } catch (error) {
    if (!["OverconstrainedError", "ConstraintNotSatisfiedError"].includes(error.name)
      || fallbacks.length === 0) {
      throw error;
    }

    setStatus("La resolución elegida no está disponible; probando una opción menor.");
    for (const [width, height] of fallbacks) {
      try {
        return await navigator.mediaDevices.getUserMedia(cameraConstraints(width, height));
      } catch (fallbackError) {
        if (!["OverconstrainedError", "ConstraintNotSatisfiedError"].includes(fallbackError.name)) {
          throw fallbackError;
        }
      }
    }
    throw error;
  }
}

function closePeerConnection() {
  if (peerConnection) peerConnection.close();
  peerConnection = null;
  pendingCandidates = [];
}

function createPeerConnection() {
  closePeerConnection();
  peerConnection = new RTCPeerConnection({ iceServers });
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(socket, { type: "ice", candidate: event.candidate.toJSON() });
    }
  };
  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === "connected") {
      iceRestartAttempts = 0;
      setStatus("Conectado: vídeo en directo.", "ok");
    } else if (peerConnection.connectionState === "failed") {
      if (iceRestartAttempts < 2) {
        iceRestartAttempts += 1;
        void restartPeerConnection();
      } else {
        setStatus("No se pudo restablecer el vídeo. Comprueba la red o la configuración TURN.", "error");
      }
    } else if (peerConnection.connectionState === "disconnected") {
      setStatus("La conexión de vídeo se ha interrumpido; esperando recuperación de la red.");
    }
  };
}

async function addRemoteCandidate(candidate) {
  if (!peerConnection || !peerConnection.remoteDescription
    || peerConnection.signalingState !== "stable") {
    if (pendingCandidates.length >= 256) {
      throw new Error("Se recibieron demasiados candidatos ICE antes de la respuesta. Reinicia el emparejamiento.");
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

async function createOffer(options = {}) {
  if (creatingOffer || !peerConnection
    || (peerConnection.localDescription && !options.iceRestart)
    || peerConnection.signalingState !== "stable") return;
  creatingOffer = true;
  try {
    const offer = await peerConnection.createOffer(options);
    await peerConnection.setLocalDescription(offer);
    sendSignal(socket, { type: "offer", sdp: peerConnection.localDescription });
    setStatus("Negociando la conexión de vídeo…");
  } finally {
    creatingOffer = false;
  }
}

async function restartPeerConnection() {
  const currentConnection = peerConnection;
  if (!currentConnection || creatingOffer
    || !socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("El vídeo se interrumpió. Esperando que vuelva la señalización y la red.", "error");
    return;
  }

  setStatus(`Intentando restablecer el vídeo (${iceRestartAttempts}/2)…`);
  try {
    await createOffer({ iceRestart: true });
  } catch (error) {
    console.error("ICE restart failed:", error);
    setStatus("No se pudo reiniciar ICE. Comprueba la conexión o el servidor TURN.", "error");
  }
}

async function handleSignal(message) {
  if (message.type === "joined") {
    reconnectAttempts = 0;
    const track = localStream.getVideoTracks()[0];
    const settings = track.getSettings();
    const width = settings.width || 0;
    const height = settings.height || 0;
    const [targetWidth, targetHeight] = qs("resolution").value.split("x").map(Number);
    const capabilities = track.getCapabilities?.();
    const maxWidth = capabilities?.width?.max;
    const actualResolution = width && height
      ? `Resolución capturada: ${width} × ${height}${settings.frameRate ? ` a ${Math.round(settings.frameRate)} FPS` : ""}.`
      : "La resolución capturada no está disponible en este navegador.";
    const targetNote = width && height && (width < targetWidth || height < targetHeight)
      ? ` No se alcanzó el objetivo de ${targetWidth} × ${targetHeight}.`
      : "";
    const capabilityNote = Number.isFinite(maxWidth)
      ? ` Capacidad máxima anunciada: ${maxWidth} px de ancho.`
      : "";
    qs("camera-info").textContent = `${actualResolution}${targetNote}${capabilityNote}`;
    setStatus("Cámara activa. Esperando al ordenador…", "ok");
    return;
  }
  if ((message.type === "peer-joined" || message.type === "peer-present")
    && message.role === "viewer") {
    if (!peerConnection) createPeerConnection();
    await createOffer();
    return;
  }
  if (message.type === "answer" && peerConnection) {
    await peerConnection.setRemoteDescription(message.sdp);
    await flushRemoteCandidates();
    return;
  }
  if (message.type === "ice") {
    await addRemoteCandidate(message.candidate || null);
    return;
  }
  if (message.type === "restart") {
    if (iceRestartAttempts < 2) {
      iceRestartAttempts += 1;
      await restartPeerConnection();
    } else {
      setStatus("No se pudo restablecer el vídeo. Comprueba la red o la configuración TURN.", "error");
    }
    return;
  }
  if (message.type === "hangup") {
    closePeerConnection();
    setStatus("El ordenador ha detenido el vídeo. Esperando reconexión…");
    return;
  }
  if (message.type === "peer-left") {
    closePeerConnection();
    setStatus("El ordenador se ha desconectado. Esperando reconexión…");
  }
}

function releaseCamera() {
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  preview.srcObject = null;
  qs("camera-info").textContent = "";
}

async function connectToRoom() {
  if (isStopping || !activeRoom || socket) return;
  try {
    iceServers = await loadIceServers();
    if (isStopping || !activeRoom || socket) return;
    createPeerConnection();
    socket = connectSignaling(activeRoom, "phone", handleSignal, finishConnection);
  } catch (error) {
    if (isStopping || !activeRoom) return;
    console.error("Phone signaling setup failed:", error);
    const delay = reconnectDelay(reconnectAttempts++);
    setStatus(`${error.message || "No se pudo conectar al servidor."} Se reintentará en ${Math.ceil(delay / 1000)} s.`, "error");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectToRoom, delay);
  }
}

function finishConnection(closedSocket, event) {
  if (socket !== closedSocket) return;
  socket = null;
  closePeerConnection();
  if (isStopping) return;
  if (event.code === 1008) {
    releaseCamera();
    activeRoom = null;
    connectButton.disabled = false;
    qs("generate-code").disabled = false;
    qs("copy-code").disabled = false;
    stopButton.disabled = true;
    setStatus("No se pudo emparejar. Comprueba el código privado y que no haya otra cámara conectada.", "error");
    return;
  }
  const delay = reconnectDelay(reconnectAttempts++);
  setStatus(`Se perdió la señalización. Reconectando en ${Math.ceil(delay / 1000)} s…`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectToRoom, delay);
}

async function start() {
  const room = getRoom();
  if (!hasValidRoom(room)) {
    setStatus("Genera un código privado en este teléfono y úsalo también en el ordenador.", "error");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("La cámara requiere HTTPS y un navegador actualizado. Abre la página con el dominio HTTPS.", "error");
    return;
  }

  isStopping = false;
  activeRoom = room;
  reconnectAttempts = 0;
  connectButton.disabled = true;
  qs("generate-code").disabled = true;
  qs("copy-code").disabled = true;
  stopButton.disabled = true;

  try {
    localStream = await captureCamera();
    preview.srcObject = localStream;
    stopButton.disabled = false;
    connectToRoom();
  } catch (error) {
    console.error("Phone camera setup failed:", error);
    isStopping = true;
    activeRoom = null;
    releaseCamera();
    closePeerConnection();
    connectButton.disabled = false;
    qs("generate-code").disabled = false;
    qs("copy-code").disabled = false;
    stopButton.disabled = true;
    const message = error.name === "NotAllowedError"
      ? "Permite el acceso a la cámara en el navegador y vuelve a intentarlo."
      : error.name === "NotFoundError"
        ? "No se encontró una cámara disponible en el teléfono."
        : error.name === "NotReadableError"
          ? "La cámara está ocupada por otra aplicación. Ciérrala y vuelve a intentarlo."
          : error.message || "No se pudo iniciar la cámara.";
    setStatus(message, "error");
  }
}

function stop() {
  isStopping = true;
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
  releaseCamera();
  connectButton.disabled = false;
  qs("generate-code").disabled = false;
  qs("copy-code").disabled = false;
  stopButton.disabled = true;
  setStatus("Cámara detenida.");
}

qs("generate-code").addEventListener("click", () => {
  qs("room").value = generateRoomCode();
  setStatus("Código privado generado. Cópialo en el ordenador; no lo publiques.", "ok");
});
qs("copy-code").addEventListener("click", copyRoomCode);
connectButton.addEventListener("click", start);
stopButton.addEventListener("click", stop);
window.addEventListener("beforeunload", stop);
