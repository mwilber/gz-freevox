import { McpClient } from "./mcp-client.js";
import { getMcpConfig } from "./mcp-config.js";

class VoxController {
	/**
	 * @param {object} options
	 * @param {WebSocket} options.socket
	 * @param {Function} options.appendMessage
	 * @param {Function} [options.appendToolResult]
	 * @param {HTMLElement} options.chatEl
	 * @param {HTMLElement} options.voiceToggle
	 * @param {Function} options.onVoiceActiveChange
	 * @param {Function} options.canStartVoice
	 */
	constructor({
		socket,
		appendMessage,
		appendToolResult,
		chatEl,
		voiceToggle,
		onVoiceActiveChange,
		canStartVoice
	}) {
		this.socket = socket;
		this.appendMessage = appendMessage;
		this.appendToolResult = appendToolResult;
		this.chatEl = chatEl;
		this.voiceToggle = voiceToggle;
		this.onVoiceActiveChange = onVoiceActiveChange;
		this.canStartVoice = canStartVoice;

		this.isVoiceActive = false;
		this.voiceStream = null;
		this.voiceContext = null;
		this.voiceProcessor = null;
		this.voiceSource = null;
		this.voiceSilence = null;
		this.playbackContext = null;
		this.playbackTime = 0;
		this.playbackNodes = [];
		this.voiceAssistantEl = null;
		this.voiceUserEl = null;
		this.isAssistantSpeaking = false;
		this.suppressAssistantAudio = false;
		this.mcpClient = null;
		this.mcpTools = [];
		this.mcpReadyPromise = null;
		this.toolQueue = [];
		this.toolRouting = new Map();
		this.toolRouteOverrides = { serverTools: [] };

		this._handleToggle = this._handleToggle.bind(this);
		this.voiceToggle.addEventListener("click", this._handleToggle);
		this._updateVoiceUi(false);
		this.initializeMcpClient();
	}

	/**
	 * Toggles the voice session on click.
	 */
	_handleToggle() {
		if (this.isVoiceActive) {
			this.stopVoiceSession({ notifyServer: true });
			return;
		}
		this.startVoiceSession();
	}

