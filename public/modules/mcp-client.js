import { getMcpConfig } from "./mcp-config.js";

class McpServerClient {
	/**
	 * @param {object} config
	 */
	constructor(config) {
		this.config = config;
		this.mcpUrl = config.url;
		this.sessionId = null;
		this.requestId = 1;
	}

	/**
	 * @returns {Promise<object|null>}
	 */
	async initialize() {
		const payload = {
			jsonrpc: "2.0",
			id: this.requestId++,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: {
					name: "webmcp-chat-client",
					version: "1.0.0"
				}
			}
		};

		const response = await fetch(this.mcpUrl, {
			method: "POST",
			headers: this._buildHeaders({
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream"
			}),
			body: JSON.stringify(payload)
		});

		if (!response.ok) {
			throw new Error(`MCP initialize failed: ${response.status}`);
		}

		const sessionId = response.headers.get("mcp-session-id");
		if (!sessionId) {
			throw new Error("MCP session ID not returned.");
		}

		this.sessionId = sessionId;
		return this.parseResponse(response);
	}

	/**
	 * @returns {Promise<object|null>}
	 */
	async listTools() {
		return this.sendRequest({
			method: "tools/list",
			params: {}
		});
	}

	/**
	 * @param {string} name
	 * @param {object} [args]
	 * @returns {Promise<object|null>}
	 */
	async callTool(name, args = {}) {
		return this.sendRequest({
			method: "tools/call",
			params: {
				name,
				arguments: args
			}
		});
	}

	/**
	 * @param {object} request
	 * @param {string} request.method
	 * @param {object} request.params
	 * @returns {Promise<object|null>}
	 */
	async sendRequest(request) {
		if (!this.sessionId) {
			await this.initialize();
		}

		const payload = {
			jsonrpc: "2.0",
			id: this.requestId++,
			method: request.method,
			params: request.params
		};

		const response = await fetch(this.mcpUrl, {
			method: "POST",
			headers: this._buildHeaders({
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"mcp-session-id": this.sessionId
			}),
			body: JSON.stringify(payload)
		});

		if (!response.ok) {
			throw new Error(`MCP request failed: ${response.status}`);
		}

		return this.parseResponse(response);
	}

	/**
	 * @param {Response} response
	 * @returns {Promise<object|null>}
	 */
	async parseResponse(response) {
		const contentType = response.headers.get("content-type") || "";
		if (contentType.includes("text/event-stream")) {
			const text = await response.text();
			const dataLine = text
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.startsWith("data:"));

			if (!dataLine) {
				return null;
			}

			const payload = dataLine.replace(/^data:\s*/, "");
			return JSON.parse(payload);
		}

		return response.json();
	}

	/**
	 * @param {object} headers
	 * @returns {object}
	 */
	_buildHeaders(headers) {
		return {
			...(this.config.headers || {}),
			...headers
		};
	}
}

export class McpClient {
	/**
	 * @param {object|Promise<object>} [config]
	 */
	constructor(config = getMcpConfig()) {
		this.configPromise = Promise.resolve(config);
		this.serverClients = new Map();
		this.toolMap = new Map();
	}

	/**
	 * @returns {Promise<void>}
	 */
	async initialize() {
		const config = await this.configPromise;
		this.config = config;

		const servers = Array.isArray(config?.servers) ? config.servers : [];
		this.serverClients = new Map();
		servers.forEach((server, index) => {
			if (!server?.url) {
				return;
			}
			const name = server.name || `server-${index + 1}`;
			this.serverClients.set(name, new McpServerClient(server));
		});

		if (this.serverClients.size === 0) {
			throw new Error("No MCP servers configured.");
		}

		const entries = [...this.serverClients.entries()];
		const results = await Promise.allSettled(
			entries.map(([, client]) => client.initialize())
		);
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length === entries.length) {
			throw new Error("MCP initialize failed for every configured server.");
		}
		results.forEach((result, index) => {
			if (result.status !== "rejected") {
				return;
			}
			const serverName = entries[index][0];
			console.warn(`MCP initialize failed for ${serverName}:`, result.reason);
		});
	}

	/**
	 * @returns {Promise<object|null>}
	 */
	async listTools() {
		if (this.serverClients.size === 0) {
			await this.initialize();
		}

		const entries = [...this.serverClients.entries()];
		const results = await Promise.allSettled(
			entries.map(([, client]) => client.listTools())
		);

		const tools = [];
		this.toolMap = new Map();

		results.forEach((result, index) => {
			const [serverName, client] = entries[index];
			if (result.status !== "fulfilled") {
				console.warn(`Failed to list MCP tools for ${serverName}:`, result.reason);
				return;
			}

			const serverTools = result.value?.result?.tools || [];
			serverTools.forEach((tool) => {
				if (!tool?.name) {
					return;
				}
				if (this.toolMap.has(tool.name)) {
					console.warn(`Duplicate MCP tool "${tool.name}" from ${serverName} ignored.`);
					return;
				}
				this.toolMap.set(tool.name, client);
				tools.push(tool);
			});
		});

		return { result: { tools } };
	}

	/**
	 * @param {string} name
	 * @param {object} [args]
	 * @returns {Promise<object|null>}
	 */
	async callTool(name, args = {}) {
		if (!this.toolMap.size) {
			await this.listTools();
		}

		const client = this.toolMap.get(name);
		if (!client) {
			throw new Error(`Unknown MCP tool: ${name}`);
		}

		return client.callTool(name, args);
	}
}
