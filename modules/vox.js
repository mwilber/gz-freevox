const WebSocket = require("ws");

class VoxHandler {
  constructor({ ws, history, apiKey, model, voice, systemPrompt }) {
    this.ws = ws;
    this.history = history;
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.systemPrompt = systemPrompt;

    this.realtimeSocket = null;
    this.realtimeReady = false;
    this.realtimeQueue = [];
    this.realtimeResponding = false;
    this.pendingUserTranscript = "";
    this.pendingUserTranscriptSent = false;
    this.pendingAssistantTranscript = "";
    this.lastUserTranscript = "";
    this.bufferHasAudio = false;
  }

  _sendRealtime(payload) {
    if (!this.realtimeSocket || this.realtimeSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.realtimeSocket.send(JSON.stringify(payload));
  }

  _seedRealtimeHistory() {
    for (const message of this.history) {
      if (!message.content || message.role === "system") {
        continue;
      }
      const textType = message.role === "user" ? "input_text" : "output_text";
      this._sendRealtime({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: message.role,
          content: [{ type: textType, text: message.content }]
        }
      });
    }
  }

  _commitAssistantTranscript() {
    if (!this.pendingAssistantTranscript) {
      return;
    }
    this.history.push({ role: "assistant", content: this.pendingAssistantTranscript });
    this.pendingAssistantTranscript = "";
    this.ws.send(JSON.stringify({ type: "assistant_voice_text_done" }));
  }

