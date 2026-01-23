import { ChatController } from "./modules/chat.js";
import { VoxController } from "./modules/vox.js";
import { MarkdownRenderer } from "./modules/markdown.js";

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("message");
const statusEl = document.getElementById("status");
const voiceToggle = document.getElementById("voiceToggle");
const menuToggle = document.getElementById("menuToggle");
const conversationPanel = document.getElementById("conversationPanel");
const conversationList = document.getElementById("conversationList");
const panelClose = document.getElementById("panelClose");
const panelBackdrop = document.getElementById("panelBackdrop");
const currentConversationTitle = document.getElementById("currentConversationTitle");
const newConversationButton = document.getElementById("newConversation");
const settingsButton = document.getElementById("settingsButton");
const settingsModal = document.getElementById("settingsModal");
const settingsClose = document.getElementById("settingsClose");
const settingsBackdrop = document.getElementById("settingsBackdrop");
const openaiApiKeyInput = document.getElementById("openaiApiKeyInput");
const realtimeModelInput = document.getElementById("realtimeModelInput");
const realtimeVoiceInput = document.getElementById("realtimeVoiceInput");
const realtimeVoiceStyleInput = document.getElementById("realtimeVoiceStyleInput");
const rtmUserTokenInput = document.getElementById("rtmUserTokenInput");
const freevoxUserIdInput = document.getElementById("freevoxUserIdInput");
const settingsSave = document.getElementById("settingsSave");

let socket;
let connectPromise = null;
let isTextStreaming = false;
let isVoiceActive = false;
let chatController;
let voxController;
let currentConversationId = null;
let openConversationMenu = null;
const isProduction = !["localhost", "127.0.0.1"].includes(window.location.hostname);
const conversationDumpRequests = new Map();

const DEFAULT_SETTINGS = {
	OPENAI_REALTIME_MODEL: "gpt-realtime",
	OPENAI_REALTIME_VOICE: "sage",
	OPENAI_REALTIME_VOICE_STYLE: "Speak fast with a low pitch."
};

function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) {
		return;
	}
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/service-worker.js").catch((err) => {
			console.warn("Service worker registration failed:", err);
		});
	});
}

function initializeSettingsDefaults() {
	Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => {
		if (!localStorage.getItem(key)) {
			localStorage.setItem(key, value);
		}
	});
}

function requestConversationDump() {
	const requestId = typeof crypto !== "undefined" && crypto.randomUUID
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return ensureSocketConnected().then(() => new Promise((resolve) => {
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			resolve([]);
			return;
		}
		conversationDumpRequests.set(requestId, resolve);
		socket.send(JSON.stringify({ type: "conversation_dump", requestId }));
	}));
}

