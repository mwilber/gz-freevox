# Phase 5 Technical Specification: Build PWA (FreeVox)

## Objective

Build FreeVox, a minimal Progressive Web App hosted on Heroku with exactly two user-facing functions:

1. Send typed text to SELMA.
2. Start a realtime voice interaction with an OpenAI realtime speech model, then send the complete conversation transcript to SELMA when the user presses End Conversation.

FreeVox is not an archive, dashboard, conversation-history app, or SID browser. It only captures user input and submits it to SELMA.

## Scope

Included:

- Heroku-hosted PWA.
- Mobile-first installable PWA behavior.
- Single-user authentication.
- Text input with Send button.
- Realtime voice interaction with an OpenAI realtime speech model.
- Start Conversation button.
- End Conversation button.
- Complete transcript assembly for the realtime voice conversation.
- Automatic transcript submission to SELMA when End Conversation is pressed.
- PWA manifest and service worker for installability.

Excluded:

- Conversation history.
- SID/Data Store linking, browsing, lookup, or display.
- Displaying SID transcript IDs.
- Displaying SELMA run history.
- Quick voice note mode separate from realtime conversation.
- OS share target integration. That is Phase 7.
- Native mobile app.
- Multi-user account system.
- Local transcript archive.
- Editing transcripts after End Conversation.

## OpenAI Realtime Transcript Verification

Official OpenAI documentation confirms transcript capture is possible:

- Realtime transcription sessions emit incremental transcript deltas and completed transcript events for input audio.
- Realtime conversation sessions emit transcript events for model audio output.
- Browser realtime audio can be handled over WebRTC with microphone input from `navigator.mediaDevices.getUserMedia`.

Implementation consequence:

- FreeVox must collect user speech transcript from `conversation.item.input_audio_transcription.completed` events.
- FreeVox must collect assistant speech transcript from realtime output audio transcript completion events such as `response.output_audio_transcript.done`.
- FreeVox must maintain an ordered local transcript during the active session and submit that transcript to SELMA when the user ends the conversation.

## Platform

- Runtime: Node.js on Heroku.
- Frontend: browser-native JavaScript, HTML, CSS, Web APIs, WebRTC, and PWA APIs.
- Backend: Node.js server for auth, serving assets, creating OpenAI realtime session credentials, and submitting transcripts to SELMA.
- LLM provider: OpenAI.
- Dependency policy: do not use third-party libraries or frameworks. FreeVox must not use React, Vue, Svelte, Angular, Express, Fastify, Koa, Nest, dotenv, third-party service-worker libraries, CSS frameworks, UI kits, validation libraries, auth/session middleware, or OpenAI client libraries unless explicitly approved later.
- Use Node.js built-in modules for HTTP routing, sessions, CSRF handling, static file serving, and SELMA submission.
- Public web deployment: require authentication.
- Heroku deployment must use the platform-provided `PORT`.
- Heroku deployment must include a `Procfile`.

## Configuration

Required:

- `FREEVOX_SESSION_SECRET`
- `FREEVOX_UI_USERNAME`
- `FREEVOX_UI_PASSWORD_HASH`
- `SELMA_BASE_URL`
- `SELMA_API_TOKEN`
- `OPENAI_API_KEY`
- `REALTIME_MODEL`
- `REALTIME_TRANSCRIPTION_MODEL`

Optional:

- `FREEVOX_ALLOWED_ORIGIN`
- `LOG_LEVEL`

Credential requirements:

- Store all secrets in Heroku config vars.
- Do not expose `OPENAI_API_KEY` or `SELMA_API_TOKEN` to the browser.
- Browser realtime access must use provider-approved short-lived client credentials created by the backend.
- Store the UI password as a hash, not plain text.

## User Interface

The app should have one authenticated screen with two sections.

### Text Sender

Elements:

- Text input area.
- Send button.
- Submission status text.

Behavior:

1. User types or pastes text.
2. User presses Send.
3. Browser sends the text to FreeVox backend.
4. FreeVox backend submits it to SELMA.
5. UI clears the input only after SELMA accepts the request.
6. UI shows a simple status: idle, sending, sent, or failed.

Do not show SID links or transcript history.

### Realtime Voice

Elements:

- Start Conversation button.
- End Conversation button.
- Active-session status text.
- Optional live transcript display for the current active session only.

Behavior:

