/* Tuesday — offline shell.

   Caches the app's own files so the icon opens without a network. The wardrobe
   lives in IndexedDB and was never online.

   Scope discipline: this worker handles GET requests for this origin and the
   three pinned CDN scripts, and nothing else. Everything else — API calls,
   uploads, anything cross-origin — passes straight through untouched.

   An earlier version intercepted every request, which meant a failed API call
   surfaced as "FetchEvent.respondWith received an error" instead of the actual
   error. A worker that wraps requests it cannot serve turns useful failures
   into useless ones. */

const CACHE = "tuesday-v2";

const CDN = [
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
  "https://unpkg.com/@babel/standalone@7.24.7/babel.min.js",
];

const SHELL = [
  "./",
  "./index.html",
  "./app.jsx",
  "./storage.js",
  "./manifest.webmanifest",
  "./tuesday-icon-180.png",
  "./tuesday-icon-192.png",
  "./tuesday-icon-512.png",
  ...CDN,
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  /* Anything that is not a plain GET is none of this worker's business. */
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isPinnedCdn = CDN.includes(url.href);
  if (!sameOrigin && !isPinnedCdn) return;

  /* App files network-first so an update lands on reload; pinned CDN scripts
     cache-first because they are versioned and never change. */
  const isAppFile =
    sameOrigin &&
    (url.pathname.endsWith("/app.jsx") ||
      url.pathname.endsWith("/index.html") ||
      url.pathname.endsWith("/storage.js") ||
      url.pathname.endsWith("/"));

  if (isAppFile) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});
