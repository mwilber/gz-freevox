import { ChatController } from "./modules/chat.js";
import { VoxController } from "./modules/vox.js";
import { MarkdownRenderer } from "./modules/markdown.js";

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("message");
const statusEl = document.getElementById("status");
const voiceToggle = document.getElementById("voiceToggle");
const voiceStatus = document.getElementById("voiceStatus");
const menuToggle = document.getElementById("menuToggle");
const conversationPanel = document.getElementById("conversationPanel");
const conversationList = document.getElementById("conversationList");
const panelClose = document.getElementById("panelClose");
const panelBackdrop = document.getElementById("panelBackdrop");
const currentConversationTitle = document.getElementById("currentConversationTitle");
const newConversationButton = document.getElementById("newConversation");

let socket;
let isTextStreaming = false;
let isVoiceActive = false;
let chatController;
let voxController;
let currentConversationId = null;
let openConversationMenu = null;
const conversationDumpRequests = new Map();

function requestConversationDump() {
	if (!socket || socket.readyState !== WebSocket.OPEN) {
		return Promise.reject(new Error("WebSocket is not connected."));
	}
	const requestId = typeof crypto !== "undefined" && crypto.randomUUID
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return new Promise((resolve) => {
		conversationDumpRequests.set(requestId, resolve);
		socket.send(JSON.stringify({ type: "conversation_dump", requestId }));
	});
}

function connect() {
	const protocol = window.location.protocol === "https:" ? "wss" : "ws";
	socket = new WebSocket(`${protocol}://${window.location.host}`);

	socket.addEventListener("open", () => {
		statusEl.textContent = "Connected";
		statusEl.style.color = "#3c6e3c";
		refreshConversations();
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
			const detail = payload.detail || undefined;
			const content = {
				message: payload.message || "Something went wrong.",
				detail
			};
			appendToolResult("System error", content, {
				variant: "error",
				label: "System error"
			});
			if (chatController) {
				chatController.handleError();
			}
			updateComposerState();
			return;
		}

		if (payload.type === "conversations_updated") {
			refreshConversations();
			return;
		}

		if (payload.type === "conversation_started") {
			currentConversationId = payload.conversation?.id || null;
			if (payload.conversation?.title) {
				setCurrentConversationTitle(payload.conversation.title);
			}
			refreshConversations();
			return;
		}

		if (payload.type === "conversation_dump") {
			const requestId = payload.requestId || null;
			const resolver = requestId ? conversationDumpRequests.get(requestId) : null;
			if (resolver) {
				conversationDumpRequests.delete(requestId);
				resolver(payload.messages || []);
				return;
			}
			console.log(payload.messages || []);
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
	if (role === "system") {
		return null;
	}
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

function appendToolResult(toolName, content, options = {}) {
	const wrapper = document.createElement("div");
	wrapper.className = "message message--tool";
	if (options.variant === "error") {
		wrapper.classList.add("message--tool-error");
	}

	const summary = document.createElement("button");
	summary.type = "button";
	summary.className = "tool-result__summary";
	summary.setAttribute("aria-expanded", "false");
	summary.textContent = options.label || `Tool: ${toolName}`;

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

function setCurrentConversationTitle(title) {
	if (!currentConversationTitle) {
		return;
	}
	currentConversationTitle.textContent = title || "New conversation";
}

function togglePanel(nextOpen) {
	const isOpen = typeof nextOpen === "boolean"
		? nextOpen
		: !conversationPanel.classList.contains("is-open");
	conversationPanel.classList.toggle("is-open", isOpen);
	conversationPanel.setAttribute("aria-hidden", String(!isOpen));
	panelBackdrop.hidden = !isOpen;
	menuToggle.setAttribute("aria-expanded", String(isOpen));
}

async function refreshConversations() {
	try {
		const response = await fetch("/conversations");
		if (!response.ok) {
			throw new Error(`Failed to load conversations: ${response.status}`);
		}
		const data = await response.json();
		renderConversations(data.conversations || []);
		if (currentConversationId) {
			const current = (data.conversations || []).find(
				(conversation) => conversation.id === currentConversationId
			);
			if (current) {
				setCurrentConversationTitle(current.title);
			}
		}
	} catch (error) {
		renderConversations([]);
	}
}

function renderConversations(conversations) {
	if (!conversationList) {
		return;
	}
	conversationList.innerHTML = "";
	if (!conversations.length) {
		const empty = document.createElement("div");
		empty.className = "conversation-item";
		empty.textContent = "No conversations yet.";
		conversationList.appendChild(empty);
		return;
	}
	conversations.forEach((conversation) => {
		const item = document.createElement("div");
		item.className = "conversation-item";
		if (conversation.id === currentConversationId) {
			item.classList.add("is-active");
		}

		const menuButton = document.createElement("button");
		menuButton.type = "button";
		menuButton.className = "conversation-menu";
		menuButton.setAttribute("aria-expanded", "false");
		menuButton.textContent = "⋯";

		const menuPanel = document.createElement("div");
		menuPanel.className = "conversation-menu__panel";
		menuPanel.hidden = true;

		const deleteButton = document.createElement("button");
		deleteButton.type = "button";
		deleteButton.className = "conversation-menu__action is-danger";
		deleteButton.textContent = "Delete Conversation";
		deleteButton.addEventListener("click", (event) => {
			event.stopPropagation();
			menuPanel.hidden = true;
			menuButton.setAttribute("aria-expanded", "false");
			if (openConversationMenu === menuPanel) {
				openConversationMenu = null;
			}
			handleDeleteConversation(conversation.id);
		});

		menuPanel.appendChild(deleteButton);

		menuButton.addEventListener("click", (event) => {
			event.stopPropagation();
			const willOpen = menuPanel.hidden;
			closeConversationMenu();
			menuPanel.hidden = !willOpen;
			menuButton.setAttribute("aria-expanded", String(willOpen));
			openConversationMenu = willOpen ? menuPanel : null;
		});

		const title = document.createElement("div");
		title.className = "conversation-item__title";
		title.textContent = conversation.title || "Untitled Conversation";
		const meta = document.createElement("div");
		meta.className = "conversation-item__meta";
		meta.textContent = conversation.updated_at
			? `Updated ${new Date(conversation.updated_at).toLocaleString()}`
			: "";
		item.appendChild(title);
		item.appendChild(meta);
		item.appendChild(menuButton);
		item.appendChild(menuPanel);
		item.addEventListener("click", () => {
			loadConversation(conversation.id);
			togglePanel(false);
		});
		conversationList.appendChild(item);
	});
}

async function loadConversation(conversationId) {
	try {
		const response = await fetch(`/conversations/${conversationId}`);
		if (!response.ok) {
			throw new Error(`Failed to load conversation: ${response.status}`);
		}
		const data = await response.json();
		const messages = data.messages || [];
		chat.innerHTML = "";
		messages.forEach((message) => {
			if (message.role === "system") {
				return;
			}
			const role = message.role === "user" ? "user" : "assistant";
			const label = message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : "System";
			appendMessage(label, message.content, role);
		});
		currentConversationId = conversationId;
		if (data.conversation?.title) {
			setCurrentConversationTitle(data.conversation.title);
		}
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "conversation_select", conversationId }));
		}
		refreshConversations();
	} catch (error) {
		appendToolResult("System error", {
			message: error?.message || "Failed to load conversation."
		}, {
			variant: "error",
			label: "System error"
		});
	}
}

