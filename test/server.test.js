import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from '../server.js';

function passwordHash(password) {
  const digest = 'sha256';
  const iterations = 210000;
  const salt = 'testsalt';
  const hash = pbkdf2Sync(password, salt, iterations, 32, digest).toString('base64url');
  return `pbkdf2$${digest}$${iterations}$${salt}$${hash}`;
}

function env(overrides = {}) {
  return {
    FREEVOX_SESSION_SECRET: 'test-secret-that-is-long-enough',
    FREEVOX_UI_USERNAME: 'user',
    FREEVOX_UI_PASSWORD_HASH: passwordHash('pass'),
    SELMA_BASE_URL: 'https://selma.example',
    SELMA_API_TOKEN: 'selma-token',
    OPENAI_API_KEY: 'openai-token',
    REALTIME_MODEL: 'gpt-realtime-test',
    REALTIME_TRANSCRIPTION_MODEL: 'gpt-transcribe-test',
    ...overrides
  };
}

async function withServer(options, callback) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'user', password: 'pass' })
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const app = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
  const html = await app.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  assert.ok(csrf);
  return { cookie, csrf };
}

async function authedPost(baseUrl, auth, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Cookie: auth.cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': auth.csrf
    },
    body: JSON.stringify(body)
  });
}

test('GET /healthz returns process health without auth', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test('auth-protected routes reject unauthenticated requests', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' })
    });
    assert.equal(response.status, 401);
  });
});

test('authenticated POST routes require CSRF token', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await fetch(`${baseUrl}/api/send-text`, {
      method: 'POST',
      headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' })
    });
    assert.equal(response.status, 403);
  });
});

test('GET /share serves login when unauthenticated', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/share?text=hello`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /FreeVox Login/);
  });
});

test('GET /share serves app when authenticated', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await fetch(`${baseUrl}/share?title=A&text=B&url=https%3A%2F%2Fexample.com`, {
      headers: { Cookie: auth.cookie }
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="text-panel"/);
    assert.match(html, new RegExp(`content="${auth.csrf}"`));
  });
});

test('login persists across server instances with stateless signed cookie', async () => {
  let auth;
  await withServer({ env: env(), now: () => new Date('2026-05-22T16:30:00Z') }, async (baseUrl) => {
    auth = await login(baseUrl);
  });

  await withServer({ env: env(), now: () => new Date('2026-05-22T16:31:00Z') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`, { headers: { Cookie: auth.cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="text-panel"/);
    assert.match(html, new RegExp(`content="${auth.csrf}"`));
  });
});

