/* Gibbon service worker — network-first (with a short timeout) so updates land
 * immediately, cache fallback so the instrument works fully offline. */
const CACHE = 'saigon-v4-2';
const CORE = ['./', 'app.js', 'manifest.webmanifest',
              'icon-192.png', 'icon-512.png', 'icon-180.png'];
const NET_TIMEOUT_MS = 3500;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const net = fetch(req);
    try {
      const res = await Promise.race([
        net,
        new Promise((_, rej) => setTimeout(() => rej(new Error('net-timeout')), NET_TIMEOUT_MS)),
      ]);
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
      }
      return res;
    } catch (err) {
      const m = await caches.match(req, { ignoreSearch: true });
      if (m) return m;
      if (req.mode === 'navigate') {
        const idx = await caches.match('./');
        if (idx) return idx;
      }
      return net; // nothing cached — let the slow network finish
    }
  })());
});
