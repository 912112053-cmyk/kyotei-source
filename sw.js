/* 共テ Service Worker
   - アプリ本体（index.html / manifest / アイコン）はインストール時に先読みキャッシュ
   - CDN ライブラリ（pdf.js / tesseract.js / wasm コア / 日本語学習データ）は
     実行時にキャッシュし、次回からはキャッシュ優先（オフライン対応） */
"use strict";

var CACHE_NAME = "kyotei-web-v1";

var PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./AppIcon1024.png",
  "./icon-512.png",
  "./icon-192.png"
];

/* キャッシュ対象の CDN ホスト（pdf.js, tesseract.js 本体・worker・core(wasm),
   tessdata の言語データを含む） */
var CDN_HOSTS = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "tessdata.projectnaptha.com",
  "raw.githubusercontent.com"
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

function isCacheable(url) {
  if (url.origin === self.location.origin) return true;
  return CDN_HOSTS.indexOf(url.hostname) !== -1;
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (!isCacheable(url)) return;

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
