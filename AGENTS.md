# Project Agent Guide

## Overview
FreeVox is a Node.js web app that enables a real-time, two-way conversation with an LLM. It supports text chat via OpenAI's streaming Responses API over WebSockets and a live audio conversation via OpenAI's Realtime API. The server keeps a short in-memory conversation history per WebSocket connection and streams assistant output back to the client in incremental chunks.

## Architecture
- `server.js`: Express static server + WebSocket server. Receives user messages, appends to history, calls OpenAI, streams deltas back to the client. Also bridges realtime audio between the browser and OpenAI's Realtime WebSocket.
- `public/`: Client UI and logic.
  - `index.html`: App shell and layout.
  - `styles.css`: Visual design.
  - `client.js`: WebSocket client, message rendering, streaming handling, mic capture, and audio playback.

## Runtime Flow
Text chat:
1. Browser connects to WebSocket at the same host.
2. User submits a message; the client sends `{ type: "user_message", text }`.
3. Server appends to history and calls OpenAI with `stream: true`.
4. As deltas arrive, the server forwards `{ type: "assistant_delta", delta }` to the client.
5. On completion, the server sends `{ type: "assistant_done" }` and stores the assistant reply in history.

Voice chat:
1. User clicks the voice button; the client requests the microphone and sends `{ type: "audio_start" }`.
2. The client streams PCM16 audio chunks with `{ type: "audio_chunk", audio }`.
3. The server opens a Realtime WebSocket session and forwards audio chunks to OpenAI.
4. On speech start the server sends `{ type: "user_voice_start" }` so the client can place the user transcript bubble immediately.
5. The server streams audio deltas back as `{ type: "assistant_audio_delta", audio }` and transcript deltas as `{ type: "assistant_voice_text_delta", delta }` plus `{ type: "user_voice_text_delta", delta }`.
6. Speaking while the assistant talks triggers interruption; the server sends `{ type: "assistant_audio_interrupt" }` and cancels the response.
7. When the user ends, the client sends `{ type: "audio_stop" }` and the server closes the realtime session.

## Configuration
- `.env` must include `OPENAI_API_KEY`.
- `PORT` is optional (default 3000).
- Models can be changed in `server.js` in the OpenAI request body.
- Realtime voice settings can be set via `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, and `OPENAI_REALTIME_PROMPT`.

## Development
- Install: `npm install`
- Run: `npm start`
- Visit: `http://localhost:3000`

## Notes
- History is in-memory per connection; it resets when the socket reconnects.
- Error payloads are sent as `{ type: "error", message, detail? }`.
- If microphone capture fails, confirm browser permissions and prefer `http://localhost` or HTTPS.

## Commit Messages
All commit messages follow this format:
- A single sentence summarizing the overall change.
- A bullet list describing each high-level change, consolidating similar updates into one concise bullet.
