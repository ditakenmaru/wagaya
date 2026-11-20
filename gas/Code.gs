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
var API_VERSION = 11;     // 画面（app.js の API_EXPECTED）と合わせる。ずれたら画面に「Google側の更新がまだ」と出る
var BACKUP_KEEP = 8;      // バックアップを何週分残すか

/* 各シートの見出し（setupで足りない列を足すのに使う。並べ替えは自由） */
var SHEETS = {
  '設定': ['項目', '値', '説明'],
  '画面': ['キー', '見出し', 'みんなのタブ', '人のタブ', '順番', '夜の順番', '旅行中', '見る人', '説明', '下のタブ', '朝の順番'],
  '担当': ['id', '時刻', 'やること', '担当', '曜日', '日付'],
  'チェック': ['日付', '種類', '対象ID', '済', '誰', '更新'],
  '申し送り': ['id', '作成', 'from', 'to', 'taskId', 'task', 'text', '確認', '確認した人'],
  '日記': ['id', '日付', '時刻', '誰', 'text', '対象'],
  '献立': ['日付', '料理', 'ホットクック', 'メモ', '材料', '作り方', '写真URL'],
  '買い物': ['週', 'id', '分類', '品名', '量'],
  '予定': ['日付', '時刻', '内容', '誰'],
  '中期': ['id', '名前', '次の一手', '期限'],
  'ニュース': ['id', '中期ID', '出どころ', '発信元', '日付', '見出し', 'なぜ今', '本文', 'URL'],
  '話題': ['id', '見出し', 'URL', '説明', '日付', '表示'],
  '要望': ['id', '日時', '誰', '内容', '画面', '状態', 'メモ'],
  '相談': ['id', '問い', '選択肢', '期限', '状態', '決まったこと', '人1の答え', '人2の答え', 'メモ', '作成'],
  '期限': ['id', '内容', '期限', '担当', '済', 'URL', 'メモ'],
  'お出かけ': ['id', '名前', '種類', '日付', '場所', 'URL', 'メモ', '人1', '人2', '状態', '行く日'],
  '使われ方': ['日付', '誰', '項目', '回数'],
  'ふりかえり': ['週', '作成', '開いた回数', 'よく見たセクション', '見られていないセクション', 'よく使った操作', '未対応の要望', 'エラー', '気づき'],
  '改善ログ': ['日付', 'きっかけ', '仮説', '変えたこと', '結果', '状態'],
  '_sessions': ['hash', 'email', '作成', '期限'],
  '返信': ['id', '対象', '誰', '日時', '本文'],
  '_keys': ['hash', '誰', '作成', '状態', '最後に使った', '回数'],
  'Museの記録': ['日時', '誰', '操作', 'シート', 'id', '内容']
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
  ['写真フォルダID', '', '子どもの写真と動画を置くGoogleドライブのフォルダID（URLの folders/ の後ろ）。空なら写真は出さない'],
  ['動画の上限MB', '10', 'これより大きい動画は、アプリでは1コマだけ出す（最大15）'],
  ['旅行の期間', '', '例：2027-08-10〜2027-08-15。この間は「画面」の「旅行中」に印がある部分だけ出し、話題を一番上に'],
  ['夜の並びにする時刻', '18:00', 'この時刻から、画面の並びを「夜の順番」にする。空なら夜の並びは使わない'],
  ['朝の並びにする時刻', '5:00', 'この時刻から「朝の並びを終える時刻」までは「朝の順番」で並べる。空なら朝の並びは使わない'],
  ['朝の並びを終える時刻', '9:00', 'この時刻から夜の並びまでは、ふだんの「順番」'],
  ['天気の場所', '', '例：東京 35.68,139.76（地名と緯度,経度）。上の見出しに今日の天気を出す。空なら出さない'],
  ['旅行先の天気の場所', '', '例：ハワイ 21.31,-157.86。旅行の期間はこちらの天気を出す']
];

