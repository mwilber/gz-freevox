import { getMcpConfig } from "./mcp-config.js";

export class McpClient {
  /**
   * @param {object} [config]
   */
  constructor(config = getMcpConfig()) {
    this.config = config;
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
          version: "1.0.0",
        },
      },
    };

    const response = await fetch(this.config.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
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
      params: {},
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
        arguments: args,
      },
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
      params: request.params,
    };

    const response = await fetch(this.config.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": this.sessionId,
      },
      body: JSON.stringify(payload),
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
}
