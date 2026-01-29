self.addEventListener("fetch", event => {
  const req = event.request;

  // SEMPRE pega HTML da rede
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // outros assets podem continuar cache-first
});
