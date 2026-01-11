class VoxController {
  constructor({
    socket,
    appendMessage,
    chatEl,
    voiceToggle,
    voiceStatus,
    onVoiceActiveChange,
    canStartVoice
  }) {
    this.socket = socket;
    this.appendMessage = appendMessage;
    this.chatEl = chatEl;
    this.voiceToggle = voiceToggle;
    this.voiceStatus = voiceStatus;
    this.onVoiceActiveChange = onVoiceActiveChange;
    this.canStartVoice = canStartVoice;

    this.isVoiceActive = false;
    this.voiceStream = null;
    this.voiceContext = null;
    this.voiceProcessor = null;
    this.voiceSource = null;
    this.voiceSilence = null;
    this.playbackContext = null;
    this.playbackTime = 0;
    this.playbackNodes = [];
    this.voiceAssistantEl = null;
    this.voiceUserEl = null;

    this._handleToggle = this._handleToggle.bind(this);
    this.voiceToggle.addEventListener("click", this._handleToggle);
    this._updateVoiceUi(false);
  }

  _handleToggle() {
    if (this.isVoiceActive) {
      this.stopVoiceSession({ notifyServer: true });
      return;
    }
    this.startVoiceSession();
  }

  async startVoiceSession() {
    if (
      this.isVoiceActive ||
      this.socket.readyState !== WebSocket.OPEN ||
      (this.canStartVoice && !this.canStartVoice())
    ) {
      return;
    }

    try {
      this.voiceStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (err) {
      this.appendMessage("System", "Microphone access was blocked.", "assistant");
      return;
    }

    this.voiceContext = new AudioContext({ sampleRate: 24000 });
    this.playbackContext = new AudioContext({ sampleRate: 24000 });
    await this._resumeAudioContext(this.playbackContext);
    await this._resumeAudioContext(this.voiceContext);

    this.voiceSource = this.voiceContext.createMediaStreamSource(this.voiceStream);
    this.voiceProcessor = this.voiceContext.createScriptProcessor(4096, 1, 1);
    this.voiceSilence = this.voiceContext.createGain();
    this.voiceSilence.gain.value = 0;

    this.voiceProcessor.onaudioprocess = (event) => {
      if (!this.isVoiceActive || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const inputData = event.inputBuffer.getChannelData(0);
      const pcm16 = this._floatTo16BitPCM(inputData);
      const base64 = this._pcm16ToBase64(pcm16);
      this.socket.send(JSON.stringify({ type: "audio_chunk", audio: base64 }));
    };

    this.voiceSource.connect(this.voiceProcessor);
    this.voiceProcessor.connect(this.voiceSilence);
    this.voiceSilence.connect(this.voiceContext.destination);

    this.isVoiceActive = true;
    this.socket.send(JSON.stringify({ type: "audio_start" }));
    this._updateVoiceUi(true);
    this.onVoiceActiveChange(true);
    this._stopPlayback();
  }

  stopVoiceSession({ notifyServer }) {
    if (!this.isVoiceActive && !this.voiceStream) {
      return;
    }

    this.isVoiceActive = false;
    if (notifyServer && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "audio_stop" }));
    }

    if (this.voiceProcessor) {
      this.voiceProcessor.disconnect();
      this.voiceProcessor.onaudioprocess = null;
    }
    if (this.voiceSource) {
      this.voiceSource.disconnect();
    }
    if (this.voiceSilence) {
      this.voiceSilence.disconnect();
    }
    if (this.voiceStream) {
      this.voiceStream.getTracks().forEach((track) => track.stop());
    }
    this._stopPlayback();
    if (this.voiceContext) {
      this.voiceContext.close();
    }
    if (this.playbackContext) {
      this.playbackContext.close();
    }

    this.voiceStream = null;
    this.voiceContext = null;
    this.voiceProcessor = null;
    this.voiceSource = null;
    this.voiceSilence = null;
    this.playbackContext = null;
    this.voiceAssistantEl = null;
    this.voiceUserEl = null;
    this._updateVoiceUi(false);
    this.onVoiceActiveChange(false);
  }

  handleSocketMessage(payload) {
    if (payload.type === "assistant_voice_text_delta") {
      if (!this.voiceAssistantEl) {
        this.voiceAssistantEl = this.appendMessage("Assistant", "", "assistant");
      }
      this.voiceAssistantEl.querySelector(".message__body").textContent += payload.delta;
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
      return true;
    }

    if (payload.type === "assistant_voice_text_done") {
      this.voiceAssistantEl = null;
      return true;
    }

    if (payload.type === "user_voice_start") {
      if (!this.voiceUserEl) {
        this.voiceUserEl = this.appendMessage("You", "", "user");
      }
      return true;
    }

    if (payload.type === "user_voice_text_delta") {
      if (!this.voiceUserEl) {
        this.voiceUserEl = this.appendMessage("You", "", "user");
      }
      this.voiceUserEl.querySelector(".message__body").textContent += payload.delta;
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
      return true;
    }

    if (payload.type === "user_voice_text_done") {
      this.voiceUserEl = null;
      return true;
    }

    if (payload.type === "assistant_audio_delta") {
      this._queueAudioPlayback(payload.audio || "");
      return true;
    }

    if (payload.type === "assistant_audio_interrupt") {
      this._stopPlayback();
      this.voiceAssistantEl = null;
      return true;
    }

    if (payload.type === "assistant_audio_done") {
      this.playbackTime = Math.max(this.playbackTime, this.playbackContext ? this.playbackContext.currentTime : 0);
      return true;
    }

    return false;
  }

  handleSocketClose() {
    this.stopVoiceSession({ notifyServer: false });
  }

  _updateVoiceUi(active) {
    if (!this.voiceToggle || !this.voiceStatus) {
      return;
    }
    this.voiceToggle.textContent = active ? "End voice" : "Start voice";
    this.voiceToggle.classList.toggle("is-active", active);
    this.voiceStatus.textContent = active ? "Listening and speaking in real time." : "Voice idle.";
  }

  _floatTo16BitPCM(float32Array) {
    const output = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return output;
  }

  _pcm16ToBase64(pcm16Array) {
    const bytes = new Uint8Array(pcm16Array.buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  _base64ToInt16(base64) {
    if (!base64) {
      return new Int16Array(0);
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  }

  _queueAudioPlayback(base64) {
    if (!this.playbackContext || !base64) {
      return;
    }
    const pcm16 = this._base64ToInt16(base64);
    if (!pcm16.length) {
      return;
    }
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i += 1) {
      float32[i] = pcm16[i] / 0x8000;
    }

    const buffer = this.playbackContext.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);

    const startTime = Math.max(this.playbackContext.currentTime, this.playbackTime);
    source.start(startTime);
    this.playbackTime = startTime + buffer.duration;
    this.playbackNodes.push(source);
    source.onended = () => {
      this.playbackNodes = this.playbackNodes.filter((node) => node !== source);
    };
  }

  _stopPlayback() {
    this.playbackNodes.forEach((node) => {
      try {
        node.stop();
      } catch (err) {
        // Ignore playback stop errors.
      }
    });
    this.playbackNodes = [];
    this.playbackTime = this.playbackContext ? this.playbackContext.currentTime : 0;
  }

  async _resumeAudioContext(context) {
    if (!context) {
      return;
    }
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (err) {
        // Ignore resume errors.
      }
    }
  }
}

export { VoxController };
