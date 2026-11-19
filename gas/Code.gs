/**
 * わが家の今日 — Google側（スプレッドシート「WAGAYA DB」に入れるコード）
 *
 * このコードには家族のデータを書かない。中身はすべてスプレッドシートから読む。
 * - 列は「1行目の見出しの名前」で読む。列を足したり並べ替えたりしてよい
 * - 人の呼び名・色・誕生日・時間帯などは「設定」シート、見出し・表示・順番は「画面」シート
 * - シートを直すと自動で反映（数十秒〜）。すぐ反映したい時は、メニュー「わが家 → アプリに反映」
 *
 * 使い方（コードを変えた時）
 * 1. このファイルと appsscript.json を Apps Script に貼って保存
 * 2. 関数 setup を実行（足りないシート・列・設定の行だけ足す。今ある行は消さない）
 * 3. デプロイ → デプロイを管理 → 鉛筆 → 新バージョン → デプロイ（URLは変わらない）
 *
 * 守り：どの操作も、Googleでログインした「設定」シートの2人だけが使える。
 */

var TZ = 'Asia/Tokyo';
var DOWS = ['日', '月', '火', '水', '木', '金', '土'];
var SESSION_DAYS = 180;
var SNAP_SECONDS = 600;   // まとめたデータを覚えておく時間（予定・写真の更新の目安）

/* 各シートの見出し（setupで足りない列を足すのに使う。並べ替えは自由） */
var SHEETS = {
  '設定': ['項目', '値', '説明'],
  '画面': ['キー', '見出し', 'みんなのタブ', '人のタブ', '順番', '説明'],
  '担当': ['id', '時刻', 'やること', '担当', '曜日'],
  'チェック': ['日付', '種類', '対象ID', '済', '誰', '更新'],
  '申し送り': ['id', '作成', 'from', 'to', 'taskId', 'task', 'text', '確認', '確認した人'],
  '日記': ['id', '日付', '時刻', '誰', 'text', '対象'],
  '献立': ['日付', '料理', 'ホットクック', 'メモ', '材料', '作り方', '写真URL'],
  '買い物': ['週', 'id', '分類', '品名', '量'],
  '予定': ['日付', '時刻', '内容', '誰'],
  '中期': ['id', '名前', '次の一手', '期限'],
  'ニュース': ['id', '中期ID', '出どころ', '発信元', '日付', '見出し', 'なぜ今', '本文', 'URL'],
  '_sessions': ['hash', 'email', '作成', '期限']
};

/* 設定シートの行（setupで、無い行だけ足す） */
var SETTING_ROWS = [
  ['クライアントID', '', 'Google CloudのOAuthクライアントID（…apps.googleusercontent.com）'],
  ['人1の呼び名', 'とと', 'アプリでの呼び名。「担当」「予定」などの誰の欄にもこの名前を書く（パパ・ととでも通じる）'],
  ['人1のメール', '', 'この人がログインに使うGoogleアカウント'],
  ['人1の色', '#3046A6', '色コード（#から始まる6けた）'],
  ['人2の呼び名', 'まま', 'アプリでの呼び名（ママ・ままでも通じる）'],
  ['人2のメール', '', 'この人がログインに使うGoogleアカウント'],
  ['人2の色', '#A3355D', '色コード'],
  ['家族の色', '#2C6B52', '「家族」の担当・予定の色'],
  ['子どもの呼び方', 'ふたり', '写真の上の「ふたり 2歳4か月」の前半'],
  ['子どもの誕生日', '', 'yyyy-mm-dd。空なら年齢を出さない'],
  ['時間帯のはじまり', '6:00', '「つぎの担当」の帯の左はし'],
  ['時間帯のおわり', '21:00', '「つぎの担当」の帯の右はし'],
  ['献立がない日の料理名', 'まだ決まっていません', ''],
  ['献立がない日のメモ', '日曜の15分で決めます。', ''],
  ['カレンダーID', '', '家族の共有Googleカレンダーの「カレンダーID」。空なら「予定」シートを使う。予定名の頭に「とと:」「まま:」で担当の色'],
  ['写真フォルダID', '', '子どもの写真を置くGoogleドライブのフォルダID（URLの folders/ の後ろ）。空なら写真は出さない']
];

