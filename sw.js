const VERSION = 'ratevault-v6';
const SHELL = `${VERSION}-shell`;
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== SHELL).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests with http/https schemes
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // Handle same origin and CDN assets (such as PDF.js)
  const isSameOrigin = url.origin === location.origin;
  const isCdn = url.hostname.includes('cdnjs.cloudflare.com');
  if (!isSameOrigin && !isCdn) return;

  // Cache-first strategy for app shell assets and PDF.js
  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        // Fetch in background to keep cache fresh
        fetch(request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(SHELL).then(cache => cache.put(request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }

      return fetch(request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(SHELL).then(cache => {
          cache.put(request, responseToCache);
        });
        return networkResponse;
      }).catch(async () => {
        if (request.mode === 'navigate') {
          return (await caches.match('./index.html')) || (await caches.match('./'));
        }
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
