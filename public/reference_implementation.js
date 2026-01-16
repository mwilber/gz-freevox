/**!
 *	alpha
 *	Generation date: 2026-01-10T13:44:29.433Z
 *	Package Type: Core alacarte
 *	Build descriptor: v9.2.0-572-ga11407fe8
 */

/***********************************************************!
 * Copyright © 2025 S&P Global All rights reserved
*************************************************************/
/*************************************! DO NOT MAKE CHANGES TO THIS LIBRARY FILE!! !*************************************
* If you wish to overwrite default functionality, create a separate file with a copy of the methods you are overwriting *
* and load that file right after the library has been loaded, but before the chart engine is instantiated.              *
* Directly modifying library files will prevent upgrades and the ability for ChartIQ to support your solution.          *
*************************************************************************************************************************/
/* eslint-disable no-extra-parens */


// Manages a chat application interface that integrates with AI services and executes chart
// CLI commands through a tool queue system.
// import { Executor } from "../../cli/Executor.js";
// import { CIQ } from "../../../js/chartiq.js";
import { McpClient } from "./mcp-client.js";
import { getMcpConfig } from "./mcp-config.js";

// ChatApp class definition
export class ChatApp {
	constructor(cliEl, proxyUrl, maxRetries = 3) {
		this.cliEl = cliEl;
		// this.executor = null;
		this.proxyUrl = proxyUrl;
		this.conversation = null;
		this.input = null;
		this.sendBtn = null;
		this.placeholderEl = null;
		this.payload = {
			messages: []
		};
		this.toolQueue = [];
		this.mcpClient = null;
		this.mcpTools = [];
		this.mcpReadyPromise = null;
		this.toolRouting = new Map();
		this.toolRouteOverrides = { serverTools: [] };
		// Loop guard tracking
		this.commandHistory = [];
		this.maxRetries = maxRetries;
		this.commandHistoryWindow = 20; // Keep last 20 commands
		this.patternSize = 2; // Minimum pattern size to detect (e.g., add->remove)
	}

	// Initializes the chat application by setting up DOM elements, creating the executor,
	// and configuring event listeners.
	async init() {
		this.conversation = document.getElementById("conversation");
		this.input = document.getElementById("message-input");
		this.sendBtn = document.getElementById("send-button");

		// Set up the executor function to handle tool responses using the local
		// toolResponse method.
		// this.executor = await this.cliEl.getExecutor({
		// 	toolResponse: this.handleToolResponse.bind(this)
		// });

		this.setupEventListeners();
		this.initializeMcpClient();
	}

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