/* 画面シートの行（キーはアプリ側の名前なので変えない。見出し・表示・順番は自由） */
/* キー, 見出し, みんなのタブ, 人のタブ, 順番, 夜の順番, 旅行中, 見る人（空＝2人とも。'人1'＝人1だけ）, 説明, 下のタブ（アプリの下の切り替え。同じ名前のものが同じ画面に出る）, 朝の順番 */
var SCREEN_ROWS = [
  ['photos', '写真', true, false, 1, 0, true, '', '子どもの写真のスライド', '今日', 0],
  ['hero', 'つぎの担当', true, true, 2, 1, false, '', '大きな時計と時間帯の帯', '今日', 1],
  ['flow', '今日の流れ', true, true, 3, 2, false, '', '今日の担当のチェック', '今日', 2],
  ['decide', 'ふたりで決めること', true, true, 3.6, 3, true, '', '相談中のことに、それぞれが答える（「相談」シート）', 'ふたりで', 5],
  ['deadline', '期限があるもの', true, true, 3.7, 6, true, '', '書類・支払い・予約などの期限（「期限」シート）', 'ふたりで', 4],
  ['topics', '話題', true, true, 3.5, 9, true, '', '旅のしおりなど、いま話している資料へのリンク（「話題」シート）', '予定', 9],
  ['diary', '今日の日記', true, true, 4, 10, true, '', '気づき・成長のメモ', '今日', 11],
  ['week', '今週のごはん', true, true, 5, 4, false, '', '献立。材料を買い物リストへ送れる', 'ごはん', 7],
  ['shop', '買い物リスト', true, true, 6, 5, false, '', '', 'ごはん', 8],
  ['weekend', '今週末', true, true, 6.5, 7, false, '', 'お出かけの候補と決まったところ（「お出かけ」シート）', '予定', 10],
  ['plan', '今週の予定', true, true, 7, 8, true, '', '人のタブでは、その人と家族の予定だけ', '予定', 3],
  ['news', 'ピックアップニュース', true, true, 8, 12, false, '人1', '見る人を人1にすると、人1がログインした時だけ出る', 'ニュース', 6]
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
    if (action === 'muse') return out(museCall(req));   // Muse（AIの手伝い）用の入口。ログインの代わりに「鍵」で入る。できることは足すことと一覧を見ることだけ
    var me = sessionUser(req.session);
    if (!me) return out({ ok: false, code: 'no_session' });
    switch (action) {
      case 'boot': return out({ ok: true, data: bootFor(req, me) });
      case 'ver': return out({ ok: true, v: ver() });   // 変わったかだけ確かめる（軽い）。変わっていたら画面が boot で読み直す
      case 'photos': return out({ ok: true, photos: photoList() });
      case 'photosBatch': return out(photosBatch(req.ids));
      case 'video': return out(videoData(req.id));
      case 'logout': return out(logout(req.session));
      case 'setDone': return out(withLock(function () { return setCheck(req.date, '担当', req.taskId, !!req.done, me); }));
      case 'setShop': return out(withLock(function () { return setCheck(req.week, '買い物', req.itemId, !!req.checked, me); }));
      case 'addNote': return out(withLock(function () { return addNote(req.note, me); }));
      case 'ackNote': return out(withLock(function () { return ackNote(req.id, !!req.read, me); }));
      case 'deleteNote': return out(withLock(function () { return deleteOwn('申し送り', req.id, 'from', me); }));
      case 'addDiary': return out(withLock(function () { return addDiary(req.entry, me); }));
      case 'deleteDiary': return out(withLock(function () { return deleteOwn('日記', req.id, '誰', me); }));
      case 'skipDuty': return out(withLock(function () { return setCheck(req.date, '休み', req.id, !!req.skip, me); }));
      case 'saveDuty': return out(withLock(function () { return saveDuty(req.duty || {}); }));
      case 'deleteDuty': return out(withLock(function () { return deleteById('担当', req.id, DUTY_KEYS); }));
      case 'saveShop': return out(withLock(function () { return saveShop(req.item || {}); }));
      case 'deleteShop': return out(withLock(function () { return deleteById('買い物', req.id, SHOP_KEYS); }));
      case 'saveTopic': return out(withLock(function () { return saveTopic(req.topic || {}); }));
      case 'deleteTopic': return out(withLock(function () { return deleteById('話題', req.id, TOPIC_KEYS); }));
      case 'saveDecision': return out(withLock(function () { return saveDecision(req.item || {}); }));
      case 'answerDecision': return out(withLock(function () { return answerDecision(req.id, req.answer, me); }));
      case 'decide': return out(withLock(function () { return decide(req.id, req.decided, !!req.reopen); }));
      case 'deleteDecision': return out(withLock(function () { return deleteById('相談', req.id, ['問い']); }));
      case 'saveDeadline': return out(withLock(function () { return saveDeadline(req.item || {}); }));
      case 'doneDeadline': return out(withLock(function () { var r = findById('期限', req.id, ['内容', '期限']); if (!r) return { ok: false, code: 'not_found' }; setCells('期限', r._row, { '済': !!req.done }); return { ok: true }; }));
      case 'deleteDeadline': return out(withLock(function () { return deleteById('期限', req.id, ['内容', '期限']); }));
      case 'saveOuting': return out(withLock(function () { return saveOuting(req.item || {}); }));
      case 'likeOuting': return out(withLock(function () { return likeOuting(req.id, !!req.like, me); }));
      case 'planOuting': return out(withLock(function () { return planOuting(req.id, req.date, me); }));
      case 'deleteOuting': return out(withLock(function () { return deleteById('お出かけ', req.id, ['名前']); }));
      case 'saveMenu': return out(withLock(function () { return saveMenu(req.menu || {}); }));
      case 'deleteMenu': return out(withLock(function () { return deleteMenu(req.date); }));
      case 'addReply': return out(withLock(function () { return addReply(req.reply || {}, me); }));
      case 'deleteReply': return out(withLock(function () { return deleteOwn('返信', req.id, '誰', me); }));
      case 'addShopMany': return out(withLock(function () { return addShopMany(req.items || []); }));
      case 'logUsage': return out(logUsage(req.counts, req.date, me, req.batch));
      case 'addFeedback': return out(withLock(function () { return addFeedback(req.feedback || {}, me); }));
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
    .addSeparator()
    .addItem('Muse用の鍵を作る', 'museNewKey')
    .addToUi();
}

/* 手でシートを直したら、次にアプリが読む時に作り直す */
function onEdit() { bump(); }

function refreshApp() {
  bump();
  _tables = {}; _cfg = null;
  var today = ymd(new Date()), v = ver();
  snapPut(today, buildBoot(today), v);
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
  rowsOf('設定').forEach(function (r) {
    var k = String(r['項目'] || '').trim(); if (!k) return;
    var v = r['値'];
    /* 「18:00」と打つとシートが時刻の型にする。文字の「18:00」にそろえる（1900年より前の日付は時刻だけの値） */
    if (v && typeof v.getFullYear === 'function') v = Utilities.formatDate(v, TZ, v.getFullYear() < 1901 ? 'H:mm' : 'yyyy-MM-dd');
    s[k] = String(v == null ? '' : v).trim();
  });
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
  var cache = CacheService.getScriptCache(), rk = 'login_' + Math.floor(Date.now() / 600000);
  var n = Number(cache.get(rk) || 0) + 1;
  cache.put(rk, String(n), 900);
  if (n > 30) return { ok: false, code: 'busy' };   // 10分に30回まで（入口を連打されてもGoogle側の上限を使い切らない）
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
  var v = ver();   // 組み立てる前の版で保存する（組み立て中に書き込みがあれば、その版のまとめは使われない）
  var data = req.fresh ? null : snapGet(today, v);
  if (!data) { data = buildBoot(today); snapPut(today, data, v); }
  data.me = me; data.api = API_VERSION; data.v = v;
  return data;
}

function buildBoot(today) {
  var t = parseYmd(today);
  var weekStart = new Date(t.getFullYear(), t.getMonth(), t.getDate() - t.getDay());
  var weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
  var dow = t.getDay();
  var s = settings();

  /* 担当：日付があれば「その日だけ」、なければ曜日のくり返し */
  var dutyRows = rowsOf('担当').filter(function (r) { return text(r['やること']); }).map(function (r) {
    return { id: idOf(r, DUTY_KEYS), t: normTime(r['時刻']) ? minutes(r['時刻']) : null, task: text(r['やること']), who: whoOf(r['担当']), rule: text(r['曜日']) || '毎日', date: normDate(r['日付']) };
  });
  var skipped = {};
  rowsOf('チェック').forEach(function (r) { if (r['種類'] === '休み' && truthy(r['済']) && normDate(r['日付']) === today) skipped[String(r['対象ID'])] = true; });
  var duties = dutyRows.filter(function (d) { return (d.date ? d.date === today : dayMatch(d.rule, dow)) && !skipped[d.id]; })
    .map(function (d) { return { id: d.id, t: d.t, task: d.task, who: d.who, once: !!d.date }; });
  var dutiesAll = dutyRows.filter(function (d) { return !d.date || d.date >= today; });

  var shop = shopFor(weekStart);
  var done = {}, checked = {}, doneBy = {}, skipBy = {}, firstDay = today;
  rowsOf('チェック').forEach(function (r) {
    if (!truthy(r['済'])) return;
    var d = normDate(r['日付']);
    if (r['種類'] === '担当' && d === today) done[String(r['対象ID'])] = true;
    if (r['種類'] === '買い物' && d === shop.week) checked[String(r['対象ID'])] = true;
    if (r['種類'] === '担当' && d) { (doneBy[d] = doneBy[d] || {})[String(r['対象ID'])] = true; if (d < firstDay) firstDay = d; }
    if (r['種類'] === '休み' && d) (skipBy[d] = skipBy[d] || {})[String(r['対象ID'])] = true;
  });
  var streak = streakOf(dutyRows, doneBy, skipBy, firstDay, t);

  var since = Date.now() - 14 * 864e5;
  var notes = rowsOf('申し送り').filter(function (r) { return r.id; }).map(function (r) {
    return { id: String(r.id), createdAt: new Date(r['作成']).getTime(), from: whoOf(r.from), to: whoOf(r.to), taskId: text(r.taskId), task: text(r.task), text: text(r.text), read: truthy(r['確認']) };
  }).filter(function (n) { return !n.read || n.createdAt >= since; });

  var diary = rowsOf('日記').filter(function (r) { return r.id && normDate(r['日付']) === today; }).map(function (r) {
    return { id: String(r.id), date: today, time: normTime(r['時刻']), by: whoOf(r['誰']), text: text(r.text), target: text(r['対象']) };
  });

  var menu = rowsOf('献立').filter(function (r) { var d = normDate(r['日付']); return d && d >= ymd(weekStart) && d <= ymd(weekEnd); }).map(function (r) {
    return { date: normDate(r['日付']), dish: text(r['料理']), hotcook: truthy(r['ホットクック']), note: text(r['メモ']), ingredients: parseIngredients(r['材料']), how: text(r['作り方']), photo: safeUrl(r['写真URL']) };
  });

  var replies = rowsOf('返信').filter(function (r) { return r.id && text(r['本文']); }).slice(-400).map(function (r) {
    return { id: String(r.id), target: text(r['対象']), who: whoOf(r['誰']), at: new Date(r['日時']).getTime() || 0, text: text(r['本文']) };
  });

  var goals = rowsOf('中期').filter(function (r) { return text(r['名前']); }).map(function (r) {
    return { id: idOf(r, ['名前']), label: text(r['名前']), next: text(r['次の一手']), due: text(r['期限']) };
  });
  var news = rowsOf('ニュース').filter(function (r) { return text(r['見出し']); }).slice(-30).reverse().map(function (r) {
    var d = r['日付'];
    return { id: idOf(r, ['見出し']), goals: text(r['中期ID']).split(/[,、\s]+/).filter(String), src: text(r['出どころ']) || 'Web', from: text(r['発信元']), date: d instanceof Date ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : text(d), title: text(r['見出し']), why: text(r['なぜ今']), body: text(r['本文']), url: safeUrl(r['URL']) };
  });

  var topics = rowsOf('話題').filter(function (r) { return text(r['見出し']) && (r['表示'] === '' || r['表示'] == null || truthy(r['表示'])); }).map(function (r) {
    var d = r['日付'];
    return { id: idOf(r, TOPIC_KEYS), title: text(r['見出し']), url: safeUrl(r['URL']), note: text(r['説明']), date: d instanceof Date ? (d.getMonth() + 1) + '/' + d.getDate() : text(d) };
  }).reverse();

  /* ふたりで決めること：相談中のものと、決まって2週間以内のもの */
  var dsince = ymd(new Date(t.getTime() - 14 * 864e5));
  var decisions = rowsOf('相談').filter(function (r) { return text(r['問い']); }).map(function (r) {
    return { id: idOf(r, ['問い']), q: text(r['問い']), options: splitOptions(r['選択肢']), due: normDate(r['期限']), state: text(r['状態']) || '相談中', decided: text(r['決まったこと']),
      a1: text(r['人1の答え']), a2: text(r['人2の答え']), note: text(r['メモ']), created: normDate(r['作成']) };
  }).filter(function (x) { return x.state !== '決まった' || !x.created || x.created >= dsince || (x.due && x.due >= dsince); });

  /* 期限があるもの：済んでいないものと、済んで3日以内のもの */
  var deadlines = rowsOf('期限').filter(function (r) { return text(r['内容']); }).map(function (r) {
    return { id: idOf(r, ['内容', '期限']), what: text(r['内容']), due: normDate(r['期限']), who: whoOf(r['担当']), done: truthy(r['済']), url: safeUrl(r['URL']), note: text(r['メモ']) };
  }).filter(function (x) { return !x.done || (x.due && x.due >= ymd(new Date(t.getTime() - 3 * 864e5))); })
    .sort(function (a, b) { return (a.due || '9999') < (b.due || '9999') ? -1 : 1; });

  /* お出かけ：行った・やめた以外 */
  var outings = rowsOf('お出かけ').filter(function (r) { return text(r['名前']); }).map(function (r) {
    return { id: idOf(r, ['名前']), name: text(r['名前']), kind: text(r['種類']), date: normDate(r['日付']), place: text(r['場所']), url: safeUrl(r['URL']), note: text(r['メモ']),
      like1: truthy(r['人1']), like2: truthy(r['人2']), state: text(r['状態']) || '候補', go: normDate(r['行く日']) };
  }).filter(function (x) { return x.state !== '行った' && x.state !== 'やめた' && (!x.date || x.date >= today) && !(x.go && x.go < today); });

  var trip = tripRange(s['旅行の期間'], today);
  var ps = people();
  return {
    topics: topics, decisions: decisions, deadlines: deadlines, outings: outings, streak: streak,
    weather: weatherFor(trip[0] && trip[1] && today >= trip[0] && today <= trip[1] && s['旅行先の天気の場所'] ? s['旅行先の天気の場所'] : s['天気の場所'], today),
    today: today, duties: duties, dutiesAll: dutiesAll, skipped: skipped, shopSuggest: shopSuggest(shop), done: done, checked: checked, notes: notes, diary: diary,
    menu: menu, replies: replies, shop: shop, plans: plansFor(weekStart, new Date(Math.max(weekEnd.getTime(), t.getTime() + 6 * 864e5)), s['カレンダーID']),   /* 今週と、今日から7日（今週末の日曜まで入る） */ goals: goals, news: news,
    photosReady: !!s['写真フォルダID'], photos: s['写真フォルダID'] ? photoList() : [],
    people: ps.list.map(function (p) { return { name: p.name, ink: p.ink }; }), family: ps.family,
    ui: {
      sections: screenRows(),
      timeStart: minutes(s['時間帯のはじまり']) || 360, timeEnd: minutes(s['時間帯のおわり']) || 1260,
      kidsLabel: s['子どもの呼び方'] || '', kidsBirth: normDate(s['子どもの誕生日']),
      noMenuDish: s['献立がない日の料理名'] || 'まだ決まっていません', noMenuNote: s['献立がない日のメモ'] || '',
      eveningFrom: timeOrNull(s['夜の並びにする時刻'], 1080),
      morningFrom: timeOrNull(s['朝の並びにする時刻'], null), morningTo: timeOrNull(s['朝の並びを終える時刻'], null),
      tripFrom: trip[0] || '', tripTo: trip[1] || ''
    }
  };
}

/* 担当を全部終えた日が何日続いているか（今日は全部終わっていれば数える。担当がない日・休みは飛ばす） */
function streakOf(dutyRows, doneBy, skipBy, firstDay, t) {
  var dayOf = function (k) { var x = new Date(t.getTime()); x.setDate(x.getDate() - k); return x; };
  /* 新しく足した担当で、昔の日が「できていない」にならないよう、担当ごとに初めて済になった日から数える */
  var first = {};
  Object.keys(doneBy).forEach(function (d) { Object.keys(doneBy[d]).forEach(function (id) { if (!first[id] || d < first[id]) first[id] = d; }); });
  var allDone = function (x) {
    var d = ymd(x), dow = x.getDay(), dn = doneBy[d] || {}, sk = skipBy[d] || {};
    var list = dutyRows.filter(function (r) { return (r.date ? r.date === d : dayMatch(r.rule, dow)) && !sk[r.id] && first[r.id] && first[r.id] <= d; });
    if (!list.length) return null;
    return list.every(function (r) { return dn[r.id]; });
  };
  var n = 0;
  for (var k = 1; k <= 60; k++) {
    var x = dayOf(k);
    if (ymd(x) < firstDay) break;
    var a = allDone(x);
    if (a === null) continue;
    if (!a) break;
    n++;
  }
  if (allDone(dayOf(0)) === true) n++;
  return n;
}

/* 今日の天気（Open-Meteo。登録なし・無料）。設定の「地名 緯度,経度」から。1時間まとめて置く */
function weatherFor(spec, today) {
  var m = String(spec || '').match(/(-?\d+(?:\.\d+)?)\s*[,、]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  var place = String(spec).replace(m[0], '').trim();
  var key = 'wx_' + m[1] + '_' + m[2] + '_' + today, cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return hit === 'none' ? null : JSON.parse(hit);
  var fail = function () { try { cache.put(key, 'none', 600); } catch (e) {} return null; };   /* 取れない時は10分おく（毎回待たない） */
  try {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + m[1] + '&longitude=' + m[2] +
      '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1';
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return fail();
    var j = JSON.parse(r.getContentText()), dl = j.daily || {}, cu = j.current || {};
    if (!dl.temperature_2m_max || !dl.temperature_2m_min) return fail();
    var w = { place: place, code: dl.weather_code ? dl.weather_code[0] : cu.weather_code, now: Math.round(cu.temperature_2m),
      max: Math.round(dl.temperature_2m_max[0]), min: Math.round(dl.temperature_2m_min[0]), pop: dl.precipitation_probability_max ? dl.precipitation_probability_max[0] : null };
    cache.put(key, JSON.stringify(w), 3600);
    return w;
  } catch (e) { return fail(); }
}

/* 画面シート：見出し・表示・順番。行が無いキーは初期値 */
/* 見る人：空・みんな・知らない名前なら2人とも。人1/人2/呼び名/パパ・ママならその人だけ */
function viewerOf(v) {
  v = text(v);
  if (!v || v === 'みんな' || v === '2人') return '';
  var ps = people().list;
  if (v === '人1') return ps[0].name;
  if (v === '人2') return ps[1].name;
  for (var i = 0; i < ps.length; i++) if (ps[i].alias.indexOf(v) >= 0) return ps[i].name;
  return '';
}

function screenRows() {
  var byKey = {};
  rowsOf('画面').forEach(function (r) { var k = text(r['キー']); if (k) byKey[k] = r; });
  return SCREEN_ROWS.map(function (d, i) {
    var r = byKey[d[0]];
    var num = r && r['順番'] !== '' && r['順番'] != null && !isNaN(Number(r['順番'])) ? Number(r['順番']) : d[4];
    var has = function (h) { return r && r[h] !== '' && r[h] != null; };
    var eve = has('夜の順番') && !isNaN(Number(r['夜の順番'])) ? Number(r['夜の順番']) : d[5];
    var morn = has('朝の順番') && !isNaN(Number(r['朝の順番'])) ? Number(r['朝の順番']) : d[10];
    var viewer = has('見る人') ? text(r['見る人']) : (r && ('見る人' in r) ? '' : d[7]);
    return {
      key: d[0], title: r && text(r['見出し']) || d[1],
      all: has('みんなのタブ') ? truthy(r['みんなのタブ']) : d[2],
      person: has('人のタブ') ? truthy(r['人のタブ']) : d[3],
      order: num + i / 100, evening: eve + i / 100, morning: morn + i / 100,
      travel: has('旅行中') ? truthy(r['旅行中']) : d[6],
      tab: has('下のタブ') ? text(r['下のタブ']) : d[9],
      viewer: viewerOf(viewer)
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
    byLabel[label].items.push([idOf(r, SHOP_KEYS), text(r['品名']), text(r['量'])]);
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

/* 買うかも：これまでの買い物リストから、くり返し買っている物を出す。
 * 何週ごとに買っているかを見て、そろそろの物を先に。今のリストにある物は出さない */
function shopSuggest(shop) {
  var now = {};
  shop.groups.forEach(function (g) { g.items.forEach(function (x) { now[normName(x[1])] = 1; }); });
  var byName = {};
  rowsOf('買い物').forEach(function (r) {
    var name = text(r['品名']), w = normDate(r['週']);
    if (!name || !w || w > shop.week) return;
    var k = normName(name);
    var e = byName[k] || (byName[k] = { name: name, weeks: {}, qty: '', cat: '' });
    e.weeks[w] = 1; e.qty = text(r['量']) || e.qty; e.cat = text(r['分類']) || e.cat; e.name = name;
  });
  var base = parseYmd(shop.week).getTime(), list = [];
  Object.keys(byName).forEach(function (k) {
    if (now[k]) return;
    var e = byName[k], ws = Object.keys(e.weeks).sort(), n = ws.length;
    var last = parseYmd(ws[n - 1]).getTime(), since = Math.round((base - last) / 864e5);
    var gap = n >= 2 ? (last - parseYmd(ws[0]).getTime()) / 864e5 / (n - 1) : 0;
    var due = n >= 2 && since >= gap * 0.9;
    var weeksGap = Math.max(1, Math.round(gap / 7));
    list.push({
      name: e.name, qty: e.qty, cat: e.cat, n: n, due: due,
      note: due ? 'そろそろ（' + weeksGap + '週ごと）' : (n >= 2 ? n + '回買った' : (since <= 7 ? '先週買った' : Math.round(since / 7) + '週前に買った')),
      score: (due ? 1000 : 0) + n * 10 - since / 7
    });
  });
  return list.sort(function (a, b) { return b.score - a.score; }).slice(0, 12)
    .map(function (x) { return { name: x.name, qty: x.qty, cat: x.cat, note: x.note, due: x.due }; });
}
function normName(s) { return String(s || '').replace(/[\s　]/g, '').toLowerCase(); }

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
function snapGet(today, v) {
  var s = bigGet('b_' + today + '_' + (v || ver()));
  return s ? JSON.parse(s) : null;
}
function snapPut(today, data, v) {
  var copy = {}; Object.keys(data).forEach(function (k) { if (k !== 'me') copy[k] = data[k]; });
  bigPut('b_' + today + '_' + (v || ver()), JSON.stringify(copy), SNAP_SECONDS);
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
/* 1件100KB（バイト）まで。日本語は1文字最大3バイトなので3万文字ずつ */
function bigPut(key, str, seconds) {
  var size = 30000, count = Math.ceil(str.length / size) || 1, put = {};
  if (count > 40) return;
  for (var j = 0; j < count; j++) put[key + '_' + j] = str.slice(j * size, (j + 1) * size);
  put[key + '_n'] = String(count);
  try { CacheService.getScriptCache().putAll(put, seconds); } catch (e) {}
}

/* ================= 写真 ================= */

function photoQuery() {
  var folderId = settings()['写真フォルダID'];
  return folderId ? "'" + folderId.replace(/'/g, '') + "' in parents and (mimeType contains 'image/' or mimeType contains 'video/') and trashed = false" : '';
}
function videoLimit() { var n = Number(settings()['動画の上限MB']); return (n > 0 ? Math.min(n, 15) : 10) * 1048576; }

/* 写真と動画の一覧（idだけ。軽い）。動画は大きさも見る */
function photoList() {
  var q = photoQuery();
  if (!q) return [];
  try {
    var lim = videoLimit();
    return (Drive.Files.list({ q: q, pageSize: 10, orderBy: 'createdTime desc', fields: 'files(id,modifiedTime,mimeType,size)' }).files || [])
      .map(function (f) {
        var v = /^video\//.test(f.mimeType || '');
        return { id: f.id, v: f.modifiedTime, video: v, big: v && Number(f.size || 0) > lim };
      });
  } catch (err) { console.error(err); return []; }
}

/* 動画の中身（写真フォルダの中のものだけ、上限まで） */
function videoData(id) {
  var folderId = settings()['写真フォルダID'];
  if (!folderId || !id) return { ok: false, code: 'bad_request' };
  var f;
  try { f = Drive.Files.get(String(id), { fields: 'id,parents,mimeType,size' }); } catch (err) { return { ok: false, code: 'not_found' }; }
  if ((f.parents || []).indexOf(folderId) < 0 || !/^video\//.test(f.mimeType || '')) return { ok: false, code: 'not_found' };
  if (Number(f.size || 0) > videoLimit()) return { ok: false, code: 'too_big' };
  var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id) + '?alt=media', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return { ok: false, code: 'fetch_failed' };
  return { ok: true, type: f.mimeType, data: Utilities.base64Encode(r.getContent()) };
}

/* 写真をまとめて返す（写真フォルダの中のものだけ）。覚えている分はすぐ返し、足りない分は並行して取る */
function photosBatch(ids) {
  var q = photoQuery();
  if (!q) return { ok: true, photos: {} };
  var want = {};
  (ids || []).forEach(function (id) { want[String(id)] = 1; });
  var files;
  try { files = Drive.Files.list({ q: q, pageSize: 10, orderBy: 'createdTime desc', fields: 'files(id,thumbnailLink)' }).files || []; }
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
  var today = ymd(new Date()), v = ver();
  if (!snapGet(today, v)) snapPut(today, buildBoot(today), v);
  cleanSessions();
}

/* 期限が切れたログインの行を消す */
function cleanSessions() {
  var rows = rowsOf('_sessions'), sh = sheet('_sessions'), now = Date.now();
  for (var i = rows.length - 1; i >= 0; i--) if (rows[i].hash && new Date(rows[i]['期限']).getTime() < now) sh.deleteRow(rows[i]._row);
  delete _tables['_sessions'];
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

/* 献立：日付ごとに1つ。材料は「品名:量」を「 / 」でつなぐ（シートで手で書く形と同じ） */
function saveMenu(m) {
  var date = normDate(m.date), dish = String(m.dish || '').slice(0, 80).trim();
  if (!date || !dish) return { ok: false, code: 'bad_request' };
  var ings = (m.ingredients || []).slice(0, 40).map(function (x) {
    var n = String(x.name || '').replace(/[:：\/／\n]/g, ' ').slice(0, 40).trim(), q = String(x.qty || '').replace(/[:：\/／\n]/g, ' ').slice(0, 20).trim();
    return n ? n + (q ? ':' + q : '') : '';
  }).filter(String);
  var obj = { '日付': date, '料理': dish, 'ホットクック': !!m.hotcook, 'メモ': String(m.note || '').slice(0, 300).trim(), '材料': ings.join(' / '), '作り方': String(m.how || '').slice(0, 3000).trim() };
  var rows = rowsOf('献立');
  for (var i = 0; i < rows.length; i++) if (normDate(rows[i]['日付']) === date) { setCells('献立', rows[i]._row, obj); return { ok: true }; }
  appendObj('献立', obj);
  return { ok: true };
}
function deleteMenu(date) {
  var d = normDate(date), rows = rowsOf('献立'), n = 0;
  if (!d) return { ok: false, code: 'bad_request' };
  for (var i = rows.length - 1; i >= 0; i--) if (normDate(rows[i]['日付']) === d) { sheet('献立').deleteRow(rows[i]._row); n++; }
  delete _tables['献立'];
  return n ? { ok: true } : { ok: false, code: 'not_found' };
}

/* 返信：話題・相談・日記・お出かけなどへの、ふたりのやりとり。対象は「種類:id」 */
function addReply(r, me) {
  var body = String(r.text || '').slice(0, 1000).trim(), target = String(r.target || '').slice(0, 80);
  if (!body || !r.id || !/^(topics|decide|diary|weekend|deadline|news):\S{1,60}$/.test(target)) return { ok: false, code: 'bad_request' };
  appendObj('返信', { id: String(r.id), '対象': target, '誰': me.who, '日時': new Date(), '本文': body });
  return { ok: true };
}

var DUTY_KEYS = ['時刻', 'やること'];
var SHOP_KEYS = ['週', '分類', '品名'];
var TOPIC_KEYS = ['見出し', 'URL'];

/* 話題：旅のしおりなどのリンク。https だけ受け付ける */
function saveTopic(t) {
  var title = String(t.title || '').slice(0, 100).trim(), url = String(t.url || '').trim();
  if (!title || !t.id || (url && !/^https:\/\/[^\s]+$/.test(url))) return { ok: false, code: 'bad_request' };
  var obj = { id: String(t.id), '見出し': title, 'URL': url, '説明': String(t.note || '').slice(0, 200).trim() };
  var r = findById('話題', t.id, TOPIC_KEYS);
  if (r) setCells('話題', r._row, obj);
  else {
    obj['日付'] = ymd(new Date()); obj['表示'] = true; appendObj('話題', obj);
    var t2 = table('話題');
    if (t2.col['表示'] != null) t2.sh.getRange(t2.sh.getLastRow(), t2.col['表示'] + 1).insertCheckboxes().setValue(true);
  }
  return { ok: true };
}

/* idで行を探す（idの列が空の行は、中身から決まるidで探す） */
function findById(name, id, keys) {
  var rows = rowsOf(name);
  for (var i = 0; i < rows.length; i++) if (idOf(rows[i], keys) === String(id)) return rows[i];
  return null;
}
function deleteById(name, id, keys) {
  var r = findById(name, id, keys);
  if (!r) return { ok: false, code: 'not_found' };
  sheet(name).deleteRow(r._row); delete _tables[name];
  return { ok: true };
}

/* 担当を足す・直す。date があれば「その日だけ」、なければ rule（毎日・平日・土日・月水金など）でくり返す */
function saveDuty(d) {
  var task = String(d.task || '').slice(0, 100).trim();
  if (!task || !d.id) return { ok: false, code: 'bad_request' };
  var obj = { id: String(d.id), '時刻': normTime(d.time) || '', 'やること': task, '担当': whoOf(d.who), '曜日': d.date ? '' : (String(d.rule || '毎日').trim() || '毎日'), '日付': normDate(d.date) || '' };
  var r = findById('担当', d.id, DUTY_KEYS);
  if (r) setCells('担当', r._row, obj); else appendObj('担当', obj);
  return { ok: true };
}

/* 買い物を足す・直す（週は、アプリに出ているリストの週） */
function saveShop(x) {
  var name = String(x.name || '').slice(0, 60).trim();
  if (!name || !x.id) return { ok: false, code: 'bad_request' };
  var r = findById('買い物', x.id, SHOP_KEYS);
  var obj = { id: String(x.id), '品名': name, '量': String(x.qty || '').slice(0, 30).trim(), '分類': String(x.cat || '').slice(0, 30).trim() || 'その他' };
  if (r) setCells('買い物', r._row, obj);
  else { obj['週'] = normDate(x.week) || ymd(new Date()); appendObj('買い物', obj); }
  return { ok: true };
}

/* ふたりで決めること */
function saveDecision(x) {
  var q = String(x.q || '').slice(0, 200).trim();
  if (!q || !x.id) return { ok: false, code: 'bad_request' };
  var opts = (x.options || []).map(function (o) { return String(o).slice(0, 60).trim(); }).filter(String);
  var obj = { id: String(x.id), '問い': q, '選択肢': opts.join('\n'), '期限': normDate(x.due), 'メモ': String(x.note || '').slice(0, 300) };
  var r = findById('相談', x.id, ['問い']);
  if (r) {
    /* 問いか選択肢が変わったら、2人の答えを消して相談中に戻す（違う問いへの答えで決まりにならないように） */
    if (text(r['問い']) !== q || splitOptions(r['選択肢']).join('\n') !== opts.join('\n')) { obj['人1の答え'] = ''; obj['人2の答え'] = ''; obj['状態'] = '相談中'; obj['決まったこと'] = ''; }
    setCells('相談', r._row, obj);
  } else { obj['状態'] = '相談中'; obj['作成'] = ymd(new Date()); appendObj('相談', obj); }
  return { ok: true };
}
function personCol(me) { return people().list[0].name === me.who ? '人1' : '人2'; }
function answerDecision(id, answer, me) {
  var r = findById('相談', id, ['問い']);
  if (!r) return { ok: false, code: 'not_found' };
  if (text(r['状態']) === '決まった') return { ok: false, code: 'already_decided' };   // 変えたい時は「相談に戻す」から
  var o = {}; o[personCol(me) + 'の答え'] = String(answer || '').slice(0, 60);
  setCells('相談', r._row, o);
  return { ok: true };
}
/* 決まったにするのは、2人の答えがそろっている時だけ（片方の判断で決定扱いにしない） */
function decide(id, decided, reopen) {
  var r = findById('相談', id, ['問い']);
  if (!r) return { ok: false, code: 'not_found' };
  if (reopen) { setCells('相談', r._row, { '状態': '相談中', '決まったこと': '' }); return { ok: true }; }
  var a1 = text(r['人1の答え']), a2 = text(r['人2の答え']);
  if (!a1 || a1 !== a2 || a1 === '話したい') return { ok: false, code: 'not_agreed' };
  setCells('相談', r._row, { '状態': '決まった', '決まったこと': a1 });
  return { ok: true };
}

function saveDeadline(x) {
  var what = String(x.what || '').slice(0, 120).trim();
  if (!what || !x.id) return { ok: false, code: 'bad_request' };
  var obj = { id: String(x.id), '内容': what, '期限': normDate(x.due), '担当': whoOf(x.who), 'URL': safeUrl(x.url), 'メモ': String(x.note || '').slice(0, 300) };
  var r = findById('期限', x.id, ['内容', '期限']);
  if (r) setCells('期限', r._row, obj); else { obj['済'] = false; appendObj('期限', obj); }
  return { ok: true };
}

function saveOuting(x) {
  var name = String(x.name || '').slice(0, 80).trim();
  if (!name || !x.id) return { ok: false, code: 'bad_request' };
  var obj = { id: String(x.id), '名前': name, '種類': String(x.kind || '').slice(0, 20), '日付': normDate(x.date), '場所': String(x.place || '').slice(0, 80), 'URL': safeUrl(x.url), 'メモ': String(x.note || '').slice(0, 300) };
  var r = findById('お出かけ', x.id, ['名前']);
  if (r) setCells('お出かけ', r._row, obj); else { obj['状態'] = '候補'; appendObj('お出かけ', obj); }
  return { ok: true };
}
function likeOuting(id, like, me) {
  var r = findById('お出かけ', id, ['名前']);
  if (!r) return { ok: false, code: 'not_found' };
  var o = {}; o[personCol(me)] = like; setCells('お出かけ', r._row, o);
  return { ok: true };
}
/* 行く日を決める（予定シートにも入れる。カレンダーを使っている時は予定シートには入れない） */
function planOuting(id, date, me) {
  var r = findById('お出かけ', id, ['名前']);
  if (!r) return { ok: false, code: 'not_found' };
  var d = normDate(date), label = 'おでかけ：' + text(r['名前']);
  if (d && !(truthy(r['人1']) && truthy(r['人2']))) return { ok: false, code: 'not_both' };   // 2人とも「行きたい」の時だけ決める
  setCells('お出かけ', r._row, { '状態': d ? '決めた' : '候補', '行く日': d });
  /* 前に入れた予定の行は消す（日を変えた時・やめた時に、予定が残ったり重なったりしないように） */
  var plans = rowsOf('予定');
  for (var i = plans.length - 1; i >= 0; i--) if (text(plans[i]['内容']) === label) sheet('予定').deleteRow(plans[i]._row);
  delete _tables['予定'];
  if (d && !settings()['カレンダーID']) appendObj('予定', { '日付': d, '時刻': '', '内容': label, '誰': '家族' });
  return { ok: true };
}

/* 使われ方：回数だけ（書いた文章は残さない）。日付×人×項目で足し込む */
function logUsage(counts, date, me, batch) {
  var d = normDate(date) || ymd(new Date());
  var keys = Object.keys(counts || {}).filter(function (k) { return /^[a-z]+:[A-Za-z0-9_\-]{1,40}$/.test(k) && Number(counts[k]) > 0; }).slice(0, 80);
  if (!keys.length) return { ok: true };
  var cache = CacheService.getScriptCache(), bk = batch ? 'u_' + String(batch).replace(/[^\w]/g, '').slice(0, 40) : '';
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (bk && cache.get(bk)) return { ok: true, dup: true };   // 同じ送信が2回届いても1回だけ数える（鍵の中で確かめる）
    _tables = {};
    var t = ensureCols('使われ方', SHEETS['使われ方']), at = {};
    t.rows.forEach(function (r) { if (normDate(r['日付']) === d && whoOf(r['誰']) === me.who) at[text(r['項目'])] = r; });
    var add = [];
    keys.forEach(function (k) {
      var n = Math.min(500, Math.floor(Number(counts[k])));
      if (at[k]) t.sh.getRange(at[k]._row, t.col['回数'] + 1).setValue(Number(at[k]['回数'] || 0) + n);
      else add.push({ '日付': d, '誰': me.who, '項目': k, '回数': n });
    });
    appendRows('使われ方', add);
    if (bk) cache.put(bk, '1', 21600);
  } finally { lock.releaseLock(); }
  return { ok: true };
}

/* 献立の材料をまとめて買い物リストへ（1回で書く） */
function addShopMany(items) {
  var add = items.slice(0, 40).map(function (x) {
    var name = String(x.name || '').slice(0, 60).trim();
    return name && x.id ? { id: String(x.id), '週': normDate(x.week) || ymd(new Date()), '分類': String(x.cat || '').slice(0, 30).trim() || 'その他', '品名': name, '量': String(x.qty || '').slice(0, 30).trim() } : null;
  }).filter(Boolean);
  appendRows('買い物', add);
  return { ok: true };
}

/* 毎週金曜の夜（setupで予約）：1週間の使われ方を「ふりかえり」に1行まとめる */
function weeklyReview() {
  _tables = {};
  var now = new Date(), from = ymd(new Date(now.getTime() - 6 * 864e5)), to = ymd(now);
  var opens = {}, secs = {}, acts = {}, errs = 0;
  rowsOf('使われ方').forEach(function (r) {
    var d = normDate(r['日付']); if (!d || d < from || d > to) return;
    var k = text(r['項目']), n = Number(r['回数'] || 0), who = whoOf(r['誰']);
    if (k === 'open:app') opens[who] = (opens[who] || 0) + n;
    else if (k.indexOf('sec:') === 0) secs[k.slice(4)] = (secs[k.slice(4)] || 0) + n;
    else if (k.indexOf('act:') === 0) acts[k.slice(4)] = (acts[k.slice(4)] || 0) + n;
    else if (k.indexOf('err:') === 0) errs += n;
  });
  var top = function (o, n) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, n).map(function (k) { return k + ' ' + o[k]; }).join('、'); };
  var titles = {}; screenRows().forEach(function (x) { titles[x.key] = x.title; });
  var unseen = SCREEN_ROWS.map(function (x) { return x[0]; }).filter(function (k) { return !secs[k]; }).map(function (k) { return titles[k] || k; }).join('、');
  var open = rowsOf('要望').filter(function (r) { return text(r['状態']) !== '対応済み' && text(r['内容']); }).length;
  var secNamed = {}; Object.keys(secs).forEach(function (k) { secNamed[titles[k] || k] = secs[k]; });
  appendObj('ふりかえり', { '週': from + '〜' + to, '作成': new Date(), '開いた回数': Object.keys(opens).map(function (w) { return w + ' ' + opens[w]; }).join('、') || '0',
    'よく見たセクション': top(secNamed, 5), '見られていないセクション': unseen, 'よく使った操作': top(acts, 6), '未対応の要望': open, 'エラー': errs, '気づき': 'バックアップ：' + (PropertiesService.getScriptProperties().getProperty('backupLast') || 'まだ') });
}

/* 毎週日曜の朝（setupで予約）：シートを丸ごとコピーしてバックアップ。古いものは BACKUP_KEEP を超えたら消す */
function backupNow() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('backupFolder'), how = '';
  if (folderId) {
    try { if (Drive.Files.get(folderId, { fields: 'id,trashed' }).trashed) folderId = ''; }
    catch (e) { if (/not ?found|404/i.test(String(e && e.message))) folderId = ''; else throw e; }   // 見つからない時だけ作り直す
  }
  if (!folderId) {
    folderId = Drive.Files.create({ name: 'WAGAYA DB バックアップ', mimeType: 'application/vnd.google-apps.folder' }, null, { fields: 'id' }).id;
    props.setProperty('backupFolder', folderId);
  }
  var id = SpreadsheetApp.getActive().getId(), name = 'WAGAYA DB ' + ymd(new Date());
  try {
    Drive.Files.copy({ name: name, parents: [folderId] }, id, { fields: 'id' });
    how = 'コピー';
  } catch (e) {
    /* コピーできない権限の時は、Excel形式に書き出して置く（読み取りの権限で足りる） */
    var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=' + encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { props.setProperty('backupLast', ymd(new Date()) + ' 失敗（' + res.getResponseCode() + '）'); throw e; }
    Drive.Files.create({ name: name + '.xlsx', parents: [folderId] }, res.getBlob().setName(name + '.xlsx'), { fields: 'id' });
    how = 'Excel形式';
  }
  var files = Drive.Files.list({ q: "'" + folderId + "' in parents and trashed = false", orderBy: 'createdTime desc', fields: 'files(id)', pageSize: 50 }).files || [];
  files.slice(BACKUP_KEEP).forEach(function (f) { try { Drive.Files.update({ trashed: true }, f.id); } catch (e) {} });
  props.setProperty('backupLast', ymd(new Date()) + ' 成功（' + how + '）');
  return how;
}

/* 旅行の期間：「2027-08-10〜2027-08-15」「8/10～8/15」「8/10から8/15」などを読む。年が無ければ今年（終わりが前なら翌年） */
/* 旅行の期間：「2027-08-10〜2027-08-15」「8/10～8/15」「12/28〜1/3」「2027-08-10 - 2027-08-15」。
   年がない時は今日から見て決める（終わりが今日より前にならない年。年をまたぐ期間もそろえる） */
function tripRange(v, today) {
  var str = String(v || '').trim();
  var full = str.match(/^(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})\s*[-–—]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})$/);
  var parts = full ? [full[1], full[2]] : str.split(/\s*(?:〜|～|~|から|まで)\s*/).filter(String);
  if (parts.length < 2) return ['', ''];
  var a = normDate(parts[0]), b = normDate(parts[1]);
  if (!a || !b) return ['', ''];
  var ya = /^\d{4}/.test(parts[0].trim()), yb = /^\d{4}/.test(parts[1].trim());
  var setY = function (d, y) { return String(y) + d.slice(4); };
  today = today || ymd(new Date());
  if (!ya && !yb) {
    var y = Number(today.slice(0, 4));
    a = setY(a, y); b = setY(b, y);
    if (b < a) { if (b >= today) a = setY(a, y - 1); else b = setY(b, y + 1); }
    else if (b < today) { a = setY(a, y + 1); b = setY(b, y + 1); }
  } else if (ya && !yb) {
    b = setY(b, Number(a.slice(0, 4))); if (b < a) b = setY(b, Number(a.slice(0, 4)) + 1);
  } else if (!ya && yb) {
    a = setY(a, Number(b.slice(0, 4))); if (a > b) a = setY(a, Number(b.slice(0, 4)) - 1);
  }
  return [a, b];
}

/* 選択肢は1行に1つ（「、」や「12/29」の「/」では分けない）。前後に空白のある「 / 」も区切りとして読む */
function splitOptions(v) { return String(v || '').split(/\n| [\/／] /).map(function (x) { return x.trim(); }).filter(String); }
function splitList(v) { return String(v || '').split(/\s*[\/／、,\n]\s*/).map(function (x) { return x.trim(); }).filter(String); }

/* 要望・不具合のメモ（Claudeがあとで読んで直す） */
function addFeedback(f, me) {
  var body = String(f.text || '').slice(0, 2000).trim();
  if (!body) return { ok: false, code: 'bad_request' };
  appendObj('要望', { id: 'f' + Date.now().toString(36), '日時': new Date(), '誰': me.who, '内容': body, '画面': String(f.screen || '').slice(0, 300), '状態': '未対応', 'メモ': '' });
  return { ok: true };
}

/* ================= Muse（AIの手伝い）からの書き込み =================
 * 入口は doPost の action:'muse'。ログインの代わりに「鍵」で入る（鍵はメニュー「Muse用の鍵を作る」で人ごとに作り、
 * シートにはハッシュだけ残す。止める時は「_keys」の状態を「止める」に）。
 * できること：一覧を見る（list）と、足すこと（買い物・献立・担当・申し送り・要望・話題・相談・期限・お出かけ）、
 * 自分の鍵で足したものを24時間以内に取り消すこと（undo）。日記・写真・設定は読めない・書けない。
 * 書いたものは「Museの記録」に1行ずつ残す。 */

var MUSE_LOG = 'Museの記録';

function museCall(req) {
  var cache = CacheService.getScriptCache();
  var fk = 'mfail_' + Math.floor(Date.now() / 600000);
  if (Number(cache.get(fk) || 0) >= 30) return { ok: false, code: 'busy' };   // 違う鍵が続いたら10分止める
  var owner = keyOwner(String(req.key || ''));
  if (!owner) { cache.put(fk, String(Number(cache.get(fk) || 0) + 1), 900); return { ok: false, code: 'bad_key' }; }
  var rk = 'mrate_' + owner.hash.slice(0, 16) + '_' + Math.floor(Date.now() / 3600000);
  var n = Number(cache.get(rk) || 0) + 1; cache.put(rk, String(n), 3700);
  if (n > 200) return { ok: false, code: 'too_many', message: '1時間に200回までです' };
  var me = { who: owner.who, email: '' };
  var op = String(req.op || '');
  if (op === 'help') return { ok: true, me: me.who, ops: MUSE_HELP };
  if (op === 'list') return museList(me);
  var fn = MUSE_OPS[op];
  if (!fn) return { ok: false, code: 'unknown_op', ops: Object.keys(MUSE_HELP) };
  return withLock(function () {
    var r = fn(req, me) || { ok: true };
    if (r.ok) {
      appendRows(MUSE_LOG, (r.log || []).map(function (l) { return { '日時': new Date(), '誰': me.who, '操作': op, 'シート': l[0], 'id': l[1], '内容': String(l[2] || '').slice(0, 120) }; }));
      setCells('_keys', owner.row, { '最後に使った': new Date(), '回数': Number(owner.count || 0) + 1 });
      delete r.log;
    }
    return r;
  });
}

function keyOwner(key) {
  if (!/^wgk_[0-9a-f]{64}$/.test(key)) return null;
  var h = sha(key), rows = rowsOf('_keys');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].hash !== h) continue;
    if (text(rows[i]['状態']) !== '使う') return null;
    var who = whoOf(rows[i]['誰']);
    return who === '家族' ? null : { who: who, hash: h, row: rows[i]._row, count: rows[i]['回数'] };
  }
  return null;
}

