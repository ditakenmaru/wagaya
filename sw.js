/* 画面のファイルだけを手元に置く。家族のデータは置かない。
 * 開く時は手元の画面をすぐ出し、裏で新しい版を取っておく（次に開いた時に新しい版になる）。
 * index.html と同じ版の app.js / config.js だけを使う（?v= の番号で合わせる。混ざると画面が空になるため）。
 * 版を上げる時：index.html の ?v= と、下の VERSION をそろえて上げる。 */
var VERSION = '66';
var CACHE = 'wagaya-v' + VERSION;
var SHELL = ['./', 'index.html', 'app.js?v=' + VERSION, 'config.js?v=' + VERSION, 'manifest.webmanifest', 'icons/icon-192.png?v=4', 'icons/apple-touch-icon.png?v=4'];
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

/* 通知：届くのは中身のない合図だけ。ログインの控え（同じ端末の Cache Storage）で、何が来たかを聞きに行って出す。
   聞けなかった時も必ず1つは出す（iPhone は通知を出さないと受け取りを止めるため） */
var NOTE_ICON = 'icons/icon-192.png?v=4';
function showNote(title, body, tag, go) {
  return self.registration.showNotification(title, { body: body || '', tag: tag, icon: NOTE_ICON, badge: NOTE_ICON, data: { go: go || '' } });
}
function peekNotes() {
  return caches.open('wagaya-auth').then(function (c) { return c.match('./__auth'); }).then(function (r) { return r ? r.json() : null; }).then(function (a) {
    if (!a || !a.s || !a.g) return null;
    return self.registration.pushManager.getSubscription().then(function (sub) {
      var req = fetch(a.g, { method: 'POST', body: JSON.stringify({ action: 'pushPeek', session: a.s, endpoint: sub ? sub.endpoint : '' }), redirect: 'follow' }).then(function (r) { return r.json(); });
      return Promise.race([req, new Promise(function (ok) { setTimeout(function () { ok(null); }, 20000); })]);
    });
  });
}
self.addEventListener('push', function (e) {
  var plain = function () { return showNote('わが家の今日', '新しいお知らせがあります', 'wagaya-new', ''); };
  e.waitUntil(peekNotes().then(function (r) {
    var items = (r && r.ok && r.items) || [];
    if (!items.length) return plain();
    return Promise.all(items.map(function (x, i) {
      return showNote(x.title, x.body + (i === items.length - 1 && r.more ? '（ほか' + r.more + '件）' : ''), x.id, x.go);
    })).then(function () {   /* アイコンの数字：最後に開いてから来た通知の数（開くと、アプリが「あなたの番」の数に直す） */
      try { if (r.badge && self.navigator.setAppBadge) return self.navigator.setAppBadge(r.badge).catch(function () {}); } catch (err) {}
    });
  }).catch(plain));
});
/* 通知を押したら、アプリを開いて（開いていれば前に出して）その場所へ */
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var go = (e.notification.data && e.notification.data.go) || '';
  var url = new URL('./' + (go ? '?go=' + encodeURIComponent(go) : ''), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) { list[i].postMessage({ type: 'go', go: go }); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
