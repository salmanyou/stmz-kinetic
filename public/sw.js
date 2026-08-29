/* STMZ Kinetic service worker — v6
   Strategy: network-first for HTML/JS (so updates show immediately),
             cache-first for CSS/SVG (static assets safely cached).
   skipWaiting + clients.claim so a fresh deploy replaces an old SW
   on the very next navigation, no "wait until all tabs close". */
const CACHE = 'stmz-v24';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;                          // never cache API
  if (url.origin !== self.location.origin) return;                       // never cache cross-origin

  // network-first for HTML & JS (latest code wins)
  if (req.destination === 'document' || url.pathname.endsWith('.js') || url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone()).catch(()=>{});
        return fresh;
      } catch {
        const hit = await caches.match(req);
        return hit || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }
  // cache-first for everything else (CSS, SVG, images, manifest)
  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        // Only cache successful, basic-type responses
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
        }
        return res;
      }).catch(() => new Response('', { status: 204 })); // silent fail on offline
    })
  );
});
