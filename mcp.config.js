const mcpConfig = {
	servers: [
		// {
		// 	name: "local",
		// 	url: "http://localhost:3000/mcp"
		// },
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

module.exports = { mcpConfig };
