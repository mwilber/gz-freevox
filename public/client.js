const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("message");
const statusEl = document.getElementById("status");

let socket;
let currentAssistantEl = null;
let isStreaming = false;

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
      isStreaming = false;
      currentAssistantEl = null;
      toggleInput();
    }

    if (payload.type === "error") {
      appendMessage("System", payload.message || "Something went wrong.", "assistant");
      isStreaming = false;
      currentAssistantEl = null;
      toggleInput();
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

function toggleInput() {
  input.disabled = isStreaming;
  form.querySelector("button").disabled = isStreaming;
  if (!isStreaming) {
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || isStreaming || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  appendMessage("You", text, "user");
  socket.send(JSON.stringify({ type: "user_message", text }));
  input.value = "";
  isStreaming = true;
  toggleInput();
});

connect();
