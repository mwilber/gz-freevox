const DEFAULT_CONFIG = {
	servers: [
		{
			name: "webmcp",
			url: "https://gz-webmcp-21aba15ed44e.herokuapp.com/mcp"
		},
		{
			name: "rtm",
			url: "https://gz-rtm-mcp-89ec15c486a9.herokuapp.com/mcp"
		}
	],
	toolRouting: {
		serverTools: []
	}
};

let cachedConfigPromise = null;

/**
 * For cross-origin MCP URLs, the server must expose "mcp-session-id" via CORS.
 * @returns {Promise<{servers: Array, toolRouting: object}>}
 */
export function getMcpConfig() {
	if (!cachedConfigPromise) {
		cachedConfigPromise = fetch("/mcp-config")
			.then((response) => {
				if (!response.ok) {
					throw new Error(`MCP config request failed: ${response.status}`);
				}
				return response.json();
			})
			.then((config) => normalizeConfig(config))
			.catch((error) => {
				console.warn("Failed to load MCP config, using defaults.", error);
				return DEFAULT_CONFIG;
			});
	}

	return cachedConfigPromise;
}

/**
 * @param {object} config
 * @returns {{servers: Array, toolRouting: object}}
 */
function normalizeConfig(config) {
	const servers = Array.isArray(config?.servers) ? config.servers : [];
	return {
		...DEFAULT_CONFIG,
		...config,
		servers: applyLocalOverrides(servers),
		toolRouting: {
			...DEFAULT_CONFIG.toolRouting,
			...(config?.toolRouting || {})
		}
	};
}

/**
 * @param {Array} servers
 * @returns {Array}
 */
function applyLocalOverrides(servers) {
	const rtmUserToken = localStorage.getItem("RTM_USER_TOKEN");
	if (!rtmUserToken) {
		return servers;
	}
	return servers.map((server) => {
		if (server?.name !== "rtm") {
			return server;
		}
		return {
			...server,
			userToken: rtmUserToken
		};
	});
}
