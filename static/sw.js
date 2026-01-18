self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// IMPORTANT: never cache /api requests
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Let the browser handle API calls normally (no caching)
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // For everything else: just do a normal fetch (no custom caching)
  event.respondWith(fetch(event.request));
});
