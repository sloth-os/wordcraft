// WordCraft web service worker: makes the app work offline.
//
// The build assets (wasm, js) carry content hashes in their names, so they are immutable and
// served cache-first forever. index.html is the only file that moves between builds, so it is
// network-first: a new weekly deployment is picked up on the next online visit, and offline the
// cached copy is served instead. On activation the worker warms the cache with everything the
// current index.html references — a first visit's page requests race ahead of the worker's
// activation, so without that pass the hashed js/wasm would only reach the cache on a second
// online visit. The same pass prunes hashed assets that no current page references (each weekly
// build replaces them; the wasm alone is ~60 MB). The worker's own byte-diff update check
// (browsers refetch sw.js behind a navigation) plus skipWaiting/clients.claim make a new
// deployment take over within one visit. version.json (written by the build) stays uncached so
// the page can always see the live deployment id.
//
// User-added fonts live in IndexedDB and preferences in localStorage — the app manages those
// itself, the service worker never touches them.
'use strict';

const CACHE = 'wordcraft-web-v1';

// Everything the shell needs on a cold offline start. The hashed js/wasm can't be listed here
// (their names are only known after the build); they are warmed right after activation by
// warmAppAssets(), and served cache-first by the fetch handler afterwards. One failed entry
// doesn't fail the install — the page still works online, and the next visit retries.
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
      try {
        await warmAppAssets();
      } catch (err) {
        console.warn('sw: asset warm-up failed', err);
      }
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

  // Everything else same-origin (offline.html, unhashed icons, …): stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});

function isImmutableAsset(url) {
  if (url.pathname.endsWith('/sw.js')) return false;
  return /\.(wasm|js|png|ico|woff2?)$/.test(url.pathname) || /-[0-9a-f]{8,}\.(css|svg|png)$/.test(url.pathname);
}

// After activation: make sure the build the current index.html points at is fully cached.
//
// The page begins fetching the hashed js/wasm the moment its module scripts run — on a first
// visit that races ahead of this worker (registration happens on window load, control only after
// activation), so those requests bypass the fetch handler entirely. warmAppAssets() reads the
// cached index.html and caches every same-origin asset it references: script src, preload and
// modulepreload links, icons, stylesheets. Entries already in the cache are skipped; failures
// only warn — the page is working online at that point and the next visit fills any gap.
// Finally, hashed assets that the current index no longer references (previous weekly builds)
// are deleted so the cache doesn't grow by a wasm per week.
async function warmAppAssets() {
  const cache = await caches.open(CACHE);
  const index = await cache.match('./index.html', { ignoreVary: true });
  if (!index) return;

  const html = await index.text();
  const scope = self.registration.scope;
  const wanted = new Set(PRECACHE.map((u) => new URL(u, scope).href));

  const refs = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel=["']([^"']+)["']/i.exec(tag);
    const href = /\bhref=["']([^"']+)["']/i.exec(tag);
    if (!rel || !href) continue;
    const kinds = rel[1].toLowerCase().split(/\s+/);
    if (kinds.some((k) => ['preload', 'modulepreload', 'icon', 'stylesheet', 'manifest', 'apple-touch-icon'].includes(k))) {
      refs.push(href[1]);
    }
  }
  for (const ref of refs) {
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(ref)) continue; // absolute or protocol-relative: skip
    try {
      const url = new URL(ref, scope);
      if (url.origin !== self.location.origin) continue;
      wanted.add(url.href);
    } catch {
      /* malformed ref: ignore */
    }
  }

  await Promise.all(
    [...wanted].map(async (href) => {
      if (await cache.match(href, { ignoreVary: true })) return;
      try {
        await cache.add(href); // plain fetch: reuses the page's fresh HTTP-cache entries
      } catch (err) {
        console.warn('sw: could not cache', href, err);
      }
    })
  );

  const stale = (await cache.keys()).filter((req) => {
    if (wanted.has(req.url)) return false;
    try {
      return /-[0-9a-f]{8,}/.test(new URL(req.url).pathname);
    } catch {
      return false;
    }
  });
  await Promise.all(stale.map((req) => cache.delete(req)));
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
