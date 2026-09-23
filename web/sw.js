/* Офлайн-режим «Умного Закупа».
 * При первом открытии сохраняет все файлы сервиса в браузере; дальше сервис открывается
 * и считает без интернета. При наличии сети всегда берёт свежую версию (сначала сеть,
 * затем кэш), поэтому обновления данных видны сразу. */
const VERSION = "umny-zakup-v4";
const CORE = ["./", "index.html", "styles.css", "app.js", "engine.js", "coverage.js", "assumptions.js", "data.js", "vendor/xlsx.full.min.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const font = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !font) return;
  // сначала сеть (свежие данные), при её отсутствии — сохранённая копия
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined))),
  );
});
