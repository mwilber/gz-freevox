import http from 'node:http';
import { createHash, createHmac, timingSafeEqual, randomBytes, pbkdf2Sync } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;

async function createStaticCacheVersion(directory, relativeDirectory = '') {
  const hash = createHash('sha256');
  const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      hash.update(await createStaticCacheVersion(directory, relativePath));
    } else if (relativePath !== 'service-worker.js') {
      hash.update(relativePath);
      hash.update(await readFile(join(directory, relativePath)));
    }
  }

  return hash.digest('hex');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function createServer(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const staticCacheVersion = createStaticCacheVersion(PUBLIC_DIR);

  function requireConfig(names) {
    const missing = names.filter((name) => !env[name]);
    if (missing.length) {
      const error = new Error(`Missing required configuration: ${missing.join(', ')}`);
      error.statusCode = 500;
      throw error;
    }
  }

  function sign(value) {
    return createHmac('sha256', env.FREEVOX_SESSION_SECRET).update(value).digest('base64url');
  }

  function encodeCookiePayload(payload) {
    const value = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${value}.${sign(value)}`;
  }

  function decodeCookiePayload(value) {
    if (!value || !value.includes('.')) return null;
    const [raw, signature] = value.split('.');
    const expected = sign(raw);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length) return null;
    if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    try {
      return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  function parseCookies(req) {
    const header = req.headers.cookie || '';
    const cookies = {};
    for (const part of header.split(';')) {
      const [name, ...valueParts] = part.trim().split('=');
      if (!name) continue;
      cookies[name] = decodeURIComponent(valueParts.join('='));
    }
    return cookies;
  }

  function getSession(req) {
    if (!env.FREEVOX_SESSION_SECRET) return null;
    const session = decodeCookiePayload(parseCookies(req).freevox_session);
    if (!session || session.username !== env.FREEVOX_UI_USERNAME) return null;
    if (typeof session.csrfToken !== 'string' || !session.csrfToken) return null;
    return session;
  }

  function cookieHeader(session, req) {
    const secure = isSecureRequest(req) ? '; Secure' : '';
    return `freevox_session=${encodeURIComponent(encodeCookiePayload(session))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
  }

  function clearCookieHeader() {
    return 'freevox_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
  }

  function isSecureRequest(req) {
    return req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  }

  function validateOrigin(req) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
    const allowed = env.FREEVOX_ALLOWED_ORIGIN;
    if (!allowed) return true;
    const origin = req.headers.origin;
    return !origin || origin === allowed;
  }

  function validateCsrf(req, session) {
    const token = req.headers['x-csrf-token'];
    return Boolean(session?.csrfToken && token === session.csrfToken);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('Request body too large');
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const error = new Error('Invalid JSON');
      error.statusCode = 400;
      throw error;
    }
  }

  function sendJson(res, statusCode, body, headers = {}) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    });
    res.end(JSON.stringify(body));
  }

  function sendHtml(res, statusCode, html, headers = {}) {
    res.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    });
    res.end(html);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function verifyPassword(password, encodedHash) {
    const parts = String(encodedHash || '').split('$');
    if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
    const [, digest, iterationsRaw, salt, expected] = parts;
    const iterations = Number(iterationsRaw);
    if (!Number.isInteger(iterations) || iterations < 100000) return false;
    const actual = pbkdf2Sync(password, salt, iterations, Buffer.from(expected, 'base64url').length, digest).toString('base64url');
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  async function submitToSelma(payload) {
    requireConfig(['SELMA_BASE_URL', 'SELMA_API_TOKEN']);
    const baseUrl = env.SELMA_BASE_URL.replace(/\/+$/, '');
    const response = await fetchImpl(`${baseUrl}/api/agent-runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SELMA_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const error = new Error(`SELMA request failed with status ${response.status}`);
      error.statusCode = 502;
      throw error;
    }
    return response;
  }

  async function createRealtimeSession() {
    requireConfig(['OPENAI_API_KEY', 'REALTIME_MODEL', 'REALTIME_TRANSCRIPTION_MODEL']);
    const response = await fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: env.REALTIME_MODEL,
          audio: {
            input: {
              transcription: {
                model: env.REALTIME_TRANSCRIPTION_MODEL
              },
              turn_detection: {
                type: 'server_vad'
              }
            }
          }
        }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`OpenAI realtime session request failed with status ${response.status}`);
      error.statusCode = 502;
      throw error;
    }
    const secret = data.client_secret?.value || data.value || (typeof data.client_secret === 'string' ? data.client_secret : null);
    if (!secret) {
      const error = new Error('OpenAI realtime session response did not include a client secret');
      error.statusCode = 502;
      throw error;
    }
    return {
      client_secret: secret,
      model: data.session?.model || env.REALTIME_MODEL,
      expires_at: data.client_secret?.expires_at || data.expires_at ? new Date((data.client_secret?.expires_at || data.expires_at) * 1000).toISOString() : null
    };
  }

  function formatTextTranscript(text) {
    return text.trim();
  }

  function formatVoiceTranscript(startedAt, endedAt, turns) {
    const lines = [
      `Started: ${startedAt}`,
      `Ended: ${endedAt}`,
      '',
    ];
    for (const turn of turns) {
      const label = turn.role === 'assistant' ? 'Assistant' : 'User';
      lines.push(`**${label}:** ${String(turn.text).trim()}`);
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  function normalizeTurns(turns) {
    if (!Array.isArray(turns)) return [];
    return turns
      .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.text === 'string' && turn.text.trim())
      .map((turn) => ({ role: turn.role, text: turn.text.trim() }));
  }

  async function handleLogin(req, res) {
    requireConfig(['FREEVOX_SESSION_SECRET', 'FREEVOX_UI_USERNAME', 'FREEVOX_UI_PASSWORD_HASH']);
    const body = await readJson(req);
    if (body.username !== env.FREEVOX_UI_USERNAME || !verifyPassword(String(body.password || ''), env.FREEVOX_UI_PASSWORD_HASH)) {
      return sendJson(res, 401, { ok: false, error: 'Invalid username or password' });
    }
    const session = {
      username: env.FREEVOX_UI_USERNAME,
      csrfToken: randomBytes(32).toString('base64url')
    };
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(session, req) });
  }

  async function serveApp(req, res, session) {
    const template = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
    const csrfToken = session ? session.csrfToken : '';
    sendHtml(res, 200, template.replace('__CSRF_TOKEN__', escapeHtml(csrfToken)));
  }

  async function serveLogin(res) {
    const template = await readFile(join(PUBLIC_DIR, 'login.html'), 'utf8');
    sendHtml(res, 200, template);
  }

  async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const relative = normalize(pathname.replace(/^\/+/, ''));
    if (relative.startsWith('..')) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }
    const filePath = join(PUBLIC_DIR, relative);
    try {
      let content = await readFile(filePath);
      if (relative === 'service-worker.js') {
        const version = (await staticCacheVersion).slice(0, 16);
        content = Buffer.from(content.toString('utf8').replace('__CACHE_VERSION__', version));
      }
      const cacheControl = ['app.js', 'index.html', 'login.html', 'service-worker.js'].includes(relative)
        ? 'no-cache'
        : 'public, max-age=3600';
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
        'Cache-Control': cacheControl
      });
      res.end(content);
    } catch {
      sendJson(res, 404, { ok: false, error: 'Not found' });
    }
  }

  async function handleApi(req, res, session) {
    if (!session) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
    if (!validateCsrf(req, session)) return sendJson(res, 403, { ok: false, error: 'Invalid CSRF token' });

    if (req.method === 'POST' && req.url === '/api/realtime/session') {
      const realtimeSession = await createRealtimeSession();
      return sendJson(res, 200, realtimeSession);
    }

    if (req.method === 'POST' && req.url === '/api/send-text') {
      const body = await readJson(req);
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return sendJson(res, 400, { ok: false, error: 'Text is required' });
      }
      const submittedAt = now().toISOString();
      await submitToSelma({
        transcript: formatTextTranscript(body.text),
        source: 'freevox_text',
        metadata: { submitted_at: submittedAt }
      });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/api/send-voice-transcript') {
      const body = await readJson(req);
      const turns = normalizeTurns(body.turns);
      if (!turns.length) return sendJson(res, 400, { ok: false, error: 'At least one transcript turn is required' });
      const startedAt = typeof body.started_at === 'string' && body.started_at ? body.started_at : now().toISOString();
      const endedAt = typeof body.ended_at === 'string' && body.ended_at ? body.ended_at : now().toISOString();
      await submitToSelma({
        transcript: formatVoiceTranscript(startedAt, endedAt, turns),
        source: 'freevox_realtime',
        metadata: {
          conversation_started_at: startedAt,
          conversation_ended_at: endedAt,
          turn_count: turns.length
        }
      });
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!validateOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Invalid origin' });
      const url = new URL(req.url, 'http://localhost');
      const session = getSession(req);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/share')) {
        return session ? await serveApp(req, res, session) : await serveLogin(res);
      }

      if (req.method === 'POST' && url.pathname === '/login') {
        return await handleLogin(req, res);
      }

      if (req.method === 'POST' && url.pathname === '/logout') {
        if (!session) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
        if (!validateCsrf(req, session)) return sendJson(res, 403, { ok: false, error: 'Invalid CSRF token' });
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
      }

      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, session);
      }

      if (req.method === 'GET') {
        return await serveStatic(req, res);
      }

      return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (error) {
      if ((env.LOG_LEVEL || '').toLowerCase() === 'debug') {
        console.error(error);
      }
      sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : 'Internal server error' });
    }
  });

  server.formatTextTranscript = formatTextTranscript;
  server.formatVoiceTranscript = formatVoiceTranscript;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  dotenv.config({ quiet: true });
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(port, () => {
    console.log(`FreeVox listening on port ${port}`);
  });
}
