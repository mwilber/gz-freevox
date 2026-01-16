const { createParser } = require("eventsource-parser");

class ChatHandler {
	/**
	 * @param {object} options
	 * @param {object} options.ws
	 * @param {Array} options.history
	 * @param {string} options.apiKey
	 * @param {string} [options.model]
	 * @param {Function} [options.onMessage]
	 */
	constructor({ ws, history, apiKey, model = "gpt-4o-mini", onMessage }) {
		this.ws = ws;
		this.history = history;
		this.apiKey = apiKey;
		this.model = model;
		this.onMessage = onMessage;
		this.tools = [];
		this.pendingToolCalls = [];
		this.pendingToolResults = [];
	}

	/**
	 * Streams a Responses API call and collects tool calls.
	 * @param {object} [options]
	 * @param {Array} [options.tools]
	 * @returns {Promise<{assistantText: string, toolCalls: Array}>}
	 */
	async _streamAssistantResponse({ tools } = {}) {
		const input = this.history.map((message) => {
			if (!message || typeof message !== "object") {
				return message;
			}
			if (!message.tool_calls) {
				return message;
			}
			const { tool_calls, ...rest } = message;
			return rest;
		});
		const pendingToolCalls = this.pendingToolCalls;
		const pendingToolResults = this.pendingToolResults;
		if (pendingToolCalls.length > 0) {
			input.push(...pendingToolCalls);
		}
		if (pendingToolResults.length > 0) {
			input.push(...pendingToolResults);
		}
		const requestBody = {
			model: this.model,
			input,
			stream: true
		};

		if (Array.isArray(tools) && tools.length > 0) {
			requestBody.tools = tools;
		}

		const response = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(requestBody)
		});

		if (!response.ok || !response.body) {
			const detail = await response.text();
			throw new Error(detail || "Bad response from OpenAI.");
		}

		const decoder = new TextDecoder();
		let assistantText = "";
		const toolCalls = new Map();

		const parser = createParser((event) => {
			if (event.type != "event") {
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

			if (payload.type === "response.output_item.added") {
				const item = payload.item;
				if (item?.type === "function_call") {
					const itemId = item.id || item.call_id;
					const callId = item.call_id || item.id;
					if (!itemId) {
						return;
					}
					toolCalls.set(itemId, {
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
					toolCalls.get(payload.item_id) ||
					[...toolCalls.values()].find((entry) => entry.call_id === payload.item_id);
				if (call) {
					call.function.arguments += payload.delta || "";
				}
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
						toolCalls.get(itemId) ||
						[...toolCalls.values()].find((entry) => entry.call_id === callId);
					if (call) {
						call.id = itemId || call.id;
						call.call_id = callId || call.call_id;
						call.function.name = item.name || call.function.name;
						if (typeof item.arguments === "string") {
							call.function.arguments = item.arguments;
						}
					} else {
						toolCalls.set(itemId, {
							id: itemId,
							call_id: callId,
							function: {
								name: item.name,
								arguments: item.arguments || ""
							}
						});
					}
				}
			}

			if (payload.type === "response.output_text.delta") {
				assistantText += payload.delta || "";
				this.ws.send(JSON.stringify({
					type: "assistant_delta",
					delta: payload.delta || ""
				}));
			}

			if (payload.type === "response.completed") {
				this.ws.send(JSON.stringify({ type: "assistant_done" }));
			}
		});

		for await (const chunk of response.body) {
			parser.feed(decoder.decode(chunk, { stream: true }));
		}

		this.pendingToolCalls = [];
		this.pendingToolResults = [];
		return {
			assistantText,
			toolCalls: Array.from(toolCalls.values())
		};
	}

	/**
	 * Handles incoming websocket payloads for text chat and tool results.
	 * @param {object} message
	 * @returns {Promise<boolean>}
	 */
	async handleMessage(message) {
		if (message.type != "user_message" || !message.text) {
			return this._handleToolResults(message);
		}

		this.history.push({ role: "user", content: message.text });
		if (this.onMessage) {
			this.onMessage({ role: "user", content: message.text });
		}
		if (Array.isArray(message.tools)) {
			this.tools = message.tools;
		}

		try {
			await this._handleAssistantResponse();
		} catch (err) {
			this.ws.send(JSON.stringify({
				type: "error",
				message: "OpenAI request failed.",
				detail: err.message
			}));
		}

		return true;
	}

	/**
	 * Sends a request to the model and routes tool call results.
	 * @returns {Promise<void>}
	 */
	async _handleAssistantResponse() {
		const { assistantText, toolCalls } = await this._streamAssistantResponse({
			tools: this.tools
		});

		if (toolCalls.length > 0) {
			if (assistantText) {
				this.history.push({ role: "assistant", content: assistantText });
				if (this.onMessage) {
					this.onMessage({ role: "assistant", content: assistantText });
				}
			}
			this.pendingToolCalls = toolCalls.map((toolCall) => ({
				type: "function_call",
				id: toolCall.id,
				call_id: toolCall.call_id || toolCall.id,
				name: toolCall.function?.name,
				arguments: toolCall.function?.arguments || ""
			}));
			this.ws.send(JSON.stringify({
				type: "assistant_tool_calls",
				toolCalls
			}));
			return;
		}

		if (assistantText) {
			this.history.push({ role: "assistant", content: assistantText });
			if (this.onMessage) {
				this.onMessage({ role: "assistant", content: assistantText });
			}
		}
	}

	/**
	 * Applies tool outputs and triggers a follow-up model response.
	 * @param {object} message
	 * @returns {Promise<boolean>}
	 */
	async _handleToolResults(message) {
		if (message.type !== "tool_results") {
			return false;
		}

		if (!Array.isArray(message.results) || message.results.length === 0) {
			this.ws.send(JSON.stringify({
				type: "error",
				message: "Invalid tool results payload."
			}));
			return true;
		}

		for (const result of message.results) {
			if (!result || !result.tool_call_id) {
				continue;
			}
			let content = result.content;
			if (content === undefined) {
				content = result.result;
			}
			if (typeof content !== "string") {
				try {
					content = JSON.stringify(content ?? {});
				} catch (err) {
					content = "";
				}
			}
			this.pendingToolResults.push({
				type: "function_call_output",
				call_id: result.tool_call_id,
				output: content
			});
		}

		try {
			await this._handleAssistantResponse();
		} catch (err) {
			this.ws.send(JSON.stringify({
				type: "error",
				message: "OpenAI request failed.",
				detail: err.message
			}));
		}

		return true;
	}
}

module.exports = { ChatHandler };
