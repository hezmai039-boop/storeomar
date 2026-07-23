/*
 * Atlas service worker — makes the dashboard installable and resilient on
 * mobile without changing any application behaviour.
 *
 * Design constraints (intentional):
 *  - NEVER cache API or auth traffic. Cached order/conversation data would
 *    be a correctness + privacy hazard on a multi-tenant app. We only cache
 *    the static app shell (HTML/JS/CSS/fonts/icons).
 *  - API calls are excluded two ways: cross-origin requests are skipped
 *    outright, and any same-origin path under /v1 (in case the API is ever
 *    reverse-proxied under the web origin) is skipped too.
 *  - Bump CACHE_VERSION on any shell-caching change so old caches are purged
 *    on activate.
 */
const CACHE_VERSION = "atlas-shell-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = ["/", "/offline.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  // Cross-origin (the API on its own host/port) or a same-origin /v1 path.
  return url.origin !== self.location.origin || url.pathname.startsWith("/v1");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never touch POST/PATCH/DELETE
  const url = new URL(request.url);
  if (isApiRequest(url)) return; // let the network handle API/auth as normal

  // Navigations (SPA route loads): network-first, fall back to cached shell,
  // then the offline page. Keeps content fresh online, usable offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("/", copy));
          return resp;
        })
        .catch(async () => (await caches.match("/")) ?? (await caches.match(OFFLINE_URL)))
    );
    return;
  }

  // Static assets (Vite emits content-hashed, immutable filenames):
  // stale-while-revalidate — instant from cache, refreshed in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === "basic") {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached ?? network;
    })
  );
});