function connect() {
	if (socket && socket.readyState === WebSocket.OPEN) {
		return Promise.resolve();
	}
	if (socket && socket.readyState === WebSocket.CONNECTING && connectPromise) {
		return connectPromise;
	}
	if (connectPromise) {
		return connectPromise;
	}
	const protocol = window.location.protocol === "https:" ? "wss" : "ws";
	const nextSocket = new WebSocket(`${protocol}://${window.location.host}`);
	socket = nextSocket;
	if (chatController) {
		chatController.setSocket(nextSocket);
	}
	if (voxController) {
		voxController.setSocket(nextSocket);
	}

	connectPromise = new Promise((resolve, reject) => {
		let opened = false;
		nextSocket.addEventListener("open", () => {
			opened = true;
			statusEl.textContent = "Connected";
			statusEl.style.color = "#3c6e3c";
			sendSettingsUpdate();
			refreshConversations();
			if (currentConversationId) {
				nextSocket.send(JSON.stringify({
					type: "conversation_select",
					conversationId: currentConversationId
				}));
			}
			connectPromise = null;
			resolve();
		});

		nextSocket.addEventListener("close", () => {
			statusEl.textContent = "Disconnected";
			statusEl.style.color = "#9b3e25";
			if (voxController) {
				voxController.handleSocketClose();
			}
			if (!opened) {
				connectPromise = null;
				reject(new Error("WebSocket closed before connecting."));
				return;
			}
			connectPromise = null;
		});

		nextSocket.addEventListener("error", (err) => {
			if (!opened) {
				connectPromise = null;
				reject(err);
			}
		});
	});

	nextSocket.addEventListener("message", (event) => {
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

	return connectPromise;
}

function ensureSocketConnected() {
	if (socket && socket.readyState === WebSocket.OPEN) {
		return Promise.resolve();
	}
	return connect();
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

function toggleSettings(nextOpen) {
	if (!settingsModal) {
		return;
	}
	const isOpen = typeof nextOpen === "boolean"
		? nextOpen
		: settingsModal.hasAttribute("hidden");
	settingsModal.toggleAttribute("hidden", !isOpen);
}

function loadSettingsFields() {
	if (openaiApiKeyInput) {
		openaiApiKeyInput.value = localStorage.getItem("OPENAI_API_KEY") || "";
	}
	if (realtimeModelInput) {
		realtimeModelInput.value = localStorage.getItem("OPENAI_REALTIME_MODEL") || "";
	}
	if (realtimeVoiceInput) {
		realtimeVoiceInput.value = localStorage.getItem("OPENAI_REALTIME_VOICE") || "";
	}
	if (realtimeVoiceStyleInput) {
		realtimeVoiceStyleInput.value = localStorage.getItem("OPENAI_REALTIME_VOICE_STYLE") || "";
	}
	if (rtmUserTokenInput) {
		rtmUserTokenInput.value = localStorage.getItem("RTM_USER_TOKEN") || "";
	}
	if (freevoxUserIdInput) {
		freevoxUserIdInput.value = localStorage.getItem("FREEVOX_USER_ID") || "";
	}
}

function saveSettingsFields() {
	if (openaiApiKeyInput) {
		localStorage.setItem("OPENAI_API_KEY", openaiApiKeyInput.value || "");
	}
	if (realtimeModelInput) {
		localStorage.setItem("OPENAI_REALTIME_MODEL", realtimeModelInput.value || "");
	}
	if (realtimeVoiceInput) {
		localStorage.setItem("OPENAI_REALTIME_VOICE", realtimeVoiceInput.value || "");
	}
	if (realtimeVoiceStyleInput) {
		localStorage.setItem("OPENAI_REALTIME_VOICE_STYLE", realtimeVoiceStyleInput.value || "");
	}
	if (rtmUserTokenInput) {
		localStorage.setItem("RTM_USER_TOKEN", rtmUserTokenInput.value || "");
	}
	if (freevoxUserIdInput) {
		localStorage.setItem("FREEVOX_USER_ID", freevoxUserIdInput.value || "");
	}
}

function sendSettingsUpdate() {
	if (!socket || socket.readyState !== WebSocket.OPEN) {
		return;
	}
	const openaiApiKey = localStorage.getItem("OPENAI_API_KEY") || "";
	socket.send(JSON.stringify({
		type: "settings_update",
		openaiApiKey,
		realtimeModel: localStorage.getItem("OPENAI_REALTIME_MODEL") || "",
		realtimeVoice: localStorage.getItem("OPENAI_REALTIME_VOICE") || "",
		realtimeVoiceStyle: localStorage.getItem("OPENAI_REALTIME_VOICE_STYLE") || "",
		freevoxUserId: localStorage.getItem("FREEVOX_USER_ID") || ""
	}));
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
	const ensurePromise = ensureSocketConnected();
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
		await ensurePromise;
		if (socket && socket.readyState === WebSocket.OPEN) {
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

registerServiceWorker();
initializeSettingsDefaults();
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
	canSendMessage: () => !isVoiceActive,
	ensureConnected: ensureSocketConnected
});

voxController = new VoxController({
	socket,
	appendMessage,
	appendToolResult,
	chatEl: chat,
	voiceToggle,
	onVoiceActiveChange: setVoiceActive,
	canStartVoice: () => !isTextStreaming,
	ensureConnected: ensureSocketConnected
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
		ensureSocketConnected()
			.then(() => {
				if (socket && socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: "conversation_new" }));
				}
			})
			.catch(() => {});
		refreshConversations();
		togglePanel(false);
	});
}

if (settingsButton) {
	settingsButton.addEventListener("click", () => {
		loadSettingsFields();
		toggleSettings(true);
	});
}

if (settingsClose) {
	settingsClose.addEventListener("click", () => {
		toggleSettings(false);
	});
}

if (settingsBackdrop) {
	settingsBackdrop.addEventListener("click", () => {
		toggleSettings(false);
	});
}

if (settingsSave) {
	settingsSave.addEventListener("click", () => {
		saveSettingsFields();
		sendSettingsUpdate();
		toggleSettings(false);
	});
}
