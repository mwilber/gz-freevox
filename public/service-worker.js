const CACHE_PREFIX = 'freevox-static-';
// The server replaces this token with a hash of the deployed static files.
const CACHE_VERSION = '__CACHE_VERSION__';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const AUTH_CACHE_NAME = 'freevox-authenticated-shell-v1';
const AUTH_SHELL_URL = '/__freevox_authenticated_shell__';

// These are the static files needed by the installed app. The authenticated HTML
// is stored separately so asset upgrades do not change the local login state.
const APP_FILES = [
  '/app.js',
  '/offline.html',
  '/styles.css',
  '/manifest.json',
  '/icons/android/android-launchericon-192-192.png',
  '/icons/android/android-launchericon-512-512.png',
  '/icons/ios/120.png',
  '/icons/ios/152.png',
  '/icons/ios/167.png',
  '/icons/ios/180.png',
  '/icons/windows11/Square44x44Logo.targetsize-16.png',
  '/icons/windows11/Square44x44Logo.targetsize-32.png',
  '/icons/windows11/Square44x44Logo.targetsize-256.png'
];

const APP_FILE_PATHS = new Set(APP_FILES);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

function isStaticAppRequest(request, url) {
  return request.method === 'GET'
    && url.origin === self.location.origin
    && APP_FILE_PATHS.has(url.pathname);
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function getAuthenticatedShell() {
  const cache = await caches.open(AUTH_CACHE_NAME);
  return cache.match(AUTH_SHELL_URL);
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CACHE_AUTHENTICATED_SHELL' && typeof event.data.html === 'string') {
    event.waitUntil((async () => {
      const cache = await caches.open(AUTH_CACHE_NAME);
      await cache.put(AUTH_SHELL_URL, new Response(event.data.html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }));
      event.ports[0]?.postMessage({ ok: true });
    })());
    return;
  }

  if (event.data?.type === 'CLEAR_AUTHENTICATED_SHELL') {
    event.waitUntil((async () => {
      await caches.delete(AUTH_CACHE_NAME);
      event.ports[0]?.postMessage({ ok: true });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only the explicitly listed, same-origin app files are cacheable. API,
  // authentication, AI-service, and all other external requests stay on network.
  if (isStaticAppRequest(event.request, url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Presence of the authenticated shell is the durable local login state. It is
  // removed only by explicit logout (or after a rejected authenticated request).
  if (event.request.method === 'GET' && event.request.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith((async () => {
      const shell = await getAuthenticatedShell();
      if (shell) return shell;
      return fetch(event.request).catch(() => caches.match('/offline.html'));
    })());
  }
});
