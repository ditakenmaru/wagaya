/* わが家の今日 — 家族アプリ（画面）
 * 画面は index.html の <template id="tpl"> に書き、ここで描画する。
 * データは GAS（Googleのスプレッドシートとカレンダー）から取る。
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var DEMO = /[?&]demo=1/.test(location.search) || !!CFG.demo;
  var LS = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
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
  var EVT = { onclick: 'click', onchange: 'input', oninput: 'input', onkeydown: 'keydown' };
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
  function api(action, payload) {
    payload = Object.assign({ action: action, session: LS.get('session') }, payload || {});
    if (DEMO) return demoApi(payload);
    if (!CFG.gasUrl) return Promise.reject({ code: 'not_configured' });
    return fetch(CFG.gasUrl, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (!res || !res.ok) throw res || { code: 'bad_response' }; return res; });
  }

  /* ---------------- 日付の道具 ---------------- */
  var DOWS = ['日', '月', '火', '水', '木', '金', '土'];
  function pad(n) { return ('0' + n).slice(-2); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function hm(m) { return Math.floor(m / 60) + ':' + pad(m % 60); }
  function whenLabel(ms) {
    var d = new Date(ms), now = new Date();
    var day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var t = d.getHours() + ':' + pad(d.getMinutes());
    if (d >= day0) return '今日 ' + t;
    if (d >= new Date(day0 - 864e5)) return '昨日 ' + t;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + t;
  }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pexels(id, w) { return 'https://images.pexels.com/photos/' + id + '/pexels-photo-' + id + '.jpeg?auto=compress&cs=tinysrgb&w=' + (w || 900); }
  var MOOD = [5728162, 4262172, 29144275, 6646360];

  /* ---------------- 画面のロジック ---------------- */
  function App() {
    DCLogic.call(this);
    var cached = LS.get('boot');
    this.state = {
      who: 'all', day: null, dayAnim: 0, hideBought: false, now: Date.now(), toast: null, sheet: false,
      loading: !cached, data: cached, photos: [],
      slideIdx: 0, slideAt: Date.now(), paused: false,
      noteOpen: false, noteMode: 'diary', noteTarget: '', noteTaskId: null, noteDraft: '', listening: false,
      notesOpen: false, draft: '', draftTo: null,
      mounted: {}, seen: {}, goal: 'all', goalAnim: 0, newsOpen: {},
      planDay: null, planAnim: 0,
      needLogin: !DEMO && !LS.get('session'), loginError: '', loggingIn: false,
      accountOpen: false, syncing: false, lastSync: cached ? cached._at : 0, offline: false
    };
    this.lazyIds = ['diary', 'week', 'shop', 'plan', 'news'];
  }
  App.prototype = Object.create(DCLogic.prototype);

  App.prototype.componentDidMount = function () {
    var self = this;
    /* 画面の描き直しは「分が変わった時」と「写真を送る時」だけ（毎秒は描かない） */
    this.timer = setInterval(function () {
      var s = self.state, upd = null;
      if (Math.floor(Date.now() / 60000) !== Math.floor(s.now / 60000)) upd = { now: Date.now() };
      var n = self.order().length;
      if (n && self.showPhotos() && !s.paused && !s.loading && (Date.now() - s.slideAt) / 1000 >= self.slideDur(s.slideIdx)) { upd = upd || {}; upd.slideIdx = s.slideIdx + 1; upd.slideAt = Date.now(); }
      if (upd) self.setState(upd);
    }, 1000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { self.setState({ now: Date.now() }); self.refresh(true); } });
    this.poll = setInterval(function () { if (document.visibilityState === 'visible') self.refresh(true); }, 60000);
    this.handleRedirect().then(function () { if (!self.state.needLogin) self.refresh(!!self.state.data); });
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
    var blocked = function () { var s = self.state; return s.needLogin || s.noteOpen || s.notesOpen || s.sheet || s.accountOpen; };
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
      self.refresh(false, true).then(function (ok) {
        setTimeout(function () {
          show(56, ok ? '新しくしました' : '更新できませんでした', false);
          setTimeout(function () { self.pulling = false; show(0); }, 700);
        }, Math.max(0, 400 - (Date.now() - t0)));
      });
    }, { passive: true });
  };

  /* ログイン：Googleの画面へ移動し、戻ってきたらGASで確かめる */
  App.prototype.login = function () {
    if (!CFG.clientId) { this.setState({ loginError: 'ログインの設定（クライアントID）がまだです。config.js を確かめてください。' }); return; }
    var nonce = uid('n');
    LS.set('nonce', nonce);
    var redirect = location.origin + location.pathname;
    var q = 'client_id=' + encodeURIComponent(CFG.clientId) + '&redirect_uri=' + encodeURIComponent(redirect) +
      '&response_type=id_token&scope=' + encodeURIComponent('openid email') + '&nonce=' + encodeURIComponent(nonce) + '&prompt=select_account';
    this.setState({ loggingIn: true });
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
  };
  App.prototype.handleRedirect = function () {
    var self = this;
    var h = location.hash.replace(/^#/, '');
    if (!/id_token=|error=/.test(h)) return Promise.resolve();
    var p = {};
    h.split('&').forEach(function (kv) { var i = kv.indexOf('='); p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); });
    history.replaceState(null, '', location.pathname + location.search);
    if (p.error) { this.setState({ needLogin: true, loginError: 'ログインできませんでした（' + p.error + '）。もう一度お試しください。' }); return Promise.resolve(); }
    this.setState({ loggingIn: true });
    return api('login', { idToken: p.id_token, nonce: LS.get('nonce') }).then(function (res) {
      LS.set('session', res.session); LS.del('nonce');
      self.setState({ needLogin: false, loginError: '', loggingIn: false });
    }).catch(function (err) {
      var msg = err && err.code === 'not_allowed' ? 'このアカウントは登録されていません。家族のGoogleアカウントでログインしてください。' : 'ログインを確かめられませんでした。時間をおいてもう一度お試しください。';
      self.setState({ needLogin: true, loginError: msg, loggingIn: false });
    });
  };
  App.prototype.logout = function () {
    var self = this;
    api('logout', {}).catch(function () {});
    LS.del('session'); LS.del('boot');
    self.setState({ needLogin: true, accountOpen: false, data: null, loading: true, photos: [] });
  };

  /* データの読み込み（キャッシュをすぐ出して、裏で新しくする） */
  /* quiet：右上に「更新中」を出さない。fresh：GAS側のまとめを使わず、シートから読み直す */
  App.prototype.refresh = function (quiet, fresh) {
    var self = this;
    if (this.state.needLogin || this.pending > 0) return Promise.resolve(false);
    if (this.inflight) return fresh ? this.inflight.then(function () { return self.refresh(quiet, true); }) : this.inflight;
    if (!quiet) this.setState({ syncing: true });
    this.inflight = api('boot', { today: ymd(new Date()), fresh: !!fresh }).then(function (res) {
      var data = res.data; data._at = Date.now();
      LS.set('boot', data);
      var first = !self.state.data;
      self.setState({ data: data, loading: false, syncing: false, lastSync: data._at, offline: false });
      if (first) setTimeout(function () { self.attachLazy(); }, 60);
      self.loadPhotos(data.photos);
      return true;
    }).catch(function (err) {
      if (err && (err.code === 'no_session' || err.code === 'not_allowed')) { LS.del('session'); self.setState({ needLogin: true, syncing: false }); return false; }
      self.setState({ syncing: false, offline: true });
      if (!quiet) self.showToast(err && err.code === 'not_configured' ? 'つなぎ先（GASのURL）の設定がまだです' : '新しいデータを取れませんでした。通信を確かめてください', null);
      return false;
    }).then(function (ok) { self.inflight = null; return ok; });
    return this.inflight;
  };
  /* 写真：一覧はbootで受け取り、1枚ずつ取りに行って端末に保存する（2回目からはすぐ出る） */
  App.prototype.loadPhotos = function (list) {
    var self = this;
    list = (list || []).slice(0, 8);
    var key = list.map(function (p) { return p.id + p.v; }).join('|');
    if (key === this.photoKey) return;
    this.photoKey = key;
    var slots = list.map(function () { return null; });
    var publish = function () { self.setState({ photos: slots.filter(Boolean) }); };
    var cacheP = (window.caches && window.isSecureContext) ? caches.open('wagaya-photos').catch(function () { return null; }) : Promise.resolve(null);
    var url = function (p) { return location.origin + '/__photo/' + p.id + '?v=' + encodeURIComponent(p.v || ''); };
    var show = function (i, blob) { slots[i] = { src: URL.createObjectURL(blob), pos: 'center 30%' }; publish(); };
    cacheP.then(function (cache) {
      /* 1) 端末に保存してある写真はすぐ出す */
      return Promise.all(list.map(function (p, i) {
        return (cache ? cache.match(url(p)) : Promise.resolve(null)).then(function (hit) { return hit ? hit.blob().then(function (b) { show(i, b); return true; }) : false; }).catch(function () { return false; });
      })).then(function (have) {
        /* 2) 足りない写真だけ、1回の通信でまとめて取る */
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
        if (!cache) return;
        var keep = {}; list.forEach(function (p) { keep[url(p)] = 1; });
        return cache.keys().then(function (reqs) { reqs.forEach(function (r) { if (!keep[r.url]) cache.delete(r); }); });
      }).catch(function () {});
    });
  };

  /* 書き込み：先に画面を変え、失敗したら戻す */
  App.prototype.mutate = function (fn) {
    var d = JSON.parse(JSON.stringify(this.state.data || {}));
    fn(d);
    LS.set('boot', d);
    this.setState({ data: d });
  };
  App.prototype.send = function (action, payload, revert) {
    var self = this;
    this.pending = (this.pending || 0) + 1;
    return api(action, payload).then(function (r) { self.pending -= 1; return r; }).catch(function (err) {
      self.pending -= 1;
      if (revert) revert();
      if (err && err.code === 'no_session') { LS.del('session'); self.setState({ needLogin: true }); return; }
      self.showToast('保存できませんでした。通信を確かめて、もう一度お試しください', null);
    });
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

  /* 写真のスライド */
  App.prototype.media = function () {
    return (this.state.photos || []).map(function (p) { return { type: 'photo', src: p.src, dur: 5, pos: p.pos || 'center 30%' }; });
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
        pick: function () { self.setState({ who: t[0] }); },
        style: 'min-height: 40px; border: none; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; transition: background .2s, color .2s; ' + (on ? 'background: #FFFFFF; color: #17201B; box-shadow: 0 1px 2px rgba(23,32,27,0.12)' : 'background: transparent; color: #55605A')
      };
    });

    var duties = (D.duties || []).slice().sort(function (a, b) { return a.t - b.t; });
    var tS = ui.timeStart || 360, tE = ui.timeEnd > tS ? ui.timeEnd : 1260;
    function pct(m) { return Math.max(0, Math.min(100, (m - tS) / (tE - tS) * 100)); }
    var mine = duties.filter(function (d) { return whoSel === 'all' || d.who === whoSel || d.who === '家族'; });

    var next = null;
    for (var i = 0; i < mine.length; i++) { if (!done[mine[i].id] && mine[i].t >= nowMin) { next = mine[i]; break; } }
    var hero;
    if (next) {
      var diff = Math.max(0, next.t - nowMin);
      var cd = diff <= 0 ? 'いまから' : 'あと' + (diff >= 60 ? Math.floor(diff / 60) + '時間' : '') + (diff % 60 ? (diff % 60) + '分' : '');
      hero = { kicker: 'つぎの担当', time: hm(next.t), countdown: cd, task: next.task, who: next.who, color: this.person(next.who).ink };
    } else {
      var first = mine[0];
      hero = { kicker: '今日の担当はおしまい', time: first ? hm(first.t) : '--:--', countdown: '明日の最初', task: first ? first.task : '担当はありません', who: first ? first.who : '—', color: this.person('家族').ink };
    }
    hero.bandStyle = 'margin: 4px 16px 0; padding: 22px 20px 16px; border-radius: 24px; background: ' + hero.color + '; color: #FFFFFF; display: flex; flex-direction: column; gap: 6px; transition: background .5s; animation: heroIn .6s cubic-bezier(.2,.8,.2,1) both';
    hero.marks = [tS, 720, 1080, tE].filter(function (m, k, a) { return (k === 0 || k === a.length - 1 || (m > tS + 90 && m < tE - 90)); }).map(function (m, k, a) {
      var p0 = pct(m);
      return { label: hm(m), style: 'position: absolute; top: 0; ' + (k === 0 ? 'left: 0' : (k === a.length - 1 ? 'right: 0' : 'left: ' + p0 + '%; transform: translateX(-50%)')) };
    });
    hero.passedStyle = 'position: absolute; left: 0; top: 13px; height: 2px; width: ' + pct(nowMin) + '%; background: #FFFFFF; border-radius: 2px';
    hero.nowStyle = 'position: absolute; top: 4px; left: calc(' + pct(nowMin) + '% - 1px); width: 2px; height: 20px; background: #FFFFFF; border-radius: 2px; animation: breathe 2.4s ease-in-out infinite';
    var timeline = mine.map(function (d) {
      var isNext = next && d.id === next.id;
      var size = isNext ? 14 : 8;
      var fill = done[d.id] || d.t < nowMin ? '#FFFFFF' : 'transparent';
      return { dotStyle: 'position: absolute; top: ' + (14 - size / 2) + 'px; left: calc(' + pct(d.t) + '% - ' + size / 2 + 'px); width: ' + size + 'px; height: ' + size + 'px; border-radius: 50%; box-sizing: border-box; border: 2px solid #FFFFFF; background: ' + fill };
    });

    var flow = mine.map(function (d) {
      var isDone = !!done[d.id];
      var past = d.t < nowMin;
      var c = self.person(d.who);
      var tnotes = notesAll.filter(function (n) { return n.taskId === d.id; });
      return {
        time: hm(d.t), task: d.task, who: d.who, done: isDone,
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
        noteBtnStyle: 'position: relative; width: 44px; height: 44px; margin-right: 6px; flex-shrink: 0; border-radius: 14px; border: none; background: transparent; color: #8A928C; display: flex; align-items: center; justify-content: center; cursor: pointer',
        markStyle: 'width: 24px; height: 24px; flex-shrink: 0; border-radius: 50%; box-sizing: border-box; display: flex; align-items: center; justify-content: center; transition: background .2s; border: 2px solid ' + c.ink + '; background: ' + (isDone ? c.ink : 'transparent'),
        taskStyle: 'flex: 1; min-width: 0; font-size: 16px; font-weight: 700; background-image: linear-gradient(currentColor, currentColor); background-repeat: no-repeat; background-position: 0 55%; transition: background-size .35s cubic-bezier(.2,.8,.2,1), color .3s; background-size: ' + (isDone ? '100% 1.5px; color: #55605A' : '0% 1.5px'),
        badgeStyle: self.badge(d.who)
      };
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
        style: 'flex-shrink: 0; width: 52px; min-height: 72px; border-radius: 16px; border: ' + (isToday && !on ? '2px solid #17201B' : '2px solid transparent') + '; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer; transition: background .2s, color .2s; ' + (on ? 'background: #17201B; color: #FFFFFF' : 'background: #FFFFFF; color: #17201B'),
        dotStyle: 'width: 6px; height: 6px; border-radius: 50%; background: ' + (menuByDow[i].hotcook ? '#C99A1E' : 'transparent')
      };
    });
    var dm = menuByDow[dayIdx];
    var dayOfYear = Math.floor((new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayIdx) - new Date(now.getFullYear(), 0, 1)) / 86400000);
    var dayMenu = {
      label: dayIdx === todayIdx ? '今日' : dows[dayIdx] + '曜', dish: dm.dish, hotcook: !!dm.hotcook, note: dm.note || '',
      ingredients: (dm.ingredients || []).map(function (x) { return { name: x[0], qty: x[1] }; }), how: dm.how || '',
      photo: dm.photo || pexels(MOOD[((dayOfYear % MOOD.length) + MOOD.length) % MOOD.length]),
      photoAlt: dm.photo ? dm.dish + 'のイメージ写真' : '食卓を囲むイメージ写真',
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
          name: x[1], qty: x[2], checked: on,
          toggle: function () {
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
        style: 'flex-shrink: 0; display: flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border-radius: 999px; border: none; font-size: 14px; font-weight: 700; cursor: pointer; transition: background .2s, color .2s; ' + (on ? 'background: #17201B; color: #FFFFFF' : 'background: #FFFFFF; color: #17201B'),
        countStyle: 'min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; ' + (on ? 'background: rgba(255,255,255,.2)' : 'background: #EEF1EC; color: #55605A')
      };
    });
    var news = newsRaw.filter(function (n) { return goalId === 'all' || n.goals.indexOf(goalId) >= 0; }).map(function (n) {
      var open = !!st.newsOpen[n.id];
      var web = n.src === 'Web';
      return {
        title: n.title, why: n.why, body: n.body, url: n.url, src: n.src, meta: n.from + (n.date ? '（' + n.date + '）' : ''),
        open: open, expanded: open ? 'true' : 'false', more: open ? '閉じる' : 'くわしく',
        toggle: function () { var o = Object.assign({}, self.state.newsOpen); o[n.id] = !o[n.id]; self.setState({ newsOpen: o }); },
        srcStyle: 'padding: 3px 8px; border-radius: 6px; font-size: 12px; font-weight: 900; ' + (web ? 'background: #E3E7F6; color: #3046A6' : 'background: #F3E8D6; color: #8A5A12'),
        cardStyle: 'flex-shrink: 0; width: 290px; box-sizing: border-box; scroll-snap-align: start; display: flex; flex-direction: column; gap: 8px; min-height: 230px; padding: 16px; border-radius: 20px; background: #FFFFFF; animation: ' + ((st.goalAnim || 0) % 2 ? 'slideA' : 'slideB') + ' .4s cubic-bezier(.2,.8,.2,1) both'
      };
    });

    /* 今週の予定 */
    var plansRaw = (D.plans || []).map(function (p) { return Object.assign({}, p, { d: Math.round((parseYmd(p.date) - start) / 864e5) }); }).filter(function (p) { return p.d >= 0 && p.d < 7 && (whoSel === 'all' || p.who === whoSel || p.who === '家族'); });
    var planIdx = st.planDay === null ? todayIdx : st.planDay;
    var plans = plansRaw.filter(function (p) { return p.d === planIdx; }).sort(function (a, b) { return (a.time || '') < (b.time || '') ? -1 : 1; }).map(function (p) {
      return { time: p.time || '終日', what: p.what, who: p.who, badgeStyle: self.badge(p.who) };
    });
    var planWeek = dows.map(function (d, i) {
      var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var on = i === planIdx;
      var isToday = i === todayIdx;
      var dayPlans = plansRaw.filter(function (p) { return p.d === i; });
      return {
        dow: isToday ? '今日' : d, date: dt.getDate(), pressed: on ? 'true' : 'false',
        aria: (isToday ? '今日' : d + '曜') + ' ' + dt.getDate() + '日、予定' + dayPlans.length + '件',
        pick: function () { self.setState({ planDay: i, planAnim: (self.state.planAnim || 0) + 1 }); },
        style: 'flex-shrink: 0; width: 52px; min-height: 72px; border-radius: 16px; border: ' + (isToday && !on ? '2px solid #17201B' : '2px solid transparent') + '; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer; transition: background .2s, color .2s; ' + (on ? 'background: #17201B; color: #FFFFFF' : 'background: #FFFFFF; color: #17201B'),
        dots: dayPlans.slice(0, 4).map(function (p) { return { style: 'width: 6px; height: 6px; border-radius: 50%; background: ' + (on ? '#FFFFFF' : self.person(p.who).ink) }; })
      };
    });

    var notesSorted = notesAll.slice().sort(function (a, b) { return (a.read === b.read) ? b.createdAt - a.createdAt : (a.read ? 1 : -1); });
    var myUnread = notesAll.filter(function (n) { return !n.read && n.to === meWho; });
    var unreadAll = notesAll.filter(function (n) { return !n.read; });
    var o = this.order();
    var cur = o.length ? st.slideIdx % o.length : 0;
    var syncLabel = st.syncing ? '更新中…' : (st.offline ? 'オフライン' : meWho);
    var nb = /^\d{4}-\d{2}-\d{2}$/.test(ui.kidsBirth || '') ? parseYmd(ui.kidsBirth) : null;

    /* セクションの見出し・表示・順番（スプレッドシートの「画面」） */
    var SEC_DEF = [['photos', '写真'], ['hero', 'つぎの担当'], ['flow', '今日の流れ'], ['diary', '今日の日記'], ['week', '今週のごはん'], ['shop', '買い物リスト'], ['plan', '今週の予定'], ['news', 'ピックアップニュース']];
    var secCfg = ui.sections && ui.sections.length ? ui.sections : SEC_DEF.map(function (x, k) { return { key: x[0], title: x[1], all: true, person: x[0] !== 'photos', order: k }; });
    var secByKey = {}; secCfg.forEach(function (c) { secByKey[c.key] = c; });
    var title = {}, sections = [];
    SEC_DEF.forEach(function (x) { title[x[0]] = (secByKey[x[0]] && secByKey[x[0]].title) || x[1]; });
    secCfg.concat(SEC_DEF.filter(function (x) { return !secByKey[x[0]]; }).map(function (x) { return { key: x[0], title: x[1], all: true, person: true }; })).forEach(function (c) {
      var vis = whoSel === 'all' ? c.all !== false : c.person !== false;
      var o2 = { key: c.key, wrapStyle: vis ? '' : 'display: none' };
      SEC_DEF.forEach(function (x) { o2['is_' + x[0]] = x[0] === c.key; });
      sections.push(o2);
    });

    return {
      sections: sections, title: title, planNote: '担当の色は、文字（' + names.concat(['家族']).join('・') + '）でも見分けられます。',
      lazy: lazy, goalChips: goalChips, news: news, newsCount: news.length, newsEmpty: news.length === 0,
      goalOn: goalId !== 'all', goalNext: curGoal.next || '', goalDue: curGoal.due || '',
      goalCardStyle: 'margin: 0 20px; padding: 12px 16px; border-radius: 16px; background: #E0EEE7; display: flex; flex-direction: column; gap: 4px; animation: rise .35s cubic-bezier(.2,.8,.2,1) both',
      planWeek: planWeek, plansEmpty: plans.length === 0, planTotal: plansRaw.length,
      planDayLabel: planIdx === todayIdx ? '今日' : dows[planIdx] + '曜',
      planCardStyle: 'margin-top: 4px; background: #FFFFFF; border-radius: 20px; padding: 14px 16px 6px; display: flex; flex-direction: column; animation: ' + ((st.planAnim || 0) % 2 ? 'slideA' : 'slideB') + ' .4s cubic-bezier(.2,.8,.2,1) both',
      whoTabs: whoTabs, hero: hero, timeline: timeline, flow: flow, flowEmpty: flow.length === 0,
      prog: (function () {
        var tot = mine.length;
        var dn = mine.filter(function (d) { return done[d.id]; }).length;
        var p = tot ? Math.round(dn / tot * 100) : 0;
        var circ = 2 * Math.PI * 44;
        var ring = self.person(whoSel === 'all' ? '家族' : whoSel).ink;
        var msg = tot === 0 ? '今日の担当はありません' : (dn === 0 ? '今日もはじめよう' : (dn === tot ? '今日もおつかれさま' : (tot - dn === 1 ? 'あと1つ' : (p >= 50 ? 'いい調子。あと' + (tot - dn) + 'つ' : 'あと' + (tot - dn) + 'つ'))));
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
          aria: '今日の担当 ' + tot + 'つのうち ' + dn + 'つ完了（' + p + '%）',
          ringStyle: 'stroke: ' + ring + '; stroke-width: 11; stroke-linecap: round; stroke-dasharray: ' + circ.toFixed(2) + '; stroke-dashoffset: ' + (circ * (1 - p / 100)).toFixed(2) + '; transition: stroke-dashoffset .7s cubic-bezier(.2,.8,.2,1), stroke .4s',
          people: people
        };
      })(),
      diary: diaryAll.slice().reverse().map(function (k, i) {
        return { time: k.time + (k.by ? '　' + k.by : ''), text: k.text, cardStyle: 'flex-shrink: 0; width: 240px; box-sizing: border-box; background: #FFF6E8; border-radius: 18px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; animation: rise .45s cubic-bezier(.2,.8,.2,1) ' + (i * 60) + 'ms both' };
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
      plans: plans,
      noPhotos: o.length === 0,
      photoHint: (D.photos && D.photos.length) ? '写真を読み込んでいます…' : (D.photosReady ? '写真フォルダに写真を入れると、ここに流れます。' : '写真の共有を設定すると、ここにふたりの写真が流れます。'),
      slides: o.map(function (m, i) {
        var on = i === cur;
        var base = 'position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ' + m.pos + '; transition: opacity 1.2s ease, transform ' + (on ? (m.dur + 1) + 's linear' : '1.2s ease') + '; ';
        return { isVideo: false, isPhoto: true, src: m.src, poster: '', style: base + (on ? 'opacity: 1; transform: scale(1.08)' : 'opacity: 0; transform: scale(1)') };
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
      capStyle: 'position: absolute; left: 20px; bottom: 18px; display: flex; flex-direction: column; gap: 2px; color: #FFFFFF; pointer-events: none; animation: ' + (st.slideIdx % 2 ? 'capIn' : 'capIn2') + ' .8s cubic-bezier(.2,.8,.2,1) .2s both',
      nextSlide: function () { if (o.length) self.setState({ slideIdx: self.state.slideIdx + 1, slideAt: Date.now() }); },
      togglePause: function () { self.setState({ paused: !self.state.paused, slideAt: Date.now() }); },
      paused: st.paused, playing: !st.paused,
      pauseLabel: st.paused ? 'スライドを再開' : 'スライドを一時停止',
      unreadCount: myUnread.length || unreadAll.length,
      hasUnread: unreadAll.length > 0,
      notesNavLabel: unreadAll.length ? '申し送り（未確認' + unreadAll.length + '件）' : '申し送り',
      notesNavBg: st.notesOpen ? 'rgba(255,255,255,0.16)' : 'transparent',
      openNotes: function () { self.setState({ notesOpen: true }); },
      closeNotes: function () { self.setState({ notesOpen: false }); },
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
          }
        };
      }),
      toChoices: names.map(function (p) {
        var on = (st.draftTo || self.otherWho()) === p;
        var c = self.person(p);
        return {
          label: p + 'へ', pressed: on ? 'true' : 'false', pick: function () { self.setState({ draftTo: p }); },
          style: 'min-height: 40px; padding: 0 14px; border-radius: 999px; font-size: 14px; font-weight: 700; cursor: pointer; transition: background .2s, color .2s; border: 1.5px solid ' + c.ink + '; ' + (on ? 'background: ' + c.ink + '; color: #FFFFFF' : 'background: transparent; color: ' + c.ink)
        };
      }),
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
      toastStyle: 'position: fixed; left: 16px; right: 16px; bottom: calc(96px + env(safe-area-inset-bottom)); max-width: 448px; margin: 0 auto; box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 16px; border-radius: 16px; background: #17201B; color: #FFFFFF; box-shadow: 0 8px 24px rgba(23,32,27,0.25); z-index: 60; transition: transform .25s ease-out, opacity .25s; ' + (st.toast ? 'transform: translateY(0); opacity: 1' : 'transform: translateY(24px); opacity: 0; pointer-events: none'),
      openSheet: function () { self.setState({ sheet: true }); },
      closeSheet: function () { self.setState({ sheet: false }); },
      backdropStyle: backdrop(st.sheet),
      sheetStyle: sheetStyle(st.sheet, 'max-height: 80vh; overflow-y: auto; gap: 8px; ', '.3s cubic-bezier(.2,.8,.2,1)'),
      /* ログインとアカウント */
      needLogin: st.needLogin,
      loginError: st.loginError,
      loginLabel: st.loggingIn ? 'ログインしています…' : 'Googleでログイン',
      login: function () { self.login(); },
      syncLabel: syncLabel,
      accountAria: 'アカウントと更新（' + syncLabel + '）',
      syncStyle: 'min-height: 32px; padding: 0 12px; border-radius: 999px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; ' + (st.offline ? 'background: #F5E2E9; color: #7A2645' : 'background: #DDE3DA; color: #39433D'),
      openAccount: function () { self.setState({ accountOpen: true }); },
      closeAccount: function () { self.setState({ accountOpen: false }); },
      meLabel: D.me ? D.me.who + 'でログイン中' : 'ログイン中',
      meEmail: D.me ? D.me.email : '',
      lastSyncLabel: st.lastSync ? '最後に更新：' + whenLabel(st.lastSync) : 'まだ更新していません',
      refreshNow: function () { self.setState({ accountOpen: false }); self.refresh(); },
      logout: function () { self.logout(); },
      accountBackdropStyle: backdrop(st.accountOpen),
      accountSheetStyle: sheetStyle(st.accountOpen, '')
    };
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
        duties: [[390, '起こして朝ごはん', 'とと'], [435, '犬の散歩', 'とと'], [480, '保育園の送り', 'まま'], [1020, '保育園のお迎え', 'まま'], [1080, '夕ごはん（ホットクック）', 'とと'], [1140, 'お風呂', 'とと'], [1200, '寝かしつけ', 'まま']].map(function (x, i) { return { id: 'd' + (i + 1), t: x[0], task: x[1], who: x[2] }; }),
        done: {}, checked: {},
        notes: [{ id: 'n1', createdAt: Date.now() - 3600e3, from: 'まま', to: 'とと', taskId: '', task: '', text: '保育園の連絡帳に、明日の持ち物（着替え2組）が書いてありました。', read: false }],
        diary: [{ id: 'k1', date: ymd(t), time: '7:40', by: 'まま', text: '散歩で、公園の手前からふたりとも自分で歩きたがった。', target: '今日の日記' }],
        menu: dishes.map(function (x, i) { return { date: dd(i), dish: x[0], hotcook: x[1], note: x[2], ingredients: x[3], how: x[4], photo: x[5] ? pexels(x[5]) : '' }; }),
        shop: { week: dd(0), groups: [{ label: 'お店で買う', items: [['e', '大根', '1本'], ['f', 'じゃがいも', '4個']] }, { label: 'WEBで頼む（冷凍・重いもの）', items: [['a', '鶏もも肉', '600g'], ['c', '冷凍ブロッコリー', '1袋']] }] },
        plans: [{ date: dd(3), time: '10:00', what: '保育園の面談', who: 'まま' }, { date: dd(6), time: '10:00', what: '公園へおでかけ', who: '家族' }],
        goals: [{ id: 'ai', label: 'AI・仕組み', next: '家族の道具をそろえる', due: '12月末' }],
        news: [{ id: 'w1', goals: ['ai'], src: 'Web', from: '見本', date: '', title: '見本のニュース', why: '見本モードです', body: '本番ではGASから読み込みます。', url: 'https://example.com' }],
        photosReady: false,
        people: [{ name: 'とと', ink: '#3046A6' }, { name: 'まま', ink: '#A3355D' }], family: { name: '家族', ink: '#2C6B52' },
        ui: { timeStart: 360, timeEnd: 1260, kidsLabel: 'ふたり', kidsBirth: '2024-04-01', noMenuDish: 'まだ決まっていません', noMenuNote: '日曜の15分で決めます。' }
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
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadCtrl && !reloaded) { reloaded = true; location.reload(); } });
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