/* 画面シートの行（キーはアプリ側の名前なので変えない。見出し・表示・順番は自由） */
var SCREEN_ROWS = [
  ['photos', '写真', true, false, 1, '子どもの写真のスライド'],
  ['hero', 'つぎの担当', true, true, 2, '大きな時計と時間帯の帯'],
  ['flow', '今日の流れ', true, true, 3, '今日の担当のチェック'],
  ['diary', '今日の日記', true, true, 4, '気づきのメモ'],
  ['week', '今週のごはん', true, true, 5, '献立'],
  ['shop', '買い物リスト', true, true, 6, ''],
  ['plan', '今週の予定', true, true, 7, '人のタブでは、その人と家族の予定だけ'],
  ['news', 'ピックアップニュース', true, true, 8, '']
];

/* ================= 入口 ================= */

function doGet() {
  return out({ ok: true, app: 'wagaya' });
}

function doPost(e) {
  _tables = {}; _cfg = null;
  try {
    var req = JSON.parse(e.postData.contents || '{}');
    var action = String(req.action || '');
    if (action === 'login') return out(login(req));
    var me = sessionUser(req.session);
    if (!me) return out({ ok: false, code: 'no_session' });
    switch (action) {
      case 'boot': return out({ ok: true, data: bootFor(req, me) });
      case 'photos': return out({ ok: true, photos: photoList() });
      case 'photosBatch': return out(photosBatch(req.ids));
      case 'logout': return out(logout(req.session));
      case 'setDone': return out(withLock(function () { return setCheck(req.date, '担当', req.taskId, !!req.done, me); }));
      case 'setShop': return out(withLock(function () { return setCheck(req.week, '買い物', req.itemId, !!req.checked, me); }));
      case 'addNote': return out(withLock(function () { return addNote(req.note, me); }));
      case 'ackNote': return out(withLock(function () { return ackNote(req.id, !!req.read, me); }));
      case 'deleteNote': return out(withLock(function () { return deleteOwn('申し送り', req.id, 'from', me); }));
      case 'addDiary': return out(withLock(function () { return addDiary(req.entry, me); }));
      case 'deleteDiary': return out(withLock(function () { return deleteOwn('日記', req.id, '誰', me); }));
    }
    return out({ ok: false, code: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return out({ ok: false, code: 'error', message: String(err && err.message || err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* 書き込みは1つずつ。終わったら、まとめたデータを作り直す合図を出す */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  _tables = {};
  try { var r = fn(); return r || { ok: true }; } finally { bump(); lock.releaseLock(); }
}

/* ================= スプレッドシートのメニューと自動反映 ================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('わが家')
    .addItem('アプリに反映', 'refreshApp')
    .addItem('シートを整える（足りない列・行を足す）', 'setup')
    .addToUi();
}

/* 手でシートを直したら、次にアプリが読む時に作り直す */
function onEdit() { bump(); }

function refreshApp() {
  bump();
  _tables = {}; _cfg = null;
  var today = ymd(new Date());
  snapPut(today, buildBoot(today));
  SpreadsheetApp.getActive().toast('アプリに反映しました。アプリを下に引っぱると新しい内容が出ます。', 'わが家', 5);
}

/* ================= 設定 ================= */

var _cfg = null;
function settings() {
  if (_cfg) return _cfg;
  var cache = CacheService.getScriptCache(), key = 'cfg_' + ver();
  var hit = cache.get(key);
  if (hit) return (_cfg = JSON.parse(hit));
  var s = {};
  rowsOf('設定').forEach(function (r) { var k = String(r['項目'] || '').trim(); if (k) s[k] = String(r['値'] == null ? '' : r['値']).trim(); });
  try { cache.put(key, JSON.stringify(s), 21600); } catch (e) {}
  return (_cfg = s);
}

/* 2人と家族。呼び名は設定シート、昔の呼び方（パパ・ママ）でも通じる */
function people() {
  var s = settings();
  var p1 = s['人1の呼び名'] || 'とと', p2 = s['人2の呼び名'] || 'まま';
  return {
    list: [
      { name: p1, email: (s['人1のメール'] || s['パパのメール'] || '').toLowerCase(), ink: s['人1の色'] || '#3046A6', alias: [p1, 'パパ', 'とと', '人1'] },
      { name: p2, email: (s['人2のメール'] || s['ママのメール'] || '').toLowerCase(), ink: s['人2の色'] || '#A3355D', alias: [p2, 'ママ', 'まま', '人2'] }
    ],
    family: { name: '家族', ink: s['家族の色'] || '#2C6B52' }
  };
}

function whoOf(v) {
  var s = String(v || '').trim();
  var ps = people().list;
  for (var i = 0; i < ps.length; i++) if (ps[i].alias.indexOf(s) >= 0) return ps[i].name;
  return '家族';
}

/* ================= ログイン ================= */

function nameOfEmail(email) {
  email = String(email || '').toLowerCase();
  var ps = people().list;
  for (var i = 0; i < ps.length; i++) if (ps[i].email && ps[i].email === email) return ps[i].name;
  return null;
}

function login(req) {
  var s = settings();
  if (!s['クライアントID']) return { ok: false, code: 'not_configured' };
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.idToken || ''), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, code: 'bad_token' };
  var c = JSON.parse(res.getContentText());
  var issOk = c.iss === 'accounts.google.com' || c.iss === 'https://accounts.google.com';
  if (c.aud !== s['クライアントID'] || !issOk || String(c.email_verified) !== 'true' || Number(c.exp) * 1000 < Date.now()) return { ok: false, code: 'bad_token' };
  if (!req.nonce || c.nonce !== req.nonce) return { ok: false, code: 'bad_token' };
  var email = String(c.email).toLowerCase();
  var who = nameOfEmail(email);
  if (!who) return { ok: false, code: 'not_allowed' };
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var now = new Date();
  appendObj('_sessions', { hash: sha(token), email: email, '作成': now, '期限': new Date(now.getTime() + SESSION_DAYS * 864e5) });
  return { ok: true, session: token, me: { email: email, who: who } };
}

function sessionUser(token) {
  if (!token) return null;
  var h = sha(String(token));
  var cache = CacheService.getScriptCache();
  var email = cache.get('s_' + h);
  if (!email) {
    var rows = rowsOf('_sessions');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].hash === h && new Date(rows[i]['期限']).getTime() > Date.now()) { email = rows[i].email; break; }
    }
    if (!email) return null;
    cache.put('s_' + h, email, 21600);
  }
  var who = nameOfEmail(email);
  return who ? { email: email, who: who } : null;
}

function logout(token) {
  var h = sha(String(token || ''));
  CacheService.getScriptCache().remove('s_' + h);
  var rows = rowsOf('_sessions'), sh = sheet('_sessions');
  for (var i = rows.length - 1; i >= 0; i--) if (rows[i].hash === h) sh.deleteRow(rows[i]._row);
  return { ok: true };
}

function sha(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ================= 読み出し ================= */

/* まとめたデータがあればそれを返す（速い）。fresh のときは必ず作り直す */
function bootFor(req, me) {
  var today = /^\d{4}-\d{2}-\d{2}$/.test(req.today || '') ? req.today : ymd(new Date());
  var data = req.fresh ? null : snapGet(today);
  if (!data) { data = buildBoot(today); snapPut(today, data); }
  data.me = me;
  return data;
}

function buildBoot(today) {
  var t = parseYmd(today);
  var weekStart = new Date(t.getFullYear(), t.getMonth(), t.getDate() - t.getDay());
  var weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
  var dow = t.getDay();
  var s = settings();

  var duties = rowsOf('担当').filter(function (r) { return text(r['やること']) && dayMatch(text(r['曜日']) || '毎日', dow); }).map(function (r) {
    return { id: idOf(r, ['時刻', 'やること']), t: minutes(r['時刻']), task: text(r['やること']), who: whoOf(r['担当']) };
  });

  var shop = shopFor(weekStart);
  var done = {}, checked = {};
  rowsOf('チェック').forEach(function (r) {
    if (!truthy(r['済'])) return;
    var d = normDate(r['日付']);
    if (r['種類'] === '担当' && d === today) done[String(r['対象ID'])] = true;
    if (r['種類'] === '買い物' && d === shop.week) checked[String(r['対象ID'])] = true;
  });

  var since = Date.now() - 14 * 864e5;
  var notes = rowsOf('申し送り').filter(function (r) { return r.id; }).map(function (r) {
    return { id: String(r.id), createdAt: new Date(r['作成']).getTime(), from: whoOf(r.from), to: whoOf(r.to), taskId: text(r.taskId), task: text(r.task), text: text(r.text), read: truthy(r['確認']) };
  }).filter(function (n) { return !n.read || n.createdAt >= since; });

  var diary = rowsOf('日記').filter(function (r) { return r.id && normDate(r['日付']) === today; }).map(function (r) {
    return { id: String(r.id), date: today, time: normTime(r['時刻']), by: whoOf(r['誰']), text: text(r.text), target: text(r['対象']) };
  });

  var menu = rowsOf('献立').filter(function (r) { var d = normDate(r['日付']); return d && d >= ymd(weekStart) && d <= ymd(weekEnd); }).map(function (r) {
    return { date: normDate(r['日付']), dish: text(r['料理']), hotcook: truthy(r['ホットクック']), note: text(r['メモ']), ingredients: parseIngredients(r['材料']), how: text(r['作り方']), photo: text(r['写真URL']) };
  });

  var goals = rowsOf('中期').filter(function (r) { return text(r['名前']); }).map(function (r) {
    return { id: idOf(r, ['名前']), label: text(r['名前']), next: text(r['次の一手']), due: text(r['期限']) };
  });
  var news = rowsOf('ニュース').filter(function (r) { return text(r['見出し']); }).slice(-30).reverse().map(function (r) {
    var d = r['日付'];
    return { id: idOf(r, ['見出し']), goals: text(r['中期ID']).split(/[,、\s]+/).filter(String), src: text(r['出どころ']) || 'Web', from: text(r['発信元']), date: d instanceof Date ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : text(d), title: text(r['見出し']), why: text(r['なぜ今']), body: text(r['本文']), url: text(r['URL']) };
  });

  var ps = people();
  return {
    today: today, duties: duties, done: done, checked: checked, notes: notes, diary: diary,
    menu: menu, shop: shop, plans: plansFor(weekStart, weekEnd, s['カレンダーID']), goals: goals, news: news,
    photosReady: !!s['写真フォルダID'], photos: s['写真フォルダID'] ? photoList() : [],
    people: ps.list.map(function (p) { return { name: p.name, ink: p.ink }; }), family: ps.family,
    ui: {
      sections: screenRows(),
      timeStart: minutes(s['時間帯のはじまり']) || 360, timeEnd: minutes(s['時間帯のおわり']) || 1260,
      kidsLabel: s['子どもの呼び方'] || '', kidsBirth: normDate(s['子どもの誕生日']),
      noMenuDish: s['献立がない日の料理名'] || 'まだ決まっていません', noMenuNote: s['献立がない日のメモ'] || ''
    }
  };
}

/* 画面シート：見出し・表示・順番。行が無いキーは初期値 */
function screenRows() {
  var byKey = {};
  rowsOf('画面').forEach(function (r) { var k = text(r['キー']); if (k) byKey[k] = r; });
  return SCREEN_ROWS.map(function (d, i) {
    var r = byKey[d[0]];
    var num = r && r['順番'] !== '' && r['順番'] != null && !isNaN(Number(r['順番'])) ? Number(r['順番']) : d[4];
    return {
      key: d[0], title: r && text(r['見出し']) || d[1],
      all: r && r['みんなのタブ'] !== '' && r['みんなのタブ'] != null ? truthy(r['みんなのタブ']) : d[2],
      person: r && r['人のタブ'] !== '' && r['人のタブ'] != null ? truthy(r['人のタブ']) : d[3],
      order: num + i / 100
    };
  }).sort(function (a, b) { return a.order - b.order; });
}

function shopFor(weekStart) {
  var ws = ymd(weekStart);
  var rows = rowsOf('買い物').filter(function (r) { return text(r['品名']); });
  var weeks = rows.map(function (r) { return normDate(r['週']); }).filter(function (w) { return w && w <= ws; }).sort();
  var week = weeks.indexOf(ws) >= 0 ? ws : (weeks.length ? weeks[weeks.length - 1] : ws);
  var groups = [], byLabel = {};
  rows.forEach(function (r) {
    if (normDate(r['週']) !== week) return;
    var label = text(r['分類']) || 'その他';
    if (!byLabel[label]) { byLabel[label] = { label: label, items: [] }; groups.push(byLabel[label]); }
    byLabel[label].items.push([idOf(r, ['週', '分類', '品名']), text(r['品名']), text(r['量'])]);
  });
  return { week: week, groups: groups };
}

function plansFor(weekStart, weekEnd, calendarId) {
  if (!calendarId) {
    return rowsOf('予定').filter(function (r) { var d = normDate(r['日付']); return d && d >= ymd(weekStart) && d <= ymd(weekEnd); })
      .map(function (r) { return { date: normDate(r['日付']), time: normTime(r['時刻']), what: text(r['内容']), who: whoOf(r['誰']) }; });
  }
  var end = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() + 1);
  var items;
  try {
    items = Calendar.Events.list(calendarId, { timeMin: weekStart.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 100 }).items || [];
  } catch (err) { console.error(err); return []; }
  var names = [];
  people().list.forEach(function (p) { names = names.concat(p.alias); });
  names.push('家族');
  var re = new RegExp('^(' + names.map(function (n) { return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')\\s*[：:]\\s*');
  var outList = [];
  items.forEach(function (ev) {
    if (ev.status === 'cancelled') return;
    var title = String(ev.summary || '（予定）'), who = '家族';
    var m = title.match(re);
    if (m) { who = whoOf(m[1]); title = title.slice(m[0].length); }
    if (ev.start.dateTime) {
      var st = new Date(ev.start.dateTime);
      outList.push({ date: ymd(st), time: Utilities.formatDate(st, TZ, 'H:mm'), what: title, who: who });
    } else {
      var d = parseYmd(ev.start.date), last = parseYmd(ev.end.date);
      for (; d < last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        if (d >= weekStart && d <= weekEnd) outList.push({ date: ymd(d), time: '', what: title, who: who });
      }
    }
  });
  return outList;
}

/* ================= まとめたデータ（スナップショット） ================= */

function ver() {
  var cache = CacheService.getScriptCache();
  var v = cache.get('ver');
  if (!v) { v = String(Date.now()); cache.put('ver', v, 21600); }
  return v;
}
function bump() {
  try { CacheService.getScriptCache().put('ver', String(Date.now()) + Math.random().toString(36).slice(2, 6), 21600); } catch (e) {}
  _cfg = null;
}
function snapGet(today) {
  var s = bigGet('b_' + today + '_' + ver());
  return s ? JSON.parse(s) : null;
}
function snapPut(today, data) {
  var copy = {}; Object.keys(data).forEach(function (k) { if (k !== 'me') copy[k] = data[k]; });
  bigPut('b_' + today + '_' + ver(), JSON.stringify(copy), SNAP_SECONDS);
}

/* CacheService は1件100KBまでなので、分けて入れる */
function bigGet(key) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(key + '_n') || 0);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys), parts = [];
  for (var k = 0; k < n; k++) { if (got[keys[k]] == null) return null; parts.push(got[keys[k]]); }
  return parts.join('');
}
function bigPut(key, str, seconds) {
  var size = 90000, count = Math.ceil(str.length / size) || 1, put = {};
  if (count > 20) return;
  for (var j = 0; j < count; j++) put[key + '_' + j] = str.slice(j * size, (j + 1) * size);
  put[key + '_n'] = String(count);
  try { CacheService.getScriptCache().putAll(put, seconds); } catch (e) {}
}

