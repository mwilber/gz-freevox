# Project Agent Guide

## Overview
FreeVox is a Node.js web app that enables a real-time, two-way conversation with an LLM using OpenAI's streaming Responses API over WebSockets. The server keeps a short in-memory conversation history per WebSocket connection and streams assistant output back to the client in incremental chunks.

## Architecture
- `server.js`: Express static server + WebSocket server. Receives user messages, appends to history, calls OpenAI, streams deltas back to the client.
- `public/`: Client UI and logic.
  - `index.html`: App shell and layout.
  - `styles.css`: Visual design.
  - `client.js`: WebSocket client, message rendering, and streaming handling.

## Runtime Flow
1. Browser connects to WebSocket at the same host.
2. User submits a message; the client sends `{ type: "user_message", text }`.
3. Server appends to history and calls OpenAI with `stream: true`.
4. As deltas arrive, the server forwards `{ type: "assistant_delta", delta }` to the client.
5. On completion, the server sends `{ type: "assistant_done" }` and stores the assistant reply in history.

## Configuration
- `.env` must include `OPENAI_API_KEY`.
- `PORT` is optional (default 3000).
- Models can be changed in `server.js` in the OpenAI request body.

## Development
- Install: `npm install`
- Run: `npm start`
- Visit: `http://localhost:3000`

## Notes
- History is in-memory per connection; it resets when the socket reconnects.
- Error payloads are sent as `{ type: "error", message, detail? }`.

## Commit Messages
All commit messages follow this format:
- A single sentence summarizing the overall change.
- A bullet list describing each high-level change, consolidating similar updates into one concise bullet.
