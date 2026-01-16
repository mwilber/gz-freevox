import { ChatController } from "./modules/chat.js";
import { VoxController } from "./modules/vox.js";
import { MarkdownRenderer } from "./modules/markdown.js";

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
			const detail = payload.detail ? ` (${payload.detail})` : "";
			appendMessage("System", `${payload.message || "Something went wrong."}${detail}`, "assistant");
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
	wrapper.getRawText = () => body.dataset.rawText || "";
	wrapper.updateBody = (nextText, { allowMarkdown = false } = {}) => {
		body.dataset.rawText = nextText;
		if (allowMarkdown && MarkdownRenderer.hasMarkdown(nextText)) {
			body.innerHTML = MarkdownRenderer.render(nextText);
			body.classList.add("message__body--markdown");
		} else {
			body.textContent = nextText;
			body.classList.remove("message__body--markdown");
		}
	};
	wrapper.updateBody(text, { allowMarkdown: true });

	wrapper.appendChild(meta);
	wrapper.appendChild(body);
	chat.appendChild(wrapper);
	chat.scrollTop = chat.scrollHeight;

	return wrapper;
}

function appendToolResult(toolName, content) {
	const wrapper = document.createElement("div");
	wrapper.className = "message message--tool";

	const summary = document.createElement("button");
	summary.type = "button";
	summary.className = "tool-result__summary";
	summary.setAttribute("aria-expanded", "false");
	summary.textContent = `Tool: ${toolName}`;

	const body = document.createElement("pre");
	body.className = "tool-result__content";
	body.hidden = true;
	body.textContent = formatToolContent(content);

	summary.addEventListener("click", () => {
		const nextHidden = !body.hidden;
		body.hidden = nextHidden;
		summary.setAttribute("aria-expanded", String(!nextHidden));
	});

	wrapper.appendChild(summary);
	wrapper.appendChild(body);
	chat.appendChild(wrapper);
	chat.scrollTop = chat.scrollHeight;

	return wrapper;
}

function formatToolContent(content) {
	if (typeof content !== "string") {
		try {
			return JSON.stringify(content, null, 2);
		} catch (err) {
			return String(content);
		}
	}

	try {
		const parsed = JSON.parse(content);
		return JSON.stringify(parsed, null, 2);
	} catch (err) {
		return content;
	}
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
	appendToolResult,
	chatEl: chat,
	formEl: form,
	inputEl: input,
	onStreamingChange: setTextStreaming,
	canSendMessage: () => !isVoiceActive
});

voxController = new VoxController({
	socket,
	appendMessage,
	appendToolResult,
	chatEl: chat,
	voiceToggle,
	voiceStatus,
	onVoiceActiveChange: setVoiceActive,
	canStartVoice: () => !isTextStreaming
});