function museId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function otherOf(who) { var ps = people().list; return ps[0].name === who ? ps[1].name : ps[0].name; }

/* 今の一覧（Museが重ならないように足したり、相談に使ったりする）。日記・写真・申し送りの他人宛ては出さない */
function museList(me) {
  var today = ymd(new Date()), v = ver();
  var D = snapGet(today, v);
  if (!D) { D = buildBoot(today); snapPut(today, D, v); }
  var items = [];
  (D.shop.groups || []).forEach(function (g) { g.items.forEach(function (it) { items.push({ name: it[1], qty: it[2], cat: g.label, bought: !!D.checked[it[0]] }); }); });
  return { ok: true, today: today, me: me.who, partner: otherOf(me.who),
    shop: { week: D.shop.week, categories: (D.shop.groups || []).map(function (g) { return g.label; }), items: items },
    menu: (D.menu || []).map(function (m) { return { date: m.date, dish: m.dish, ingredients: m.ingredients.map(function (x) { return x[0] + (x[1] ? ' ' + x[1] : ''); }) }; }),
    duties: (D.dutiesAll || []).map(function (d) { return { task: d.task, time: d.t == null ? '' : Math.floor(d.t / 60) + ':' + pad(d.t % 60), who: d.who, repeat: d.date ? '' : d.rule, date: d.date || '' }; }),
    plans: (D.plans || []).filter(function (p) { return p.date >= today; }),
    deadlines: (D.deadlines || []).filter(function (x) { return !x.done; }).map(function (x) { return { what: x.what, due: x.due, who: x.who }; }),
    decisions: (D.decisions || []).filter(function (x) { return x.state !== '決まった'; }).map(function (x) { return { q: x.q, options: x.options, due: x.due }; }),
    outings: (D.outings || []).map(function (x) { return { name: x.name, date: x.date, place: x.place, state: x.state, go: x.go }; }),
    notesForMe: (D.notes || []).filter(function (x) { return x.to === me.who && !x.read; }).map(function (x) { return { from: x.from, text: x.text }; })
  };
}

