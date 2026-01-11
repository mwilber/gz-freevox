class ChatController {
  constructor({
    socket,
    appendMessage,
    chatEl,
    formEl,
    inputEl,
    onStreamingChange,
    canSendMessage
  }) {
    this.socket = socket;
    this.appendMessage = appendMessage;
    this.chatEl = chatEl;
    this.formEl = formEl;
    this.inputEl = inputEl;
    this.onStreamingChange = onStreamingChange;
    this.canSendMessage = canSendMessage;
    this.currentAssistantEl = null;
    this.isStreaming = false;

    this._handleSubmit = this._handleSubmit.bind(this);
    this.formEl.addEventListener("submit", this._handleSubmit);
  }

  _setStreaming(value) {
    this.isStreaming = value;
    this.onStreamingChange(this.isStreaming);
  }

  _handleSubmit(event) {
    event.preventDefault();
    const text = this.inputEl.value.trim();
    if (
      !text ||
      this.isStreaming ||
      this.socket.readyState !== WebSocket.OPEN ||
      (this.canSendMessage && !this.canSendMessage())
    ) {
      return;
    }

    this.appendMessage("You", text, "user");
    this.socket.send(JSON.stringify({ type: "user_message", text }));
    this.inputEl.value = "";
    this._setStreaming(true);
  }

  handleSocketMessage(payload) {
    if (payload.type === "assistant_delta") {
      if (!this.currentAssistantEl) {
        this.currentAssistantEl = this.appendMessage("Assistant", "", "assistant");
      }
      this.currentAssistantEl.querySelector(".message__body").textContent += payload.delta;
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
      return true;
    }

    if (payload.type === "assistant_done") {
      this._setStreaming(false);
      this.currentAssistantEl = null;
      return true;
    }

    return false;
  }

  handleError() {
    if (this.isStreaming) {
      this._setStreaming(false);
    }
    this.currentAssistantEl = null;
  }
}

export { ChatController };
