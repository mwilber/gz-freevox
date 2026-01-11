import { ChatController } from "./modules/chat.js";
import { VoxController } from "./modules/vox.js";

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("message");
const statusEl = document.getElementById("status");
const voiceToggle = document.getElementById("voiceToggle");
const voiceStatus = document.getElementById("voiceStatus");

let socket;
let isTextStreaming = false;
let isVoiceActive = false;
let chatController;
let voxController;

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
    if (voxController) {
      voxController.handleSocketClose();
    }
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "error") {
      appendMessage("System", payload.message || "Something went wrong.", "assistant");
      if (chatController) {
        chatController.handleError();
      }
      updateComposerState();
      return;
    }

    if (chatController && chatController.handleSocketMessage(payload)) {
      return;
    }

    if (voxController) {
      voxController.handleSocketMessage(payload);
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

function setTextStreaming(value) {
  isTextStreaming = value;
  updateComposerState();
}

function setVoiceActive(value) {
  isVoiceActive = value;
  updateComposerState();
}

connect();

chatController = new ChatController({
  socket,
  appendMessage,
  chatEl: chat,
  formEl: form,
  inputEl: input,
  onStreamingChange: setTextStreaming,
  canSendMessage: () => !isVoiceActive
});

voxController = new VoxController({
  socket,
  appendMessage,
  chatEl: chat,
  voiceToggle,
  voiceStatus,
  onVoiceActiveChange: setVoiceActive,
  canStartVoice: () => !isTextStreaming
});