function closeConversationMenu() {
	if (!openConversationMenu) {
		return;
	}
	openConversationMenu.hidden = true;
	openConversationMenu = null;
}

async function handleDeleteConversation(conversationId) {
	const confirmed = window.confirm("Delete this conversation? This cannot be undone.");
	if (!confirmed) {
		return;
	}
	try {
		const response = await fetch(`/conversations/${conversationId}`, { method: "DELETE" });
		if (!response.ok) {
			throw new Error(`Failed to delete conversation: ${response.status}`);
		}
		if (conversationId === currentConversationId) {
			currentConversationId = null;
			chat.innerHTML = "";
			setCurrentConversationTitle("New conversation");
		}
		refreshConversations();
	} catch (error) {
		appendToolResult("System error", {
			message: error?.message || "Failed to delete conversation."
		}, {
			variant: "error",
			label: "System error"
		});
	}
}

connect();

window.dumpConversationMessages = () => {
	return requestConversationDump()
		.then((messages) => {
			console.log(messages);
			return messages;
		})
		.catch((error) => {
			console.warn(error?.message || "Failed to dump conversation messages.");
			return null;
		});
};

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

if (menuToggle) {
	menuToggle.addEventListener("click", () => togglePanel());
}

if (panelClose) {
	panelClose.addEventListener("click", () => togglePanel(false));
}

if (panelBackdrop) {
	panelBackdrop.addEventListener("click", () => togglePanel(false));
}

document.addEventListener("click", () => {
	closeConversationMenu();
});

if (newConversationButton) {
	newConversationButton.addEventListener("click", () => {
		currentConversationId = null;
		chat.innerHTML = "";
		setCurrentConversationTitle("New conversation");
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "conversation_new" }));
		}
		refreshConversations();
		togglePanel(false);
	});
}
