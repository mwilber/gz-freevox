import { McpClient } from "./mcp-client.js";
import { getMcpConfig } from "./mcp-config.js";

class ChatController {
	/**
	 * @param {object} options
	 * @param {WebSocket} options.socket
	 * @param {Function} options.appendMessage
	 * @param {HTMLElement} options.chatEl
	 * @param {HTMLFormElement} options.formEl
	 * @param {HTMLInputElement} options.inputEl
	 * @param {Function} options.onStreamingChange
	 * @param {Function} options.canSendMessage
	 */
	constructor({
		socket,
		appendMessage,
		chatEl,
		formEl,
		inputEl,
		onStreamingChange,
		canSendMessage
	}) {
		this.socket = socket;
		this.appendMessage = appendMessage;
		this.chatEl = chatEl;
		this.formEl = formEl;
		this.inputEl = inputEl;
		this.onStreamingChange = onStreamingChange;
		this.canSendMessage = canSendMessage;
		this.currentAssistantEl = null;
		this.isStreaming = false;
		this.mcpClient = null;
		this.mcpTools = [];
		this.mcpReadyPromise = null;
		this.toolQueue = [];
		this.toolRouting = new Map();
		this.toolRouteOverrides = { serverTools: [] };

		this._handleSubmit = this._handleSubmit.bind(this);
		this.formEl.addEventListener("submit", this._handleSubmit);

		this.initializeMcpClient();
	}

	/**
	 * @param {boolean} value
	 */
	_setStreaming(value) {
		this.isStreaming = value;
		this.onStreamingChange(this.isStreaming);
	}

	/**
	 * @param {Event} event
	 */
	_handleSubmit(event) {
		event.preventDefault();
		const text = this.inputEl.value.trim();
		if (
			!text ||
			this.isStreaming ||
			this.socket.readyState !== WebSocket.OPEN ||
			(this.canSendMessage && !this.canSendMessage())
		) {
			return;
		}

		this.appendMessage("You", text, "user");
		const sendMessage = () => {
			this.socket.send(JSON.stringify({
				type: "user_message",
				text,
				tools: this.mcpTools
			}));
		};
		Promise.resolve(this.mcpReadyPromise)
			.then(sendMessage)
			.catch(sendMessage);
		this.inputEl.value = "";
		this._setStreaming(true);
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
		if (payload.type === "assistant_delta") {
			if (!this.currentAssistantEl) {
				this.currentAssistantEl = this.appendMessage("Assistant", "", "assistant");
			}
			this.currentAssistantEl.updateBody(
				this.currentAssistantEl.getRawText() + payload.delta,
				{ allowMarkdown: false }
			);
			this.chatEl.scrollTop = this.chatEl.scrollHeight;
			return true;
		}

		if (payload.type === "assistant_done") {
			if (this.currentAssistantEl) {
				this.currentAssistantEl.updateBody(
					this.currentAssistantEl.getRawText(),
					{ allowMarkdown: true }
				);
			}
			this._setStreaming(false);
			this.currentAssistantEl = null;
			return true;
		}

		if (payload.type === "assistant_tool_calls") {
			this.queueToolCalls(payload.toolCalls || []);
			this.executeToolQueue();
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
				results.push({
					tool_call_id: toolCall.toolCallId,
					name: toolCall.name,
					content: JSON.stringify({
						error: "UNSUPPORTED_TOOL_ROUTE",
						message: "Tool is not available on the client."
					})
				});
				continue;
			}

			try {
				const toolResult = await this.mcpClient.callTool(
					toolCall.name,
					toolCall.args || {}
				);
				results.push({
					tool_call_id: toolCall.toolCallId,
					name: toolCall.name,
					content: JSON.stringify(toolResult)
				});
			} catch (error) {
				results.push({
					tool_call_id: toolCall.toolCallId,
					name: toolCall.name,
					content: JSON.stringify({
						error: "TOOL_CALL_FAILED",
						message: error?.message || "Tool call failed."
					})
				});
			}
		}

		this.socket.send(JSON.stringify({ type: "tool_results", results }));
	}

	/**
	 * Resets local streaming state on errors.
	 */
	handleError() {
		if (this.isStreaming) {
			this._setStreaming(false);
		}
		this.currentAssistantEl = null;
	}
}

export { ChatController };
