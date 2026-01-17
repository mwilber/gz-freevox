const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const db = require("./modules/db");
const { ChatHandler } = require("./modules/chat");
const { VoxHandler } = require("./modules/vox");
const { mcpConfig } = require("./mcp.config");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
const REALTIME_TRANSCRIPTION_LANGUAGE =
	process.env.OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE || "en";
const REALTIME_VOICE_STYLE = process.env.OPENAI_REALTIME_VOICE_STYLE || "";
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system-prompt.txt");
const DEFAULT_SYSTEM_PROMPT =
	"You are a concise, friendly assistant. Keep answers helpful and brief.";
let SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;

try {
	const filePrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
	if (filePrompt) {
		SYSTEM_PROMPT = filePrompt;
	}
} catch (err) {}

function getCurrentDateTimeString() {
	return new Date().toLocaleString("en-US", {
		dateStyle: "full",
		timeStyle: "long"
	});
}

function buildSystemPromptWithDate() {
	return `${SYSTEM_PROMPT}\n\nThe current date and time is ${getCurrentDateTimeString()}.`;
}

function buildDateTimeSystemMessage() {
	return `The current date and time is ${getCurrentDateTimeString()}.`;
}

if (!OPENAI_API_KEY) {
	console.error("Missing OPENAI_API_KEY in environment.");
	process.exit(1);
}

const TITLE_MODEL = "gpt-4o-mini";

