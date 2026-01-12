// const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
// const DEFAULT_LOCAL_URL = "http://localhost:3000/mcp";
const DEFAULT_REMOTE_URL =
  "https://gz-webmcp-21aba15ed44e.herokuapp.com/mcp";
// For cross-origin MCP URLs, the server must expose "mcp-session-id" via CORS.
const DEFAULT_TOOL_ROUTING = {
  serverTools: [],
};

/**
 * @returns {{mcpUrl: string, toolRouting: object}}
 */
export function getMcpConfig() {
  // const hostname = window.location.hostname;
  // const origin = window.location.origin;

  // if (LOCAL_HOSTS.has(hostname)) {
  //   return { mcpUrl: DEFAULT_LOCAL_URL, toolRouting: DEFAULT_TOOL_ROUTING };
  // }

  // if (origin && origin.startsWith("http")) {
  //   return { mcpUrl: `${origin}/mcp`, toolRouting: DEFAULT_TOOL_ROUTING };
  // }

  return { mcpUrl: DEFAULT_REMOTE_URL, toolRouting: DEFAULT_TOOL_ROUTING };
}