/* 今アプリに出ている買い物リストの週と、まだ買っていない品名 */
function shopNow() {
  var t = parseYmd(ymd(new Date()));
  var shop = shopFor(new Date(t.getFullYear(), t.getMonth(), t.getDate() - t.getDay()));
  var bought = {};
  rowsOf('チェック').forEach(function (r) { if (r['種類'] === '買い物' && truthy(r['済']) && normDate(r['日付']) === shop.week) bought[String(r['対象ID'])] = true; });
  var have = {};
  shop.groups.forEach(function (g) { g.items.forEach(function (it) { if (!bought[it[0]]) have[normName(it[1])] = true; }); });
  return { week: shop.week, firstCat: shop.groups[0] ? shop.groups[0].label : 'その他', have: have };
}
function addToShop(list, cat) {
  var s = shopNow(), add = [], log = [], skipped = [];
  (list || []).slice(0, 40).forEach(function (x) {
    var name = String(x.name || '').slice(0, 60).trim();
    if (!name) return;
    if (s.have[normName(name)]) { skipped.push(name); return; }
    s.have[normName(name)] = true;
    var id = museId('s');
    add.push({ id: id, '週': s.week, '分類': String(x.cat || cat || '').slice(0, 30).trim() || s.firstCat, '品名': name, '量': String(x.qty || '').slice(0, 30).trim() });
    log.push(['買い物', id, name]);
  });
  appendRows('買い物', add);
  return { added: add.map(function (a) { return a['品名']; }), skipped: skipped, log: log };
}

