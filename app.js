/* わが家の今日 — 家族アプリ（画面）
 * 画面は index.html の <template id="tpl"> に書き、ここで描画する。
 * データは GAS（Googleのスプレッドシートとカレンダー）から取る。
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var APP_VERSION = '39';
  var API_EXPECTED = 11;   // GAS の API_VERSION と同じ番号
  var DEMO = /[?&]demo=1/.test(location.search) || !!CFG.demo;
  /* 見本モードは別の名前で保存する（本物のアプリの保存を上書きしない） */
  var LSP = DEMO ? 'demo.' : '';
  var LS = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(LSP + k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(LSP + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(LSP + k); } catch (e) {} }
  };

  /* ---------------- 使われ方（回数だけ。書いた文章は残さない） ---------------- */
  var USAGE = {
    add: function (k, n) {
      if (DEMO) return;
      var u = LS.get('usage') || {}, d = new Date(), day = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
      if (u.date !== day) { USAGE.flush(); u = LS.get('usage') || {}; if (u.date !== day) u = { date: day, counts: {} }; }
      u.counts[k] = (u.counts[k] || 0) + (n || 1);
      LS.set('usage', u);
    },
    /* 送る分には番号を付けて別に取っておき、届くまで同じ番号で送り直す（GASは同じ番号を1回しか数えない） */
    flush: function (keepalive) {
      if (DEMO || !LS.get('session') || USAGE.busy) return;
      var p = LS.get('usagePending');
      if (!p) {
        var u = LS.get('usage');
        if (!u || !u.counts || !Object.keys(u.counts).length) return;
        p = { batch: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), date: u.date, counts: u.counts };
        LS.set('usagePending', p);
        LS.set('usage', { date: u.date, counts: {} });
      }
      USAGE.busy = true;
      api('logUsage', { date: p.date, counts: p.counts, batch: p.batch }, !!keepalive)
        .then(function () { var q = LS.get('usagePending'); if (q && q.batch === p.batch) LS.del('usagePending'); })
        .catch(function () {})
        .then(function () { USAGE.busy = false; });
    }
  };

  /* ---------------- 小さな描画の仕組み ---------------- */
  var EXPR = /\{\{\s*([^}]*?)\s*\}\}/g;
  function parseParts(str) {
    var parts = [], last = 0, m;
    EXPR.lastIndex = 0;
    while ((m = EXPR.exec(str))) {
      if (m.index > last) parts.push({ s: str.slice(last, m.index) });
      parts.push({ e: m[1] });
      last = EXPR.lastIndex;
    }
    if (last < str.length) parts.push({ s: str.slice(last) });
    return parts;
  }
  function exprOf(str) { var p = parseParts(str || ''); return p.length && p[0].e !== undefined ? p[0].e : ''; }
  function lookup(path, scope) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var segs = path.split('.');
    var v = scope[segs[0]];
    for (var i = 1; i < segs.length; i++) { if (v == null) return undefined; v = v[segs[i]]; }
    return v;
  }
  function evalParts(parts, scope) {
    if (parts.length === 1 && parts[0].e !== undefined) return lookup(parts[0].e, scope);
    var s = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.e !== undefined) { var v = lookup(p.e, scope); s += v == null ? '' : v; } else s += p.s;
    }
    return s;
  }
  function compileKids(n) {
    var out = [];
    for (var c = n.firstChild; c; c = c.nextSibling) { var k = compileNode(c); if (k) out.push(k); }
    return out;
  }
  function compileNode(n) {
    if (n.nodeType === 3) {
      if (!n.nodeValue.trim()) return null;
      return { t: 'text', parts: parseParts(n.nodeValue.replace(/\s*\n\s*/g, '')) };
    }
    if (n.nodeType !== 1) return null;
    var tag = n.localName;
    if (tag === 'sc-for') return { t: 'for', list: exprOf(n.getAttribute('list')), as: n.getAttribute('as'), kids: compileKids(n) };
    if (tag === 'sc-if') return { t: 'if', value: exprOf(n.getAttribute('value')), kids: compileKids(n) };
    var attrs = [];
    for (var i = 0; i < n.attributes.length; i++) {
      var a = n.attributes[i];
      if (a.name.indexOf('hint-') === 0) continue;
      attrs.push({ name: a.name, parts: parseParts(a.value) });
    }
    return { t: 'el', tag: tag, ns: n.namespaceURI, attrs: attrs, kids: compileKids(n) };
  }
  function renderNode(k, scope) {
    if (k.t === 'text') { var tv = evalParts(k.parts, scope); return [{ text: tv == null ? '' : String(tv) }]; }
    if (k.t === 'el') {
      return [{ tag: k.tag, ns: k.ns, attrs: k.attrs.map(function (a) { return [a.name, evalParts(a.parts, scope)]; }), slots: k.kids.map(function (c) { return renderNode(c, scope); }) }];
    }
    if (k.t === 'if') return lookup(k.value, scope) ? flat(k.kids, scope) : [];
    if (k.t === 'for') {
      var list = lookup(k.list, scope) || [], out = [];
      for (var i = 0; i < list.length; i++) { var s = Object.create(scope); s[k.as] = list[i]; out.push.apply(out, flat(k.kids, s)); }
      return out;
    }
    return [];
  }
  function flat(kids, scope) { var out = []; for (var i = 0; i < kids.length; i++) out.push.apply(out, renderNode(kids[i], scope)); return out; }

  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var EVT = { onclick: 'click', onchange: 'input', oninput: 'input', onkeydown: 'keydown', oncommit: 'change' };
  var BOOL = { autoplay: 1, muted: 1, loop: 1, playsinline: 1, disabled: 1 };
  function same(node, v) { return v.text !== undefined ? node.nodeType === 3 : (node.nodeType === 1 && node.__tag === v.tag); }
  function create(v) {
    if (v.text !== undefined) return document.createTextNode(v.text);
    var el = v.ns && v.ns !== HTML_NS ? document.createElementNS(v.ns, v.tag) : document.createElement(v.tag);
    el.__tag = v.tag; el.__attrs = {}; el.__slots = v.slots.map(function () { return []; });
    update(el, v);
    return el;
  }
  function update(el, v) {
    if (v.text !== undefined) { if (el.nodeValue !== v.text) el.nodeValue = v.text; return; }
    var old = el.__attrs;
    for (var i = 0; i < v.attrs.length; i++) {
      var name = v.attrs[i][0], val = v.attrs[i][1];
      if (EVT[name]) {
        el['__' + name] = val;
        if (!el['__b' + name]) {
          el['__b' + name] = 1;
          (function (nm) { el.addEventListener(EVT[nm], function (e) { var f = el['__' + nm]; if (typeof f === 'function') f(e); }); })(name);
        }
        continue;
      }
      if (name === 'value') { var sv = val == null ? '' : String(val); if (el.value !== sv) el.value = sv; continue; }
      if (typeof val === 'boolean' && name.indexOf('aria-') === 0) val = String(val);
      if (old[name] === val) continue;
      old[name] = val;
      if (BOOL[name]) { if (val && val !== 'false') { el.setAttribute(name, ''); if (name === 'muted') el.muted = true; } else el.removeAttribute(name); continue; }
      if (val == null || val === false) el.removeAttribute(name); else el.setAttribute(name, String(val));
    }
    patchSlots(el, v.slots);
  }
  function patchSlots(parent, newSlots) {
    var slots = parent.__slots, anchor = null;
    /* 同じ種類の要素を別の中身に使い回した時、余った子要素を消す（残ると前の画面の部品が混ざる） */
    for (var x = newSlots.length; x < slots.length; x++) {
      (slots[x] || []).forEach(function (n) { if (n.parentNode === parent) parent.removeChild(n); });
    }
    slots.length = Math.min(slots.length, newSlots.length);
    for (var i = newSlots.length - 1; i >= 0; i--) {
      slots[i] = patchList(parent, slots[i] || [], newSlots[i], anchor);
      if (slots[i].length) anchor = slots[i][0];
    }
  }
  function patchList(parent, olds, vs, anchor) {
    var out = [];
    for (var j = 0; j < vs.length; j++) {
      var v = vs[j], o = olds[j];
      if (o && same(o, v)) { update(o, v); out.push(o); }
      else { var n = create(v); if (o) parent.replaceChild(n, o); else parent.insertBefore(n, anchor); out.push(n); }
    }
    for (var k = vs.length; k < olds.length; k++) if (olds[k].parentNode === parent) parent.removeChild(olds[k]);
    return out;
  }

  function DCLogic() { this.state = {}; }
  DCLogic.prototype.setState = function (u) {
    this.state = Object.assign({}, this.state, typeof u === 'function' ? u(this.state) : u);
    scheduleRender();
  };

  var root, compiled, comp, queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () { queued = false; render(); });
  }
  function render() {
    var vals = comp.renderVals();
    patchSlots(root, compiled.map(function (k) { return renderNode(k, vals); }));
  }

  /* ---------------- 通信（GAS） ---------------- */
  function api(action, payload, keepalive) {
    payload = Object.assign({ action: action, session: LS.get('session') }, payload || {});
    if (DEMO) return demoApi(payload);
    if (!CFG.gasUrl) return Promise.reject({ code: 'not_configured' });
    return fetch(CFG.gasUrl, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow', keepalive: !!keepalive })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (!res || !res.ok) throw res || { code: 'bad_response' }; return res; })
      .catch(function (err) { if (action !== 'logUsage') USAGE.add('err:' + String((err && err.code) || 'network').replace(/[^\w]/g, '').slice(0, 30)); throw err; });
  }

  /* ログインの控え：localStorage だけが消える時に備え、同じ端末の Cache Storage にも置く（ほかの場所には出さない）。
     ログアウトで消す。DEMO では使わない */
  var AUTH = {
    key: 'auth', cache: 'wagaya-auth',
    save: function (session, email) {
      if (DEMO || !window.caches || !session) return;
      try { caches.open(this.cache).then(function (c) { return c.put(new Request('./__auth'), new Response(JSON.stringify({ s: session, e: email || '', t: Date.now() }))); }).catch(function () {}); } catch (e) {}
    },
    load: function () {
      if (DEMO || !window.caches) return Promise.resolve(null);
      try { return caches.open(this.cache).then(function (c) { return c.match('./__auth'); }).then(function (r) { return r ? r.json() : null; }).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
    },
    clear: function () { try { if (window.caches) caches.delete(this.cache); } catch (e) {} }
  };

  /* 新しい版があるか確かめる（ホーム画面のアプリは、戻ってきただけでは読み直さないため）。
     新しい版が入ると controllerchange で、入力中でなければ読み直す */
  function checkUpdate() {
    try { if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {}); } catch (e) {}
  }

  /* ---------------- 日付の道具 ---------------- */
  var DOWS = ['日', '月', '火', '水', '木', '金', '土'];
  function pad(n) { return ('0' + n).slice(-2); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  /* くり返しの言い方：「火金」→「毎週 火・金」、1日だけなら「毎週 木曜」 */
  function ruleWords(r) {
    r = String(r || '毎日');
    if (r === '毎日' || r === '平日' || r === '土日' || r === '週末') return r;
    var ds = r.split('').filter(function (c) { return DOWS.indexOf(c) >= 0; });
    if (!ds.length) return r;
    return '毎週 ' + (ds.length === 1 ? ds[0] + '曜' : ds.join('・'));
  }
  function hm(m) { return m == null ? 'いつでも' : Math.floor(m / 60) + ':' + pad(m % 60); }
  function whenLabel(ms) {
    var d = new Date(ms), now = new Date();
    var day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var t = d.getHours() + ':' + pad(d.getMinutes());
    if (d >= day0) return '今日 ' + t;
    if (d >= new Date(day0 - 864e5)) return '昨日 ' + t;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + t;
  }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  /* ウィキペディアの写真の表示：作者 / ライセンス / Wikimedia Commons（ライセンスの条件どおり） */
  function creditText(c) {
    c = c || {};
    return ['写真：' + (c.artist || '作者不明'), c.license || '', 'Wikimedia Commons'].filter(function (x) { return x; }).join(' / ');
  }
  function pexels(id, w) { return 'https://images.pexels.com/photos/' + id + '/pexels-photo-' + id + '.jpeg?auto=compress&cs=tinysrgb&w=' + (w || 900); }
  var MOOD = [5728162, 4262172, 29144275, 6646360];

  /* ---------------- 画面のロジック ---------------- */
  function App() {
    DCLogic.call(this);
    var cached = LS.get('boot');
    this.state = {
      who: LS.get('who') || 'all', day: null, dayAnim: 0, hideBought: false, now: Date.now(), toast: null, sheet: false,
      loading: !cached, data: cached, photos: [],
      slideIdx: 0, slideAt: Date.now(), paused: false,
      noteOpen: false, noteMode: 'diary', noteTarget: '', noteTaskId: null, noteDraft: '', listening: false,
      notesOpen: false, draft: '', draftTo: null,
      mounted: {}, seen: {}, goal: 'all', goalAnim: 0, newsOpen: {},
      needLogin: !DEMO && !LS.get('session'), loginError: '', loggingIn: false,
      accountOpen: false, syncing: false, lastSync: cached ? cached._at : 0, offline: false,
      flowEdit: false, shopEdit: false, editor: null, shopDraft: '', shopQty: '', shopCat: null,
      fbOpen: false, fbDraft: '', museOpen: false, museDraft: '', detail: null, replyDraft: '', topicEdit: false, nav: null, expanded: {}, homeStyle: LS.get('homeStyle') || 'a'
    };
    this.lazyIds = ['diary', 'week', 'shop', 'plan', 'news'];
  }
  App.prototype = Object.create(DCLogic.prototype);

  App.prototype.componentDidMount = function () {
    var self = this;
    USAGE.add('open:app');
    setInterval(function () { USAGE.flush(); }, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { USAGE.flush(true); self.seeAll(); } else USAGE.add('open:app'); });
    /* どのセクションが見られたか（開くたびに1回ずつ） */
    this.secSeen = {};
    var watch = function () {
      if (typeof IntersectionObserver === 'undefined') return;
      if (!self.secIO) self.secIO = new IntersectionObserver(function (es) {
        es.forEach(function (e) { var k = e.target.getAttribute('data-sec'); if (e.isIntersecting && k && !self.secSeen[k]) { self.secSeen[k] = 1; USAGE.add('sec:' + k); } });
      }, { threshold: 0.35 });
      document.querySelectorAll('[data-sec]').forEach(function (el) { if (!el.__watched) { el.__watched = 1; self.secIO.observe(el); } });
    };
    setInterval(watch, 2000); setTimeout(watch, 300);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') self.secSeen = {}; });
    /* 画面の描き直しは「分が変わった時」と「写真を送る時」だけ（毎秒は描かない） */
    this.timer = setInterval(function () {
      var s = self.state, upd = null;
      if (Math.floor(Date.now() / 60000) !== Math.floor(s.now / 60000)) upd = { now: Date.now() };
      var n = self.order().length;
      if (n && self.showPhotos() && !s.paused && !s.loading && (Date.now() - s.slideAt) / 1000 >= self.slideDur(s.slideIdx)) { upd = upd || {}; upd.slideIdx = s.slideIdx + 1; upd.slideAt = Date.now(); }
      if (upd) self.setState(upd);
    }, 1000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { self.setState({ now: Date.now() }); self.refresh(true); checkUpdate(); } });
    /* 開いている間は15秒ごとに「変わったか」だけ確かめ、変わった時だけ読み直す（Museや相手の書き込みがすぐ出る）。
       予定（カレンダー）などシートの外のものもあるので、5分ごとには必ず読み直す */
    this.poll = setInterval(function () { if (document.visibilityState === 'visible') self.pollVer(); }, 15000);
    this.handleRedirect().then(function () { return self.restoreLogin(); }).then(function () { if (!self.state.needLogin) self.refresh(!!self.state.data); });
    if (this.state.data) { setTimeout(function () { self.attachLazy(); }, 60); this.loadPhotos(this.state.data.photos); }
    this.setupPull();
  };

  /* 画面を下に引っぱって更新（いちばん上にいる時だけ） */
  App.prototype.setupPull = function () {
    var self = this, el = document.getElementById('ptr');
    if (!el) return;
    var label = el.querySelector('span'), y0 = null, dist = 0, TH = 70;
    var show = function (d, txt, spin) {
      el.style.transform = 'translate(-50%, ' + Math.min(d, 90) + 'px)';
      el.style.opacity = d > 8 ? String(Math.min(1, d / TH)) : '0';
      el.classList.toggle('spin', !!spin);
      if (txt) label.textContent = txt;
    };
    var blocked = function () { var s = self.state; return s.needLogin || s.noteOpen || s.notesOpen || s.sheet || s.accountOpen || s.editor || s.fbOpen || s.museOpen || s.detail; };
    document.addEventListener('touchstart', function (e) {
      y0 = (window.scrollY <= 0 && e.touches.length === 1 && !blocked() && !self.pulling) ? e.touches[0].clientY : null;
      dist = 0; el.style.transition = 'none';
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (y0 === null) return;
      if (window.scrollY > 0) { y0 = null; show(0); return; }
      dist = Math.max(0, (e.touches[0].clientY - y0) * 0.5);
      show(dist, dist >= TH ? '離すと更新' : '引っぱって更新');
    }, { passive: true });
    document.addEventListener('touchend', function () {
      if (y0 === null) return;
      y0 = null; el.style.transition = 'transform .25s, opacity .25s';
      if (dist < TH) { show(0); return; }
      self.pulling = true;
      show(56, '更新しています…', true);
      var t0 = Date.now();
      checkUpdate();
      self.refresh(false, true).then(function (ok) {
        setTimeout(function () {
          show(56, ok ? '新しくしました' : '更新できませんでした', false);
          setTimeout(function () { self.pulling = false; show(0); }, 700);
        }, Math.max(0, 400 - (Date.now() - t0)));
      });
    }, { passive: true });
  };

  /* ログイン：Googleの画面へ移動し、戻ってきたらGASで確かめる */
  /* silent：Googleの画面を出さずに確かめる（prompt=none）。だめならログインの画面に戻る */
  App.prototype.login = function (silent) {
    if (!CFG.clientId) { this.setState({ loginError: 'ログインの設定（クライアントID）がまだです。config.js を確かめてください。' }); return; }
    var nonce = uid('n'), hint = LS.get('hint');
    LS.set('nonce', nonce);
    if (silent === true) LS.set('silent', 1); else LS.del('silent');
    var redirect = location.origin + location.pathname;
    var q = 'client_id=' + encodeURIComponent(CFG.clientId) + '&redirect_uri=' + encodeURIComponent(redirect) +
      '&response_type=id_token&scope=' + encodeURIComponent('openid email') + '&nonce=' + encodeURIComponent(nonce) +
      (silent === true ? '&prompt=none' : '&prompt=select_account') + (hint ? '&login_hint=' + encodeURIComponent(hint) : '');
    this.setState({ loggingIn: true });
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
  };
  /* ログインが手元から消えていたら：①同じ端末の控えから戻す ②Googleにまだログインしていれば、画面を出さずに入り直す（1回だけ）。
     どちらでもだめならログインの画面。何が起きたかは「使われ方」に回数だけ残す（原因を調べるため） */
  App.prototype.restoreLogin = function () {
    var self = this;
    if (DEMO || LS.get('session') || LS.get('loggedOut') || /id_token=|error=/.test(location.hash)) return Promise.resolve();
    return AUTH.load().then(function (b) {
      var photosLeft = window.caches ? caches.has('wagaya-photos') : Promise.resolve(false);
      return photosLeft.then(function (hasPhotos) {
        USAGE.add('diag:lost_' + (b ? 'ls_only' : (hasPhotos ? 'ls_and_auth' : 'all')));
        if (b && b.s) {
          LS.set('session', b.s); if (b.e) LS.set('hint', b.e);
          USAGE.add('diag:restored');
          self.setState({ needLogin: false });
          return;
        }
        var tried = false; try { tried = sessionStorage.getItem('silentTried') === '1'; } catch (e) {}
        if (!tried && !self.redirected && navigator.onLine !== false) { try { sessionStorage.setItem('silentTried', '1'); } catch (e) {} self.login(true); }
      });
    });
  };
  App.prototype.handleRedirect = function () {
    var self = this;
    var h = location.hash.replace(/^#/, '');
    if (!/id_token=|error=/.test(h)) return Promise.resolve();
    this.redirected = true;   // Googleから戻った直後は、自動で入り直さない
    var p = {};
    h.split('&').forEach(function (kv) { var i = kv.indexOf('='); p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); });
    history.replaceState(null, '', location.pathname + location.search);
    var wasSilent = !!LS.get('silent'); LS.del('silent');
    if (p.error) {
      USAGE.add('diag:' + (wasSilent ? 'silent_ng' : 'login_error'));
      this.setState({ needLogin: true, loggingIn: false, loginError: wasSilent ? '' : 'ログインできませんでした（' + p.error + '）。もう一度お試しください。' });
      return Promise.resolve();
    }
    this.setState({ loggingIn: true });
    return api('login', { idToken: p.id_token, nonce: LS.get('nonce') }).then(function (res) {
      LS.set('session', res.session); LS.del('nonce'); LS.del('loggedOut');
      if (res.me && res.me.email) LS.set('hint', res.me.email);
      AUTH.save(res.session, res.me && res.me.email);
      USAGE.add('diag:' + (wasSilent ? 'silent_ok' : 'login_ok'));
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(function (g) { USAGE.add('diag:persist_' + (g ? 'yes' : 'no')); }); } catch (e) {}
      self.setState({ needLogin: false, loginError: '', loggingIn: false });
    }).catch(function (err) {
      var msg = err && err.code === 'not_allowed' ? 'このアカウントは登録されていません。家族のGoogleアカウントでログインしてください。' : 'ログインを確かめられませんでした。時間をおいてもう一度お試しください。';
      self.setState({ needLogin: true, loginError: msg, loggingIn: false });
    });
  };
  App.prototype.logout = function () {
    var self = this;
    USAGE.flush();
    api('logout', {}).catch(function () {});
    AUTH.clear(); LS.set('loggedOut', 1); LS.del('hint');
    LS.del('session'); LS.del('boot'); LS.del('seen'); LS.del('seenPending'); LS.del('usage'); LS.del('usagePending'); LS.del('orderPlain');
    try { if (window.caches) caches.delete('wagaya-photos'); } catch (e) {}
    this.photoKey = null;
    self.setState({ needLogin: true, accountOpen: false, data: null, loading: true, photos: [] });
  };

  /* データの読み込み（キャッシュをすぐ出して、裏で新しくする） */
  /* quiet：右上に「更新中」を出さない。fresh：GAS側のまとめを使わず、シートから読み直す */
  App.prototype.refresh = function (quiet, fresh) {
    var self = this;
    if (this.state.needLogin || this.pending > 0) return Promise.resolve(false);
    if (this.inflight) return fresh ? this.inflight.then(function () { return self.refresh(quiet, true); }) : this.inflight;
    if (!quiet) this.setState({ syncing: true });
    var seq0 = this.writeSeq || 0;
    this.inflight = api('boot', { today: ymd(new Date()), fresh: !!fresh }).then(function (res) {
      /* 読み込みの間に書き込みがあったら、この結果は古いので捨て、書き込みが終わってから読み直す */
      if ((self.writeSeq || 0) !== seq0 || self.pending > 0) { self.setState({ syncing: false }); self.afterWrites = true; return true; }
      var data = res.data; data._at = Date.now();
      if (!self.authSaved && data.me) { self.authSaved = true; AUTH.save(LS.get('session'), data.me.email); if (data.me.email) LS.set('hint', data.me.email); }
      if (!DEMO && data.api !== API_EXPECTED && !self.apiWarned) { self.apiWarned = true; setTimeout(function () { self.showToast('Google側の更新がまだのようです（版のずれ）。アプリを管理している人に伝えてください', null); }, 800); }
      LS.set('boot', data);
      var first = !self.state.data;
      self.setState({ data: data, loading: false, syncing: false, lastSync: data._at, offline: false });
      self.trackMarks(data);
      if (first) setTimeout(function () { self.attachLazy(); }, 60);
      self.loadPhotos(data.photos);
      return true;
    }).catch(function (err) {
      if (err && (err.code === 'no_session' || err.code === 'not_allowed')) { AUTH.clear(); LS.del('session'); self.setState({ needLogin: true, syncing: false }); return false; }
      self.setState({ syncing: false, offline: true });
      if (!quiet) self.showToast(err && err.code === 'not_configured' ? 'つなぎ先（GASのURL）の設定がまだです' : '新しいデータを取れませんでした。通信を確かめてください', null);
      return false;
    }).then(function (ok) { self.inflight = null; return ok; });
    return this.inflight;
  };
  App.prototype.pollVer = function () {
    var self = this, D = this.state.data;
    if (DEMO || this.state.needLogin || this.pending > 0 || this.inflight || this.verBusy) return;
    if (!D || !D.v || Date.now() - (D._at || 0) > 5 * 60000) { if (!D || D.v || Date.now() - (D._at || 0) > 60000) this.refresh(true); return; }
    this.verBusy = true;
    fetch(CFG.gasUrl, { method: 'POST', body: JSON.stringify({ action: 'ver', session: LS.get('session') }), redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (res && res.ok && res.v && self.state.data && res.v !== self.state.data.v) self.refresh(true); })
      .catch(function () {})
      .then(function () { self.verBusy = false; });
  };
  /* 写真と動画：一覧はbootで受け取る。1コマ目（写真・動画のサムネイル）を1回の通信でまとめて取り、
   * 動画の中身はそのあと1本ずつ取る。どれも端末に保存し、2回目からはすぐ出る */
  App.prototype.loadPhotos = function (list) {
    var self = this;
    list = (list || []).slice(0, 10);
    var key = list.map(function (p) { return p.id + p.v; }).join('|');
    if (key === this.photoKey) return;
    this.photoKey = key;
    var slots = list.map(function () { return null; });
    var publish = function () { self.setState({ photos: slots.filter(Boolean) }); };
    var cacheP = (window.caches && window.isSecureContext) ? caches.open('wagaya-photos').catch(function () { return null; }) : Promise.resolve(null);
    var url = function (p) { return location.origin + '/__photo/' + p.id + '?v=' + encodeURIComponent(p.v || ''); };
    var vurl = function (p) { return location.origin + '/__video/' + p.id + '?v=' + encodeURIComponent(p.v || ''); };
    var base = function (i) { var p = list[i]; return slots[i] || { id: p.id, video: !!p.video, big: !!p.big, pos: 'center 30%' }; };
    var show = function (i, blob) { slots[i] = Object.assign({}, base(i), { src: URL.createObjectURL(blob) }); publish(); };
    var play = function (i, blob) { slots[i] = Object.assign({}, base(i), { vsrc: URL.createObjectURL(blob) }); publish(); };
    cacheP.then(function (cache) {
      /* 1) 端末に保存してある1コマ目はすぐ出す */
      return Promise.all(list.map(function (p, i) {
        return (cache ? cache.match(url(p)) : Promise.resolve(null)).then(function (hit) { return hit ? hit.blob().then(function (b) { show(i, b); return true; }) : false; }).catch(function () { return false; });
      })).then(function (have) {
        /* 2) 足りない1コマ目だけ、1回の通信でまとめて取る */
        var missing = list.filter(function (_, i) { return !have[i]; });
        if (!missing.length || self.state.needLogin) return;
        return api('photosBatch', { ids: missing.map(function (p) { return p.id; }) }).then(function (res) {
          return Promise.all(list.map(function (p, i) {
            var src = res.photos && res.photos[p.id];
            if (have[i] || !src) return null;
            return fetch(src).then(function (r) { return r.blob(); }).then(function (blob) {
              show(i, blob);
              if (cache) return cache.put(url(p), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } })).catch(function () {});
            });
          }));
        }).catch(function () {});
      }).then(function () {
        /* 3) 動画の中身を1本ずつ（大きすぎる動画は1コマだけ） */
        return list.reduce(function (chain, p, i) {
          if (!p.video || p.big) return chain;
          return chain.then(function () {
            return (cache ? cache.match(vurl(p)) : Promise.resolve(null)).then(function (hit) {
              if (hit) return hit.blob().then(function (b) { play(i, b); });
              if (self.state.needLogin) return;
              return api('video', { id: p.id }).then(function (res) {
                var bin = atob(res.data), arr = new Uint8Array(bin.length);
                for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
                var blob = new Blob([arr], { type: res.type || 'video/mp4' });
                play(i, blob);
                if (cache) return cache.put(vurl(p), new Response(blob, { headers: { 'Content-Type': blob.type } })).catch(function () {});
              });
            }).catch(function () {});
          });
        }, Promise.resolve());
      }).then(function () {
        if (!cache) return;
        var keep = {}; list.forEach(function (p) { keep[url(p)] = 1; keep[vurl(p)] = 1; });
        return cache.keys().then(function (reqs) { reqs.forEach(function (r) { if (!keep[r.url]) cache.delete(r); }); });
      }).catch(function () {});
    });
  };

  /* 新しくなったところ：前に見た時の中身（端末に保存）と比べて、相手が足した・変えたものに印を付ける。
     自分の書き込みは印にしない。アプリを閉じた時に「見た」にする */
  function sigsOf(D) {
    var m = {};
    if (!D) return m;
    var rc = {}; (D.replies || []).forEach(function (r) { rc[r.target] = (rc[r.target] || 0) + 1; });
    var withR = function (k, v) { m[k] = v + (rc[k] ? '#r' + rc[k] : ''); };
    (D.dutiesAll || []).forEach(function (x) { m['flow:' + x.id] = [x.task, x.t, x.who, x.rule, x.date].join('|'); });
    (D.decisions || []).forEach(function (x) { withR('decide:' + x.id, [x.q, x.a1, x.a2, x.state, x.note, x.due].join('|')); });
    (D.deadlines || []).forEach(function (x) { m['deadline:' + x.id] = [x.what, x.due, x.who, x.note].join('|'); });
    (D.topics || []).forEach(function (x) { withR('topics:' + x.id, [x.title, x.url, x.note].join('|')); });
    (D.diary || []).forEach(function (x) { withR('diary:' + x.id, x.text); });
    (D.outings || []).forEach(function (x) { withR('weekend:' + x.id, [x.name, x.like1, x.like2, x.state, x.go].join('|')); });
    /* 申し送りは返信が付いた時だけ（確認の有無は別の印で出す） */
    (D.notes || []).forEach(function (x) { var k = 'notes:' + x.id; if (rc[k]) m[k] = '#r' + rc[k]; });
    ((D.shop && D.shop.groups) || []).forEach(function (g) { (g.items || []).forEach(function (it) { m['shop:' + it[0]] = [it[1], it[2]].join('|'); }); });
    return m;
  }
  App.prototype.trackMarks = function (data) {
    this.commitSeen(false);
    var cur = sigsOf(data), seen = LS.get('seen'), own = this.ownKeys || {};
    if (!seen) { LS.set('seen', cur); return; }
    var marks = Object.assign({}, this.state.marks || {});
    Object.keys(cur).forEach(function (k) {
      if (cur[k] === seen[k]) return;
      if (own[k]) seen[k] = cur[k]; else marks[k] = 1;
    });
    Object.keys(seen).forEach(function (k) { if (!(k in cur)) delete seen[k]; });
    Object.keys(marks).forEach(function (k) { if (!(k in cur)) delete marks[k]; });
    this.ownKeys = {};
    LS.set('seen', seen);
    this.setState({ marks: marks });
  };
  /* アプリを閉じた時は「見た」の候補として取っておき、15分以上たってから開いた時に確定する
     （子どもを抱っこしてちょっと閉じただけで新着が消えないように） */
  App.prototype.seeAll = function () {
    if (this.reloading) return;   /* 新しい版への読み直しでは「見た」にしない */
    if (this.state.data) LS.set('seenPending', { at: Date.now(), sigs: sigsOf(this.state.data) });
  };
  App.prototype.commitSeen = function (force) {
    var p = LS.get('seenPending');
    if (!p || (!force && Date.now() - p.at < 15 * 60 * 1000)) return false;
    var seen = LS.get('seen') || {};
    Object.keys(p.sigs).forEach(function (k) { seen[k] = p.sigs[k]; });
    LS.set('seen', seen); LS.del('seenPending');
    var marks = Object.assign({}, this.state.marks || {});
    Object.keys(marks).forEach(function (k) { if (p.sigs[k] !== undefined && seen[k] === p.sigs[k]) delete marks[k]; });
    this.setState({ marks: marks });
    return true;
  };

  /* 書き込み：先に画面を変え、失敗したら戻す */
  App.prototype.mutate = function (fn) {
    var d = JSON.parse(JSON.stringify(this.state.data || {}));
    var before = sigsOf(d);
    fn(d);
    var after = sigsOf(d), own = this.ownKeys = this.ownKeys || {}, marks = this.state.marks;
    Object.keys(after).concat(Object.keys(before)).forEach(function (k) { if (before[k] !== after[k]) { own[k] = 1; if (marks && marks[k]) delete marks[k]; } });
    LS.set('boot', d);
    this.setState({ data: d });
  };
  /* 書き込みは1本の列に並べ、前の結果を待ってから次を送る（順番が入れ替わると、取り消しが先に届いて消えるなどが起きる） */
  App.prototype.send = function (action, payload, revert) {
    var self = this;
    this.pending = (this.pending || 0) + 1;
    this.writeSeq = (this.writeSeq || 0) + 1;
    USAGE.add('act:' + action);
    var run = function () {
      return api(action, payload).then(function (r) { return r; }).catch(function (err) {
        if (err && err.code === 'no_session') { AUTH.clear(); LS.del('session'); self.setState({ needLogin: true }); return; }
        if (revert) revert();
        var why = { not_agreed: '2人の答えがそろっていないので、まだ決まりにできません', not_both: '2人とも「行きたい」を押すと、行く日を決められます', already_decided: 'もう決まった相談です。変える時は「相談に戻す」を押してください' }[err && err.code];
        self.showToast(why || '保存できませんでした。通信を確かめて、もう一度お試しください', null);
      });
    };
    var p = (this.writeQ || Promise.resolve()).then(run, run);
    this.writeQ = p.then(function () {
      self.pending -= 1;
      if (self.pending === 0 && self.afterWrites) { self.afterWrites = false; self.refresh(true); }
    });
    return p;
  };
  /* 前の日のデータを出したまま書かない（朝いちばんのチェックが前日に入らないように） */
  App.prototype.stale = function () {
    var d = this.state.data;
    if (DEMO || !d || !d.today || d.today === ymd(new Date())) return false;
    this.showToast('今日のデータを読み込んでいます。少し待ってからもう一度押してください', null);
    this.refresh(false);
    return true;
  };

  App.prototype.markLazy = function (key, id) {
    if (this.state[key][id]) return;
    var n = Object.assign({}, this.state[key]); n[id] = true;
    var upd = {}; upd[key] = n;
    if (key === 'seen' && !this.state.mounted[id]) { var m = Object.assign({}, this.state.mounted); m[id] = true; upd.mounted = m; }
    this.setState(upd);
  };
  App.prototype.attachLazy = function () {
    var self = this;
    if (this.ioNear) return;
    var els = this.lazyIds.map(function (id) { return document.getElementById('w-' + id); });
    if (typeof IntersectionObserver === 'undefined' || els.some(function (el) { return !el; })) {
      if (els.some(function (el) { return !el; }) && !this.lazyRetry) { this.lazyRetry = setTimeout(function () { self.lazyRetry = null; self.attachLazy(); }, 300); return; }
      var all = {}; this.lazyIds.forEach(function (id) { all[id] = true; });
      this.setState({ mounted: all, seen: Object.assign({}, all) });
      return;
    }
    this.ioNear = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { self.markLazy('mounted', e.target.id.slice(2)); self.ioNear.unobserve(e.target); } });
    }, { rootMargin: '0px 0px 600px 0px' });
    this.ioSeen = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { self.markLazy('seen', e.target.id.slice(2)); self.ioSeen.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -10% 0px' });
    els.forEach(function (el) { self.ioNear.observe(el); self.ioSeen.observe(el); });
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 200); };
    var step = function () {
      var next = self.lazyIds.filter(function (id) { return !self.state.mounted[id]; })[0];
      if (!next) return;
      idle(function () { self.markLazy('mounted', next); self.prefetchTimer = setTimeout(step, 1200); });
    };
    this.prefetchTimer = setTimeout(step, 2000);
  };
  App.prototype.showToast = function (msg, undo) {
    var self = this;
    clearTimeout(this.toastTimer);
    this.setState({ toast: { msg: msg, undo: undo } });
    this.toastTimer = setTimeout(function () { self.setState({ toast: null }); }, 3500);
  };

  /* 下のタブ（画面を切り替える）。どのセクションをどのタブに出すかは「画面」シートの「下のタブ」で変えられる */
  var TAB_ORDER = ['今日', 'ふたりで', 'ごはん', '予定', 'ニュース'];
  var TAB_LABEL = { '今日': 'ホーム', 'ふたりで': '相談・連絡' };   /* 最初のタブはホーム（全部を少しずつ）。「ふたりで」は中身（相談・申し送り・期限）が分かる名前で出す。シート上の名前はそのまま */
  var TAB_ID = { '今日': 'today', 'ふたりで': 'two', 'ごはん': 'food', '予定': 'plan', 'ニュース': 'news' };
  /* ホーム以外のタブでは、そのタブの主役から決まった順で並べる（時刻の並びはホームだけ） */
  var TAB_SEQ = { two: ['decide', 'deadline'], food: ['week', 'shop'], plan: ['plan', 'weekend', 'topics'], news: ['news'] };
  var DEF_TAB = { photos: '今日', hero: '今日', flow: '今日', diary: '今日', decide: 'ふたりで', deadline: 'ふたりで', week: 'ごはん', shop: 'ごはん', topics: '予定', weekend: '予定', plan: '予定', news: 'ニュース' };

  /* 2人の呼び名と色は、スプレッドシートの「設定」から届く */
  var DEFAULT_PEOPLE = [{ name: 'とと', ink: '#3046A6' }, { name: 'まま', ink: '#A3355D' }];
  App.prototype.people = function () { var d = this.state.data; return (d && d.people && d.people.length) ? d.people : DEFAULT_PEOPLE; };
  App.prototype.names = function () { return this.people().map(function (p) { return p.name; }); };
  App.prototype.ui = function () { var d = this.state.data; return (d && d.ui) || {}; };
  App.prototype.meWho = function () { var d = this.state.data; return d && d.me ? d.me.who : this.names()[0]; };
  App.prototype.otherWho = function () { var me = this.meWho(), n = this.names(); return n[0] === me ? n[1] : n[0]; };
  App.prototype.showPhotos = function () {
    var secs = this.ui().sections, all = this.state.who === 'all';
    if (!secs) return all;
    var p = secs.filter(function (s) { return s.key === 'photos'; })[0];
    return p ? (all ? p.all : p.person) : all;
  };
  App.prototype.openNoteFor = function (target, taskId, mode, to) {
    var upd = { noteOpen: true, noteMode: mode || 'diary', noteTarget: target, noteTaskId: taskId, noteDraft: '' };
    if (mode === 'handover') upd.draftTo = to && to !== this.meWho() && to !== '家族' ? to : this.otherWho();
    this.setState(upd);
  };
  App.prototype.closeNote = function () {
    try { if (this.rec) this.rec.stop(); } catch (e) {}
    this.setState({ noteOpen: false, listening: false });
  };
  App.prototype.toggleMic = function () {
    var self = this;
    if (this.state.listening) { try { if (this.rec) this.rec.stop(); } catch (e) {} this.setState({ listening: false }); return; }
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.showToast('この画面では音声入力が使えません。キーボードのマイクで話してください', null); return; }
    try {
      var rec = new SR();
      rec.lang = 'ja-JP'; rec.interimResults = true; rec.continuous = false;
      var base = this.state.noteDraft ? this.state.noteDraft + ' ' : '';
      rec.onresult = function (e) { var t = ''; for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; self.setState({ noteDraft: base + t }); };
      rec.onerror = function () { self.setState({ listening: false }); self.showToast('マイクが使えませんでした。キーボードのマイクで話してください', null); };
      rec.onend = function () { self.setState({ listening: false }); };
      this.rec = rec; rec.start();
      this.setState({ listening: true });
    } catch (e) {
      this.setState({ listening: false });
      this.showToast('マイクが使えませんでした。キーボードのマイクで話してください', null);
    }
  };
  App.prototype.addNote = function (to, text, taskId, task) {
    var self = this;
    var note = { id: uid('n'), createdAt: Date.now(), from: this.meWho(), to: to, taskId: taskId || '', task: task || '', text: text, read: false };
    this.mutate(function (d) { d.notes = [note].concat(d.notes || []); });
    var revert = function () { self.mutate(function (d) { d.notes = (d.notes || []).filter(function (x) { return x.id !== note.id; }); }); };
    this.send('addNote', { note: note }, revert);
    this.showToast(to + 'に申し送りを送りました', function () { revert(); self.send('deleteNote', { id: note.id }); self.setState({ toast: null }); });
  };
  App.prototype.saveNote = function () {
    var self = this;
    var text = (this.state.noteDraft || '').trim();
    var handover = this.state.noteMode === 'handover';
    if (!text) { this.showToast(handover ? '申し送りの内容を入力してください' : '気づきの内容を入力してください', null); return; }
    try { if (this.rec) this.rec.stop(); } catch (e) {}
    this.setState({ noteOpen: false, noteDraft: '', listening: false });
    if (handover) { this.addNote(this.state.draftTo || this.otherWho(), text, this.state.noteTaskId, this.state.noteTarget); return; }
    var d0 = new Date();
    var k = { id: uid('k'), date: ymd(d0), time: d0.getHours() + ':' + pad(d0.getMinutes()), by: this.meWho(), text: text, target: this.state.noteTarget || '今日の日記' };
    this.mutate(function (d) { d.diary = (d.diary || []).concat([k]); });
    var revert = function () { self.mutate(function (d) { d.diary = (d.diary || []).filter(function (x) { return x.id !== k.id; }); }); };
    this.send('addDiary', { entry: k }, revert);
    this.showToast('気づきを今日の日記に残しました', function () { revert(); self.send('deleteDiary', { id: k.id }); self.setState({ toast: null }); });
  };
  App.prototype.setDone = function (d0, val) {
    if (this.stale()) return;
    var self = this;
    this.mutate(function (d) { d.done = d.done || {}; if (val) d.done[d0.id] = true; else delete d.done[d0.id]; });
    this.send('setDone', { date: this.state.data.today, taskId: d0.id, done: val }, function () { self.mutate(function (d) { if (val) delete d.done[d0.id]; else d.done[d0.id] = true; }); });
  };
  App.prototype.setShop = function (x, val) {
    var self = this;
    var week = this.state.data.shop ? this.state.data.shop.week : '';
    this.mutate(function (d) { d.checked = d.checked || {}; if (val) d.checked[x[0]] = true; else delete d.checked[x[0]]; });
    this.send('setShop', { week: week, itemId: x[0], checked: val }, function () { self.mutate(function (d) { if (val) delete d.checked[x[0]]; else d.checked[x[0]] = true; }); });
  };
  App.prototype.ackNote = function (n, val) {
    var self = this;
    var flip = function (v) { self.mutate(function (d) { (d.notes || []).forEach(function (x) { if (x.id === n.id) x.read = v; }); }); };
    flip(val);
    this.send('ackNote', { id: n.id, read: val }, function () { flip(!val); });
  };

  /* ---------- 担当・買い物の編集（先に画面を変え、失敗したら戻す） ---------- */
  function hhmm(t) { return t != null ? pad(Math.floor(t / 60)) + ':' + pad(t % 60) : ''; }
  function minOf(s) { var m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function dayMatch(rule, dow) {
    rule = String(rule || '').trim();
    if (!rule || rule === '毎日') return true;
    if (rule === '平日') return dow >= 1 && dow <= 5;
    if (rule === '土日' || rule === '週末') return dow === 0 || dow === 6;
    return rule.indexOf(DOWS[dow]) >= 0;
  }
  function ruleDays(rule) { return DOWS.map(function (_, i) { return dayMatch(rule, i); }); }
  function daysRule(on) {
    var s = DOWS.filter(function (_, i) { return on[i]; }).join('');
    if (s.length === 7) return '毎日';
    if (s === '月火水木金') return '平日';
    if (s === '日土') return '土日';
    return s;
  }
  /* 失敗した時は、画面全体を前に戻さず、シートから読み直してそろえる（ほかの操作まで消さないように） */
  App.prototype.snapshot = function () {
    var self = this;
    return function () { self.afterWrites = true; };
  };
  App.prototype.openDuty = function (d) {
    var D = this.state.data || {};
    var all = d ? ((D.dutiesAll || []).filter(function (x) { return x.id === d.id; })[0] || d) : null;
    var who = this.state.who !== 'all' && this.names().indexOf(this.state.who) >= 0 ? this.state.who : this.meWho();
    this.setState({ editor: {
      kind: 'duty', isNew: !d, id: d ? d.id : uid('d'), task: d ? d.task : '', time: d ? hhmm(d.t) : pad(Math.min(23, new Date().getHours() + 1)) + ':00',
      who: d ? d.who : who, once: all ? !!all.date : true, rule: (all && !all.date && all.rule) || '毎日', date: (all && all.date) || D.today || ymd(new Date()),
      routine: !!(all && !all.date), skipToday: !!(d && D.skipped && D.skipped[d.id])
    } });
  };
  App.prototype.editSet = function (k, v) { var e = Object.assign({}, this.state.editor); e[k] = v; this.setState({ editor: e }); };
  App.prototype.saveDuty = function () {
    if (this.stale()) return;
    var self = this, e = this.state.editor, task = (e.task || '').trim();
    if (!task) { this.showToast('やることを入力してください', null); return; }
    var rule = e.once ? '' : (e.rule || '毎日');
    var d = { id: e.id, task: task, time: e.time, who: e.who, rule: rule, date: e.once ? e.date : '' };
    var revert = this.snapshot();
    this.mutate(function (D) {
      var row = { id: d.id, t: minOf(d.time), task: task, who: d.who, rule: rule || '毎日', date: d.date };
      D.dutiesAll = (D.dutiesAll || []).filter(function (x) { return x.id !== d.id; }).concat([row]);
      var today = parseYmd(D.today || ymd(new Date()));
      var on = d.date ? d.date === D.today : dayMatch(rule, today.getDay());
      D.duties = (D.duties || []).filter(function (x) { return x.id !== d.id; });
      if (on) D.duties.push({ id: d.id, t: row.t, task: task, who: d.who, once: !!d.date });
    });
    this.setState({ editor: null });
    this.send('saveDuty', { duty: d }, revert);
    var when = d.date ? (d.date === (this.state.data || {}).today ? '今日' : parseYmd(d.date).getMonth() + 1 + '/' + parseYmd(d.date).getDate()) + 'だけ' : ruleWords(rule);
    this.showToast('「' + task + '」を' + when + 'で' + (e.isNew ? '足しました' : '直しました'), null);
  };
  App.prototype.deleteDuty = function () {
    var self = this, e = this.state.editor;
    var revert = this.snapshot();
    var old = (this.state.data.dutiesAll || []).filter(function (x) { return x.id === e.id; })[0];
    this.mutate(function (D) {
      D.dutiesAll = (D.dutiesAll || []).filter(function (x) { return x.id !== e.id; });
      D.duties = (D.duties || []).filter(function (x) { return x.id !== e.id; });
    });
    this.setState({ editor: null });
    this.send('deleteDuty', { id: e.id }, revert);
    this.showToast('「' + e.task + '」を消しました', old ? function () {
      revert(); self.send('saveDuty', { duty: { id: old.id, task: old.task, time: hhmm(old.t), who: old.who, rule: old.date ? '' : old.rule, date: old.date } }); self.setState({ toast: null });
    } : null);
  };

  /* くり返しの担当を、今日だけ休む（決まりは消さない） */
  App.prototype.skipToday = function (id, val) {
    if (this.stale()) return;
    var self = this, D = this.state.data || {}, row = (D.dutiesAll || []).filter(function (x) { return x.id === id; })[0];
    this.mutate(function (d) {
      d.skipped = d.skipped || {};
      if (val) { d.skipped[id] = true; d.duties = (d.duties || []).filter(function (x) { return x.id !== id; }); }
      else {
        delete d.skipped[id];
        var today = parseYmd(d.today || ymd(new Date()));
        if (row && !row.date && dayMatch(row.rule, today.getDay()) && !(d.duties || []).some(function (x) { return x.id === id; })) d.duties.push({ id: id, t: row.t, task: row.task, who: row.who, once: false });
      }
    });
    this.setState({ editor: null });
    this.send('skipDuty', { date: D.today, id: id, skip: val }, this.snapshot());
    if (row) this.showToast(val ? '「' + row.task + '」は今日はお休みにしました（くり返しはそのまま）' : '「' + row.task + '」を今日もやることに戻しました', val ? function () { self.skipToday(id, false); self.setState({ toast: null }); } : null);
  };

  App.prototype.addShopItem = function (name, qty, cat) {
    name = String(name || '').trim();
    if (!name) { this.showToast('品名を入力してください', null); return; }
    var D = this.state.data || {}, groups = (D.shop && D.shop.groups) || [];
    cat = cat || (groups[0] && groups[0].label) || 'その他';
    var id = uid('s'), week = (D.shop && D.shop.week) || ymd(new Date());
    var revert = this.snapshot();
    this.mutate(function (d) {
      d.shop = d.shop || { week: week, groups: [] };
      var g = d.shop.groups.filter(function (x) { return x.label === cat; })[0];
      if (!g) { g = { label: cat, items: [] }; d.shop.groups.push(g); }
      g.items.push([id, name, qty || '']);
      d.shopSuggest = (d.shopSuggest || []).filter(function (x) { return x.name !== name; });
    });
    this.send('saveShop', { item: { id: id, name: name, qty: qty || '', cat: cat, week: week } }, revert);
    this.showToast(name + 'をリストに足しました', null);
  };
  App.prototype.addShopFromForm = function () {
    var st = this.state, D = st.data || {}, groups = (D.shop && D.shop.groups) || [];
    var cats = groups.map(function (g) { return g.label; }); if (cats.indexOf('その他') < 0) cats.push('その他');
    var cat = st.shopCat && cats.indexOf(st.shopCat) >= 0 ? st.shopCat : cats[0];
    var name = (st.shopDraft || '').trim();
    if (!name) { this.showToast('品名を入力してください', null); return; }
    this.addShopItem(name, (st.shopQty || '').trim(), cat);
    this.setState({ shopDraft: '', shopQty: '' });
  };
  App.prototype.openShop = function (x, cat) {
    this.setState({ editor: { kind: 'shop', isNew: false, id: x[0], name: x[1], qty: x[2] || '', cat: cat } });
  };
  App.prototype.saveShopEdit = function () {
    var e = this.state.editor, name = (e.name || '').trim();
    if (!name) { this.showToast('品名を入力してください', null); return; }
    var revert = this.snapshot();
    this.mutate(function (d) {
      var groups = d.shop.groups;
      groups.forEach(function (g) { g.items = g.items.filter(function (x) { return x[0] !== e.id; }); });
      var g = groups.filter(function (x) { return x.label === e.cat; })[0];
      if (!g) { g = { label: e.cat, items: [] }; groups.push(g); }
      g.items.push([e.id, name, e.qty || '']);
      d.shop.groups = groups.filter(function (x) { return x.items.length; });
    });
    this.setState({ editor: null });
    this.send('saveShop', { item: { id: e.id, name: name, qty: e.qty || '', cat: e.cat } }, revert);
  };
  App.prototype.deleteShop = function () {
    var self = this, e = this.state.editor;
    var revert = this.snapshot();
    this.mutate(function (d) {
      d.shop.groups.forEach(function (g) { g.items = g.items.filter(function (x) { return x[0] !== e.id; }); });
      d.shop.groups = d.shop.groups.filter(function (x) { return x.items.length; });
    });
    this.setState({ editor: null });
    this.send('deleteShop', { id: e.id }, revert);
    var self2 = this, week = this.state.data.shop ? this.state.data.shop.week : '';
    this.showToast(e.name + 'をリストから消しました', function () {
      self2.mutate(function (d) {
        var g = d.shop.groups.filter(function (x) { return x.label === e.cat; })[0];
        if (!g) { g = { label: e.cat, items: [] }; d.shop.groups.push(g); }
        g.items.push([e.id, e.name, e.qty || '']);
      });
      self2.send('saveShop', { item: { id: e.id, name: e.name, qty: e.qty || '', cat: e.cat, week: week } });
      self2.setState({ toast: null });
    });
  };

  App.prototype.sendFeedback = function () {
    var self = this, text = (this.state.fbDraft || '').trim();
    if (!text) { this.showToast('書きたいことを入力してください', null); return; }
    var ua = navigator.userAgent, os = (ua.match(/OS (\d+)_(\d+)/) || []).slice(1).join('.');
    var screen = 'v' + APP_VERSION + ' / タブ:' + (this.state.who === 'all' ? 'みんな' : this.state.who) + ' / ' + (/iPhone/.test(ua) ? 'iPhone iOS' + os : ua.slice(0, 60)) + ' / ' + (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches ? 'ホーム画面' : 'ブラウザ');
    this.setState({ fbOpen: false, fbDraft: '' });
    api('addFeedback', { feedback: { text: text, screen: screen } }).then(function () {
      self.showToast('要望を送りました。次の修正で見ます', null);
    }).catch(function () {
      self.setState({ fbOpen: true, fbDraft: text });
      self.showToast('送れませんでした。通信を確かめて、もう一度お試しください', null);
    });
  };

  /* Museに相談：その項目の文だけを下書きにして見せる。送るのは本人（Museへ自動では送らない）。
     写真・日記・メール・他の項目は入れない。WhatsAppの番号はこの端末だけに覚える */
  App.prototype.openMuse = function (kind, x) {
    var D = this.state.data || {}, me = (D.me && D.me.who) || '';
    var L = ['わが家アプリ（わが家の今日）のことで相談です。私は「' + me + '」です。', ''];
    if (kind === 'decide') {
      L.push('【ふたりで決めること】' + x.q);
      if (x.options && x.options.length) L.push('選択肢：' + x.options.join(' / '));
      if (x.due) L.push('期限：' + x.due);
      if (x.note) L.push('メモ：' + x.note);
      L.push('', 'どう考えるとよいか、材料や別の案を出してください。');
    } else if (kind === 'outing') {
      L.push('【お出かけの候補】' + x.name);
      [['種類', x.kind], ['日付', x.date], ['場所', x.place], ['リンク', x.url], ['メモ', x.note]].forEach(function (a) { if (a[1]) L.push(a[0] + '：' + a[1]); });
      L.push('', '行くかどうか・いつ行くかを考えたいです。子連れでの注意や、ほかの候補もあれば教えてください。');
    } else if (kind === 'menu') {
      L.push('【今週の献立】');
      (D.menu || []).forEach(function (m) { if (m.dish) L.push(m.date.slice(5).replace('-', '/') + '：' + m.dish); });
      var have = [];
      ((D.shop && D.shop.groups) || []).forEach(function (g) { g.items.forEach(function (it) { if (!(D.checked || {})[it[0]]) have.push(it[1]); }); });
      if (have.length) L.push('', '【買い物リストにある物】' + have.slice(0, 40).join('、'));
      L.push('', 'このあとの献立を一緒に考えてください。決まったら、献立（menu.add）と買い物に入れる案を出してください。');
    } else {
      L.push('（ここに相談したいことを書いてください）');
    }
    L.push('', 'アプリに入れる時は、入れる前に私に確認してください。決めるのは夫婦2人なので、決定扱いにはしないでください。');
    USAGE.add('act:muse_' + kind);
    this.setState({ museOpen: true, museDraft: L.join('\n'), accountOpen: false });
  };
  App.prototype.museSend = function (how) {
    var text = String(this.state.museDraft || '').trim();
    if (!text) { this.showToast('送る文が空です', null); return; }
    var num = String(LS.get('museWa') || '').replace(/[^\d]/g, '');
    try { if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {}); } catch (e) {}
    if (how === 'wa' && num) window.open('https://wa.me/' + num + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
    else window.open('https://muse.ai/', '_blank', 'noopener');
    USAGE.add('act:muse_' + (how === 'wa' && num ? 'wa' : 'copy'));
    this.setState({ museOpen: false });
    if (!(how === 'wa' && num)) this.showToast('文をコピーしました。Museに貼って送ってください', null);
  };

  /* 詳細を見る・コメント：話題・相談・日記・お出かけ・ニュースの全文と、ふたりのやりとり */
  App.prototype.openDetail = function (kind, id) {
    USAGE.add('act:detail_' + kind);
    this.setState({ detail: { kind: kind, id: id }, replyDraft: '' });
  };
  App.prototype.sendReply = function () {
    var dt = this.state.detail, text = String(this.state.replyDraft || '').trim();
    if (!dt || !text) return;
    if (this.addReplyTo(dt.kind, dt.id, text)) this.setState({ replyDraft: '' });
  };
  App.prototype.addReplyTo = function (kind, id, text) {
    if (this.stale()) return false;
    var r = { id: uid('r'), target: kind + ':' + id, text: text }, me = this.meWho(), revert = this.snapshot();
    this.mutate(function (d) { d.replies = (d.replies || []).concat([{ id: r.id, target: r.target, who: me, at: Date.now(), text: text }]); });
    this.send('addReply', { reply: r }, revert);
    return true;
  };
  /* 申し送りへの返信。自分宛てで未確認なら、返信した時に確認済みにもする */
  App.prototype.replyNote = function (n) {
    var text = String(this.state.noteReplyDraft || '').trim();
    if (!text) { this.showToast('返信の内容を入力してください', null); return; }
    if (!this.addReplyTo('notes', n.id, text)) return;
    USAGE.add('act:note_reply');
    if (!n.read && n.to === this.meWho()) this.ackNote(n, true);
    this.setState({ noteReplyId: null, noteReplyDraft: '' });
    this.showToast('返信しました', null);
  };
  /* 申し送りを閉じたら、返信の新着は見たことにする */
  App.prototype.seeNotes = function () {
    var marks = Object.assign({}, this.state.marks || {}), seen = LS.get('seen') || {}, cur = sigsOf(this.state.data), hit = false;
    Object.keys(marks).forEach(function (k) { if (k.indexOf('notes:') === 0) { delete marks[k]; if (cur[k] !== undefined) seen[k] = cur[k]; hit = true; } });
    if (hit) { LS.set('seen', seen); this.setState({ marks: marks }); }
  };
  App.prototype.deleteReply = function (id) {
    var revert = this.snapshot();
    this.mutate(function (d) { d.replies = (d.replies || []).filter(function (x) { return x.id !== id; }); });
    this.send('deleteReply', { id: id }, revert);
    this.showToast('コメントを削除しました', null);
  };

  /* 話題（旅のしおりなどのリンク） */
  App.prototype.openTopic = function (t) {
    this.setState({ editor: { kind: 'topic', isNew: !t, id: t ? t.id : uid('t'), title: t ? t.title : '', url: t ? t.url : '', note: t ? t.note : '' } });
  };
  App.prototype.saveTopic = function () {
    var e = this.state.editor, title = (e.title || '').trim(), url = (e.url || '').trim();
    if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
    if (/^http:\/\//.test(url)) url = url.replace(/^http:/, 'https:');
    if (!title) { this.showToast('見出しを入力してください', null); return; }
    if (url && !/^https:\/\/\S+$/.test(url)) { this.showToast('リンクは https:// から始まるものを入れてください', null); return; }
    var t = { id: e.id, title: title, url: url, note: (e.note || '').trim() };
    var revert = this.snapshot();
    this.mutate(function (d) {
      var now = new Date(), list = (d.topics || []).filter(function (x) { return x.id !== t.id; });
      d.topics = e.isNew ? [Object.assign({ date: (now.getMonth() + 1) + '/' + now.getDate() }, t)].concat(list) : (d.topics || []).map(function (x) { return x.id === t.id ? Object.assign({}, x, t) : x; });
    });
    this.setState({ editor: null });
    this.send('saveTopic', { topic: t }, revert);
    this.showToast(e.isNew ? '話題に「' + title + '」を足しました' : '話題を直しました', null);
  };
  App.prototype.deleteTopic = function () {
    var e = this.state.editor, revert = this.snapshot();
    this.mutate(function (d) { d.topics = (d.topics || []).filter(function (x) { return x.id !== e.id; }); });
    this.setState({ editor: null });
    this.send('deleteTopic', { id: e.id }, revert);
    var self2 = this;
    this.showToast('話題から消しました', function () {
      var t = { id: e.id, title: e.title, url: e.url, note: e.note };
      self2.mutate(function (d) { d.topics = [t].concat(d.topics || []); });
      self2.send('saveTopic', { topic: t });
      self2.setState({ toast: null });
    });
  };

  /* ---------- ふたりで決めること ---------- */
  App.prototype.openDecision = function (x) {
    this.setState({ editor: { kind: 'decide', isNew: !x, id: x ? x.id : uid('q'), q: x ? x.q : '', options: x ? x.options.join('\n') : '', due: x ? x.due : '', note: x ? x.note : '' } });
  };
  App.prototype.saveDecision = function () {
    var e = this.state.editor, q = (e.q || '').trim();
    if (!q) { this.showToast('相談したいことを入力してください', null); return; }
    var opts = String(e.options || '').split(/\n/).map(function (x) { return x.trim(); }).filter(String).slice(0, 6);
    var item = { id: e.id, q: q, options: opts, due: e.due || '', note: (e.note || '').trim() };
    var cleared = false;
    this.mutate(function (d) {
      var list = d.decisions || [], old = list.filter(function (x) { return x.id === item.id; })[0];
      if (old) {
        if (old.q !== item.q || (old.options || []).join('\n') !== opts.join('\n')) {
          if (old.a1 || old.a2 || old.state === '決まった') cleared = true;
          old.a1 = ''; old.a2 = ''; old.state = '相談中'; old.decided = '';
        }
        Object.assign(old, item);
      } else list.push(Object.assign({ state: '相談中', a1: '', a2: '', decided: '' }, item));
      d.decisions = list;
    });
    this.setState({ editor: null });
    this.send('saveDecision', { item: item }, this.snapshot());
    this.showToast(e.isNew ? '相談を足しました' : (cleared ? '相談を直しました。問いか選択肢が変わったので、2人とも答えをもう一度お願いします' : '相談を直しました'), null);
  };
  App.prototype.deleteDecision = function () {
    var e = this.state.editor;
    this.mutate(function (d) { d.decisions = (d.decisions || []).filter(function (x) { return x.id !== e.id; }); });
    this.setState({ editor: null });
    this.send('deleteDecision', { id: e.id }, this.snapshot());
    this.showToast('相談を消しました', null);
  };
  App.prototype.answer = function (x, opt) {
    var me1 = this.names()[0] === this.meWho(), key = me1 ? 'a1' : 'a2';
    var val = x[key] === opt ? '' : opt;
    this.mutate(function (d) { (d.decisions || []).forEach(function (y) { if (y.id === x.id) y[key] = val; }); });
    this.send('answerDecision', { id: x.id, answer: val }, this.snapshot());
  };
  App.prototype.decideNow = function (x, reopen) {
    var self = this;
    this.mutate(function (d) { (d.decisions || []).forEach(function (y) { if (y.id === x.id) { y.state = reopen ? '相談中' : '決まった'; y.decided = reopen ? '' : y.a1; } }); });
    this.send('decide', { id: x.id, reopen: !!reopen }, this.snapshot());
    this.showToast(reopen ? '相談に戻しました' : '「' + x.a1 + '」で決まりにしました', reopen ? null : function () { self.decideNow(x, true); self.setState({ toast: null }); });
  };

  /* ---------- 期限があるもの ---------- */
  App.prototype.openDeadline = function (x) {
    var D = this.state.data || {};
    this.setState({ editor: { kind: 'deadline', isNew: !x, id: x ? x.id : uid('k'), what: x ? x.what : '', due: x ? x.due : (D.today || ymd(new Date())), who: x ? x.who : this.meWho(), url: x ? x.url : '', note: x ? x.note : '' } });
  };
  App.prototype.saveDeadline = function () {
    var e = this.state.editor, what = (e.what || '').trim();
    if (!what) { this.showToast('内容を入力してください', null); return; }
    var url = (e.url || '').trim(); if (url && !/^https?:\/\//.test(url)) url = 'https://' + url; url = url.replace(/^http:/, 'https:');
    var item = { id: e.id, what: what, due: e.due || '', who: e.who, url: url, note: (e.note || '').trim() };
    this.mutate(function (d) {
      var list = d.deadlines || [], old = list.filter(function (x) { return x.id === item.id; })[0];
      if (old) Object.assign(old, item); else list.push(Object.assign({ done: false }, item));
      d.deadlines = list;
    });
    this.setState({ editor: null });
    this.send('saveDeadline', { item: item }, this.snapshot());
    this.showToast(e.isNew ? '期限を足しました' : '期限を直しました', null);
  };
  App.prototype.deleteDeadline = function () {
    var e = this.state.editor;
    this.mutate(function (d) { d.deadlines = (d.deadlines || []).filter(function (x) { return x.id !== e.id; }); });
    this.setState({ editor: null });
    this.send('deleteDeadline', { id: e.id }, this.snapshot());
    this.showToast('期限を消しました', null);
  };
  App.prototype.toggleDeadline = function (x) {
    var self = this, v = !x.done;
    this.mutate(function (d) { (d.deadlines || []).forEach(function (y) { if (y.id === x.id) y.done = v; }); });
    this.send('doneDeadline', { id: x.id, done: v }, this.snapshot());
    this.showToast(v ? '「' + x.what + '」を済にしました' : '「' + x.what + '」を戻しました', function () { self.toggleDeadline(Object.assign({}, x, { done: v })); self.setState({ toast: null }); });
  };

  /* ---------- 今週末（お出かけ） ---------- */
  App.prototype.openOuting = function (x) {
    this.setState({ editor: { kind: 'outing', isNew: !x, id: x ? x.id : uid('o'), name: x ? x.name : '', okind: x ? x.kind : '公園', date: x ? x.date : '', place: x ? x.place : '', url: x ? x.url : '', note: x ? x.note : '' } });
  };
  App.prototype.saveOuting = function () {
    var e = this.state.editor, name = (e.name || '').trim();
    if (!name) { this.showToast('行き先を入力してください', null); return; }
    var url = (e.url || '').trim(); if (url && !/^https?:\/\//.test(url)) url = 'https://' + url; url = url.replace(/^http:/, 'https:');
    var item = { id: e.id, name: name, kind: e.okind || '', date: e.date || '', place: (e.place || '').trim(), url: url, note: (e.note || '').trim() };
    this.mutate(function (d) {
      var list = d.outings || [], old = list.filter(function (x) { return x.id === item.id; })[0];
      if (old) Object.assign(old, item); else list.push(Object.assign({ like1: false, like2: false, state: '候補', go: '' }, item));
      d.outings = list;
    });
    this.setState({ editor: null });
    this.send('saveOuting', { item: item }, this.snapshot());
    this.showToast(e.isNew ? '候補に「' + name + '」を足しました' : '候補を直しました', null);
  };
  App.prototype.deleteOuting = function () {
    var e = this.state.editor;
    this.mutate(function (d) { d.outings = (d.outings || []).filter(function (x) { return x.id !== e.id; }); });
    this.setState({ editor: null });
    this.send('deleteOuting', { id: e.id }, this.snapshot());
    this.showToast('候補を消しました', null);
  };
  App.prototype.likeOuting = function (x) {
    var key = this.names()[0] === this.meWho() ? 'like1' : 'like2', v = !x[key];
    this.mutate(function (d) { (d.outings || []).forEach(function (y) { if (y.id === x.id) y[key] = v; }); });
    this.send('likeOuting', { id: x.id, like: v }, this.snapshot());
  };
  App.prototype.planOuting = function (x, date) {
    var self = this;
    var label = 'おでかけ：' + x.name;
    this.mutate(function (d) {
      (d.outings || []).forEach(function (y) { if (y.id === x.id) { y.state = date ? '決めた' : '候補'; y.go = date || ''; } });
      d.plans = (d.plans || []).filter(function (p) { return p.what !== label; });
      if (date) d.plans.push({ date: date, time: '', what: label, who: '家族' });
    });
    this.send('planOuting', { id: x.id, date: date || '' }, this.snapshot());
    if (date) {
      var dd = parseYmd(date), n0 = new Date(), weekEnd = new Date(n0.getFullYear(), n0.getMonth(), n0.getDate() + 6);
      var other = this.names()[0] === this.meWho() ? x.like2 : x.like1, otherName = this.names()[0] === this.meWho() ? this.names()[1] : this.names()[0];
      this.showToast((dd.getMonth() + 1) + '/' + dd.getDate() + '（' + DOWS[dd.getDay()] + '）に「' + x.name + '」へ。' + (dd > weekEnd ? '先の予定に入れました' : '予定にも入れました') + (other ? '' : '（' + otherName + 'はまだ「行きたい」を押していません）'), null);
    } else this.showToast('「' + x.name + '」に行くのをやめました。予定からも外しました', null);
  };

  /* ---------- 献立の材料を買い物リストへ ---------- */
  /* ---------- 献立（アプリから入れる・直す） ---------- */
  function ingLines(list) { return (list || []).map(function (x) { return x[0] + (x[1] ? ' ' + x[1] : ''); }).join('\n'); }
  function parseIngLines(t) {
    return String(t || '').split(/\n+/).map(function (l) { return l.trim(); }).filter(String).map(function (l) {
      var m = l.match(/^(.+?)\s*[:：]\s*(.*)$/) || l.match(/^(.+?)[\s　]+(\S.*)$/);
      return m ? { name: m[1].trim(), qty: m[2].trim() } : { name: l, qty: '' };
    });
  }
  App.prototype.openMenu = function (date, m) {
    var d = parseYmd(date), lbl = (d.getMonth() + 1) + '/' + d.getDate() + '（' + DOWS[d.getDay()] + '）';
    this.setState({ editor: { kind: 'menu', isNew: !m, id: date, date: date, dateLabel: lbl, dish: m ? m.dish : '', servings: m ? m.servings || '' : '', hotcook: m ? !!m.hotcook : false, note: m ? m.note || '' : '', ings: m ? ingLines(m.ingredients) : '', how: m ? m.how || '' : '' } });
  };
  App.prototype.saveMenu = function () {
    if (this.stale()) return;
    var e = this.state.editor, dish = (e.dish || '').trim();
    if (!dish) { this.showToast('料理の名前を入れてください', null); return; }
    var ings = parseIngLines(e.ings);
    var m = { date: e.date, dish: dish, servings: String(e.servings || '').replace(/[^0-9０-９]/g, '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 65248); }).slice(0, 2), hotcook: !!e.hotcook, note: (e.note || '').trim(), ingredients: ings, how: (e.how || '').trim() };
    var revert = this.snapshot();
    this.mutate(function (d) {
      var row = { date: m.date, dish: m.dish, servings: m.servings, hotcook: m.hotcook, note: m.note, ingredients: ings.map(function (x) { return [x.name, x.qty]; }), how: m.how, photo: '' };
      var old = (d.menu || []).filter(function (x) { return x.date === m.date; })[0];
      if (old) row.photo = old.photo || '';
      d.menu = (d.menu || []).filter(function (x) { return x.date !== m.date; }).concat([row]);
    });
    this.setState({ editor: null });
    this.send('saveMenu', { menu: m }, revert);
    this.showToast(e.dateLabel + 'の献立を' + (e.isNew ? '入れました' : '直しました'), null);
  };
  App.prototype.deleteMenu = function () {
    if (this.stale()) return;
    var e = this.state.editor, revert = this.snapshot();
    this.mutate(function (d) { d.menu = (d.menu || []).filter(function (x) { return x.date !== e.date; }); });
    this.setState({ editor: null });
    this.send('deleteMenu', { date: e.date }, revert);
    this.showToast(e.dateLabel + 'の献立を消しました', null);
  };
  App.prototype.menuToShop = function (dm) {
    if (this.stale()) return;
    var D = this.state.data || {}, groups = (D.shop && D.shop.groups) || [], week = (D.shop && D.shop.week) || ymd(new Date());
    var have = {}; groups.forEach(function (g) { g.items.forEach(function (x) { have[String(x[1]).replace(/\s/g, '')] = 1; }); });
    var cat = (groups[0] && groups[0].label) || 'お店で買う';
    var items = (dm.ingredients || []).filter(function (x) { return x.name && !have[String(x.name).replace(/\s/g, '')]; }).map(function (x) { return { id: uid('s'), name: x.name, qty: x.qty || '', cat: cat, week: week }; });
    if (!items.length) { this.showToast('材料はもう全部リストにあります', null); return; }
    this.mutate(function (d) {
      d.shop = d.shop || { week: week, groups: [] };
      var g = d.shop.groups.filter(function (x) { return x.label === cat; })[0];
      if (!g) { g = { label: cat, items: [] }; d.shop.groups.push(g); }
      items.forEach(function (x) { g.items.push([x.id, x.name, x.qty]); });
    });
    this.send('addShopMany', { items: items }, this.snapshot());
    this.showToast(dm.dish + 'の材料を' + items.length + '品、買い物リストに足しました', null);
  };

  /* 写真のスライド */
  App.prototype.media = function () {
    return (this.state.photos || []).filter(function (p) { return p.src || p.vsrc; }).map(function (p) {
      if (p.vsrc) return { type: 'video', src: p.vsrc, poster: p.src || '', dur: 12, pos: p.pos || 'center 30%', id: p.id };
      return { type: 'photo', src: p.src, dur: 5, pos: p.pos || 'center 30%', id: p.id, video: !!p.video, big: !!p.big };
    });
  };
  App.prototype.order = function () {
    var m = this.media();
    if (!m.length) return m;
    var d = new Date();
    var dayNum = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(d.getFullYear(), 0, 1)) / 86400000);
    var start = dayNum % m.length;
    return m.map(function (_, i) { return m[(start + i) % m.length]; });
  };
  App.prototype.slideDur = function (idx) { var o = this.order(); return o.length ? o[idx % o.length].dur : 5; };
  /* 色コードから、薄い背景色を作る（白に88%寄せる） */
  function tintOf(hex) {
    var m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
    if (!m) return '#E0EEE7';
    var n = parseInt(m[1], 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    var mix = function (c) { return Math.round(c + (255 - c) * 0.86); };
    return 'rgb(' + mix(r) + ',' + mix(g) + ',' + mix(b) + ')';
  }
  App.prototype.person = function (who) {
    var p = this.people().filter(function (x) { return x.name === who; })[0];
    var d = this.state.data;
    var ink = p ? p.ink : ((d && d.family && d.family.ink) || '#2C6B52');
    if (!/^#[0-9a-f]{6}$/i.test(ink)) ink = p ? (p === this.people()[0] ? '#3046A6' : '#A3355D') : '#2C6B52';
    return { ink: ink, tint: tintOf(ink) };
  };
  App.prototype.badge = function (who) {
    var c = this.person(who);
    return 'flex-shrink: 0; font-size: 12px; font-weight: 700; color: ' + c.ink + '; background: ' + c.tint + '; border-radius: 999px; padding: 4px 10px; white-space: nowrap';
  };

  var SHEET_POS = 'position: fixed; left: 0; right: 0; bottom: 0; width: 100%; max-width: 480px; margin: 0 auto; box-sizing: border-box; ';
  var SHEET_PAD = 'padding: 12px 20px calc(28px + env(safe-area-inset-bottom)); ';
  function backdrop(open) { return 'position: fixed; inset: 0; width: 100%; border: none; padding: 0; background: rgba(23,32,27,0.4); z-index: 30; transition: opacity .25s; ' + (open ? 'opacity: 1' : 'opacity: 0; pointer-events: none'); }
  function sheetStyle(open, extra, ease) {
    return SHEET_POS + extra + 'background: #FFFFFF; border-radius: 24px 24px 0 0; ' + SHEET_PAD + 'display: flex; flex-direction: column; gap: 10px; z-index: 40; transition: transform ' + (ease || '.45s cubic-bezier(.2,1.2,.3,1)') + '; ' + (open ? 'transform: translateY(0)' : 'transform: translateY(105%); visibility: hidden');
  }

  App.prototype.renderVals = function () {
    var marks = this.state.marks || {};
    var self = this;
    var st = this.state;
    var D = st.data || {};
    var now = new Date(st.now);
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var dows = DOWS;
    var todayIdx = now.getDay();
    var dayIdx = st.day === null ? todayIdx : st.day;
    var done = D.done || {}, checked = D.checked || {}, notesAll = D.notes || [], diaryAll = (D.diary || []).filter(function (k) { return k.date === ymd(now); });
    var meWho = this.meWho();
    var names = this.names(), ui = this.ui();
    var whoSel = st.who === 'all' || names.indexOf(st.who) >= 0 ? st.who : 'all';

    var whoTabs = [['all', 'みんな']].concat(names.map(function (n) { return [n, n]; })).map(function (t) {
      var on = whoSel === t[0];
      return {
        label: t[1], pressed: on ? 'true' : 'false',
        pick: function () { LS.set('who', t[0]); USAGE.add('tab:' + (t[0] === 'all' ? 'all' : (names.indexOf(t[0]) === 0 ? 'p1' : 'p2'))); self.setState({ who: t[0] }); },
        style: 'min-height: 44px; border: none; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; transition: background .2s, color .2s; ' + (on ? 'background: #FFFFFF; color: #17201B; box-shadow: 0 1px 2px rgba(23,32,27,0.12)' : 'background: transparent; color: rgba(255,255,255,0.86)')
      };
    });

    var tOrd = function (x) { return x.t == null ? 99999 : x.t; };
    var duties = (D.duties || []).slice().sort(function (a, b) { return tOrd(a) - tOrd(b); });
    var tS = ui.timeStart || 360, tE = ui.timeEnd > tS ? ui.timeEnd : 1260;
    function pct(m) { return Math.max(0, Math.min(100, (m - tS) / (tE - tS) * 100)); }
    var mine = duties.filter(function (d) { return whoSel === 'all' || d.who === whoSel || d.who === '家族'; });

    var next = null;
    for (var i = 0; i < mine.length; i++) { if (!done[mine[i].id] && mine[i].t != null && mine[i].t >= nowMin) { next = mine[i]; break; } }
    var hero;
    if (next) {
      var diff = Math.max(0, next.t - nowMin);
      var cd = diff <= 0 ? 'いまから' : 'あと' + (diff >= 60 ? Math.floor(diff / 60) + '時間' : '') + (diff % 60 ? (diff % 60) + '分' : '');
      hero = { kicker: 'つぎの担当', time: hm(next.t), countdown: cd, task: next.task, who: next.who, color: this.person(next.who).ink };
    } else {
      var left0 = mine.filter(function (d) { return !done[d.id]; });
      if (!mine.length) hero = { kicker: '今日の担当', time: '—', countdown: '', task: '今日の担当はありません', who: '—', color: this.person('家族').ink };
      else if (left0.length) { var lastL = left0.filter(function (d) { return d.t != null; }).pop() || left0[left0.length - 1];   /* いちばん最近の、終わっていない担当 */
        hero = { kicker: 'まだ終わっていない担当（' + left0.length + '件）', time: hm(lastL.t), countdown: '時間は過ぎています', task: lastL.task, who: lastL.who, color: this.person(lastL.who).ink }; }
      else hero = { kicker: '今日の担当', time: 'おしまい', countdown: 'おつかれさま', task: '今日の担当は全部終わりました', who: whoSel === 'all' ? 'みんな' : whoSel, color: this.person('家族').ink };
    }
    hero.bandStyle = 'margin: 4px 16px 0; padding: 22px 20px 16px; border-radius: 24px; background: ' + hero.color + '; color: #FFFFFF; display: flex; flex-direction: column; gap: 6px; transition: background .5s; animation: heroIn .6s cubic-bezier(.2,.8,.2,1) both';
    hero.marks = [tS, 720, 1080, tE].filter(function (m, k, a) { return (k === 0 || k === a.length - 1 || (m > tS + 90 && m < tE - 90)); }).map(function (m, k, a) {
      var p0 = pct(m);
      return { label: hm(m), style: 'position: absolute; top: 0; ' + (k === 0 ? 'left: 0' : (k === a.length - 1 ? 'right: 0' : 'left: ' + p0 + '%; transform: translateX(-50%)')) };
    });
    hero.passedStyle = 'position: absolute; left: 0; top: 13px; height: 2px; width: ' + pct(nowMin) + '%; background: #FFFFFF; border-radius: 2px';
    hero.nowStyle = 'position: absolute; top: 4px; left: calc(' + pct(nowMin) + '% - 1px); width: 2px; height: 20px; background: #FFFFFF; border-radius: 2px; animation: breathe 2.4s ease-in-out infinite';
    var timeline = mine.filter(function (d) { return d.t != null; }).map(function (d) {
      var isNext = next && d.id === next.id;
      var size = isNext ? 14 : 8;
      var fill = done[d.id] || d.t < nowMin ? '#FFFFFF' : 'transparent';
      return { dotStyle: 'position: absolute; top: ' + (14 - size / 2) + 'px; left: calc(' + pct(d.t) + '% - ' + size / 2 + 'px); width: ' + size + 'px; height: ' + size + 'px; border-radius: 50%; box-sizing: border-box; border: 2px solid #FFFFFF; background: ' + fill };
    });

    var flow = mine.map(function (d) {
      var isDone = !!done[d.id];
      var past = d.t != null && d.t < nowMin;
      var c = self.person(d.who);
      var tnotes = notesAll.filter(function (n) { return n.taskId === d.id; });
      return {
        time: hm(d.t), task: d.task, who: d.who, done: isDone, once: !!d.once, isNew: !!marks['flow:' + d.id],
        toggle: function () {
          var v = !isDone;
          self.setDone(d, v);
          self.showToast(v ? '「' + d.task + '」を終わりにしました' : '「' + d.task + '」を未完了に戻しました', function () { self.setDone(d, !v); self.setState({ toast: null }); });
        },
        wrapStyle: 'border-radius: 18px; transition: background .3s, opacity .3s; background: ' + (isDone ? '#F4F6F2' : '#FFFFFF') + '; ' + (past && !isDone ? 'opacity: 0.72' : ''),
        notes: tnotes.map(function (n) {
          return {
            text: n.text,
            meta: n.from + 'から' + n.to + 'へ　' + whenLabel(n.createdAt).replace('今日 ', '') + (n.read ? '　確認済み' : '　未確認'),
            bubbleStyle: 'margin: 0 12px 10px 70px; padding: 8px 12px; border-radius: 12px 12px 12px 4px; font-size: 13px; line-height: 1.6; transition: background .3s; animation: rise .35s cubic-bezier(.2,.8,.2,1) both; background: ' + (n.read ? '#F0F2EE' : '#FFF6E8')
          };
        }),
        hasNotes: tnotes.some(function (n) { return !n.read; }),
        noteCount: tnotes.filter(function (n) { return !n.read; }).length,
        noteLabel: '「' + d.task + '」の申し送りを書く',
        openNote: function () { self.openNoteFor(d.task, d.id, 'handover', d.who); },
        noteBtnStyle: 'position: relative; width: 50px; min-height: 52px; margin-right: 4px; flex-shrink: 0; border-radius: 14px; border: none; background: transparent; color: #6B746E; display: flex; flex-direction: column; gap: 3px; align-items: center; justify-content: center; cursor: pointer',
        markStyle: 'width: 24px; height: 24px; flex-shrink: 0; border-radius: 50%; box-sizing: border-box; display: flex; align-items: center; justify-content: center; transition: background .2s; border: 2px solid ' + c.ink + '; background: ' + (isDone ? c.ink : 'transparent'),
        taskStyle: 'display: inline; font-size: 16px; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-decoration-break: clone; box-decoration-break: clone; background-image: linear-gradient(currentColor, currentColor); background-repeat: no-repeat; background-position: 0 55%; transition: background-size .35s cubic-bezier(.2,.8,.2,1), color .3s; background-size: ' + (isDone ? '100% 1.5px; color: #55605A' : '0% 1.5px'),
        badgeStyle: self.badge(d.who)
      };
    });

    /* 担当の編集：くり返しも「その日だけ」も全部並べる */
    function ruleLabel(x) {
      if (x.date) { var dd = parseYmd(x.date); return (x.date === D.today ? '今日' : (dd.getMonth() + 1) + '/' + dd.getDate()) + 'だけ'; }
      return ruleWords(x.rule || '毎日');
    }
    var flowEditRows = (D.dutiesAll || []).filter(function (d) { return whoSel === 'all' || d.who === whoSel || d.who === '家族'; })
      .slice().sort(function (a, b) { return tOrd(a) - tOrd(b); }).map(function (d) {
        return { time: hm(d.t), task: d.task, who: d.who, rule: ruleLabel(d), badgeStyle: self.badge(d.who), open: function () { self.openDuty(d); } };
      });

    /* 今週のごはん */
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - todayIdx);
    var menuMap = {};
    (D.menu || []).forEach(function (m) { menuMap[m.date] = m; });
    var menuByDow = dows.map(function (_, i) {
      var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return menuMap[ymd(dt)] || { dish: ui.noMenuDish || 'まだ決まっていません', hotcook: false, note: ui.noMenuNote || '', ingredients: [], how: '', photo: '' };
    });
    var week = dows.map(function (d, i) {
      var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var on = i === dayIdx;
      var isToday = i === todayIdx;
      return {
        dow: isToday ? '今日' : d, date: dt.getDate(), pressed: on ? 'true' : 'false',
        pick: function () { self.setState({ day: i, dayAnim: self.state.dayAnim + 1 }); },
        style: 'flex: 1 1 0; min-width: 44px; min-height: 72px; border-radius: 14px; border: ' + (isToday && !on ? '2px solid #17201B' : '2px solid transparent') + '; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer; transition: background .2s, color .2s; ' + (on ? 'background: #17201B; color: #FFFFFF' : 'background: #FFFFFF; color: #17201B'),
        aria: (isToday ? '今日' : d + '曜') + ' ' + dt.getDate() + '日、' + (menuMap[ymd(dt)] ? (menuByDow[i].hotcook ? 'ホットクックの献立あり' : '献立あり') : '献立なし'),
        dotStyle: 'width: 6px; height: 6px; border-radius: 50%; background: ' + (!menuMap[ymd(dt)] ? 'transparent' : (menuByDow[i].hotcook ? '#C99A1E' : (on ? '#FFFFFF' : '#8A948D')))
      };
    });
    var dm = menuByDow[dayIdx];
    var dmDate = ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayIdx)), dmReal = menuMap[dmDate] || null;
    var dayOfYear = Math.floor((new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayIdx) - new Date(now.getFullYear(), 0, 1)) / 86400000);
    var dayMenu = {
      label: dayIdx === todayIdx ? '今日' : dows[dayIdx] + '曜', servingsLabel: dm.servings ? '・' + dm.servings + '人分' : '', dish: dm.dish, hotcook: !!dm.hotcook, note: dm.note || '',
      ingredients: (dm.ingredients || []).map(function (x) { return { name: x[0], qty: x[1] }; }), how: dm.how || '',
      photo: dm.photo || pexels(MOOD[((dayOfYear % MOOD.length) + MOOD.length) % MOOD.length]),
      photoAlt: dm.photo ? (dm.photoBy === 'wiki' ? dm.dish + 'に近い料理の写真（ウィキペディア「' + (dm.photoTitle || '') + '」）' : dm.dish + 'の写真') : '食卓を囲むイメージ写真',
      photoCredit: dm.photo ? (dm.photoBy === 'wiki' ? creditText(dm.photoCredit) : '') : 'イメージ写真（Pexels）',
      photoLink: dm.photo ? (dm.photoBy === 'wiki' && dm.photoCredit && /^https:\/\/commons\.wikimedia\.org\//.test(dm.photoCredit.page || '') ? dm.photoCredit.page : '') : 'https://www.pexels.com/',
      hasPhotoLink: !!(dm.photo ? (dm.photoBy === 'wiki' && dm.photoCredit && dm.photoCredit.page) : true),
      photoLicenseLink: dm.photoBy === 'wiki' && dm.photoCredit && /^https:\/\//.test(dm.photoCredit.licenseUrl || '') ? dm.photoCredit.licenseUrl : '',
      photoStyle: 'display: block; width: 100%; height: 100%; object-fit: cover; animation: ' + (st.dayAnim % 2 ? 'slideA' : 'slideB') + ' .5s cubic-bezier(.2,.8,.2,1) both'
    };

    /* 買い物 */
    var groups = (D.shop && D.shop.groups) || [];
    var total = 0, got = 0;
    var shop = groups.map(function (g) {
      var items = [];
      g.items.forEach(function (x) {
        var on = !!checked[x[0]];
        total += 1; if (on) got += 1;
        if (st.hideBought && on) return;
        items.push({
          name: x[1], qty: x[2], checked: on, editing: !!st.shopEdit, isNew: !!marks['shop:' + x[0]],
          toggle: function () {
            if (self.state.shopEdit) { self.openShop(x, g.label); return; }
            var v = !on;
            self.setShop(x, v);
            var c2 = Object.assign({}, checked); if (v) c2[x[0]] = true; else delete c2[x[0]];
            var allNow = groups.every(function (gg) { return gg.items.every(function (y) { return c2[y[0]]; }); });
            self.showToast(allNow ? '全部そろいました。おつかれさま' : (v ? x[1] + 'を買いました' : x[1] + 'をリストに戻しました'), function () { self.setShop(x, !v); self.setState({ toast: null }); });
          },
          boxStyle: 'width: 24px; height: 24px; flex-shrink: 0; border-radius: 8px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; transition: background .2s; border: 2px solid #2C6B52; background: ' + (on ? '#2C6B52' : 'transparent'),
          nameStyle: 'font-size: 16px; background-image: linear-gradient(currentColor, currentColor); background-repeat: no-repeat; background-position: 0 55%; transition: background-size .35s cubic-bezier(.2,.8,.2,1), color .3s; background-size: ' + (on ? '100% 1.5px; color: #55605A' : '0% 1.5px')
        });
      });
      return { label: g.label, items: items, empty: items.length === 0 };
    });
    var shopCats = groups.map(function (g) { return g.label; });
    if (shopCats.indexOf('その他') < 0) shopCats.push('その他');
    var shopCatSel = st.shopCat && shopCats.indexOf(st.shopCat) >= 0 ? st.shopCat : shopCats[0];
    function chip(on, ink) {
      ink = ink || '#17201B';
      return 'flex-shrink: 0; min-height: 44px; padding: 0 14px; border-radius: 999px; font-size: 13px; font-weight: 700; cursor: pointer; border: 1.5px solid ' + ink + '; ' + (on ? 'background: ' + ink + '; color: #FFFFFF' : 'background: transparent; color: ' + ink);
    }
    var shopSuggest = (D.shopSuggest || []).map(function (x) {
      return { name: x.name, note: x.note || '', due: !!x.due, add: function () { self.addShopItem(x.name, x.qty, x.cat && shopCats.indexOf(x.cat) >= 0 ? x.cat : (x.cat || shopCatSel)); },
        style: 'flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 52px; padding: 8px 12px; border-radius: 14px; border: 1.5px dashed ' + (x.due ? '#C99A1E' : '#B9C3B5') + '; background: ' + (x.due ? '#FFF6E8' : '#FFFFFF') + '; color: #17201B; cursor: pointer; text-align: left' };
    });

    /* 話題 */
    /* 長い文は5行まで。全文とコメントは「詳細を見る」の画面で */
    var rCount = {}; (D.replies || []).forEach(function (r) { rCount[r.target] = (rCount[r.target] || 0) + 1; });
    var clamp = function (n, extra) { return 'display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ' + n + '; overflow: hidden; overflow-wrap: anywhere; ' + (extra || ''); };
    var moreOf = function (kind, id) {
      var n = rCount[kind + ':' + id] || 0;
      return { label: n ? '詳細を見る（コメント' + n + '件）' : '詳細を見る', go: function () { self.openDetail(kind, id); },
        style: 'align-self: flex-start; min-height: 44px; padding: 0 12px; border-radius: 12px; border: none; background: ' + (n ? '#E3E7F6' : '#EEF1EC') + '; color: ' + (n ? '#22337A' : '#17201B') + '; font-size: 13px; font-weight: 700; cursor: pointer' };
    };
    var topics = (D.topics || []).map(function (t) {
      return { isNew: !!marks['topics:' + t.id], title: t.title, note: t.note, more: moreOf('topics', t.id), titleStyle: clamp(2, 'font-size: 16px; font-weight: 900; line-height: 1.4'), noteStyle: clamp(5, 'font-size: 13px; color: #39433D; line-height: 1.6'), url: t.url, hasUrl: !!t.url, date: t.date || '', editing: !!st.topicEdit, open: function () { self.openTopic(t); },
        host: (function () { try { var h = new URL(t.url).hostname; return h === 'claude.ai' ? 'Claude' : h.replace(/^www\./, ''); } catch (e) { return ''; } })() };
    });

    /* ふたりで決めること */
    var me1 = names[0] === meWho;
    var dueLabel = function (due) {
      if (!due) return '';
      var n = Math.round((parseYmd(due) - parseYmd(todayStr0)) / 864e5), dd = parseYmd(due), md = (dd.getMonth() + 1) + '/' + dd.getDate();
      return n < 0 ? md + '（' + (-n) + '日過ぎ）' : n === 0 ? md + '（今日）' : n === 1 ? md + '（明日）' : md + '（あと' + n + '日）';
    };
    var todayStr0 = ymd(now);
    var myTurnOf = function (x) { return x.state !== '決まった' && !(me1 ? x.a1 : x.a2) ? 0 : 1; };
    var decisions = (D.decisions || []).slice().sort(function (a, b) { return (a.state === '決まった') - (b.state === '決まった') || myTurnOf(a) - myTurnOf(b) || ((a.due || '9') < (b.due || '9') ? -1 : 1); }).map(function (x) {
      var decided = x.state === '決まった';
      var mine = me1 ? x.a1 : x.a2;
      var both = x.a1 && x.a1 === x.a2 && x.a1 !== '話したい';
      var opts = (x.options && x.options.length ? x.options : ['賛成', '反対']).concat(['話したい']).map(function (o) {
        var picks = [];
        if (x.a1 === o) picks.push({ label: names[0], style: self.badge(names[0]) });
        if (x.a2 === o) picks.push({ label: names[1], style: self.badge(names[1]) });
        var on = mine === o;
        return { label: o, picks: picks, pressed: on ? 'true' : 'false', pick: function () { self.answer(x, o); },
          style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 48px; padding: 0 12px; border-radius: 12px; text-align: left; cursor: pointer; font-size: 15px; font-weight: 700; color: #17201B; border: 2px solid ' + (on ? '#17201B' : '#DDE3DA') + '; background: ' + (on ? '#F4F6F2' : '#FFFFFF') };
      });
      var other = me1 ? x.a2 : x.a1, otherName = me1 ? names[1] : names[0];
      var waiting = !mine && !other ? 'まだ2人とも答えていません。あなたから答えられます'
        : !mine ? 'あなたの番です（' + otherName + 'は答えました）'
        : !other ? otherName + 'の答え待ち'
        : (mine === '話したい' || other === '話したい') ? (other === '話したい' ? otherName + 'が話したいそうです' : '話したい、と伝えています')
        : both ? '答えがそろいました' : '答えが分かれています。話して決めましょう';
      return { isNew: !!marks['decide:' + x.id], more: moreOf('decide', x.id), qStyle: clamp(3, 'font-size: 16px; font-weight: 900; line-height: 1.45'), noteStyle: clamp(5, 'margin: 0; font-size: 13px; color: #39433D; line-height: 1.6'), q: x.q, note: x.note, hasNote: !!x.note, due: dueLabel(x.due), hasDue: !!x.due && !decided, decided: decided, open: !decided, decidedText: x.decided, opts: opts, waiting: waiting,
        muse: function () { self.openMuse('decide', x); }, canDecide: both && !decided, decide: function () { self.decideNow(x, false); }, reopen: function () { self.decideNow(x, true); }, edit: function () { self.openDecision(x); },
        cardStyle: 'display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: 20px; background: ' + (decided ? '#F4F6F2' : '#FFFFFF') };
    });

    /* 期限があるもの */
    var deadlines = (D.deadlines || []).filter(function (x) { return whoSel === 'all' || !x.who || x.who === whoSel || x.who === '家族'; }).sort(function (a, b) { return (a.done - b.done) || ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0); }).map(function (x) {
      var n = x.due ? Math.round((parseYmd(x.due) - parseYmd(todayStr0)) / 864e5) : 99;
      var col = x.done ? '#55605A' : (n < 0 ? '#A3355D' : n <= 2 ? '#8A5A12' : '#39433D');
      return { isNew: !!marks['deadline:' + x.id], what: x.what, due: x.due ? dueLabel(x.due) : '期限なし', who: x.who, done: !!x.done, url: x.url, hasUrl: !!x.url, note: x.note,
        toggle: function () { self.toggleDeadline(x); }, edit: function () { self.openDeadline(x); }, badgeStyle: self.badge(x.who),
        dueStyle: 'font-size: 13px; font-weight: 900; color: ' + col,
        boxStyle: 'width: 26px; height: 26px; flex-shrink: 0; border-radius: 8px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; border: 2px solid #2C6B52; background: ' + (x.done ? '#2C6B52' : 'transparent'),
        textStyle: 'font-size: 15px; font-weight: 700; ' + (x.done ? 'text-decoration: line-through; color: #55605A' : '') };
    });

    /* 今週末 */
    var sat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((6 - now.getDay() + 7) % 7));
    var sun = now.getDay() === 0 ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(sat.getFullYear(), sat.getMonth(), sat.getDate() + 1);
    var wkDays = (now.getDay() === 0 ? [sun] : [sat, sun]).map(function (d) { return { ymd: ymd(d), label: (d.getMonth() + 1) + '/' + d.getDate() + '（' + DOWS[d.getDay()] + '）' }; });
    var outings = (D.outings || []).slice().map(function (x) {   /* 押しても並びが動かないよう、シートの順のまま */
      var mineLike = me1 ? x.like1 : x.like2, likes = [];
      if (x.like1) likes.push({ label: names[0], style: self.badge(names[0]) });
      if (x.like2) likes.push({ label: names[1], style: self.badge(names[1]) });
      var planned = x.state === '決めた' && x.go;
      var gd = planned ? parseYmd(x.go) : null;
      return { isNew: !!marks['weekend:' + x.id], more: moreOf('weekend', x.id), noteStyle: clamp(5, 'font-size: 13px; color: #39433D; line-height: 1.6'), name: x.name, kind: x.kind, meta: [x.date ? dueLabel(x.date).replace(/（.*）/, '') + 'のイベント' : '', x.place].filter(String).join('・'), note: x.note, url: x.url, hasUrl: !!x.url,
        likes: likes, likeLabel: mineLike ? '行きたい（取り消す）' : '行きたい', like: function () { self.likeOuting(x); },
        planned: !!planned, notPlanned: !planned && x.like1 && x.like2, needBoth: !planned && !(x.like1 && x.like2),
        needText: (x.like1 || x.like2) ? (x.like1 ? names[1] : names[0]) + 'も「行きたい」を押すと、行く日を決められます' : '2人とも「行きたい」を押すと、行く日を決められます',
        goLabel: planned ? (gd.getMonth() + 1) + '/' + gd.getDate() + '（' + DOWS[gd.getDay()] + '）に行く' : '',
        days: wkDays.map(function (w) { return { label: w.label + 'に行く', pick: function () { self.planOuting(x, w.ymd); } }; }),
        unplan: function () { self.planOuting(x, ''); }, edit: function () { self.openOuting(x); }, muse: function () { self.openMuse('outing', x); },
        likeStyle: 'min-height: 44px; padding: 0 14px; border-radius: 12px; font-size: 14px; font-weight: 700; cursor: pointer; border: 1.5px solid #A3355D; ' + (mineLike ? 'background: #A3355D; color: #FFFFFF' : 'background: transparent; color: #A3355D'),
        cardStyle: 'flex-shrink: 0; width: 270px; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: 20px; background: ' + (planned ? '#E0EEE7' : '#FFFFFF') };
    });

    /* 編集シート（担当・買い物・話題） */
    var E = st.editor;
    var ed = { open: !!E, duty: !!E && E.kind === 'duty', shop: !!E && E.kind === 'shop', topic: !!E && E.kind === 'topic', decide: !!E && E.kind === 'decide', deadline: !!E && E.kind === 'deadline', outing: !!E && E.kind === 'outing', menu: !!E && E.kind === 'menu', isNew: !!(E && E.isNew), canDelete: !!(E && !E.isNew) };
    if (E) {
      var HEAD = { duty: ['担当を足す', '担当を直す'], shop: ['買い物を直す', '買い物を直す'], topic: ['話題を足す', '話題を直す'], decide: ['相談を足す', '相談を直す'], deadline: ['期限を足す', '期限を直す'], outing: ['お出かけの候補を足す', 'お出かけの候補を直す'], menu: ['献立を入れる', '献立を直す'] };
      ed.heading = HEAD[E.kind][E.isNew ? 0 : 1];
      var FIELDS = ['task', 'time', 'name', 'qty', 'title', 'url', 'note', 'q', 'options', 'due', 'what', 'place', 'date', 'dish', 'ings', 'how', 'servings'];
      FIELDS.forEach(function (k) { ed[k] = E[k] || ''; });
      ed.set = {};
      FIELDS.forEach(function (k) { ed.set[k] = function (ev) { self.editSet(k, ev.target.value); }; });
      ed.cancel = function () { self.setState({ editor: null }); };
      if (E.kind === 'duty') {
        ed.whoChips = names.concat(['家族']).map(function (n) { var on = E.who === n; return { label: n, pressed: on ? 'true' : 'false', style: chip(on, self.person(n).ink), pick: function () { self.editSet('who', n); } }; });
        ed.showKind = !E.routine || E.isNew;
        ed.isRoutine = !!E.routine && !E.isNew;
        ed.skipLabel = E.skipToday ? '今日もやる（休みをやめる）' : '今日だけ休む（くり返しはそのまま）';
        ed.toggleSkip = function () { self.skipToday(E.id, !E.skipToday); };
        ed.once = !!E.once;
        ed.date = E.date || '';
        ed.set.date = function (ev) { self.editSet('date', ev.target.value); };
        var tdy = (self.state.data || {}).today || ymd(new Date()), tmr = (function () { var x = parseYmd(tdy); x.setDate(x.getDate() + 1); return ymd(x); })();
        ed.dateChips = [[tdy, '今日'], [tmr, '明日']].map(function (x) { var on = E.date === x[0]; return { label: x[1], pressed: on ? 'true' : 'false', style: chip(on), pick: function () { self.editSet('date', x[0]); } }; });
        ed.kindChips = [['once', '日にちを決める'], ['repeat', 'くり返し']].map(function (k) { var on = (k[0] === 'once') === !!E.once; return { label: k[1], pressed: on ? 'true' : 'false', style: chip(on), pick: function () { self.editSet('once', k[0] === 'once'); } }; });
        ed.repeat = !E.once;
        var days = ruleDays(E.rule || '毎日');
        ed.dayChips = DOWS.map(function (dn, i) { return { label: dn, pressed: days[i] ? 'true' : 'false', style: chip(days[i]) + '; flex: 1; min-width: 0; padding: 0', pick: function () {
          var cur = self.state.editor.rule || '毎日', on2 = ruleDays(cur);
          if (cur === '毎日') { on2 = DOWS.map(function (_, k) { return k === i; }); }   /* 「毎日」から曜日を押したら、その曜日だけにする */
          else { on2[i] = !on2[i]; if (!on2.some(Boolean)) return; }
          self.editSet('rule', daysRule(on2));
        } }; });
        ed.ruleText = ruleWords(E.rule || '毎日');
        ed.rulePresets = [['毎日', '毎日'], ['平日', '平日'], ['土日', '土日']].map(function (r) { var on = (E.rule || '毎日') === r[0]; return { label: r[1], pressed: on ? 'true' : 'false', style: chip(on), pick: function () { self.editSet('rule', r[0]); } }; });
        ed.save = function () { self.saveDuty(); }; ed.del = function () { self.deleteDuty(); };
      } else if (E.kind === 'shop') {
        ed.catChips = shopCats.map(function (c) { var on = E.cat === c; return { label: c, pressed: on ? 'true' : 'false', style: chip(on, '#2C6B52'), pick: function () { self.editSet('cat', c); } }; });
        ed.save = function () { self.saveShopEdit(); }; ed.del = function () { self.deleteShop(); };
      } else if (E.kind === 'decide') {
        ed.save = function () { self.saveDecision(); }; ed.del = function () { self.deleteDecision(); };
      } else if (E.kind === 'deadline') {
        ed.whoChips = names.concat(['家族']).map(function (n) { var on = E.who === n; return { label: n, pressed: on ? 'true' : 'false', style: chip(on, self.person(n).ink), pick: function () { self.editSet('who', n); } }; });
        ed.save = function () { self.saveDeadline(); }; ed.del = function () { self.deleteDeadline(); };
      } else if (E.kind === 'menu') {
        ed.heading += '　' + E.dateLabel;
        ed.hotcookPressed = E.hotcook ? 'true' : 'false';
        ed.hotcookStyle = chip(!!E.hotcook, '#8A6A0E') + '; align-self: flex-start';
        ed.toggleHotcook = function () { self.editSet('hotcook', !self.state.editor.hotcook); };
        ed.save = function () { self.saveMenu(); }; ed.del = function () { self.deleteMenu(); };
      } else if (E.kind === 'outing') {
        ed.okindChips = ['公園', '行くところ', 'イベント'].map(function (k) { var on = E.okind === k; return { label: k, pressed: on ? 'true' : 'false', style: chip(on, '#2C6B52'), pick: function () { self.editSet('okind', k); } }; });
        ed.save = function () { self.saveOuting(); }; ed.del = function () { self.deleteOuting(); };
      } else {
        ed.save = function () { self.saveTopic(); }; ed.del = function () { self.deleteTopic(); };
      }
      ed.close = function () { self.setState({ editor: null }); };
      ed.noTimeOn = E.kind === 'duty' && !E.time;
      ed.noTime = ed.noTimeOn ? 'true' : 'false';
      ed.noTimeStyle = chip(ed.noTimeOn) + '; flex-shrink: 0; min-height: 48px';
      ed.toggleNoTime = function () { var e2 = self.state.editor; self.editSet('time', e2.time ? '' : (e2.lastTime || pad(Math.min(23, new Date().getHours() + 1)) + ':00')); if (e2.time) self.editSet('lastTime', e2.time); };
      /* 消すは2回押し：1回目で「本当に消す」に変わる */
      var del0 = ed.del;
      ed.delLabel = E.confirmDel ? '本当に消す（もう一度押す）' : '消す';
      ed.delStyle = 'min-height: 48px; border-radius: 14px; font-size: 15px; font-weight: 700; cursor: pointer; ' + (E.confirmDel ? 'border: none; background: #A3355D; color: #FFFFFF' : 'border: 1.5px solid #C9A1B0; background: transparent; color: #7A2645');
      ed.del = function () {
        if (self.state.editor && self.state.editor.confirmDel) { del0(); return; }
        self.editSet('confirmDel', true);
        clearTimeout(self.delTimer);
        self.delTimer = setTimeout(function () { if (self.state.editor && self.state.editor.confirmDel) self.editSet('confirmDel', false); }, 4000);
      };
    }

    var lazy = {};
    var skelH = { diary: 260, week: 540, shop: 520, plan: 400, news: 520 };
    this.lazyIds.forEach(function (id) {
      var m = !!st.mounted[id], s = !!st.seen[id];
      lazy[id] = {
        on: m, off: !m,
        wrapStyle: 'transition: opacity .8s cubic-bezier(.2,.8,.2,1), transform .8s cubic-bezier(.2,.8,.2,1); ' + (s ? 'opacity: 1; transform: none' : 'opacity: 0; transform: translateY(32px)'),
        skelStyle: 'margin: 24px 20px 8px; height: ' + skelH[id] + 'px; border-radius: 20px; background: linear-gradient(90deg, #DDE3DA 0%, #E9EDE6 50%, #DDE3DA 100%); background-size: 780px 100%; animation: shimmer 1.4s linear infinite'
      };
    });

    /* ピックアップニュース */
    var goals = [{ id: 'all', label: 'すべて' }].concat(D.goals || []);
    var newsRaw = D.news || [];
    var goalId = st.goal || 'all';
    var curGoal = goals.filter(function (g) { return g.id === goalId; })[0] || goals[0];
    var goalChips = goals.map(function (g) {
      var on = g.id === goalId;
      var cnt = g.id === 'all' ? newsRaw.length : newsRaw.filter(function (n) { return n.goals.indexOf(g.id) >= 0; }).length;
      return {
        label: g.label, count: cnt, pressed: on ? 'true' : 'false',
        pick: function () { self.setState({ goal: g.id, newsOpen: {}, goalAnim: (self.state.goalAnim || 0) + 1 }); },
        style: 'flex-shrink: 0; display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 14px; border-radius: 999px; border: none; font-size: 14px; font-weight: 700; cursor: pointer; transition: background .2s, color .2s; ' + (on ? 'background: #17201B; color: #FFFFFF' : 'background: #FFFFFF; color: #17201B'),
        countStyle: 'min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; ' + (on ? 'background: rgba(255,255,255,.2)' : 'background: #EEF1EC; color: #55605A')
      };
    });
    var news = newsRaw.filter(function (n) { return goalId === 'all' || n.goals.indexOf(goalId) >= 0; }).map(function (n) {
      var open = !!st.newsOpen[n.id];
      var web = n.src === 'Web';
      return {
        title: n.title, why: n.why, body: n.body, url: n.url, src: n.src, meta: n.from + (n.date ? '（' + n.date + '）' : ''),
        open: false, expanded: 'false', more: (rCount['news:' + n.id] ? '詳細を見る（コメント' + rCount['news:' + n.id] + '件）' : '詳細を見る'),
        toggle: function () { self.openDetail('news', n.id); },
        srcStyle: 'padding: 3px 8px; border-radius: 6px; font-size: 12px; font-weight: 900; ' + (web ? 'background: #E3E7F6; color: #3046A6' : 'background: #F3E8D6; color: #8A5A12'),
        cardStyle: 'flex-shrink: 0; width: 290px; box-sizing: border-box; scroll-snap-align: start; display: flex; flex-direction: column; gap: 8px; min-height: 230px; padding: 16px; border-radius: 20px; background: #FFFFFF; animation: ' + ((st.goalAnim || 0) % 2 ? 'slideA' : 'slideB') + ' .4s cubic-bezier(.2,.8,.2,1) both'
      };
    });

    /* 予定：今日から2週間を、押さなくても見えるように。上は2段×7日のカレンダー（何日も続く予定は帯）、下は日ごとの一覧 */
    var pStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var dayOf = function (s) { return Math.round((parseYmd(s) - pStart) / 864e5); };
    var planN = D.plansTo ? Math.max(1, Math.min(14, dayOf(D.plansTo) + 1)) : 7;
    var plansRaw = (D.plans || []).map(function (p) { return Object.assign({}, p, { d: dayOf(p.date) }); }).filter(function (p) { return p.d >= 0 && p.d < planN && (whoSel === 'all' || p.who === whoSel || p.who === '家族'); });
    var md = function (s) { var x = parseYmd(s); return (x.getMonth() + 1) + '/' + x.getDate(); };
    var byTime = function (a, b) { var ta = /^\d/.test(a.time || '') ? a.time.replace(/^(\d):/, '0$1:') : '99'; var tb = /^\d/.test(b.time || '') ? b.time.replace(/^(\d):/, '0$1:') : '99'; return ta < tb ? -1 : (ta > tb ? 1 : 0); };
    /* 続く予定をまとめる（key ごと）。帯の段（レーン）を、始まりが早い・長い順に詰めて決める */
    var spans = {}, spanList = [];
    plansRaw.forEach(function (p) {
      if (!p.key) return;
      var g = spans[p.key];
      if (!g) { g = spans[p.key] = { key: p.key, what: p.what, who: p.who, from: p.from, to: p.to, d0: p.d, d1: p.d, time: '' }; spanList.push(g); }
      g.d0 = Math.min(g.d0, p.d); g.d1 = Math.max(g.d1, p.d);
      if (p.date === p.from && /^\d/.test(p.time || '')) g.time = p.time;
    });
    spanList.sort(function (a, b) { return a.d0 - b.d0 || (b.d1 - b.d0) - (a.d1 - a.d0); });
    var laneEnd = [], PLAN_LANES = 2;
    spanList.forEach(function (g) {
      var l = 0; while (l < laneEnd.length && laneEnd[l] >= g.d0) l++;
      g.lane = l; laneEnd[l] = g.d1;
    });
    var singles = plansRaw.filter(function (p) { return !p.key; });
    var planWeeks = [0, 1].filter(function (w) { return w * 7 < planN; }).map(function (w) {
      var lanes = 0;
      spanList.forEach(function (g) { if (g.lane < PLAN_LANES && g.d1 >= w * 7 && g.d0 <= w * 7 + 6) lanes = Math.max(lanes, g.lane + 1); });
      var cells = [], chips = [], bands = [];
      for (var c = 0; c < 7; c++) {
        var i = w * 7 + c;
        var dt = new Date(pStart.getFullYear(), pStart.getMonth(), pStart.getDate() + i), dw = dt.getDay(), dstr = ymd(dt);
        var off = i >= planN;
        var mine = singles.filter(function (p) { return p.d === i; }).sort(byTime);
        var extra = spanList.filter(function (g) { return g.lane >= PLAN_LANES && g.d0 <= i && g.d1 >= i; });
        var shown = mine.slice(0, 3);
        var more = mine.length - shown.length + extra.length;
        var col = c + 1;
        var ink = dw === 0 ? '#C0392B' : (dw === 6 ? '#2F5DA8' : '#17201B');
        cells.push({
          dow: i === 0 ? '今日' : DOWS[dw], date: dt.getDate() === 1 || c === 0 ? (dt.getMonth() + 1) + '/' + dt.getDate() : String(dt.getDate()),
          aria: (i === 0 ? '今日 ' : '') + (dt.getMonth() + 1) + '月' + dt.getDate() + '日' + DOWS[dw] + '曜、予定' + (mine.length + spanList.filter(function (g) { return g.d0 <= i && g.d1 >= i; }).length) + '件',
          go: (function (day) { return function () { self.planJump(day); }; })(dstr),
          style: 'grid-column: ' + col + '; grid-row: 1 / -1; border: none; padding: 0; margin: 0; font: inherit; cursor: pointer; border-radius: 12px; min-width: 0; ' + (i === 0 ? 'background: #17201B; ' : (dw === 0 || dw === 6 ? 'background: #F3F5EF; ' : 'background: #FFFFFF; ')) + (off ? 'opacity: .35; ' : '') + 'display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start',
          headStyle: 'display: flex; flex-direction: column; align-items: center; padding: 6px 0 4px; line-height: 1.15; color: ' + (i === 0 ? '#FFFFFF' : ink),
        });
        chips.push({
          style: 'grid-column: ' + col + '; grid-row: ' + (lanes + 2) + '; pointer-events: none; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 2px 2px 6px',
          list: shown.map(function (p) {
            var pc = self.person(p.who);
            return { text: p.what, style: 'display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 10px; line-height: 13px; max-height: 28px; box-sizing: border-box; font-weight: 700; overflow: hidden; word-break: break-all; border-radius: 4px; padding: 1px 3px; border-bottom: 1px solid transparent; color: ' + pc.ink + '; background: ' + (i === 0 ? '#FFFFFF' : pc.tint) };
          }),
          more: more > 0 ? '+' + more : '', moreStyle: 'font-size: 10px; font-weight: 700; padding-left: 3px; color: ' + (i === 0 ? '#FFFFFF' : '#55605A')
        });
      }
      spanList.forEach(function (g) {
        if (g.lane >= PLAN_LANES || g.d1 < w * 7 || g.d0 > w * 7 + 6) return;
        var c0 = Math.max(g.d0, w * 7) - w * 7, c1 = Math.min(g.d1, w * 7 + 6) - w * 7;
        var pc = self.person(g.who);
        var dayStr = function (n) { return ymd(new Date(pStart.getFullYear(), pStart.getMonth(), pStart.getDate() + n)); };
        var openL = g.d0 < w * 7 || g.from < dayStr(g.d0), openR = g.d1 > w * 7 + 6 || g.to > dayStr(g.d1);
        var rl = openL ? '0' : '8px', rr = openR ? '0' : '8px';
        bands.push({
          text: (openL ? '… ' : '') + g.what,
          style: 'grid-column: ' + (c0 + 1) + ' / ' + (c1 + 2) + '; grid-row: ' + (g.lane + 2) + '; pointer-events: none; margin: 1px ' + (openR && c1 < 6 ? '-3px' : (openR ? '0' : '2px')) + ' 1px ' + (openL ? '0' : '2px') + '; height: 15px; box-sizing: border-box; border-radius: ' + rl + ' ' + rr + ' ' + rr + ' ' + rl + '; padding: 0 6px; font-size: 10px; line-height: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; color: #FFFFFF; background: ' + pc.ink
        });
      });
      return { cells: cells, chips: chips, bands: bands, gridStyle: 'display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-template-rows: 40px' + (lanes ? ' repeat(' + lanes + ', 17px)' : '') + ' minmax(34px, auto); column-gap: 3px' };
    });
    /* 下の一覧：予定のある日だけ。続く予定は、見えている最初の日に「11/26〜12/3」で1回だけ */
    var planList = [];
    for (var pi = 0; pi < planN; pi++) {
      var pdt = new Date(pStart.getFullYear(), pStart.getMonth(), pStart.getDate() + pi), pds = ymd(pdt);
      var rows = singles.filter(function (p) { return p.d === pi; }).map(function (p) { return { time: p.time || '終日', what: p.what, who: p.who, sub: '' , t: p.time }; });
      spanList.forEach(function (g) {
        if (g.d0 !== pi) return;
        var started = g.from < pds;
        rows.push({ time: started ? 'つづき' : (g.time || '終日'), what: g.what, who: g.who, sub: started ? md(g.to) + 'まで' : md(g.from) + '〜' + md(g.to), t: started ? '' : g.time });
      });
      if (!rows.length) continue;
      rows.sort(function (a, b) { return byTime({ time: a.t }, { time: b.t }); });
      var dwi = pdt.getDay();
      planList.push({
        id: 'plan-d-' + pds,
        label: (pi === 0 ? '今日 ' : (pi === 1 ? '明日 ' : '')) + (pdt.getMonth() + 1) + '/' + pdt.getDate() + '（' + DOWS[dwi] + '）',
        labelStyle: 'margin: 0; padding: 12px 0 2px; font-size: 13px; font-weight: 900; color: ' + (pi === 0 ? '#2C6B52' : (dwi === 0 ? '#C0392B' : (dwi === 6 ? '#2F5DA8' : '#55605A'))),
        rows: rows.map(function (r) { return { time: r.time, what: r.what, sub: r.sub, hasSub: !!r.sub, who: r.who, badgeStyle: self.badge(r.who) }; })
      });
    }
    var planTotal = singles.length + spanList.length;

    var notesSorted = notesAll.slice().sort(function (a, b) { return (a.read === b.read) ? b.createdAt - a.createdAt : (a.read ? 1 : -1); });
    var myUnread = notesAll.filter(function (n) { return !n.read && n.to === meWho; });
    var unreadAll = notesAll.filter(function (n) { return !n.read; });
    var newReplies = notesAll.filter(function (n) { return marks['notes:' + n.id]; });
    var o = this.order();
    var cur = o.length ? st.slideIdx % o.length : 0;
    var syncLabel = st.syncing ? '更新中…' : (st.offline ? 'オフライン' : meWho);
    var nb = /^\d{4}-\d{2}-\d{2}$/.test(ui.kidsBirth || '') ? parseYmd(ui.kidsBirth) : null;

    /* セクションの見出し・表示・順番（スプレッドシートの「画面」） */
    var SEC_DEF = [['photos', '写真'], ['hero', 'つぎの担当'], ['flow', '今日の流れ'], ['decide', 'ふたりで決めること'], ['deadline', '期限があるもの'], ['topics', '話題'], ['diary', '今日の日記'], ['week', '今週のごはん'], ['shop', '買い物リスト'], ['weekend', '今週末'], ['plan', 'これからの予定'], ['news', 'ピックアップニュース']];
    var todayStr = ymd(now);
    var travel = !!(ui.tripFrom && ui.tripTo && todayStr >= ui.tripFrom && todayStr <= ui.tripTo);
    /* 時刻で並びを変える：朝（朝の並びにする時刻〜終える時刻）・日中（ふだんの順番）・夜（夜の並びにする時刻〜）。
       時刻の欄が空ならその並びは使わない（古いGASは eveningFrom だけ送ってくる） */
    var tm = function (v, dflt) { return v === undefined ? dflt : (v === null || v === '' ? null : Number(v)); };
    var mFrom = tm(ui.morningFrom, null), mTo = tm(ui.morningTo, null), eFrom = tm(ui.eveningFrom, 1080);
    var morning = mFrom != null && mTo != null && nowMin >= mFrom && nowMin < mTo;
    var evening = !morning && eFrom != null && nowMin >= eFrom;
    /* 「いつもの並びにする」を押したら、その並び（朝・夜・旅行）が終わるまでふだんの並び */
    var modeKey = travel ? 'travel:' + ui.tripFrom + '~' + ui.tripTo : morning ? 'morning:' + todayStr : evening ? 'evening:' + todayStr : '';
    var plain = !!modeKey && LS.get('orderPlain') === modeKey;
    var modeName = travel ? '旅行中' : morning ? '朝' : evening ? '夜' : '';
    if (plain) { travel = false; morning = false; evening = false; }
    var hhmmOf = function (m) { return Math.floor(m / 60) + ':' + pad(m % 60); };
    var orderBanner = !modeKey ? { show: false } : {
      show: true,
      text: plain ? 'いつもの並びで出しています（' + modeName + 'の並びを止めています）'
        : travel ? '旅行中なので、旅行に関係するところだけ出しています（' + (function (t) { var x = parseYmd(t); return (x.getMonth() + 1) + '/' + x.getDate(); })(ui.tripTo) + 'まで）'
        : morning ? '朝の並びです（' + hhmmOf(mTo) + 'まで）'
        : '夜の並びです（' + hhmmOf(eFrom) + 'から）',
      btn: plain ? modeName + 'の並びに戻す' : 'いつもの並びにする',
      toggle: function () {
        if (plain) LS.del('orderPlain'); else LS.set('orderPlain', modeKey);
        USAGE.add('act:order_' + (plain ? 'auto' : 'plain'));
        self.setState({ orderTick: Date.now() });
      },
      style: 'display: flex; align-items: center; gap: 10px; margin: 0 16px 12px; padding: 8px 8px 8px 14px; border-radius: 14px; font-size: 13px; font-weight: 700; line-height: 1.5; ' + (travel ? 'background: #E3E7F6; color: #22337A' : 'background: #E6ECE4; color: #2C3A31')
    };
    var secCfg = ui.sections && ui.sections.length ? ui.sections : SEC_DEF.map(function (x, k) { return { key: x[0], title: x[1], all: true, person: x[0] !== 'photos', order: k }; });
    var secByKey = {}; secCfg.forEach(function (c) { secByKey[c.key] = c; });
    var title = {}, sections = [];
    SEC_DEF.forEach(function (x) { title[x[0]] = (secByKey[x[0]] && secByKey[x[0]].title) || x[1]; });
    var secAll = secCfg.concat(SEC_DEF.filter(function (x) { return !secByKey[x[0]]; }).map(function (x, k) { return { key: x[0], title: x[1], all: true, person: true, order: 50 + k, evening: 50 + k, travel: true }; }));
    /* 夜（設定の時刻から）は「夜の順番」、旅行中は話題を一番上に */
    var ordOf = function (c) {
      if (c.key === 'photos') return -2;   /* 写真は見出しなので、いつも一番上 */
      if (travel && c.key === 'topics') return -1;
      if (morning && c.morning != null) return c.morning;
      if (evening && c.evening != null) return c.evening;
      return c.order != null ? c.order : 99;
    };
    /* 下のタブ：セクションごとに「画面」の「下のタブ」。旅行中は話題を最初のタブへ */
    var tabOf = function (c) { if (travel && c.key === 'topics') return TAB_ORDER[0]; return c.tab || DEF_TAB[c.key] || TAB_ORDER[0]; };
    var shown = [], tabHas = {};
    secAll.slice().sort(function (a, b) { return ordOf(a) - ordOf(b); }).forEach(function (c) {
      var vis = whoSel === 'all' ? c.all !== false : c.person !== false;
      if (c.viewer && c.viewer !== meWho) vis = false;        /* 見る人が決まっているセクションは、その人がログインした時だけ */
      if (travel && c.travel === false) vis = false;           /* 旅行中は印のあるセクションだけ */
      if (vis) tabHas[tabOf(c)] = true;
      shown.push({ c: c, vis: vis });
    });
    var tabNames = TAB_ORDER.filter(function (t) { return tabHas[t]; });
    secAll.forEach(function (c) { var t = tabOf(c); if (tabHas[t] && tabNames.indexOf(t) < 0) tabNames.push(t); });
    var curTab = tabNames.indexOf(st.nav) >= 0 ? st.nav : tabNames[0];
    var isHome = curTab === tabNames[0];   /* ホーム（最初のタブ）は全部のセクションを出し、長い一覧は少しだけ */
    var tileMode = st.homeStyle === 'b' && isHome;   /* ホームの見た目 B：タイル（写真と「つぎの担当」はタイルの中に出す） */
    var secTab = {}; secAll.forEach(function (c) { secTab[c.key] = tabOf(c); });
    /* 並びは CSS の order で変える（DOM の順は変えない。入れ替えると描き直しで要素が使い回されて崩れるため） */
    var seq0 = !isHome && TAB_SEQ[TAB_ID[curTab]];
    var rankOf = {};
    shown.map(function (x, i) { return [x.c.key, i]; }).sort(function (a, b) {
      var ra = seq0 ? (seq0.indexOf(a[0]) < 0 ? 50 : seq0.indexOf(a[0])) : 0, rb = seq0 ? (seq0.indexOf(b[0]) < 0 ? 50 : seq0.indexOf(b[0])) : 0;
      return (ra - rb) || (a[1] - b[1]);
    }).forEach(function (a, i) { rankOf[a[0]] = i; });
    var visOf = {}; shown.forEach(function (x) { visOf[x.c.key] = x.vis && (isHome || tabOf(x.c) === curTab) && !(tileMode && (x.c.key === 'photos' || x.c.key === 'hero')); });
    SEC_DEF.map(function (d) { return d[0]; }).concat(shown.map(function (x) { return x.c.key; }).filter(function (k) { return !SEC_DEF.some(function (d) { return d[0] === k; }); })).forEach(function (k) {
      if (!(k in visOf)) return;
      var o2 = { key: k, vis: !!visOf[k], wrapStyle: visOf[k] ? 'order: ' + rankOf[k] : 'display: none' };
      SEC_DEF.forEach(function (d) { o2['is_' + d[0]] = d[0] === k; });
      sections.push(o2);
    });
    /* ホーム以外のタブは短いので、遅れて出す仕組みを使わずにすぐ出す（並べ替えで見張りが外れても空白にならない） */
    if (!isHome) Object.keys(lazy).forEach(function (id) { lazy[id].on = true; lazy[id].off = false; lazy[id].wrapStyle = 'opacity: 1; transform: none'; });
    /* 自分の番：自分宛ての未確認の申し送りと、まだ答えていない相談 */
    var myTurnDecide = (D.decisions || []).filter(function (x) { return x.state !== '決まった' && !(me1 ? x.a1 : x.a2); }).length;
    var twoTab = tabOf(secByKey.decide || { key: 'decide' });
    var navTabs = tabNames.map(function (t) {
      var badge = t === twoTab ? myUnread.length + newReplies.length + myTurnDecide : 0;
      var on = t === curTab;
      return {
        label: TAB_LABEL[t] || t, ic_today: TAB_ID[t] === 'today' || !TAB_ID[t], ic_two: TAB_ID[t] === 'two', ic_food: TAB_ID[t] === 'food', ic_plan: TAB_ID[t] === 'plan', ic_news: TAB_ID[t] === 'news', current: on ? 'page' : 'false', badge: badge, hasBadge: badge > 0,
        aria: (TAB_LABEL[t] || t) + (badge ? '（あなたの番 ' + badge + '件）' : ''),
        style: 'position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 52px; border: none; border-radius: 16px; color: #FFFFFF; font-size: 11px; font-weight: 700; cursor: pointer; transition: background .25s; background: ' + (on ? 'rgba(255,255,255,0.18)' : 'transparent'),
        go: function () {
          if (on) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
          USAGE.add('nav:' + (TAB_ID[t] || 'n' + tabNames.indexOf(t)));
          self.setState({ nav: t });
          window.scrollTo(0, 0);
        }
      };
    });
    /* 上の見出し（ファーストビュー）：時間帯で色とあいさつを変え、今日の進み具合・自分の番・旅行までの日数・新着を出す */
    var hdr = (function () {
      var h = Math.floor(nowMin / 60);
      var tod = h < 5 ? 'night' : h < 10 ? 'morning' : h < 17 ? 'day' : 'night';
      var tripNow = !!(ui.tripFrom && ui.tripTo && todayStr >= ui.tripFrom && todayStr <= ui.tripTo);
      var bg = tripNow ? 'linear-gradient(135deg, #0E7C86 0%, #14527A 100%)'
        : tod === 'morning' ? 'linear-gradient(135deg, #F2A33A 0%, #D9573B 100%)'
        : tod === 'day' ? 'linear-gradient(135deg, #2C6B52 0%, #17402F 100%)'
        : 'linear-gradient(135deg, #2B3A7A 0%, #1B1F3B 100%)';
      var greet = (tod === 'morning' ? 'おはよう、' : tod === 'day' ? 'こんにちは、' : 'おつかれさま、') + meWho;
      var tot = mine.length, dn = mine.filter(function (d) { return done[d.id]; }).length;
      var turn = myUnread.length + myTurnDecide;
      var onPhoto = curTab === tabNames[0] && sections.some(function (x) { return x.key === 'photos' && x.vis; });
      var chip = function (on) { if (onPhoto) return 'flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 86px; min-height: 56px; padding: 8px 12px; box-sizing: border-box; border-radius: 16px; border: none; text-align: left; cursor: pointer; font-family: inherit; box-shadow: 0 2px 8px rgba(23,32,27,0.06); color: ' + (on ? '#FFFFFF' : '#17201B') + '; background: ' + (on ? '#17201B' : '#FFFFFF');
        return 'flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 92px; min-height: 56px; padding: 8px 12px; box-sizing: border-box; border-radius: 16px; border: none; text-align: left; cursor: pointer; font-family: inherit; color: ' + (on ? '#17201B' : '#FFFFFF') + '; background: ' + (on ? '#FFFFFF' : 'rgba(255,255,255,0.14)'); };
      var chips = [];
      chips.push({ k: '今日の担当', v: tot ? dn + ' / ' + tot : 'なし', sub: tot && dn === tot ? 'ぜんぶ終わり' : '', style: chip(false),
        go: function () { if (curTab !== tabNames[0]) self.setState({ nav: tabNames[0] }); setTimeout(function () { var el = document.querySelector('[data-sec="flow"]'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 80); } });
      chips.push({ k: 'あなたの番', v: turn ? turn + '件' : 'なし', sub: '', style: chip(turn > 0),
        go: function () { self.setState({ nav: twoTab }); window.scrollTo(0, 0); } });
      var newChip = function (n) { return { k: '新着', v: n + '件', sub: '', style: chip(true),
        go: function () { if (curTab !== tabNames[0]) self.setState({ nav: tabNames[0] }); setTimeout(function () { var el = document.querySelector('[data-new]'); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 80); } }; };
      if (ui.tripFrom && ui.tripTo) {
        var dTo = Math.round((parseYmd(ui.tripFrom) - parseYmd(todayStr)) / 864e5);
        if (tripNow) chips.push({ k: '旅行', v: (Math.round((parseYmd(todayStr) - parseYmd(ui.tripFrom)) / 864e5) + 1) + '日目', sub: '', style: chip(false), go: function () {} });
        else if (dTo > 0 && dTo <= 120) chips.push({ k: '旅行まで', v: 'あと' + dTo + '日', sub: '', style: chip(false), go: function () {} });
      }
      var streak = D.streak || 0;
      if (streak >= 2) chips.splice(1, 0, { k: '全部できた日', v: '連続' + streak + '日', sub: '', style: chip(false), go: function () {} });
      var W = D.weather, wx = null;
      if (W && W.max != null && W.min != null) {
        var c = W.code, kind = c === 0 ? ['晴れ', 'sun'] : c <= 2 ? ['晴れときどき曇り', 'part'] : c === 3 ? ['曇り', 'cloud'] : c <= 48 ? ['霧', 'cloud'] : c <= 67 || (c >= 80 && c <= 82) ? ['雨', 'rain'] : c <= 77 || c === 85 || c === 86 ? ['雪', 'snow'] : ['雷雨', 'rain'];
        wx = { label: (W.place && tripNow ? W.place + '　' : '') + kind[0], temp: W.max + '° / ' + W.min + '°', pop: W.pop != null ? '雨 ' + W.pop + '%' : '', place: W.place || '', kind: kind[0], max: W.max + '°', minPop: '最低' + W.min + '°' + (W.pop != null ? '・雨' + W.pop + '%' : ''),
          sun: kind[1] === 'sun', part: kind[1] === 'part', cloud: kind[1] === 'cloud', rain: kind[1] === 'rain', snow: kind[1] === 'snow' };
      }
      var dd = now;
      /* ホーム以外は、そのタブの目的に合わせた短い見出し */
      var tid = TAB_ID[curTab] || '';
      var soon = (D.deadlines || []).filter(function (x) { return !x.done && x.due && Math.round((parseYmd(x.due) - parseYmd(todayStr)) / 864e5) <= 3; }).length;
      var sum = tid === 'two' ? [turn ? 'あなたの番 ' + turn + '件' : 'あなたの番はありません', soon ? '3日以内の期限 ' + soon + '件' : '']
        : tid === 'food' ? ['今日：' + dayMenu.dish, total ? '買い物 のこり' + (total - got) + '品' : '']
        : tid === 'plan' ? [planTotal ? (planN >= 14 ? '2週間' : planN + '日') + 'の予定 ' + planTotal + '件' : (planN >= 14 ? '2週間' : planN + '日') + 'の予定はまだありません', (ui.tripFrom && !tripNow && Math.round((parseYmd(ui.tripFrom) - parseYmd(todayStr)) / 864e5) > 0) ? '旅行まで あと' + Math.round((parseYmd(ui.tripFrom) - parseYmd(todayStr)) / 864e5) + '日' : '']
        : tid === 'news' ? ['いまのやることに関係するニュース', ''] : ['', ''];
      var isHomeTab = curTab === tabNames[0];
      var photoHero = isHomeTab && sections.some(function (x) { return x.key === 'photos' && x.vis; });
      return {
        big: isHomeTab && !photoHero && st.homeStyle !== 'b', small: !isHomeTab, inPhoto: photoHero, newChip: newChip,
        tot: tot, dn: dn, turn: turn, streak: D.streak || 0, twoTab: twoTab, showWho: tid !== 'food' && tid !== 'news',   /* 人で絞っても変わらないタブには出さない */
        smallTitle: TAB_LABEL[curTab] || curTab, smallSum: sum.filter(String).join('　・　'),
        smallStyle: 'margin: 10px 12px 0; padding: 16px 18px 14px; border-radius: 24px; display: flex; flex-direction: column; gap: 10px; color: #FFFFFF; background: ' + bg,
        wx: wx, hasWx: !!wx,
        style: 'position: relative; overflow: hidden; margin: 10px 12px 0; padding: 18px 18px 16px; border-radius: 28px; color: #FFFFFF; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 14px 34px rgba(23,32,27,0.22); background: ' + bg,
        greet: greet,
        date: (dd.getMonth() + 1) + '月' + dd.getDate() + '日（' + DOWS[dd.getDay()] + '）',
        chips: chips
      };
    })();
    var notesHere = curTab === twoTab || (isHome && myUnread.length > 0);

    var R = {
      sections: sections, title: title, planNote: '', travelOn: travel, orderBanner: orderBanner,
      hdr: hdr, seeAll: function () { self.seeAll(); },
      navTabs: navTabs, navStyle: 'position: fixed; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); max-width: 456px; margin: 0 auto; box-sizing: border-box; display: grid; grid-template-columns: repeat(' + Math.max(1, navTabs.length) + ', minmax(0, 1fr)); gap: 2px; padding: 6px; border-radius: 22px; background: rgba(23,32,27,0.88); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); box-shadow: 0 10px 30px rgba(23,32,27,0.28); z-index: 25',
      notesHere: notesHere,
      notesCardText: myUnread.length || newReplies.length ? [myUnread.length ? 'あなた宛てが ' + myUnread.length + '件' : '', newReplies.length ? '新しい返信が ' + newReplies.length + '件' : ''].filter(String).join('、') + 'あります' : (unreadAll.length ? '未確認が ' + unreadAll.length + '件（相手の確認待ち）' : '未確認はありません'),
      notesCardStyle: 'display: flex; align-items: center; gap: 12px; width: calc(100% - 32px); margin: 0 16px 16px; box-sizing: border-box; min-height: 64px; padding: 12px 16px; border-radius: 20px; text-align: left; cursor: pointer; font-family: inherit; color: #17201B; border: ' + (myUnread.length || newReplies.length ? '2px solid #F2A33A' : '1.5px solid #DDE3DA') + '; background: #FFFFFF',
      travelText: travel ? '旅行中なので、旅行に関係するところだけ出しています（' + (function (t) { var x = parseYmd(t); return (x.getMonth() + 1) + '/' + x.getDate(); })(ui.tripTo) + 'まで）' : '',
      decisions: decisions, decisionsEmpty: decisions.length === 0, addDecision: function () { self.openDecision(null); },
      deadlines: deadlines, deadlinesEmpty: deadlines.length === 0, addDeadline: function () { self.openDeadline(null); },
      outings: outings, outingsEmpty: outings.length === 0, addOuting: function () { self.openOuting(null); },
      menuToShop: function () { self.menuToShop({ dish: dayMenu.dish, ingredients: dayMenu.ingredients }); },
      editMenu: function () { self.openMenu(dmDate, dmReal); }, editMenuLabel: dmReal ? '献立を直す' : '献立を入れる', hasMenu: !!dmReal, hasIngredients: dayMenu.ingredients.length > 0,
      flowEdit: !!st.flowEdit, flowNormal: !st.flowEdit, flowEditRows: flowEditRows, flowEditEmpty: flowEditRows.length === 0,
      flowEditLabel: st.flowEdit ? '完了' : '直す',
      toggleFlowEdit: function () { self.setState({ flowEdit: !self.state.flowEdit }); },
      addDuty: function () { self.openDuty(null); },
      shopEdit: !!st.shopEdit, shopEditLabel: st.shopEdit ? '完了' : '直す・消す',
      toggleShopEdit: function () { self.setState({ shopEdit: !self.state.shopEdit }); },
      shopDraft: st.shopDraft, shopQty: st.shopQty,
      setShopDraft: function (e) { self.setState({ shopDraft: e.target.value }); },
      setShopQty: function (e) { self.setState({ shopQty: e.target.value }); },
      shopKey: function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); self.addShopFromForm(); } },
      addShop: function () { self.addShopFromForm(); },
      shopCatChips: shopCats.map(function (c) { var on = c === shopCatSel; return { label: c, pressed: on ? 'true' : 'false', style: chip(on, '#2C6B52'), pick: function () { self.setState({ shopCat: c }); } }; }),
      shopSuggest: shopSuggest, hasSuggest: shopSuggest.length > 0,
      topics: topics, topicsEmpty: topics.length === 0, topicEdit: !!st.topicEdit, topicEditLabel: st.topicEdit ? '完了' : '直す',
      toggleTopicEdit: function () { self.setState({ topicEdit: !self.state.topicEdit }); },
      addTopic: function () { self.openTopic(null); },
      ed: ed, edBackdropStyle: backdrop(!!E), edSheetStyle: sheetStyle(!!E, 'max-height: 88vh; overflow-y: auto; '),
      fbDraft: st.fbDraft, setFbDraft: function (e) { self.setState({ fbDraft: e.target.value }); },
      openFb: function () { self.setState({ fbOpen: true, accountOpen: false }); },
      closeFb: function () { self.setState({ fbOpen: false }); },
      sendFb: function () { self.sendFeedback(); },
      fbBackdropStyle: backdrop(st.fbOpen), fbSheetStyle: sheetStyle(st.fbOpen, ''),
      dt: (function () {
        var x = st.detail;
        if (!x) return { open: false, title: '', body: '', meta: '', kindLabel: '', hasUrl: false, url: '', lines: [], replies: [], empty: true, canReply: false, ctaLabel: '', hasCta: false, cta: function () {} };
        var KL = { topics: '話題', decide: 'ふたりで決めること', diary: '今日の日記', weekend: 'お出かけの候補', news: 'ニュース', deadline: '期限があるもの' };
        var find = function (list) { return (list || []).filter(function (y) { return String(y.id) === String(x.id); })[0]; };
        var it = null, title = '', body = '', meta = '', url = '', lines = [], cta = null;
        if (x.kind === 'topics' && (it = find(D.topics))) { title = it.title; body = it.note; url = it.url; meta = it.date || ''; cta = ['直す・消す', function () { self.setState({ detail: null }); self.openTopic(it); }]; }
        if (x.kind === 'decide' && (it = find(D.decisions))) {
          title = it.q; body = it.note; meta = it.due ? dueLabel(it.due) + 'まで' : '';
          lines = (it.options && it.options.length ? it.options : ['賛成', '反対']).map(function (o) { var w = []; if (it.a1 === o) w.push(names[0]); if (it.a2 === o) w.push(names[1]); return o + (w.length ? '　← ' + w.join('・') : ''); });
          if (it.state === '決まった') lines.push('決まった：' + it.decided);
          cta = ['閉じて、カードで答える', function () { self.setState({ detail: null }); }];
        }
        if (x.kind === 'diary' && (it = find(D.diary))) { title = (it.by || '') + 'の日記'; body = it.text; meta = it.time || ''; }
        if (x.kind === 'weekend' && (it = find(D.outings))) { title = it.name; body = it.note; url = it.url; meta = [it.kind, it.date, it.place].filter(String).join('・'); cta = ['直す・消す', function () { self.setState({ detail: null }); self.openOuting(it); }]; }
        if (x.kind === 'news' && (it = find(D.news))) { title = it.title; body = [it.why, it.body].filter(String).join('\n\n'); url = it.url; meta = it.from + (it.date ? '（' + it.date + '）' : ''); }
        var tgt = x.kind + ':' + x.id;
        var rs = (D.replies || []).filter(function (r) { return r.target === tgt; }).sort(function (a, b) { return a.at - b.at; }).map(function (r) {
          var d0 = new Date(r.at || 0), mine = r.who === meWho;
          return { who: r.who, text: r.text, time: r.at ? (d0.getMonth() + 1) + '/' + d0.getDate() + ' ' + d0.getHours() + ':' + pad(d0.getMinutes()) : '', badgeStyle: self.badge(r.who), mine: mine, del: function () { self.deleteReply(r.id); },
            style: 'display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 16px; ' + (mine ? 'background: #EEF1EC; margin-left: 28px' : 'background: #FFF6E8; margin-right: 28px') };
        });
        return { open: true, kindLabel: KL[x.kind] || '', title: it ? title : '（見つかりません。消されたかもしれません）', body: body || '', hasBody: !!body, meta: meta, hasMeta: !!meta, url: url || '', hasUrl: !!url,
          lines: lines.map(function (l) { return { text: l }; }), hasLines: lines.length > 0, replies: rs, empty: rs.length === 0, canReply: !!it,
          hasCta: !!cta, ctaLabel: cta ? cta[0] : '', cta: cta ? cta[1] : function () {} };
      })(),
      replyDraft: st.replyDraft, setReplyDraft: function (e) { self.setState({ replyDraft: e.target.value }); },
      sendReply: function () { self.sendReply(); }, closeDetail: function () { self.setState({ detail: null, replyDraft: '' }); },
      detailBackdropStyle: backdrop(!!st.detail), detailSheetStyle: sheetStyle(!!st.detail, 'max-height: 88vh; overflow-y: auto; '),
      museDraft: st.museDraft, setMuseDraft: function (e) { self.setState({ museDraft: e.target.value }); },
      closeMuse: function () { self.setState({ museOpen: false }); },
      museCopy: function () { self.museSend('copy'); }, museWa: function () { self.museSend('wa'); },
      hasMuseWa: !!String(LS.get('museWa') || '').replace(/[^\d]/g, ''), museWaNum: LS.get('museWa') || '',
      setMuseWaNum: function (e) { LS.set('museWa', e.target.value); self.setState({ museWaAt: Date.now() }); },
      openMuseAny: function () { self.openMuse('any'); }, openMuseMenu: function () { self.openMuse('menu'); },
      museBackdropStyle: backdrop(st.museOpen), museSheetStyle: sheetStyle(st.museOpen, 'max-height: 90vh; overflow-y: auto; '),
      appVersion: 'v' + APP_VERSION,
      lazy: lazy, goalChips: goalChips, news: news, newsCount: news.length, newsEmpty: news.length === 0,
      goalOn: goalId !== 'all', goalNext: curGoal.next || '', goalDue: curGoal.due || '',
      goalCardStyle: 'margin: 0 20px; padding: 12px 16px; border-radius: 16px; background: #E0EEE7; display: flex; flex-direction: column; gap: 4px; animation: rise .35s cubic-bezier(.2,.8,.2,1) both',
      planWeeks: planWeeks, planList: planList, plansEmpty: planTotal === 0, planTotal: planTotal, planRange: planN >= 14 ? '2週間' : planN + '日',
      planCardStyle: 'margin-top: 4px; background: #FFFFFF; border-radius: 20px; padding: 2px 16px 10px; display: flex; flex-direction: column',
      whoTabs: whoTabs, hero: hero, timeline: timeline, flow: flow, flowEmpty: flow.length === 0,
      prog: (function () {
        var tot = mine.length;
        var dn = mine.filter(function (d) { return done[d.id]; }).length;
        var p = tot ? Math.round(dn / tot * 100) : 0;
        var circ = 2 * Math.PI * 44;
        var ring = self.person(whoSel === 'all' ? '家族' : whoSel).ink;
        var msg = tot === 0 ? '今日の担当はありません' : (dn === 0 ? '今日もはじめよう' : (dn === tot ? '今日もおつかれさま' : (tot - dn === 1 ? 'あと1つ' : (p >= 50 ? 'いい調子。あと' + (tot - dn) + '件' : 'あと' + (tot - dn) + '件'))));
        var people = names.filter(function (nm) { return whoSel === 'all' || nm === whoSel; }).map(function (nm) {
          var list = duties.filter(function (d) { return d.who === nm; });
          var c = list.filter(function (d) { return done[d.id]; }).length;
          var col = self.person(nm).ink;
          return {
            name: nm, count: c + ' / ' + list.length, nameStyle: 'color: ' + col,
            barStyle: 'height: 100%; border-radius: 999px; background: ' + col + '; transition: width .6s cubic-bezier(.2,.8,.2,1); width: ' + (list.length ? c / list.length * 100 : 0) + '%'
          };
        });
        return {
          pct: p, count: dn + ' / ' + tot, message: msg,
          aria: '今日の担当 ' + tot + '件のうち ' + dn + '件完了（' + p + '%）',
          ringStyle: 'stroke: ' + ring + '; stroke-width: 11; stroke-linecap: round; stroke-dasharray: ' + circ.toFixed(2) + '; stroke-dashoffset: ' + (circ * (1 - p / 100)).toFixed(2) + '; transition: stroke-dashoffset .7s cubic-bezier(.2,.8,.2,1), stroke .4s',
          people: people
        };
      })(),
      diary: diaryAll.slice().reverse().map(function (k, i) {
        return { isNew: !!marks['diary:' + k.id], time: k.time + (k.by ? '　' + k.by : ''), text: k.text, more: moreOf('diary', k.id), textStyle: clamp(5, 'margin: 0; font-size: 14px; line-height: 1.7'), cardStyle: 'flex-shrink: 0; width: 240px; box-sizing: border-box; background: #FFF6E8; border-radius: 18px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; animation: rise .45s cubic-bezier(.2,.8,.2,1) ' + (i * 60) + 'ms both' };
      }),
      diaryCount: diaryAll.length ? diaryAll.length + '件' : '',
      diaryEmpty: diaryAll.length === 0,
      openDiaryNote: function () { self.openNoteFor('今日の日記', null); },
      noteTarget: st.noteTarget, noteDraft: st.noteDraft,
      isHandover: st.noteMode === 'handover',
      sheetKicker: st.noteMode === 'handover' ? '申し送りを書く' : '気づきを残す',
      sheetLabel: st.noteMode === 'handover' ? '伝えたいこと' : '気づいたこと',
      sheetPlaceholder: st.noteMode === 'handover' ? '例：お迎えのとき、上履きを持ち帰ってください' : '例：今日はお風呂を嫌がらずに入れた',
      saveLabel: st.noteMode === 'handover' ? '送る' : '日記に残す',
      setNoteDraft: function (e) { self.setState({ noteDraft: e.target.value }); },
      closeNote: function () { self.closeNote(); },
      saveNote: function () { self.saveNote(); },
      toggleMic: function () { self.toggleMic(); },
      listening: st.listening ? 'true' : 'false',
      listeningOn: !!st.listening,
      micHint: st.listening ? '聞いています。話し終わったら、もう一度押してください。' : 'マイクを押して話すと、文字になります。',
      micStyle: 'position: relative; width: 56px; height: 56px; flex-shrink: 0; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .2s, color .2s; ' + (st.listening ? 'background: #A3355D; color: #FFFFFF' : 'background: #F5E2E9; color: #A3355D'),
      noteBackdropStyle: backdrop(st.noteOpen),
      noteSheetStyle: sheetStyle(st.noteOpen, ''),
      toastHasUndo: !!(st.toast && st.toast.undo),
      celebrate: (total > 0 && got === total) || (duties.length > 0 && duties.every(function (d) { return done[d.id]; })),
      week: week, dayMenu: dayMenu,
      shop: shop, shopCount: got + ' / ' + total + ' 品',
      shopBarStyle: 'height: 100%; width: ' + (total ? got / total * 100 : 0) + '%; background: #2C6B52; border-radius: 999px; transition: width .35s ease-out',
      hideBought: st.hideBought ? 'true' : 'false',
      hideLabel: st.hideBought ? '買ったものも表示' : '買ったものを隠す',
      toggleHide: function () { self.setState({ hideBought: !self.state.hideBought }); },
      noPhotos: o.length === 0,
      figStyle: 'margin: 10px 12px 0; position: relative; height: ' + (o.length ? 310 : 280) + 'px; border-radius: 28px; box-shadow: 0 14px 34px rgba(23,32,27,0.22); overflow: hidden; background: #DDE3DA; animation: rise .55s cubic-bezier(.2,.8,.2,1) both',
      photoHint: (D.photos && D.photos.length) ? '写真を読み込んでいます…' : 'ここに子どもたちの写真が流れます。',
      slides: o.map(function (m, i) {
        var on = i === cur;
        var base = 'position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ' + m.pos + '; transition: opacity 1.2s ease, transform ' + (on ? (m.dur + 1) + 's linear' : '1.2s ease') + '; ';
        var vis = on ? 'opacity: 1; transform: scale(' + (m.type === 'video' ? '1' : '1.08') + ')' : 'opacity: 0; transform: scale(1)';
        return { isVideo: m.type === 'video', isPhoto: m.type !== 'video', src: m.src, poster: m.poster || '', badge: !!m.video && m.type !== 'video', style: base + vis };
      }),
      bars: o.map(function (m, i) {
        var w = i < cur ? 'width: 100%' : (i === cur ? 'width: 0; animation: ' + (st.slideIdx % 2 ? 'barA' : 'barB') + ' ' + m.dur + 's linear forwards; animation-play-state: ' + (st.paused ? 'paused' : 'running') : 'width: 0');
        return { fillStyle: 'display: block; height: 100%; background: #FFFFFF; border-radius: 3px; ' + w };
      }),
      capDay: now.getDate(),
      capMonth: (now.getMonth() + 1) + '月',
      capDow: dows[now.getDay()] + '曜日',
      capAge: (function () {
        if (!nb) return '';
        var y = now.getFullYear() - nb.getFullYear(), m = now.getMonth() - nb.getMonth(), dd = now.getDate() - nb.getDate();
        if (dd < 0) { m -= 1; dd += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); }
        if (m < 0) { y -= 1; m += 12; }
        if (y < 0) return '';
        return (ui.kidsLabel ? ui.kidsLabel + ' ' : '') + y + '歳' + m + 'か月' + (dd ? dd + '日' : '');
      })(),
      capStyle: 'position: absolute; left: 20px; right: 20px; bottom: 18px; display: flex; flex-direction: column; gap: 2px; color: #FFFFFF; pointer-events: none; animation: ' + (st.slideIdx % 2 ? 'capIn' : 'capIn2') + ' .8s cubic-bezier(.2,.8,.2,1) .2s both',
      nextSlide: function () { if (o.length) self.setState({ slideIdx: self.state.slideIdx + 1, slideAt: Date.now() }); },
      togglePause: function () { self.setState({ paused: !self.state.paused, slideAt: Date.now() }); },
      paused: st.paused, playing: !st.paused,
      pauseLabel: st.paused ? 'スライドを再開' : 'スライドを一時停止',
      unreadCount: myUnread.length || unreadAll.length,
      hasUnread: unreadAll.length > 0,
      notesNavLabel: unreadAll.length ? '申し送り（未確認' + unreadAll.length + '件）' : '申し送り',
      notesNavBg: st.notesOpen ? 'rgba(255,255,255,0.16)' : 'transparent',
      openNotes: function () { self.setState({ notesOpen: true }); },
      closeNotes: function () { self.setState({ notesOpen: false, noteReplyId: null }); self.seeNotes(); },
      notesSummary: unreadAll.length ? '未確認 ' + unreadAll.length + '件' : 'すべて確認済み',
      notes: notesSorted.map(function (n) {
        var mineTo = n.to === meWho;
        return {
          from: n.from, to: n.to, when: whenLabel(n.createdAt), text: n.text, task: n.task,
          unread: !n.read && mineTo, read: n.read, hasTask: !!n.task,
          fromBadge: self.badge(n.from), toBadge: self.badge(n.to),
          cardStyle: 'display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: 16px; transition: background .3s; background: ' + (n.read ? '#F4F6F2' : '#FFF6E8') + '; border: 1.5px solid ' + (n.read ? 'transparent' : '#F2C77E'),
          ack: function () {
            self.ackNote(n, true);
            self.showToast('申し送りを確認しました', function () { self.ackNote(n, false); self.setState({ toast: null }); });
          },
          newReply: !!marks['notes:' + n.id],
          replies: (D.replies || []).filter(function (r) { return r.target === 'notes:' + n.id; }).sort(function (a, b) { return a.at - b.at; }).map(function (r) {
            var mine = r.who === meWho;
            return { who: r.who, text: r.text, time: whenLabel(r.at), badgeStyle: self.badge(r.who), mine: mine,
              del: function () { self.deleteReply(r.id); },
              style: 'display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 12px; background: #FFFFFF; ' + (mine ? 'margin-left: 24px' : 'margin-right: 24px') };
          }),
          replyOpen: st.noteReplyId === n.id, replyExpanded: st.noteReplyId === n.id ? 'true' : 'false',
          replyLabel: st.noteReplyId === n.id ? 'やめる' : '返信',
          toggleReply: function () { self.setState({ noteReplyId: self.state.noteReplyId === n.id ? null : n.id, noteReplyDraft: '' }); setTimeout(function () { var el = document.getElementById('note-reply-input'); if (el) el.focus(); }, 60); },
          sendReply: function () { self.replyNote(n); }
        };
      }),
      toChoices: names.map(function (p) {
        var on = (st.draftTo || self.otherWho()) === p;
        var c = self.person(p);
        return {
          label: p + 'へ', pressed: on ? 'true' : 'false', pick: function () { self.setState({ draftTo: p }); },
          style: 'min-height: 44px; padding: 0 14px; border-radius: 999px; font-size: 14px; font-weight: 700; cursor: pointer; transition: background .2s, color .2s; border: 1.5px solid ' + c.ink + '; ' + (on ? 'background: ' + c.ink + '; color: #FFFFFF' : 'background: transparent; color: ' + c.ink)
        };
      }),
      noteReplyDraft: st.noteReplyDraft || '',
      setNoteReplyDraft: function (e) { self.setState({ noteReplyDraft: e.target.value }); },
      draft: st.draft,
      setDraft: function (e) { self.setState({ draft: e.target.value }); },
      sendNote: function () {
        var text = (self.state.draft || '').trim();
        if (!text) { self.showToast('申し送りの内容を入力してください', null); return; }
        self.setState({ draft: '' });
        self.addNote(self.state.draftTo || self.otherWho(), text, '', '');
      },
      notesBackdropStyle: backdrop(st.notesOpen),
      notesSheetStyle: sheetStyle(st.notesOpen, 'max-height: 85vh; overflow-y: auto; '),
      loading: st.loading && !st.needLogin, ready: !st.loading && !st.needLogin,
      skeletonRows: [56, 56, 56, 140, 56, 56].map(function (h, k) {
        return { style: 'height: ' + h + 'px; border-radius: ' + (h > 60 ? 20 : 12) + 'px; background: linear-gradient(90deg, #DDE3DA 0%, #E9EDE6 40%, #DDE3DA 80%); background-size: 780px 100%; animation: shimmer 1.1s linear infinite; animation-delay: ' + (k * 60) + 'ms' };
      }),
      menuCardStyle: 'margin: 4px 20px 0; background: #FFFFFF; border-radius: 20px; padding: 20px; display: flex; flex-direction: column; gap: 10px; animation: ' + (st.dayAnim % 2 ? 'slideA' : 'slideB') + ' .4s cubic-bezier(.2,.8,.2,1) both',
      confetti: (function () {
        var cols = ['#3046A6', '#A3355D', '#2C6B52', '#C99A1E'];
        var w0 = Math.min(window.innerWidth || 390, 480), out = [];
        for (var k = 0; k < 28; k++) {
          var w = k % 3 === 0 ? 6 : 9;
          out.push({ style: 'position: absolute; top: 0; left: ' + ((k * 37) % (w0 - 10)) + 'px; width: ' + w + 'px; height: ' + (w + 5) + 'px; border-radius: 2px; background: ' + cols[k % 4] + '; animation: fall ' + (1400 + (k * 97) % 900) + 'ms cubic-bezier(.3,.6,.4,1) ' + ((k * 53) % 600) + 'ms both' });
        }
        return out;
      })(),
      toastMsg: st.toast ? st.toast.msg : '',
      undo: function () { if (self.state.toast && self.state.toast.undo) self.state.toast.undo(); },
      toastStyle: 'position: fixed; left: 16px; right: 16px; bottom: calc(96px + env(safe-area-inset-bottom)); max-width: 448px; margin: 0 auto; box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 16px; border-radius: 16px; background: #17201B; color: #FFFFFF; box-shadow: 0 8px 24px rgba(23,32,27,0.25); z-index: 30; transition: transform .25s ease-out, opacity .25s; ' + (st.toast ? 'transform: translateY(0); opacity: 1' : 'transform: translateY(24px); opacity: 0; pointer-events: none'),
      openSheet: function () { self.setState({ sheet: true }); },
      closeSheet: function () { self.setState({ sheet: false }); },
      backdropStyle: backdrop(st.sheet),
      sheetStyle: sheetStyle(st.sheet, 'max-height: 80vh; overflow-y: auto; gap: 8px; ', '.3s cubic-bezier(.2,.8,.2,1)'),
      /* ログインとアカウント */
      needLogin: st.needLogin,
      loginError: st.loginError,
      inBrowser: !DEMO && !(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)),
      loginLabel: st.loggingIn ? 'ログインしています…' : 'Googleでログイン',
      login: function () { self.login(); },
      syncLabel: syncLabel,
      accountAria: 'アカウントと更新（' + syncLabel + '）',
      syncStyle: 'min-height: 44px; padding: 0 12px; border-radius: 999px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; ' + (st.offline ? 'background: #F5E2E9; color: #7A2645' : 'background: #DDE3DA; color: #39433D'),
      openAccount: function () { self.setState({ accountOpen: true }); },
      closeAccount: function () { self.setState({ accountOpen: false }); },
      meLabel: D.me ? D.me.who + 'でログイン中' : 'ログイン中',
      meEmail: D.me ? D.me.email : '',
      lastSyncLabel: st.lastSync ? '最後に更新：' + whenLabel(st.lastSync) : 'まだ更新していません',
      refreshNow: function () { self.setState({ accountOpen: false }); self.refresh(); },
      logout: function () { self.logout(); },
      theme: st.homeStyle === 'c' ? 'apple' : '',
      homeStyleA: st.homeStyle !== 'b' && st.homeStyle !== 'c' ? 'true' : 'false', homeStyleB: st.homeStyle === 'b' ? 'true' : 'false', homeStyleC: st.homeStyle === 'c' ? 'true' : 'false',
      pickHomeC: function () { LS.set('homeStyle', 'c'); USAGE.add('act:home_c'); self.setState({ homeStyle: 'c', accountOpen: false }); window.scrollTo(0, 0); },
      homeCStyle: 'flex: 1; min-height: 44px; border-radius: 12px; font-size: 14px; font-weight: 700; cursor: pointer; border: 1.5px solid #17201B; ' + (st.homeStyle === 'c' ? 'background: #17201B; color: #FFFFFF' : 'background: transparent; color: #17201B'),
      pickHomeA: function () { LS.set('homeStyle', 'a'); USAGE.add('act:home_a'); self.setState({ homeStyle: 'a', accountOpen: false }); window.scrollTo(0, 0); },
      pickHomeB: function () { LS.set('homeStyle', 'b'); USAGE.add('act:home_b'); self.setState({ homeStyle: 'b', accountOpen: false }); window.scrollTo(0, 0); },
      homeAStyle: 'flex: 1; min-height: 44px; border-radius: 12px; font-size: 14px; font-weight: 700; cursor: pointer; border: 1.5px solid #17201B; ' + (st.homeStyle !== 'b' && st.homeStyle !== 'c' ? 'background: #17201B; color: #FFFFFF' : 'background: transparent; color: #17201B'),
      homeBStyle: 'flex: 1; min-height: 44px; border-radius: 12px; font-size: 14px; font-weight: 700; cursor: pointer; border: 1.5px solid #17201B; ' + (st.homeStyle === 'b' ? 'background: #17201B; color: #FFFFFF' : 'background: transparent; color: #17201B'),
      accountBackdropStyle: backdrop(st.accountOpen),
      accountSheetStyle: sheetStyle(st.accountOpen, '')
    };
    R.more = this.homeMore(R, isHome, secTab, curTab, flow);
    this.planMore = R.more.planList && R.more.planList.show && R.more.planList.label.indexOf('少なく') < 0 ? R.more.planList.go : null;
    /* 並びの帯：写真が見出しの時は写真の下に、それ以外は上に */
    R.orderBanner = Object.assign({}, R.orderBanner, { top: !!R.orderBanner.show && !R.hdr.inPhoto, inHero: !!R.orderBanner.show && !!R.hdr.inPhoto });
    R.notesTop = R.notesHere && !R.hdr.inPhoto; R.notesInHero = R.notesHere && !!R.hdr.inPhoto;   /* 申し送りの入口も写真の下へ */
    /* 見出しの「新着」は、いま画面に出ているものだけ数える（今日でない担当や、しぼって隠れた分は数えない） */
    var visSec = {}; sections.forEach(function (x) { if (x.vis) visSec[x.key] = true; });
    var cnt = function (list) { return (list || []).filter(function (x) { return x.isNew; }).length; };
    var nNew = (visSec.flow ? cnt(R.flow) : 0) + (visSec.decide ? cnt(R.decisions) : 0) + (visSec.deadline ? cnt(R.deadlines) : 0) + (visSec.topics ? cnt(R.topics) : 0)
      + (visSec.diary ? cnt(R.diary) : 0) + (visSec.weekend ? cnt(R.outings) : 0) + (visSec.shop ? (R.shop || []).reduce(function (a, g) { return a + cnt(g.items); }, 0) : 0);
    R.hdr.chips = R.hdr.chips.filter(function (c) { return c.k !== '新着'; });
    if (nNew) R.hdr.chips.unshift(R.hdr.newChip(nNew));   /* 新着はいちばん左（見切れないように） */
    R.tiles = this.tilesFor(tileMode, R, hero, nNew);   /* 新着の数を出してから */
    return R;
  };

  /* ホームの見た目 B（タイル）：写真・天気・今日の担当・つぎの担当・あなたの番・新着をタイルで並べる */
  App.prototype.tilesFor = function (on, R, hero, nNew) {
    if (!on) return { show: false };
    var self = this, st = this.state, H = R.hdr, o = this.order();
    var cur = o.length ? o[st.slideIdx % o.length] : null;
    var circ = 263.9, pct = H.tot ? H.dn / H.tot : 0;
    var goHome = function (sel) { setTimeout(function () { var el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60); };
    var last = nNew ? { k: '新着', v: nNew + '件', sub: '押すと最初の新着へ', dark: true, go: function () { goHome('[data-new]'); } }
      : (R.hdr.chips.filter(function (c) { return c.k === '旅行まで' || c.k === '旅行'; })[0] ? (function (c) { return { k: c.k, v: c.v, sub: '', dark: true, go: function () {} }; })(R.hdr.chips.filter(function (c) { return c.k === '旅行まで' || c.k === '旅行'; })[0])
      : { k: '全部できた日', v: H.streak ? '連続' + H.streak + '日' : 'これから', sub: '', dark: true, go: function () {} });
    return {
      show: true, date: H.date, greet: H.greet,
      hasPhoto: !!cur, photoSrc: cur ? (cur.type === 'video' ? (cur.poster || '') : cur.src) : '', age: R.capAge, photoHint: R.photoHint,
      nextPhoto: function () { if (o.length) self.setState({ slideIdx: st.slideIdx + 1, slideAt: Date.now() }); },
      hasWx: H.hasWx, wx: H.wx || {},
      ringOffset: (circ * (1 - pct)).toFixed(1), prog: H.tot ? H.dn + '/' + H.tot : 'なし', streakText: H.streak >= 2 ? '連続' + H.streak + '日' : (H.tot && H.dn === H.tot ? 'ぜんぶ終わり' : ''),
      goFlow: function () { goHome('[data-sec="flow"]'); },
      next: { kicker: hero.kicker + (hero.countdown ? '・' + hero.countdown : ''), time: hero.time, task: hero.task, who: hero.who === '—' ? '' : '担当：' + hero.who,
        style: 'grid-column: span 2; border: none; cursor: pointer; text-align: left; font-family: inherit; padding: 14px 16px; border-radius: 22px; color: #FFFFFF; display: flex; flex-direction: column; justify-content: space-between; min-height: 112px; box-sizing: border-box; background: ' + hero.color },
      turn: H.turn ? H.turn + '件' : 'なし', turnSub: H.turn ? '押すと「相談・連絡」へ' : '答える番はありません',
      goTurn: function () { self.setState({ nav: H.twoTab }); window.scrollTo(0, 0); },
      last: last
    };
  };

  /* カレンダーの日を押したら、下の一覧のその日へ。ホームでしぼっていたら広げる */
  App.prototype.planJump = function (day) {
    var self = this, go = function () { var el = document.getElementById('plan-d-' + day); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    USAGE.add('act:plan_day');
    if (!document.getElementById('plan-d-' + day) && this.planMore) { this.planMore(); setTimeout(go, 160); } else go();
  };

  /* ホームでは長い一覧を数件にしぼり、「すべて見る」を付ける。
     そのセクションの居場所が別のタブならそのタブへ、ホームの中ならその場で広げる */
  var HOME_LIMIT = { flow: ['flow', 8], decisions: ['decide', 2], deadlines: ['deadline', 4], topics: ['topics', 3], diary: ['diary', 3], shop: ['shop', 8], outings: ['weekend', 3], news: ['news', 5], planList: ['plan', 3] };
  App.prototype.homeMore = function (R, isHome, secTab, curTab, flowAll) {
    var self = this, st = this.state, more = {};
    Object.keys(HOME_LIMIT).forEach(function (k) {
      var sec = HOME_LIMIT[k][0], n = HOME_LIMIT[k][1], list = R[k] || [];
      var count = k === 'shop' ? list.reduce(function (a, g) { return a + g.items.length; }, 0) : list.length;
      var m = { show: false, label: '', go: function () {}, style: 'align-self: stretch; margin: 10px ' + ({ topics: 1, diary: 1, outings: 1, news: 1 }[k] ? '20px' : '0') + ' 0; min-height: 48px; border-radius: 14px; border: 1.5px solid #C9D1C5; background: #FFFFFF; color: #17201B; font-size: 14px; font-weight: 700; cursor: pointer' };
      more[k] = m;
      var here = secTab[sec] === curTab;
      var open = !!(st.expanded && st.expanded[sec]);
      if (!isHome || count <= n) return;
      if ((k === 'flow' && st.flowEdit) || (k === 'shop' && st.shopEdit) || (k === 'topics' && st.topicEdit)) return;   /* 直している最中はしぼらない */
      if (here && open) {
        m.show = true; m.label = '少なく表示';
        m.go = function () { var e = Object.assign({}, self.state.expanded); delete e[sec]; self.setState({ expanded: e }); };
        return;
      }
      /* 新着を先に残し、残りを順に足す（並びは元のまま） */
      var keep = function (all, first, nn) {
        var pick = all.filter(function (r) { return r.isNew; }).slice(0, nn);
        first.forEach(function (r) { if (pick.length < nn && pick.indexOf(r) < 0) pick.push(r); });
        all.forEach(function (r) { if (pick.length < nn && pick.indexOf(r) < 0) pick.push(r); });
        return all.filter(function (r) { return pick.indexOf(r) >= 0; });
      };
      if (k === 'flow') {
        /* 新着、まだのもの、の順に選び、並びは時刻のまま */
        R.flow = keep(flowAll, flowAll.filter(function (r) { return !r.done; }), n);
      } else if (k === 'shop') {
        /* まだ買っていないものを優先して、全部で n 品まで */
        var flat = [];
        list.forEach(function (g, gi) { g.items.forEach(function (it) { flat.push({ gi: gi, it: it, isNew: it.isNew }); }); });
        var chosen = keep(flat, flat.filter(function (x) { return !x.it.checked; }), n);
        R.shop = list.map(function (g, gi) { return Object.assign({}, g, { items: chosen.filter(function (x) { return x.gi === gi; }).map(function (x) { return x.it; }), empty: false }); }).filter(function (g) { return g.items.length; });
      } else {
        R[k] = keep(list, [], n);
      }
      m.show = true;
      m.label = k === 'planList' ? '2週間の予定をすべて見る（' + count + '日）' : 'すべて見る（全' + count + '件）';
      m.go = function () {
        USAGE.add('act:more_' + sec);
        if (here) { var e = Object.assign({}, self.state.expanded || {}); e[sec] = true; self.setState({ expanded: e }); return; }
        self.setState({ nav: secTab[sec] });
        setTimeout(function () { var el = document.querySelector('[data-sec="' + sec + '"]'); if (el) el.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0); }, 80);
      };
    });
    return more;
  };

  /* ---------------- 見本モード（?demo=1） ---------------- */
  var demoDB = null;
  function demoApi(p) {
    if (!demoDB) {
      var t = new Date(), start = new Date(t.getFullYear(), t.getMonth(), t.getDate() - t.getDay());
      var dd = function (i) { return ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)); };
      var dishes = [
        ['ハンバーグと温野菜', false, 'フライパンで焼く日。', [['合いびき肉', '400g'], ['玉ねぎ', '1個']], 'たねを作って焼く。', 28893432],
        ['鶏と大根の煮物', true, '朝に材料を入れて予約。18時に完成。', [['鶏もも肉', '300g'], ['大根', '1/2本']], '材料を切って内なべへ。', 34536865],
        ['豚汁と焼き鮭', true, '豚汁はホットクック、鮭はグリルで。', [['豚こま肉', '150g'], ['塩鮭', '4切れ']], '汁物メニューで。', 39692061],
        ['カレー', true, '多めに作って、木曜の朝にも。', [['豚こま肉', '250g'], ['カレールウ', '1/2箱']], '水を入れずに煮る。', 674574],
        ['肉じゃが', true, '朝に予約。', [['牛こま肉', '200g'], ['じゃがいも', '2個']], '朝に予約する。', 0],
        ['テイクアウト', false, '金曜は作らない日。', [], '帰り道で受け取る。', 17597420],
        ['鍋', false, '食卓で家族みんなで。', [['鶏肉・豆腐・白菜', '適量']], '卓上で。', 35132136]
      ];
      demoDB = {
        me: { email: 'demo@example.com', who: 'とと' }, today: ymd(t),
        duties: [[390, '起こして朝ごはん', 'とと'], [435, '犬の散歩', 'とと'], [480, '保育園の送り', 'まま'], [1020, '保育園のお迎え', 'まま'], [1080, '夕ごはん（ホットクック）', 'とと'], [1140, 'お風呂', 'とと'], [1200, '寝かしつけ', 'まま'], [1230, '保育園の持ち物（着替え2組・タオル・連絡帳）をそろえて玄関に置く', 'まま']].map(function (x, i) { return { id: 'd' + (i + 1), t: x[0], task: x[1], who: x[2] }; }),
        done: {}, checked: {},
        dutiesAll: [[390, '起こして朝ごはん', 'とと', '毎日'], [435, '犬の散歩', 'とと', '毎日'], [480, '保育園の送り', 'まま', '平日'], [1020, '保育園のお迎え', 'まま', '平日'], [1080, '夕ごはん（ホットクック）', 'とと', '毎日'], [1140, 'お風呂', 'とと', '毎日'], [1200, '寝かしつけ', 'まま', '毎日'], [1230, '保育園の持ち物（着替え2組・タオル・連絡帳）をそろえて玄関に置く', 'まま', '毎日'], [600, 'ゴミ出し', '家族', '火金']].map(function (x, i) { return { id: 'd' + (i + 1), t: x[0], task: x[1], who: x[2], rule: x[3], date: '' }; }),
        notes: [{ id: 'n1', createdAt: Date.now() - 3600e3, from: 'まま', to: 'とと', taskId: '', task: '', text: '保育園の連絡帳に、明日の持ち物（着替え2組）が書いてありました。', read: false }],
        diary: [{ id: 'k1', date: ymd(t), time: '7:40', by: 'まま', text: '散歩で、公園の手前からふたりとも自分で歩きたがった。', target: '今日の日記' }],
        menu: dishes.map(function (x, i) { var m = { date: dd(i), dish: x[0], hotcook: x[1], note: x[2], ingredients: x[3], how: x[4], photo: x[5] ? pexels(x[5]) : '' }; if (i % 2 && m.photo) { m.photoBy = 'wiki'; m.photoTitle = x[0]; m.photoCredit = { artist: '見本の作者', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', page: 'https://commons.wikimedia.org/wiki/File:Example.jpg' }; } return m; }),
        shop: { week: dd(0), groups: [{ label: 'お店で買う', items: [['e', '大根', '1本'], ['f', 'じゃがいも', '4個']] }, { label: 'WEBで頼む（冷凍・重いもの）', items: [['a', '鶏もも肉', '600g'], ['c', '冷凍ブロッコリー', '1袋']] }] },
        plans: (function () {
          var t0 = new Date(), td = function (n) { return ymd(new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + n)); };
          var out = [{ date: td(0), time: '17:00', what: '保育園お迎え', who: 'まま' }, { date: td(1), time: '9:00', what: 'インフルワクチン', who: '家族' }, { date: td(1), time: '', what: '燃えるゴミ', who: '家族' },
            { date: td(2), time: '9:30', what: 'ベビーパーク', who: 'とと' }, { date: td(4), time: '10:15', what: 'トリミング', who: 'とと' }, { date: td(9), time: '', what: '結婚記念日', who: '家族' }, { date: td(9), time: '19:00', what: 'レストラン予約', who: 'とと' }, { date: td(12), time: '8:30', what: '保育園 写真前撮り', who: 'まま' }];
          for (var i = 6; i <= 13; i++) out.push({ date: td(i), time: i === 6 ? '' : '', what: '家族旅行', who: '家族', key: 'trip', from: td(6), to: td(15) });
          for (var j = 0; j <= 3; j++) out.push({ date: td(j), time: j === 3 ? '〜10:30' : '', what: 'まるペットホテル', who: 'とと', key: 'hotel', from: td(-1), to: td(3) });
          return out;
        })(), plansFrom: ymd(new Date()), plansTo: ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 13)),
        goals: [{ id: 'ai', label: 'AI・仕組み', next: '家族の道具をそろえる', due: '12月末' }],
        news: [{ id: 'w1', goals: ['ai'], src: 'Web', from: '見本', date: '', title: '見本のニュース', why: '見本モードです', body: '本番ではGASから読み込みます。', url: 'https://example.com' }],
        decisions: [{ id: 'q1', q: '見本：週末の朝ごはん、どうする？', options: ['見本：A案', '見本：B案'], due: dd(5), state: '相談中', a1: '見本：A案', a2: '', decided: '', note: '' }],
        deadlines: [{ id: 'k1', what: '見本：保育園の書類を出す', due: ymd(t), who: 'まま', done: false, url: '', note: '' }, { id: 'k2', what: '見本：ペットホテルの予約', due: dd(9), who: 'とと', done: false, url: '', note: '' }],
        outings: [{ id: 'o1', name: '見本：近くの公園', kind: '公園', date: '', place: '', url: '', note: '芝生が広い', like1: false, like2: true, state: '候補', go: '' }],
        weather: { place: '', code: 1, now: 15, max: 18, min: 9, pop: 20 }, streak: 3,
        topics: [{ id: 't1', title: '見本：旅のしおり', url: 'https://example.com', note: '持ち物と1日ずつの予定', date: '11/19' }, { id: 't2', title: '見本：年末の帰省の相談', url: '', note: '見本の長い文です。12/28の夕方に出て、実家に2泊する案。新幹線は混むので、車で行くなら途中で1回休む。おみやげは前の日に買う。ふたりの昼寝の時間に合わせて出発したい。帰りは12/30の午前。大掃除は帰ってからにするか、出る前に半分だけ済ませるか、決めたい。年賀状は今年は写真入りにする？', date: '11/20' }],
        replies: [{ id: 'r0', target: 'notes:n1', who: 'とと', at: Date.now() - 1200e3, text: '見本の返信：了解、今夜カバンに入れておきます。' }, { id: 'r1', target: 'topics:t2', who: 'まま', at: Date.now() - 1800e3, text: '見本のコメント：出る前に半分だけ大掃除がいいと思う。' }],
        shopSuggest: [{ name: '牛乳', qty: '2本', cat: 'お店で買う', note: 'そろそろ（1週ごと）', due: true }, { name: 'バナナ', qty: '1房', cat: 'お店で買う', note: '3回買った', due: false }],
        photosReady: false,
        people: [{ name: 'とと', ink: '#3046A6' }, { name: 'まま', ink: '#A3355D' }], family: { name: '家族', ink: '#2C6B52' },
        ui: Object.assign({ timeStart: 360, timeEnd: 1260, kidsLabel: 'ふたり', kidsBirth: '2024-04-01', noMenuDish: 'まだ決まっていません', noMenuNote: '日曜の15分で決めます。' }, /[?&]trip=1/.test(location.search) ? { tripFrom: dd(t.getDay() - 1), tripTo: dd(t.getDay() + 3) } : {})   /* ?demo=1&trip=1 で旅行中の見本 */
      };
    }
    var db = demoDB;
    return new Promise(function (res) {
      setTimeout(function () {
        var a = p.action;
        if (a === 'boot') return res({ ok: true, data: JSON.parse(JSON.stringify(db)) });
        if (a === 'photos') return res({ ok: true, photos: [] });
        if (a === 'photosBatch') return res({ ok: true, photos: {} });
        if (a === 'setDone') { if (p.done) db.done[p.taskId] = true; else delete db.done[p.taskId]; }
        if (a === 'setShop') { if (p.checked) db.checked[p.itemId] = true; else delete db.checked[p.itemId]; }
        if (a === 'addNote') db.notes.unshift(p.note);
        if (a === 'deleteNote') db.notes = db.notes.filter(function (x) { return x.id !== p.id; });
        if (a === 'ackNote') db.notes.forEach(function (x) { if (x.id === p.id) x.read = p.read; });
        if (a === 'addDiary') db.diary.push(p.entry);
        if (a === 'deleteDiary') db.diary = db.diary.filter(function (x) { return x.id !== p.id; });
        if (a === 'saveMenu') { db.menu = db.menu.filter(function (x) { return x.date !== p.menu.date; }).concat([{ date: p.menu.date, dish: p.menu.dish, servings: p.menu.servings, hotcook: p.menu.hotcook, note: p.menu.note, ingredients: p.menu.ingredients.map(function (x) { return [x.name, x.qty]; }), how: p.menu.how, photo: '' }]); }
        if (a === 'deleteMenu') db.menu = db.menu.filter(function (x) { return x.date !== p.date; });
        if (a === 'addReply') db.replies.push({ id: p.reply.id, target: p.reply.target, who: 'とと', at: Date.now(), text: p.reply.text });
        if (a === 'deleteReply') db.replies = db.replies.filter(function (x) { return x.id !== p.id; });
        res({ ok: true });
      }, 250);
    });
  }

  /* ---------------- 起動 ---------------- */
  function start() {
    var tpl = document.getElementById('tpl');
    root = document.getElementById('app');
    root.innerHTML = '';
    compiled = compileKids(tpl.content);
    root.__slots = compiled.map(function () { return []; });
    comp = new App();
    render();
    comp.componentDidMount();
    if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') {
      /* 新しい版に切り替わったら、1回だけ読み直して新しい画面にする */
      var hadCtrl = !!navigator.serviceWorker.controller, reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadCtrl || reloaded) return;
        var go = function () { reloaded = true; comp.reloading = true; location.reload(); };
        var s = comp.state, busy = comp.pending > 0 || s.editor || s.noteOpen || s.notesOpen || s.fbOpen || s.museOpen || s.replyDraft || s.accountOpen || s.flowEdit || s.shopEdit || s.topicEdit || s.noteDraft || s.draft || s.fbDraft || s.shopDraft;
        /* 使っている最中（入力中・編集中・ホーム以外のタブ）は読み直さず、次にアプリに戻った時に読み直す */
        if (busy || (s.nav && s.nav !== '今日')) { document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && !reloaded) go(); }); return; }
        go();
      });
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
