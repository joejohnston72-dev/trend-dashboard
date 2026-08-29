/* Trend Bot service worker — offline shell + last-known data.
   Shell is cache-first (instant, works offline). Data is network-first (fresh when
   online, falls back to the last cached snapshot offline) so the app can always
   render *something*, and the staleness banner tells the user how old it is. */
const CACHE = 'trendbot-v1';
const SHELL = [
  './', './index.html', './style.css', './app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.pathname.includes('/data/')) {
    // network-first, cache the clean URL (strip cache-busting query) as fallback
    const key = new Request(url.origin + url.pathname);
    e.respondWith(
      fetch(e.request).then(r => {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(key, cp));
        return r;
      }).catch(() => caches.match(key))
    );
  } else {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