var MUSE_HELP = {
  list: '今の一覧を見る（買い物・献立・担当・予定・期限・相談・お出かけ・自分宛ての申し送り）',
  'shop.add': 'items:[{name, qty?, cat?}] 買い物リストに足す（まだ買っていない同じ品名は足さない）',
  'menu.add': 'date?(yyyy-mm-dd。省くと今日から7日で献立が空いている最初の日), dish, ingredients:[{name, qty?}], how?, note?, url?(https), hotcook?(true/false), toShop?(true＝材料のうちリストに無い物を買い物に足す), replace?(true＝その日の献立を置きかえる)',
  'duty.add': 'task, time?(H:mm), who?(呼び名・家族。省くと自分), date?(その日だけ) か repeat?(毎日・平日・土日・月水金 など。省くと毎日)',
  'note.add': 'text, to?(省くと相手) 相手への申し送り',
  'feedback.add': 'text, screen? アプリの要望・不具合（「ここ直しといて」）',
  'topic.add': 'title, url?(https), note? いま話している資料へのリンク',
  'decision.add': 'q, options?:[..], due?, note? ふたりで決めることに出す（答えと決定はアプリで2人がする）',
  'deadline.add': 'what, due?, who?, url?, note? 期限があるもの',
  'outing.add': 'name, kind?, date?, place?, url?, note? お出かけの候補',
  undo: 'id（足した時に返ったid）自分の鍵で足したものを24時間以内なら取り消す'
};

