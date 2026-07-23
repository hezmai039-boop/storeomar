/*
 * Atlas service worker — v2.
 *
 * IMPORTANT LESSON (why v2 is deliberately minimal): v1 cached the app shell
 * ("/" index.html) and served it as a fallback. On a frequently-redeployed
 * app that is a trap — a cached index.html keeps pointing at hashed asset
 * filenames (index-XXXX.css / .js) that the next deploy deletes, so the page
 * renders with its JS but NO CSS (a broken, unstyled shell) until a hard
 * refresh. v2 fixes that class of bug by NEVER serving a cached HTML shell or
 * caching hashed build assets. It keeps only what's safe:
 *   - installability (manifest + icon are precached),
 *   - a genuine offline fallback page for navigations.
 * Everything else always goes to the network, so a fresh deploy is picked up
 * immediately with matching HTML+CSS+JS. Correctness over offline caching —
 * the right trade-off for an app still shipping daily.
 */
const CACHE_VERSION = "atlas-static-v2";
const OFFLINE_URL = "/offline.html";
// Only self-contained, rarely-changing files — never the hashed app bundles
// and never index.html.
const PRECACHE_URLS = [OFFLINE_URL, "/manifest.webmanifest", "/icon.svg"];

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
  return url.origin !== self.location.origin || url.pathname.startsWith("/v1");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isApiRequest(url)) return; // API/auth always hit the network untouched

  // Navigations: network-first, and the ONLY fallback is the self-contained
  // offline page — never a cached index.html (which could reference deleted
  // assets and render unstyled).
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Precached static files (icon/manifest) can serve from cache; everything
  // else — including hashed JS/CSS — goes straight to the network so HTML and
  // assets always come from the same deploy.
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