	/**
	 * Starts capture and opens the voice session.
	 * @returns {Promise<void>}
	 */
	async startVoiceSession() {
		if (
			this.isVoiceActive ||
			this.socket.readyState !== WebSocket.OPEN ||
			(this.canStartVoice && !this.canStartVoice())
		) {
			return;
		}

		try {
			this.voiceStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true
				}
			});
		} catch (err) {
			this.appendMessage("System", "Microphone access was blocked.", "assistant");
			return;
		}

		this.voiceContext = new AudioContext({ sampleRate: 24000 });
		this.playbackContext = new AudioContext({ sampleRate: 24000 });
		await this._resumeAudioContext(this.playbackContext);
		await this._resumeAudioContext(this.voiceContext);

		this.voiceSource = this.voiceContext.createMediaStreamSource(this.voiceStream);
		this.voiceProcessor = this.voiceContext.createScriptProcessor(4096, 1, 1);
		this.voiceSilence = this.voiceContext.createGain();
		this.voiceSilence.gain.value = 0;

		this.voiceProcessor.onaudioprocess = (event) => {
			if (!this.isVoiceActive || this.socket.readyState !== WebSocket.OPEN) {
				return;
			}
			const inputData = event.inputBuffer.getChannelData(0);
			const pcm16 = this._floatTo16BitPCM(inputData);
			const base64 = this._pcm16ToBase64(pcm16);
			this.socket.send(JSON.stringify({ type: "audio_chunk", audio: base64 }));
		};

		this.voiceSource.connect(this.voiceProcessor);
		this.voiceProcessor.connect(this.voiceSilence);
		this.voiceSilence.connect(this.voiceContext.destination);

		const finalizeStart = (payload) => {
			this.socket.send(JSON.stringify(payload));
			this.isVoiceActive = true;
			this._updateVoiceUi(true);
			this.onVoiceActiveChange(true);
			this._stopPlayback();
		};
		Promise.resolve(this.mcpReadyPromise)
			.then(() => {
				finalizeStart({ type: "audio_start", tools: this.mcpTools });
			})
			.catch(() => {
				finalizeStart({ type: "audio_start" });
			});
	}

	/**
	 * Stops capture and closes the voice session.
	 * @param {object} options
	 * @param {boolean} options.notifyServer
	 */
	stopVoiceSession({ notifyServer }) {
		if (!this.isVoiceActive && !this.voiceStream) {
			return;
		}

		this.isVoiceActive = false;
		if (notifyServer && this.socket.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify({ type: "audio_stop" }));
		}

		if (this.voiceProcessor) {
			this.voiceProcessor.disconnect();
			this.voiceProcessor.onaudioprocess = null;
		}
		if (this.voiceSource) {
			this.voiceSource.disconnect();
		}
		if (this.voiceSilence) {
			this.voiceSilence.disconnect();
		}
		if (this.voiceStream) {
			this.voiceStream.getTracks().forEach((track) => track.stop());
		}
		this._stopPlayback();
		if (this.voiceContext) {
			this.voiceContext.close();
		}
		if (this.playbackContext) {
			this.playbackContext.close();
		}

		this.voiceStream = null;
		this.voiceContext = null;
		this.voiceProcessor = null;
		this.voiceSource = null;
		this.voiceSilence = null;
		this.playbackContext = null;
		this.voiceAssistantEl = null;
		this.voiceUserEl = null;
		this._updateVoiceUi(false);
		this.onVoiceActiveChange(false);
	}

	/**
	 * Initializes the MCP client and tool list.
	 */
	initializeMcpClient() {
		this.mcpReadyPromise = getMcpConfig()
			.then((config) => {
				this.toolRouteOverrides = config.toolRouting || { serverTools: [] };
				this.mcpClient = new McpClient(config);
				return this.mcpClient.initialize();
			})
			.then(() => this.loadMcpTools())
			.catch((error) => {
				console.error("Failed to initialize MCP client:", error);
			});
	}

	/**
	 * Loads MCP tools and builds tool routing.
	 * @returns {Promise<void>}
	 */
	async loadMcpTools() {
		const toolsResponse = await this.mcpClient.listTools();
		const tools = toolsResponse?.result?.tools || [];
		const serverTools = new Set(
			this.toolRouteOverrides?.serverTools || []
		);
		this.mcpTools = tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters: tool.inputSchema || { type: "object", properties: {} }
		}));
		this.toolRouting = new Map(
			tools.map((tool) => [
				tool.name,
				serverTools.has(tool.name) ? "server" : "client"
			])
		);
	}

	/**
	 * @param {object} payload
	 * @returns {boolean}
	 */
	handleSocketMessage(payload) {
		if (payload.type === "assistant_voice_text_delta") {
			if (!this.voiceAssistantEl) {
				this.voiceAssistantEl = this.appendMessage("Assistant", "", "assistant");
			}
			this.voiceAssistantEl.updateBody(
				this.voiceAssistantEl.getRawText() + payload.delta,
				{ allowMarkdown: false }
			);
			this.chatEl.scrollTop = this.chatEl.scrollHeight;
			return true;
		}

		if (payload.type === "assistant_voice_text_done") {
			if (this.voiceAssistantEl) {
				this.voiceAssistantEl.updateBody(
					this.voiceAssistantEl.getRawText(),
					{ allowMarkdown: true }
				);
			}
			this.voiceAssistantEl = null;
			return true;
		}

		if (payload.type === "user_voice_start") {
			this.suppressAssistantAudio = true;
			if (this.isAssistantSpeaking || this.playbackNodes.length > 0) {
				this._stopPlayback();
			}
			if (!this.voiceUserEl) {
				this.voiceUserEl = this.appendMessage("You", "…", "user");
			} else {
				this.voiceUserEl.updateBody("…", { allowMarkdown: false });
			}
			return true;
		}

		if (payload.type === "user_voice_text_delta") {
			if (!this.voiceUserEl) {
				this.voiceUserEl = this.appendMessage("You", "", "user");
			}
			const currentText = this.voiceUserEl.getRawText();
			const nextText = currentText === "…" ? payload.delta : currentText + payload.delta;
			this.voiceUserEl.updateBody(
				nextText,
				{ allowMarkdown: false }
			);
			this.chatEl.scrollTop = this.chatEl.scrollHeight;
			return true;
		}

		if (payload.type === "user_voice_text_done") {
			this.suppressAssistantAudio = false;
			if (this.voiceUserEl) {
				this.voiceUserEl.updateBody(
					this.voiceUserEl.getRawText(),
					{ allowMarkdown: true }
				);
			}
			this.voiceUserEl = null;
			return true;
		}

		if (payload.type === "assistant_audio_delta") {
			if (this.suppressAssistantAudio) {
				return true;
			}
			this.isAssistantSpeaking = true;
			this._queueAudioPlayback(payload.audio || "");
			return true;
		}

		if (payload.type === "assistant_audio_interrupt") {
			this.suppressAssistantAudio = false;
			this.isAssistantSpeaking = false;
			this._stopPlayback();
			this.voiceAssistantEl = null;
			return true;
		}

		if (payload.type === "assistant_audio_done") {
			this.suppressAssistantAudio = false;
			this.isAssistantSpeaking = false;
			this.playbackTime = Math.max(this.playbackTime, this.playbackContext ? this.playbackContext.currentTime : 0);
			return true;
		}

		if (payload.type === "assistant_voice_tool_calls") {
			this.queueToolCalls(payload.toolCalls || []);
			this.executeToolQueue();
			return true;
		}

		if (payload.type === "assistant_voice_error") {
			if (this.appendToolResult) {
				const content = {
					message: payload.message || "Voice error",
					code: payload.code || undefined,
					detail: payload.detail
				};
				this.appendToolResult("Voice error", content, {
					variant: "error",
					label: "Voice error"
				});
			} else if (this.appendMessage) {
				const detail = payload.message || "Voice error";
				this.appendMessage("System", detail, "assistant");
			}
			return true;
		}

		return false;
	}

	/**
	 * @param {Array} toolCalls
	 */
	queueToolCalls(toolCalls) {
		for (const toolCall of toolCalls) {
			let args = {};
			if (toolCall.function?.arguments) {
				try {
					args = JSON.parse(toolCall.function.arguments);
				} catch (error) {
					console.error("Failed to parse tool arguments:", error);
				}
			}
			this.toolQueue.push({
				toolCallId: toolCall.call_id || toolCall.id,
				name: toolCall.function?.name,
				args
			});
		}
	}

	/**
	 * @returns {Promise<void>}
	 */
	async executeToolQueue() {
		if (this.toolQueue.length === 0 || this.socket.readyState !== WebSocket.OPEN) {
			return;
		}

		const pendingCalls = [...this.toolQueue];
		this.toolQueue = [];
		const results = [];

		for (const toolCall of pendingCalls) {
			const route = this.toolRouting.get(toolCall.name) || "client";
			if (route !== "client") {
				const content = JSON.stringify({
					error: "UNSUPPORTED_TOOL_ROUTE",
					message: "Tool is not available on the client."
				});
				results.push({
					tool_call_id: toolCall.toolCallId,
					name: toolCall.name,
					content
				});
				if (this.appendToolResult) {
					this.appendToolResult(toolCall.name, content);
				}
				continue;
			}

			try {
				const toolResult = await this.mcpClient.callTool(
					toolCall.name,
					toolCall.args || {}
				);
				const content = JSON.stringify(toolResult);
				results.push({
					tool_call_id: toolCall.toolCallId,
					name: toolCall.name,
					content
				});
				if (this.appendToolResult) {
					this.appendToolResult(toolCall.name, content);
				}
			} catch (error) {
				const content = JSON.stringify({
					error: "TOOL_CALL_FAILED",
					message: error?.message || "Tool call failed."
				});
				results.push({
					tool_call_id: toolCall.toolCallId,
					name: toolCall.name,
					content
				});
				if (this.appendToolResult) {
					this.appendToolResult(toolCall.name, content);
				}
			}
		}

		this.socket.send(JSON.stringify({ type: "voice_tool_results", results }));
	}

	/**
	 * Handles websocket closure by tearing down audio.
	 */
	handleSocketClose() {
		this.stopVoiceSession({ notifyServer: false });
	}

	/**
	 * @param {boolean} active
	 */
	_updateVoiceUi(active) {
		if (!this.voiceToggle) {
			return;
		}
		const nextLabel = active ? "End voice" : "Start voice";
		const labelEl = this.voiceToggle.querySelector(".voice__label");
		if (labelEl) {
			labelEl.textContent = nextLabel;
		}
		this.voiceToggle.setAttribute("aria-label", nextLabel);
		this.voiceToggle.classList.toggle("is-active", active);
	}

	/**
	 * @param {Float32Array} float32Array
	 * @returns {Int16Array}
	 */
	_floatTo16BitPCM(float32Array) {
		const output = new Int16Array(float32Array.length);
		for (let i = 0; i < float32Array.length; i += 1) {
			const s = Math.max(-1, Math.min(1, float32Array[i]));
			output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
		}
		return output;
	}

	/**
	 * @param {Int16Array} pcm16Array
	 * @returns {string}
	 */
	_pcm16ToBase64(pcm16Array) {
		const bytes = new Uint8Array(pcm16Array.buffer);
		let binary = "";
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		return btoa(binary);
	}

	/**
	 * @param {string} base64
	 * @returns {Int16Array}
	 */
	_base64ToInt16(base64) {
		if (!base64) {
			return new Int16Array(0);
		}
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new Int16Array(bytes.buffer);
	}

	/**
	 * @param {string} base64
	 */
	_queueAudioPlayback(base64) {
		if (!this.playbackContext || !base64) {
			return;
		}
		const pcm16 = this._base64ToInt16(base64);
		if (!pcm16.length) {
			return;
		}
		const float32 = new Float32Array(pcm16.length);
		for (let i = 0; i < pcm16.length; i += 1) {
			float32[i] = pcm16[i] / 0x8000;
		}

		const buffer = this.playbackContext.createBuffer(1, float32.length, 24000);
		buffer.getChannelData(0).set(float32);
		const source = this.playbackContext.createBufferSource();
		source.buffer = buffer;
		source.connect(this.playbackContext.destination);

		const startTime = Math.max(this.playbackContext.currentTime, this.playbackTime);
		source.start(startTime);
		this.playbackTime = startTime + buffer.duration;
		this.playbackNodes.push(source);
		source.onended = () => {
			this.playbackNodes = this.playbackNodes.filter((node) => node !== source);
		};
	}

	/**
	 * Stops queued playback sources.
	 */
	_stopPlayback() {
		this.playbackNodes.forEach((node) => {
			try {
				node.stop();
			} catch (err) {
				// Ignore playback stop errors.
			}
		});
		this.playbackNodes = [];
		this.isAssistantSpeaking = false;
		this.playbackTime = this.playbackContext ? this.playbackContext.currentTime : 0;
	}

	/**
	 * @param {AudioContext} context
	 * @returns {Promise<void>}
	 */
	async _resumeAudioContext(context) {
		if (!context) {
			return;
		}
		if (context.state === "suspended") {
			try {
				await context.resume();
			} catch (err) {
				// Ignore resume errors.
			}
		}
	}
}

export { VoxController };
