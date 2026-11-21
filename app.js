/* わが家の今日 — 家族アプリ（画面）
 * 画面は index.html の <template id="tpl"> に書き、ここで描画する。
 * データは GAS（Googleのスプレッドシートとカレンダー）から取る。
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var APP_VERSION = '77';
  var API_EXPECTED = 15;   // 画面が必要とする GAS の API_VERSION の下限（これより古い時だけ知らせる）。16 から boot に swapsAhead と cancelSwap。無い GAS では取り消しを出さない
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
    checkTitle();
  }
  function renderNow() { if (!comp) return; queued = false; render(); }

  /* 画面の切り替えを滑らかに（View Transitions。無い端末・動きを減らす設定ではそのまま切り替える） */
  function swapView(fn) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || reduce) { fn(); return; }
    try { document.startViewTransition(function () { fn(); renderNow(); }); } catch (e) { fn(); }
  }

  /* 大きな見出しが上のバーの下に隠れたら、バーにタブの名前を出す（iPhoneの大きな見出しの縮み） */
  var titleOn = false, titleTick = false;
  function checkTitle() {
    titleTick = false;
    var h = document.querySelector('.tabhead h2'), bar = document.querySelector('.appbar');
    var v = !!(h && bar && h.getBoundingClientRect().bottom < bar.getBoundingClientRect().bottom + 4);
    if (v !== titleOn) { titleOn = v; document.documentElement.classList.toggle('collapsed', v); }
  }
  window.addEventListener('scroll', function () { if (!titleTick) { titleTick = true; (window.requestAnimationFrame || setTimeout)(checkTitle); } }, { passive: true });

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
      try { caches.open(this.cache).then(function (c) { return c.put(new Request('./__auth'), new Response(JSON.stringify({ s: session, e: email || '', t: Date.now(), g: CFG.gasUrl || '' }))); }).catch(function () {}); } catch (e) {}
    },
    load: function () {
      if (DEMO || !window.caches) return Promise.resolve(null);
      try { return caches.open(this.cache).then(function (c) { return c.match('./__auth'); }).then(function (r) { return r ? r.json() : null; }).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
    },
    clear: function () { try { if (window.caches) caches.delete(this.cache); } catch (e) {} }
  };

  /* 通知（Web Push）：ホーム画面のアプリだけ（iPhone は iOS 16.4 以降）。鍵（公開の方）は boot の push.key。
     通知の中身は sw.js が、上のログインの控え（g＝GASのURL）で聞きに行く */
  function b64uBytes(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  var PUSH = {
    can: function () { return !DEMO && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
    home: function () { return !!(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)); },
    sub: function () { return navigator.serviceWorker.ready.then(function (r) { return r.pushManager.getSubscription().then(function (s) { return { reg: r, sub: s }; }); }); },
    send: function (sub, key) { return api('pushSub', { sub: sub.toJSON() }).then(function () { LS.set('pushEp', sub.endpoint); LS.set('pushKey', key); LS.set('pushAt', Date.now()); }); }
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
  /* 話題のカードの色（Apple の色をもとに、白い文字が読める濃さ） */
  var TOPIC_TONES = [['#0A6CDA', '#5E5CE6'], ['#E8590C', '#F08C00'], ['#0B8A7A', '#2F9E44'], ['#7048E8', '#AE3EC9'], ['#C2255C', '#E8590C'], ['#1D1D1F', '#495057']];
  function hashIdx(str, n) { var h = 0; str = String(str || ''); for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h) % n; }
  function pexels(id, w) { return 'https://images.pexels.com/photos/' + id + '/pexels-photo-' + id + '.jpeg?auto=compress&cs=tinysrgb&w=' + (w || 900); }
  var MOOD = [5728162, 4262172, 29144275, 6646360];

  /* ---------------- 画面のロジック ---------------- */
  function App() {
    DCLogic.call(this);
    var cached = LS.get('boot');
    this.state = {
      who: LS.get('who') || 'all', day: null, menuWeek: 0, dayAnim: 0, hideBought: false, now: Date.now(), toast: null, sheet: false,
      loading: !cached, data: cached, photos: [],
      slideIdx: 0, slideAt: Date.now(), paused: false,
      noteOpen: false, noteMode: 'diary', noteTarget: '', noteTaskId: null, noteDraft: '', listening: false,
      notesOpen: false, draft: '', draftTo: null,
      mounted: {}, seen: {}, goal: 'all', goalAnim: 0, newsOpen: {},
      needLogin: !DEMO && !LS.get('session'), loginError: '', loggingIn: false,
      accountOpen: false, syncing: false, lastSync: cached ? cached._at : 0, offline: false,
      flowEdit: false, shopEdit: false, editor: null, shopDraft: '', shopQty: '', shopCat: null,
      fbOpen: false, fbDraft: '', museOpen: false, museDraft: '', museKind: '', museFrom: '', detail: null, replyDraft: '', topicEdit: false, nav: null, expanded: {}
    };
    this.lazyIds = ['diary', 'week', 'shop', 'plan', 'news'];
  }
  App.prototype = Object.create(DCLogic.prototype);

  App.prototype.componentDidMount = function () {
    var self = this;
    USAGE.add('open:app');
    /* 通知から開いた時（?go=…）と、開いている時に通知を押した時（sw.js からの知らせ） */
    try {
      var go0 = new URLSearchParams(location.search).get('go');
      if (go0) { history.replaceState(null, '', location.pathname + location.search.replace(/([?&])go=[^&]*&?/, '$1').replace(/[?&]$/, '') + location.hash); this.goTo(go0); }
      if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'go') { self.refresh(true); self.goTo(e.data.go); } });
    } catch (e) {}
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
      /* 日が変わったら、すぐ読み直す（昨日の流れ・申し送りを出したままにしない）。読み込み中なら次の秒に */
      if (s.data && s.data.today && ymd(new Date()) !== s.data.today && !s.loading && !self.dayRolling && document.visibilityState === 'visible') {
        self.dayRolling = true; setTimeout(function () { self.dayRolling = false; }, 20000); self.refresh(true);
      }
      var n = self.order().length;
      if (n && self.showPhotos() && !s.paused && !s.loading && (Date.now() - s.slideAt) / 1000 >= self.slideDur(s.slideIdx)) { upd = upd || {}; upd.slideIdx = s.slideIdx + 1; upd.slideAt = Date.now(); }
      if (upd) self.setState(upd);
    }, 1000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { self.appBadge = null; self.setState({ now: Date.now() }); self.openRefresh(); checkUpdate(); } });   /* 通知で付いたアイコンの数字を、開いたら「あなたの番」の数に直す */
    /* 開いている間は15秒ごとに「変わったか」だけ確かめ、変わった時だけ読み直す（Museや相手の書き込みがすぐ出る）。
       予定（カレンダー）などシートの外のものもあるので、5分ごとには必ず読み直す */
    this.poll = setInterval(function () { if (document.visibilityState === 'visible') self.pollVer(); }, 15000);
    this.handleRedirect().then(function () { return self.restoreLogin(); }).then(function () { if (!self.state.needLogin) self.openRefresh(true); });
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
    /* この端末の通知も止める（ログアウトした端末に家族の通知を出さない） */
    var ep = LS.get('pushEp'), bye = function () { return api('logout', {}).catch(function () {}); };
    if (ep) { api('pushUnsub', { endpoint: ep }).catch(function () {}).then(bye); try { PUSH.sub().then(function (x) { if (x.sub) x.sub.unsubscribe(); }).catch(function () {}); } catch (e) {} LS.del('pushEp'); LS.del('pushKey'); }
    else bye();
    AUTH.clear(); LS.set('loggedOut', 1); LS.del('hint');
    LS.del('session'); LS.del('boot'); LS.del('seen'); LS.del('seenPending'); LS.del('usage'); LS.del('usagePending'); LS.del('orderPlain');
    try { if (window.caches) caches.delete('wagaya-photos'); } catch (e) {}
    this.photoKey = null;
    self.setState({ needLogin: true, accountOpen: false, data: null, loading: true, photos: [] });
  };

  /* データの読み込み（キャッシュをすぐ出して、裏で新しくする） */
  /* quiet：右上に「更新中」を出さない。fresh：GAS側のまとめを使わず、シートから読み直す */
  /* 開いた時の読み直し：手元のデータが前の日なら「更新中」を出して読む。起動時と、前に読んでから3分以上たった時は
     Google側のまとめも作り直す（fresh。カレンダー・写真などシートの外の物も新しくする）。それ以外はまとめを使って速く */
  App.prototype.openRefresh = function (start) {
    var D = this.state.data;
    if (!D) return this.refresh(false, !!start);
    var oldDay = !!D.today && D.today !== ymd(new Date());
    var old = Date.now() - (D._at || 0) > 3 * 60000;
    if (!start && !oldDay && this.inflight) return this.inflight;   /* もう読んでいる最中なら重ねない */
    return this.refresh(!oldDay, !!start || old || oldDay);
  };
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
      if (!DEMO && !(data.api >= API_EXPECTED) && !self.apiWarned) { self.apiWarned = true; setTimeout(function () { self.showToast('Google側の更新がまだのようです（版のずれ）。アプリを管理している人に伝えてください', null); }, 800); }
      LS.set('boot', data);
      var first = !self.state.data;
      self.setState({ data: data, loading: false, syncing: false, lastSync: data._at, offline: false });
      self.trackMarks(data);
      self.syncPush(data);
      if (first) setTimeout(function () { self.attachLazy(); }, 60);
      if (first && self.pendingGo) { var g0 = self.pendingGo; self.pendingGo = null; setTimeout(function () { self.goTo(g0); }, 200); }
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
    list = (list || []).slice(0, 30);
    /* 動画の中身まで取るのは新しい5本だけ（通信を抑える）。残りは1コマで出す */
    var nv = 0; list = list.map(function (p) { if (p.video && !p.big && ++nv > 5) return Object.assign({}, p, { big: true }); return p; });
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
        /* 2) 足りない1コマ目だけ、8枚ずつまとめて取る（新しい物から順に出る） */
        var missing = list.filter(function (_, i) { return !have[i]; });
        if (!missing.length || self.state.needLogin) return;
        var chunks = []; for (var c = 0; c < missing.length; c += 8) chunks.push(missing.slice(c, c + 8));
        return chunks.reduce(function (chain, part) {
          return chain.then(function () {
            if (self.state.needLogin) return;
            return api('photosBatch', { ids: part.map(function (p) { return p.id; }) }).then(function (res) {
              return Promise.all(list.map(function (p, i) {
                var src = res.photos && res.photos[p.id];
                if (have[i] || !src || part.indexOf(p) < 0) return null;
                return fetch(src).then(function (r) { return r.blob(); }).then(function (blob) {
                  show(i, blob);
                  if (cache) return cache.put(url(p), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } })).catch(function () {});
                });
              }));
            }).catch(function () {});
          });
        }, Promise.resolve());
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
    /* 返信は相手が書いた物だけ数える（自分の返信では「新着」「新しい返信」にしない） */
    var me = D.me && D.me.who;
    var rc = {}; (D.replies || []).forEach(function (r) { if (me && r.who === me) return; rc[r.target] = (rc[r.target] || 0) + 1; });
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
    if (!seen || LS.get('seenV') !== 2) { LS.set('seen', cur); LS.set('seenV', 2); return; }   /* 数え方を変えた時は一度だけそろえ直す（自分の返信を数えなくした） */
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
        var why = { not_agreed: '2人の答えがそろっていないので、まだ決まりにできません', not_both: '2人とも「行きたい」を押すと、行く日を決められます', already_decided: 'もう決まった相談です。変える時は「相談に戻す」を押してください', unknown_action: 'Google側の更新がまだのため、できませんでした', past: 'もう過ぎた日のため、できませんでした', done: '済にした担当は取り消せません', not_yours: '相手が引き受けた担当は、申し送りで「戻してもらえる？」と頼んでください' }[err && err.code];
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
  /* 通知 */
  App.prototype.pushState = function () {
    if (DEMO) return 'demo';
    if (!PUSH.home()) return 'needHome';
    if (!PUSH.can()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return Notification.permission === 'granted' && LS.get('pushEp') ? 'on' : 'off';
  };
  App.prototype.enablePush = function () {
    var self = this, D = this.state.data || {}, key = D.push && D.push.key;
    if (!key) { this.showToast('Google側の更新がまだです（通知の鍵がありません）', null); return; }
    /* 許可を聞くのは、押したその場で（iPhone は押した操作の中でないと聞けない） */
    var ask = Notification.requestPermission();
    USAGE.add('act:push_on');
    this.setState({ pushBusy: true });
    Promise.resolve(ask).then(function (p) {
      if (p !== 'granted') throw { code: 'denied' };
      return PUSH.sub();
    }).then(function (x) {
      return x.sub || x.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
    }).then(function (sub) {
      AUTH.save(LS.get('session'), D.me && D.me.email);
      return PUSH.send(sub, key);
    }).then(function () { self.setState({ pushBusy: false }); self.showToast('通知をオンにしました。「テスト通知を送る」で確かめられます', null); })
      .catch(function (e) { self.setState({ pushBusy: false }); self.showToast(e && e.code === 'denied' ? '通知が許可されていません。iPhoneの「設定」→「通知」で、このアプリを許可してください' : '通知をオンにできませんでした', null); });
  };
  App.prototype.disablePush = function () {
    var self = this;
    USAGE.add('act:push_off');
    PUSH.sub().then(function (x) {
      var ep = x.sub ? x.sub.endpoint : LS.get('pushEp');
      return (x.sub ? x.sub.unsubscribe() : Promise.resolve()).then(function () { return api('pushUnsub', { endpoint: ep }); });
    }).catch(function () {}).then(function () { LS.del('pushEp'); LS.del('pushKey'); self.setState({ now: Date.now() }); self.showToast('この端末の通知をオフにしました', null); });
  };
  App.prototype.testPush = function () {
    var self = this;
    USAGE.add('act:push_test');
    api('pushTest', {}).then(function (r) {
      var c = (r.last && r.last.codes) || [];
      if (!c.length) self.showToast('この端末の登録が見つかりませんでした。いったんオフにして、もう一度オンにしてください', null);
      else if (c.some(function (x) { return x >= 200 && x < 300; })) self.showToast('テスト通知を送りました。数秒で届きます', null);
      else self.showToast('送れませんでした（' + c.join(',') + '）。いったんオフにして、もう一度オンにしてください', null);
    }).catch(function () { self.showToast('送れませんでした。通信を確かめてください', null); });
  };
  /* 開いた時に、この端末の登録がGAS側とずれていたら直す（鍵が変わった・登録が消えた・7日たった） */
  App.prototype.syncPush = function (D) {
    if (this.pushSynced || !PUSH.can() || !PUSH.home() || Notification.permission !== 'granted' || !D.push || !D.push.key || !LS.get('pushEp')) return;
    this.pushSynced = true;
    var key = D.push.key;
    PUSH.sub().then(function (x) {
      var same = x.sub && LS.get('pushKey') === key;
      if (same && D.push.subs > 0 && x.sub.endpoint === LS.get('pushEp') && Date.now() - (LS.get('pushAt') || 0) < 7 * 864e5) return;
      var p = same ? Promise.resolve(x.sub) : (x.sub ? x.sub.unsubscribe() : Promise.resolve()).then(function () { return x.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) }); });
      return p.then(function (sub) { return PUSH.send(sub, key); });
    }).catch(function () {});
  };
  /* 通知を押して開いた時：その場所へ（申し送りはシートを開く） */
  App.prototype.goTo = function (go) {
    var self = this;
    if (!go) return;
    if (!this.state.data) { this.pendingGo = go; return; }
    USAGE.add('act:push_open');
    this.jumpSec(go);
  };
  /* そのセクションのタブへ切り替えて、セクションの頭までスクロールする（通知・右上のメニューから） */
  App.prototype.jumpSec = function (go) {
    if (go === 'notes') { this.setState({ notesOpen: true }); return; }
    var t = this.secTabMap && this.secTabMap[go];
    if (!t) return;
    /* タブが変わる時は一気に（前のタブの位置から長く流れないように）、同じタブの中だけ滑らかに */
    var change = this.state.nav !== t;
    if (change) { this.setState({ nav: t }); window.scrollTo(0, 0); }
    var find = function () { return document.querySelector('[data-sec="' + go + '"]'); };
    setTimeout(function () {
      var el = find();
      if (!el) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      el.scrollIntoView({ block: 'start', behavior: change ? 'auto' : 'smooth' });
      /* 読み上げの位置も移った先へ（見出しにフォーカス） */
      var h = el.querySelector('h2, h3');
      if (h) { if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) {} }
      /* 遅れて出る部分で高さが変わった時は、もう一度合わせる */
      setTimeout(function () { var e2 = find(); if (e2 && Math.abs(e2.getBoundingClientRect().top - 64) > 8) e2.scrollIntoView({ block: 'start', behavior: 'auto' }); }, change ? 500 : 900);
    }, 120);
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
  App.prototype.openNoteFor = function (target, taskId, mode, to, date) {
    var upd = { noteOpen: true, noteMode: mode === 'swap' ? 'handover' : (mode || 'diary'), noteTarget: target, noteTaskId: taskId, noteDraft: '', noteAsk: mode === 'swap', noteAskDate: mode === 'swap' ? (date || '') : '', noteBack: false };
    if (mode === 'swap') upd.noteDraft = this.askDraft(target, date);
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
      /* iPhone は確定した結果と途中の結果が重なって返ることがあるので、確定分を順に足し、途中の分は最後の1つだけ使う */
      var fixed = '';
      rec.onresult = function (e) {
        var interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) fixed += e.results[i][0].transcript; else interim = e.results[i][0].transcript;
        }
        self.setState({ noteDraft: base + fixed + interim });
      };
      rec.onerror = function (ev) {
        var code = String((ev && ev.error) || 'unknown').replace(/[^\w-]/g, '').slice(0, 30);
        USAGE.add('err:mic_' + code);   /* 何が起きたかを回数だけ残す（文章は残さない） */
        self.setState({ listening: false });
        if (code === 'no-speech' || code === 'aborted') { self.showToast('声が聞き取れませんでした。もう一度マイクを押して話してください', null); return; }
        if (code === 'not-allowed') { self.showToast('マイクが許可されていません。iPhoneの設定で、このアプリのマイクと音声入力を許可してください。すぐ使うならキーボードのマイクが確実です', null); return; }
        self.showToast('ホーム画面のアプリでは音声入力が止まることがあります（' + code + '）。キーボードのマイクで話してください', null);
      };
      rec.onend = function () { self.setState({ listening: false }); };
      this.rec = rec; rec.start(); USAGE.add('act:mic_start');
      this.setState({ listening: true });
    } catch (e) {
      this.setState({ listening: false });
      this.showToast('マイクが使えませんでした。キーボードのマイクで話してください', null);
    }
  };
  App.prototype.addNote = function (to, text, taskId, task, ask, askDate) {
    var self = this;
    var note = { id: uid('n'), createdAt: Date.now(), from: this.meWho(), to: to, taskId: taskId || '', task: task || '', text: text, read: false };
    if (ask && taskId) { note.ask = 'swap'; note.askDate = askDate || (this.state.data || {}).today || ymd(new Date()); note.answer = ''; }
    this.mutate(function (d) { d.notes = [note].concat(d.notes || []); });
    var revert = function () { self.mutate(function (d) { d.notes = (d.notes || []).filter(function (x) { return x.id !== note.id; }); }); };
    this.send('addNote', { note: note }, revert);
    var back = !!this.state.noteBack && ask; this.setState({ noteBack: false });
    this.showToast(back ? to + 'に頼みました。返事があるまでは自分の担当のままです' : to + 'に申し送りを送りました', function () { revert(); self.send('deleteNote', { id: note.id }); self.setState({ toast: null }); });
  };
  App.prototype.saveNote = function () {
    var self = this;
    var text = (this.state.noteDraft || '').trim();
    var handover = this.state.noteMode === 'handover';
    if (!text) { this.showToast(handover ? '申し送りの内容を入力してください' : '気づきの内容を入力してください', null); return; }
    try { if (this.rec) this.rec.stop(); } catch (e) {}
    this.setState({ noteOpen: false, noteDraft: '', listening: false });
    if (handover) { this.addNote(this.state.draftTo || this.otherWho(), text, this.state.noteTaskId, this.state.noteTarget, !!this.state.noteAsk && this.canAskSwap(this.state.noteTaskId, this.state.noteAskDate), this.state.noteAskDate); return; }
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
  /* 大項目と小項目をまとめて済にする・戻す（GAS 17 の setDoneMany。1回の書き込み） */
  App.prototype.setDoneMany = function (ids, val) {
    if (this.stale()) return;
    var self = this, prev = {}, D0 = this.state.data.done || {};
    ids.forEach(function (id) { prev[id] = !!D0[id]; });
    this.mutate(function (d) { d.done = d.done || {}; ids.forEach(function (id) { if (val) d.done[id] = true; else delete d.done[id]; }); });
    this.send('setDoneMany', { date: this.state.data.today, ids: ids, done: val }, function () { self.mutate(function (d) { ids.forEach(function (id) { if (prev[id]) d.done[id] = true; else delete d.done[id]; }); }); });
  };
  App.prototype.privApi = function () { return Number((this.state.data || {}).api || 0) >= 18; };   /* 「Museに出さない」は GAS 18 から */
  App.prototype.dutyApi = function () { return Number((this.state.data || {}).api || 0) >= 17; };   /* 大項目と小項目（担当の「親」）は GAS 17 から */
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
  App.prototype.openDuty = function (d, parentId) {
    var D = this.state.data || {};
    var all = d ? ((D.dutiesAll || []).filter(function (x) { return x.id === d.id; })[0] || d) : null;
    var who = this.state.who !== 'all' && this.names().indexOf(this.state.who) >= 0 ? this.state.who : this.meWho();
    this.setState({ editor: {
      kind: 'duty', isNew: !d, id: d ? d.id : uid('d'), task: d ? d.task : '', time: d ? hhmm(d.t) : pad(Math.min(23, new Date().getHours() + 1)) + ':00',
      who: d ? (all && all.who) || d.who : who, once: all ? !!all.date : true, rule: (all && !all.date && all.rule) || '毎日', date: (all && all.date) || D.today || ymd(new Date()),
      routine: !!(all && !all.date), skipToday: !!(d && D.skipped && D.skipped[d.id]),
      relOn: !!(all && all.rel != null), rel: all && all.rel != null ? String(all.rel) : '',
      parent: (all && all.parent) || parentId || '',
      priv: !!(all && all.priv)
    } });
  };
  App.prototype.editSet = function (k, v) { var e = Object.assign({}, this.state.editor); e[k] = v; this.setState({ editor: e }); };
  App.prototype.saveDuty = function () {
    if (this.stale()) return;
    var self = this, e = this.state.editor, task = (e.task || '').trim();
    if (!task) { this.showToast('やることを入力してください', null); return; }
    var rule = e.once ? '' : (e.rule || '毎日');
    var dep = this.departMin();
    var rel = e.relOn ? Math.max(0, Math.min(600, parseInt(String(e.rel || '0').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 65248); }), 10) || 0)) : null;
    if (rel != null && dep == null) { this.showToast('出発の時刻が決まっていません。先に「出発」の時刻を決めてください', null); return; }
    if (e.parent) {   /* 小項目：時刻・担当・曜日は大項目についていく */
      var D1 = this.state.data || {}, prow = (D1.dutiesAll || []).filter(function (x) { return x.id === e.parent; })[0];
      if (!prow) { this.showToast('大項目が見つかりません。読み直してからもう一度お試しください', null); return; }
      var dc = { id: e.id, task: task, parent: e.parent };
      if (this.privApi()) dc.priv = !!e.priv;
      var revertC = this.snapshot();
      this.mutate(function (D) {
        D.dutiesAll = (D.dutiesAll || []).filter(function (x) { return x.id !== dc.id; }).concat([{ id: dc.id, t: prow.t, rel: prow.rel, task: task, who: prow.who, rule: prow.rule, date: prow.date, parent: dc.parent, priv: !!dc.priv, privAny: !!(dc.priv || prow.priv || prow.privAny) }]);
        var pt = (D.duties || []).filter(function (x) { return x.id === dc.parent; })[0];
        D.duties = (D.duties || []).filter(function (x) { return x.id !== dc.id; });
        if (pt) D.duties.push({ id: dc.id, t: pt.t, rel: pt.rel, task: task, who: pt.who, orig: pt.orig || '', once: !!pt.once, parent: dc.parent });
      });
      this.setState({ editor: null, lastDuty: dc.parent });
      this.send('saveDuty', { duty: dc }, revertC);
      this.showToast('「' + prow.task + '」の小項目「' + task + '」を' + (e.isNew ? '足しました' : '直しました'), null);
      return;
    }
    var d = { id: e.id, task: task, time: rel != null ? hhmm(dep - rel) : e.time, rel: rel, who: e.who, rule: rule, date: e.once ? e.date : '' };
    if (this.dutyApi()) d.parent = '';   /* 小項目から外した時に「親」を消す */
    if (this.privApi()) d.priv = !!e.priv;
    var revert = this.snapshot();
    this.mutate(function (D) {
      var row = { id: d.id, t: rel != null ? dep - rel : minOf(d.time), rel: rel, task: task, who: d.who, rule: rule || '毎日', date: d.date };
      if (e.priv) row.priv = true;
      D.dutiesAll = (D.dutiesAll || []).filter(function (x) { return x.id !== d.id; }).concat([row]);
      var today = parseYmd(D.today || ymd(new Date()));
      var on = d.date ? d.date === D.today : dayMatch(rule, today.getDay());
      D.duties = (D.duties || []).filter(function (x) { return x.id !== d.id; });
      if (on) D.duties.push({ id: d.id, t: row.t, rel: rel, task: task, who: d.who, once: !!d.date });
      /* 小項目は大項目についていく（読み直すまでの間も合わせる） */
      (D.dutiesAll || []).forEach(function (x) { if (x.parent === d.id) { x.t = row.t; x.rel = rel; x.who = d.who; x.rule = row.rule; x.date = d.date; } });
      var kidsAll = (D.dutiesAll || []).filter(function (x) { return x.parent === d.id; });
      D.duties = D.duties.filter(function (x) { return x.parent !== d.id; });
      if (on) kidsAll.forEach(function (x) { D.duties.push({ id: x.id, t: row.t, rel: rel, task: x.task, who: d.who, once: !!d.date, parent: d.id }); });
    });
    this.setState({ editor: null, lastDuty: d.id });   /* 足した担当は、ホームで8件にしぼる時も残す */
    this.send('saveDuty', { duty: d }, revert);
    var when = d.date ? (d.date === (this.state.data || {}).today ? '今日' : parseYmd(d.date).getMonth() + 1 + '/' + parseYmd(d.date).getDate()) + 'だけ' : ruleWords(rule);
    this.showToast('「' + task + '」を' + when + 'で' + (e.isNew ? '足しました' : '直しました'), null);
  };
  /* ---------- 今日だけ担当を替える ---------- */
  App.prototype.todayDuty = function (id) { return ((this.state.data || {}).duties || []).filter(function (x) { return x.id === id; })[0] || null; };
  /* 「代わってほしい」と頼めるのは、今日の自分の担当だけ */
  App.prototype.canAskSwap = function (id, date) {
    var today = (this.state.data || {}).today;
    if (date && date !== today) { var sa = this.swapAhead(id, date); return sa ? sa.who === this.meWho() : this.askDates(id).indexOf(date) >= 0; }
    var d = id && this.todayDuty(id); return !!(d && d.who === this.meWho());
  };
  /* 「この日はお願い」：自分のいつもの担当を、明日から ASK_DAYS 日先までのその担当の日を選んで頼む（GAS は依頼の日にその日の担当替えを書く） */
  var ASK_DAYS = 7;
  App.prototype.dutyRow = function (id) { return ((this.state.data || {}).dutiesAll || []).filter(function (x) { return x.id === id; })[0] || null; };
  App.prototype.askDates = function (id) {
    var D = this.state.data || {}, row = id && this.dutyRow(id), out = [];
    if (!row || row.who !== this.meWho()) return out;
    var t0 = parseYmd(D.today || ymd(new Date()));
    for (var i = 1; i <= ASK_DAYS; i++) {
      var x = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + i), k = ymd(x);
      if (row.date ? row.date === k : dayMatch(row.rule, x.getDay())) out.push(k);
    }
    return out;
  };
  /* その日について自分が出した頼みの状態：'' まだ／'asked' 返事待ち／'ok' 代わってもらう（'ng' の後はまた頼める） */
  App.prototype.askState = function (id, date) {
    var me = this.meWho(), D = this.state.data || {}, st0 = '', hasAhead = !!D.swapsAhead;
    if (hasAhead && this.swapAhead(id, date)) return 'ok';
    (D.notes || []).forEach(function (n) {
      if (n.ask !== 'swap' || n.from !== me || n.taskId !== id || n.askDate !== date) return;
      if (n.answer === 'ok' && !hasAhead) st0 = 'ok'; else if (!n.answer && st0 !== 'ok') st0 = 'asked';
    });
    return st0;
  };
  /* 自分から出して返事待ちの頼みがあるか（頼み返しの二重送りを防ぐ） */
  App.prototype.pendingAsk = function (id, date) {
    var me = this.meWho();
    return ((this.state.data || {}).notes || []).some(function (n) { return n.ask === 'swap' && n.from === me && n.taskId === id && n.askDate === date && !n.answer; });
  };
  /* 取り消し（cancelSwap）と先の日の状態（swapsAhead）は GAS 16 から。古い GAS では出さない */
  App.prototype.swapApi = function () { return Number((this.state.data || {}).api || 0) >= 16; };
  /* 引き受けた側から「戻してもらえる？」と頼み返す（一方的には戻さない） */
  App.prototype.askBack = function (id, date, task, orig) {
    this.setState({ editor: null });
    this.openNoteFor(task, id, 'swap', orig, date);
    this.setState({ noteBack: true, noteDraft: this.askDayWord(date).replace(/^明日 /, '') + 'の「' + task + '」、やっぱりむずかしくなりました。戻してもらえる？' });
  };
  /* 先の日の担当替え（GAS 16 から。無ければ null）。今日の分は duties の orig で分かる */
  App.prototype.swapAhead = function (id, date) { return ((this.state.data || {}).swapsAhead || []).filter(function (x) { return x.id === id && x.date === date; })[0] || null; };
  /* 引き受けてもらった担当替えが、今も生きているか（取り消せるか） */
  App.prototype.swapLive = function (id, date) {
    var D = this.state.data || {};
    if (date === D.today) { var d = this.todayDuty(id); return !!(d && d.orig && d.who !== d.orig); }
    return !!this.swapAhead(id, date);
  };
  /* 取り消し：頼んだ人（やっぱり自分でやる）か、引き受けた人（やっぱりむずかしい）。2回押しで */
  App.prototype.tapCancelSwap = function (id, date, task) {
    var self = this, key = date + '|' + id;
    if (this.state.cancelArm === key) { clearTimeout(this.cancelArmTimer); this.setState({ cancelArm: null }); this.cancelSwap(id, date, task); return; }
    this.setState({ cancelArm: key });
    clearTimeout(this.cancelArmTimer);
    this.cancelArmTimer = setTimeout(function () { if (self.state.cancelArm === key) self.setState({ cancelArm: null }); }, 4000);
  };
  App.prototype.cancelSwap = function (id, date, task) {
    if (this.stale()) return;
    var w = this.askDayWord(date);
    var revert = this.snapshot();
    this.mutate(function (X) {
      X.swapsAhead = (X.swapsAhead || []).filter(function (x) { return !(x.id === id && x.date === date); });
      if (date === X.today) (X.duties || []).forEach(function (x) { if (x.id === id && x.orig) { x.who = x.orig; x.orig = ''; } });
    });
    this.setState({ editor: null });
    this.send('cancelSwap', { date: date, id: id }, revert);
    USAGE.add('act:swap_cancel');
    this.showToast(w + 'の「' + task + '」は自分でやります（' + this.otherWho() + 'に申し送りで知らせます）', null);
  };
  App.prototype.askDayWord = function (date) {
    var today = (this.state.data || {}).today || ymd(new Date());
    if (!date || date === today) return '今日';
    var x = parseYmd(date), t0 = parseYmd(today), md = (x.getMonth() + 1) + '/' + x.getDate() + '（' + DOWS[x.getDay()] + '）';
    return Math.round((x - t0) / 864e5) === 1 ? '明日 ' + md : md;
  };
  App.prototype.askDraft = function (task, date) { return this.askDayWord(date).replace(/^明日 /, '') + 'の「' + task + '」、代わってもらえる？'; };
  App.prototype.swapToMe = function (d, take) {
    if (this.stale()) return;
    var self = this, me = this.meWho(), D = this.state.data;
    var revert = this.snapshot();
    this.mutate(function (X) { (X.duties || []).forEach(function (x) {
      if (x.id !== d.id) return;
      if (take) { if (!x.orig) x.orig = x.who; x.who = me; if (x.orig === me) x.orig = ''; }
      else if (x.orig) { x.who = x.orig; x.orig = ''; }
    }); });
    this.setState({ editor: null });
    this.send('swapDuty', { date: D.today, id: d.id, take: !!take }, revert);
    this.showToast(take ? '今日の「' + d.task + '」は自分がやります' : '「' + d.task + '」をいつもの担当に戻しました', null);
  };
  App.prototype.answerSwap = function (n, ok) {
    if (this.stale()) return;
    var self = this, me = this.meWho(), D = this.state.data;
    var revert = this.snapshot();
    this.mutate(function (X) {
      (X.notes || []).forEach(function (x) { if (x.id === n.id) { x.answer = ok ? 'ok' : 'ng'; x.read = true; } });
      if (ok && n.askDate === X.today) (X.duties || []).forEach(function (x) { if (x.id === n.taskId) { if (!x.orig) x.orig = x.who; x.who = me; } });
    });
    this.send('answerSwap', { id: n.id, ok: !!ok }, revert);
    USAGE.add('act:swap_' + (ok ? 'ok' : 'ng'));
    this.showToast(ok ? '「' + n.task + '」を代わりました' : '「むずかしい」と返しました', null);
  };
  App.prototype.openWho = function (d) { this.setState({ editor: { kind: 'who', isNew: false, id: d.id, task: d.task, dutyId: d.id } }); };

  /* 朝の出発時刻（分）。担当の時刻を「出発のN分前」にしておくと、出発を変えた時に一緒にずれる */
  App.prototype.departMin = function () { var u = this.ui(); return u.depart == null ? (u.hasOwnProperty('depart') ? null : 480) : Number(u.depart); };
  App.prototype.openDepart = function () { var m = this.departMin(); this.setState({ editor: { kind: 'depart', isNew: false, id: 'depart', time: hhmm(m == null ? 480 : m) } }); };
  App.prototype.saveDepart = function () {
    if (this.stale()) return;
    var e = this.state.editor, m = minOf(e.time);
    if (m == null || !e.time) { this.showToast('時刻を入れてください', null); return; }
    var revert = this.snapshot();
    this.mutate(function (D) {
      D.ui = Object.assign({}, D.ui, { depart: m });
      (D.duties || []).concat(D.dutiesAll || []).forEach(function (x) { if (x.rel != null) x.t = Math.max(0, m - x.rel); });
    });
    this.setState({ editor: null });
    this.send('setDepart', { time: e.time }, revert);
    var n = ((this.state.data || {}).dutiesAll || []).filter(function (x) { return x.rel != null; }).length;
    this.showToast('家を出る時刻を' + e.time.replace(/^0/, '') + 'にしました' + (n ? '（合わせた担当' + n + '件も動きました）' : ''), null);
  };
  App.prototype.deleteDuty = function () {
    var self = this, e = this.state.editor;
    var revert = this.snapshot();
    var old = (this.state.data.dutiesAll || []).filter(function (x) { return x.id === e.id; })[0];
    var kidRows = (this.state.data.dutiesAll || []).filter(function (x) { return x.parent === e.id; });
    this.mutate(function (D) {   /* 大項目を消すと小項目も消える（GAS も同じ） */
      D.dutiesAll = (D.dutiesAll || []).filter(function (x) { return x.id !== e.id && x.parent !== e.id; });
      D.duties = (D.duties || []).filter(function (x) { return x.id !== e.id && x.parent !== e.id; });
    });
    this.setState({ editor: null });
    this.send('deleteDuty', { id: e.id }, revert);
    this.showToast('「' + e.task + '」を消しました' + (kidRows.length ? '（小項目' + kidRows.length + '件も）' : ''), old ? function () {
      revert();
      self.send('saveDuty', { duty: old.parent ? { id: old.id, task: old.task, parent: old.parent } : { id: old.id, task: old.task, time: hhmm(old.t), rel: old.rel, who: old.who, rule: old.date ? '' : old.rule, date: old.date } });
      kidRows.forEach(function (k) { self.send('saveDuty', { duty: { id: k.id, task: k.task, parent: old.id } }); });
      self.setState({ toast: null });
    } : null);
  };

  /* くり返しの担当を、今日だけ休む（決まりは消さない） */
  App.prototype.skipToday = function (id, val) {
    if (this.stale()) return;
    var self = this, D = this.state.data || {}, row = (D.dutiesAll || []).filter(function (x) { return x.id === id; })[0];
    this.mutate(function (d) {
      d.skipped = d.skipped || {};
      if (val) { d.skipped[id] = true; d.duties = (d.duties || []).filter(function (x) { return x.id !== id && x.parent !== id; }); }   /* 大項目を休むと小項目も出さない */
      else {
        delete d.skipped[id];
        var today = parseYmd(d.today || ymd(new Date()));
        if (row && !row.date && dayMatch(row.rule, today.getDay()) && !(d.duties || []).some(function (x) { return x.id === id; })) d.duties.push({ id: id, t: row.t, task: row.task, who: row.who, once: false });
        if (row && !row.date && dayMatch(row.rule, today.getDay())) (d.dutiesAll || []).forEach(function (k) { if (k.parent === id && !(d.duties || []).some(function (x) { return x.id === k.id; })) d.duties.push({ id: k.id, t: row.t, task: k.task, who: row.who, once: false, parent: id }); });
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
    var key = name.replace(/\s/g, ''), chk = D.checked || {}, dup = null;
    groups.forEach(function (g) { g.items.forEach(function (x) { if (!chk[x[0]] && String(x[1]).replace(/\s/g, '') === key) dup = g.label; }); });
    if (dup) { this.showToast(name + 'はもう「' + dup + '」にあります', null); return false; }   /* まだ買っていない同じ品は足さない（献立から入れる時と同じ） */
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
    if (this.addShopItem(name, (st.shopQty || '').trim(), cat) === false) return;
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
    this.setState({ museOpen: true, museKind: kind, museDraft: L.join('\n'), accountOpen: false });
  };
  /* 入力中の文（申し送り・気づき）を Muse に整えてもらう：音声入力の誤変換と言いよどみだけ直して、アプリに入れてもらう。
   * 送るのは本人（下書きを見せて、コピーか WhatsApp で開く）。担当に付けた申し送り・代わってほしいの頼みは Muse から入れられないので、整えた文を返してもらうだけ */
  /* 「Museに出さない」担当（吸入・薬など）に付けた文は、Muse に渡す入口を出さない（GAS が list から外しているのと同じ線） */
  App.prototype.polishHidden = function () {
    var id = this.state.noteTaskId; if (!id) return false;
    var all = ((this.state.data || {}).dutiesAll || []);
    return all.some(function (d) { return d.id === id && (d.priv || d.privAny); });
  };
  App.prototype.polishMuse = function (from) {
    var list = from === 'notes';   /* 申し送りの一覧の書く欄から（担当には付かない） */
    var st = this.state, text = String((list ? st.draft : st.noteDraft) || '').trim();
    if (!list && this.polishHidden()) return;
    if (!text) { this.showToast('先に文を入れてください（キーボードのマイクで話せます）', null); return; }
    try { if (this.rec) { this.rec.onresult = null; this.rec.stop(); } } catch (e) {}   /* 止めた後に届く結果で下書きがずれないように */
    var me = this.meWho(), handover = list || st.noteMode === 'handover';
    var to = st.draftTo || this.otherWho();
    /* 担当に付けた文・代わってほしいの頼み・「今日の日記」以外に付けた気づきは、Muse からは同じ形で入れられないので、整えた文を返してもらう */
    var viaApp = !list && !!(st.noteTaskId || st.noteAsk || (!handover && st.noteTarget && st.noteTarget !== '今日の日記'));
    var L = ['わが家アプリ（わが家の今日）へのお願いです。私は「' + me + '」です。', '',
      '次の文は音声入力のままです。誤変換と言いよどみだけ直して整えてください。意味は変えず、内容を足したり削ったりしないでください。', '', '【文】', text, ''];
    if (viaApp) L.push('整えた文だけを返してください。アプリには入れないでください（私がアプリに貼って送ります）。');
    else if (handover) L.push('整えたら、わが家アプリで「' + to + '」への申し送りに入れてください（note.add）。入れたら、入れた文を私に見せてください。');
    else L.push('整えたら、わが家アプリの今日の日記に入れてください（diary.add）。入れたら、入れた文を私に見せてください。');
    USAGE.add('act:muse_polish');
    var upd = { museOpen: true, museKind: viaApp ? 'polishBack' : 'polish', museFrom: list ? 'notes' : 'note', museDraft: L.join('\n'), listening: false };
    upd[list ? 'notesOpen' : 'noteOpen'] = false;
    this.setState(upd);
  };
  /* 整える途中でやめたら、入力の画面に戻す（書いた文は残す） */
  App.prototype.closeMuseSheet = function () {
    var upd = { museOpen: false, museKind: '' };
    if (/^polish/.test(this.state.museKind || '')) upd[this.state.museFrom === 'notes' ? 'notesOpen' : 'noteOpen'] = true;
    this.setState(upd);
  };
  App.prototype.museSend = function (how) {
    var self = this, st = this.state;
    var text = String(st.museDraft || '').trim();
    if (!text) { this.showToast('送る文が空です', null); return; }
    var num = String(LS.get('museWa') || '').replace(/[^\d]/g, ''), wa = how === 'wa' && !!num;
    var kind = st.museKind || '', list = st.museFrom === 'notes', orig = list ? st.draft : st.noteDraft;
    /* 元の下書きに戻す（コピーできなかった時・トーストの「元に戻す」） */
    var restore = function () { self.setState(list ? { draft: orig, notesOpen: true, toast: null } : { noteDraft: orig, noteOpen: true, toast: null }); };
    var copied = null;
    try { if (navigator.clipboard) copied = navigator.clipboard.writeText(text); } catch (e) {}
    if (copied && copied.catch) copied.catch(function () {
      /* コピーできなかった：Museに貼れないので、整える時は下書きを戻して知らせる（WhatsApp は文を入れて開くので、そのまま） */
      if (wa) return;
      if (kind === 'polish') restore();
      self.showToast('文をコピーできませんでした。もう一度押すか、文を長押ししてコピーしてください', null);
    });
    if (wa) window.open('https://wa.me/' + num + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
    else window.open('https://muse.ai/', '_blank', 'noopener');
    USAGE.add('act:muse_' + (wa ? 'wa' : 'copy'));
    if (kind === 'polish') {
      /* 整えて入れてもらう：こちらの下書きは消す（二重に入らないように）。「元に戻す」で戻せる。一覧から来た時は一覧に戻る */
      this.setState(list ? { museOpen: false, museKind: '', draft: '', notesOpen: true } : { museOpen: false, museKind: '', noteDraft: '' });
      this.showToast(wa ? 'WhatsAppで送ると、Museが整えてアプリに入れます' : '文をコピーしました。Museに貼って送ると、整えてアプリに入れます', restore);
    } else if (kind === 'polishBack') {
      /* 返してもらうだけ：入力の画面に戻す（今の文と入れ替えて送る） */
      this.setState({ museOpen: false, museKind: '', noteOpen: true });
      this.showToast((wa ? '' : '文をコピーしました。') + 'Museが返した文に入れ替えて、ここから送ってください', null);
    } else {
      this.setState({ museOpen: false, museKind: '' });
      if (!wa) this.showToast('文をコピーしました。Museに貼って送ってください', null);
    }
  };

  /* 詳細を見る・コメント：話題・相談・日記・お出かけ・ニュースの全文と、ふたりのやりとり */
  App.prototype.openDetail = function (kind, id) {
    USAGE.add('act:detail_' + kind);
    this.setState({ detail: { kind: kind, id: id }, replyDraft: '' });
  };
  App.prototype.sendReply = function () {
    var dt = this.state.detail, text = String(this.state.replyDraft || '').trim();
    if (!dt || !text) return;
    if (this.addReplyTo(dt.kind, dt.id, text, this.state.replyTo && this.state.replyTo.id)) this.setState({ replyDraft: '', replyTo: null });
  };
  App.prototype.addReplyTo = function (kind, id, text, parent) {
    if (this.stale()) return false;
    var r = { id: uid('r'), target: kind + ':' + id, text: text, parent: parent || '' }, me = this.meWho(), revert = this.snapshot();
    this.mutate(function (d) { d.replies = (d.replies || []).concat([{ id: r.id, target: r.target, who: me, at: Date.now(), text: text, parent: r.parent }]); });
    this.send('addReply', { reply: r }, revert);
    return true;
  };
  /* 写真を足す：iPhoneの写真から選ぶ → 写真は長い辺1600pxのJPEGに縮めて送る（動画は15MBまでそのまま）。1枚ずつ順に */
  function shrinkImage(file) {
    var MAX = 1600;
    var draw = function (src, w, h) {
      var k = Math.min(1, MAX / Math.max(w, h)), c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85).split(',')[1];
    };
    var viaImg = function () {
      return new Promise(function (ok, ng) {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { try { ok(draw(img, img.naturalWidth, img.naturalHeight)); } catch (e) { ng(e); } URL.revokeObjectURL(url); };
        img.onerror = function () { URL.revokeObjectURL(url); ng(new Error('decode')); };
        img.src = url;
      });
    };
    return (window.createImageBitmap ? createImageBitmap(file).then(function (b) { var d = draw(b, b.width, b.height); if (b.close) b.close(); return d; }).catch(viaImg) : viaImg());
  }
  function readBase64(file) {
    return new Promise(function (ok, ng) { var r = new FileReader(); r.onload = function () { ok(String(r.result).split(',')[1] || ''); }; r.onerror = ng; r.readAsDataURL(file); });
  }
  App.prototype.pickPhotos = function () { var el = document.getElementById('photo-pick'); if (el) el.click(); };
  App.prototype.uploadPhotos = function (e) {
    var self = this, files = Array.prototype.slice.call((e && e.target && e.target.files) || [], 0, 20);
    if (e && e.target) e.target.value = '';
    if (!files.length) return;
    USAGE.add('act:photo_add');
    var done = 0, ng = 0, big = 0, n = files.length;
    var step = function (i) {
      if (i >= n) {
        self.showToast(done ? '写真を' + done + '件足しました' + (ng || big ? '（' + [big ? big + '件は大きすぎ' : '', ng ? ng + '件は失敗' : ''].filter(String).join('、') + '）' : '') : (big ? '大きすぎて送れませんでした（動画は15MBまで）' : '送れませんでした。電波のよい所でもう一度'), null);
        if (done) self.refresh(true, true);
        return;
      }
      var f = files[i], isVideo = /^video\//.test(f.type || '');
      self.showToast('写真を送っています ' + (i + 1) + ' / ' + n, null);
      if (isVideo && f.size > 15 * 1048576) { big++; step(i + 1); return; }
      var prep = isVideo ? readBase64(f).then(function (d) { return { mime: f.type === 'video/quicktime' ? 'video/quicktime' : 'video/mp4', data: d }; })
        : shrinkImage(f).then(function (d) { return { mime: 'image/jpeg', data: d }; });
      prep.then(function (x) { return api('addPhoto', x); })
        .then(function () { done++; }, function (err) { if (err && err.code === 'too_big') big++; else ng++; })
        .then(function () { step(i + 1); });
    };
    step(0);
  };

  /* 相談のカードのコメント1件ぶんの表示。長い文は3行で切り「続きを読む」で全文。返信（1段だけ）を下に並べる */
  App.prototype.commentVM = function (r, children, qid) {
    var self = this, st = this.state;
    var base = 'margin: 0; font-size: var(--t-sub); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; ';
    var one = function (c, isChild) {
      var o = !!(st.cmOpen || {})[c.id], lg = String(c.text).length > 60 || String(c.text).split('\n').length > 3;
      return { who: c.who, time: whenLabel(c.at), text: c.text, badgeStyle: self.badge(c.who), long: lg,
        textStyle: base + (lg && !o ? 'display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden' : ''),
        expandLabel: o ? '閉じる ⌃' : 'さらに見る ⌄',
        toggle: function () { var m = Object.assign({}, self.state.cmOpen || {}); if (m[c.id]) delete m[c.id]; else m[c.id] = true; self.setState({ cmOpen: m }); },
        mine: c.who === self.meWho(), del: function () { self.tapDeleteReply(c.id); }, delLabel: self.delLabelOf(c.id),
        style: 'display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-radius: var(--r-btn); background: ' + (isChild ? 'var(--card); margin-left: 16px; border-left: 3px solid var(--sep)' : 'var(--card2)') };
    };
    var vm = one(r, false);
    vm.replies = children.map(function (c) { return one(c, true); });
    vm.reply = function () { self.setState({ decCommentId: qid, decCommentDraft: '', decReplyTo: { id: r.id, who: r.who } }); setTimeout(function () { var el = document.getElementById('dec-comment-input'); if (el) el.focus(); }, 60); };
    return vm;
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
  /* コメントの削除は2回押し（1回目で「もう一度で削除」、4秒で元に戻る） */
  App.prototype.tapDeleteReply = function (id) {
    var self = this;
    if (this.state.delArm === id) { clearTimeout(this.delArmTimer); this.setState({ delArm: null }); this.deleteReply(id); return; }
    this.setState({ delArm: id });
    clearTimeout(this.delArmTimer);
    this.delArmTimer = setTimeout(function () { if (self.state.delArm === id) self.setState({ delArm: null }); }, 4000);
  };
  App.prototype.delLabelOf = function (id) { return this.state.delArm === id ? 'もう一度で削除' : '削除'; };
  App.prototype.deleteReply = function (id) {
    var revert = this.snapshot();
    this.mutate(function (d) { d.replies = (d.replies || []).filter(function (x) { return x.id !== id; }); });
    this.send('deleteReply', { id: id }, revert);
    this.showToast('コメントを削除しました', null);
  };

  /* 話題（旅のしおりなどのリンク） */
  App.prototype.openTopic = function (t) {
    this.setState({ editor: { kind: 'topic', isNew: !t, id: t ? t.id : uid('t'), title: t ? t.title : '', url: t ? t.url : '', note: t ? t.note : '', high: t ? !!t.high : false } });
  };
  App.prototype.saveTopic = function () {
    var e = this.state.editor, title = (e.title || '').trim(), url = (e.url || '').trim();
    if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
    if (/^http:\/\//.test(url)) url = url.replace(/^http:/, 'https:');
    if (!title) { this.showToast('見出しを入力してください', null); return; }
    if (url && !/^https:\/\/\S+$/.test(url)) { this.showToast('リンクは https:// から始まるものを入れてください', null); return; }
    var t = { id: e.id, title: title, url: url, note: (e.note || '').trim(), high: !!e.high };
    if (e.isNew && e.toArchive) {   /* リンク集に直接入れる */
      t.show = false;
      var rv0 = this.snapshot(), now0 = new Date();
      this.mutate(function (d) { d.topicsArchived = [Object.assign({ date: (now0.getMonth() + 1) + '/' + now0.getDate() }, t)].concat(d.topicsArchived || []); });
      this.setState({ editor: null, linksOpen: true });
      this.send('saveTopic', { topic: t }, rv0);
      this.showToast('リンク集に「' + title + '」を入れました', null);
      return;
    }
    var revert = this.snapshot();
    this.mutate(function (d) {
      var now = new Date(), list = (d.topics || []).filter(function (x) { return x.id !== t.id; });
      d.topics = e.isNew ? [Object.assign({ date: (now.getMonth() + 1) + '/' + now.getDate() }, t)].concat(list) : (d.topics || []).map(function (x) { return x.id === t.id ? Object.assign({}, x, t) : x; });
    });
    this.setState({ editor: null });
    this.send('saveTopic', { topic: t }, revert);
    this.showToast(e.isNew ? '話題に「' + title + '」を足しました' : '話題を直しました', null);
  };
  /* リンク集（アーカイブ）へしまう・話題に戻す。消さずに残しておき、いつでも見られる */
  App.prototype.archiveTopic = function (t, toArchive) {
    if (this.stale()) return;
    var nt = { id: t.id, title: t.title, url: t.url || '', note: t.note || '', show: !toArchive };
    var revert = this.snapshot();
    this.mutate(function (d) {
      var x = (d.topics || []).concat(d.topicsArchived || []).filter(function (y) { return y.id === t.id; })[0] || t;
      d.topics = (d.topics || []).filter(function (y) { return y.id !== t.id; });
      d.topicsArchived = (d.topicsArchived || []).filter(function (y) { return y.id !== t.id; });
      if (toArchive) d.topicsArchived = [Object.assign({}, x, { high: false })].concat(d.topicsArchived); else d.topics = [x].concat(d.topics);
    });
    this.setState({ editor: null });
    this.send('saveTopic', { topic: nt }, revert);
    var self = this;
    this.showToast(toArchive ? '「' + t.title + '」をリンク集にしまいました' : '「' + t.title + '」を話題に戻しました', function () { self.archiveTopic(t, !toArchive); self.setState({ toast: null }); });
  };
  /* 話題の優先度：高くすると色が変わって一番前に来る */
  App.prototype.toggleTopicHigh = function (t) {
    if (this.stale()) return;
    var on = !t.high, nt = { id: t.id, title: t.title, url: t.url || '', note: t.note || '', high: on };
    var revert = this.snapshot();
    this.mutate(function (d) { (d.topics || []).forEach(function (x) { if (x.id === t.id) x.high = on; }); });
    this.send('saveTopic', { topic: nt }, revert);
    setTimeout(function () { var el = document.querySelector('section[aria-labelledby="sec-topics"] .strip'); if (el && el.scrollTo) el.scrollTo({ left: 0, behavior: 'smooth' }); }, 60);
    this.showToast(on ? '「' + t.title + '」を優先度高にしました' : '「' + t.title + '」の優先度を戻しました', null);
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
  /* 献立の材料を買い物リストへ：先にシートを開き、材料ごとに行き先（買い物リストの分類／家にある）を選んでから、まとめて送る。
   * すでにリストにある物（まだ買っていない）は「リストにある」で選べない。既定は前回その品を入れた分類、分からなければお店 */
  var AT_HOME = '家にある';
  function shopKey(n) { return String(n || '').replace(/[\s　]/g, '').toLowerCase(); }   /* GAS の normName と同じ */
  App.prototype.shopCatList = function () {
    var D = this.state.data || {}, out = [];
    ((D.shop && D.shop.groups) || []).forEach(function (g) { if (out.indexOf(g.label) < 0) out.push(g.label); });
    (D.shopCats || []).forEach(function (c) { if (c && out.indexOf(c) < 0) out.push(c); });
    if (!out.length) out.push('その他');
    return out.slice(0, 5);
  };
  App.prototype.shopHave = function () {
    var D = this.state.data || {}, chk = D.checked || {}, have = {};
    ((D.shop && D.shop.groups) || []).forEach(function (g) { g.items.forEach(function (x) { if (!chk[x[0]]) have[shopKey(x[1])] = 1; }); });
    return have;
  };
  App.prototype.menuToShop = function (dm) {
    if (this.stale()) return;
    var D = this.state.data || {}, cats = this.shopCatList(), last = D.shopLastCat || {}, have = this.shopHave();
    var shopCat = cats.filter(function (c) { return /店/.test(c); })[0] || cats[0];
    var seen = {};
    var rows = (dm.ingredients || []).filter(function (x) { var k = shopKey(x.name); if (!k || seen[k]) return false; seen[k] = 1; return true; }).map(function (x) {
      var k = shopKey(x.name), prev = last[k];
      return { name: x.name, qty: x.qty || '', onList: !!have[k], cat: prev && cats.indexOf(prev) >= 0 ? prev : shopCat };
    });
    if (!rows.length) return;
    var d = parseYmd(dm.date || ymd(new Date()));
    USAGE.add('act:toShopOpen');
    this.setState({ editor: { kind: 'toShop', isNew: true, dish: dm.dish, dateLabel: (d.getMonth() + 1) + '/' + d.getDate() + '（' + DOWS[d.getDay()] + '）', rows: rows } });
  };
  App.prototype.setToShopCat = function (i, cat) {
    var e = this.state.editor; if (!e || e.kind !== 'toShop') return;
    var rows = e.rows.map(function (r, j) { return j === i ? Object.assign({}, r, { cat: cat }) : r; });
    this.editSet('rows', rows);
  };
  App.prototype.sendToShop = function () {
    if (this.stale()) return;
    var e = this.state.editor, D = this.state.data || {}, week = (D.shop && D.shop.week) || ymd(new Date());
    var have = this.shopHave();   /* シートを開いている間にリストが変わっていても、ここでもう一度確かめる */
    var items = e.rows.filter(function (r) { return !r.onList && r.cat !== AT_HOME && !have[shopKey(r.name)]; })
      .map(function (r) { return { id: uid('s'), name: r.name, qty: r.qty || '', cat: r.cat, week: week }; });
    var homeN = e.rows.filter(function (r) { return !r.onList && r.cat === AT_HOME; }).length;
    this.setState({ editor: null });
    if (!items.length) { this.showToast(homeN ? '送る物はありませんでした（家にある ' + homeN + '品）' : '材料はもう全部リストにあります', null); return; }
    this.mutate(function (d) {
      d.shop = d.shop || { week: week, groups: [] };
      items.forEach(function (x) {
        var g = d.shop.groups.filter(function (y) { return y.label === x.cat; })[0];
        if (!g) { g = { label: x.cat, items: [] }; d.shop.groups.push(g); }
        g.items.push([x.id, x.name, x.qty]);
      });
      d.shopSuggest = (d.shopSuggest || []).filter(function (s) { return !items.some(function (x) { return shopKey(x.name) === shopKey(s.name); }); });
    });
    this.send('addShopMany', { items: items }, this.snapshot());
    var by = {}; items.forEach(function (x) { var k = shortCat(x.cat); by[k] = (by[k] || 0) + 1; });
    this.showToast(e.dish + 'の材料を' + items.length + '品、買い物リストに足しました（' + Object.keys(by).map(function (k) { return k + ' ' + by[k]; }).join('・') + (homeN ? '。家にある ' + homeN + '品は送っていません' : '') + '）', null);
  };
  /* 分類の名前は短く出す（「WEBで頼む（冷凍・重いもの）」→「WEBで頼む」） */
  function shortCat(c) { return String(c || '').replace(/[（(][^）)]*[）)]/g, '').trim() || String(c || ''); }

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
    return 'flex-shrink: 0; font-size: var(--t-cap); font-weight: 600; color: ' + c.ink + '; color: color-mix(in srgb, ' + c.ink + ' var(--pc-ink), #FFFFFF); background: ' + c.tint + '; background: color-mix(in srgb, ' + c.ink + ' var(--pc-tint), transparent); border-radius: var(--r-chip); padding: 4px 12px; white-space: nowrap';
  };

  /* 人の色：ダークモードでは白に寄せて読みやすくする（--pc-ink・--pc-tint） */
  function inkText(ink) { return 'color-mix(in srgb, ' + ink + ' var(--pc-ink), #FFFFFF)'; }
  function inkTint(ink) { return 'color-mix(in srgb, ' + ink + ' var(--pc-tint), transparent)'; }
  /* 選ぶ札：選んだ物は塗り、ほかは薄い灰色。人の札だけ人の色（ダークでは明るく寄せる） */
  function pill(on, ink) {
    return 'flex-shrink: 0; min-height: 44px; padding: 0 16px; border-radius: var(--r-chip); border: none; font-size: var(--t-sub); font-weight: 600; cursor: pointer; transition: background-color .2s, color .2s; background: ' + (on ? (ink || 'var(--accent-bg)') : 'var(--fill)') + '; color: ' + (on ? '#FFFFFF' : (ink ? 'color-mix(in srgb, ' + ink + ' var(--pc-ink), #FFFFFF)' : 'var(--label)'));
  }
  var SHEET_POS = 'position: fixed; left: 0; right: 0; bottom: 0; width: 100%; max-width: 480px; margin: 0 auto; box-sizing: border-box; ';
  var SHEET_PAD = 'padding: 12px 16px calc(24px + env(safe-area-inset-bottom)); ';
  function backdrop(open) { return 'position: fixed; inset: 0; width: 100%; border: none; padding: 0; background: var(--scrim); z-index: 30; transition: opacity .3s; ' + (open ? 'opacity: 1' : 'opacity: 0; pointer-events: none'); }
  function sheetStyle(open, extra, ease) {
    return SHEET_POS + extra + 'background: var(--card); border-radius: var(--r-sheet) var(--r-sheet) 0 0; box-shadow: 0 -1px 0 var(--sep), 0 120px 0 0 var(--card); ' + SHEET_PAD + 'display: flex; flex-direction: column; gap: 12px; z-index: 40; transition: transform ' + (ease || '.5s var(--ease-sheet)') + '; ' + (open ? 'transform: translateY(0)' : 'transform: translateY(105%); visibility: hidden');
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
      };
    });

    var tOrd = function (x) { return x.t == null ? 99999 : x.t; };
    /* 小項目（parent あり）は大項目の行の中に並べる。数・つぎの担当・タイムラインは大項目だけで数える */
    var kidsOf = {};
    (D.duties || []).forEach(function (x) { if (x.parent) (kidsOf[x.parent] = kidsOf[x.parent] || []).push(x); });
    var duties = (D.duties || []).filter(function (x) { return !x.parent || !(D.duties || []).some(function (y) { return y.id === x.parent; }); }).sort(function (a, b) { return tOrd(a) - tOrd(b); });
    /* 大項目の済は「小項目が全部済」。行・見出しの数・つぎの担当・タイムラインを同じ決まりで数える */
    done = Object.assign({}, done);
    Object.keys(kidsOf).forEach(function (pid) { var ks = kidsOf[pid]; if (ks.length) { if (ks.every(function (k) { return done[k.id]; })) done[pid] = true; else delete done[pid]; } });
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
    /* つぎの担当：白いカード。人の色は左の細い印と名札だけ */
    hero.bandStyle = 'margin: 4px 16px 0; padding: 16px 16px 12px 20px; border-radius: var(--r-card); background: var(--card); color: var(--label); box-shadow: inset 4px 0 0 ' + hero.color + '; display: flex; flex-direction: column; gap: 8px; animation: heroIn .6s var(--ease) both';
    hero.whoStyle = this.badge(hero.who);
    hero.marks = [tS, 720, 1080, tE].filter(function (m, k, a) { return (k === 0 || k === a.length - 1 || (m > tS + 90 && m < tE - 90)); }).map(function (m, k, a) {
      var p0 = pct(m);
      return { label: hm(m), style: 'position: absolute; top: 0; ' + (k === 0 ? 'left: 0' : (k === a.length - 1 ? 'right: 0' : 'left: ' + p0 + '%; transform: translateX(-50%)')) };
    });
    hero.passedStyle = 'position: absolute; left: 0; top: 13px; height: 2px; width: ' + pct(nowMin) + '%; background: var(--accent); border-radius: 2px';
    hero.nowStyle = 'position: absolute; top: 4px; left: calc(' + pct(nowMin) + '% - 1px); width: 2px; height: 20px; background: var(--accent); border-radius: 2px; animation: breathe 2.4s ease-in-out infinite';
    var timeline = mine.filter(function (d) { return d.t != null; }).map(function (d) {
      var isNext = next && d.id === next.id;
      var size = isNext ? 14 : 8;
      var fill = done[d.id] || d.t < nowMin ? 'var(--accent)' : 'var(--card)';
      return { dotStyle: 'position: absolute; top: ' + (14 - size / 2) + 'px; left: calc(' + pct(d.t) + '% - ' + size / 2 + 'px); width: ' + size + 'px; height: ' + size + 'px; border-radius: 50%; box-sizing: border-box; border: 2px solid ' + (fill === 'var(--card)' ? 'var(--label3)' : 'var(--accent)') + '; background: ' + fill };
    });

    var flow = mine.map(function (d) {
      var kids = kidsOf[d.id] || [];
      var kidsDone = kids.filter(function (k) { return !!done[k.id]; }).length;
      var isDone = kids.length ? kidsDone === kids.length : !!done[d.id];
      var past = d.t != null && d.t < nowMin;
      var c = self.person(d.who);
      /* 今日の流れに出す申し送りは「今日のもの」だけ（今日書いた物と、今日の担当についての頼み）。前の日の物は申し送りの一覧で見る */
      var todayStr = D.today || ymd(now);
      /* ふつうの申し送りは今日書いた物。前の日の物は、昨日のこの担当の時刻より後に書いて、まだ確認していない物だけ
         （夜に書いた明日の朝の分は朝に出す。確認済みの昨日の物＝「雨のためスキップ」などは出さない）。時刻のない担当は今日書いた物だけ */
      var t0d = parseYmd(todayStr).getTime(), since = d.t != null ? t0d - 864e5 + d.t * 60000 : t0d;
      var tnotes = notesAll.filter(function (n) { return n.taskId === d.id && (n.ask === 'swap' ? n.askDate === todayStr : (n.createdAt >= t0d || (!n.read && n.createdAt >= since))); });
      return {
        id: d.id, time: hm(d.t), task: d.task, who: d.who, done: isDone, once: !!d.once, isNew: !!marks['flow:' + d.id],
        toggle: function () {
          var v = !isDone;
          if (kids.length) {   /* 大項目を押すと小項目も全部 */
            var ids = [d.id].concat(kids.map(function (k) { return k.id; }));
            var before = ids.filter(function (id) { return !!done[id]; });
            self.setDoneMany(ids, v);
            self.showToast(v ? '「' + d.task + '」を小項目もまとめて終わりにしました' : '「' + d.task + '」を小項目もまとめて未完了に戻しました', function () {
              self.setDoneMany(ids, !v); if (before.length && v) self.setDoneMany(before, true); self.setState({ toast: null }); });   /* 全部済にしたのを戻す時は、前から済だった小項目は済のまま */
            return;
          }
          self.setDone(d, v);
          self.showToast(v ? '「' + d.task + '」を終わりにしました' : '「' + d.task + '」を未完了に戻しました', function () { self.setDone(d, !v); self.setState({ toast: null }); });
        },
        hasSubs: kids.length > 0,
        subCount: kids.length ? kidsDone + ' / ' + kids.length : '',
        subs: kids.map(function (k) {
          var kd = !!done[k.id];
          return { id: k.id, task: k.task, done: kd ? 'true' : 'false', isDone: kd,
            toggle: function () {
              var v2 = !kd, after = kids.filter(function (x) { return x.id === k.id ? v2 : !!done[x.id]; }).length === kids.length;
              var ids2 = [k.id]; if (!!done[d.id] !== after) ids2.push(d.id);   /* 全部そろったら大項目も済に、1つ外したら大項目も戻す */
              if (ids2.length > 1) self.setDoneMany(ids2, v2); else self.setDone(k, v2);   /* 大項目が変わる時は、必ず小項目と同じ向き */
            },
            markStyle: 'width: 20px; height: 20px; flex-shrink: 0; border-radius: 6px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; border: 2px solid ' + inkText(c.ink) + '; background: ' + (kd ? inkText(c.ink) : 'transparent'),
            taskStyle: 'font-size: var(--t-sub); font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; ' + (kd ? 'color: var(--label2); text-decoration: line-through' : '') };
        }),
        wrapStyle: 'border-radius: var(--r-card); transition: background .3s, opacity .3s; background: ' + (isDone ? 'var(--card2)' : 'var(--card)') + '; ' + (past && !isDone ? 'opacity: 0.72' : ''),
        notes: tnotes.map(function (n) {
          return {
            text: n.text,
            meta: n.from + 'から' + n.to + 'へ　' + whenLabel(n.createdAt).replace('今日 ', '') + (n.read ? '　確認済み' : '　未確認'),
            bubbleStyle: 'margin: 0 12px 12px 72px; padding: 8px 12px; border-radius: 12px 12px 12px 4px; font-size: var(--t-foot); line-height: 1.6; transition: background .3s; animation: rise .35s cubic-bezier(.2,.8,.2,1) both; background: ' + (n.read ? 'var(--card2)' : 'var(--attn-soft)')
          };
        }),
        hasNotes: tnotes.some(function (n) { return !n.read; }),
        noteCount: tnotes.filter(function (n) { return !n.read; }).length,
        noteLabel: '「' + d.task + '」の申し送りを書く',
        openNote: function () { self.openNoteFor(d.task, d.id, 'handover', d.who); },
        noteBtnStyle: 'position: relative; width: 44px; min-height: 52px; margin-right: 4px; flex-shrink: 0; border-radius: var(--r-btn); border: none; background: transparent; color: var(--label3); display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: center; cursor: pointer',
        markStyle: 'width: 24px; height: 24px; flex-shrink: 0; border-radius: 50%; box-sizing: border-box; display: flex; align-items: center; justify-content: center; transition: background .2s; border: 2px solid ' + inkText(c.ink) + '; background: ' + (isDone ? inkText(c.ink) : 'transparent'),
        taskStyle: 'display: inline; font-size: var(--t-body); font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-decoration-break: clone; box-decoration-break: clone; background-image: linear-gradient(currentColor, currentColor); background-repeat: no-repeat; background-position: 0 55%; transition: background-size .35s cubic-bezier(.2,.8,.2,1), color .3s; background-size: ' + (isDone ? '100% 1.5px; color: var(--label2)' : '0% 1.5px'),
        badgeStyle: self.badge(d.who),
        whoLabel: d.who, swapped: !!d.orig, swapNote: '',
        whoAria: '担当：' + d.who + (d.orig ? '（今日の担当。いつもは' + d.orig + '）' : '') + '。押すと担当を替えられます',
        openWho: function () { self.openWho(d); }
      };
    });

    /* 担当の編集：くり返しも「その日だけ」も全部並べる */
    function ruleLabel(x) {
      if (x.date) { var dd = parseYmd(x.date); return (x.date === D.today ? '今日' : (dd.getMonth() + 1) + '/' + dd.getDate()) + 'だけ'; }
      return ruleWords(x.rule || '毎日');
    }
    var allRows = (D.dutiesAll || []).filter(function (d) { return whoSel === 'all' || d.who === whoSel || d.who === '家族'; });
    var hasRow = {}; allRows.forEach(function (d) { hasRow[d.id] = d; });
    var flowEditRows = [];
    allRows.filter(function (d) { return !d.parent || !hasRow[d.parent]; }).sort(function (a, b) { return tOrd(a) - tOrd(b); }).forEach(function (d) {
      flowEditRows.push({ time: hm(d.t), task: d.task, who: d.who, rule: ruleLabel(d), badgeStyle: self.badge(d.who), open: function () { self.openDuty(d); } });
      allRows.filter(function (k) { return k.parent === d.id; }).forEach(function (k) {   /* 小項目は大項目の下に字下げで */
        flowEditRows.push({ time: '', task: '└ ' + k.task, who: k.who, rule: '「' + d.task + '」の小項目', badgeStyle: self.badge(k.who), open: function () { self.openDuty(k); } });
      });
    });

    /* 今週のごはん（来週へも送れる。来週の献立は GAS が menuTo まで返す。古い GAS なら今週だけ） */
    var start0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - todayIdx);
    var menuWeeks = D.menuTo ? Math.max(1, Math.min(2, Math.round((parseYmd(D.menuTo) - start0) / 864e5 / 7))) : 1;
    var wkOff = Math.max(0, Math.min(menuWeeks - 1, st.menuWeek || 0));
    var start = new Date(start0.getFullYear(), start0.getMonth(), start0.getDate() + 7 * wkOff);
    var todayInWeek = wkOff === 0 ? todayIdx : -1;
    if (wkOff && st.day === null) dayIdx = 0;
    var todayStrM = D.today || ymd(now);
    var menuMap = {};
    (D.menu || []).forEach(function (m) { menuMap[m.date] = m; });
    var menuByDow = dows.map(function (_, i) {
      var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return menuMap[ymd(dt)] || { dish: ui.noMenuDish || 'まだ決まっていません', hotcook: false, note: ui.noMenuNote || '', ingredients: [], how: '', photo: '' };
    });
    var todayMenu = menuMap[ymd(now)];
    var mdLabel = function (dt) { return (dt.getMonth() + 1) + '/' + dt.getDate(); };
    var weekNav = menuWeeks < 2 ? [] : [[0, '今週'], [1, '来週']].map(function (w) {
      var on = w[0] === wkOff;
      return { label: w[1], pressed: on ? 'true' : 'false', style: chip(on),
        pick: function () { if (self.state.menuWeek === w[0]) return; USAGE.add('act:menuWeek'); self.setState({ menuWeek: w[0], day: null, dayAnim: self.state.dayAnim + 1 }); } };
    });
    var weekRange = mdLabel(start) + '（日）〜' + mdLabel(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)) + '（土）';
    var week = dows.map(function (d, i) {
      var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var on = i === dayIdx;
      var isToday = i === todayInWeek;
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
      label: dayIdx === todayInWeek ? '今日' : wkOff ? '来週' + dows[dayIdx] + '曜' : dows[dayIdx] + '曜', servingsLabel: dm.servings ? '・' + dm.servings + '人分' : '', dish: dm.dish, hotcook: !!dm.hotcook, note: dm.note || '',
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
    /* どの献立の材料か：今日から先（今週・来週）の献立の材料と品名を、画面の側で突き合わせる（シートの列は増やさない） */
    var ingKey = function (n) { var t = String(n || ''); try { t = t.normalize('NFKC'); } catch (e) { /* 古い端末 */ } return t.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s　]/g, '').toLowerCase(); };
    var forMenu = {};
    (D.menu || []).filter(function (m) { return m.date >= todayStrM && m.dish; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (m) {
      (m.ingredients || []).forEach(function (x) { var k = ingKey(x[0]); if (!k) return; var l = forMenu[k] = forMenu[k] || []; if (!l.some(function (y) { return y.date === m.date; })) l.push({ date: m.date, dish: m.dish }); });
    });
    var nextWeek0 = ymd(new Date(start0.getFullYear(), start0.getMonth(), start0.getDate() + 7));
    var dayWord = function (date) { var w = DOWS[parseYmd(date).getDay()]; return date === todayStrM ? '今日' : w; };
    var forMenuOf = function (name) {
      var l = forMenu[ingKey(name)]; if (!l) return null;
      if (l.length === 1) return { text: (l[0].date >= nextWeek0 ? '来週' : '') + dayWord(l[0].date) + '：' + l[0].dish, aria: dayWord(l[0].date) + '（' + l[0].date.slice(5).replace('-', '/') + '）の' + l[0].dish + 'の材料' };
      var a = l.filter(function (x) { return x.date < nextWeek0; }).map(function (x) { return dayWord(x.date); }), b = l.filter(function (x) { return x.date >= nextWeek0; }).map(function (x) { return dayWord(x.date); });
      return { text: a.concat(b.length ? ['来週' + b.join('・')] : []).join('・'), aria: l.map(function (x) { return x.date.slice(5).replace('-', '/') + 'の' + x.dish; }).join('、') + 'の材料' };
    };
    var shop = groups.map(function (g) {
      var items = [];
      g.items.forEach(function (x) {
        var on = !!checked[x[0]], fm = forMenuOf(x[1]);
        total += 1; if (on) got += 1;
        if (st.hideBought && on) return;
        items.push({
          name: x[1], qty: x[2], checked: on, editing: !!st.shopEdit, isNew: !!marks['shop:' + x[0]],
          forMenu: fm ? fm.text : '', forMenuAria: fm ? fm.aria : '',
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
    /* 選ぶ札は見た目の決まり（pill）にそろえる。人の色以外の色は使わない */
    function chip(on) { return pill(on); }
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
        style: 'align-self: flex-start; min-height: 44px; padding: 0; border: none; background: transparent; color: var(--accent); font-size: var(--t-sub); font-weight: 600; cursor: pointer' };   /* ボタンではなく文字のリンク（デザインの見直し） */
    };
    var arch = D.topicsArchived || [];
    var linksArchive = {
      show: arch.length > 0, open: !!st.linksOpen, expanded: st.linksOpen ? 'true' : 'false',
      label: st.linksOpen ? 'リンク集を閉じる ⌃' : 'リンク集（アーカイブ ' + arch.length + '件）⌄',
      toggle: function () { self.setState({ linksOpen: !self.state.linksOpen }); USAGE.add('act:links_archive'); },
      items: arch.map(function (t) {
        return { title: t.title, note: t.note || '', hasNote: !!t.note, url: t.url, hasUrl: !!t.url, noUrl: !t.url, date: t.date || '',
          host: (function () { try { var h = new URL(t.url).hostname; return h === 'claude.ai' ? 'Claude' : h.replace(/^www\./, ''); } catch (e) { return ''; } })(),
          restore: function () { self.archiveTopic(t, false); } };
      })
    };
    var topics = (D.topics || []).filter(function (t) { return t.high; }).concat((D.topics || []).filter(function (t) { return !t.high; })).map(function (t) {
      return { isNew: !!marks['topics:' + t.id], title: t.title, note: t.note, more: moreOf('topics', t.id), titleStyle: clamp(2, 'font-size: var(--t-body); font-weight: 700; line-height: 1.4'), noteStyle: clamp(5, 'font-size: var(--t-foot); color: var(--label); line-height: 1.6'), url: t.url, hasUrl: !!t.url, date: t.date || '', editing: !!st.topicEdit, open: function () { self.openTopic(t); },
        archive: function () { self.archiveTopic(t, true); },
        high: !!t.high, highLabel: t.high ? '優先度 高' : '優先度を高く', highPressed: t.high ? 'true' : 'false', toggleHigh: function () { self.toggleTopicHigh(t); },
        highBtnStyle: 'flex-shrink: 0; min-height: 32px; padding: 0 10px; border-radius: var(--r-chip); border: none; cursor: pointer; font-size: var(--t-cap); font-weight: 700; ' + (t.high ? 'background: #FFFFFF; color: #1D1D1F' : 'background: rgba(255,255,255,.22); color: #FFFFFF'),
        /* Apple Store・Amazon のような横スライドのカード：幅をそろえて次のカードを少し見せ、1枚ずつ止まる */
        /* カードごとに色（Apple Store・Amazon のカルーセル風）。色は話題ごとに決まる（id から）。文字は白 */
        cardStyle: 'flex-shrink: 0; width: var(--w-slide); min-height: 176px; box-sizing: border-box; scroll-snap-align: start; display: flex; flex-direction: column; gap: 8px; padding: 18px; border-radius: var(--r-card); color: #FFFFFF; box-shadow: var(--shadow-card); background: linear-gradient(150deg, ' + TOPIC_TONES[hashIdx(t.id || t.title, TOPIC_TONES.length)].join(', ') + ')',
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
      var tone = TOPIC_TONES[hashIdx(x.id || x.q, TOPIC_TONES.length)];   /* 上の帯と、下の薄い色（v73） */
      var mine = me1 ? x.a1 : x.a2;
      var both = x.a1 && x.a1 === x.a2 && x.a1 !== '話したい';
      var base = (x.options || []).filter(function (o) { return o && o !== '話したい'; });   /* シートに「話したい」があっても2つ出さない */
      var opts = (base.length ? base : ['賛成', '反対']).concat(['話したい']).map(function (o) {
        var picks = [];
        if (x.a1 === o) picks.push({ label: names[0], style: self.badge(names[0]) });
        if (x.a2 === o) picks.push({ label: names[1], style: self.badge(names[1]) });
        var on = mine === o;
        return { label: (on ? '✓ ' : '') + o, picks: picks, pressed: on ? 'true' : 'false', pick: function () { self.answer(x, o); },
          style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 48px; padding: 0 12px; border-radius: var(--r-btn); text-align: left; cursor: pointer; font-size: var(--t-sub); font-weight: 600; border: none; color: ' + (on ? '#1D1D1F' : '#FFFFFF') + '; background: ' + (on ? 'rgba(255,255,255,.96)' : 'rgba(255,255,255,.2)') + '; box-shadow: none' };
      });
      var other = me1 ? x.a2 : x.a1, otherName = me1 ? names[1] : names[0];
      var waiting = !mine && !other ? 'まだ2人とも答えていません。あなたから答えられます'
        : !mine ? 'あなたの番です（' + otherName + 'は答えました）'
        : !other ? otherName + 'の答え待ち'
        : (mine === '話したい' || other === '話したい') ? (other === '話したい' ? otherName + 'が話したいそうです' : '話したい、と伝えています')
        : both ? '答えがそろいました' : '答えが分かれています。話して決めましょう';
      return { isNew: !!marks['decide:' + x.id], more: Object.assign(moreOf('decide', x.id), { label: '詳細を見る' }), qStyle: clamp(3, 'font-size: var(--t-body); font-weight: 700; line-height: 1.45'), noteStyle: clamp(2, 'margin: 0; font-size: var(--t-foot); color: var(--label); line-height: 1.6'), q: x.q, note: x.note, hasNote: !!x.note, due: dueLabel(x.due), hasDue: !!x.due && !decided, decided: decided, open: !decided, decidedText: x.decided, opts: opts, waiting: waiting,
        comments: (function () {
          var all = (D.replies || []).filter(function (r) { return r.target === 'decide:' + x.id; }).sort(function (a, b) { return a.at - b.at; });
          var tops = all.filter(function (r) { return !r.parent || !all.some(function (p) { return p.id === r.parent; }); });
          var showAll = !!(st.decAllOpen || {})[x.id];
          return (showAll ? tops : tops.slice(-2)).map(function (r) { return self.commentVM(r, all.filter(function (c) { return c.parent === r.id; }), x.id); });
        })(),
        moreComments: (function () {
          var all = (D.replies || []).filter(function (r) { return r.target === 'decide:' + x.id; });
          var tops = all.filter(function (r) { return !r.parent || !all.some(function (p) { return p.id === r.parent; }); }).length;
          if (tops <= 2) return '';
          return (st.decAllOpen || {})[x.id] ? '前のコメントを閉じる ⌃' : '前のコメントをさらに見る（' + (tops - 2) + '件）⌄';
        })(),
        toggleAll: function () { var m = Object.assign({}, self.state.decAllOpen || {}); if (m[x.id]) delete m[x.id]; else m[x.id] = true; self.setState({ decAllOpen: m }); },
        commentOpen: st.decCommentId === x.id, commentLabel: st.decCommentId === x.id ? 'やめる' : 'コメントする',
        /* コメントはふだん畳んでおく（カードを短く）。「コメント N件 ⌄」で開く。書いている間は開いたまま */
        threadOpen: !!((st.decThreadOpen || {})[x.id] || st.decCommentId === x.id),
        hasThread: (D.replies || []).some(function (r) { return r.target === 'decide:' + x.id; }),
        threadLabel: (function () { var n = (D.replies || []).filter(function (r) { return r.target === 'decide:' + x.id; }).length; return ((st.decThreadOpen || {})[x.id] || st.decCommentId === x.id) ? 'コメントを閉じる ⌃' : 'コメント ' + n + '件 ⌄'; })(),
        threadExpanded: ((st.decThreadOpen || {})[x.id] || st.decCommentId === x.id) ? 'true' : 'false',
        showCommentBtn: !(D.replies || []).some(function (r) { return r.target === 'decide:' + x.id; }) || !!((st.decThreadOpen || {})[x.id] || st.decCommentId === x.id),   /* コメントがある時は、開いてから書く */
        toggleThread: function () { var m = Object.assign({}, self.state.decThreadOpen || {}); if (m[x.id] || self.state.decCommentId === x.id) { delete m[x.id]; self.setState({ decThreadOpen: m, decCommentId: self.state.decCommentId === x.id ? null : self.state.decCommentId }); } else { m[x.id] = true; self.setState({ decThreadOpen: m }); } },
        commentExpanded: st.decCommentId === x.id ? 'true' : 'false',
        replyToLabel: st.decCommentId === x.id && st.decReplyTo ? st.decReplyTo.who + 'のコメントへの返信' : '',
        cancelReplyTo: function () { self.setState({ decReplyTo: null }); },
        toggleComment: function () { self.setState({ decCommentId: self.state.decCommentId === x.id ? null : x.id, decCommentDraft: '', decReplyTo: null }); setTimeout(function () { var el = document.getElementById('dec-comment-input'); if (el) el.focus(); }, 60); },
        sendComment: function () {
          var text = String(self.state.decCommentDraft || '').trim();
          if (!text) { self.showToast('コメントを入力してください', null); return; }
          if (self.addReplyTo('decide', x.id, text, self.state.decReplyTo && self.state.decReplyTo.id)) { USAGE.add('act:decide_comment'); var m = Object.assign({}, self.state.decThreadOpen || {}); m[x.id] = true; self.setState({ decCommentId: null, decCommentDraft: '', decReplyTo: null, decThreadOpen: m }); }   /* 書いた後は開いたまま（自分のコメントが見える） */
        },
        openAll: function () { self.openDetail('decide', x.id); },
        muse: function () { self.openMuse('decide', x); }, canDecide: both && !decided, decide: function () { self.decideNow(x, false); }, reopen: function () { self.decideNow(x, true); }, edit: function () { self.openDecision(x); },
        /* 話題と同じ横スライドのカード。上の質問の帯だけ相談ごとの色（TOPIC_TONES）、答える所は白で読みやすく */
        cardStyle: 'flex-shrink: 0; width: var(--w-slide); box-sizing: border-box; scroll-snap-align: start; display: flex; flex-direction: column; gap: 8px; padding: 0 16px 8px; overflow: hidden; border-radius: var(--r-card); ' + (decided ? 'box-shadow: none; background: var(--card2)' : 'color: #FFFFFF; box-shadow: var(--shadow-card); background: linear-gradient(150deg, ' + tone.join(', ') + ')'),
        headStyle: 'display: flex; flex-direction: column-reverse; justify-content: flex-end; gap: 4px; align-items: flex-start; margin: 0 -16px 4px; padding: 16px 16px 4px; box-sizing: border-box; color: #FFFFFF; background: ' + (decided ? 'linear-gradient(150deg, ' + tone.join(', ') + ')' : 'transparent') };
    });

    /* 決まった相談はアーカイブへ。一覧には決まっていないものだけ出し、下の「決まったこと」で広げる（新しく決まった順＝シートの下から） */
    var decDone = (D.decisions || []).filter(function (x) { return x.state === '決まった'; }).reverse();
    var decArchiveOpen = !!st.decArchiveOpen;
    var decArchive = {
      show: decDone.length > 0, open: decArchiveOpen, expanded: decArchiveOpen ? 'true' : 'false',
      label: decArchiveOpen ? '決まったことを閉じる ⌃' : '決まったこと（アーカイブ ' + decDone.length + '件）⌄',
      toggle: function () { self.setState({ decArchiveOpen: !self.state.decArchiveOpen }); USAGE.add('act:decide_archive'); },
      items: decDone.map(function (x) {
        return { q: x.q, decidedText: x.decided, qStyle: clamp(2, 'font-size: var(--t-sub); font-weight: 700; line-height: 1.45; color: var(--label)'),
          more: moreOf('decide', x.id),
          reopen: function () { self.decideNow(x, true); } };
      })
    };
    decisions = decisions.filter(function (x) { return !x.decided; });

    /* 期限があるもの */
    var deadlines = (D.deadlines || []).filter(function (x) { return whoSel === 'all' || !x.who || x.who === whoSel || x.who === '家族'; }).sort(function (a, b) { return (a.done - b.done) || ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0); }).map(function (x) {
      var n = x.due ? Math.round((parseYmd(x.due) - parseYmd(todayStr0)) / 864e5) : 99;
      var col = x.done ? 'var(--label2)' : (n < 0 ? 'var(--danger)' : n <= 2 ? 'var(--attn-ink)' : 'var(--label)');
      return { isNew: !!marks['deadline:' + x.id], what: x.what, due: x.due ? dueLabel(x.due) : '期限なし', who: x.who, done: !!x.done, url: x.url, hasUrl: !!x.url, note: x.note,
        toggle: function () { self.toggleDeadline(x); }, edit: function () { self.openDeadline(x); }, badgeStyle: self.badge(x.who),
        dueStyle: 'font-size: var(--t-foot); font-weight: 700; color: ' + col,
        boxStyle: 'width: 26px; height: 26px; flex-shrink: 0; border-radius: 50%; box-sizing: border-box; display: flex; align-items: center; justify-content: center; border: 2px solid ' + (x.done ? 'var(--done)' : 'var(--label3)') + '; background: ' + (x.done ? 'var(--done)' : 'transparent'),
        textStyle: 'font-size: var(--t-sub); font-weight: 700; ' + (x.done ? 'text-decoration: line-through; color: var(--label2)' : '') };
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
      return { isNew: !!marks['weekend:' + x.id], more: moreOf('weekend', x.id), noteStyle: clamp(5, 'font-size: var(--t-foot); color: var(--label); line-height: 1.6'), name: x.name, kind: x.kind, meta: [x.date ? dueLabel(x.date).replace(/（.*）/, '') + 'のイベント' : '', x.place].filter(String).join('・'), note: x.note, url: x.url, hasUrl: !!x.url,
        likes: likes, likeLabel: mineLike ? '行きたい（取り消す）' : '行きたい', like: function () { self.likeOuting(x); },
        planned: !!planned, notPlanned: !planned && x.like1 && x.like2, needBoth: !planned && !(x.like1 && x.like2),
        needText: (x.like1 || x.like2) ? (x.like1 ? names[1] : names[0]) + 'も「行きたい」を押すと、行く日を決められます' : '2人とも「行きたい」を押すと、行く日を決められます',
        goLabel: planned ? (gd.getMonth() + 1) + '/' + gd.getDate() + '（' + DOWS[gd.getDay()] + '）に行く' : '',
        days: wkDays.map(function (w) { return { label: w.label + 'に行く', pick: function () { self.planOuting(x, w.ymd); } }; }),
        unplan: function () { self.planOuting(x, ''); }, edit: function () { self.openOuting(x); }, muse: function () { self.openMuse('outing', x); },
        likeStyle: 'min-height: 44px; padding: 0 16px; border-radius: var(--r-btn); font-size: var(--t-sub); font-weight: 700; cursor: pointer; border: none; ' + (mineLike ? 'background: var(--accent-bg); color: #FFFFFF' : 'background: var(--accent-soft); color: var(--accent)'),
        cardStyle: 'flex-shrink: 0; width: var(--w-slide); scroll-snap-align: start; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: var(--r-card); background: ' + (planned ? 'var(--done-soft)' : 'var(--card)') };
    });

    /* 編集シート（担当・買い物・話題） */
    var E = st.editor;
    var ed = { open: !!E, showSave: !(E && E.kind === 'who'), whoSheet: !!E && E.kind === 'who', duty: !!E && E.kind === 'duty', depart: !!E && E.kind === 'depart', shop: !!E && E.kind === 'shop', topic: !!E && E.kind === 'topic', decide: !!E && E.kind === 'decide', deadline: !!E && E.kind === 'deadline', outing: !!E && E.kind === 'outing', menu: !!E && E.kind === 'menu', toshop: !!E && E.kind === 'toShop', isNew: !!(E && E.isNew), canDelete: !!(E && !E.isNew && E.kind !== 'depart' && E.kind !== 'who'), saveLabel: '保存する' };
    if (E) {
      var HEAD = { who: ['担当を替える', '担当を替える'], depart: ['家を出る時刻', '家を出る時刻'], duty: ['担当を足す', '担当を直す'], shop: ['買い物を直す', '買い物を直す'], topic: ['話題を足す', '話題を直す'], decide: ['相談を足す', '相談を直す'], deadline: ['期限を足す', '期限を直す'], outing: ['お出かけの候補を足す', 'お出かけの候補を直す'], menu: ['献立を入れる', '献立を直す'], toShop: ['材料を買い物リストへ', '材料を買い物リストへ'] };
      ed.heading = HEAD[E.kind][E.isNew ? 0 : 1];
      var FIELDS = ['task', 'time', 'rel', 'name', 'qty', 'title', 'url', 'note', 'q', 'options', 'due', 'what', 'place', 'date', 'dish', 'ings', 'how', 'servings'];
      FIELDS.forEach(function (k) { ed[k] = E[k] || ''; });
      ed.set = {};
      FIELDS.forEach(function (k) { ed.set[k] = function (ev) { self.editSet(k, ev.target.value); }; });
      ed.cancel = function () { self.setState({ editor: null }); };
      if (E.kind === 'duty') {
        ed.whoChips = names.concat(['家族']).map(function (n) { var on = E.who === n; return { label: n, pressed: on ? 'true' : 'false', style: pill(on, self.person(n).ink), pick: function () { self.editSet('who', n); } }; });
        ed.showKind = !E.routine || E.isNew;
        ed.isRoutine = !!E.routine && !E.isNew;
        ed.skipLabel = E.skipToday ? '今日もやる（休みをやめる）' : '今日だけ休む（くり返しはそのまま）';
        ed.toggleSkip = function () { self.skipToday(E.id, !E.skipToday); };
        ed.once = !!E.once;
        ed.date = E.date || '';
        ed.set.date = function (ev) { self.editSet('date', ev.target.value); };
        var tdy = (self.state.data || {}).today || ymd(new Date()), tmr = (function () { var x = parseYmd(tdy); x.setDate(x.getDate() + 1); return ymd(x); })();
        ed.dateChips = [[tdy, '今日'], [tmr, '明日']].map(function (x) { var on = E.date === x[0]; return { label: x[1], pressed: on ? 'true' : 'false', style: pill(on), pick: function () { self.editSet('date', x[0]); } }; });
        ed.kindChips = [['once', '日にちを決める'], ['repeat', 'くり返し']].map(function (k) { var on = (k[0] === 'once') === !!E.once; return { label: k[1], pressed: on ? 'true' : 'false', style: pill(on), pick: function () { self.editSet('once', k[0] === 'once'); } }; });
        ed.repeat = !E.once;
        var days = ruleDays(E.rule || '毎日');
        ed.dayChips = DOWS.map(function (dn, i) { return { label: dn, pressed: days[i] ? 'true' : 'false', style: pill(days[i]) + '; flex: 1; min-width: 0; padding: 0', pick: function () {
          var cur = self.state.editor.rule || '毎日', on2 = ruleDays(cur);
          if (cur === '毎日') { on2 = DOWS.map(function (_, k) { return k === i; }); }   /* 「毎日」から曜日を押したら、その曜日だけにする */
          else { on2[i] = !on2[i]; if (!on2.some(Boolean)) return; }
          self.editSet('rule', daysRule(on2));
        } }; });
        ed.ruleText = ruleWords(E.rule || '毎日');
        ed.rulePresets = [['毎日', '毎日'], ['平日', '平日'], ['土日', '土日']].map(function (r) { var on = (E.rule || '毎日') === r[0]; return { label: r[1], pressed: on ? 'true' : 'false', style: pill(on), pick: function () { self.editSet('rule', r[0]); } }; });
        ed.save = function () { self.saveDuty(); }; ed.del = function () { self.deleteDuty(); };
        /* 大項目と小項目（GAS 17 から） */
        var allD = (self.state.data || {}).dutiesAll || [];
        var myKids = allD.filter(function (x) { return x.parent === E.id; });
        var prow0 = E.parent ? allD.filter(function (x) { return x.id === E.parent; })[0] : null;
        ed.isChild = !!E.parent; ed.notChild = !E.parent;
        ed.childHint = prow0 ? '時刻・担当・曜日は大項目「' + prow0.task + '」と同じです。大項目を済にすると、小項目も全部済になります。' : '';
        ed.showParent = self.dutyApi() && !myKids.length;
        var tops = allD.filter(function (x) { return !x.parent && x.id !== E.id; }).sort(function (a, b) { return (a.t == null ? 99999 : a.t) - (b.t == null ? 99999 : b.t); });
        ed.parentChips = [{ id: '', label: 'なし（ふつうの担当）' }].concat(tops.map(function (x) { return { id: x.id, label: (x.t != null ? hm(x.t) + ' ' : '') + x.task }; })).map(function (x) {
          var on = (E.parent || '') === x.id;
          return { label: x.label, pressed: on ? 'true' : 'false', style: pill(on), pick: function () { self.editSet('parent', x.id); } };
        });
        ed.hasKids = myKids.length > 0;
        ed.kidsText = myKids.length ? '小項目：' + myKids.map(function (x) { return x.task; }).join('、') : '';
        ed.canAddChild = self.dutyApi() && !E.isNew && !E.parent;
        /* Museに渡さない（健康に近い担当など。Muse の一覧・履歴に出さない） */
        var privByParent = !!(prow0 && prow0.priv);
        ed.showPriv = self.privApi();
        ed.privPressed = (E.priv || privByParent) ? 'true' : 'false';
        ed.privStyle = pill(!!(E.priv || privByParent)) + (privByParent ? '; opacity: .6' : '');
        ed.privLabel = privByParent ? 'Museに渡さない（大項目と同じ）' : 'Museに渡さない';
        ed.togglePriv = function () { if (!privByParent) self.editSet('priv', !E.priv); };
        ed.addChild = function () { self.setState({ editor: null }); setTimeout(function () { self.openDuty(null, E.id); }, 0); };
        ed.canAskOther = !E.isNew && !E.parent && self.askDates(E.id).length > 0;
        ed.askOther = function () { self.setState({ editor: { kind: 'who', isNew: false, id: E.id, task: E.task, dutyId: E.id } }); };
        /* 出発に合わせる：時刻の代わりに「出発のN分前」で持つ */
        var dep0 = self.departMin();
        ed.showTime = !E.relOn;
        ed.relOn = !!E.relOn; ed.relPressed = E.relOn ? 'true' : 'false';
        ed.relStyle = pill(!!E.relOn) + '; align-self: flex-start';
        ed.toggleRel = function () {
          var cur = self.state.editor, on = !cur.relOn, e2 = Object.assign({}, cur, { relOn: on });
          if (on && (cur.rel === '' || cur.rel == null)) { var tm0 = minOf(cur.time); e2.rel = String(dep0 != null && tm0 != null && tm0 <= dep0 ? dep0 - tm0 : 0); }
          if (!on && dep0 != null) e2.time = hhmm(Math.max(0, dep0 - (parseInt(cur.rel, 10) || 0)));
          self.setState({ editor: e2 });
        };
        var relN = parseInt(String(E.rel || '0'), 10) || 0;
        ed.relHint = dep0 == null ? '家を出る時刻が決まっていません' : '家を出る ' + hhmm(dep0).replace(/^0/, '') + ' → この担当は ' + hhmm(Math.max(0, dep0 - relN)).replace(/^0/, '') + '。家を出る時刻を変えると、一緒にずれます（0分前＝出発ちょうど）';
      } else if (E.kind === 'who') {
        var wd = self.todayDuty(E.dutyId), me0 = self.meWho(), acts = [];
        ed.save = function () {}; ed.del = function () {};
        if (wd) {
          ed.whoNow = '今日の担当：' + wd.who + (wd.orig ? '（いつもは' + wd.orig + '）' : '');
          if (wd.who !== me0) acts.push({ label: '今日は自分がやる', sub: '今日の担当を' + me0 + 'にします。いつもの担当はそのまま', go: function () { self.swapToMe(wd, true); }, primary: true });
          if (wd.who === me0 && !wd.orig) acts.push({ label: '代わってほしいと頼む', sub: '申し送りで' + self.otherWho() + 'に頼みます。「代わる」を押してもらえたら替わります', go: function () { self.setState({ editor: null }); self.openNoteFor(wd.task, wd.id, 'swap', wd.who); }, primary: true });
          if (wd.orig) {
            var askedOk = ((self.state.data || {}).notes || []).some(function (n) { return n.ask === 'swap' && n.answer === 'ok' && n.taskId === wd.id && n.askDate === (self.state.data || {}).today && n.to === wd.who; });
            var doneT = !!((self.state.data || {}).done || {})[wd.id];
            if (wd.orig === me0 && self.swapApi() && !doneT) acts.push({ label: 'やっぱり自分でやる', sub: wd.who + 'に申し送りで知らせて、今日の担当を' + me0 + 'に戻します', go: function () { self.cancelSwap(wd.id, (self.state.data || {}).today, wd.task); } });
            else if (wd.who === me0 && askedOk && self.pendingAsk(wd.id, (self.state.data || {}).today)) acts.push({ label: '戻してもらえるか頼んであります', sub: wd.orig + 'の返事があるまでは、今日の担当は' + me0 + 'のままです', go: function () {} });
            else if (wd.who === me0 && askedOk) acts.push({ label: '戻してもらえる？と頼む', sub: '頼まれて引き受けた担当です。' + wd.orig + 'に申し送りで頼みます', go: function () { self.askBack(wd.id, (self.state.data || {}).today, wd.task, wd.orig); } });
            else if (!doneT) acts.push({ label: 'いつもの担当に戻す', sub: '今日の入れ替えをやめて、' + wd.orig + 'に戻します', go: function () { self.swapToMe(wd, false); } });
          }
          acts.push({ label: 'いつもの担当を変える', sub: 'くり返しの決まりを変えます（明日からも）', go: function () { var x = wd; self.setState({ editor: null }); setTimeout(function () { self.openDuty(x); }, 0); } });
        } else { ed.whoNow = '今日はこの担当の日ではありません'; }
        var row0 = self.dutyRow(E.dutyId);
        ed.askDays = self.askDates(E.dutyId).map(function (k) {
          var s0 = self.askState(E.dutyId, k), w = self.askDayWord(k);
          var armed = self.state.cancelArm === k + '|' + E.dutyId;
          return { label: w, sub: armed ? 'もう一度で自分でやる' : s0 === 'ok' ? '代わってもらう' : s0 === 'asked' ? '返事待ち' : '頼む', pressed: s0 ? 'true' : 'false',
            style: pill(!!s0) + '; display: flex; flex-direction: column; align-items: center; gap: 0; min-height: 52px; line-height: 1.3' + (s0 === 'asked' ? '; opacity: .6' : '') + (armed ? '; background: var(--danger); color: #FFFFFF' : ''),
            go: function () {
              if (s0 === 'ok' && self.swapApi() && self.swapAhead(E.dutyId, k)) { self.tapCancelSwap(E.dutyId, k, E.task); return; }
              if (s0) { self.showToast(s0 === 'ok' ? w + 'は' + self.otherWho() + 'が代わってくれます' : w + 'はもう頼んであります（返事待ち）', null); return; }
              self.setState({ editor: null }); self.openNoteFor(E.task, E.dutyId, 'swap', self.otherWho(), k); } };
        });
        ed.hasAskDays = ed.askDays.length > 0;
        ed.askDaysHint = '日を押すと、' + self.otherWho() + 'への申し送りで頼めます。「代わる」を押してもらえたら、その日だけ替わります' + (row0 && !row0.date ? '（いつもの担当はそのまま）' : '') + (self.swapApi() && ed.askDays.some(function (c) { return c.sub === '代わってもらう'; }) ? '。「代わってもらう」の日は、2回押すと自分でやるに戻せます' : '');
        ed.whoActs = acts.map(function (a) { return { label: a.label, sub: a.sub, go: a.go, cls: a.primary ? 'btn btn-fill' : 'btn btn-gray' }; });
      } else if (E.kind === 'topic') {
        ed.highPressed = E.high ? 'true' : 'false'; ed.highStyle = pill(!!E.high) + '; align-self: flex-start';
        ed.toggleHigh = function () { self.editSet('high', !self.state.editor.high); };
        ed.topicNew = !!E.isNew; ed.topicOld = !E.isNew;
        ed.toArchivePressed = E.toArchive ? 'true' : 'false'; ed.toArchiveStyle = pill(!!E.toArchive) + '; align-self: flex-start';
        ed.toggleToArchive = function () { self.editSet('toArchive', !self.state.editor.toArchive); };
        ed.archiveNow = function () { var tt = ((self.state.data || {}).topics || []).filter(function (x) { return x.id === E.id; })[0]; if (tt) self.archiveTopic(tt, true); };
      } else if (E.kind === 'depart') {
        ed.save = function () { self.saveDepart(); }; ed.del = function () {};
        var nRel = ((self.state.data || {}).dutiesAll || []).filter(function (x) { return x.rel != null; }).length;
        ed.departHint = nRel ? '「家を出る時刻に合わせる」にした担当（' + nRel + '件）も、一緒にずれます。' : '担当を「家を出る時刻に合わせる」にすると、ここを変えた時に一緒にずれます。';
      } else if (E.kind === 'shop') {
        ed.catChips = shopCats.map(function (c) { var on = E.cat === c; return { label: c, pressed: on ? 'true' : 'false', style: chip(on, '#2C6B52'), pick: function () { self.editSet('cat', c); } }; });
        ed.save = function () { self.saveShopEdit(); }; ed.del = function () { self.deleteShop(); };
      } else if (E.kind === 'decide') {
        ed.save = function () { self.saveDecision(); }; ed.del = function () { self.deleteDecision(); };
      } else if (E.kind === 'deadline') {
        ed.whoChips = names.concat(['家族']).map(function (n) { var on = E.who === n; return { label: n, pressed: on ? 'true' : 'false', style: pill(on, self.person(n).ink), pick: function () { self.editSet('who', n); } }; });
        ed.save = function () { self.saveDeadline(); }; ed.del = function () { self.deleteDeadline(); };
      } else if (E.kind === 'menu') {
        ed.heading += '　' + E.dateLabel;
        ed.hotcookPressed = E.hotcook ? 'true' : 'false';
        ed.hotcookStyle = chip(!!E.hotcook, '#8A6A0E') + '; align-self: flex-start';
        ed.toggleHotcook = function () { self.editSet('hotcook', !self.state.editor.hotcook); };
        ed.save = function () { self.saveMenu(); }; ed.del = function () { self.deleteMenu(); };
      } else if (E.kind === 'toShop') {
        /* 材料ごとに行き先を選ぶ：買い物リストの分類＋「家にある」。リストにある物は選べない */
        var tsCats = self.shopCatList().concat([AT_HOME]), nSend = 0;
        ed.dish = E.dish; ed.dateLabel = E.dateLabel;
        ed.tsRows = E.rows.map(function (r, i) {
          if (!r.onList && r.cat !== AT_HOME) nSend += 1;
          return { name: r.name, qty: r.qty, onList: r.onList, canPick: !r.onList,
            aria: r.name + 'をどこで買うか',
            chips: r.onList ? [] : tsCats.map(function (c) { var on = r.cat === c; return { label: shortCat(c), aria: c, pressed: on ? 'true' : 'false', style: chip(on, c === AT_HOME ? '#55605A' : '#2C6B52'), pick: function () { self.setToShopCat(i, c); } }; }) };
        });
        ed.tsNote = E.rows.some(function (r) { return r.onList; }) ? '「リストにある」品は、まだ買っていない物がリストに入っているので送りません。' : '';
        ed.saveLabel = nSend ? nSend + '品をまとめて送る' : '送る物はありません';
        ed.save = function () { self.sendToShop(); }; ed.del = function () {};
      } else if (E.kind === 'outing') {
        ed.okindChips = ['公園', '行くところ', 'イベント'].map(function (k) { var on = E.okind === k; return { label: k, pressed: on ? 'true' : 'false', style: pill(on), pick: function () { self.editSet('okind', k); } }; });
        ed.save = function () { self.saveOuting(); }; ed.del = function () { self.deleteOuting(); };
      } else {
        ed.save = function () { self.saveTopic(); }; ed.del = function () { self.deleteTopic(); };
      }
      ed.close = function () { self.setState({ editor: null }); };
      ed.noTimeOn = E.kind === 'duty' && !E.time;
      ed.noTime = ed.noTimeOn ? 'true' : 'false';
      ed.noTimeStyle = pill(ed.noTimeOn) + '; flex-shrink: 0; min-height: 48px';
      ed.toggleNoTime = function () { var e2 = self.state.editor; self.editSet('time', e2.time ? '' : (e2.lastTime || pad(Math.min(23, new Date().getHours() + 1)) + ':00')); if (e2.time) self.editSet('lastTime', e2.time); };
      /* 消すは2回押し：1回目で「本当に消す」に変わる */
      var del0 = ed.del;
      var kidsN = E.kind === 'duty' ? (((self.state.data || {}).dutiesAll || []).filter(function (x) { return x.parent === E.id; }).length) : 0;
      ed.delLabel = E.confirmDel ? '本当に消す（もう一度押す）' : (kidsN ? '消す（小項目' + kidsN + '件も）' : '消す');
      ed.delStyle = 'min-height: 48px; border-radius: var(--r-btn); font-size: var(--t-sub); font-weight: 700; cursor: pointer; ' + (E.confirmDel ? 'border: none; background: var(--danger); color: #FFFFFF' : 'border: none; background: var(--danger-soft); color: var(--danger)');
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
        skelStyle: 'margin: 24px 16px 8px; height: ' + skelH[id] + 'px; border-radius: var(--r-card); background: linear-gradient(90deg, var(--fill) 0%, var(--card2) 50%, var(--fill) 100%); background-size: 780px 100%; animation: shimmer 1.4s linear infinite'
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
        style: 'flex-shrink: 0; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: var(--r-chip); border: none; font-size: var(--t-sub); font-weight: 700; cursor: pointer; transition: background .2s, color .2s; ' + (on ? 'background: var(--accent-bg); color: #FFFFFF' : 'background: var(--card); color: var(--label)'),
        countStyle: 'min-width: 20px; height: 20px; padding: 0 4px; box-sizing: border-box; border-radius: var(--r-btn); display: inline-flex; align-items: center; justify-content: center; font-size: var(--t-cap); ' + (on ? 'background: rgba(255,255,255,.2)' : 'background: var(--fill); color: var(--label2)')
      };
    });
    var news = newsRaw.filter(function (n) { return goalId === 'all' || n.goals.indexOf(goalId) >= 0; }).map(function (n) {
      var open = !!st.newsOpen[n.id];
      return {
        title: n.title, why: n.why, body: n.body, url: n.url, src: n.src, meta: n.from + (n.date ? '（' + n.date + '）' : ''),
        open: false, expanded: 'false', more: (rCount['news:' + n.id] ? '詳細を見る（コメント' + rCount['news:' + n.id] + '件）' : '詳細を見る'),
        toggle: function () { self.openDetail('news', n.id); },
        srcStyle: 'padding: 4px 8px; border-radius: var(--r-btn); font-size: var(--t-cap); font-weight: 700; background: rgba(255,255,255,.22); color: #FFFFFF',
        cardStyle: 'flex-shrink: 0; width: var(--w-slide); box-sizing: border-box; scroll-snap-align: start; display: flex; flex-direction: column; gap: 8px; min-height: 200px; padding: 18px; border-radius: var(--r-card); color: #FFFFFF; box-shadow: var(--shadow-card); background: linear-gradient(150deg, ' + TOPIC_TONES[hashIdx(n.id || n.title, TOPIC_TONES.length)].join(', ') + '); animation: ' + ((st.goalAnim || 0) % 2 ? 'slideA' : 'slideB') + ' .4s cubic-bezier(.2,.8,.2,1) both'
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
        var ink = dw === 0 ? 'var(--danger)' : (dw === 6 ? 'var(--accent)' : 'var(--label)');
        cells.push({
          dow: i === 0 ? '今日' : DOWS[dw], date: dt.getDate() === 1 || c === 0 ? (dt.getMonth() + 1) + '/' + dt.getDate() : String(dt.getDate()),
          aria: (i === 0 ? '今日 ' : '') + (dt.getMonth() + 1) + '月' + dt.getDate() + '日' + DOWS[dw] + '曜、予定' + (mine.length + spanList.filter(function (g) { return g.d0 <= i && g.d1 >= i; }).length) + '件',
          go: (function (day) { return function () { self.planJump(day); }; })(dstr),
          style: 'grid-column: ' + col + '; grid-row: 1 / -1; border: none; padding: 0; margin: 0; font: inherit; cursor: pointer; border-radius: var(--r-btn); min-width: 0; ' + (i === 0 ? 'background: var(--accent-bg); ' : (dw === 0 || dw === 6 ? 'background: var(--card2); ' : 'background: var(--card); ')) + (off ? 'opacity: .35; ' : '') + 'display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start',
          headStyle: 'display: flex; flex-direction: column; align-items: center; padding: 8px 0 4px; line-height: 1.15; color: ' + (i === 0 ? '#FFFFFF' : ink),
        });
        chips.push({
          style: 'grid-column: ' + col + '; grid-row: ' + (lanes + 2) + '; pointer-events: none; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 2px 2px 8px',
          list: shown.map(function (p) {
            var pc = self.person(p.who);
            return { text: p.what, style: 'display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: var(--t-cap); line-height: 15px; max-height: 32px; box-sizing: border-box; font-weight: 700; overflow: hidden; word-break: break-all; border-radius: 4px; padding: 1px 4px; border-bottom: 1px solid transparent; color: ' + (i === 0 ? pc.ink : inkText(pc.ink)) + '; background: ' + (i === 0 ? '#fff' : inkTint(pc.ink)) };
          }),
          more: more > 0 ? '+' + more : '', moreStyle: 'font-size: var(--t-cap); font-weight: 700; padding-left: 4px; color: ' + (i === 0 ? '#FFFFFF' : 'var(--label2)')
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
          style: 'grid-column: ' + (c0 + 1) + ' / ' + (c1 + 2) + '; grid-row: ' + (g.lane + 2) + '; pointer-events: none; margin: 1px ' + (openR && c1 < 6 ? '-3px' : (openR ? '0' : '2px')) + ' 1px ' + (openL ? '0' : '2px') + '; height: 16px; box-sizing: border-box; border-radius: ' + rl + ' ' + rr + ' ' + rr + ' ' + rl + '; padding: 0 8px; font-size: var(--t-cap); line-height: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; color: #FFFFFF; background: ' + pc.ink
        });
      });
      return { cells: cells, chips: chips, bands: bands, gridStyle: 'display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-template-rows: 40px' + (lanes ? ' repeat(' + lanes + ', 18px)' : '') + ' minmax(34px, auto); column-gap: 4px' };
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
        labelStyle: 'margin: 0; padding: 12px 0 2px; font-size: var(--t-foot); font-weight: 700; color: ' + (pi === 0 ? 'var(--done)' : (dwi === 0 ? 'var(--danger)' : (dwi === 6 ? 'var(--accent)' : 'var(--label2)'))),
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
      style: 'display: flex; align-items: center; gap: 12px; margin: 0 16px 12px; padding: 8px 8px 8px 16px; border-radius: var(--r-btn); font-size: var(--t-foot); font-weight: 700; line-height: 1.5; ' + (travel ? 'background: var(--accent-soft); color: var(--accent)' : 'background: var(--card2); color: var(--label)')
    };
    var secCfg = ui.sections && ui.sections.length ? ui.sections : SEC_DEF.map(function (x, k) { return { key: x[0], title: x[1], all: true, person: x[0] !== 'photos', order: k }; });
    var secByKey = {}; secCfg.forEach(function (c) { secByKey[c.key] = c; });
    var title = {}, sections = [];
    SEC_DEF.forEach(function (x) { title[x[0]] = (secByKey[x[0]] && secByKey[x[0]].title) || x[1]; });
    if (wkOff && /今週/.test(title.week)) title.week = title.week.replace('今週', '来週');   /* 来週を見ている時は見出しも来週に */
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
    var secTab = {}; secAll.forEach(function (c) { secTab[c.key] = tabOf(c); });
    this.secTabMap = secTab;
    /* 右上のメニューの「移動」：タブごとに、いま見えるセクションを並べる（写真・見出しは除く）。押すとそのタブのそのセクションへ */
    /* 右上のメニューの「移動」：いま見えるセクション（写真・見出しは除く）をアイコン付きのタイルで2列に。下の小さな字は、どのタブか */
    var NAV_ICON = {
      flow: 'M5 12.5l4 4 10-10', diary: 'M4 20h4L19 9l-4-4L4 16v4z', notes: 'M3 6h18v12H3zM3 6l9 7 9-7',
      decide: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.4M12 16.8v.2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', deadline: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
      week: 'M4 11h16a8 8 0 0 1-16 0zM9 7c0-1 1-1.5 1-2.5M14 7c0-1 1-1.5 1-2.5', shop: 'M3 4h2l2.5 11h10L20 7H6.5M9 20h.01M17 20h.01',
      plan: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', weekend: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
      topics: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1', news: 'M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M7 9h7M7 13h7M7 16h4'
    };
    /* タイルの上の絵：料理は今日の献立の写真、ほかはセクションごとの色のアイコン画像（アプリのアイコン風） */
    var NAV_GRAD = { flow: '#34C759,#30B0C7', diary: '#FF9F0A,#FF6B3D', notes: '#5E5CE6,#BF5AF2', decide: '#FF375F,#FF9F0A', deadline: '#FF3B30,#FF7A6E',
      week: '#FF9F0A,#FFCC00', shop: '#32ADE6,#0A84FF', plan: '#0A84FF,#5E5CE6', weekend: '#FFCC00,#FF9F0A', topics: '#64D2FF,#5E5CE6', news: '#8E8E93,#48484A' };
    var todayYmd = D.today || ymd(new Date());
    var todayMenu = (D.menu || []).filter(function (m) { return m.date === todayYmd && m.dish; })[0];
    var navPhoto = { week: todayMenu && todayMenu.photo ? todayMenu.photo : pexels(MOOD[0], 400) };
    /* 中身の一言（押す前に何があるか分かるように） */
    var chk0 = D.checked || {}, done0 = D.done || {};
    var hintOf = function (key) {
      if (key === 'flow') { var left = mine.filter(function (d) { return !done[d.id]; }).length; return left ? 'のこり' + left + '件' : 'ぜんぶ済み'; }
      if (key === 'diary') return diaryAll.length ? '今日 ' + diaryAll.length + '件' : 'まだ書いていない';
      if (key === 'notes') return myNotes ? '未確認 ' + myNotes + '件' : '新しいものなし';
      if (key === 'decide') { var od = (D.decisions || []).filter(function (x) { return x.state !== '決まった'; }).length; return od ? od + '件の相談' : '相談なし'; }
      if (key === 'deadline') { var nx = (D.deadlines || []).filter(function (x) { return !x.done && x.due; }).sort(function (a, b) { return a.due < b.due ? -1 : 1; })[0]; return nx ? '次：' + Number(nx.due.slice(5, 7)) + '/' + Number(nx.due.slice(8, 10)) : '期限なし'; }
      if (key === 'week') return todayMenu ? '今日：' + todayMenu.dish : '今日の献立はまだ';
      if (key === 'shop') { var nb = 0; ((D.shop && D.shop.groups) || []).forEach(function (g) { g.items.forEach(function (it) { if (!chk0[it[0]]) nb++; }); }); return nb ? 'まだ買っていない ' + nb + '品' : 'ぜんぶ買った'; }
      if (key === 'plan') { var tp = (D.plans || []).filter(function (p) { return p.date === todayYmd; }).length; return tp ? '今日 ' + tp + '件' : '今日の予定なし'; }
      if (key === 'topics') { var nt = (D.topics || []).length; return nt ? nt + '件' : ''; }
      if (key === 'news') { var nn = (D.news || []).length; return nn ? nn + '本' : ''; }
      return '';
    };
    /* 落ち着いた見た目（UIデザイナーの見直し）：色は青1色。アイコンは小さな角丸の枠に。料理だけ同じ大きさの写真 */
    var tileVisual = function (key) {
      var ph = navPhoto[key];
      if (ph) return 'width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0; background: var(--fill) url(\'' + ph.replace(/'/g, '%27') + '\') center / cover no-repeat';
      return 'width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--accent-soft)';
    };
    var navGo = function (key) { return function () { self.setState({ accountOpen: false }); USAGE.add('act:menu_nav'); setTimeout(function () { self.jumpSec(key); }, 60); }; };
    var myNotes = (D.notes || []).filter(function (n) { return n.to === meWho && !n.read; }).length;
    var navTiles = [];
    tabNames.forEach(function (t) {
      var seq = TAB_SEQ[TAB_ID[t]] || [], tl = TAB_LABEL[t] || t, here = t === curTab;
      var secs = shown.filter(function (x) { return x.vis && tabOf(x.c) === t && x.c.key !== 'photos' && x.c.key !== 'hero'; })
        .sort(function (a, b) { var ia = seq.indexOf(a.c.key), ib = seq.indexOf(b.c.key); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
      var keys = secs.map(function (x) { return x.c.key; });
      if (TAB_ID[t] === 'two') keys.unshift('notes');
      keys.forEach(function (key) {
        var name = key === 'notes' ? '申し送り' : (title[key] || key);
        var hint = hintOf(key);
        navTiles.push({ key: key, label: name, hint: hint, hasHint: !!hint, sub: tl + (here ? '・いまここ' : ''), icon: NAV_ICON[key] || 'M12 11.5h.01', visual: tileVisual(key), isPhoto: !!navPhoto[key], noPhoto: !navPhoto[key], badge: key === 'notes' ? myNotes : 0, hasBadge: key === 'notes' && myNotes > 0,
          aria: name + '（' + tl + '）' + (key === 'notes' && myNotes ? '、未確認 ' + myNotes + '件' : ''), go: navGo(key),
          style: 'position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-height: 96px; padding: 12px; border-radius: var(--r-card); border: none; background: ' + (here ? 'var(--accent-soft)' : 'var(--card)') + '; color: var(--label); text-align: left; font-family: inherit; cursor: pointer' });
      });
    });
    /* 申し送りは、相談・期限が見えないタブ構成でも行けるように */
    if (!navTiles.some(function (x) { return x.key === 'notes'; })) navTiles.unshift({ key: 'notes', label: '申し送り', hint: hintOf('notes'), hasHint: true, sub: '相談・連絡', icon: NAV_ICON.notes, visual: tileVisual('notes'), isPhoto: false, noPhoto: true, badge: myNotes, hasBadge: myNotes > 0, aria: '申し送り', go: navGo('notes'),
      style: 'position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-height: 96px; padding: 12px; border-radius: var(--r-card); border: none; background: var(--card); color: var(--label); text-align: left; font-family: inherit; cursor: pointer' });
    /* 並びは CSS の order で変える（DOM の順は変えない。入れ替えると描き直しで要素が使い回されて崩れるため） */
    var seq0 = !isHome && TAB_SEQ[TAB_ID[curTab]];
    var rankOf = {};
    shown.map(function (x, i) { return [x.c.key, i]; }).sort(function (a, b) {
      var ra = seq0 ? (seq0.indexOf(a[0]) < 0 ? 50 : seq0.indexOf(a[0])) : 0, rb = seq0 ? (seq0.indexOf(b[0]) < 0 ? 50 : seq0.indexOf(b[0])) : 0;
      return (ra - rb) || (a[1] - b[1]);
    }).forEach(function (a, i) { rankOf[a[0]] = i; });
    var visOf = {}; shown.forEach(function (x) { visOf[x.c.key] = x.vis && (isHome || tabOf(x.c) === curTab); });
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
    /* ホーム画面のアイコンの数字：あなたの番（自分宛ての未確認・相手からの新しい返信・まだ答えていない相談） */
    var appBadge = myUnread.length + newReplies.length + myTurnDecide;
    if (!DEMO && appBadge !== this.appBadge) { this.appBadge = appBadge; setTimeout(function () { try { if (appBadge && navigator.setAppBadge) navigator.setAppBadge(appBadge).catch(function () {}); else if (!appBadge && navigator.clearAppBadge) navigator.clearAppBadge().catch(function () {}); } catch (e) {} }, 0); }
    var navTabs = tabNames.map(function (t) {
      var badge = t === twoTab ? myUnread.length + newReplies.length + myTurnDecide : 0;
      var on = t === curTab;
      return {
        label: TAB_LABEL[t] || t, ic_today: TAB_ID[t] === 'today' || !TAB_ID[t], ic_two: TAB_ID[t] === 'two', ic_food: TAB_ID[t] === 'food', ic_plan: TAB_ID[t] === 'plan', ic_news: TAB_ID[t] === 'news', current: on ? 'page' : 'false', badge: badge, hasBadge: badge > 0,
        aria: (TAB_LABEL[t] || t) + (badge ? '（あなたの番 ' + badge + '件）' : ''),
        go: function () {
          if (on) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
          USAGE.add('nav:' + (TAB_ID[t] || 'n' + tabNames.indexOf(t)));
          swapView(function () { self.setState({ nav: t }); window.scrollTo(0, 0); });
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
      var chip = function (on) { return on ? '1' : '0'; };   /* 札の見た目は CSS（.statchip）。on は数字を色で強める */
      var chips = [];
      chips.push({ k: '今日の担当', v: tot ? dn + ' / ' + tot : 'なし', sub: tot && dn === tot ? 'ぜんぶ終わり' : '', on: chip(false),
        go: function () { if (curTab !== tabNames[0]) self.setState({ nav: tabNames[0] }); setTimeout(function () { var el = document.querySelector('[data-sec="flow"]'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 80); } });
      chips.push({ k: 'あなたの番', v: turn ? turn + '件' : 'なし', sub: '', on: chip(turn > 0),
        go: function () { self.setState({ nav: twoTab }); window.scrollTo(0, 0); } });
      var newChip = function (n) { return { k: '新着', v: n + '件', sub: '', on: chip(true),
        go: function () { if (curTab !== tabNames[0]) self.setState({ nav: tabNames[0] }); setTimeout(function () { var el = document.querySelector('[data-new]'); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 80); } }; };
      var goFlow = chips[0].go;
      var goTrip = function () {
        var pt = tabOf(secByKey.plan || { key: 'plan' }), day = tripNow ? todayStr : ui.tripFrom;
        if (curTab !== pt) self.setState({ nav: pt });
        setTimeout(function () { self.planJump(day); }, 120);
      };
      if (ui.tripFrom && ui.tripTo) {
        var dTo = Math.round((parseYmd(ui.tripFrom) - parseYmd(todayStr)) / 864e5);
        if (tripNow) chips.push({ k: '旅行', v: (Math.round((parseYmd(todayStr) - parseYmd(ui.tripFrom)) / 864e5) + 1) + '日目', sub: '', on: chip(false), go: goTrip });
        else if (dTo > 0 && dTo <= 120) chips.push({ k: '旅行まで', v: 'あと' + dTo + '日', sub: '', on: chip(false), go: goTrip });
      }
      var streak = D.streak || 0;
      if (streak >= 2) chips.splice(1, 0, { k: '全部できた日', v: '連続' + streak + '日', sub: '', on: chip(false), go: goFlow });
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
        : tid === 'food' ? ['今日：' + (todayMenu ? todayMenu.dish : (ui.noMenuDish || 'まだ決まっていません')), total ? '買い物 のこり' + (total - got) + '品' : '']
        : tid === 'plan' ? [planTotal ? (planN >= 14 ? '2週間' : planN + '日') + 'の予定 ' + planTotal + '件' : (planN >= 14 ? '2週間' : planN + '日') + 'の予定はまだありません', (ui.tripFrom && !tripNow && Math.round((parseYmd(ui.tripFrom) - parseYmd(todayStr)) / 864e5) > 0) ? '旅行まで あと' + Math.round((parseYmd(ui.tripFrom) - parseYmd(todayStr)) / 864e5) + '日' : '']
        : tid === 'news' ? ['いまのやることに関係するニュース', ''] : ['', ''];
      var isHomeTab = curTab === tabNames[0];
      var photoHero = isHomeTab && sections.some(function (x) { return x.key === 'photos' && x.vis; });
      return {
        big: isHomeTab && !photoHero, small: !isHomeTab, inPhoto: photoHero, newChip: newChip,
        tot: tot, dn: dn, turn: turn, streak: D.streak || 0, twoTab: twoTab, showWho: tid !== 'food' && tid !== 'news',   /* 人で絞っても変わらないタブには出さない */
        smallTitle: TAB_LABEL[curTab] || curTab, barTitle: isHomeTab ? '' : (TAB_LABEL[curTab] || curTab), smallSum: sum.filter(String).join('　・　'),
        wx: wx, hasWx: !!wx,
        style: 'position: relative; overflow: hidden; margin: 8px 16px 0; padding: 16px; border-radius: var(--r-card); color: #FFFFFF; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 14px 34px rgba(0,0,0,0.22); background: ' + bg,
        greet: greet,
        date: (dd.getMonth() + 1) + '月' + dd.getDate() + '日（' + DOWS[dd.getDay()] + '）',
        chips: chips
      };
    })();
    var notesHere = curTab === twoTab || (isHome && myUnread.length > 0);

    var R = {
      sections: sections, title: title, planNote: '', travelOn: travel, orderBanner: orderBanner,
      hdr: hdr, seeAll: function () { self.seeAll(); },
      navTabs: navTabs, navStyle: 'grid-template-columns: repeat(' + Math.max(1, navTabs.length) + ', minmax(0, 1fr))',
      notesHere: notesHere,
      notesCardText: myUnread.length || newReplies.length ? [myUnread.length ? 'あなた宛てが ' + myUnread.length + '件' : '', newReplies.length ? '新しい返信が ' + newReplies.length + '件' : ''].filter(String).join('、') + 'あります' : (unreadAll.length ? '未確認が ' + unreadAll.length + '件（相手の確認待ち）' : '未確認はありません'),
      notesCardStyle: 'display: flex; align-items: center; gap: 12px; width: calc(100% - 32px); margin: 0 16px 16px; box-sizing: border-box; min-height: 64px; padding: 12px 16px; border-radius: var(--r-card); text-align: left; cursor: pointer; color: var(--label); border: none; background: var(--card)',
      notesIconColor: myUnread.length || newReplies.length ? 'var(--attn)' : 'var(--label3)',   /* 注意の色は枠ではなくアイコンで */
      travelText: travel ? '旅行中なので、旅行に関係するところだけ出しています（' + (function (t) { var x = parseYmd(t); return (x.getMonth() + 1) + '/' + x.getDate(); })(ui.tripTo) + 'まで）' : '',
      decisions: decisions, decisionsEmpty: decisions.length === 0, decArchive: decArchive, addDecision: function () { self.openDecision(null); },
      deadlines: deadlines, deadlinesEmpty: deadlines.length === 0, addDeadline: function () { self.openDeadline(null); },
      outings: outings, outingsEmpty: outings.length === 0, addOuting: function () { self.openOuting(null); },
      menuToShop: function () { self.menuToShop({ dish: dayMenu.dish, date: dmDate, ingredients: dayMenu.ingredients }); },
      editMenu: function () { self.openMenu(dmDate, dmReal); }, editMenuLabel: dmReal ? '献立を直す' : '献立を入れる', hasMenu: !!dmReal, hasIngredients: dayMenu.ingredients.length > 0 && dmDate >= todayStrM,   /* 過ぎた日の材料は送らない */
      weekNav: weekNav, hasWeekNav: weekNav.length > 0, weekRange: weekRange,
      flowEdit: !!st.flowEdit, flowNormal: !st.flowEdit, flowEditRows: flowEditRows, flowEditEmpty: flowEditRows.length === 0,
      flowEditLabel: st.flowEdit ? '完了' : '直す',
      openDepart: function () { self.openDepart(); },
      departLabel: (function () { var m = self.departMin(); if (m == null) return '家を出る時刻：未定'; var left = m - nowMin, wd = now.getDay() >= 1 && now.getDay() <= 5; var hm0 = hhmm(m).replace(/^0/, ''); return wd && left > 0 && left <= 180 ? '家を出る ' + hm0 + '（あと' + left + '分）' : '家を出る ' + hm0; })(),
      departAria: (function () { var m = self.departMin(); return '朝、家を出る時刻' + (m == null ? '（未定）' : ' ' + hhmm(m)) + '。押すと変えられます'; })(),
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
      topics: topics, topicsEmpty: topics.length === 0, linksArchive: linksArchive, topicEdit: !!st.topicEdit, topicEditLabel: st.topicEdit ? '完了' : '直す',
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
        var all0 = (D.replies || []).filter(function (r) { return r.target === tgt; }).sort(function (a, b) { return a.at - b.at; });
        var tops0 = all0.filter(function (r) { return !r.parent || !all0.some(function (p) { return p.id === r.parent; }); });
        var ordered = []; tops0.forEach(function (t0) { ordered.push(t0); all0.forEach(function (c) { if (c.parent === t0.id) ordered.push(c); }); });
        var rs = ordered.map(function (r) {
          var d0 = new Date(r.at || 0), mine = r.who === meWho, child = !!(r.parent && all0.some(function (p) { return p.id === r.parent; }));
          var parentWho = child ? all0.filter(function (p) { return p.id === r.parent; })[0].who : '';
          return { who: r.who, text: r.text, time: r.at ? (d0.getMonth() + 1) + '/' + d0.getDate() + ' ' + d0.getHours() + ':' + pad(d0.getMinutes()) : '', badgeStyle: self.badge(r.who), mine: mine, del: function () { self.tapDeleteReply(r.id); }, delLabel: self.delLabelOf(r.id),
            isChild: child, reLabel: child ? '↳ ' + parentWho + 'への返信' : '', canReply: !child,
            reply: function () { self.setState({ replyTo: { id: r.id, who: r.who } }); setTimeout(function () { var el = document.getElementById('reply-input'); if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); } }, 60); },
            style: 'display: flex; flex-direction: column; gap: 4px; padding: 12px 16px; border-radius: var(--r-card); ' + (child ? 'margin-left: 24px; border-left: 3px solid var(--sep); ' : '') + (mine ? 'background: var(--fill)' : 'background: var(--attn-soft)') };
        });
        return { open: true, kindLabel: KL[x.kind] || '', title: it ? title : '（見つかりません。消されたかもしれません）', body: body || '', hasBody: !!body, meta: meta, hasMeta: !!meta, url: url || '', hasUrl: !!url,
          lines: lines.map(function (l) { return { text: l }; }), hasLines: lines.length > 0, replies: rs, empty: rs.length === 0, canReply: !!it,
          hasCta: !!cta, ctaLabel: cta ? cta[0] : '', cta: cta ? cta[1] : function () {} };
      })(),
      replyDraft: st.replyDraft, setReplyDraft: function (e) { self.setState({ replyDraft: e.target.value }); },
      replyToLabel: st.replyTo ? st.replyTo.who + 'のコメントへの返信' : '', cancelReplyTo: function () { self.setState({ replyTo: null }); },
      sendReply: function () { self.sendReply(); }, closeDetail: function () { self.setState({ detail: null, replyDraft: '', replyTo: null }); },
      detailBackdropStyle: backdrop(!!st.detail), detailSheetStyle: sheetStyle(!!st.detail, 'max-height: 88vh; overflow-y: auto; '),
      museDraft: st.museDraft, setMuseDraft: function (e) { self.setState({ museDraft: e.target.value }); },
      closeMuse: function () { self.closeMuseSheet(); },
      museTitle: /^polish/.test(st.museKind || '') ? 'Museに整えてもらう' : 'Museに相談',
      museLead: /^polish/.test(st.museKind || '') ? 'Museに渡すのは、下の文だけです（いま書いた文が入っています）。送った文はMuse（Meta）側に残ることがあります。残したくない話は、やめて、そのままアプリに入れてください。送るのは自分で、アプリからは自動で送りません。' : 'Museに渡すのは、下の文だけです（写真・日記・メールは入りません）。消したいところは消してから送ってください。送るのは自分で、アプリからは自動で送りません。',
      polishMuse: function () { self.polishMuse(); }, showPolish: !self.polishHidden(), polishMuseNotes: function () { self.polishMuse('notes'); },
      museCopy: function () { self.museSend('copy'); }, museWa: function () { self.museSend('wa'); },
      hasMuseWa: !!String(LS.get('museWa') || '').replace(/[^\d]/g, ''), museWaNum: LS.get('museWa') || '',
      setMuseWaNum: function (e) { LS.set('museWa', e.target.value); self.setState({ museWaAt: Date.now() }); },
      openMuseAny: function () { self.openMuse('any'); }, openMuseMenu: function () { self.openMuse('menu'); },
      museBackdropStyle: backdrop(st.museOpen), museSheetStyle: sheetStyle(st.museOpen, 'max-height: 90vh; overflow-y: auto; '),
      appVersion: 'v' + APP_VERSION,
      lazy: lazy, goalChips: goalChips, news: news, newsCount: news.length, newsEmpty: news.length === 0,
      goalOn: goalId !== 'all', goalNext: curGoal.next || '', goalDue: curGoal.due || '',
      goalCardStyle: 'margin: 0 16px; padding: 12px 16px; border-radius: var(--r-card); background: var(--done-soft); display: flex; flex-direction: column; gap: 4px; animation: rise .35s cubic-bezier(.2,.8,.2,1) both',
      planWeeks: planWeeks, planList: planList, plansEmpty: planTotal === 0, planTotal: planTotal, planRange: planN >= 14 ? '2週間' : planN + '日',
      planCardStyle: 'margin-top: 4px; background: var(--card); border-radius: var(--r-card); padding: 2px 16px 12px; display: flex; flex-direction: column',
      whoTabs: whoTabs, hero: hero, timeline: timeline, flow: flow, flowEmpty: flow.length === 0,
      prog: (function () {
        var tot = mine.length;
        var dn = mine.filter(function (d) { return done[d.id]; }).length;
        var p = tot ? Math.round(dn / tot * 100) : 0;
        var circ = 2 * Math.PI * 44;
        var ring = self.person(whoSel === 'all' ? '家族' : whoSel).ink;
        var msg = tot === 0 ? '今日の担当はありません' : (dn === 0 ? (now.getHours() < 12 ? '今日もはじめよう' : 'あと' + tot + '件') : (dn === tot ? '今日もおつかれさま' : (tot - dn === 1 ? 'あと1つ' : (p >= 50 ? 'いい調子。あと' + (tot - dn) + '件' : 'あと' + (tot - dn) + '件'))));
        var people = names.filter(function (nm) { return whoSel === 'all' || nm === whoSel; }).map(function (nm) {
          var list = duties.filter(function (d) { return d.who === nm; });
          var c = list.filter(function (d) { return done[d.id]; }).length;
          var col = self.person(nm).ink;
          return {
            name: nm, count: c + ' / ' + list.length, nameStyle: 'color: ' + inkText(col),
            barStyle: 'height: 100%; border-radius: var(--r-chip); background: ' + col + '; transition: width .6s cubic-bezier(.2,.8,.2,1); width: ' + (list.length ? c / list.length * 100 : 0) + '%'
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
        return { isNew: !!marks['diary:' + k.id], time: k.time + (k.by ? '　' + k.by : ''), text: k.text, more: moreOf('diary', k.id), textStyle: clamp(5, 'margin: 0; font-size: var(--t-sub); line-height: 1.7'), cardStyle: 'flex-shrink: 0; width: 240px; box-sizing: border-box; background: var(--attn-soft); border-radius: var(--r-card); padding: 16px 16px; display: flex; flex-direction: column; gap: 8px; animation: rise .45s cubic-bezier(.2,.8,.2,1) ' + (i * 60) + 'ms both' };
      }),
      diaryCount: diaryAll.length ? diaryAll.length + '件' : '',
      diaryEmpty: diaryAll.length === 0,
      openDiaryNote: function () { self.openNoteFor('今日の日記', null); },
      pickPhotos: function () { self.pickPhotos(); }, uploadPhotos: function (e) { self.uploadPhotos(e); },
      noteTarget: st.noteTarget, noteDraft: st.noteDraft,
      isHandover: st.noteMode === 'handover',
      canAsk: st.noteMode === 'handover' && self.canAskSwap(st.noteTaskId, st.noteAskDate),
      askBtnLabel: self.askDayWord(st.noteAskDate) + 'の担当を代わってほしい',
      askPressed: st.noteAsk ? 'true' : 'false', askStyle: pill(!!st.noteAsk) + '; align-self: flex-start',
      toggleAsk: function () { var on = !self.state.noteAsk, u = { noteAsk: on }; if (on && !String(self.state.noteDraft || '').trim()) u.noteDraft = self.askDraft(self.state.noteTarget, self.state.noteAskDate); self.setState(u); },
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
      micStyle: 'position: relative; width: 56px; height: 56px; flex-shrink: 0; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .2s, color .2s; ' + (st.listening ? 'background: var(--danger); color: #FFFFFF' : 'background: var(--danger-soft); color: var(--danger)'),
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
      figStyle: 'margin: 8px 16px 0; position: relative; height: ' + (o.length ? 310 : 280) + 'px; border-radius: var(--r-card); box-shadow: 0 14px 34px rgba(0,0,0,0.22); overflow: hidden; background: var(--fill); animation: rise .55s cubic-bezier(.2,.8,.2,1) both',
      photoHint: (D.photos && D.photos.length) ? '写真を読み込んでいます…' : 'ここに子どもたちの写真が流れます。',
      slides: o.map(function (m, i) {
        var on = i === cur;
        var base = 'position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ' + m.pos + '; transition: opacity 1.2s ease, transform ' + (on ? (m.dur + 1) + 's linear' : '1.2s ease') + '; ';
        var vis = on ? 'opacity: 1; transform: scale(' + (m.type === 'video' ? '1' : '1.08') + ')' : 'opacity: 0; transform: scale(1)';
        return { isVideo: m.type === 'video', isPhoto: m.type !== 'video', src: m.src, poster: m.poster || '', badge: !!m.video && m.type !== 'video', style: base + vis };
      }),
      bars: o.map(function (m, i) {
        var w = i < cur ? 'width: 100%' : (i === cur ? 'width: 0; animation: ' + (st.slideIdx % 2 ? 'barA' : 'barB') + ' ' + m.dur + 's linear forwards; animation-play-state: ' + (st.paused ? 'paused' : 'running') : 'width: 0');
        return { fillStyle: 'display: block; height: 100%; background: #fff; border-radius: 3px; ' + w };
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
        /* 引き受けた頼み：今日か先の日でまだ生きていれば取り消せる。先の日は GAS 16（swapsAhead）がある時だけ */
        var okAsk = n.ask === 'swap' && n.answer === 'ok' && n.askDate >= D.today && self.swapApi();
        var live = okAsk && self.swapLive(n.taskId, n.askDate);
        var doneT = n.askDate === D.today && !!(D.done || {})[n.taskId];
        var cancelable = live && !mineTo && !doneT;          /* 頼んだ人：やっぱり自分でやる */
        var backWait = live && mineTo && self.pendingAsk(n.taskId, n.askDate);   /* もう頼み返して返事待ち */
        var backable = live && mineTo && !doneT && !backWait;             /* 引き受けた人：戻してもらえる？と頼む */
        var canceled = okAsk && !live;
        var dayIs = n.askDate && n.askDate !== D.today ? 'この日は' : '今日は';
        return {
          from: n.from, to: n.to, when: whenLabel(n.createdAt), text: n.text, task: n.task,
          unread: !n.read && mineTo && !(n.ask === 'swap' && !n.answer), read: n.read, hasTask: !!n.task,
          fromBadge: self.badge(n.from), toBadge: self.badge(n.to),
          isAsk: n.ask === 'swap', notAsk: n.ask !== 'swap', askLabel: n.ask === 'swap' ? '代わってほしい：' + n.task + (n.askDate && n.askDate !== D.today ? '（' + Number(n.askDate.slice(5, 7)) + '/' + Number(n.askDate.slice(8)) + '）' : '（今日）') : '',
          canAnswer: n.ask === 'swap' && !n.answer && mineTo && n.askDate >= D.today,
          ngLabel: (n.askDate && n.askDate !== D.today ? 'この日は' : '今日は') + 'むずかしい',
          canCancel: !!(cancelable || backable),
          backWait: !!backWait,
          cancelLabel: cancelable ? (self.state.cancelArm === n.askDate + '|' + n.taskId ? 'もう一度で取り消す' : 'やっぱり自分でやる') : (backable ? '戻してもらえる？と頼む' : ''),
          cancelSwap: function () { if (cancelable) self.tapCancelSwap(n.taskId, n.askDate, n.task); else self.askBack(n.taskId, n.askDate, n.task, n.from); },
          answerText: n.answer === 'ok' ? (canceled ? ((self.dutyRow(n.taskId) || {}).who || n.from) + 'の担当に戻りました' : (mineTo ? '代わりました' : n.to + 'が代わってくれました')) : (n.answer === 'ng' ? (mineTo ? '「' + dayIs + 'むずかしい」と返しました' : n.to + 'は' + dayIs + 'むずかしいそうです') : (n.ask === 'swap' && !mineTo ? '返事待ち' : '')),
          answerStyle: 'align-self: flex-start; padding: 4px 10px; border-radius: var(--r-chip); font-size: var(--t-foot); font-weight: 600; ' + (n.answer === 'ok' ? 'background: var(--done-soft); color: var(--done)' : 'background: var(--fill); color: var(--label2)'),
          swapOk: function () { self.answerSwap(n, true); }, swapNg: function () { self.answerSwap(n, false); },
          cardStyle: 'display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: var(--r-card); transition: background .3s; background: ' + (n.read ? 'var(--card2)' : 'var(--attn-soft)') + '; border: 1.5px solid ' + (n.read ? 'transparent' : 'var(--attn)'),
          ack: function () {
            self.ackNote(n, true);
            self.showToast('申し送りを確認しました', function () { self.ackNote(n, false); self.setState({ toast: null }); });
          },
          newReply: !!marks['notes:' + n.id],
          replies: (D.replies || []).filter(function (r) { return r.target === 'notes:' + n.id; }).sort(function (a, b) { return a.at - b.at; }).map(function (r) {
            var mine = r.who === meWho;
            return { who: r.who, text: r.text, time: whenLabel(r.at), badgeStyle: self.badge(r.who), mine: mine,
              del: function () { self.tapDeleteReply(r.id); }, delLabel: self.delLabelOf(r.id),
              style: 'display: flex; flex-direction: column; gap: 4px; padding: 12px 12px; border-radius: var(--r-btn); background: var(--card); ' + (mine ? 'margin-left: 24px' : 'margin-right: 24px') };
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
          style: pill(on, c.ink)
        };
      }),
      decCommentDraft: st.decCommentDraft || '',
      setDecCommentDraft: function (e) { self.setState({ decCommentDraft: e.target.value }); },
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
        return { style: 'height: ' + h + 'px; border-radius: ' + (h > 60 ? 20 : 12) + 'px; background: linear-gradient(90deg, var(--fill) 0%, var(--card2) 40%, var(--fill) 80%); background-size: 780px 100%; animation: shimmer 1.1s linear infinite; animation-delay: ' + (k * 60) + 'ms' };
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
      toastStyle: 'position: fixed; left: 16px; right: 16px; bottom: calc(96px + env(safe-area-inset-bottom)); max-width: 448px; margin: 0 auto; box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 16px; border-radius: var(--r-card); background: var(--toast); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); color: #FFFFFF; box-shadow: 0 8px 24px rgba(0,0,0,0.2); z-index: 30; transition: transform .25s ease-out, opacity .25s; ' + (st.toast ? 'transform: translateY(0); opacity: 1' : 'transform: translateY(24px); opacity: 0; pointer-events: none'),
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
      accountAria: 'メニュー（' + syncLabel + '。アカウント・通知・更新）',
      syncStyle: 'min-height: 44px; padding: 0 12px; border-radius: var(--r-chip); border: none; font-size: var(--t-cap); font-weight: 700; cursor: pointer; ' + (st.offline ? 'background: var(--danger-soft); color: var(--danger)' : 'background: var(--fill); color: var(--label)'),
      openAccount: function () { self.setState({ accountOpen: true }); },
      navTiles: navTiles,
      push: (function () {
        var ps = self.pushState(), q = (D.ui && D.ui.quiet) || '';
        var what = '自分宛ての申し送り（「代わってほしい」も）、相手からの返信・コメント、相談が足された・答えられた時に届きます。自分で書いた物では鳴りません。' + (q ? q + 'の分は、明けてからまとめて届きます。' : '');
        var note = { on: 'この端末で受け取っています。' + what, off: what, needHome: 'ホーム画面のアプリから開くと、通知をオンにできます。', denied: '通知が許可されていません。iPhoneの「設定」→「通知」で、このアプリを許可してください。', unsupported: 'この端末では通知を使えません（iPhoneは iOS 16.4 以降の、ホーム画面のアプリで使えます）。', demo: '見本では通知は使えません。' }[ps];
        return { note: note, canOn: ps === 'off', isOn: ps === 'on', busy: !!st.pushBusy, onLabel: st.pushBusy ? 'オンにしています…' : 'この端末で通知を受け取る',
          on: function () { if (!self.state.pushBusy) self.enablePush(); }, off: function () { self.disablePush(); }, test: function () { self.testPush(); } };
      })(),
      closeAccount: function () { self.setState({ accountOpen: false }); },
      meLabel: D.me ? D.me.who + 'でログイン中' : 'ログイン中',
      meEmail: D.me ? D.me.email : '',
      lastSyncLabel: st.lastSync ? '最後に更新：' + whenLabel(st.lastSync) : 'まだ更新していません',
      refreshNow: function () { self.setState({ accountOpen: false }); self.refresh(); },
      logout: function () { self.logout(); },
      accountBackdropStyle: backdrop(st.accountOpen),
      accountSheetStyle: sheetStyle(st.accountOpen, 'max-height: 88vh; overflow-y: auto; overscroll-behavior: contain; ')   /* 「移動」が増えて長くなったので、シートの中でスクロール */
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
    /* 札は3つまで（4つ目は画面の右で切れるため）。減らす順：全部できた日 → 旅行の日数 */
    ['全部できた日', '旅行まで', '旅行'].forEach(function (k) { if (R.hdr.chips.length > 3) R.hdr.chips = R.hdr.chips.filter(function (c) { return c.k !== k; }); });
    return R;
  };

  /* カレンダーの日を押したら、下の一覧のその日へ。ホームでしぼっていたら広げる */
  App.prototype.planJump = function (day) {
    var self = this, go = function () { var el = document.getElementById('plan-d-' + day); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    USAGE.add('act:plan_day');
    if (!document.getElementById('plan-d-' + day) && this.planMore) { this.planMore(); setTimeout(go, 160); } else go();
  };

  /* ホームでは長い一覧を数件にしぼり、「すべて見る」を付ける。
     そのセクションの居場所が別のタブならそのタブへ、ホームの中ならその場で広げる */
  var HOME_LIMIT = { flow: ['flow', 8], decisions: ['decide', 10], deadlines: ['deadline', 4], topics: ['topics', 10], diary: ['diary', 3], shop: ['shop', 8], outings: ['weekend', 3], news: ['news', 5], planList: ['plan', 3] };
  App.prototype.homeMore = function (R, isHome, secTab, curTab, flowAll) {
    var self = this, st = this.state, more = {};
    Object.keys(HOME_LIMIT).forEach(function (k) {
      var sec = HOME_LIMIT[k][0], n = HOME_LIMIT[k][1], list = R[k] || [];
      var count = k === 'shop' ? list.reduce(function (a, g) { return a + g.items.length; }, 0) : list.length;
      var m = { show: false, label: '', go: function () {}, style: 'align-self: flex-start; margin: 8px ' + ({ topics: 1, diary: 1, outings: 1, news: 1 }[k] ? '20px' : '0') + ' 0; min-height: 44px; padding: 0 4px; border-radius: var(--r-btn); border: none; background: transparent; color: var(--accent); font-size: var(--t-sub); font-weight: 600; cursor: pointer' };
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
        R.flow = keep(flowAll, flowAll.filter(function (r) { return r.id === st.lastDuty; }).concat(flowAll.filter(function (r) { return !r.done; })), n);
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
        ['鍋', false, '食卓で家族みんなで。', [['鶏肉', '400g'], ['豆腐', '1丁'], ['白菜', '1/4株']], '卓上で。', 35132136]
      ];
      /* 来週の見本（日・火・木・金） */
      var nextDishes = [
        [7, '見本：親子丼', false, '見本の献立です。', [['鶏もも肉', '300g'], ['卵', '4個'], ['玉ねぎ', '1個']], '見本の作り方。'],
        [9, '見本：豚汁', true, '見本の献立です。', [['豚こま肉', '200g'], ['大根', '1/3本'], ['にんじん', '1本'], ['みそ', '大さじ3']], '見本の作り方。'],
        [11, '見本：筑前煮', true, '見本の献立です。', [['鶏もも肉', '300g'], ['にんじん', '1本'], ['ごぼう', '1本'], ['冷凍いんげん', '1袋']], '見本の作り方。'],
        [12, '見本：焼きそば', false, '見本の献立です。', [['焼きそば麺', '3玉'], ['キャベツ', '1/4個']], '見本の作り方。']
      ];
      demoDB = {
        me: { email: 'demo@example.com', who: 'とと' }, api: 18, today: ymd(t), swapsAhead: [{ date: ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)), id: 'd1', who: 'まま', orig: 'とと' }],
        duties: [[390, '起こして朝ごはん', 'とと'], [435, '犬の散歩', 'とと'], [480, '保育園の送り', 'まま'], [1020, '保育園のお迎え', 'まま'], [1080, '夕ごはん（ホットクック）', 'とと'], [1140, 'お風呂', 'とと'], [1200, '寝かしつけ', 'まま'], [1230, '保育園の持ち物（着替え2組・タオル・連絡帳）をそろえて玄関に置く', 'まま']].map(function (x, i) { return { id: 'd' + (i + 1), t: x[0], task: x[1], who: x[2], rel: i === 0 ? 90 : (i === 2 ? 0 : null) }; }),
        done: {}, checked: {},
        dutiesAll: [[390, '起こして朝ごはん', 'とと', '毎日', 90], [435, '犬の散歩', 'とと', '毎日'], [480, '保育園の送り', 'まま', '平日', 0], [1020, '保育園のお迎え', 'まま', '平日'], [1080, '夕ごはん（ホットクック）', 'とと', '毎日'], [1140, 'お風呂', 'とと', '毎日'], [1200, '寝かしつけ', 'まま', '毎日'], [1230, '保育園の持ち物（着替え2組・タオル・連絡帳）をそろえて玄関に置く', 'まま', '毎日'], [600, 'ゴミ出し', '家族', '火金']].map(function (x, i) { var o = { id: 'd' + (i + 1), t: x[0], task: x[1], who: x[2], rule: x[3], date: '', rel: x[4] == null ? null : x[4] }; if (o.id === 'd6') { o.priv = true; o.privAny = true; } return o; }),   /* d6 は「Museに出さない」の見本 */
        notes: [{ id: 'n0', createdAt: Date.now() - 1800e3, from: 'まま', to: 'とと', taskId: 'd7', task: '寝かしつけ', text: '見本：今日の「寝かしつけ」、代わってもらえる？', read: false, ask: 'swap', askDate: ymd(t), answer: '' }, { id: 'n1', createdAt: Date.now() - 3600e3, from: 'まま', to: 'とと', taskId: '', task: '', text: '保育園の連絡帳に、明日の持ち物（着替え2組）が書いてありました。', read: false }, { id: 'n2', createdAt: Date.now() - 7200e3, from: 'とと', to: 'まま', taskId: 'd1', task: '起こして朝ごはん', text: '見本：明日の「起こして朝ごはん」、代わってもらえる？', read: true, ask: 'swap', askDate: ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)), answer: 'ok' }],
        diary: [{ id: 'k1', date: ymd(t), time: '7:40', by: 'まま', text: '散歩で、公園の手前からふたりとも自分で歩きたがった。', target: '今日の日記' }],
        menu: dishes.map(function (x, i) { var m = { date: dd(i), dish: x[0], hotcook: x[1], note: x[2], ingredients: x[3], how: x[4], photo: x[5] ? pexels(x[5]) : '' }; if (i % 2 && m.photo) { m.photoBy = 'wiki'; m.photoTitle = x[0]; m.photoCredit = { artist: '見本の作者', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', page: 'https://commons.wikimedia.org/wiki/File:Example.jpg' }; } return m; })
          .concat(nextDishes.map(function (x) { return { date: dd(x[0]), dish: x[1], hotcook: x[2], note: x[3], ingredients: x[4], how: x[5], photo: '' }; })),
        menuFrom: dd(0), menuTo: dd(13),
        shop: { week: dd(0), groups: [{ label: 'お店で買う', items: [['e', '大根', '1本'], ['f', 'じゃがいも', '4個']] }, { label: 'WEBで頼む（冷凍・重いもの）', items: [['a', '鶏もも肉', '600g'], ['c', '冷凍ブロッコリー', '1袋']] }] },
        shopCats: ['お店で買う', 'WEBで頼む（冷凍・重いもの）'],
        shopLastCat: { '豚こま肉': 'WEBで頼む（冷凍・重いもの）', '冷凍いんげん': 'WEBで頼む（冷凍・重いもの）', 'にんじん': 'お店で買う' },
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
        decisions: [{ id: 'q0', q: '見本：夏の旅行はどこにする？', options: ['見本：海', '見本：山'], due: '', state: '決まった', a1: '見本：海', a2: '見本：海', decided: '見本：海', note: '' },
          { id: 'q1', q: '見本：週末の朝ごはん、どうする？', options: ['見本：A案', '見本：B案', '話したい'], due: dd(5), state: '相談中', a1: '見本：A案', a2: '', decided: '', note: '' }],
        deadlines: [{ id: 'k1', what: '見本：保育園の書類を出す', due: ymd(t), who: 'まま', done: false, url: '', note: '' }, { id: 'k2', what: '見本：ペットホテルの予約', due: dd(9), who: 'とと', done: false, url: '', note: '' }],
        outings: [{ id: 'o1', name: '見本：近くの公園', kind: '公園', date: '', place: '', url: '', note: '芝生が広い', like1: false, like2: true, state: '候補', go: '' }],
        weather: { place: '', code: 1, now: 15, max: 18, min: 9, pop: 20 }, streak: 3,
        topicsArchived: [{ id: 't0', title: '見本：去年の旅のしおり', url: 'https://example.com/old', note: '終わった旅行のリンク', date: '10/02' }],
        topics: [{ id: 't1', title: '見本：旅のしおり', url: 'https://example.com', note: '持ち物と1日ずつの予定', date: '11/19' }, { id: 't2', title: '見本：年末の帰省の相談', url: '', note: '見本の長い文です。12/28の夕方に出て、実家に2泊する案。新幹線は混むので、車で行くなら途中で1回休む。おみやげは前の日に買う。ふたりの昼寝の時間に合わせて出発したい。帰りは12/30の午前。大掃除は帰ってからにするか、出る前に半分だけ済ませるか、決めたい。年賀状は今年は写真入りにする？', date: '11/20' }],
        replies: [{ id: 'r0', target: 'notes:n1', who: 'とと', at: Date.now() - 1200e3, text: '見本の返信：了解、今夜カバンに入れておきます。' }, { id: 'r1', target: 'topics:t2', who: 'まま', at: Date.now() - 1800e3, text: '見本のコメント：出る前に半分だけ大掃除がいいと思う。' }],
        shopSuggest: [{ name: '牛乳', qty: '2本', cat: 'お店で買う', note: 'そろそろ（1週ごと）', due: true }, { name: 'バナナ', qty: '1房', cat: 'お店で買う', note: '3回買った', due: false }],
        photosReady: false,
        people: [{ name: 'とと', ink: '#3046A6' }, { name: 'まま', ink: '#A3355D' }], family: { name: '家族', ink: '#2C6B52' },
        ui: Object.assign({ depart: 480, timeStart: 360, timeEnd: 1260, kidsLabel: 'ふたり', kidsBirth: '2024-04-01', noMenuDish: 'まだ決まっていません', noMenuNote: '日曜の15分で決めます。' }, /[?&]trip=1/.test(location.search) ? { tripFrom: dd(t.getDay() - 1), tripTo: dd(t.getDay() + 3) } : {})   /* ?demo=1&trip=1 で旅行中の見本 */
      };
      /* 見本：大項目「朝の準備」と小項目（犬の散歩の後） */
      demoDB.dutiesAll.push({ id: 'dp1', t: 465, task: '朝の準備', who: 'とと', rule: '毎日', date: '', rel: null });
      demoDB.duties.push({ id: 'dp1', t: 465, task: '朝の準備', who: 'とと', rel: null });
      ['水筒の準備', '吸入用のお水の用意', '子どもの朝ごはんの準備'].forEach(function (x, i) {
        demoDB.dutiesAll.push({ id: 'dk' + i, t: 465, task: x, who: 'とと', rule: '毎日', date: '', rel: null, parent: 'dp1' });
        demoDB.duties.push({ id: 'dk' + i, t: 465, task: x, who: 'とと', rel: null, parent: 'dp1' });
      });
    }
    var db = demoDB;
    return new Promise(function (res) {
      setTimeout(function () {
        var a = p.action;
        if (a === 'boot') return res({ ok: true, data: JSON.parse(JSON.stringify(db)) });
        if (a === 'photos') return res({ ok: true, photos: [] });
        if (a === 'photosBatch') return res({ ok: true, photos: {} });
        if (a === 'swapDuty') db.duties.forEach(function (x) { if (x.id !== p.id) return; if (p.take) { if (!x.orig) x.orig = x.who; x.who = 'とと'; if (x.orig === 'とと') x.orig = ''; } else if (x.orig) { x.who = x.orig; x.orig = ''; } });
        if (a === 'answerSwap') db.notes.forEach(function (x) { if (x.id !== p.id) return; x.answer = p.ok ? 'ok' : 'ng'; x.read = true; if (!p.ok) return;
          if (x.askDate === db.today) db.duties.forEach(function (y) { if (y.id === x.taskId) { if (!y.orig) y.orig = y.who; y.who = 'とと'; } });
          else { var row = (db.dutiesAll || []).filter(function (y) { return y.id === x.taskId; })[0]; (db.swapsAhead = db.swapsAhead || []).push({ date: x.askDate, id: x.taskId, who: 'とと', orig: row ? row.who : x.from }); } });
        if (a === 'cancelSwap') { db.notes.unshift({ id: uid('n'), createdAt: Date.now(), from: 'とと', to: 'まま', taskId: p.id, task: '', text: '（見本）自分でやることにしました。代わらなくて大丈夫です', read: false }); db.swapsAhead = (db.swapsAhead || []).filter(function (x) { return !(x.id === p.id && x.date === p.date); }); if (p.date === db.today) db.duties.forEach(function (y) { if (y.id === p.id && y.orig) { y.who = y.orig; y.orig = ''; } }); }
        if (a === 'setDepart') { var dm0 = minOf(p.time); db.ui.depart = dm0; db.dutiesAll.concat(db.duties).forEach(function (x) { if (x.rel != null) x.t = dm0 - x.rel; }); }
        if (a === 'setDone') { if (p.done) db.done[p.taskId] = true; else delete db.done[p.taskId]; }
        if (a === 'setDoneMany') (p.ids || []).forEach(function (id) { if (p.done) db.done[id] = true; else delete db.done[id]; });
        if (a === 'setShop') { if (p.checked) db.checked[p.itemId] = true; else delete db.checked[p.itemId]; }
        if (a === 'addNote') db.notes.unshift(p.note);
        if (a === 'deleteNote') db.notes = db.notes.filter(function (x) { return x.id !== p.id; });
        if (a === 'ackNote') db.notes.forEach(function (x) { if (x.id === p.id) x.read = p.read; });
        if (a === 'addDiary') db.diary.push(p.entry);
        if (a === 'deleteDiary') db.diary = db.diary.filter(function (x) { return x.id !== p.id; });
        if (a === 'saveMenu') { db.menu = db.menu.filter(function (x) { return x.date !== p.menu.date; }).concat([{ date: p.menu.date, dish: p.menu.dish, servings: p.menu.servings, hotcook: p.menu.hotcook, note: p.menu.note, ingredients: p.menu.ingredients.map(function (x) { return [x.name, x.qty]; }), how: p.menu.how, photo: '' }]); }
        if (a === 'deleteMenu') db.menu = db.menu.filter(function (x) { return x.date !== p.date; });
        if (a === 'addShopMany') (p.items || []).forEach(function (x) {
          var g = db.shop.groups.filter(function (y) { return y.label === x.cat; })[0];
          if (!g) { g = { label: x.cat, items: [] }; db.shop.groups.push(g); }
          g.items.push([x.id, x.name, x.qty]);
        });
        if (a === 'addReply') db.replies.push({ id: p.reply.id, target: p.reply.target, who: 'とと', at: Date.now(), text: p.reply.text, parent: p.reply.parent || '' });
        if (a === 'addPhoto') { db.uploaded = (db.uploaded || 0) + 1; }
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
