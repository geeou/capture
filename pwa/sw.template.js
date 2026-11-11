// CAPTURE service worker — generated at build time by vite.config.ts (do not edit dist/sw.js).
// Precaches the whole app shell so the game starts offline; hashed assets are immutable.
const VERSION = '__VERSION__';
const CACHE = 'capture-' + VERSION;
const FILES = __FILES__;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('capture-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // network first so a new deploy shows up as soon as there is a connection
    e.respondWith(
      fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); return res; })
        .catch(() => caches.match('./', { cacheName: CACHE })),
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })),
  );
});
