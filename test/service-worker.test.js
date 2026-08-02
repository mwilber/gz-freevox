import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadWorker({ cachedResponse = null, authenticatedShell = null } = {}) {
  const listeners = new Map();
  const calls = { addAll: [], authMatch: [], delete: [], fetch: [], match: [], open: [], put: [] };
  const staticCache = {
    async addAll(files) { calls.addAll.push(files); },
    async put(request, response) { calls.put.push([request, response]); }
  };
  const authCache = {
    async match(request) { calls.authMatch.push(request); return authenticatedShell; },
    async put(request, response) { calls.put.push([request, response]); }
  };
  const context = {
    URL,
    Set,
    Promise,
    fetch: async (request) => {
      calls.fetch.push(request);
      return new Response('network', { status: 200 });
    },
    Response,
    caches: {
      async open(name) {
        calls.open.push(name);
        return name === 'freevox-authenticated-shell-v1' ? authCache : staticCache;
      },
      async keys() {
        return [
          'unrelated-cache',
          'freevox-authenticated-shell-v1',
          'freevox-static-old',
          'freevox-static-__CACHE_VERSION__'
        ];
      },
      async delete(name) { calls.delete.push(name); return true; },
      async match(request, options) { calls.match.push([request, options]); return cachedResponse; }
    },
    self: {
      location: { origin: 'https://freevox.example' },
      clients: { async claim() {} },
      async skipWaiting() {},
      addEventListener(type, listener) { listeners.set(type, listener); }
    }
  };
  vm.createContext(context);
  const source = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  return { calls, listeners };
}

function dispatchFetch(listener, request) {
  let responsePromise;
  listener({ request, respondWith(value) { responsePromise = value; } });
  return responsePromise;
}

test('install precaches the complete static app shell', async () => {
  const { calls, listeners } = await loadWorker();
  let work;
  listeners.get('install')({ waitUntil(value) { work = value; } });
  await work;
  assert.equal(calls.addAll.length, 1);
  assert.ok(calls.addAll[0].includes('/app.js'));
  assert.ok(calls.addAll[0].includes('/styles.css'));
  assert.ok(calls.addAll[0].includes('/manifest.json'));
  assert.ok(calls.addAll[0].includes('/offline.html'));
});

test('static app files are served from cache before network', async () => {
  const cached = new Response('cached');
  const { calls, listeners } = await loadWorker({ cachedResponse: cached });
  const request = new Request('https://freevox.example/app.js?v=release');
  const response = await dispatchFetch(listeners.get('fetch'), request);
  assert.equal(response, cached);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.match[0][1].ignoreSearch, true);
});

test('API and external AI requests bypass the service worker cache', async () => {
  const { calls, listeners } = await loadWorker();
  const api = dispatchFetch(listeners.get('fetch'), new Request('https://freevox.example/api/send-text'));
  const ai = dispatchFetch(listeners.get('fetch'), new Request('https://api.openai.com/v1/realtime/calls'));
  assert.equal(api, undefined);
  assert.equal(ai, undefined);
  assert.equal(calls.match.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test('authenticated navigation loads instantly without contacting the server', async () => {
  const shell = new Response('<main>app</main>', { headers: { 'Content-Type': 'text/html' } });
  const { calls, listeners } = await loadWorker({ authenticatedShell: shell });
  const request = { method: 'GET', mode: 'navigate', url: 'https://freevox.example/' };
  const response = await dispatchFetch(listeners.get('fetch'), request);
  assert.equal(response, shell);
  assert.equal(calls.fetch.length, 0);
  assert.deepEqual(calls.authMatch, ['/__freevox_authenticated_shell__']);
});

test('logged-out navigation contacts the server for the login page', async () => {
  const { calls, listeners } = await loadWorker();
  const request = { method: 'GET', mode: 'navigate', url: 'https://freevox.example/' };
  const response = await dispatchFetch(listeners.get('fetch'), request);
  assert.equal(await response.text(), 'network');
  assert.equal(calls.fetch.length, 1);
});

test('authenticated app document is saved as the durable login state', async () => {
  const { calls, listeners } = await loadWorker();
  let work;
  listeners.get('message')({
    data: { type: 'CACHE_AUTHENTICATED_SHELL', html: '<!doctype html><main>app</main>' },
    ports: [{ postMessage() {} }],
    waitUntil(value) { work = value; }
  });
  await work;
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0][0], '/__freevox_authenticated_shell__');
  assert.equal(await calls.put[0][1].text(), '<!doctype html><main>app</main>');
});

test('explicit logout clears the authenticated shell cache', async () => {
  const { calls, listeners } = await loadWorker();
  let work;
  let acknowledged = false;
  listeners.get('message')({
    data: { type: 'CLEAR_AUTHENTICATED_SHELL' },
    ports: [{ postMessage() { acknowledged = true; } }],
    waitUntil(value) { work = value; }
  });
  await work;
  assert.ok(calls.delete.includes('freevox-authenticated-shell-v1'));
  assert.equal(acknowledged, true);
});

test('activation removes only older versioned FreeVox caches', async () => {
  const { calls, listeners } = await loadWorker();
  let work;
  listeners.get('activate')({ waitUntil(value) { work = value; } });
  await work;
  assert.deepEqual(calls.delete, ['freevox-static-old']);
});
