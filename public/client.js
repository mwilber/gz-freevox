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
		if (allowMarkdown && hasMarkdown(nextText)) {
			body.innerHTML = renderMarkdown(nextText);
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

function hasMarkdown(text) {
	return /```|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|^#{1,6}\s+|^\s*[-*]\s+|\[[^\]]+\]\([^)]+\)/m.test(
		text
	);
}

function renderMarkdown(text) {
	if (!text) {
		return "";
	}

	const codeBlocks = [];
	const textWithPlaceholders = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
		const index = codeBlocks.length;
		codeBlocks.push({ lang, code });
		return `@@CODEBLOCK_${index}@@`;
	});

	const escaped = escapeHtml(textWithPlaceholders);
	const lines = escaped.split("\n");
	let html = "";
	let inList = false;

	for (const line of lines) {
		const codePlaceholder = line.match(/^@@CODEBLOCK_(\d+)@@$/);
		if (codePlaceholder) {
			if (inList) {
				html += "</ul>";
				inList = false;
			}
			const block = codeBlocks[Number(codePlaceholder[1])];
			html += renderCodeBlock(block);
			continue;
		}

		const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
		if (headingMatch) {
			if (inList) {
				html += "</ul>";
				inList = false;
			}
			const level = headingMatch[1].length;
			html += `<h${level}>${applyInlineMarkdown(headingMatch[2])}</h${level}>`;
			continue;
		}

		const listMatch = line.match(/^\s*[-*]\s+(.*)$/);
		if (listMatch) {
			if (!inList) {
				html += "<ul>";
				inList = true;
			}
			html += `<li>${applyInlineMarkdown(listMatch[1])}</li>`;
			continue;
		}

		if (line.trim() === "") {
			if (inList) {
				html += "</ul>";
				inList = false;
			}
			continue;
		}

		if (inList) {
			html += "</ul>";
			inList = false;
		}

		html += `<p>${applyInlineMarkdown(line)}</p>`;
	}

	if (inList) {
		html += "</ul>";
	}

	return html;
}

function applyInlineMarkdown(text) {
	let output = text;
	output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
	output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
	return output;
}

function renderCodeBlock(block) {
	if (!block) {
		return "";
	}
	const language = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
	return `<pre><code${language}>${escapeHtml(block.code)}</code></pre>`;
}

function escapeHtml(text) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
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
