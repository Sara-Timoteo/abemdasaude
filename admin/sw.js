// Service Worker do painel admin
// Estratégia: REDE PRIMEIRO para conteúdo próprio (HTML/JS/CSS) — mostra sempre a
// versão nova quando há internet; a cache só serve de reserva quando estás offline.
// Assim NÃO é preciso mudar a versão a cada deploy.

const CACHE_NAME = 'abem-admin-v7';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  '../icon-192.png',
  '../icon-512.png',
  '../assets/abem-logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Nunca mexer em Supabase nem CDNs — deixa passar direto à rede.
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('jsdelivr.net')) {
    return;
  }

  // Só tratamos ficheiros da nossa própria origem.
  if (url.origin !== self.location.origin) return;

  // REDE PRIMEIRO: tenta a rede, atualiza a cache e serve o novo.
  // Se falhar (offline), serve o que houver em cache; para navegações, o index.
  event.respondWith(
    fetch(req).then(resp => {
      if (resp && resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy));
      }
      return resp;
    }).catch(() =>
      caches.match(req).then(cached =>
        cached || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())
      )
    )
  );
});
