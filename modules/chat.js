const { createParser } = require("eventsource-parser");

class ChatHandler {
	constructor({ ws, history, apiKey, model = "gpt-4o-mini" }) {
		this.ws = ws;
		this.history = history;
		this.apiKey = apiKey;
		this.model = model;
	}

	async _streamAssistantResponse() {
		const response = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				model: this.model,
				input: this.history,
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

		if (assistantText) {
			this.history.push({ role: "assistant", content: assistantText });
		}
	}

	async handleMessage(message) {
		if (message.type != "user_message" || !message.text) {
			return false;
		}

		this.history.push({ role: "user", content: message.text });

		try {
			await this._streamAssistantResponse();
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