var MUSE_OPS = {
  'shop.add': function (q) {
    var r = addToShop(q.items || (q.name ? [{ name: q.name, qty: q.qty, cat: q.cat }] : []), q.cat);
    if (!r.added.length && !r.skipped.length) return { ok: false, code: 'bad_request' };
    return { ok: true, added: r.added, skipped: r.skipped, ids: r.log.map(function (l) { return l[1]; }), log: r.log };
  },
  'menu.add': function (q) {
    var dish = String(q.dish || '').slice(0, 80).trim();
    if (!dish) return { ok: false, code: 'bad_request' };
    var used = {};
    rowsOf('献立').forEach(function (r) { var d = normDate(r['日付']); if (d && text(r['料理'])) used[d] = r; });
    var date = normDate(q.date);
    if (!date) {
      for (var i = 0; i < 7 && !date; i++) { var d0 = new Date(); d0.setDate(d0.getDate() + i); if (!used[ymd(d0)]) date = ymd(d0); }
      if (!date) return { ok: false, code: 'no_free_day', message: 'この7日は献立が埋まっています。date と replace:true で置きかえてください' };
    }
    if (used[date] && !q.replace) return { ok: false, code: 'taken', message: date + 'はすでに「' + text(used[date]['料理']) + '」です。置きかえるなら replace:true' };
    var ings = (q.ingredients || []).slice(0, 40).map(function (x) { return { name: String(x.name || '').replace(/[:：\/／\n]/g, ' ').slice(0, 40).trim(), qty: String(x.qty || '').replace(/[:：\/／\n]/g, ' ').slice(0, 20).trim() }; }).filter(function (x) { return x.name; });
    var url = safeUrl(q.url), note = String(q.note || '').slice(0, 200).trim();
    var obj = { '日付': date, '料理': dish, 'ホットクック': !!q.hotcook, 'メモ': (note + (url ? (note ? ' ' : '') + url : '')).trim(),
      '材料': ings.map(function (x) { return x.name + (x.qty ? ':' + x.qty : ''); }).join(' / '), '作り方': String(q.how || '').slice(0, 1500).trim() };
    if (used[date]) setCells('献立', used[date]._row, obj); else appendObj('献立', obj);
    var log = [['献立', 'menu:' + date, dish]], res = { ok: true, date: date, dish: dish, replaced: !!used[date] };
    if (q.toShop && ings.length) { var s = addToShop(ings); res.shopAdded = s.added; res.shopSkipped = s.skipped; log = log.concat(s.log); }
    res.ids = log.map(function (l) { return l[1]; }); res.log = log;
    return res;
  },
  'duty.add': function (q, me) {
    var id = museId('d');
    var r = saveDuty({ id: id, task: q.task, time: q.time, who: q.who || me.who, date: q.date, rule: q.repeat || q.rule });
    return r.ok ? { ok: true, id: id, log: [['担当', id, q.task]] } : r;
  },
  'note.add': function (q, me) {
    var id = museId('n');
    var r = addNote({ id: id, text: q.text, to: q.to || otherOf(me.who) }, me);
    return r.ok ? { ok: true, id: id, log: [['申し送り', id, q.text]] } : r;
  },
  'feedback.add': function (q, me) {
    var r = addFeedback({ text: q.text, screen: 'Museから' + (q.screen ? ' / ' + q.screen : '') }, me);
    return r.ok ? { ok: true, log: [['要望', '', q.text]] } : r;
  },
  'topic.add': function (q) {
    var id = museId('t');
    var r = saveTopic({ id: id, title: q.title, url: q.url, note: q.note });
    return r.ok ? { ok: true, id: id, log: [['話題', id, q.title]] } : r;
  },
  'decision.add': function (q) {
    var id = museId('q');
    var r = saveDecision({ id: id, q: q.q, options: q.options || [], due: q.due, note: q.note });
    return r.ok ? { ok: true, id: id, log: [['相談', id, q.q]] } : r;
  },
  'deadline.add': function (q, me) {
    var id = museId('k');
    var r = saveDeadline({ id: id, what: q.what, due: q.due, who: q.who || me.who, url: q.url, note: q.note });
    return r.ok ? { ok: true, id: id, log: [['期限', id, q.what]] } : r;
  },
  'outing.add': function (q) {
    var id = museId('o');
    var r = saveOuting({ id: id, name: q.name, kind: q.kind, date: q.date, place: q.place, url: q.url, note: q.note });
    return r.ok ? { ok: true, id: id, log: [['お出かけ', id, q.name]] } : r;
  },
  undo: function (q, me) {
    var id = String(q.id || ''), since = Date.now() - 864e5, hit = null;
    if (!id) return { ok: false, code: 'bad_request' };
    rowsOf(MUSE_LOG).forEach(function (r) { if (text(r.id) === id && whoOf(r['誰']) === me.who && new Date(r['日時']).getTime() >= since && text(r['操作']) !== 'undo') hit = r; });
    if (!hit) return { ok: false, code: 'not_found', message: '自分の鍵で24時間以内に足したものだけ取り消せます' };
    var name = text(hit['シート']), rows;
    if (name === '献立') {
      var date = id.replace(/^menu:/, '');
      rows = rowsOf('献立');
      for (var i = rows.length - 1; i >= 0; i--) if (normDate(rows[i]['日付']) === date && text(rows[i]['料理']) === text(hit['内容'])) { sheet('献立').deleteRow(rows[i]._row); delete _tables['献立']; return { ok: true, log: [[name, id, '取り消し']] }; }
      return { ok: false, code: 'not_found' };
    }
    rows = rowsOf(name);
    for (var j = rows.length - 1; j >= 0; j--) if (String(rows[j].id) === id) { sheet(name).deleteRow(rows[j]._row); delete _tables[name]; return { ok: true, log: [[name, id, '取り消し']] }; }
    return { ok: false, code: 'not_found' };
  }
};

