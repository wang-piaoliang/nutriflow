const CACHE_NAME = "nutriflow-pwa-v38";
const APP_SHELL = [
  "./",
  "./nutriflow.html",
  "./manifest.webmanifest",
  "./offline.html",
  "./balanced-diet-pagoda-2022.png",
  "./apple-touch-icon.png",
  "./apple-touch-icon-precomposed.png",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./maskable-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isAppShell = url.origin === self.location.origin && (
    url.pathname.endsWith("/") || url.pathname.endsWith("/nutriflow.html")
  );
  event.respondWith(
    (isAppShell ? fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match("./offline.html")))
      : caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match("./offline.html"));
      }))
  );
});