/* ================= 写真 ================= */

function photoQuery() {
  var folderId = settings()['写真フォルダID'];
  return folderId ? "'" + folderId.replace(/'/g, '') + "' in parents and mimeType contains 'image/' and trashed = false" : '';
}

/* 写真の一覧（idだけ。軽い） */
function photoList() {
  var q = photoQuery();
  if (!q) return [];
  try {
    return (Drive.Files.list({ q: q, pageSize: 8, orderBy: 'createdTime desc', fields: 'files(id,modifiedTime)' }).files || [])
      .map(function (f) { return { id: f.id, v: f.modifiedTime }; });
  } catch (err) { console.error(err); return []; }
}

/* 写真をまとめて返す（写真フォルダの中のものだけ）。覚えている分はすぐ返し、足りない分は並行して取る */
function photosBatch(ids) {
  var q = photoQuery();
  if (!q) return { ok: true, photos: {} };
  var want = {};
  (ids || []).forEach(function (id) { want[String(id)] = 1; });
  var files;
  try { files = Drive.Files.list({ q: q, pageSize: 8, orderBy: 'createdTime desc', fields: 'files(id,thumbnailLink)' }).files || []; }
  catch (err) { console.error(err); return { ok: true, photos: {} }; }
  var res0 = {}, need = [];
  files.forEach(function (f) {
    if (!want[f.id]) return;
    var src = bigGet('p_' + f.id);
    if (src) res0[f.id] = src; else if (f.thumbnailLink) need.push(f);
  });
  if (need.length) {
    var token = ScriptApp.getOAuthToken();
    var res = UrlFetchApp.fetchAll(need.map(function (f) {
      return { url: f.thumbnailLink.replace(/=s\d+$/, '=s800'), headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
    }));
    res.forEach(function (r, i) {
      if (r.getResponseCode() !== 200) return;
      var src = 'data:' + (r.getHeaders()['Content-Type'] || 'image/jpeg') + ';base64,' + Utilities.base64Encode(r.getContent());
      res0[need[i].id] = src;
      bigPut('p_' + need[i].id, src, 21600);
    });
  }
  return { ok: true, photos: res0 };
}

/* 1時間ごと（setupで予約）：写真と今日のまとめを先に用意しておく */
function warmPhotos() {
  photosBatch(photoList().map(function (p) { return p.id; }));
  var today = ymd(new Date());
  if (!snapGet(today)) snapPut(today, buildBoot(today));
}

/* ================= 書き込み ================= */

function setCheck(date, kind, id, val, me) {
  var d = normDate(date);
  if (!d || !id) return { ok: false, code: 'bad_request' };
  var rows = rowsOf('チェック');
  for (var i = 0; i < rows.length; i++) {
    if (normDate(rows[i]['日付']) === d && rows[i]['種類'] === kind && String(rows[i]['対象ID']) === String(id)) {
      setCells('チェック', rows[i]._row, { '済': val, '誰': me.who, '更新': new Date() });
      return { ok: true };
    }
  }
  appendObj('チェック', { '日付': d, '種類': kind, '対象ID': String(id), '済': val, '誰': me.who, '更新': new Date() });
  return { ok: true };
}

function addNote(n, me) {
  n = n || {};
  var body = String(n.text || '').slice(0, 1000).trim();
  if (!body || !n.id) return { ok: false, code: 'bad_request' };
  appendObj('申し送り', { id: String(n.id), '作成': new Date(), from: me.who, to: whoOf(n.to), taskId: String(n.taskId || ''), task: String(n.task || ''), text: body, '確認': '', '確認した人': '' });
  return { ok: true };
}

function ackNote(id, read, me) {
  var rows = rowsOf('申し送り');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) { setCells('申し送り', rows[i]._row, { '確認': read, '確認した人': read ? me.who : '' }); return { ok: true }; }
  }
  return { ok: false, code: 'not_found' };
}

