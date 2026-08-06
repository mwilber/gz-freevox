const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
const textForm = document.querySelector('#text-form');
const textInput = document.querySelector('#text-input');
const textStatus = document.querySelector('#text-status');
const sendButton = document.querySelector('#send-button');
const dictationButton = document.querySelector('#dictation-button');
const textPanel = document.querySelector('#text-panel');
const showVoiceButton = document.querySelector('#show-voice-button');
const showTextButton = document.querySelector('#show-text-button');
const startButton = document.querySelector('#start-button');
const endButton = document.querySelector('#end-button');
const voiceStatus = document.querySelector('#voice-status');
const liveTranscript = document.querySelector('#live-transcript');
const voicePanel = document.querySelector('#voice-panel');
const remoteAudio = document.querySelector('#remote-audio');
const logoutButton = document.querySelector('#logout-button');

let peerConnection = null;
let dataChannel = null;
let micStream = null;
let startedAt = null;
let turnCounter = 0;
let transcriptTurns = [];
let userItems = new Map();
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let textRecognition = null;
let textRecognitionActive = false;
let dictationBaseText = '';
let finalDictationText = '';
let latestDictationText = '';
let dictationErrorMessage = '';

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    await clearAuthenticatedShell();
    window.location.assign('/');
    throw new Error('Your login is no longer valid.');
  }
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  refreshServiceWorker();
  return data;
}

function wakeSelma() {
  fetch('/api/wake-selma', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
    keepalive: true
  }).catch(() => {});
}

function workerMessage(message) {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  return navigator.serviceWorker.ready.then((registration) => new Promise((resolve) => {
    const worker = navigator.serviceWorker.controller || registration.active;
    if (!worker) {
      resolve();
      return;
    }
    const channel = new MessageChannel();
    const timeout = window.setTimeout(resolve, 2000);
    channel.port1.onmessage = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    worker.postMessage(message, [channel.port2]);
  }));
}

function clearAuthenticatedShell() {
  return workerMessage({ type: 'CLEAR_AUTHENTICATED_SHELL' });
}

function refreshServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => {});
}

async function initializeServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Register only on the first server-backed launch. Calling register on every
  // cached launch can trigger a network update check and wake the server.
  if (!navigator.serviceWorker.controller) {
    await navigator.serviceWorker.register('/service-worker.js');
  }

  const html = `<!doctype html>\n${document.documentElement.outerHTML}`;
  await workerMessage({ type: 'CACHE_AUTHENTICATED_SHELL', html });
}

function setTextStatus(value) {
  textStatus.textContent = value;
}

function setVoiceStatus(value) {
  voiceStatus.textContent = value;
}

function appendDictation(baseText, spokenText) {
  const cleanBase = String(baseText || '').trimEnd();
  const cleanSpoken = String(spokenText || '').trim();
  if (!cleanSpoken) return cleanBase;
  return cleanBase ? `${cleanBase} ${cleanSpoken}` : cleanSpoken;
}

function setDictationActive(active) {
  textRecognitionActive = active;
  dictationButton.classList.toggle('is-listening', active);
  dictationButton.setAttribute('aria-pressed', String(active));
  dictationButton.setAttribute('aria-label', active ? 'Stop voice input' : 'Start voice input');
}

function stopTextDictation() {
  if (!textRecognition || !textRecognitionActive) return;
  textRecognition.stop();
}

function createTextRecognition() {
  if (!SpeechRecognition) return null;
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  recognition.addEventListener('start', () => {
    setDictationActive(true);
    setTextStatus('Listening...');
  });

  recognition.addEventListener('result', (event) => {
    let interimText = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0]?.transcript || '';
      if (result.isFinal) {
        finalDictationText = `${finalDictationText} ${transcript}`.trim();
      } else {
        interimText = `${interimText} ${transcript}`.trim();
      }
    }
    latestDictationText = `${finalDictationText} ${interimText}`.trim();
    textInput.value = appendDictation(dictationBaseText, latestDictationText);
  });

  recognition.addEventListener('end', () => {
    const capturedText = (latestDictationText || finalDictationText).trim();
    setDictationActive(false);
    textInput.value = appendDictation(dictationBaseText, capturedText);
    setTextStatus(dictationErrorMessage || (capturedText ? 'Voice input added. Press Send when ready.' : 'Voice input stopped.'));
    dictationErrorMessage = '';
    textInput.focus();
  });

  recognition.addEventListener('error', (event) => {
    dictationErrorMessage = event.error === 'not-allowed' ? 'Microphone permission was denied.' : 'Voice input failed.';
  });

  return recognition;
}

function startTextDictation() {
  if (!SpeechRecognition) {
    setTextStatus('Voice input is not supported in this browser.');
    return;
  }
  if (textRecognitionActive) {
    stopTextDictation();
    return;
  }

  dictationBaseText = textInput.value;
  finalDictationText = '';
  latestDictationText = '';
  dictationErrorMessage = '';
  textRecognition = createTextRecognition();
  try {
    textRecognition.start();
  } catch (error) {
    setDictationActive(false);
    setTextStatus(error.message || 'Could not start voice input.');
  }
}

function getSharedText() {
  if (window.location.pathname !== '/share') return '';
  const params = new URLSearchParams(window.location.search);
  const parts = [params.get('title'), params.get('text'), params.get('url')]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return parts.join('\n\n');
}

function loadSharedText() {
  const sharedText = getSharedText();
  if (!sharedText) return;
  textInput.value = sharedText;
  showPanel('text');
  setTextStatus('Shared content loaded. Press Send when ready.');
  window.history.replaceState({}, '', '/');
}

