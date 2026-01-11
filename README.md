# FreeVox

Real-time, two-way LLM conversation using WebSockets and OpenAI's APIs for text and voice.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

Add your OpenAI API key to `.env`.

3. Run the server:

```bash
npm start
```

Visit `http://localhost:3000`.

## Voice chat

- Click "Start voice" to begin a real-time audio conversation and allow microphone access when prompted.
- Speak at any time to interrupt the assistant mid-response; it will stop and listen.
- Click "End voice" to finish the conversation.
- Voice transcripts for both sides appear in the chat history as standard messages.
- Optional configuration: `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, and `OPENAI_REALTIME_PROMPT` in `.env`.

## Troubleshooting

- If the mic button does nothing, confirm the browser granted microphone access and reload.
- If audio playback is silent, check the system volume and that the browser tab is not muted.
- For reliable microphone access in some browsers, use `https://` or `http://localhost`.
