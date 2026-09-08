/* Tuesday — offline shell.

   Caches the app files and the CDN scripts so the icon opens without a
   network. The wardrobe itself lives in IndexedDB and was never online.

   Strategy: network first for app.jsx and index.html so an update is picked
   up as soon as it exists, cache first for everything else because React and
   Babel are pinned to exact versions and never change. */

const CACHE = "tuesday-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.jsx",
  "./storage.js",
  "./manifest.webmanifest",
  "./tuesday-icon-180.png",
  "./tuesday-icon-192.png",
  "./tuesday-icon-512.png",
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
  "https://unpkg.com/@babel/standalone@7.24.7/babel.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((u) => c.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const fresh = url.pathname.endsWith("/app.jsx") ||
                url.pathname.endsWith("/index.html") ||
                url.pathname.endsWith("/");

  if (fresh) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
