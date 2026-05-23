/* ============================================================
   SellTrack — Service Worker
   Stratégie :
   - app shell (HTML/CSS/JS/icônes) : cache-first
   - CDN externes (fonts, Chart.js, Lucide) : stale-while-revalidate
   - tout le reste : network-first avec fallback cache
   ============================================================ */

const VERSION = 'selltrack-v1.0.0';
const CACHE_STATIC = `${VERSION}-static`;
const CACHE_DYNAMIC = `${VERSION}-dynamic`;

// Fichiers de l'app shell, pré-cachés à l'install
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// =============================================================
// INSTALL — pré-cache l'app shell
// =============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => {
      // addAll est strict : si un fichier 404 tout échoue. On tolère donc
      // les échecs individuels (utile en dev local).
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] skip:', url, err.message))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// =============================================================
// ACTIVATE — nettoie les anciens caches de version
// =============================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// =============================================================
// FETCH — stratégies de cache
// =============================================================
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // On ne gère que GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Requêtes vers Supabase / API : toujours réseau (data fraîche obligatoire)
  if (url.hostname.endsWith('.supabase.co') || url.hostname.includes('supabase')) {
    return; // laissé au navigateur, pas d'interception
  }

  // 2. CDN externes (fonts, Chart.js, Lucide) : stale-while-revalidate
  const isCDN =
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('jsdelivr.net') ||
    url.hostname.includes('unpkg.com');

  if (isCDN) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 3. Navigation (HTML) : network-first puis fallback cache (pour offline)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_DYNAMIC).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 4. Assets statiques (notre origine) : cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }
});

// =============================================================
// Stratégies utilitaires
// =============================================================
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      const cache = await caches.open(CACHE_DYNAMIC);
      cache.put(req, copy);
    }
    return res;
  } catch (err) {
    // Pas de réseau, pas de cache : on retourne du vide
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_DYNAMIC);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || networkPromise || new Response('', { status: 504 });
}

// =============================================================
// Messages depuis l'app (ex : forcer update)
// =============================================================
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
