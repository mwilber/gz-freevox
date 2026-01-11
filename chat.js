const { createParser } = require("eventsource-parser");

function createChatHandler({ ws, history, apiKey, model = "gpt-4o-mini" }) {
  const streamAssistantResponse = async () => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: history,
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
        ws.send(JSON.stringify({
          type: "assistant_delta",
          delta: payload.delta || ""
        }));
      }

      if (payload.type === "response.completed") {
        ws.send(JSON.stringify({ type: "assistant_done" }));
      }
    });

    for await (const chunk of response.body) {
      parser.feed(decoder.decode(chunk, { stream: true }));
    }

    if (assistantText) {
      history.push({ role: "assistant", content: assistantText });
    }
  };

  const handleMessage = async (message) => {
    if (message.type != "user_message" || !message.text) {
      return false;
    }

    history.push({ role: "user", content: message.text });

    try {
      await streamAssistantResponse();
    } catch (err) {
      ws.send(JSON.stringify({
        type: "error",
        message: "OpenAI request failed.",
        detail: err.message
      }));
    }

    return true;
  };

  return { handleMessage };
}

module.exports = { createChatHandler };
