/* Service Worker — abem: da Saúde
   Estratégia: REDE PRIMEIRO para conteúdo próprio (HTML/JS/CSS) — mostra sempre a
   versão nova quando há internet; a cache só serve de reserva quando estás offline.
   Assim NÃO é preciso mudar a versão a cada deploy.
   Exceções: leituras selectivas do Supabase (niveis/quiz_questoes/recompensas) ficam
   em stale-while-revalidate para o quiz funcionar offline; fontes/CDN vão sempre à rede.
*/

const CACHE_NAME = 'quiz-mais-saude-v19';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './assets/abem-logo.png',
  './assets/dignitude-logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Adiciona um a um — se algum falhar, não estoura o install todo
      Promise.all(ASSETS.map(url =>
        cache.add(url).catch(err => console.warn('SW: falhou cache de', url, err))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Supabase: cachear leituras GET selectivas (niveis, quiz_questoes, recompensas)
  // para funcionar offline. Resto passa à rede sem cache.
  if (url.hostname.includes('supabase.co')) {
    if (req.method === 'GET' && (
        url.pathname.includes('/rest/v1/niveis') ||
        url.pathname.includes('/rest/v1/quiz_questoes') ||
        url.pathname.includes('/rest/v1/recompensas')
    )) {
      event.respondWith(staleWhileRevalidate(req));
      return;
    }
    return; // outras chamadas Supabase: deixa a rede tratar
  }

  // Fontes/CDN: também sempre à rede
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('jsdelivr.net')) {
    return;
  }

  if (req.method !== 'GET') return;
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

// Stale-while-revalidate: devolve cache imediatamente, actualiza em background
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(resp => {
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  }).catch(() => null);

  if (cached) {
    // Devolver imediatamente o que está em cache; refresh acontece em paralelo
    networkPromise.catch(() => {}); // garantir que a promise não fica unhandled
    return cached;
  }
  // Sem cache — esperar pela rede
  const fresh = await networkPromise;
  return fresh || new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ============================================
// Notificações: clique abre/foca a app
// ============================================

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetURL = new URL('./', self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Tentar focar uma janela existente da app
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
          return c.focus();
        }
      }
      // Senão, abrir nova
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetURL);
      }
    })
  );
});
