/**
 * わが家の今日 — Google側（スプレッドシート「家族DB」に入れるコード）
 *
 * 使い方
 * 1. 家族DBのスプレッドシートで「拡張機能 → Apps Script」を開き、このファイルの中身を貼る
 * 2. appsscript.json も同じ内容にする（プロジェクトの設定で「appsscript.json を表示」をオン）
 * 3. 関数 setup を1回実行する（シートと見本の行ができる）
 * 4. 「設定」シートにクライアントIDと2人のメールアドレスを書く
 * 5. 「デプロイ → 新しいデプロイ → ウェブアプリ」。実行ユーザー：自分、アクセス：全員
 *
 * 守り：どの操作も、Googleでログインした「設定」シートの2人だけが使える。
 * 「アクセス：全員」はURLに届くという意味で、中身はログインしないと返さない。
 */

var TZ = 'Asia/Tokyo';
var DOWS = ['日', '月', '火', '水', '木', '金', '土'];
var SESSION_DAYS = 180;

var SHEETS = {
  '設定': ['項目', '値', '説明'],
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

/* ================= 入口 ================= */

function doGet() {
  return out({ ok: true, app: 'wagaya' });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents || '{}');
    var action = String(req.action || '');
    if (action === 'login') return out(login(req));
    var me = sessionUser(req.session);
    if (!me) return out({ ok: false, code: 'no_session' });
    switch (action) {
      case 'boot': return out({ ok: true, data: boot(req, me) });
      case 'photos': return out({ ok: true, photos: photos() });
      case 'logout': return out(logout(req.session));
      case 'setDone': return out(withLock(function () { return setCheck(req.date, '担当', req.taskId, !!req.done, me); }));
      case 'setShop': return out(withLock(function () { return setCheck(req.week, '買い物', req.itemId, !!req.checked, me); }));
      case 'addNote': return out(withLock(function () { return addNote(req.note, me); }));
      case 'ackNote': return out(withLock(function () { return ackNote(req.id, !!req.read, me); }));
      case 'deleteNote': return out(withLock(function () { return deleteOwn('申し送り', req.id, 2, me); }));
      case 'addDiary': return out(withLock(function () { return addDiary(req.entry, me); }));
      case 'deleteDiary': return out(withLock(function () { return deleteOwn('日記', req.id, 3, me); }));
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

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { var r = fn(); return r || { ok: true }; } finally { lock.releaseLock(); }
}

/* ================= ログイン ================= */

function settings() {
  var rows = rowsOf('設定'), s = {};
  rows.forEach(function (r) { s[String(r[0]).trim()] = String(r[1] == null ? '' : r[1]).trim(); });
  return s;
}

function peopleMap() {
  var s = settings(), m = {};
  if (s['パパのメール']) m[s['パパのメール'].toLowerCase()] = 'パパ';
  if (s['ママのメール']) m[s['ママのメール'].toLowerCase()] = 'ママ';
  return m;
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
  var who = peopleMap()[email];
  if (!who) return { ok: false, code: 'not_allowed' };
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var now = new Date();
  sheet('_sessions').appendRow([sha(token), email, now, new Date(now.getTime() + SESSION_DAYS * 864e5)]);
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
      if (rows[i][0] === h && new Date(rows[i][3]).getTime() > Date.now()) { email = rows[i][1]; break; }
    }
    if (!email) return null;
    cache.put('s_' + h, email, 21600);
  }
  var who = peopleMap()[String(email).toLowerCase()];
  return who ? { email: email, who: who } : null;
}

function logout(token) {
  var h = sha(String(token || ''));
  CacheService.getScriptCache().remove('s_' + h);
  var sh = sheet('_sessions'), rows = rowsOf('_sessions');
  for (var i = rows.length - 1; i >= 0; i--) if (rows[i][0] === h) sh.deleteRow(i + 2);
  return { ok: true };
}