1. User presses Start Conversation.
2. FreeVox requests microphone permission.
3. FreeVox requests short-lived realtime connection credentials from its backend.
4. Browser starts a WebRTC realtime session with OpenAI.
5. User and assistant speak for as long as necessary.
6. FreeVox accumulates transcript turns while the conversation is active.
7. User presses End Conversation.
8. FreeVox closes the realtime session.
9. FreeVox formats the complete transcript.
10. FreeVox backend submits the transcript to SELMA automatically.
11. UI clears active-session state after SELMA accepts the transcript.

Do not require a second Submit button for the voice transcript. End Conversation is the submission trigger.

## Backend API

All browser-facing routes require session authentication after login.

### `POST /api/realtime/session`

Creates short-lived OpenAI realtime connection credentials for the browser.

Request body:

```json
{}
```

Response:

```json
{
  "client_secret": "short-lived-token",
  "model": "realtime-model-name",
  "expires_at": "2026-05-22T16:35:00Z"
}
```

Server behavior:

- Validate session auth.
- Call OpenAI using server-side `OPENAI_API_KEY`.
- Configure the realtime session for audio interaction.
- Enable input audio transcription using `REALTIME_TRANSCRIPTION_MODEL`.
- Return only short-lived browser-safe credentials and model/session metadata.

### `POST /api/send-text`

Submits typed text to SELMA.

Request:

```json
{
  "text": "Remind me to buy milk tomorrow."
}
```

Server behavior:

- Validate session auth.
- Validate `text` is a non-empty string.
- Convert text to transcript format.
- Call SELMA `POST /api/agent-runs`.
- Return only basic submission status.

SELMA request:

```json
{
  "transcript": "# FreeVox Text\n\nRemind me to buy milk tomorrow.",
  "source": "freevox_text",
  "metadata": {
    "submitted_at": "2026-05-22T16:30:00Z"
  }
}
```

### `POST /api/send-voice-transcript`

Submits the completed realtime conversation transcript to SELMA.

Request:

```json
{
  "started_at": "2026-05-22T16:30:00Z",
  "ended_at": "2026-05-22T16:34:00Z",
  "turns": [
    {
      "role": "user",
      "text": "Remind me to buy milk tomorrow."
    },
    {
      "role": "assistant",
      "text": "I can help with that."
    }
  ]
}
```

Server behavior:

- Validate session auth.
- Validate at least one transcript turn exists.
- Format the turns as a Markdown transcript.
- Call SELMA `POST /api/agent-runs`.
- Return only basic submission status.

SELMA request:

```json
{
  "transcript": "# FreeVox Voice Conversation\n\nStarted: 2026-05-22T16:30:00Z\nEnded: 2026-05-22T16:34:00Z\n\n## Transcript\n\nUser: Remind me to buy milk tomorrow.\nAssistant: I can help with that.",
  "source": "freevox_realtime",
  "metadata": {
    "conversation_started_at": "2026-05-22T16:30:00Z",
    "conversation_ended_at": "2026-05-22T16:34:00Z",
    "turn_count": 2
  }
}
```

## Realtime Transcript Assembly

FreeVox must build a complete transcript during the active realtime session.

Requirements:

- Capture user speech from OpenAI input audio transcription completion events.
- Capture assistant speech from OpenAI output audio transcript completion events.
- Store only the active session transcript in browser memory.
- Preserve speaker labels: `User` and `Assistant`.
- Preserve turn order as accurately as possible using event IDs, item IDs, and event ordering metadata provided by the realtime API.
- If final ordering cannot be guaranteed for two close events, prefer the order observed by the browser and keep the transcript readable.
- Do not send partial transcript deltas to SELMA.
- Do not persist transcript turns after successful submission.
- If transcript assembly fails or no transcript turns are captured, do not submit an empty transcript.

## Transcript Format

Text input transcript:

```markdown
# FreeVox Text

Remind me to buy milk tomorrow.
```

Voice transcript:

```markdown
# FreeVox Voice Conversation

Started: 2026-05-22T16:30:00Z
Ended: 2026-05-22T16:34:00Z

## Transcript

User: Remind me to buy milk tomorrow.
Assistant: I can help with that.
```

Keep speaker labeling clear enough for SELMA to infer the user's intended actions. The assistant turns are included for context, but SELMA should decide actions from the user's requests.

## Security