async function generateConversationTitle({ userMessage, assistantMessage }) {
	const prompt = [
		{
			role: "system",
			content: "Generate a short title (max 6 words) for this conversation. Reply with only the title."
		},
		{
			role: "user",
			content: `User: ${userMessage}\nAssistant: ${assistantMessage}`
		}
	];
	const response = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model: TITLE_MODEL,
			input: prompt
		})
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(detail || "Failed to generate title.");
	}

	const data = await response.json();
	if (typeof data.output_text === "string") {
		return data.output_text.trim();
	}
	if (Array.isArray(data.output)) {
		for (const item of data.output) {
			if (item?.content) {
				for (const part of item.content) {
					if (part?.type === "output_text" && part.text) {
						return part.text.trim();
					}
				}
			}
			if (item?.text) {
				return String(item.text).trim();
			}
		}
	}
	return "";
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/mcp-config", (req, res) => {
	res.json(mcpConfig);
});
app.get("/conversations", (req, res) => {
	try {
		const conversations = db.listConversations();
		res.json({ conversations });
	} catch (err) {
		res.status(500).json({ error: "Failed to load conversations.", detail: err.message });
	}
});
app.get("/conversations/:id", (req, res) => {
	try {
		const conversation = db.getConversation({ conversationId: req.params.id });
		if (!conversation) {
			res.status(404).json({ error: "Conversation not found." });
			return;
		}
		const messages = db.listMessages({ conversationId: req.params.id });
		res.json({ conversation, messages });
	} catch (err) {
		res.status(500).json({ error: "Failed to load conversation.", detail: err.message });
	}
});
app.delete("/conversations/:id", (req, res) => {
	try {
		const result = db.deleteConversation({ conversationId: req.params.id });
		if (!result.deleted) {
			res.status(404).json({ error: "Conversation not found." });
			return;
		}
		res.json({ deleted: true });
	} catch (err) {
		res.status(500).json({ error: "Failed to delete conversation.", detail: err.message });
	}
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
	let conversationId;
	let firstUserMessage = "";
	let firstAssistantMessage = "";
	let titleRequested = false;
	let systemPromptWithDate = buildSystemPromptWithDate();

	const history = [
		{
			role: "system",
			content: systemPromptWithDate
		}
	];

	const persistMessage = ({ role, content }) => {
		if (!content) {
			return;
		}
		if (!conversationId) {
			try {
				const conversation = db.createConversation({ title: "Untitled Conversation" });
				conversationId = conversation.id;
				db.addMessage({ conversationId, role: "system", content: systemPromptWithDate });
				ws.send(JSON.stringify({
					type: "conversation_started",
					conversation
				}));
				ws.send(JSON.stringify({ type: "conversations_updated" }));
			} catch (err) {
				ws.send(JSON.stringify({
					type: "error",
					message: "Failed to start conversation storage.",
					detail: err.message
				}));
				ws.close();
				return;
			}
		}
		try {
			db.addMessage({ conversationId, role, content });
		} catch (err) {
			ws.send(JSON.stringify({
				type: "error",
				message: "Failed to save conversation history.",
				detail: err.message
			}));
		}

		if (role === "user" && !firstUserMessage) {
			firstUserMessage = content;
			return;
		}

		if (role === "assistant" && firstUserMessage && !firstAssistantMessage && !titleRequested) {
			firstAssistantMessage = content;
			titleRequested = true;
			void (async () => {
				try {
					const title = await generateConversationTitle({
						userMessage: firstUserMessage,
						assistantMessage: firstAssistantMessage
					});
					if (title) {
						db.updateConversationTitle({ conversationId, title });
						ws.send(JSON.stringify({ type: "conversations_updated" }));
					}
				} catch (err) {
					ws.send(JSON.stringify({
						type: "error",
						message: "Failed to update conversation title.",
						detail: err.message
					}));
				}
			})();
		}
	};

	const chat = new ChatHandler({
		ws,
		history,
		apiKey: OPENAI_API_KEY,
		onMessage: persistMessage
	});

	const vox = new VoxHandler({
		ws,
		history,
		apiKey: OPENAI_API_KEY,
		model: REALTIME_MODEL,
		voice: REALTIME_VOICE,
		systemPrompt: systemPromptWithDate,
		transcriptionLanguage: REALTIME_TRANSCRIPTION_LANGUAGE,
		onMessage: persistMessage,
		voiceStyle: REALTIME_VOICE_STYLE
	});

	ws.on("message", async (raw) => {
		let message;
		try {
			message = JSON.parse(raw.toString());
		} catch (err) {
			ws.send(JSON.stringify({ type: "error", message: "Invalid JSON." }));
			return;
		}

		if (message.type === "user_message" || message.type === "tool_results") {
			if (message.type === "user_message" && !message.text) {
				ws.send(JSON.stringify({ type: "error", message: "Invalid message payload." }));
				return;
			}

			await chat.handleMessage(message);
			return;
		}

		if (message.type === "conversation_dump") {
			const messages = chat.getInputMessages();
			ws.send(JSON.stringify({
				type: "conversation_dump",
				requestId: message.requestId || null,
				messages
			}));
			return;
		}

		if (message.type === "conversation_select") {
			if (!message.conversationId) {
				ws.send(JSON.stringify({ type: "error", message: "Invalid conversation selection." }));
				return;
			}
			try {
				const conversation = db.getConversation({ conversationId: message.conversationId });
				if (!conversation) {
					ws.send(JSON.stringify({ type: "error", message: "Conversation not found." }));
					return;
				}
				const storedMessages = db.listMessages({ conversationId: message.conversationId });
				const nextHistory = storedMessages.map((item) => ({
					role: item.role,
					content: item.content
				}));
				if (!nextHistory.some((item) => item.role === "system")) {
					nextHistory.unshift({ role: "system", content: SYSTEM_PROMPT });
				}
				const dateTimeMessage = buildDateTimeSystemMessage();
				nextHistory.push({ role: "system", content: dateTimeMessage });
				const baseSystemPrompt =
					nextHistory.find((item) => item.role === "system")?.content || SYSTEM_PROMPT;
				vox.systemPrompt = `${baseSystemPrompt}\n\n${dateTimeMessage}`;
				history.length = 0;
				history.push(...nextHistory);
				conversationId = message.conversationId;
				firstUserMessage = "";
				firstAssistantMessage = "";
				titleRequested = conversation.title !== "Untitled Conversation";
				if (!titleRequested) {
					const firstUser = nextHistory.find((item) => item.role === "user");
					const firstAssistant = nextHistory.find((item) => item.role === "assistant");
					firstUserMessage = firstUser?.content || "";
					firstAssistantMessage = firstAssistant?.content || "";
					if (firstUserMessage && firstAssistantMessage) {
						titleRequested = true;
					}
				}
			} catch (err) {
				ws.send(JSON.stringify({
					type: "error",
					message: "Failed to load conversation.",
					detail: err.message
				}));
			}
			return;
		}

		if (message.type === "conversation_new") {
			systemPromptWithDate = buildSystemPromptWithDate();
			vox.systemPrompt = systemPromptWithDate;
			history.length = 0;
			history.push({ role: "system", content: systemPromptWithDate });
			conversationId = null;
			firstUserMessage = "";
			firstAssistantMessage = "";
			titleRequested = false;
			return;
		}

		if (message.type === "voice_tool_results") {
			const handledVoice = vox.handleMessage(message);
			if (!handledVoice) {
				ws.send(JSON.stringify({ type: "error", message: "Invalid message payload." }));
			}
			return;
		}

		const handled = vox.handleMessage(message);
		if (!handled) {
			ws.send(JSON.stringify({ type: "error", message: "Invalid message payload." }));
		}
	});

	ws.on("close", () => {
		vox.handleClose();
	});
});

server.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});