function sha(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ================= 読み出し ================= */

function boot(req, me) {
  var today = /^\d{4}-\d{2}-\d{2}$/.test(req.today || '') ? req.today : ymd(new Date());
  var t = parseYmd(today);
  var weekStart = new Date(t.getFullYear(), t.getMonth(), t.getDate() - t.getDay());
  var weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
  var dow = t.getDay();
  var s = settings();

  var duties = rowsOf('担当').filter(function (r) { return r[0] && r[2] && dayMatch(String(r[4] || '毎日'), dow); }).map(function (r) {
    return { id: String(r[0]), t: minutes(r[1]), task: String(r[2]), who: whoOf(r[3]) };
  });

  var checks = rowsOf('チェック');
  var done = {}, checked = {};
  var shop = shopFor(weekStart);
  checks.forEach(function (r) {
    if (!truthy(r[3])) return;
    var d = normDate(r[0]);
    if (r[1] === '担当' && d === today) done[String(r[2])] = true;
    if (r[1] === '買い物' && d === shop.week) checked[String(r[2])] = true;
  });

  var since = Date.now() - 14 * 864e5;
  var notes = rowsOf('申し送り').filter(function (r) { return r[0]; }).map(function (r) {
    return { id: String(r[0]), createdAt: new Date(r[1]).getTime(), from: whoOf(r[2]), to: whoOf(r[3]), taskId: String(r[4] || ''), task: String(r[5] || ''), text: String(r[6] || ''), read: truthy(r[7]) };
  }).filter(function (n) { return !n.read || n.createdAt >= since; });

  var diary = rowsOf('日記').filter(function (r) { return r[0] && normDate(r[1]) === today; }).map(function (r) {
    return { id: String(r[0]), date: today, time: normTime(r[2]), by: whoOf(r[3]), text: String(r[4] || ''), target: String(r[5] || '') };
  });

  var menu = rowsOf('献立').filter(function (r) { var d = normDate(r[0]); return d && d >= ymd(weekStart) && d <= ymd(weekEnd); }).map(function (r) {
    return { date: normDate(r[0]), dish: String(r[1] || ''), hotcook: truthy(r[2]), note: String(r[3] || ''), ingredients: parseIngredients(r[4]), how: String(r[5] || ''), photo: String(r[6] || '') };
  });

  var goals = rowsOf('中期').filter(function (r) { return r[0]; }).map(function (r) { return { id: String(r[0]), label: String(r[1]), next: String(r[2] || ''), due: String(r[3] || '') }; });
  var news = rowsOf('ニュース').filter(function (r) { return r[0] && r[5]; }).slice(-30).reverse().map(function (r) {
    return { id: String(r[0]), goals: String(r[1] || '').split(/[,、\s]+/).filter(String), src: String(r[2] || 'Web'), from: String(r[3] || ''), date: r[4] instanceof Date ? (r[4].getMonth() + 1) + '月' + r[4].getDate() + '日' : String(r[4] || ''), title: String(r[5]), why: String(r[6] || ''), body: String(r[7] || ''), url: String(r[8] || '') };
  });

  return {
    me: me, today: today, duties: duties, done: done, checked: checked, notes: notes, diary: diary,
    menu: menu, shop: shop, plans: plansFor(weekStart, weekEnd, s['カレンダーID']), goals: goals, news: news,
    photosReady: !!s['写真フォルダID']
  };
}

function shopFor(weekStart) {
  var ws = ymd(weekStart);
  var rows = rowsOf('買い物').filter(function (r) { return r[1] && r[3]; });
  var weeks = rows.map(function (r) { return normDate(r[0]); }).filter(function (w) { return w && w <= ws; }).sort();
  var week = weeks.indexOf(ws) >= 0 ? ws : (weeks.length ? weeks[weeks.length - 1] : ws);
  var groups = [], byLabel = {};
  rows.forEach(function (r) {
    if (normDate(r[0]) !== week) return;
    var label = String(r[2] || 'その他');
    if (!byLabel[label]) { byLabel[label] = { label: label, items: [] }; groups.push(byLabel[label]); }
    byLabel[label].items.push([String(r[1]), String(r[3]), String(r[4] || '')]);
  });
  return { week: week, groups: groups };
}

function plansFor(weekStart, weekEnd, calendarId) {
  if (!calendarId) {
    return rowsOf('予定').filter(function (r) { var d = normDate(r[0]); return d && d >= ymd(weekStart) && d <= ymd(weekEnd); })
      .map(function (r) { return { date: normDate(r[0]), time: normTime(r[1]), what: String(r[2] || ''), who: whoOf(r[3]) }; });
  }
  var end = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() + 1);
  var items;
  try {
    items = Calendar.Events.list(calendarId, { timeMin: weekStart.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 100 }).items || [];
  } catch (err) { console.error(err); return []; }
  var outList = [];
  items.forEach(function (ev) {
    if (ev.status === 'cancelled') return;
    var title = String(ev.summary || '（予定）'), who = '家族';
    var m = title.match(/^(パパ|ママ|家族)\s*[：:]\s*/);
    if (m) { who = m[1]; title = title.slice(m[0].length); }
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

function photos() {
  var folderId = settings()['写真フォルダID'];
  if (!folderId) return [];
  var q = "'" + folderId.replace(/'/g, '') + "' in parents and mimeType contains 'image/' and trashed = false";
  var auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  var files;
  try {
    files = Drive.Files.list({ q: q, pageSize: 8, orderBy: 'createdTime desc', fields: 'files(id,thumbnailLink)' }).files || [];
  } catch (err) { console.error(err); return []; }
  var cache = CacheService.getScriptCache();
  return files.map(function (f) {
    var key = 'p_' + f.id, src = cache.get(key);
    if (!src && f.thumbnailLink) {
      var img = UrlFetchApp.fetch(f.thumbnailLink.replace(/=s\d+$/, '=s900'), { headers: auth, muteHttpExceptions: true });
      if (img.getResponseCode() === 200) {
        src = 'data:' + (img.getHeaders()['Content-Type'] || 'image/jpeg') + ';base64,' + Utilities.base64Encode(img.getContent());
        if (src.length < 95000) cache.put(key, src, 21600);
      }
    }
    return src ? { src: src, pos: 'center 30%' } : null;
  }).filter(Boolean);
}

/* ================= 書き込み ================= */

function setCheck(date, kind, id, val, me) {
  var d = normDate(date);
  if (!d || !id) return { ok: false, code: 'bad_request' };
  var sh = sheet('チェック'), rows = rowsOf('チェック');
  for (var i = 0; i < rows.length; i++) {
    if (normDate(rows[i][0]) === d && rows[i][1] === kind && String(rows[i][2]) === String(id)) {
      sh.getRange(i + 2, 4, 1, 3).setValues([[val, me.who, new Date()]]);
      return { ok: true };
    }
  }
  sh.appendRow([d, kind, String(id), val, me.who, new Date()]);
  return { ok: true };
}

function addNote(n, me) {
  n = n || {};
  var text = String(n.text || '').slice(0, 1000).trim();
  if (!text || !n.id) return { ok: false, code: 'bad_request' };
  sheet('申し送り').appendRow([String(n.id), new Date(), me.who, whoOf(n.to), String(n.taskId || ''), String(n.task || ''), text, '', '']);
  return { ok: true };
}

function ackNote(id, read, me) {
  var sh = sheet('申し送り'), rows = rowsOf('申し送り');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { sh.getRange(i + 2, 8, 1, 2).setValues([[read, read ? me.who : '']]); return { ok: true }; }
  }
  return { ok: false, code: 'not_found' };
}

function addDiary(k, me) {
  k = k || {};
  var text = String(k.text || '').slice(0, 1000).trim();
  if (!text || !k.id) return { ok: false, code: 'bad_request' };
  sheet('日記').appendRow([String(k.id), normDate(k.date) || ymd(new Date()), String(k.time || ''), me.who, text, String(k.target || '今日の日記')]);
  return { ok: true };
}

/* 自分が書いたものだけ消せる（whoCol は「誰」の列、1始まりでなく0始まり） */
function deleteOwn(name, id, whoCol, me) {
  var sh = sheet(name), rows = rowsOf(name);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]) === String(id) && whoOf(rows[i][whoCol]) === me.who) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: false, code: 'not_found' };
}

