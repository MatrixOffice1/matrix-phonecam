"use strict";

let socket = null;
let peerConnection = null;
let localStream = null;
let iceServers = [];
let isStopping = false;
let creatingOffer = false;
let pendingCandidates = [];

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
      setStatus("Conectado: vídeo en directo.", "ok");
    } else if (["failed", "disconnected"].includes(peerConnection.connectionState)) {
      setStatus("Conexión interrumpida. Comprueba la red o configura un servidor TURN.", "error");
    }
  };
}

async function addRemoteCandidate(candidate) {
  if (!peerConnection || !peerConnection.remoteDescription) {
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

async function createOffer() {
  if (creatingOffer || !peerConnection || peerConnection.localDescription) return;
  creatingOffer = true;
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal(socket, { type: "offer", sdp: peerConnection.localDescription });
    setStatus("Negociando la conexión de vídeo…");
  } finally {
    creatingOffer = false;
  }
}

async function handleSignal(message) {
  if (message.type === "joined") {
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

function finishConnection(closedSocket) {
  if (socket !== closedSocket) return;
  socket = null;
  closePeerConnection();
  releaseCamera();
  connectButton.disabled = false;
  stopButton.disabled = true;
  if (!isStopping) setStatus("Conexión cerrada. Puedes volver a emparejar el teléfono.");
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
  connectButton.disabled = true;
  qs("generate-code").disabled = true;
  qs("copy-code").disabled = true;
  stopButton.disabled = true;

  try {
    localStream = await captureCamera();
    preview.srcObject = localStream;
    iceServers = await loadIceServers();
    createPeerConnection();
    socket = connectSignaling(room, "phone", handleSignal, finishConnection);
    stopButton.disabled = false;
  } catch (error) {
    console.error("Phone camera setup failed:", error);
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
  if (socket) {
    isStopping = true;
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
