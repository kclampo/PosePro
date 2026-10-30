/* sw.js — offline shell. The model itself is cached by the browser HTTP cache;
 * this keeps the app usable if the phone drops off the network mid-session.
 *
 * ⚠️ BUMP CACHE ON EVERY DEPLOY. The fetch handler is cache-first, so an
 * unchanged cache name means installed PWAs keep serving the OLD app forever.
 * v10 = v1.8.2 (light meter: reports mean luma + a noise proxy in the camera
 *             line, disambiguates "TOO DARK" from "STEP INTO FRAME", and
 *             records the reading per pose so dim sessions can be flagged).
 * v14 = v1.8.5 (still capture at POSE LOCKED + one-ZIP export with the session
 *             JSON; anti-false-green red->green edge so a pose cannot inherit
 *             the previous pose's geometry).
 */
const CACHE = 'titan-pose-v20';
const SHELL = ['./', './index.html', './measure.html', './styles.css', './app.js', './measure.js', './pose-gates.js', './zip.js', './version.js', './manifest.json', './icon.svg'];

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
  // ⛔ version.json must ALWAYS hit the network. A cached copy would report
  // "up to date" forever — which is the exact failure the version badge exists
  // to catch. Never add it to SHELL.
  if (e.request.url.indexOf('version.json') !== -1) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
