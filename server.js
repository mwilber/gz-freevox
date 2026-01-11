const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const { createParser } = require("eventsource-parser");
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
      content: "You are a concise, friendly assistant. Keep answers helpful and brief."
    }
  ];

  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON." }));
      return;
    }

    if (message.type !== "user_message" || !message.text) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message payload." }));
      return;
    }

    history.push({ role: "user", content: message.text });

    try {
      await streamAssistantResponse({ ws, history });
    } catch (err) {
      ws.send(JSON.stringify({
        type: "error",
        message: "OpenAI request failed.",
        detail: err.message
      }));
    }
  });
});

async function streamAssistantResponse({ ws, history }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: history,
      stream: true
    })
  });

  if (!response.ok || !response.body) {
    const detail = await response.text();
    throw new Error(detail || "Bad response from OpenAI.");
  }

  const decoder = new TextDecoder();
  let assistantText = "";

  const parser = createParser((event) => {
    if (event.type !== "event") {
      return;
    }

    if (event.data === "[DONE]") {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      return;
    }

    if (payload.type === "response.output_text.delta") {
      assistantText += payload.delta || "";
      ws.send(JSON.stringify({
        type: "assistant_delta",
        delta: payload.delta || ""
      }));
    }

    if (payload.type === "response.completed") {
      ws.send(JSON.stringify({ type: "assistant_done" }));
    }
  });

  for await (const chunk of response.body) {
    parser.feed(decoder.decode(chunk, { stream: true }));
  }

  if (assistantText) {
    history.push({ role: "assistant", content: assistantText });
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