function addDiary(k, me) {
  k = k || {};
  var body = String(k.text || '').slice(0, 1000).trim();
  if (!body || !k.id) return { ok: false, code: 'bad_request' };
  appendObj('日記', { id: String(k.id), '日付': normDate(k.date) || ymd(new Date()), '時刻': String(k.time || ''), '誰': me.who, text: body, '対象': String(k.target || '今日の日記') });
  return { ok: true };
}

/* 自分が書いたものだけ消せる（whoHead は「誰」の列の見出し） */
function deleteOwn(name, id, whoHead, me) {
  var rows = rowsOf(name);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].id) === String(id) && whoOf(rows[i][whoHead]) === me.who) { sheet(name).deleteRow(rows[i]._row); delete _tables[name]; return { ok: true }; }
  }
  return { ok: false, code: 'not_found' };
}

/* ================= 道具 ================= */

function sheet(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

/* シートを「見出し → 値」の行として読む。_row はシート上の行番号 */
var _tables = {};
function table(name) {
  if (_tables[name]) return _tables[name];
  var sh = sheet(name);
  var t = { sh: sh, head: [], col: {}, rows: [] };
  if (sh && sh.getLastRow() >= 1 && sh.getLastColumn() >= 1) {
    var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    t.head = vals[0].map(function (h) { return String(h).trim(); });
    t.head.forEach(function (h, i) { if (h && !(h in t.col)) t.col[h] = i; });
    for (var r = 1; r < vals.length; r++) {
      var o = { _row: r + 1 };
      t.head.forEach(function (h, j) { if (h && !(h in o)) o[h] = vals[r][j]; });
      t.rows.push(o);
    }
  }
  return (_tables[name] = t);
}
function rowsOf(name) { return table(name).rows; }
function setCells(name, rowNum, obj) {
  var t = table(name);
  Object.keys(obj).forEach(function (k) { if (t.col[k] != null) t.sh.getRange(rowNum, t.col[k] + 1).setValue(obj[k]); });
  delete _tables[name];
}
function appendObj(name, obj) {
  var t = table(name);
  var head = t.head.length ? t.head : SHEETS[name];
  t.sh.appendRow(head.map(function (h) { return h in obj ? obj[h] : ''; }));
  delete _tables[name];
}

/* idの列が空の行にも、中身から決まったidを付ける（中身を変えるとidも変わる） */
function idOf(r, keys) {
  if (r.id !== '' && r.id != null) return String(r.id);
  return 'r' + sha(keys.map(function (k) { return text(r[k]); }).join('|')).slice(0, 10);
}

function text(v) { return v == null ? '' : String(v).trim(); }
function pad(n) { return ('0' + n).slice(-2); }
function ymd(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function normDate(v) {
  if (v instanceof Date) return ymd(v);
  var s = String(v || '').trim(), m;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})$/))) return new Date().getFullYear() + '-' + pad(m[1]) + '-' + pad(m[2]);
  return '';
}
function normTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'H:mm');
  var m = String(v || '').match(/^(\d{1,2})[:：](\d{2})/);
  return m ? Number(m[1]) + ':' + m[2] : '';
}
function minutes(v) { var t = normTime(v); if (!t) return 0; var p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function truthy(v) { return v === true || v === 'TRUE' || v === 'true' || v === '済' || v === '○' || v === 1; }
function dayMatch(rule, dow) {
  rule = rule.trim();
  if (!rule || rule === '毎日') return true;
  if (rule === '平日') return dow >= 1 && dow <= 5;
  if (rule === '土日' || rule === '週末') return dow === 0 || dow === 6;
  return rule.indexOf(DOWS[dow]) >= 0;
}
function parseIngredients(v) {
  return String(v || '').split(/\s*[\/／\n]\s*/).filter(String).map(function (x) {
    var p = x.split(/[:：]/); return [p[0].trim(), (p[1] || '').trim()];
  });
}

/* ================= シートを整える（何度実行しても、今ある行は消さない） ================= */

function setup() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var want = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight('bold');
      sh.setFrozenRows(1);
      return;
    }
    var head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(function (h) { return String(h).trim(); });
    var missing = want.filter(function (h) { return head.indexOf(h) < 0; });
    if (missing.length) sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  });
  _tables = {};

  // 時刻は文字のまま扱う（Googleの時刻の型はずれやすいため）
  [['担当', '時刻'], ['日記', '時刻'], ['予定', '時刻']].forEach(function (x) {
    var t = table(x[0]), c = t.col[x[1]];
    if (c != null) t.sh.getRange(1, c + 1, t.sh.getMaxRows(), 1).setNumberFormat('@');
  });

  // 設定：無い行だけ足す。昔の「パパのメール」「ママのメール」は人1・人2へ移す
  var cfg = table('設定'), have = {};
  cfg.rows.forEach(function (r) { have[text(r['項目'])] = r; });
  var legacy = { '人1のメール': 'パパのメール', '人2のメール': 'ママのメール' };
  SETTING_ROWS.forEach(function (row) {
    if (have[row[0]]) return;
    var v = row[1];
    if (legacy[row[0]] && have[legacy[row[0]]]) v = text(have[legacy[row[0]]]['値']);
    appendObj('設定', { '項目': row[0], '値': v, '説明': row[2] });
  });
  _tables = {};
  table('設定').rows.slice().reverse().forEach(function (r) {
    var k = text(r['項目']);
    if (k === 'パパのメール' || k === 'ママのメール') sheet('設定').deleteRow(r._row);
  });
  _tables = {};

  // 画面：無いキーだけ足す
  var scr = table('画面'), keys = {};
  scr.rows.forEach(function (r) { keys[text(r['キー'])] = 1; });
  SCREEN_ROWS.forEach(function (row) {
    if (keys[row[0]]) return;
    appendObj('画面', { 'キー': row[0], '見出し': row[1], 'みんなのタブ': row[2], '人のタブ': row[3], '順番': row[4], '説明': row[5] });
  });
  _tables = {};
  scr = table('画面');
  ['みんなのタブ', '人のタブ'].forEach(function (h) {
    var c = scr.col[h];
    if (c != null && scr.rows.length) scr.sh.getRange(2, c + 1, scr.rows.length, 1).insertCheckboxes();
  });

  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'warmPhotos'; })) {
    ScriptApp.newTrigger('warmPhotos').timeBased().everyHours(1).create();
  }
  var first = ss.getSheets()[0];
  if (first.getName() === 'シート1' && first.getLastRow() === 0) ss.deleteSheet(first);
  bump();
  try { ss.toast('シートを整えました。「設定」と「画面」で呼び名・見出し・表示を変えられます。', 'わが家', 6); } catch (e) {}
}
