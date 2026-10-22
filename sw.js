/* sw.js — offline shell. The model itself is cached by the browser HTTP cache;
 * this keeps the app usable if the phone drops off the network mid-session.
 *
 * ⚠️ BUMP CACHE ON EVERY DEPLOY. The fetch handler is cache-first, so an
 * unchanged cache name means installed PWAs keep serving the OLD app forever.
 * v7 = v1.7 (Most Muscular added with the 6-athlete cross-validated band;
 *            two quarter turns added, all-estimated except the side-on gate).
 */
const CACHE = 'titan-pose-v7';
const SHELL = ['./', './index.html', './measure.html', './styles.css', './app.js', './measure.js', './pose-gates.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