- Single-user login required before accessing app.
- Use secure cookies in production.
- CSRF protection for session-authenticated POST routes.
- Never expose long-lived OpenAI or SELMA credentials to the client.
- Keep active transcripts in browser memory only.
- Do not store transcripts in local storage, IndexedDB, cookies, logs, or server files.
- Do not log full text submissions or full voice transcripts by default.

## PWA Requirements

- Mobile-first layout is required. Design for a phone viewport first, then allow the same screen to scale cleanly to tablet and desktop widths.
- App must be installable from supported mobile browsers.
- `manifest.json` must include name, short name, start URL, scope, icons, theme color, background color, and display mode.
- Use `display: standalone` unless testing shows another install display mode is more reliable on the target mobile browser.
- Provide installable icons in the sizes required by current Android/Chromium PWA install criteria, including maskable icon support.
- Service worker for app shell caching only.
- Offline mode may show the app shell but must not queue text or transcript submissions in this phase.
- The service worker must not cache authenticated API responses, OpenAI realtime credentials, SELMA responses, transcripts, or submitted text.
- The app shell must remain usable at narrow mobile widths without horizontal scrolling.
- Primary controls must be reachable with one thumb on a phone-sized screen where practical.
- Start Conversation and End Conversation states must be visually distinct and difficult to confuse.

## Heroku Deployment

Required files and behavior:

- `package.json`
- `Procfile` with `web: npm start`
- Node server must listen on `process.env.PORT`.
- Health endpoint `GET /healthz` that does not require auth and returns only basic process health.
- Static assets served by the Node server.
- No build step requiring third-party frameworks or bundlers.
- No filesystem persistence assumptions; Heroku dyno filesystem is ephemeral.

Required Heroku config vars:

- `FREEVOX_SESSION_SECRET`
- `FREEVOX_UI_USERNAME`
- `FREEVOX_UI_PASSWORD_HASH`
- `SELMA_BASE_URL`
- `SELMA_API_TOKEN`
- `OPENAI_API_KEY`
- `REALTIME_MODEL`
- `REALTIME_TRANSCRIPTION_MODEL`

Deployment documentation must include:

- How to set config vars with `heroku config:set`.
- How to run locally with equivalent environment variables.
- How to verify `/healthz`.
- How to install the PWA on the target mobile browser.
- How to test microphone permission and realtime connection setup.

## Accessibility

- Start Conversation, End Conversation, and Send must be keyboard-accessible buttons.
- Visible focus states.
- Text labels for all controls.
- Status updates should be exposed in an ARIA live region.
- Do not rely only on color for status.

## Test Requirements

Automated tests:

- Auth-protected routes reject unauthenticated requests.
- `GET /healthz` returns process health without auth.
- `POST /api/send-text` rejects empty text.
- `POST /api/send-text` calls SELMA with source `freevox_text`.
- `POST /api/send-voice-transcript` rejects empty turns.
- `POST /api/send-voice-transcript` formats user and assistant turns correctly.
- `POST /api/send-voice-transcript` calls SELMA with source `freevox_realtime`.
- Realtime session endpoint does not expose `OPENAI_API_KEY`.
- Service worker and manifest are served.
- Manifest contains required installability fields and icon references.
- Server listens on injected `PORT` in Heroku-like startup tests.

Manual acceptance tests:

1. Deploy FreeVox to Heroku.
2. Confirm `/healthz` responds on the Heroku app URL.
3. Open FreeVox on the target mobile browser.
4. Install the PWA to the device home screen.
5. Launch FreeVox from the installed home-screen icon.
6. Log in to FreeVox.
7. Type text and press Send.
8. Confirm SELMA receives source `freevox_text`.
9. Press Start Conversation and grant microphone permission.
10. Have a realtime voice exchange with the OpenAI model.
11. Press End Conversation.
12. Confirm FreeVox sends the complete transcript to SELMA with source `freevox_realtime`.
13. Confirm no SID link, conversation history, or run history appears in FreeVox.
14. Deny microphone permission and confirm the UI fails gracefully.

## Deliverables

- FreeVox Heroku application.
- Minimal authenticated PWA UI.
- Text submission endpoint.
- Realtime session broker.
- Voice transcript submission endpoint.
- PWA manifest and service worker.
- Deployment documentation.
- Manual verification notes for realtime transcript capture.

## Open Questions

- Which exact OpenAI realtime model should FreeVox use by default?
- Which exact OpenAI transcription model should FreeVox use for realtime input transcription?
