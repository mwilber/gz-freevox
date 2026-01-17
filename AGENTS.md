# Project Agent Guide

## Overview
FreeVox is a Node.js web app that enables a real-time, two-way conversation with an LLM. It supports text chat via OpenAI's streaming Responses API over WebSockets and a live audio conversation via OpenAI's Realtime API. The server keeps a short in-memory conversation history per WebSocket connection and streams assistant output back to the client in incremental chunks.

## Architecture
- `server.js`: Express static server + WebSocket server. Wires chat + voice handlers and forwards WS messages.
- `modules/chat.js`: Text chat handler (Responses API streaming).
- `modules/vox.js`: Realtime voice handler (OpenAI Realtime WebSocket bridge + transcription).
- `modules/db.js`: SQLite storage (users, conversations, messages) and CRUD helpers.
- `public/`: Client UI and logic.
	- `index.html`: App shell and layout.
	- `styles.css`: Visual design.
	- `client.js`: Bootstraps chat + voice controllers.
	- `public/modules/chat.js`: Frontend text chat controller.
	- `public/modules/mcp-client.js`: Browser MCP client for tool discovery + invocation.
	- `public/modules/mcp-config.js`: MCP endpoint + routing configuration.
	- `public/modules/vox.js`: Frontend voice controller.

## Runtime Flow
Text chat:
1. Browser connects to WebSocket at the same host.
2. Client initializes the MCP client and discovers tools.
3. User submits a message; the client sends `{ type: "user_message", text, tools }`.
4. Server appends the user message and calls OpenAI with `stream: true` and `tools`.
5. As deltas arrive, the server forwards `{ type: "assistant_delta", delta }` to the client.
6. If the model emits tool calls, the server sends `{ type: "assistant_tool_calls", toolCalls }` and waits.
7. The client executes MCP tools and replies with `{ type: "tool_results", results }`.
8. The server sends a follow-up request including `function_call` + `function_call_output` items (matching `call_id`).
9. On completion, the server sends `{ type: "assistant_done" }` and stores the assistant reply in history.

Voice chat:
1. User clicks the voice button; the client requests the microphone and sends `{ type: "audio_start" }`.
2. The client streams PCM16 audio chunks with `{ type: "audio_chunk", audio }`.
3. The server opens a Realtime WebSocket session and forwards audio chunks to OpenAI.
4. On speech start the server sends `{ type: "user_voice_start" }` so the client can place the user transcript bubble immediately.
5. The server streams audio deltas back as `{ type: "assistant_audio_delta", audio }` and transcript deltas as `{ type: "assistant_voice_text_delta", delta }` plus `{ type: "user_voice_text_delta", delta }`.
6. Speaking while the assistant talks triggers interruption; the server sends `{ type: "assistant_audio_interrupt" }` and cancels the response.
7. When the user ends, the client sends `{ type: "audio_stop" }` and the server closes the realtime session.
8. If tools are configured, the client sends them with `audio_start`; tool calls arrive as `{ type: "assistant_voice_tool_calls", toolCalls }` and results are returned as `{ type: "voice_tool_results", results }`.

Conversation storage:
1. A conversation is created on the first persisted message (text or voice) with title `Untitled Conversation`.
2. The system prompt is stored once at conversation creation; user/assistant messages append after each response.
3. After the first user + assistant exchange, the server generates a short title and updates the conversation.
4. The server emits `{ type: "conversations_updated" }` to refresh the sidebar list, and `{ type: "conversation_started", conversation }` when a new conversation is created.

Conversation switching:
1. Client loads `/conversations/:id` and replaces the chat UI with stored messages (system messages hidden).
2. Client sends `{ type: "conversation_select", conversationId }` to replace the in-memory history for the socket.
3. Client can reset to a fresh in-memory history with `{ type: "conversation_new" }` without creating a DB record.

## Configuration
- `.env` must include `OPENAI_API_KEY`.
- `PORT` is optional (default 3000).
- Models can be changed in `server.js` in the OpenAI request body.
- Realtime voice settings can be set via `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, and `OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE` (default `en`).
- SQLite configuration: `FREEVOX_USER_ID` (single-user ID for now) and `FREEVOX_DB_PATH` (default `freevox.sqlite`).
- System prompt is loaded from `system-prompt.txt` at project root.
- MCP endpoint + tool routing are set in `public/modules/mcp-config.js`.

## Development
- Install: `npm install`
- Run: `npm start`
- Visit: `http://localhost:3000`
- Test: `npm test`

## Notes
- History is in-memory per connection; it resets when the socket reconnects.
- Error payloads are sent as `{ type: "error", message, detail? }`.
- Realtime voice errors are forwarded as `{ type: "assistant_voice_error" }` and rendered in the chat stream.
- Tool calls include both `id` and `call_id`; tool outputs must use `function_call_output` with the matching `call_id`.
- If microphone capture fails, confirm browser permissions and prefer `http://localhost` or HTTPS.
- Heroku deploys use `Procfile` with `web: node server.js`; set config vars for all `.env` values and consider `FREEVOX_DB_PATH` under `/tmp` since dyno filesystems are ephemeral.
- Indentation uses tabs across project files.

## Commit Messages
All commit messages follow this format:
- A single sentence summarizing the overall change.
- A bullet list describing each high-level change, consolidating similar updates into one concise bullet.