/* メニュー「Muse用の鍵を作る」：鍵はこの画面で1回だけ見せる。シートにはハッシュだけ */
function museNewKey() {
  var ui = SpreadsheetApp.getUi(), ps = people().list;
  var r = ui.prompt('Muse用の鍵を作る', 'だれのMuseに渡す鍵ですか？（' + ps[0].name + ' か ' + ps[1].name + '）', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var who = whoOf(r.getResponseText());
  if (who === '家族') { ui.alert('呼び名が見つかりません。' + ps[0].name + ' か ' + ps[1].name + ' と入れてください。'); return; }
  _tables = {};
  if (!sheet('_keys')) setup();
  var key = 'wgk_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  appendObj('_keys', { hash: sha(key), '誰': who, '作成': new Date(), '状態': '使う', '最後に使った': '', '回数': 0 });
  var html = '<div style="font:14px sans-serif;line-height:1.6">' + who + 'のMuseに、この鍵を直接わたしてください。<b>この画面を閉じると二度と出ません。</b>メールやメモには残さないでください。' +
    '<input id="k" readonly value="' + key + '" style="width:100%;margin:10px 0;padding:8px;font:13px monospace" onclick="this.select()">' +
    '<button onclick="var k=document.getElementById(\'k\');k.select();document.execCommand(\'copy\');this.textContent=\'コピーしました\'">コピー</button>' +
    '<p style="color:#666">止める時は「_keys」シートの状態を「止める」に。なくした時は止めて、作り直します。</p></div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(560).setHeight(250), 'Muse用の鍵（' + who + '）');
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
/* 文字はそのまま文字として入れる（「1/2」が日付に、「-」「=」で始まる文が数式に化けないように） */
function asCell(v) { return typeof v === 'string' && v !== '' ? "'" + v : v; }

/* 書き込む列が見出しに無ければ、右はしに足す（列を消してしまっても、書いた値が消えないように） */
function ensureCols(name, keys) {
  var t = table(name);
  if (!t.head.length) return t;
  var add = keys.filter(function (k) { return !(k in t.col) && SHEETS[name] && SHEETS[name].indexOf(k) >= 0; });
  if (!add.length) return t;
  t.sh.getRange(1, t.head.length + 1, 1, add.length).setValues([add]).setFontWeight('bold');
  delete _tables[name];
  return table(name);
}
function setCells(name, rowNum, obj) {
  var t = ensureCols(name, Object.keys(obj));
  Object.keys(obj).forEach(function (k) { if (t.col[k] != null) t.sh.getRange(rowNum, t.col[k] + 1).setValue(asCell(obj[k])); });
  delete _tables[name];
}
/* 何行かをまとめて下に足す（1回で書く） */
function appendRows(name, objs) {
  if (!objs || !objs.length) return;
  var keys = {}; objs.forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
  var t = ensureCols(name, Object.keys(keys));
  var head = t.head.length ? t.head : SHEETS[name];
  var vals = objs.map(function (o) { return head.map(function (h) { return h in o ? asCell(o[h]) : ''; }); });
  t.sh.getRange(t.sh.getLastRow() + 1, 1, vals.length, head.length).setValues(vals);
  delete _tables[name];
}
function appendObj(name, obj) {
  var t = ensureCols(name, Object.keys(obj));
  var head = t.head.length ? t.head : SHEETS[name];
  t.sh.appendRow(head.map(function (h) { return h in obj ? asCell(obj[h]) : ''; }));
  delete _tables[name];
}

/* idの列が空の行にも、中身から決まったidを付ける（中身を変えるとidも変わる） */
function idOf(r, keys) {
  if (r.id !== '' && r.id != null) return String(r.id);
  return 'r' + sha(keys.map(function (k) { return text(r[k]); }).join('|')).slice(0, 10);
}

function safeUrl(v) { var u = text(v); return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''; }
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
/* 設定の時刻：行が無ければ初期値、空なら null（その並びを使わない） */
function timeOrNull(v, dflt) { if (v === undefined) return dflt; return normTime(v) ? minutes(v) : null; }
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
  var newCols = [];
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
    if (name === '画面') newCols = missing;
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

  // 画面：無いキーだけ足す。今回足された列（夜の順番・旅行中・見る人・下のタブ）は、空の欄に初期値を入れる
  var scr = table('画面'), keys = {};
  scr.rows.forEach(function (r) { keys[text(r['キー'])] = 1; });
  SCREEN_ROWS.forEach(function (row) {
    if (keys[row[0]]) return;
    appendObj('画面', { 'キー': row[0], '見出し': row[1], 'みんなのタブ': row[2], '人のタブ': row[3], '順番': row[4], '夜の順番': row[5], '旅行中': row[6], '見る人': row[7], '説明': row[8], '下のタブ': row[9], '朝の順番': row[10] });
  });
  _tables = {};
  scr = table('画面');
  var def = {}; SCREEN_ROWS.forEach(function (row) { def[row[0]] = row; });
  scr.rows.forEach(function (r) {
    var d = def[text(r['キー'])]; if (!d) return;
    var o = {};
    if (newCols.indexOf('夜の順番') >= 0 && (r['夜の順番'] === '' || r['夜の順番'] == null)) o['夜の順番'] = d[5];
    if (newCols.indexOf('旅行中') >= 0 && (r['旅行中'] === '' || r['旅行中'] == null)) o['旅行中'] = d[6];
    if (newCols.indexOf('見る人') >= 0 && d[7] && (r['見る人'] === '' || r['見る人'] == null)) o['見る人'] = d[7];
    if (newCols.indexOf('下のタブ') >= 0 && (r['下のタブ'] === '' || r['下のタブ'] == null)) o['下のタブ'] = d[9];
    if (newCols.indexOf('朝の順番') >= 0 && (r['朝の順番'] === '' || r['朝の順番'] == null)) o['朝の順番'] = d[10];
    if (Object.keys(o).length) setCells('画面', r._row, o);
  });
  _tables = {};
  scr = table('画面');
  ['みんなのタブ', '人のタブ', '旅行中'].forEach(function (h) {
    var c = scr.col[h];
    if (c != null && scr.rows.length) scr.sh.getRange(2, c + 1, scr.rows.length, 1).insertCheckboxes();
  });

  var tp = table('話題');
  if (tp.col['表示'] != null && tp.rows.length) tp.sh.getRange(2, tp.col['表示'] + 1, tp.rows.length, 1).insertCheckboxes();

  var trig = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (trig.indexOf('warmPhotos') < 0) ScriptApp.newTrigger('warmPhotos').timeBased().everyHours(1).create();
  if (trig.indexOf('weeklyReview') < 0) ScriptApp.newTrigger('weeklyReview').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(23).create();
  if (trig.indexOf('backupNow') < 0) ScriptApp.newTrigger('backupNow').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  var first = ss.getSheets()[0];
  if (first.getName() === 'シート1' && first.getLastRow() === 0) ss.deleteSheet(first);
  bump();
  try { ss.toast('シートを整えました。「設定」と「画面」で呼び名・見出し・表示を変えられます。', 'わが家', 6); } catch (e) {}
}

/* 権限の許可ページのURLを実行ログに出す（ポップアップでアカウントが切り替わらない時に、同じタブで開くため） */
function authUrl() {
  var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
  Logger.log(info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED ? info.getAuthorizationUrl() : '権限はそろっています');
}
