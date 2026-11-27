/* 共テ Service Worker
   - アプリ本体（同一オリジン）は network-first: 常に最新を取りに行き、
     取れたらキャッシュを更新。オフライン時のみキャッシュを使う
     （旧版 index がキャッシュに張り付いて更新が届かない事故の対策）
   - CDN ライブラリ（pdf.js / MuPDF wasm）は
     cache-first で実行時キャッシュ（オフライン対応・高速化） */
"use strict";

var CACHE_NAME = "kyotei-web-v13";

var PRECACHE_URLS = [
  "./",
  "./index.html",
  "./convert.js",
  "./manifest.webmanifest",
  "./AppIcon1024.png",
  "./icon-512.png",
  "./icon-192.png"
];

var CDN_HOSTS = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  if (url.origin === self.location.origin) {
    /* アプリ本体: network-first */
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      }).catch(function () {
        return caches.match(request, { ignoreSearch: false });
      })
    );
    return;
  }

  if (CDN_HOSTS.indexOf(url.hostname) === -1) return;

  /* CDN: cache-first */
  event.respondWith(
    caches.match(request, { ignoreSearch: false }).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && (response.status === 200 || response.type === "opaque")) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      });
    })
  );
});