function showPanel(panelName) {
  const showText = panelName === 'text';
  textPanel.hidden = !showText;
  voicePanel.hidden = showText;
  if (showText) {
    textInput.focus();
  } else {
    startButton.focus();
  }
}

function renderTranscript() {
  liveTranscript.replaceChildren();
  for (const turn of transcriptTurns) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = turn.role === 'assistant' ? 'Assistant: ' : 'User: ';
    item.append(label, document.createTextNode(turn.text));
    liveTranscript.append(item);
  }
}

function addTurn(role, text, metadata = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return;
  const turn = {
    role,
    text: cleanText,
    order: turnCounter++,
    ...metadata
  };
  transcriptTurns.push(turn);
  renderTranscript();
}

function setVoiceActive(active) {
  startButton.disabled = active;
  endButton.disabled = !active;
  voicePanel.classList.toggle('is-active', active);
}

function stopRealtimeResources() {
  if (dataChannel) dataChannel.close();
  if (peerConnection) peerConnection.close();
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
  }
  dataChannel = null;
  peerConnection = null;
  micStream = null;
  remoteAudio.srcObject = null;
}

function resetVoiceState() {
  startedAt = null;
  turnCounter = 0;
  transcriptTurns = [];
  userItems = new Map();
  renderTranscript();
}

function handleRealtimeEvent(event) {
  if (event.type === 'input_audio_buffer.committed') {
    userItems.set(event.item_id, {
      previousItemId: event.previous_item_id || null,
      observedOrder: turnCounter
    });
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const item = userItems.get(event.item_id) || {};
    addTurn('user', event.transcript, {
      itemId: event.item_id,
      previousItemId: item.previousItemId || null
    });
    return;
  }

  if (event.type === 'response.output_audio_transcript.done') {
    addTurn('assistant', event.transcript, {
      itemId: event.item_id || event.response_id || null
    });
    return;
  }

  if (event.type === 'error') {
    setVoiceStatus(event.error?.message || 'Realtime session error.');
  }
}

async function startConversation() {
  resetVoiceState();
  setVoiceStatus('Requesting microphone permission...');
  setVoiceActive(true);

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setVoiceStatus('Creating realtime session...');
    const session = await postJson('/api/realtime/session', {});

    peerConnection = new RTCPeerConnection();
    peerConnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
    };
    for (const track of micStream.getAudioTracks()) {
      peerConnection.addTrack(track, micStream);
    }

    dataChannel = peerConnection.createDataChannel('oai-events');
    dataChannel.addEventListener('message', (messageEvent) => {
      try {
        handleRealtimeEvent(JSON.parse(messageEvent.data));
      } catch {
        setVoiceStatus('Received an unreadable realtime event.');
      }
    });
    dataChannel.addEventListener('open', () => {
      setVoiceStatus('Conversation active.');
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const realtimeResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.client_secret}`,
        'Content-Type': 'application/sdp'
      },
      body: offer.sdp
    });
    if (!realtimeResponse.ok) {
      const errorText = await realtimeResponse.text().catch(() => '');
      throw new Error(errorText ? `Realtime connection setup failed: ${errorText}` : 'Realtime connection setup failed.');
    }
    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: await realtimeResponse.text()
    });
    startedAt = new Date().toISOString();
  } catch (error) {
    stopRealtimeResources();
    setVoiceActive(false);
    setVoiceStatus(error.name === 'NotAllowedError' ? 'Microphone permission was denied.' : error.message || 'Could not start conversation.');
  }
}

async function endConversation() {
  const endedAt = new Date().toISOString();
  setVoiceStatus('Ending conversation...');
  setVoiceActive(false);
  stopRealtimeResources();

  if (!transcriptTurns.length) {
    setVoiceStatus('No completed transcript turns were captured. Nothing was sent.');
    return;
  }

  try {
    setVoiceStatus('Sending transcript to SELMA...');
    await postJson('/api/send-voice-transcript', {
      started_at: startedAt || endedAt,
      ended_at: endedAt,
      turns: transcriptTurns.map(({ role, text }) => ({ role, text }))
    });
    resetVoiceState();
    setVoiceStatus('Sent.');
  } catch (error) {
    setVoiceStatus(error.message || 'Failed to send transcript.');
  }
}

textForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  stopTextDictation();
  const text = textInput.value.trim();
  if (!text) {
    setTextStatus('Enter text before sending.');
    return;
  }
  sendButton.disabled = true;
  setTextStatus('Sending...');
  try {
    await postJson('/api/send-text', { text });
    textInput.value = '';
    setTextStatus('Sent.');
  } catch (error) {
    setTextStatus(error.message || 'Failed.');
  } finally {
    sendButton.disabled = false;
  }
});

dictationButton.addEventListener('click', startTextDictation);
startButton.addEventListener('click', startConversation);
endButton.addEventListener('click', endConversation);
showVoiceButton.addEventListener('click', () => showPanel('voice'));
showTextButton.addEventListener('click', () => showPanel('text'));
logoutButton.addEventListener('click', async () => {
  try {
    const response = await fetch('/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken }
    });
    if (!response.ok && response.status !== 401) throw new Error('Log out failed.');
    await clearAuthenticatedShell();
    window.location.assign('/');
  } catch (error) {
    setTextStatus(error.message || 'Log out failed.');
  }
});

initializeServiceWorker().catch(() => {});

wakeSelma();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') wakeSelma();
});

if (!SpeechRecognition) {
  dictationButton.disabled = true;
  dictationButton.setAttribute('aria-label', 'Voice input is not supported in this browser');
}

loadSharedText();