  _openRealtimeSocket() {
    if (this.realtimeSocket) {
      return;
    }

    this.realtimeSocket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${this.model}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    this.realtimeSocket.on("open", () => {
      this.realtimeReady = true;
      this._sendRealtime({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: this.systemPrompt,
          voice: this.voice,
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

      this._seedRealtimeHistory();

      if (this.realtimeQueue.length) {
        for (const queued of this.realtimeQueue) {
          this._sendRealtime(queued);
        }
        this.realtimeQueue = [];
      }
    });

    this.realtimeSocket.on("message", (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch (err) {
        return;
      }

      if (payload.type === "input_audio_buffer.speech_started") {
        this.pendingUserTranscript = "";
        this.pendingUserTranscriptSent = false;
        this.lastUserTranscript = "";
        this.ws.send(JSON.stringify({ type: "user_voice_start" }));
        if (this.realtimeResponding) {
          this._sendRealtime({ type: "response.cancel" });
          this.ws.send(JSON.stringify({ type: "assistant_audio_interrupt" }));
          this.realtimeResponding = false;
          this.pendingAssistantTranscript = "";
        }
        return;
      }

      if (payload.type === "input_audio_buffer.speech_stopped") {
        if (!this.bufferHasAudio) {
          return;
        }
        this._sendRealtime({ type: "input_audio_buffer.commit" });
        this.bufferHasAudio = false;
        if (!this.realtimeResponding) {
          this._sendRealtime({
            type: "response.create",
            response: {
              modalities: ["audio", "text"]
            }
          });
          this.realtimeResponding = true;
        }
        return;
      }

      if (payload.type === "response.audio.delta" || payload.type === "response.output_audio.delta") {
        this.ws.send(JSON.stringify({
          type: "assistant_audio_delta",
          audio: payload.delta || payload.audio || ""
        }));
        return;
      }

      if (payload.type === "response.audio.done" || payload.type === "response.output_audio.done") {
        this.ws.send(JSON.stringify({ type: "assistant_audio_done" }));
        return;
      }

      if (payload.type === "response.text.delta" || payload.type === "response.output_text.delta") {
        const delta = payload.delta || payload.text || "";
        if (delta) {
          this.pendingAssistantTranscript += delta;
          this.ws.send(JSON.stringify({
            type: "assistant_voice_text_delta",
            delta
          }));
        }
        return;
      }

      if (payload.type === "response.text.done" || payload.type === "response.output_text.done") {
        this._commitAssistantTranscript();
        return;
      }

      if (
        payload.type === "response.audio_transcript.delta" ||
        payload.type === "response.output_audio_transcript.delta"
      ) {
        const delta = payload.delta || payload.text || "";
        if (delta) {
          this.pendingAssistantTranscript += delta;
          this.ws.send(JSON.stringify({
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
        this._commitAssistantTranscript();
        return;
      }

      if (
        payload.type === "conversation.item.input_audio_transcription.delta" ||
        payload.type === "input_audio_transcription.delta"
      ) {
        const delta = payload.delta || payload.text || "";
        if (delta) {
          this.pendingUserTranscript += delta;
          this.pendingUserTranscriptSent = true;
          this.ws.send(JSON.stringify({ type: "user_voice_text_delta", delta }));
        }
        return;
      }

      if (
        payload.type === "conversation.item.input_audio_transcription.completed" ||
        payload.type === "input_audio_transcription.completed"
      ) {
        const transcript = payload.transcript || payload.text || this.pendingUserTranscript;
        if (transcript && transcript !== this.lastUserTranscript) {
          this.history.push({ role: "user", content: transcript });
          if (!this.pendingUserTranscriptSent) {
            this.ws.send(JSON.stringify({ type: "user_voice_text_delta", delta: transcript }));
          }
          this.lastUserTranscript = transcript;
        }
        this.pendingUserTranscript = "";
        this.pendingUserTranscriptSent = false;
        this.ws.send(JSON.stringify({ type: "user_voice_text_done" }));
        return;
      }

      if (payload.type === "conversation.item.created" || payload.type === "conversation.item.updated") {
        const item = payload.item;
        if (item && item.role === "user" && Array.isArray(item.content)) {
          const textPart = item.content.find((part) => part.type === "input_text");
          const audioPart = item.content.find((part) => part.type === "input_audio");
          const transcript = (textPart && textPart.text) || (audioPart && audioPart.transcript) || "";
          if (transcript && transcript !== this.lastUserTranscript) {
            this.history.push({ role: "user", content: transcript });
            this.ws.send(JSON.stringify({ type: "user_voice_text_delta", delta: transcript }));
            this.ws.send(JSON.stringify({ type: "user_voice_text_done" }));
            this.pendingUserTranscript = "";
            this.pendingUserTranscriptSent = true;
            this.lastUserTranscript = transcript;
          }
        }
        return;
      }

      if (payload.type === "response.completed") {
        this.realtimeResponding = false;
        this._commitAssistantTranscript();
      }
    });

    this.realtimeSocket.on("close", () => {
      this.realtimeSocket = null;
      this.realtimeReady = false;
      this.realtimeQueue = [];
      this.realtimeResponding = false;
      this.pendingUserTranscript = "";
      this.pendingUserTranscriptSent = false;
      this.pendingAssistantTranscript = "";
      this.bufferHasAudio = false;
    });

    this.realtimeSocket.on("error", (err) => {
      this.ws.send(JSON.stringify({
        type: "error",
        message: "OpenAI realtime connection failed.",
        detail: err.message
      }));
    });
  }

  _closeRealtimeSocket() {
    if (this.realtimeSocket) {
      this.realtimeSocket.close();
    }
    this.realtimeSocket = null;
    this.realtimeReady = false;
    this.realtimeQueue = [];
    this.realtimeResponding = false;
    this.pendingUserTranscript = "";
    this.pendingUserTranscriptSent = false;
    this.pendingAssistantTranscript = "";
    this.bufferHasAudio = false;
  }

  handleMessage(message) {
    if (message.type === "audio_start") {
      this._openRealtimeSocket();
      return true;
    }

    if (message.type === "audio_chunk" && message.audio) {
      this._openRealtimeSocket();
      const payload = { type: "input_audio_buffer.append", audio: message.audio };
      if (!this.realtimeReady) {
        if (this.realtimeQueue.length < 8) {
          this.realtimeQueue.push(payload);
        }
      } else {
        this._sendRealtime(payload);
      }
      this.bufferHasAudio = true;
      return true;
    }

    if (message.type === "audio_stop") {
      this._closeRealtimeSocket();
      return true;
    }

    return false;
  }

  handleClose() {
    this._closeRealtimeSocket();
  }
}

module.exports = { VoxHandler };
