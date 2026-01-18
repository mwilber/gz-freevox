const WebSocket = require("ws");

class VoxHandler {
	/**
	 * @param {object} options
	 * @param {object} options.ws
	 * @param {Array} options.history
	 * @param {string} options.apiKey
	 * @param {string} options.model
	 * @param {string} options.voice
	 * @param {string} options.systemPrompt
	 * @param {string} options.transcriptionLanguage
	 * @param {Function} options.onMessage
	 * @param {string} options.voiceStyle
	 */
	constructor({ ws, history, apiKey, model, voice, systemPrompt, transcriptionLanguage, onMessage, voiceStyle }) {
		this.ws = ws;
		this.history = history;
		this.apiKey = apiKey;
		this.model = model;
		this.voice = voice;
		this.systemPrompt = systemPrompt;
		this.transcriptionLanguage = transcriptionLanguage;
		this.onMessage = onMessage;
		this.voiceStyle = voiceStyle;
		this.tools = [];
		this.realtimeToolCalls = new Map();

		this.realtimeSocket = null;
		this.realtimeReady = false;
		this.realtimeQueue = [];
		this.realtimeResponding = false;
		this.realtimeCancelling = false;
		this.pendingUserTranscript = "";
		this.pendingUserTranscriptSent = false;
		this.pendingAssistantTranscript = "";
		this.lastUserTranscript = "";
		this.bufferHasAudio = false;
		this.seededItemIds = new Set();
		this.pendingSeedMessages = 0;
		this.seedCounter = 0;
	}

	/**
	 * Sends a payload to the realtime websocket if connected.
	 * @param {object} payload
	 */
	_sendRealtime(payload) {
		if (!this.realtimeSocket || this.realtimeSocket.readyState !== WebSocket.OPEN) {
			return;
		}
		this.realtimeSocket.send(JSON.stringify(payload));
	}

	/**
	 * Sends prior text history into the realtime session.
	 */
	_seedRealtimeHistory() {
		for (const message of this.history) {
			if (!message.content || message.role === "system") {
				continue;
			}
			const seedId = `seed-${Date.now()}-${this.seedCounter++}`;
			if (message.role === "user") {
				this.seededItemIds.add(seedId);
				this.pendingSeedMessages += 1;
			}
			const textType = message.role === "user" ? "input_text" : "output_text";
			this._sendRealtime({
				type: "conversation.item.create",
				item: {
					id: seedId,
					type: "message",
					role: message.role,
					content: [{ type: textType, text: message.content }]
				}
			});
		}
	}

	/**
	 * Commits the buffered assistant transcript to history.
	 */
	_commitAssistantTranscript() {
		if (!this.pendingAssistantTranscript) {
			return;
		}
		this.history.push({ role: "assistant", content: this.pendingAssistantTranscript });
		if (this.onMessage) {
			this.onMessage({ role: "assistant", content: this.pendingAssistantTranscript });
		}
		this.pendingAssistantTranscript = "";
		this.ws.send(JSON.stringify({ type: "assistant_voice_text_done" }));
	}

