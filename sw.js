// Debout ! — service worker : appli dispo hors ligne + notifications de réveil.
const VERSION = 'debout-v8';
const SOUNDS = ['classique', 'sirene', 'klaxon', 'fanfare', 'ecole', 'chiptune', 'recul', 'coucou', 'laser', 'sonar', 'gong',
  'carillon', 'decollage', 'disco', 'kazoo', 'alerte', 'stade', 'tambours', 'microondes', 'boite', 'silence'];
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/audio.js', 'js/config.js', 'js/data.js', 'js/ring.js', 'js/util.js',
  'fonts/bagel.woff2', 'fonts/bricolage.woff2', 'nosleep.mp4',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png',
  ...SOUNDS.map((s) => `sounds/${s}.mp3`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Réseau d'abord (pour avoir la dernière version), cache si hors ligne.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.headers.get('range')) return; // lecture audio partielle : laisser le navigateur gérer
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') })
      .then((r) => r || caches.match('index.html'))),
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Debout !', body: e.data && e.data.text() }; }
  const title = data.title || '⏰ Debout !';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Ouvre Debout ! pour couper ton réveil.',
    tag: data.tag || 'debout',
    renotify: true,
    requireInteraction: true,
    vibrate: [800, 300, 800, 300, 800, 300, 800],
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: data.url || './', key: data.tag },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.registration.scope).href;
  const key = e.notification.data?.key;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => c.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      if (key) open.postMessage({ type: 'ring', key });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