test('signed login cookie remains valid until explicit logout', async () => {
  let auth;
  await withServer({ env: env(), now: () => new Date('2026-05-22T16:30:00Z') }, async (baseUrl) => {
    auth = await login(baseUrl);
  });

  await withServer({ env: env(), now: () => new Date('2026-06-22T16:30:01Z') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`, { headers: { Cookie: auth.cookie } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="text-panel"/);
  });
});

test('explicit logout clears the persistent login cookie', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf }
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /freevox_session=;/);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  });
});

test('POST /api/send-text rejects empty text', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await authedPost(baseUrl, auth, '/api/send-text', { text: '   ' });
    assert.equal(response.status, 400);
  });
});

test('POST /api/send-text calls SELMA with source freevox_text', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await withServer({ env: env(), fetchImpl, now: () => new Date('2026-05-22T16:30:00Z') }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await authedPost(baseUrl, auth, '/api/send-text', { text: 'Buy milk.' });
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, 'https://selma.example/api/agent-runs');
    assert.equal(calls[0].body.source, 'freevox_text');
    assert.equal(calls[0].body.transcript, 'Buy milk.');
    assert.equal(calls[0].body.metadata.submitted_at, '2026-05-22T16:30:00.000Z');
  });
});

test('POST /api/send-voice-transcript rejects empty turns', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await authedPost(baseUrl, auth, '/api/send-voice-transcript', { turns: [] });
    assert.equal(response.status, 400);
  });
});

test('POST /api/send-voice-transcript formats turns and calls SELMA with source freevox_realtime', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await withServer({ env: env(), fetchImpl }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await authedPost(baseUrl, auth, '/api/send-voice-transcript', {
      started_at: '2026-05-22T16:30:00Z',
      ended_at: '2026-05-22T16:34:00Z',
      turns: [
        { role: 'user', text: 'Remind me to buy milk tomorrow.' },
        { role: 'assistant', text: 'I can help with that.' }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0].body.source, 'freevox_realtime');
    assert.equal(calls[0].body.metadata.turn_count, 2);
    assert.equal(calls[0].body.transcript.startsWith('#'), false);
    assert.equal(calls[0].body.transcript.includes('## Transcript'), false);
    assert.match(calls[0].body.transcript, /^Started: 2026-05-22T16:30:00Z\nEnded: 2026-05-22T16:34:00Z/);
    assert.match(calls[0].body.transcript, /\*\*User:\*\* Remind me to buy milk tomorrow\.\n\n\*\*Assistant:\*\* I can help with that\./);
  });
});

test('realtime session endpoint does not expose OPENAI_API_KEY', async () => {
  const fetchImpl = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer openai-token');
    return new Response(JSON.stringify({
      client_secret: { value: 'ephemeral-token', expires_at: 1770000000 },
      session: { model: 'gpt-realtime-test' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await withServer({ env: env(), fetchImpl }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await authedPost(baseUrl, auth, '/api/realtime/session', {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.client_secret, 'ephemeral-token');
    assert.equal(JSON.stringify(body).includes('openai-token'), false);
  });
});

test('realtime session endpoint accepts current top-level client secret response shape', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    value: 'top-level-ephemeral-token',
    expires_at: 1770000000,
    session: { model: 'gpt-realtime-test' }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await withServer({ env: env(), fetchImpl }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await authedPost(baseUrl, auth, '/api/realtime/session', {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.client_secret, 'top-level-ephemeral-token');
    assert.equal(body.expires_at, '2026-02-02T02:40:00.000Z');
  });
});

test('realtime session errors return 502 without crashing the server', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    session: { model: 'gpt-realtime-test' }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await withServer({ env: env(), fetchImpl }, async (baseUrl) => {
    const auth = await login(baseUrl);
    const response = await authedPost(baseUrl, auth, '/api/realtime/session', {});
    assert.equal(response.status, 502);
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
  });
});

test('service worker and manifest are served', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const sw = await fetch(`${baseUrl}/service-worker.js`);
    const manifest = await fetch(`${baseUrl}/manifest.json`);
    assert.equal(sw.status, 200);
    assert.equal(manifest.status, 200);
    const source = await sw.text();
    assert.doesNotMatch(source, /__CACHE_VERSION__/);
    assert.match(source, /const CACHE_VERSION = '[a-f0-9]{16}'/);
  });
});

test('manifest contains required installability fields and icon references', async () => {
  await withServer({ env: env() }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/manifest.json`);
    const manifest = await response.json();
    assert.equal(manifest.name, 'FreeVox');
    assert.equal(manifest.short_name, 'FreeVox');
    assert.equal(manifest.description, 'Private voice and text input for SELMA.');
    assert.equal(manifest.id, '/');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.orientation, 'any');
    assert.ok(manifest.theme_color);
    assert.ok(manifest.background_color);
    assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any'));
    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
    assert.deepEqual(manifest.share_target, {
      action: '/share',
      method: 'GET',
      params: {
        title: 'title',
        text: 'text',
        url: 'url'
      }
    });
  });
});

test('server listens on injected PORT in Heroku-like startup', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env(), PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const [chunk] = await once(child.stdout, 'data');
    assert.match(String(chunk), /FreeVox listening on port/);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});
