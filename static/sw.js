/* sw.js — SAFE (no API caching) */

self.addEventListener("install", (event) => {
  // ativa o SW novo imediatamente
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // assume controle das abas imediatamente
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Só intercepta requests do mesmo domínio
  if (url.origin !== self.location.origin) return;

  // ✅ 1) NUNCA cachear API (evita “troca”/vazamento entre usuários)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(new Request(req, { cache: "no-store" })));
    return;
  }

  // ✅ 2) HTML (navegação): sempre tenta rede primeiro; fallback cache
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // ✅ 3) Static assets: cache-first para performance
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;

        return fetch(req).then((res) => {
          // só cacheia resposta OK e same-origin
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open("static-v1").then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // ✅ 4) Default: rede
  event.respondWith(fetch(req));
});