	async loadMcpTools() {
		const toolsResponse = await this.mcpClient.listTools();
		const tools = toolsResponse?.result?.tools || [];
		const serverTools = new Set(
			this.toolRouteOverrides?.serverTools || []
		);
		this.mcpTools = tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description || "",
				parameters: tool.inputSchema || { type: "object", properties: {} }
			}
		}));
		this.toolRouting = new Map(
			tools.map((tool) => [
				tool.name,
				serverTools.has(tool.name) ? "server" : "client"
			])
		);
	}

	// Adds a message object to the conversation payload array for tracking the conversation history.
	addMessageToPayload(message) {
		this.payload.messages.push({
			...message
		});
	}

	// Tracks command execution for loop detection, maintaining a sliding window of recent commands.
	// trackCommand(command, status, toolResponse, errorType = null) {
	// 	this.commandHistory.push({
	// 		command,
	// 		status,
	// 		timestamp: Date.now(),
	// 		success:
	// 			status === Executor.OK &&
	// 			(!toolResponse || toolResponse.success !== false),
	// 		toolResponse,
	// 		errorType // 'execution', 'chart', or null
	// 	});
	//
	// 	// Maintain sliding window of command history
	// 	while (this.commandHistory.length > this.commandHistoryWindow) {
	// 		this.commandHistory.shift();
	// 	}
	// }

	// Detects if a command or pattern of commands is repeating, indicating an infinite loop.
	// Checks both single command repetition and command sequence patterns.
	// detectLoop(command) {
	// 	// First check for single command repetition
	// 	const recentAttempts = this.commandHistory
	// 		.filter((h) => h.command === command)
	// 		.slice(-this.maxRetries);
	//
	// 	let result = {
	// 		detected: false,
	// 		pattern: null,
	// 		repetitions: 0
	// 	};
	//
	// 	if (recentAttempts.length >= this.maxRetries) {
	// 		const allFailed = recentAttempts.every((h) => !h.success);
	// 		if (allFailed) {
	// 			result.detected = true;
	// 			result.pattern = [command];
	// 			result.repetitions = recentAttempts.length;
	// 		}
	// 	}
	//
	// 	// Then check for pattern loops (sequences of commands)
	// 	if (this.commandHistory.length >= this.patternSize * 2) {
	// 		// Try different pattern sizes (2, 3, 4 commands)
	// 		for (
	// 			let patternLength = this.patternSize;
	// 			patternLength <= 4;
	// 			patternLength++
	// 		) {
	// 			const minRequiredLength = patternLength * 2;
	// 			if (this.commandHistory.length < minRequiredLength) continue;
	//
	// 			// Get the most recent commands
	// 			const recentCommands = this.commandHistory.slice(
	// 				-minRequiredLength * this.maxRetries
	// 			);
	//
	// 			// Extract just the command strings for pattern matching
	// 			const commandSequence = recentCommands.map((h) => h.command);
	//
	// 			// Get the potential pattern (last N commands)
	// 			const pattern = commandSequence.slice(-patternLength);
	//
	// 			// Count how many times this pattern appears consecutively at the end
	// 			let repetitions = 0;
	// 			for (
	// 				let i = commandSequence.length - patternLength;
	// 				i >= 0;
	// 				i -= patternLength
	// 			) {
	// 				const segment = commandSequence.slice(i, i + patternLength);
	//
	// 				// Check if this segment matches the pattern
	// 				if (
	// 					segment.length === pattern.length &&
	// 					segment.every((cmd, idx) => cmd === pattern[idx])
	// 				) {
	// 					repetitions++;
	// 				} else {
	// 					break; // Pattern broken
	// 				}
	// 			}
	//
	// 			// If pattern repeats at least maxRetries times, it's a loop
	// 			if (repetitions >= this.maxRetries) {
	// 				result.detected = true;
	// 				result.pattern = pattern;
	// 				result.repetitions = repetitions;
	// 			}
	// 		}
	// 	}
	// 	return result;
	// }

	// Sends user input to the AI service via proxy and handles the network request and
	// response processing.
	sendMessage() {
		const text = this.input.value.trim();
		if (!text) return null;
		this.addMessageToPayload({
			role: "user",
			content: text
		});
		this.input.value = "";
		// Post the outgoing message to the chat panel.
		this.receiveMessage(
			this.payload.messages[this.payload.messages.length - 1]
		);
		this.sendRequest();
	}

	// Sends fetch request containing message payload to remote server.
	sendRequest() {
		Promise.resolve(this.mcpReadyPromise)
			.then(() =>
				fetch(this.proxyUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json"
					},
					body: JSON.stringify({
						query: this.payload,
						tools: this.mcpTools
					})
				})
			)
			.then((response) => response.text())
			.then((data) => this.processAIResponse(data))
			.catch((error) => {
				console.error("Error:", error);
			});
	}

	// Executes the next command in the tool queue by displaying it in the chat and running
	// it through the executor. Includes loop detection to prevent infinite retry cycles.
	// async executeToolQueue() {
	// 	if (this.toolQueue.length === 0) return;
	// 	const { command, toolId, tool } = this.toolQueue[0];
	//
	// 	// Check for loops (both single command and patterns)
	// 	const loopCheck = this.detectLoop(command);
	// 	if (loopCheck.detected) {
	// 		this.toolQueue.shift();
	//
	// 		// Send loop detection error to AI
	// 		this.addMessageToPayload({
	// 			role: "tool",
	// 			tool_call_id: toolId,
	// 			name: tool,
	// 			content: JSON.stringify({
	// 				error: "LOOP_DETECTED",
	// 				...loopCheck,
	// 				_executionStatus: "LOOP_DETECTED"
	// 			})
	// 		});
	//
	// 		this.receiveMessage({
	// 			role: "error",
	// 			content: "Loop detected. Asking AI to stop repeating commands."
	// 		});
	//
	// 		// Clear remaining queue and send error to AI
	// 		this.toolQueue = [];
	// 		this.sendRequest();
	// 		return;
	// 	}
	//
	// 	this.receiveMessage({
	// 		role: "cli",
	// 		content: command
	// 	});
	// 	const status = await this.executor(command);
	// 	if (status !== Executor.OK) {
	// 		// Track failed execution
	// 		this.trackCommand(command, status, null, "execution");
	//
	// 		// Send error to AI instead of just showing in UI
	// 		const currentCommand = this.toolQueue.shift();
	// 		this.addMessageToPayload({
	// 			role: "tool",
	// 			tool_call_id: currentCommand.toolId,
	// 			name: currentCommand.tool,
	// 			content: JSON.stringify({
	// 				error: "EXECUTION_FAILED",
	// 				message: `Command failed with status ${status}: ${Executor.signal[status]}`,
	// 				command: command,
	// 				statusCode: status,
	// 				statusName: Executor.signal[status],
	// 				_executionStatus: "FAILED"
	// 			})
	// 		});
	//
	// 		this.receiveMessage({
	// 			role: "error",
	// 			content: `Error executing command: ${command} (status: ${Executor.signal[status]})`
	// 		});
	//
	// 		// Clear queue and send error to AI
	// 		if (this.toolQueue.length > 0) {
	// 			this.receiveMessage({
	// 				role: "system",
	// 				content: "Clearing remaining commands due to error."
	// 			});
	// 			this.toolQueue = [];
	// 		}
	// 		this.sendRequest();
	// 	}
	// }

	// Processes the response from a tool execution and continues processing the queue or sends
	// results back to AI.
	// handleToolResponse(data) {
	// 	const currentCommand = this.toolQueue.shift();
	// 	if (!currentCommand) return;
	//
	// 	// Check for chart-level error (success: false in response)
	// 	if (data && data.success === false) {
	// 		// Track chart-level failure
	// 		this.trackCommand(currentCommand.command, Executor.OK, data, "chart");
	//
	// 		// Send chart error to AI
	// 		this.addMessageToPayload({
	// 			role: "tool",
	// 			tool_call_id: currentCommand.toolId,
	// 			name: currentCommand.tool,
	// 			content: JSON.stringify({
	// 				...data,
	// 				error: "CHART_ERROR",
	// 				message:
	// 					data.message ||
	// 					`Chart operation failed for command: ${currentCommand.command}`,
	// 				command: currentCommand.command,
	// 				_executionStatus: "CHART_ERROR"
	// 			})
	// 		});
	//
	// 		this.receiveMessage({
	// 			role: "error",
	// 			content: `Chart error: ${
	// 				data.message || currentCommand.command + " failed"
	// 			}`
	// 		});
	//
	// 		// Clear queue and send error to AI
	// 		if (this.toolQueue.length > 0) {
	// 			this.receiveMessage({
	// 				role: "system",
	// 				content: "Clearing remaining commands due to chart error."
	// 			});
	// 			this.toolQueue = [];
	// 		}
	// 		this.sendRequest();
	// 		return;
	// 	}
	//
	// 	// Track successful execution
	// 	this.trackCommand(currentCommand.command, Executor.OK, data, null);
	//
	// 	// Add SUCCESS indicator to tool response
	// 	const responseData = {
	// 		...data,
	// 		_executionStatus: "SUCCESS"
	// 	};
	//
	// 	this.addMessageToPayload({
	// 		role: "tool",
	// 		// role: 'function', // Uncomment if you want to use 'function' role instead
	// 		tool_call_id: currentCommand.toolId,
	// 		name: currentCommand.tool,
	// 		content: JSON.stringify(responseData)
	// 	});
	// 	this.receiveMessage(
	// 		this.payload.messages[this.payload.messages.length - 1]
	// 	);
	//
	// 	// Process the next tool in the queue. When done, send the updated message payload
	// 	// back to the LLM to respond to the tool result.
	// 	if (this.toolQueue.length > 0) {
	// 		this.executeToolQueue();
	// 	} else {
	// 		this.sendRequest();
	// 	}
	// }

	// Parses and processes the AI response, handling both text messages and command
	// sequences for execution.
	async processAIResponse(data) {
		const jsonData = JSON.parse(data);

		if (!jsonData) {
			this.echo("I'm sorry, Dave. I'm afraid I can't do that.");
			return;
		}

		// Handle an error
		if (jsonData?.error) {
			this.receiveMessage("Error: " + jsonData.error);
			return;
		}

		const { cmd, message, apiResponseMessage, toolCalls } = jsonData;
		const mcpToolCalls =
			toolCalls || apiResponseMessage?.tool_calls || [];

		if (apiResponseMessage) {
			this.payload.messages.push(apiResponseMessage);
		}

		if (mcpToolCalls.length > 0) {
			this.queueToolCalls(mcpToolCalls);
			this.executeToolQueue();
			return;
		}

		if (cmd && cmd.length) {
			if (message)
				this.receiveMessage({
					role: "assistant",
					content: message
				});
			// Add commands to the tool queue for batch processing
			// for (const command of cmd) {
			// 	this.toolQueue.push({
			// 		command: command.command || command,
			// 		toolId: command.toolId || "",
			// 		tool: command.tool || "chart"
			// 	});
			// }
			// Begin processing the tool queue
			// this.executeToolQueue();
		} else if (message) {
			this.addMessageToPayload({
				role: "assistant",
				content: message
			});
			this.receiveMessage(
				this.payload.messages[this.payload.messages.length - 1]
			);
		}
	}

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
				toolCallId: toolCall.id,
				name: toolCall.function?.name,
				args
			});
		}
	}

	async executeToolQueue() {
		if (this.toolQueue.length === 0) return;

		const pendingCalls = [...this.toolQueue];
		this.toolQueue = [];

		for (const toolCall of pendingCalls) {
			const route = this.toolRouting.get(toolCall.name) || "client";
			if (route !== "client") {
				this.addMessageToPayload({
					role: "tool",
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
				this.addMessageToPayload({
					role: "tool",
					tool_call_id: toolCall.toolCallId,
					name: toolCall.name,
					content: JSON.stringify(toolResult)
				});
			} catch (error) {
				this.addMessageToPayload({
					role: "tool",
					tool_call_id: toolCall.toolCallId,
					name: toolCall.name,
					content: JSON.stringify({
						error: "TOOL_CALL_FAILED",
						message: error?.message || "Tool call failed."
					})
				});
			}
		}

		this.sendRequest();
	}

	// Converts a limited subset of markdown to HTML including bold, italics, headings,
	// lists, tables, images, and links.
	markdownToHTML(markdown) {
		if (!markdown || typeof markdown !== "string") return "";

		let html = markdown;

		// Headers (h1-h6)
		html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
		html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
		html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

		// Bold text
		html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
		html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

		// Italic text
		html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
		html = html.replace(/_(.+?)_/g, "<em>$1</em>");

		// Links
		html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

		// Images
		html = html.replace(/!\[(.+?)\]\((.+?)\)/g, '<img src="$2" alt="$1" />');

		// Unordered lists
		html = html.replace(/^\* (.+)$/gm, "<li>$1</li>");
		html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
		html = html.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");

		// Ordered lists
		html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

		// Tables (basic support)
		const tableRegex = /^\|(.+)\|$/gm;
		let tableMatches = html.match(tableRegex);
		if (tableMatches) {
			let tableHTML = "<table>";
			let isHeader = true;
			for (const row of tableMatches) {
				const cells = row
					.split("|")
					.slice(1, -1)
					.map((cell) => cell.trim());
				if (isHeader) {
					tableHTML += "<thead><tr>";
					for (const cell of cells) {
						tableHTML += `<th>${cell}</th>`;
					}
					tableHTML += "</tr></thead><tbody>";
					isHeader = false;
				} else if (!cells.every((cell) => cell.match(/^-+$/))) {
					tableHTML += "<tr>";
					for (const cell of cells) {
						tableHTML += `<td>${cell}</td>`;
					}
					tableHTML += "</tr>";
				}
			}
			tableHTML += "</tbody></table>";
			html = html.replace(tableRegex, "");
			html += tableHTML;
		}

		// Line breaks
		html = html.replace(/\n/g, "<br>");

		return html;
	}

	// Displays a message in the conversation UI with appropriate styling based on
	// the sender role.
	receiveMessage(message) {
		const msgEl = document.createElement("div");
		msgEl.classList.add("message", message.role);

		// Convert markdown to HTML before displaying
		const htmlContent = this.markdownToHTML(message.content);

		// Use CIQ.safeAssign for secure HTML content assignment
		// if (CIQ && CIQ.safeAssign) {
		// 	CIQ.safeAssign(msgEl, htmlContent, "html", "inner");
		// } else {
		// 	// Fallback for plain text if CIQ.safeAssign is not available
			msgEl.textContent = message.content;
		// }

		msgEl.style.alignSelf = message.role === "user" ? "flex-end" : "flex-start";
		this.conversation.appendChild(msgEl);
		this.conversation.scrollTop = this.conversation.scrollHeight;
	}

	// Sets up event listeners for send button clicks and Enter key presses on the
	// message input field.
	setupEventListeners() {
		this.sendBtn.addEventListener("click", () => this.sendMessage());

		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.sendMessage();
		});
	}
}