	/**
	 * Opens the OpenAI realtime websocket and wires handlers.
	 */
	_openRealtimeSocket() {
		if (this.realtimeSocket) {
			return;
		}

		this.realtimeSocket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${this.model}`, {
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"OpenAI-Beta": "realtime=v1"
			}
		});

		this.realtimeSocket.on("open", () => {
			this.realtimeReady = true;
			this._sendRealtime({
				type: "session.update",
				session: {
					modalities: ["audio", "text"],
					instructions: this.voiceStyle
						? `${this.systemPrompt}\n\nVoice style: ${this.voiceStyle}`
						: this.systemPrompt,
					voice: this.voice,
					input_audio_format: "pcm16",
					output_audio_format: "pcm16",
					input_audio_transcription: {
						model: "gpt-4o-mini-transcribe",
						language: this.transcriptionLanguage
					},
					tools: this.tools.length ? this.tools : undefined,
					turn_detection: {
						type: "server_vad",
						threshold: 0.5,
						prefix_padding_ms: 300,
						silence_duration_ms: 500
					}
				}
			});

			this._seedRealtimeHistory();

			if (this.realtimeQueue.length) {
				for (const queued of this.realtimeQueue) {
					this._sendRealtime(queued);
				}
				this.realtimeQueue = [];
			}
		});

		this.realtimeSocket.on("message", (data) => {
			let payload;
			try {
				payload = JSON.parse(data.toString());
			} catch (err) {
				return;
			}

			if (payload.type === "input_audio_buffer.speech_started") {
				this.pendingUserTranscript = "";
				this.pendingUserTranscriptSent = false;
				this.lastUserTranscript = "";
				this.ws.send(JSON.stringify({ type: "user_voice_start" }));
				if (this.realtimeResponding) {
					this._sendRealtime({ type: "response.cancel" });
					this.ws.send(JSON.stringify({ type: "assistant_audio_interrupt" }));
					this.realtimeCancelling = true;
					this.pendingAssistantTranscript = "";
				}
				return;
			}

			if (payload.type === "response.created") {
				this.realtimeResponding = true;
				this.realtimeToolCalls.clear();
				return;
			}

			if (payload.type === "response.output_item.added") {
				const item = payload.item;
				if (item?.type === "function_call") {
					const itemId = item.id || item.call_id;
					const callId = item.call_id || item.id;
					if (!itemId) {
						return;
					}
					this.realtimeToolCalls.set(itemId, {
						id: itemId,
						call_id: callId,
						function: {
							name: item.name,
							arguments: item.arguments || ""
						}
					});
				}
			}

			if (payload.type === "response.function_call_arguments.delta") {
				const call =
					this.realtimeToolCalls.get(payload.item_id) ||
					[...this.realtimeToolCalls.values()].find((entry) => entry.call_id === payload.item_id);
				if (call) {
					call.function.arguments += payload.delta || "";
				}
				return;
			}

			if (payload.type === "response.output_item.done") {
				const item = payload.item;
				if (item?.type === "function_call") {
					const itemId = item.id || item.call_id;
					const callId = item.call_id || item.id;
					if (!itemId) {
						return;
					}
					const call =
						this.realtimeToolCalls.get(itemId) ||
						[...this.realtimeToolCalls.values()].find((entry) => entry.call_id === callId);
					if (call) {
						call.id = itemId || call.id;
						call.call_id = callId || call.call_id;
						call.function.name = item.name || call.function.name;
						if (typeof item.arguments === "string") {
							call.function.arguments = item.arguments;
						}
					} else {
						this.realtimeToolCalls.set(itemId, {
							id: itemId,
							call_id: callId,
							function: {
								name: item.name,
								arguments: item.arguments || ""
							}
						});
					}
					this.ws.send(JSON.stringify({
						type: "assistant_voice_tool_calls",
						toolCalls: [this.realtimeToolCalls.get(itemId)]
					}));
				}
				return;
			}

			if (payload.type === "input_audio_buffer.speech_stopped") {
				if (!this.bufferHasAudio) {
					return;
				}
				this._sendRealtime({ type: "input_audio_buffer.commit" });
				this.bufferHasAudio = false;
				if (!this.realtimeResponding) {
					if (this.realtimeCancelling) {
						return;
					}
					this._sendRealtime({
						type: "response.create",
						response: {
							modalities: ["audio", "text"]
						}
					});
					this.realtimeResponding = true;
				}
				return;
			}

			if (payload.type === "response.audio.delta" || payload.type === "response.output_audio.delta") {
				this.ws.send(JSON.stringify({
					type: "assistant_audio_delta",
					audio: payload.delta || payload.audio || ""
				}));
				return;
			}

			if (payload.type === "response.audio.done" || payload.type === "response.output_audio.done") {
				this.ws.send(JSON.stringify({ type: "assistant_audio_done" }));
				return;
			}

			if (payload.type === "response.text.delta" || payload.type === "response.output_text.delta") {
				const delta = payload.delta || payload.text || "";
				if (delta) {
					this.pendingAssistantTranscript += delta;
					this.ws.send(JSON.stringify({
						type: "assistant_voice_text_delta",
						delta
					}));
				}
				return;
			}

			if (payload.type === "response.text.done" || payload.type === "response.output_text.done") {
				this._commitAssistantTranscript();
				return;
			}

			if (
				payload.type === "response.audio_transcript.delta" ||
				payload.type === "response.output_audio_transcript.delta"
			) {
				const delta = payload.delta || payload.text || "";
				if (delta) {
					this.pendingAssistantTranscript += delta;
					this.ws.send(JSON.stringify({
						type: "assistant_voice_text_delta",
						delta
					}));
				}
				return;
			}

			if (
				payload.type === "response.audio_transcript.done" ||
				payload.type === "response.output_audio_transcript.done"
			) {
				this._commitAssistantTranscript();
				return;
			}

			if (
				payload.type === "conversation.item.input_audio_transcription.delta" ||
				payload.type === "input_audio_transcription.delta"
			) {
				const delta = payload.delta || payload.text || "";
				if (delta) {
					this.pendingUserTranscript += delta;
					this.pendingUserTranscriptSent = true;
					this.ws.send(JSON.stringify({ type: "user_voice_text_delta", delta }));
				}
				return;
			}

			if (
				payload.type === "conversation.item.input_audio_transcription.completed" ||
				payload.type === "input_audio_transcription.completed"
			) {
				const transcript = payload.transcript || payload.text || this.pendingUserTranscript;
				if (transcript && transcript !== this.lastUserTranscript) {
					this.history.push({ role: "user", content: transcript });
					if (this.onMessage) {
						this.onMessage({ role: "user", content: transcript });
					}
					if (!this.pendingUserTranscriptSent) {
						this.ws.send(JSON.stringify({ type: "user_voice_text_delta", delta: transcript }));
					}
					this.lastUserTranscript = transcript;
				}
				this.pendingUserTranscript = "";
				this.pendingUserTranscriptSent = false;
				this.ws.send(JSON.stringify({ type: "user_voice_text_done" }));
				return;
			}

			if (payload.type === "conversation.item.created" || payload.type === "conversation.item.updated") {
				const item = payload.item;
				if (item && item.role === "user" && Array.isArray(item.content)) {
					const hasAudio = item.content.some((part) => part.type === "input_audio");
					const hasText = item.content.some((part) => part.type === "input_text");
					const isSeeded = item.id && this.seededItemIds.has(item.id);
					if (isSeeded || (this.pendingSeedMessages > 0 && hasText && !hasAudio)) {
						if (item.id && this.seededItemIds.has(item.id)) {
							this.seededItemIds.delete(item.id);
						}
						if (this.pendingSeedMessages > 0) {
							this.pendingSeedMessages -= 1;
						}
						return;
					}
					const textPart = item.content.find((part) => part.type === "input_text");
					const audioPart = item.content.find((part) => part.type === "input_audio");
					const transcript = (textPart && textPart.text) || (audioPart && audioPart.transcript) || "";
					if (transcript && transcript !== this.lastUserTranscript) {
						this.history.push({ role: "user", content: transcript });
						if (this.onMessage) {
							this.onMessage({ role: "user", content: transcript });
						}
						this.ws.send(JSON.stringify({ type: "user_voice_text_delta", delta: transcript }));
						this.ws.send(JSON.stringify({ type: "user_voice_text_done" }));
						this.pendingUserTranscript = "";
						this.pendingUserTranscriptSent = true;
						this.lastUserTranscript = transcript;
					}
				}
				return;
			}

			if (payload.type === "error") {
				const message = payload.error?.message || payload.message || "Voice error";
				const code = payload.error?.code || payload.code || "";
				this.ws.send(JSON.stringify({
					type: "assistant_voice_error",
					message,
					code,
					detail: payload.error || payload
				}));
				return;
			}

			if (payload.type === "response.completed") {
				this.realtimeResponding = false;
				this.realtimeCancelling = false;
				this._commitAssistantTranscript();
			}

			if (payload.type === "response.done") {
				this.realtimeResponding = false;
				this.realtimeCancelling = false;
			}

			if (payload.type === "response.cancelled") {
				this.realtimeResponding = false;
				this.realtimeCancelling = false;
			}

		});

		this.realtimeSocket.on("close", () => {
			this.realtimeSocket = null;
			this.realtimeReady = false;
			this.realtimeQueue = [];
			this.realtimeResponding = false;
			this.realtimeCancelling = false;
			this.pendingUserTranscript = "";
			this.pendingUserTranscriptSent = false;
			this.pendingAssistantTranscript = "";
			this.bufferHasAudio = false;
			this.seededItemIds.clear();
			this.pendingSeedMessages = 0;
			this.seedCounter = 0;
			this.realtimeToolCalls.clear();
		});

		this.realtimeSocket.on("error", (err) => {
			this.ws.send(JSON.stringify({
				type: "error",
				message: "OpenAI realtime connection failed.",
				detail: err.message
			}));
		});
	}

	/**
	 * Closes the realtime websocket and resets state.
	 */
	_closeRealtimeSocket() {
		if (this.realtimeSocket) {
			this.realtimeSocket.close();
		}
		this.realtimeSocket = null;
		this.realtimeReady = false;
		this.realtimeQueue = [];
		this.realtimeResponding = false;
		this.realtimeCancelling = false;
		this.pendingUserTranscript = "";
		this.pendingUserTranscriptSent = false;
		this.pendingAssistantTranscript = "";
		this.bufferHasAudio = false;
		this.seededItemIds.clear();
		this.pendingSeedMessages = 0;
		this.seedCounter = 0;
		this.realtimeToolCalls.clear();
	}

	/**
	 * Handles voice websocket payloads from the client.
	 * @param {object} message
	 * @returns {boolean}
	 */
	handleMessage(message) {
		if (message.type === "audio_start") {
			if (Array.isArray(message.tools)) {
				this.tools = message.tools;
			}
			this._openRealtimeSocket();
			return true;
		}

		if (message.type === "audio_chunk" && message.audio) {
			this._openRealtimeSocket();
			const payload = { type: "input_audio_buffer.append", audio: message.audio };
			if (!this.realtimeReady) {
				if (this.realtimeQueue.length < 8) {
					this.realtimeQueue.push(payload);
				}
			} else {
				this._sendRealtime(payload);
			}
			this.bufferHasAudio = true;
			return true;
		}

		if (message.type === "audio_stop") {
			this._closeRealtimeSocket();
			return true;
		}

		if (message.type === "voice_tool_results") {
			if (!Array.isArray(message.results) || message.results.length === 0) {
				return true;
			}
			for (const result of message.results) {
				if (!result?.tool_call_id) {
					continue;
				}
				let output = result.content;
				if (output === undefined) {
					output = result.result;
				}
				if (typeof output !== "string") {
					try {
						output = JSON.stringify(output ?? {});
					} catch (err) {
						output = "";
					}
				}
				this._sendRealtime({
					type: "conversation.item.create",
					item: {
						type: "function_call_output",
						call_id: result.tool_call_id,
						output
					}
				});
			}
			if (!this.realtimeResponding) {
				this._sendRealtime({
					type: "response.create",
					response: {
						modalities: ["audio", "text"]
					}
				});
				this.realtimeResponding = true;
			}
			return true;
		}

		return false;
	}

	/**
	 * Cleans up when the client websocket closes.
	 */
	handleClose() {
		this._closeRealtimeSocket();
	}
}

module.exports = { VoxHandler };
