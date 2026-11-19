/* 画面のファイルだけを手元に置く。家族のデータは置かない。
 * 開く時は手元の画面をすぐ出し、裏で新しい版を取っておく（次に開いた時に新しい版になる）。
 * index.html と同じ版の app.js / config.js だけを使う（?v= の番号で合わせる。混ざると画面が空になるため）。
 * 版を上げる時：index.html の ?v= と、下の VERSION をそろえて上げる。 */
var VERSION = '12';
var CACHE = 'wagaya-v' + VERSION;
var SHELL = ['./', 'index.html', 'app.js?v=' + VERSION, 'config.js?v=' + VERSION, 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE && k.indexOf('wagaya-v') === 0; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  var req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  var page = req.mode === 'navigate';
  e.respondWith(caches.open(CACHE).then(function (ca) {
    var key = page ? 'index.html' : req;
    return ca.match(key, { ignoreSearch: page }).then(function (hit) {
      var net = fetch(req, { cache: 'no-cache' }).then(function (r) { if (r && r.ok) ca.put(key, r.clone()); return r; });
      if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
      return net;
    });
  }));
});
