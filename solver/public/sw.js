// Solver.ca service worker: makes the site installable and shows a friendly page when there is no connection.
// It never stores lead data: /api/* and live updates always go straight to the server, and pages are always
// fetched fresh, so nobody sees an old copy of a board. Only the app's own files are kept for offline start-up.
const CACHE = 'solver-shell-v1';
const SHELL = ['/offline.html', '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/sw.js') return; // always live
  if (req.mode === 'navigate') { e.respondWith(fetch(req).catch(() => caches.match('/offline.html'))); return; }
  if (/\.(js|css|svg|png|webmanifest)$/.test(url.pathname)) {
    // fresh from the server when online (so updates show at once); the saved copy only when offline
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => caches.match(req)));
  }
});
