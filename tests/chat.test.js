const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const { ChatHandler } = require("../modules/chat");

function createSse(events) {
	const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return Readable.from([Buffer.from(payload)]);
}

function createResponse(events) {
	return {
		ok: true,
		body: createSse(events)
	};
}

test("sends tools and returns tool calls, then includes call/output items on follow-up", async () => {
	const fetchCalls = [];
	const toolItemId = "fc_test_123";
	const toolCallId = "call_test_456";

	global.fetch = async (url, options) => {
		fetchCalls.push({
			url,
			body: JSON.parse(options.body)
		});

		if (fetchCalls.length === 1) {
			return createResponse([
				{
					type: "response.output_item.added",
					item: {
						id: toolItemId,
						type: "function_call",
						call_id: toolCallId,
						name: "get_status",
						arguments: ""
					}
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: toolItemId,
					delta: "{\"id\":1}"
				},
				{
					type: "response.output_item.done",
					item: {
						id: toolItemId,
						type: "function_call",
						call_id: toolCallId,
						name: "get_status",
						arguments: "{\"id\":1}"
					}
				},
				{
					type: "response.completed"
				}
			]);
		}

		return createResponse([
			{
				type: "response.output_text.delta",
				delta: "ok"
			},
			{
				type: "response.completed"
			}
		]);
	};

	const ws = {
		sent: [],
		send(payload) {
			this.sent.push(JSON.parse(payload));
		}
	};

	const handler = new ChatHandler({
		ws,
		history: [{ role: "system", content: "System prompt." }],
		apiKey: "test-key"
	});

	await handler.handleMessage({
		type: "user_message",
		text: "status",
		tools: [
			{
				type: "function",
				name: "get_status",
				description: "Get a status.",
				parameters: { type: "object", properties: { id: { type: "number" } } }
			}
		]
	});

	assert.equal(fetchCalls.length, 1);
	assert.equal(fetchCalls[0].body.tools[0].name, "get_status");

	const toolCallMessage = ws.sent.find((message) => message.type === "assistant_tool_calls");
	assert.ok(toolCallMessage, "expected tool call message");

	await handler.handleMessage({
		type: "tool_results",
		results: [
			{
				tool_call_id: toolCallId,
				name: "get_status",
				content: "{\"status\":\"ok\"}"
			}
		]
	});

	assert.equal(fetchCalls.length, 2);
	const followUpInput = fetchCalls[1].body.input;
	const functionCallItem = followUpInput.find((item) => item.type === "function_call");
	const functionOutputItem = followUpInput.find((item) => item.type === "function_call_output");

	assert.ok(functionCallItem, "expected function_call item");
	assert.ok(functionOutputItem, "expected function_call_output item");
	assert.equal(functionCallItem.call_id, toolCallId);
	assert.equal(functionOutputItem.call_id, toolCallId);
});
