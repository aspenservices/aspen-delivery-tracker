/* Aspen Delivery Tracker — Service Worker
 * Strategy: NETWORK-FIRST for the app document (index.html) so techs always get the freshest
 * deploy when they have signal, with a cached fallback so the app still OPENS offline. Static
 * assets (icons) are cache-first. Firebase / Google APIs are never cached — they must always
 * hit the network (and are handled by the app's own offline queue when there's no signal).
 *
 * IMPORTANT: bump CACHE_VERSION whenever you want to force-refresh the cached shell. You do NOT
 * normally need to — index.html is network-first, so new deploys are picked up automatically
 * while online. Bumping just clears the offline fallback copy.
 */
const CACHE_VERSION = 'aspen-delivery-v1';
const APP_SHELL = './index.html';

self.addEventListener('install', (e) => {
  // Pre-cache the app shell so the very first offline open works.
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll([APP_SHELL, './manifest.json']).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Drop old caches from previous versions.
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept Firebase, Google, or any cross-origin API/data traffic.
  const bypass = [
    'firebaseio.com', 'firebasedatabase.app', 'googleapis.com', 'google.com',
    'gstatic.com', 'googleusercontent.com', 'accounts.google.com', 'apis.google.com'
  ];
  if (bypass.some((h) => url.hostname.includes(h))) return;

  const isDoc = req.mode === 'navigate' ||
                req.destination === 'document' ||
                url.pathname.endsWith('/') ||
                url.pathname.endsWith('index.html');

  if (isDoc) {
    // NETWORK-FIRST: try the network, fall back to the cached shell when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(APP_SHELL, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(APP_SHELL).then((r) => r || caches.match(req)))
    );
    return;
  }

  // STATIC ASSETS: cache-first with background refresh.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