/* ================= 道具 ================= */

function sheet(name) { return SpreadsheetApp.getActive().getSheetByName(name); }
function rowsOf(name) {
  var sh = sheet(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS[name].length).getValues();
}
function pad(n) { return ('0' + n).slice(-2); }
function ymd(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function normDate(v) {
  if (v instanceof Date) return ymd(v);
  var s = String(v || '').trim(), m;
  if ((m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})$/))) return new Date().getFullYear() + '-' + pad(m[1]) + '-' + pad(m[2]);
  return '';
}
function normTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'H:mm');
  var m = String(v || '').match(/^(\d{1,2})[:：](\d{2})/);
  return m ? Number(m[1]) + ':' + m[2] : '';
}
function minutes(v) { var t = normTime(v); if (!t) return 0; var p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function truthy(v) { return v === true || v === 'TRUE' || v === 'true' || v === '済' || v === 1; }
function whoOf(v) { var s = String(v || '').trim(); return s === 'パパ' || s === 'ママ' ? s : '家族'; }
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

/* ================= 最初に1回だけ実行する ================= */

function setup() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  // 時刻は文字のまま扱う（Googleの時刻の型はずれやすいため）
  sheet('担当').getRange('B:B').setNumberFormat('@');
  sheet('日記').getRange('C:C').setNumberFormat('@');
  sheet('予定').getRange('B:B').setNumberFormat('@');

  var t = new Date(), ws = new Date(t.getFullYear(), t.getMonth(), t.getDate() - t.getDay());
  var dd = function (i) { return ymd(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i)); };
  var px = function (id) { return id ? 'https://images.pexels.com/photos/' + id + '/pexels-photo-' + id + '.jpeg?auto=compress&cs=tinysrgb&w=900' : ''; };
  seed('設定', [
    ['クライアントID', '', 'Google CloudのOAuthクライアントID（…apps.googleusercontent.com）'],
    ['パパのメール', '', 'Kenのログインに使うGoogleアカウント'],
    ['ママのメール', '', '妻のログインに使うGoogleアカウント'],
    ['カレンダーID', '', '家族の共有Googleカレンダーの「カレンダーID」。空なら「予定」シートを使う'],
    ['写真フォルダID', '', '子どもの写真を置くGoogleドライブのフォルダID（URLの folders/ の後ろ）。空なら写真は出さない']
  ]);
  seed('担当', [
    ['d1', '6:30', '起こして朝ごはん', 'パパ', '毎日'],
    ['d2', '7:15', '犬の散歩', 'パパ', '毎日'],
    ['d3', '8:00', '保育園の送り', 'ママ', '平日'],
    ['d4', '17:00', '保育園のお迎え', 'ママ', '平日'],
    ['d5', '18:00', '夕ごはん（ホットクック）', 'パパ', '毎日'],
    ['d6', '19:00', 'お風呂', 'パパ', '毎日'],
    ['d7', '20:00', '寝かしつけ', 'ママ', '毎日']
  ]);
  seed('献立', [
    [dd(0), 'ハンバーグと温野菜', false, 'フライパンで焼く日。温野菜は冷凍ブロッコリーで。', '合いびき肉:400g / 玉ねぎ:1個 / 卵:1個 / 冷凍ブロッコリー:1/2袋', 'たねを作って焼く。温野菜は電子レンジで。', px(28893432)],
    [dd(1), '鶏と大根の煮物', true, '朝に材料を入れて予約。18時に完成。', '鶏もも肉:300g / 大根:1/2本 / しょうゆ・みりん:各大さじ2', '材料を切って内なべへ。朝に予約して、18時に仕上がるようにする。', px(34536865)],
    [dd(2), '豚汁と焼き鮭', true, '豚汁はホットクック、鮭はグリルで同時に。', '豚こま肉:150g / 大根・にんじん:適量 / みそ:大さじ3 / 塩鮭:4切れ', '豚汁はホットクックの汁物メニュー。鮭はグリルで同時に焼く。', px(39692061)],
    [dd(3), 'カレー', true, '多めに作って、木曜の朝にも回す。', '豚こま肉:250g / じゃがいも:2個 / 玉ねぎ:2個 / カレールウ:1/2箱', '水を入れずに野菜の水分で煮る。', px(674574)],
    [dd(4), '肉じゃが', true, '朝に予約。お迎えのあとすぐ食べられる。', '牛こま肉:200g / じゃがいも:2個 / 玉ねぎ:1個 / しょうゆ・砂糖:各大さじ2', '朝に予約。', ''],
    [dd(5), 'テイクアウト', false, '金曜は作らない日。', '', '帰り道で受け取る。', px(17597420)],
    [dd(6), '鍋', false, '食卓で家族みんなで。', '鶏肉・豆腐・白菜:適量 / 鍋つゆ:1袋', '卓上で。子ども用は先に取り分けて冷ます。', px(35132136)]
  ]);
  seed('買い物', [
    [dd(0), 'e', 'お店で買う', '大根', '1本'], [dd(0), 'f', 'お店で買う', 'じゃがいも', '4個'], [dd(0), 'g', 'お店で買う', '玉ねぎ', '3個'],
    [dd(0), 'h', 'お店で買う', '塩鮭', '4切れ'], [dd(0), 'i', 'お店で買う', 'カレールウ', '1箱'],
    [dd(0), 'a', 'WEBで頼む（冷凍・重いもの）', '鶏もも肉', '600g'], [dd(0), 'b', 'WEBで頼む（冷凍・重いもの）', '豚こま肉', '400g'],
    [dd(0), 'c', 'WEBで頼む（冷凍・重いもの）', '冷凍ブロッコリー', '1袋'], [dd(0), 'd', 'WEBで頼む（冷凍・重いもの）', '牛乳', '2本']
  ]);
  seed('中期', [
    ['ai', 'AI・仕組み', '1月の復職後も手をかけずに回る、家族の道具をそろえる', '12月末'],
    ['trip', '旅行', '旅行中に、写真の共有と申し送りの使い方を妻と相談する', '旅行中'],
    ['edu', '子どもの教育', '2歳からの過ごし方を、公的な指針をもとに整理する', '未定'],
    ['work', '復職の準備', '1月の復職に向けて、平日の朝と夕方の段取りを決める', '12月']
  ]);
  seed('ニュース', [
    ['m4', 'ai,work', 'Muse', 'AI新聞', '2026-11-19', 'ChatGPTに「Live Dictation」', '音声入力でメモを残す流れに効くかも', 'ChatGPTに音声の書き取り機能が出た、という話題。詳しい中身は未確認。', 'https://aimokuyokai.com/portal/#/news'],
    ['m3', 'ai', 'Muse', 'AI新聞', '2026-11-17', 'OpenAI、GPT-6.2のAstraとSolの提供を開始', 'ChatGPTとの使い分けを見直す材料', '11月17日に提供が始まった。2つの違いの詳細は未確認。', 'https://aimokuyokai.com/portal/#/news'],
    ['m2', 'ai', 'Muse', 'AI新聞', '2026-11-19', 'Claude CodeのProjectsで、進行役がより能動的に', '旅行後に試すClaude Codeの判断材料', '進行役がより能動的に動くようになった、という話題。詳しい中身は未確認。', 'https://aimokuyokai.com/portal/#/news'],
    ['m1', 'ai,work', 'Muse', 'AI新聞', '2026-11-19', 'ClaudeがGoogle Meetに参加し、会議中に資料を共同で作る', '復職後の会議メモを自動にする候補', 'TeamとEnterprise向けのベータ。残すのは文字起こしと要約で、音声は残さない。', 'https://aimokuyokai.com/portal/#/news'],
    ['w1', 'edu', 'Web', 'こども家庭庁', '2026-10-23', '「はじめの100か月の育ちビジョン」の全国大会と国際シンポジウム、11月22〜23日', '0〜8歳ごろの育ちを、国がどう考えているかを知る材料', '東京の会場とオンラインのハイブリッドで、参加は無料。一般の申し込みは11月13日で締め切り済み。', 'https://kyodonewsprwire.jp/release/202610198174']
  ]);
  seed('予定', [
    [dd(6), '10:00', '公園へおでかけ（見本）', '家族']
  ]);
  var first = ss.getSheets()[0];
  if (first.getName() === 'シート1' && first.getLastRow() === 0) ss.deleteSheet(first);
  SpreadsheetApp.getUi().alert('準備ができました。「設定」シートにクライアントIDと2人のメールアドレスを書いてください。');
}

function seed(name, rows) {
  var sh = sheet(name);
  if (sh.getLastRow() > 1 || !rows.length) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}
