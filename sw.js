/* VEKTER — service worker: cacher app-skallet så appen fungerer offline
   (og som installert PWA). Bump CACHE ved nye utgivelser. */
const CACHE = "vekter-v1";
const ASSETS = [
  "./", "index.html", "app.js", "manifest.webmanifest",
  "data/nye_sporsmal.js", "data/questions.js", "data/modules.js",
  "data/forklaringer.js", "data/nye_flashcards.js", "data/laerebok.js",
  "vendor/tailwindcss.js",
  "vendor/fonts/inter-400.ttf", "vendor/fonts/inter-600.ttf", "vendor/fonts/inter-700.ttf",
  "vendor/fonts/space-500.ttf", "vendor/fonts/space-600.ttf", "vendor/fonts/space-700.ttf",
  "assets/app-icon.svg", "assets/apple-touch-icon.png", "assets/icon-192.png", "assets/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for app-skallet; nettverk som fallback og oppfrisking.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("index.html"))
    )
  );
});
