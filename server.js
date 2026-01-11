const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const { createChatHandler } = require("./chat");
const { createVoxHandler } = require("./vox");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
const REALTIME_SYSTEM_PROMPT =
  process.env.OPENAI_REALTIME_PROMPT ||
  "You are a concise, friendly assistant. Keep answers helpful and brief.";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment.");
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  const history = [
    {
      role: "system",
      content: REALTIME_SYSTEM_PROMPT
    }
  ];

  const chat = createChatHandler({
    ws,
    history,
    apiKey: OPENAI_API_KEY
  });

  const vox = createVoxHandler({
    ws,
    history,
    apiKey: OPENAI_API_KEY,
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
    systemPrompt: REALTIME_SYSTEM_PROMPT
  });

  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON." }));
      return;
    }

    if (message.type === "user_message") {
      if (!message.text) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid message payload." }));
        return;
      }

      await chat.handleMessage(message);
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
