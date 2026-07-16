const CACHE_NAME = 'jmbaches-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/firebase-layer-v3.js',
  '/manifest.json',
];

// Installation — mise en cache des ressources statiques
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activation — nettoyage des anciens caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — stratégie Network First (toujours essayer le réseau d'abord)
// Firestore et Firebase Auth nécessitent le réseau — pas de cache pour eux
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Ne pas intercepter les requêtes Firebase/Google
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('jsdelivr') ||
    url.hostname.includes('fonts.google')
  ) {
    return;
  }

  // Network First pour les fichiers de l'app — {cache:'no-store'} est ESSENTIEL ici : sans lui,
  // ce fetch() peut être satisfait par le cache HTTP du navigateur lui-même (Cache-Control:
  // max-age envoyé par GitHub Pages) au lieu d'aller réellement sur le réseau, ce qui rend
  // "Network First" silencieusement identique à "Cache First" tant que le cache HTTP est frais
  // — cause probable du bug "fiche technique invisible" (119982) jamais élucidé jusqu'ici.
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(response => {
        // Mettre en cache la nouvelle version
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Fallback sur le cache si hors ligne
        return caches.match(e.request);
      })
  );
});
