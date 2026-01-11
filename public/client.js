const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("message");
const statusEl = document.getElementById("status");
const voiceToggle = document.getElementById("voiceToggle");
const voiceStatus = document.getElementById("voiceStatus");

let socket;
let currentAssistantEl = null;
let isTextStreaming = false;
let isVoiceActive = false;
let voiceStream = null;
let voiceContext = null;
let voiceProcessor = null;
let voiceSource = null;
let voiceSilence = null;
let playbackContext = null;
let playbackTime = 0;
let playbackNodes = [];
let voiceAssistantEl = null;
let voiceUserEl = null;

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener("open", () => {
    statusEl.textContent = "Connected";
    statusEl.style.color = "#3c6e3c";
  });

  socket.addEventListener("close", () => {
    statusEl.textContent = "Disconnected";
    statusEl.style.color = "#9b3e25";
    stopVoiceSession({ notifyServer: false });
    updateVoiceUi(false);
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "assistant_delta") {
      if (!currentAssistantEl) {
        currentAssistantEl = appendMessage("Assistant", "", "assistant");
      }
      currentAssistantEl.querySelector(".message__body").textContent += payload.delta;
      chat.scrollTop = chat.scrollHeight;
    }

    if (payload.type === "assistant_done") {
      isTextStreaming = false;
      currentAssistantEl = null;
      updateComposerState();
    }

    if (payload.type === "error") {
      appendMessage("System", payload.message || "Something went wrong.", "assistant");
      isTextStreaming = false;
      currentAssistantEl = null;
      updateComposerState();
    }

    if (payload.type === "assistant_voice_text_delta") {
      if (!voiceAssistantEl) {
        voiceAssistantEl = appendMessage("Assistant", "", "assistant");
      }
      voiceAssistantEl.querySelector(".message__body").textContent += payload.delta;
      chat.scrollTop = chat.scrollHeight;
    }

    if (payload.type === "assistant_voice_text_done") {
      voiceAssistantEl = null;
    }

    if (payload.type === "user_voice_text_delta") {
      if (!voiceUserEl) {
        voiceUserEl = appendMessage("You", "", "user");
      }
      voiceUserEl.querySelector(".message__body").textContent += payload.delta;
      chat.scrollTop = chat.scrollHeight;
    }

    if (payload.type === "user_voice_text_done") {
      voiceUserEl = null;
    }

    if (payload.type === "assistant_audio_delta") {
      queueAudioPlayback(payload.audio || "");
    }

    if (payload.type === "assistant_audio_interrupt") {
      stopPlayback();
    }

    if (payload.type === "assistant_audio_done") {
      playbackTime = Math.max(playbackTime, playbackContext ? playbackContext.currentTime : 0);
    }
  });
}

function appendMessage(label, text, role) {
  const wrapper = document.createElement("div");
  wrapper.className = `message message--${role}`;

  const meta = document.createElement("div");
  meta.className = "message__label";
  meta.textContent = label;

  const body = document.createElement("div");
  body.className = "message__body";
  body.textContent = text;

  wrapper.appendChild(meta);
  wrapper.appendChild(body);
  chat.appendChild(wrapper);
  chat.scrollTop = chat.scrollHeight;

  return wrapper;
}

function updateComposerState() {
  const disabled = isTextStreaming || isVoiceActive;
  input.disabled = disabled;
  form.querySelector("button").disabled = disabled;
  if (!disabled) {
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || isTextStreaming || isVoiceActive || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  appendMessage("You", text, "user");
  socket.send(JSON.stringify({ type: "user_message", text }));
  input.value = "";
  isTextStreaming = true;
  updateComposerState();
});

voiceToggle.addEventListener("click", () => {
  if (isVoiceActive) {
    stopVoiceSession({ notifyServer: true });
    return;
  }
  startVoiceSession();
});

async function startVoiceSession() {
  if (isVoiceActive || isTextStreaming || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (err) {
    appendMessage("System", "Microphone access was blocked.", "assistant");
    return;
  }

  voiceContext = new AudioContext({ sampleRate: 24000 });
  playbackContext = new AudioContext({ sampleRate: 24000 });
  await resumeAudioContext(playbackContext);
  await resumeAudioContext(voiceContext);

  voiceSource = voiceContext.createMediaStreamSource(voiceStream);
  voiceProcessor = voiceContext.createScriptProcessor(4096, 1, 1);
  voiceSilence = voiceContext.createGain();
  voiceSilence.gain.value = 0;

  voiceProcessor.onaudioprocess = (event) => {
    if (!isVoiceActive || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const inputData = event.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPCM(inputData);
    const base64 = pcm16ToBase64(pcm16);
    socket.send(JSON.stringify({ type: "audio_chunk", audio: base64 }));
  };

  voiceSource.connect(voiceProcessor);
  voiceProcessor.connect(voiceSilence);
  voiceSilence.connect(voiceContext.destination);

  isVoiceActive = true;
  socket.send(JSON.stringify({ type: "audio_start" }));
  updateVoiceUi(true);
  updateComposerState();
  stopPlayback();
}

function stopVoiceSession({ notifyServer }) {
  if (!isVoiceActive && !voiceStream) {
    return;
  }

  isVoiceActive = false;
  if (notifyServer && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "audio_stop" }));
  }

  if (voiceProcessor) {
    voiceProcessor.disconnect();
    voiceProcessor.onaudioprocess = null;
  }
  if (voiceSource) {
    voiceSource.disconnect();
  }
  if (voiceSilence) {
    voiceSilence.disconnect();
  }
  if (voiceStream) {
    voiceStream.getTracks().forEach((track) => track.stop());
  }
  stopPlayback();
  if (voiceContext) {
    voiceContext.close();
  }
  if (playbackContext) {
    playbackContext.close();
  }

  voiceStream = null;
  voiceContext = null;
  voiceProcessor = null;
  voiceSource = null;
  voiceSilence = null;
  playbackContext = null;
  voiceAssistantEl = null;
  voiceUserEl = null;
  updateVoiceUi(false);
  updateComposerState();
}

function updateVoiceUi(active) {
  if (!voiceToggle || !voiceStatus) {
    return;
  }
  voiceToggle.textContent = active ? "End voice" : "Start voice";
  voiceToggle.classList.toggle("is-active", active);
  voiceStatus.textContent = active ? "Listening and speaking in real time." : "Voice idle.";
}

function floatTo16BitPCM(float32Array) {
  const output = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function pcm16ToBase64(pcm16Array) {
  const bytes = new Uint8Array(pcm16Array.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToInt16(base64) {
  if (!base64) {
    return new Int16Array(0);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function queueAudioPlayback(base64) {
  if (!playbackContext || !base64) {
    return;
  }
  const pcm16 = base64ToInt16(base64);
  if (!pcm16.length) {
    return;
  }
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) {
    float32[i] = pcm16[i] / 0x8000;
  }

  const buffer = playbackContext.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);
  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);

  const startTime = Math.max(playbackContext.currentTime, playbackTime);
  source.start(startTime);
  playbackTime = startTime + buffer.duration;
  playbackNodes.push(source);
  source.onended = () => {
    playbackNodes = playbackNodes.filter((node) => node !== source);
  };
}

function stopPlayback() {
  playbackNodes.forEach((node) => {
    try {
      node.stop();
    } catch (err) {
      // Ignore playback stop errors.
    }
  });
  playbackNodes = [];
  playbackTime = playbackContext ? playbackContext.currentTime : 0;
}

async function resumeAudioContext(context) {
  if (!context) {
    return;
  }
  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch (err) {
      // Ignore resume errors.
    }
  }
}

connect();
