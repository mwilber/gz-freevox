const WebSocket = require("ws");

function createVoxHandler({ ws, history, apiKey, model, voice, systemPrompt }) {
  let realtimeSocket = null;
  let realtimeReady = false;
  let realtimeQueue = [];
  let realtimeResponding = false;
  let pendingUserTranscript = "";
  let pendingUserTranscriptSent = false;
  let pendingAssistantTranscript = "";
  let lastUserTranscript = "";
  let bufferHasAudio = false;

  const sendRealtime = (payload) => {
    if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    realtimeSocket.send(JSON.stringify(payload));
  };

  const seedRealtimeHistory = () => {
    for (const message of history) {
      if (!message.content || message.role === "system") {
        continue;
      }
      const textType = message.role === "user" ? "input_text" : "output_text";
      sendRealtime({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: message.role,
          content: [{ type: textType, text: message.content }]
        }
      });
    }
  };

  const commitAssistantTranscript = () => {
    if (!pendingAssistantTranscript) {
      return;
    }
    history.push({ role: "assistant", content: pendingAssistantTranscript });
    pendingAssistantTranscript = "";
    ws.send(JSON.stringify({ type: "assistant_voice_text_done" }));
  };

  const openRealtimeSocket = () => {
    if (realtimeSocket) {
      return;
    }
    realtimeSocket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    realtimeSocket.on("open", () => {
      realtimeReady = true;
      sendRealtime({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: systemPrompt,
          voice,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe"
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      });

      seedRealtimeHistory();

      if (realtimeQueue.length) {
        for (const queued of realtimeQueue) {
          sendRealtime(queued);
        }
        realtimeQueue = [];
      }
    });

    realtimeSocket.on("message", (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch (err) {
        return;
      }

      if (payload.type === "input_audio_buffer.speech_started") {
        pendingUserTranscript = "";
        pendingUserTranscriptSent = false;
        lastUserTranscript = "";
        ws.send(JSON.stringify({ type: "user_voice_start" }));
        if (realtimeResponding) {
          sendRealtime({ type: "response.cancel" });
          ws.send(JSON.stringify({ type: "assistant_audio_interrupt" }));
          realtimeResponding = false;
          pendingAssistantTranscript = "";
        }
        return;
      }

      if (payload.type === "input_audio_buffer.speech_stopped") {
        if (!bufferHasAudio) {
          return;
        }
        sendRealtime({ type: "input_audio_buffer.commit" });
        bufferHasAudio = false;
        if (!realtimeResponding) {
          sendRealtime({
            type: "response.create",
            response: {
              modalities: ["audio", "text"]
            }
          });
          realtimeResponding = true;
        }
        return;
      }

      if (payload.type === "response.audio.delta" || payload.type === "response.output_audio.delta") {
        ws.send(JSON.stringify({
          type: "assistant_audio_delta",
          audio: payload.delta || payload.audio || ""
        }));
        return;
      }

      if (payload.type === "response.audio.done" || payload.type === "response.output_audio.done") {
        ws.send(JSON.stringify({ type: "assistant_audio_done" }));
        return;
      }

      if (payload.type === "response.text.delta" || payload.type === "response.output_text.delta") {
        const delta = payload.delta || payload.text || "";
        if (delta) {
          pendingAssistantTranscript += delta;
          ws.send(JSON.stringify({
            type: "assistant_voice_text_delta",
            delta
          }));
        }
        return;
      }

      if (payload.type === "response.text.done" || payload.type === "response.output_text.done") {
        commitAssistantTranscript();
        return;
      }

      if (
        payload.type === "response.audio_transcript.delta" ||
        payload.type === "response.output_audio_transcript.delta"
      ) {
        const delta = payload.delta || payload.text || "";
        if (delta) {
          pendingAssistantTranscript += delta;
          ws.send(JSON.stringify({
            type: "assistant_voice_text_delta",
            delta
          }));
        }
        return;
      }

      if (
        payload.type === "response.audio_transcript.done" ||
        payload.type === "response.output_audio_transcript.done"
      ) {
        commitAssistantTranscript();
        return;
      }

      if (
        payload.type === "conversation.item.input_audio_transcription.delta" ||
        payload.type === "input_audio_transcription.delta"
      ) {
        const delta = payload.delta || payload.text || "";
        if (delta) {
          pendingUserTranscript += delta;
          pendingUserTranscriptSent = true;
          ws.send(JSON.stringify({ type: "user_voice_text_delta", delta }));
        }
        return;
      }

      if (
        payload.type === "conversation.item.input_audio_transcription.completed" ||
        payload.type === "input_audio_transcription.completed"
      ) {
        const transcript = payload.transcript || payload.text || pendingUserTranscript;
        if (transcript && transcript !== lastUserTranscript) {
          history.push({ role: "user", content: transcript });
          if (!pendingUserTranscriptSent) {
            ws.send(JSON.stringify({ type: "user_voice_text_delta", delta: transcript }));
          }
          lastUserTranscript = transcript;
        }
        pendingUserTranscript = "";
        pendingUserTranscriptSent = false;
        ws.send(JSON.stringify({ type: "user_voice_text_done" }));
        return;
      }

      if (payload.type === "conversation.item.created" || payload.type === "conversation.item.updated") {
        const item = payload.item;
        if (item && item.role === "user" && Array.isArray(item.content)) {
          const textPart = item.content.find((part) => part.type === "input_text");
          const audioPart = item.content.find((part) => part.type === "input_audio");
          const transcript = (textPart && textPart.text) || (audioPart && audioPart.transcript) || "";
          if (transcript && transcript !== lastUserTranscript) {
            history.push({ role: "user", content: transcript });
            ws.send(JSON.stringify({ type: "user_voice_text_delta", delta: transcript }));
            ws.send(JSON.stringify({ type: "user_voice_text_done" }));
            pendingUserTranscript = "";
            pendingUserTranscriptSent = true;
            lastUserTranscript = transcript;
          }
        }
        return;
      }

      if (payload.type === "response.completed") {
        realtimeResponding = false;
        commitAssistantTranscript();
      }
    });

    realtimeSocket.on("close", () => {
      realtimeSocket = null;
      realtimeReady = false;
      realtimeQueue = [];
      realtimeResponding = false;
      pendingUserTranscript = "";
      pendingUserTranscriptSent = false;
      pendingAssistantTranscript = "";
      bufferHasAudio = false;
    });

    realtimeSocket.on("error", (err) => {
      ws.send(JSON.stringify({
        type: "error",
        message: "OpenAI realtime connection failed.",
        detail: err.message
      }));
    });
  };

  const closeRealtimeSocket = () => {
    if (realtimeSocket) {
      realtimeSocket.close();
    }
    realtimeSocket = null;
    realtimeReady = false;
    realtimeQueue = [];
    realtimeResponding = false;
    pendingUserTranscript = "";
    pendingUserTranscriptSent = false;
    pendingAssistantTranscript = "";
    bufferHasAudio = false;
  };

  const handleMessage = (message) => {
    if (message.type === "audio_start") {
      openRealtimeSocket();
      return true;
    }

    if (message.type === "audio_chunk" && message.audio) {
      openRealtimeSocket();
      const payload = { type: "input_audio_buffer.append", audio: message.audio };
      if (!realtimeReady) {
        if (realtimeQueue.length < 8) {
          realtimeQueue.push(payload);
        }
      } else {
        sendRealtime(payload);
      }
      bufferHasAudio = true;
      return true;
    }

    if (message.type === "audio_stop") {
      closeRealtimeSocket();
      return true;
    }

    return false;
  };

  const handleClose = () => {
    closeRealtimeSocket();
  };

  return { handleMessage, handleClose };
}

module.exports = { createVoxHandler };
