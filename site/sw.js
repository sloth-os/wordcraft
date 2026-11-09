// WordCraft web service worker: makes the app work offline.
//
// The build assets (wasm, js) carry content hashes in their names, so they are immutable and
// served cache-first forever. index.html is the only file that moves between builds, so it is
// network-first: a new weekly deployment is picked up on the next online visit, and offline the
// cached copy is served instead. The worker's own byte-diff update check (browsers refetch
// sw.js behind a navigation) plus skipWaiting/clients.claim make a new deployment take over
// within one visit. version.json (written by the build) stays uncached so about:inspectors and
// the page can always see the live deployment id.
//
// User-added fonts live in IndexedDB and preferences in localStorage — the app manages those
// itself, the service worker never touches them.
'use strict';

const CACHE = 'wordcraft-web-v1';

// Everything the shell needs on a cold offline start. The hashed wasm/js are picked up at runtime
// (cache-first) when the page first loads them; their names aren't known until the build, so
// they can't be precached. One failed entry doesn't fail the install — the page still works
// online, and the next visit retries the cache.
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((e) => console.warn('sw: precache miss', url, e))
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache that isn't the current one: leftovers from older worker versions.
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'wordcraft:skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The deployment marker is never served from the cache: the live build id must be visible.
  if (url.pathname.endsWith('/version.json')) return;

  // The page itself: network-first so a new deployment is picked up on the next online visit,
  // cached copy as the offline fallback.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Hashed build assets and the PWA icons: immutable, cache-first. sw.js is excluded — a new
  // worker must always come from the network or updates stall behind the cached one.
  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else same-origin (offline.html, wordcraft.ico, …): stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});

function isImmutableAsset(url) {
  if (url.pathname.endsWith('/sw.js')) return false;
  return /\.(wasm|js|png|ico|woff2?)$/.test(url.pathname) || /-[0-9a-f]{8,}\.(css|svg|png)$/.test(url.pathname);
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return new Response('offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
    if (cached) return cached;
    return new Response(
      '<!doctype html><title>WordCraft offline</title><p style="font:14px system-ui;padding:2em">WordCraft is not cached yet. Load it online once, then it works offline.</p>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  const fetched = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || fetched;
}
