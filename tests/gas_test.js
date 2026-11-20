// GAS の Code.gs を Node で動かすテスト（Google のサービスはまねる）
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const code = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '../gas/Code.gs'), 'utf8');

function fmt(d, tz, f) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  if (f === 'yyyy-MM-dd') return `${g('year')}-${g('month')}-${g('day')}`;
  if (f === 'H:mm') return `${Number(g('hour')) % 24}:${g('minute')}`;
  throw new Error('fmt ' + f);
}
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = (this.sh.data[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; }
  setValues(v) { v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x))); return this; }
  setValue(x) { this.sh.set(this.r, this.c, x); return this; }
  setFontWeight() { return this; } setNumberFormat() { return this; } insertCheckboxes() { this.sh.checkboxes = (this.sh.checkboxes || 0) + 1; return this; }
}
class Sheet {
  constructor(name, data) { this.name = name; this.data = data || []; }
  getName() { return this.name; }
  set(r, c, v) { if (typeof v === 'string' && v[0] === "'") v = v.slice(1); while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  getLastRow() { let n = 0; this.data.forEach((r, i) => { if (r.some(v => v !== '' && v != null)) n = i + 1; }); return n; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => { let n = 0; r.forEach((v, i) => { if (v !== '' && v != null) n = i + 1; }); return n; })); }
  getMaxRows() { return 1000; }
  getRange(r, c, nr, nc) { if (typeof r === 'string') return new Range(this, 1, 1, 1, 1); return new Range(this, r, c, nr || 1, nc || 1); }
  appendRow(row) { this.data.splice(this.getLastRow(), 0, row.map(v => typeof v === 'string' && v[0] === "'" ? v.slice(1) : v)); }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  setFrozenRows() {}
}
function makeEnv(sheets) {
  const ss = { sheets: Object.entries(sheets).map(([n, d]) => new Sheet(n, d)) };
  ss.getSheetByName = n => ss.sheets.find(s => s.name === n) || null;
  ss.insertSheet = n => { const s = new Sheet(n, []); ss.sheets.push(s); return s; };
  ss.getSheets = () => ss.sheets; ss.deleteSheet = s => { ss.sheets = ss.sheets.filter(x => x !== s); };
  ss.getId = () => 'ssid'; ss.setSpreadsheetTimeZone = () => {}; ss.toast = (m) => { env.toasts.push(m); };
  const store = new Map();
  const cache = {
    get: k => store.has(k) ? store.get(k) : null, put: (k, v) => { if (Buffer.byteLength(String(v), 'utf8') > 100 * 1024) throw new Error('too big'); store.set(k, String(v)); },
    getAll: ks => { const o = {}; ks.forEach(k => { if (store.has(k)) o[k] = store.get(k); }); return o; },
    putAll: o => Object.entries(o).forEach(([k, v]) => cache.put(k, v)), remove: k => store.delete(k)
  };
  const triggers = [];
  const env = {
    toasts: [], store, triggers, counts: { reads: 0, cal: 0, drive: 0 },
    SpreadsheetApp: { getActive: () => ss, getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }), alert() {},
      prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => env.promptAnswer || '' }), Button: { OK: 'OK' }, ButtonSet: { OK_CANCEL: 1, OK: 2 },
      showModalDialog: (h) => { env.dialog = h.html; } }) },
    HtmlService: { createHtmlOutput: html => ({ html, setWidth() { return this; }, setHeight() { return this; } }) },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: s => ({ s, setMimeType() { return JSON.parse(s); } }), MimeType: { JSON: 'json' } },
    Utilities: {
      formatDate: fmt, getUuid: () => crypto.randomUUID(),
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => b > 127 ? b - 256 : b),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, base64Encode: b => Buffer.from(b).toString('base64'), base64Decode: s => Array.from(Buffer.from(s, 'base64')), newBlob: (b, m, n) => ({ bytes: b, mime: m, name: n })
    },
    UrlFetchApp: { fetch: (u) => { if (/[|\s]/.test(u.split('?')[1] || '')) throw new Error('Invalid argument: ' + u); return ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(/commons\.wikimedia/.test(u) ? (env.commons || {}) : /wikipedia/.test(u) ? (env.wikiCalls = (env.wikiCalls || 0) + 1, env.wiki || {}) : /open-meteo/.test(u) ? { current: { temperature_2m: 15.4, weather_code: 2 }, daily: { weather_code: [61], temperature_2m_max: [18.2], temperature_2m_min: [9.6], precipitation_probability_max: [70] } } : env.token) }); }, fetchAll: () => [] },
    ScriptApp: { getProjectTriggers: () => triggers, newTrigger: h => { const mk = { create: () => triggers.push({ getHandlerFunction: () => h }) }; const wk = { atHour: () => mk }; return { timeBased: () => ({ everyHours: () => mk, onWeekDay: () => wk }) }; }, WeekDay: { FRIDAY: 5, SUNDAY: 0 }, getOAuthToken: () => 't' },
    Drive: { Files: {
      list: (q) => { env.counts.drive++; if (q && /in parents/.test(q.q || '') && env.backups) return { files: env.backups.filter(f => !f.trashed).slice().reverse() }; return { files: [] }; },
      create: (r, blob) => { env.created = env.created || []; env.created.push({ r, blob }); return { id: blob ? 'file' + env.created.length : 'folder1' }; }, get: (id) => ({ id, trashed: false }),
      copy: (r, id) => { env.backups = env.backups || []; env.backups.push({ id: 'b' + env.backups.length, name: r.name }); return { id: 'c' }; },
      update: (r, id) => { const f = (env.backups || []).find(x => x.id === id); if (f) f.trashed = true; return {}; }
    } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (env.props || {})[k] || null, setProperty: (k, v) => { env.props = env.props || {}; env.props[k] = v; } }) },
    Calendar: { Events: { list: () => { env.counts.cal++; return { items: env.calItems || [] }; } } },
    console
  };
  const origGet = Sheet.prototype.getRange;
  vm.createContext(env);
  vm.runInContext(code, env);
  env.ss = ss;
  return env;
}
let fails = 0;
function ok(c, m) { if (!c) { fails++; console.log('NG', m); } else console.log('ok', m); }
const post = (env, o) => env.doPost({ postData: { contents: JSON.stringify(o) } });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());

// 古い形のシート（今の本番に近い）：設定にパパ/ママのメール、担当の列順はそのまま、行に「パパ」
const env = makeEnv({
  '設定': [['項目', '値', '説明'], ['クライアントID', 'cid', ''], ['パパのメール', 'p1@example.com', ''], ['ママのメール', 'p2@example.com', ''], ['カレンダーID', '', ''], ['写真フォルダID', '', '']],
  '担当': [['id', '時刻', 'やること', '担当', '曜日'], ['d1', '6:30', '起こして朝ごはん', 'パパ', '毎日'], ['d2', '8:00', '保育園の送り', 'ママ', '平日']],
  'シート1': []
});
env.setup();
const cfgRows = env.ss.getSheetByName('設定').data.map(r => r[0]);
ok(cfgRows.includes('人1のメール') && !cfgRows.includes('パパのメール'), 'setup: パパのメール → 人1のメール に移した');
ok(env.ss.getSheetByName('設定').data.find(r => r[0] === '人1のメール')[1] === 'p1@example.com', 'setup: メールの値を引き継いだ');
ok(env.ss.getSheetByName('画面').data.length === 13, 'setup: 画面シートに12行');
ok(env.ss.getSheetByName('チェック').data[0].length === 6, 'setup: 空のシートに見出し');
ok(env.ss.getSheetByName('献立').getLastRow() === 1, 'setup: 見本の行を入れない');
ok(env.triggers.length === 3, 'setup: トリガー3つ（写真・ふりかえり・バックアップ）');
env.setup();
ok(env.ss.getSheetByName('画面').data.length === 13 && env.triggers.length === 3, 'setup: 2回目も増えない');

// ログイン
env.token = { iss: 'accounts.google.com', aud: 'cid', email: 'p1@example.com', email_verified: 'true', exp: Date.now() / 1000 + 600, nonce: 'n1' };
const lg = post(env, { action: 'login', idToken: 'x', nonce: 'n1' });
ok(lg.ok && lg.me.who === 'とと', 'login: とと として入れる');
const S = lg.session;

// 列を並べ替え＋列を足しても読める。担当に id なしの行を足す
const duty = env.ss.getSheetByName('担当');
duty.data = [['やること', 'メモ', '担当', '時刻', '曜日', 'id'], ['起こして朝ごはん', 'x', 'パパ', '6:30', '毎日', 'd1'], ['保育園の送り', '', 'ママ', '8:00', '毎日', 'd2'], ['洗濯', '', 'とと', '21:00', '', '']];
env.onEdit();
let b = post(env, { action: 'boot', session: S, today });
ok(b.ok, 'boot ok ' + (b.message || ''));
const D = b.data;
ok(D.duties.length === 3, 'boot: 担当3つ（列の並べ替え・id無しもOK）');
ok(D.duties[0].who === 'とと' && D.duties[1].who === 'まま', 'boot: パパ/ママ → とと/まま');
ok(/^r[0-9a-f]{10}$/.test(D.duties[2].id), 'boot: id無しの行に自動id ' + D.duties[2].id);
ok(D.people[0].name === 'とと' && D.people[1].ink === '#A3355D', 'boot: 人の呼び名と色');
ok(D.ui.sections[0].key === 'photos' && D.ui.sections[0].person === false, 'boot: 画面設定（写真は人タブで出さない）');
ok(D.me.who === 'とと', 'boot: me');

// まとめ（キャッシュ）が効く：2回目はシートを読み直さない
const readsBefore = env.counts.cal;
env.ss.getSheetByName('設定').data.find(r => r[0] === 'カレンダーID')[1] = '';
let b2 = post(env, { action: 'boot', session: S, today });
ok(JSON.stringify(b2.data.duties) === JSON.stringify(D.duties), 'boot: 2回目はまとめから');
// シートを直接変える（onEditなし）→ まとめのまま。fresh で読み直す
duty.data.push(['お風呂', '', 'まま', '19:00', '毎日', 'd9']);
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.duties.length === 3, 'boot: onEditが無い変更はまとめのまま');
b2 = post(env, { action: 'boot', session: S, today, fresh: true });
ok(b2.data.duties.length === 4, 'boot fresh: 読み直して4つ');
// onEdit で次から反映
duty.data.push(['寝かしつけ', '', '家族', '20:00', '毎日', 'd10']);
env.onEdit();
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.duties.length === 5, 'boot: onEdit後は反映');

// 書き込み → すぐ反映
let r = post(env, { action: 'setDone', session: S, date: today, taskId: 'd1', done: true });
ok(r.ok, 'setDone');
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.done.d1 === true, 'boot: 書き込み後すぐ反映');
const chk = env.ss.getSheetByName('チェック').data;
ok(chk[1][4] === 'とと', 'チェック: 誰=とと');
r = post(env, { action: 'addNote', session: S, note: { id: 'n1', text: 'テスト', to: 'まま' } });
r = post(env, { action: 'addDiary', session: S, entry: { id: 'k1', date: today, time: '7:00', text: '日記' } });
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.notes.length === 1 && b2.data.notes[0].to === 'まま' && b2.data.diary.length === 1, '申し送り・日記');
r = post(env, { action: 'ackNote', session: S, id: 'n1', read: true });
r = post(env, { action: 'deleteDiary', session: S, id: 'k1' });
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.notes[0].read === true && b2.data.diary.length === 0, '確認・日記の削除');

// 設定で呼び名を変える → 反映
env.ss.getSheetByName('設定').data.find(r => r[0] === '人1の呼び名')[1] = 'ケン';
env.onEdit();
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.duties[0].who === 'ケン' && b2.data.me.who === 'ケン', '呼び名の変更が反映');
// 画面シートで見出しと順番
const scr = env.ss.getSheetByName('画面');
const head = scr.data[0];
const row = scr.data.find(x => x[0] === 'news');
row[head.indexOf('順番')] = 0; row[head.indexOf('見出し')] = 'ニュース';
env.refreshApp();
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.ui.sections[0].key === 'news' && b2.data.ui.sections[0].title === 'ニュース', '画面: 順番と見出し');
// 朝・夜の並びの時刻：時刻の型（1899年の日付）でも読める。空ならその並びを使わない
ok(b2.data.ui.morningFrom === 300 && b2.data.ui.morningTo === 540 && b2.data.ui.eveningFrom === 1080, '時刻: 朝5:00〜9:00・夜18:00（初期値）');
ok(b2.data.ui.sections.find(x => x.key === 'plan').morning < b2.data.ui.sections.find(x => x.key === 'week').morning, '画面: 朝の順番（予定がごはんより先）');
const setRow = k => env.ss.getSheetByName('設定').data.find(r => r[0] === k);
setRow('夜の並びにする時刻')[1] = new Date(Date.UTC(1899, 11, 30, 10, 30));   // 東京で19:30の時刻の値
setRow('朝の並びにする時刻')[1] = '';
env.refreshApp();
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.ui.eveningFrom === 19 * 60 + 30 && b2.data.ui.morningFrom === null, '時刻: 時刻の型は19:30として読み、空の朝はnull');
// 天気：設定の「地名 緯度,経度」から
setRow('天気の場所')[1] = '東京 35.68,139.76';
env.refreshApp();
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.weather && b2.data.weather.place === '東京' && b2.data.weather.max === 18 && b2.data.weather.pop === 70, '天気: 地名と最高気温と降水確率');
// 続けた日数：昨日の担当を全部済にすると1日
{
  const y = (d => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() - 1); return t.toISOString().slice(0, 10); })(today);
  const chkSh = env.ss.getSheetByName('チェック');
  const yd = new Date(y + 'T00:00:00'), dow = yd.getDay();
  const ids = b2.data.dutiesAll.filter(d => !d.date && (d.rule === '毎日' || !d.rule)).map(d => d.id);
  ids.forEach(id => chkSh.data.push([y, '担当', id, true, 'とと', '']));
  env.refreshApp();
  b2 = post(env, { action: 'boot', session: S, today });
  ok(b2.data.streak >= 1, '続けた日数: 昨日ぜんぶ済で ' + b2.data.streak);
}
ok(env.toasts.some(t => t.indexOf('反映') >= 0), 'メニュー: アプリに反映のお知らせ');

// カレンダーの頭の名前
env.ss.getSheetByName('設定').data.find(r => r[0] === 'カレンダーID')[1] = 'cal';
env.calItems = [{ summary: 'まま: 面談', start: { dateTime: new Date().toISOString() } }, { summary: 'パパ：歯医者', start: { dateTime: new Date().toISOString() } }];
env.onEdit();
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.plans[0].who === 'まま' && b2.data.plans[0].what === '面談' && b2.data.plans[1].who === 'ケン', 'カレンダー: 頭の名前で担当');
{
  const dd = n => { const x = new Date(today + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10) === x.toISOString().slice(0, 10) && [x.getFullYear(), String(x.getMonth() + 1).padStart(2, '0'), String(x.getDate()).padStart(2, '0')].join('-'); };
  const at = (n, h, m) => dd(n) + 'T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00+09:00';
  env.calItems = [
    { id: 'trip', summary: '旅行', start: { date: dd(-1) }, end: { date: dd(3) } },
    { id: 'hotel', summary: 'ペットホテル', start: { dateTime: at(1, 10, 40) }, end: { dateTime: at(3, 10, 30) } },
    { id: 'far', summary: '遠い', start: { date: dd(20) }, end: { date: dd(21) } }
  ];
  env.onEdit();
  b2 = post(env, { action: 'boot', session: S, today });
  const P = b2.data.plans, trip = P.filter(p => p.key === 'trip'), hotel = P.filter(p => p.key === 'hotel');
  ok(trip.length === 3 && trip[0].date === today && trip[0].from === dd(-1) && trip[0].to === dd(2), '予定: 続く終日予定は見える日ごとに from/to 付き ' + JSON.stringify(trip.map(p => p.date)));
  ok(hotel.length === 3 && hotel[0].time === '10:40' && hotel[1].time === '' && hotel[2].time === '〜10:30', '予定: 何日も続く時刻つき ' + JSON.stringify(hotel.map(p => p.time)));
  ok(b2.data.plansFrom === today && b2.data.plansTo === dd(13), '予定: 範囲は今日から2週間');
  const setSh = env.ss.getSheetByName('設定'); const alRow = setSh.data.find(r => r[0] === '人1の別名'); if (alRow) alRow[1] = 'XA, ケンB'; else setSh.data.push(['人1の別名', 'XA, ケンB', '']);
  env.calItems = [{ summary: 'XA: 病院', start: { dateTime: at(0, 9) } }, { summary: 'XB：美容院', start: { dateTime: at(0, 10) } }];
  env.onEdit();
  b2 = post(env, { action: 'boot', session: S, today });
  ok(b2.data.plans[0].who === 'ケン' && b2.data.plans[0].what === '病院' && b2.data.plans[1].who === '家族', '予定: 別名（人1の別名）で担当 ' + JSON.stringify(b2.data.plans.map(p => p.who)));
}

// 写真：最近足した物を出す
{
  const now = Date.parse('2026-11-20T00:00:00Z'), day = 864e5;
  const mk = (n, ago) => Array.from({ length: n }, (_, i) => ({ id: 'p' + ago + '_' + i, createdTime: new Date(now - ago * day - i * 1000).toISOString() }));
  let files = mk(12, 1).concat(mk(20, 60));
  let r = env.pickRecent(files, now);
  ok(r.length === 12 && r.every(f => f.id.startsWith('p1_')), '写真: 30日以内の物だけ（新しい順）');
  files = mk(3, 2).concat(mk(20, 60));
  r = env.pickRecent(files, now);
  ok(r.length === 8 && r.slice(0, 3).every(f => f.id.startsWith('p2_')), '写真: 少ない時は古い物で8件まで埋める');
  files = mk(45, 3);
  ok(env.pickRecent(files, now).length === 30, '写真: 多くても30件まで');
}
// 写真：アプリから足す
{
  const small = Buffer.from('jpegdata').toString('base64');
  let r = post(env, { action: 'addPhoto', session: S, mime: 'image/jpeg', data: small });
  const up = (env.created || []).filter(c => c.blob);
  ok(r.ok && up.length === 1 && up[0].r.parents[0] === 'folder1' && up[0].blob.mime === 'image/jpeg' && /\.jpg$/.test(up[0].r.name) && env.props.uploadFolder === 'folder1', 'addPhoto: アプリの置き場に入れる');
  ok(post(env, { action: 'addPhoto', session: S, mime: 'text/html', data: small }).code === 'bad_request', 'addPhoto: 写真・動画以外は断る');
  ok(post(env, { action: 'addPhoto', session: S, mime: 'image/jpeg', data: Buffer.alloc(9 * 1048576).toString('base64') }).code === 'too_big', 'addPhoto: 大きすぎる写真は断る');
  ok(post(env, { action: 'addPhoto', mime: 'image/jpeg', data: small }).ok === false, 'addPhoto: ログインなしは断る');
}
// 担当：アプリから足す（今日だけ・くり返し）、直す、消す
env.onEdit();
let r2 = post(env, { action: 'saveDuty', session: S, duty: { id: 'dx1', task: '病院', time: '10:00', who: 'まま', date: today } });
ok(r2.ok, 'saveDuty 今日だけ');
r2 = post(env, { action: 'saveDuty', session: S, duty: { id: 'dx2', task: 'ゴミ出し', time: '07:30', who: 'とと', rule: '日月火水木金土' } });
let b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.duties.some(d => d.id === 'dx1' && d.once) && b3.duties.some(d => d.id === 'dx2' && d.t === 450), 'boot: 足した担当が今日に出る');
ok(b3.dutiesAll.some(d => d.id === 'dx2' && d.rule === '日月火水木金土'), 'dutiesAll にくり返し');
const autoId = b3.dutiesAll.find(d => d.task === '洗濯').id;
r2 = post(env, { action: 'saveDuty', session: S, duty: { id: autoId, task: '洗濯（夜）', time: '21:30', who: 'まま', rule: '平日' } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.dutiesAll.some(d => d.id === autoId && d.task === '洗濯（夜）' && d.who === 'まま'), '自動idの行を直せる（idが固定される）');
r2 = post(env, { action: 'deleteDuty', session: S, id: 'dx1' });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(r2.ok && !b3.dutiesAll.some(d => d.id === 'dx1'), 'deleteDuty');
// 出発の時刻：担当を「出発のN分前」で持ち、出発を変えると一緒にずれる
r2 = post(env, { action: 'saveDuty', session: S, duty: { id: 'dep1', task: '検温して連絡', time: '', rel: 10, who: 'とと', rule: '日月火水木金土' } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(r2.ok && b3.duties.some(d => d.id === 'dep1' && d.rel === 10 && d.t === (b3.ui.depart - 10)), '出発: 出発-10 の担当が出発の10分前に出る');
ok(env.ss.getSheetByName('担当').data.some(row => row.includes('出発-10')), '出発: シートには「出発-10」と書く');
r2 = post(env, { action: 'setDepart', session: S, time: '8:30' });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(r2.ok && b3.ui.depart === 510 && b3.duties.some(d => d.id === 'dep1' && d.t === 500), '出発: 8:30 に変えると担当も 8:20 にずれる');
ok(post(env, { action: 'setDepart', session: S, time: 'あさ' }).code === 'bad_request', '出発: 時刻でない値は断る');
ok(JSON.stringify(env.dutyTime('出発', 480)) === '{"t":480,"rel":0}' && JSON.stringify(env.dutyTime('7:15', 480)) === '{"t":435,"rel":null}', '出発: 時刻の読み方');
post(env, { action: 'deleteDuty', session: S, id: 'dep1' });
// 今日だけ担当を替える：自分が引き受ける・戻す。「代わってほしい」の申し送りに答えると替わる
r2 = post(env, { action: 'saveDuty', session: S, duty: { id: 'sw1', task: '寝かしつけ', time: '19:30', who: lg.me.who === 'とと' ? 'まま' : 'とと', rule: '日月火水木金土' } });
r2 = post(env, { action: 'swapDuty', session: S, date: today, id: 'sw1', take: true });
b3 = post(env, { action: 'boot', session: S, today }).data;
const meW = b3.duties.find(d => d.id === 'sw1');
ok(r2.ok && meW.orig && meW.who !== meW.orig, '担当替え: 今日だけ自分がやる（orig に元の担当）');
ok(b3.dutiesAll.find(d => d.id === 'sw1').who === meW.orig, '担当替え: いつもの担当は変わらない');
post(env, { action: 'swapDuty', session: S, date: today, id: 'sw1', take: false });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(!b3.duties.find(d => d.id === 'sw1').orig, '担当替え: 元に戻す');
r2 = post(env, { action: 'addNote', session: S, note: { id: 'nsw1', to: meW.orig, taskId: 'sw1', task: '寝かしつけ', text: '代わって', ask: 'swap', askDate: today } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(r2.ok && b3.notes.some(n => n.id === 'nsw1' && n.ask === 'swap' && n.askDate === today && n.answer === ''), '代わってほしい: 申し送りに依頼が残る');
ok(post(env, { action: 'answerSwap', session: S, id: 'nsw1', ok: true }).code === 'not_yours', '代わってほしい: 頼まれた人しか答えられない');
post(env, { action: 'deleteDuty', session: S, id: 'sw1' });
// 話題の優先度：高を先に
post(env, { action: 'saveTopic', session: S, topic: { id: 'tpA', title: '話題A', url: '', note: '' } });
post(env, { action: 'saveTopic', session: S, topic: { id: 'tpB', title: '話題B', url: '', note: '', high: true } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.topics[0].id === 'tpB' && b3.topics[0].high === true && b3.topics.find(x => x.id === 'tpA').high === false, '話題: 優先度高が一番前');
post(env, { action: 'saveTopic', session: S, topic: { id: 'tpB', title: '話題B', url: '', note: '', high: false } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.topics.find(x => x.id === 'tpB').high === false, '話題: 優先度を戻せる');
post(env, { action: 'saveTopic', session: S, topic: { id: 'tpA', title: '話題A', url: '', note: '', show: false } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(!b3.topics.some(x => x.id === 'tpA') && b3.topicsArchived.some(x => x.id === 'tpA'), 'リンク集: 表示を外すとアーカイブへ');
post(env, { action: 'saveTopic', session: S, topic: { id: 'tpC', title: '話題C', url: 'https://example.com', note: '', show: false } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.topicsArchived.some(x => x.id === 'tpC') && !b3.topics.some(x => x.id === 'tpC'), 'リンク集: 最初からアーカイブに足せる');
post(env, { action: 'saveTopic', session: S, topic: { id: 'tpA', title: '話題A', url: '', note: '', show: true } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.topics.some(x => x.id === 'tpA'), 'リンク集: 話題に戻せる');
post(env, { action: 'deleteTopic', session: S, id: 'tpA' }); post(env, { action: 'deleteTopic', session: S, id: 'tpB' }); post(env, { action: 'deleteTopic', session: S, id: 'tpC' });
// 買い物：前の週の履歴から買うかも
const ws = (d => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() - t.getDay()); return t; })(today);
const wk = n => { const t = new Date(ws); t.setDate(t.getDate() - 7 * n); return t.toISOString().slice(0, 10); };
const shop = env.ss.getSheetByName('買い物');
shop.data = [['週', 'id', '分類', '品名', '量'],
  [wk(4), 'a1', 'お店で買う', '牛乳', '2本'], [wk(3), 'a2', 'お店で買う', '牛乳', '2本'], [wk(2), 'a3', 'お店で買う', '牛乳', '2本'], [wk(1), 'a4', 'お店で買う', 'バナナ', '1房'],
  [wk(4), 'a5', 'WEB', 'オムツ', '1袋'], [wk(2), 'a6', 'WEB', 'オムツ', '1袋'],
  [wk(0), 'a7', 'お店で買う', 'バナナ', '1房']];
env.onEdit();
b3 = post(env, { action: 'boot', session: S, today }).data;
const sg = b3.shopSuggest.map(x => x.name);
ok(sg[0] === '牛乳' || sg[0] === 'オムツ', '買うかも：そろそろの物が先 ' + JSON.stringify(b3.shopSuggest));
ok(!sg.includes('バナナ'), '買うかも：今のリストにある物は出さない');
r2 = post(env, { action: 'saveShop', session: S, item: { id: 'sx', name: '卵', qty: '1パック', cat: 'お店で買う', week: wk(0) } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.shop.groups.some(g => g.items.some(x => x[0] === 'sx' && x[1] === '卵')), 'saveShop 追加');
r2 = post(env, { action: 'saveShop', session: S, item: { id: 'sx', name: '卵M', qty: '2', cat: 'WEB' } });
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.shop.groups.find(g => g.label === 'WEB').items.some(x => x[1] === '卵M'), 'saveShop 直す（分類も）');
r2 = post(env, { action: 'deleteShop', session: S, id: 'sx' });
ok(r2.ok, 'deleteShop');
// 話題
r2 = post(env, { action: 'saveTopic', session: S, topic: { id: 't1', title: '旅のしおり', url: 'https://claude.ai/artifact/x', note: '旅' } });
ok(r2.ok, 'saveTopic');
r2 = post(env, { action: 'saveTopic', session: S, topic: { id: 't2', title: '危ない', url: 'javascript:alert(1)' } });
ok(!r2.ok, 'saveTopic: https 以外は断る');
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.topics.length === 1 && b3.topics[0].title === '旅のしおり', 'boot: 話題');
// 要望
r2 = post(env, { action: 'addFeedback', session: S, feedback: { text: '買い物を並べ替えたい', screen: 'v5' } });
const fb = env.ss.getSheetByName('要望').data;
ok(r2.ok && fb[1][fb[0].indexOf('内容')] === '買い物を並べ替えたい' && fb[1][fb[0].indexOf('状態')] === '未対応', 'addFeedback');

// まとめの競合：組み立て中に書き込みがあったら、古いまとめを新しい版の鍵で保存しない
{
  env.onEdit();
  const realBuild = env.buildBoot;
  env.buildBoot = function (t) { const d = realBuild(t); env.bump(); return d; }; // 組み立て中に書き込みが入った
  post(env, { action: 'boot', session: S, today });
  env.buildBoot = realBuild;
  const keys = [...env.store.keys()].filter(k => k.startsWith('b_') && k.endsWith('_n'));
  const cur = env.store.get('ver');
  ok(!keys.some(k => k.includes(cur)), 'まとめ：組み立て中に版が変わったら、新しい版の鍵では保存しない');
}
// 文字は文字のまま（1/2 が日付にならない）
post(env, { action: 'saveShop', session: S, item: { id: 'sq', name: '=SUM(1)', qty: '1/2', cat: 'お店で買う', week: wk(0) } });
const srow = env.ss.getSheetByName('買い物').data.find(r => r.includes('sq'));
ok(srow.includes('1/2') && srow.includes('=SUM(1)'), '書き込みは先頭に \' を付けて文字として入る');
// https 以外のリンクは返さない
env.ss.getSheetByName('ニュース').data.push(['nx', '', 'Web', 'x', '', '危ないリンク', '', '', 'javascript:alert(1)']);
env.onEdit();
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.news.find(n => n.title === '危ないリンク').url === '', 'ニュース：https 以外のリンクは空に');
ok(b3.api === 14 && b3.v, 'boot に api の版と、変わったかを見る版');
// 日本語の長いデータでもキャッシュの1件100KBを超えない
{
  const big = 'あ'.repeat(200000);
  env.bigPut('zz', big, 60);
  ok(env.bigGet('zz') === big, 'キャッシュ：日本語20万文字を分けて入れて戻せる');
}

// くり返しの担当を今日だけ休む（決まりは残る）
{
  env.onEdit();
  let b4 = post(env, { action: 'boot', session: S, today }).data;
  const rid = b4.duties[0].id;
  post(env, { action: 'skipDuty', session: S, date: today, id: rid, skip: true });
  b4 = post(env, { action: 'boot', session: S, today }).data;
  ok(!b4.duties.some(d => d.id === rid) && b4.dutiesAll.some(d => d.id === rid) && b4.skipped[rid], '今日だけ休む：今日の流れから消え、くり返しは残る');
  post(env, { action: 'skipDuty', session: S, date: today, id: rid, skip: false });
  b4 = post(env, { action: 'boot', session: S, today }).data;
  ok(b4.duties.some(d => d.id === rid), '休みをやめると戻る');
}

// ふたりで決めること：答えがそろうまで決まったにできない
{
  post(env, { action: 'saveDecision', session: S, item: { id: 'q1', q: '平日の朝夜の担当は？', options: ['A案（朝はとと）', 'B案（朝はまま）'], due: today } });
  let r = post(env, { action: 'answerDecision', session: S, id: 'q1', answer: 'A案（朝はとと）' });
  r = post(env, { action: 'decide', session: S, id: 'q1' });
  ok(!r.ok && r.code === 'not_agreed', '決める：片方だけでは決まったにならない');
  const row = env.ss.getSheetByName('相談').data.find(x => x.includes('q1')); const h = env.ss.getSheetByName('相談').data[0];
  row[h.indexOf('人2の答え')] = 'A案（朝はとと）'; env.onEdit();
  r = post(env, { action: 'decide', session: S, id: 'q1' });
  let bd = post(env, { action: 'boot', session: S, today }).data;
  ok(r.ok && bd.decisions[0].state === '決まった' && bd.decisions[0].decided === 'A案（朝はとと）' && bd.decisions[0].options.length === 2, '決める：2人がそろうと決まった');
  r = post(env, { action: 'answerDecision', session: S, id: 'q1', answer: 'B案（朝はまま）' });
  ok(!r.ok && r.code === 'already_decided', '決まった相談には答えを変えられない');
  post(env, { action: 'saveDecision', session: S, item: { id: 'q1', q: '別の問い', options: ['A案（朝はとと）', 'B案（朝はまま）'] } });
  bd = post(env, { action: 'boot', session: S, today }).data;
  const q1 = bd.decisions.find(x => x.id === 'q1');
  ok(q1.state === '相談中' && !q1.a1 && !q1.a2, '問いを変えると答えが消えて相談中に戻る');
  post(env, { action: 'saveDecision', session: S, item: { id: 'q2', q: '帰省', options: ['先にとと実家、あとでまま実家', '12/29から'] } });
  bd = post(env, { action: 'boot', session: S, today }).data;
  ok(bd.decisions.find(x => x.id === 'q2').options.length === 2, '選択肢は「、」や「/」で分かれない');
}
// 期限
{
  post(env, { action: 'saveDeadline', session: S, item: { id: 'k1', what: '保育園の書類', due: today, who: 'まま' } });
  post(env, { action: 'saveDeadline', session: S, item: { id: 'k2', what: 'パスポート受け取り', due: '2099-01-01', who: 'とと' } });
  let bd = post(env, { action: 'boot', session: S, today }).data;
  ok(bd.deadlines.length === 2 && bd.deadlines[0].id === 'k1', '期限：近い順');
  post(env, { action: 'doneDeadline', session: S, id: 'k1', done: true });
  bd = post(env, { action: 'boot', session: S, today }).data;
  ok(bd.deadlines.find(x => x.id === 'k1').done === true, '期限：済');
}
// お出かけ
{
  post(env, { action: 'saveOuting', session: S, item: { id: 'o1', name: '油山牧場', kind: '公園' } });
  post(env, { action: 'likeOuting', session: S, id: 'o1', like: true });
  let rr = post(env, { action: 'planOuting', session: S, id: 'o1', date: '2099-01-03' });
  ok(!rr.ok && rr.code === 'not_both', 'お出かけ：片方だけでは行く日を決められない');
  env.ss.getSheetByName('設定').data.find(r => r[0] === 'カレンダーID')[1] = '';
  const orow = env.ss.getSheetByName('お出かけ').data.find(x => x.includes('o1')); orow[env.ss.getSheetByName('お出かけ').data[0].indexOf('人2')] = true; env.onEdit();
  post(env, { action: 'planOuting', session: S, id: 'o1', date: '2099-01-03' });
  post(env, { action: 'planOuting', session: S, id: 'o1', date: '2099-01-04' });
  const prows = env.ss.getSheetByName('予定').data.filter(x => x.includes('おでかけ：油山牧場'));
  ok(prows.length === 1 && prows[0].includes('2099-01-04'), 'お出かけ：日を変えても予定は1行だけ');
  post(env, { action: 'planOuting', session: S, id: 'o1', date: '' });
  ok(!env.ss.getSheetByName('予定').data.some(x => x.includes('おでかけ：油山牧場')), 'お出かけ：やめると予定からも消える');
  post(env, { action: 'planOuting', session: S, id: 'o1', date: '2099-01-03' });
  let bd = post(env, { action: 'boot', session: S, today }).data;
  const o = bd.outings.find(x => x.id === 'o1');
  ok(o && o.like1 && o.state === '決めた' && o.go === '2099-01-03', 'お出かけ：行きたい・行く日');
}
// まとめて買い物に
{
  post(env, { action: 'addShopMany', session: S, items: [{ id: 'm1', name: '大根', qty: '1本', cat: 'お店で買う', week: wk(0) }, { id: 'm2', name: '鶏もも', qty: '300g', cat: 'お店で買う', week: wk(0) }] });
  let bd = post(env, { action: 'boot', session: S, today }).data;
  ok(bd.shop.groups.some(g => g.items.some(x => x[1] === '大根')) && bd.shop.groups.some(g => g.items.some(x => x[1] === '鶏もも')), '献立の材料をまとめて買い物へ');
}
// 材料ごとに行き先（分類）を選んで送る・来週の献立・前に入れた分類
{
  const r = post(env, { action: 'addShopMany', session: S, items: [{ id: 'm3', name: '冷凍うどん', qty: '5玉', cat: 'WEB', week: wk(0) }, { id: 'm4', name: ' 大根', qty: '1本', cat: 'WEB', week: wk(0) }, { id: 'm5', name: 'ねぎ', cat: 'お店で買う', week: wk(0) }, { id: 'm6', name: 'ねぎ', cat: 'WEB', week: wk(0) }] });
  let bd = post(env, { action: 'boot', session: S, today }).data;
  const items = bd.shop.groups.flatMap(g => g.items.map(x => [g.label, x[1]]));
  ok(r.ok && items.some(x => x[0] === 'WEB' && x[1] === '冷凍うどん') && items.some(x => x[0] === 'お店で買う' && x[1] === 'ねぎ'), 'addShopMany: 品ごとの分類で入る');
  ok(items.filter(x => x[1] === '大根').length === 1 && items.filter(x => x[1] === 'ねぎ').length === 1 && r.skipped.includes('大根') && r.skipped.includes('ねぎ'), 'addShopMany: まだ買っていない同じ品名・同じ送りの重なりは足さない');
  ok(bd.shopCats[0] === bd.shop.groups[0].label && bd.shopCats.includes('WEB') && bd.shopCats.includes('お店で買う'), 'boot: 買い物の分類の一覧（今のリストの順が先）' + JSON.stringify(bd.shopCats));
  const day = n => { const t = new Date(today + 'T00:00:00'); t.setDate(t.getDate() + n); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
  const dow = new Date(today + 'T00:00:00').getDay();
  const nextSun = day(7 - dow), nextSat = day(13 - dow), after = day(14 - dow);
  post(env, { action: 'saveMenu', session: S, menu: { date: nextSun, dish: '来週の豚汁', ingredients: [{ name: 'オムツ', qty: '' }, { name: '冷凍うどん' }, { name: 'しめじ' }] } });
  post(env, { action: 'saveMenu', session: S, menu: { date: nextSat, dish: '来週の土曜', ingredients: [] } });
  post(env, { action: 'saveMenu', session: S, menu: { date: after, dish: '再来週', ingredients: [] } });
  bd = post(env, { action: 'boot', session: S, today }).data;
  ok(bd.menu.some(x => x.date === nextSun && x.dish === '来週の豚汁') && bd.menu.some(x => x.date === nextSat) && !bd.menu.some(x => x.date === after), 'boot: 来週の献立も返す（再来週は返さない）');
  ok(bd.menuFrom === day(-dow) && bd.menuTo === nextSat && bd.menu.every((x, i, a) => !i || a[i - 1].date <= x.date), 'boot: menuFrom〜menuTo は今週の日曜〜来週の土曜・日付順');
  ok(bd.shopLastCat['オムツ'] === 'WEB' && bd.shopLastCat['冷凍うどん'] === 'WEB' && !('しめじ' in bd.shopLastCat) && !('牛乳' in bd.shopLastCat), 'boot: 献立の材料ごとに前に入れた分類（献立に出る品だけ）' + JSON.stringify(bd.shopLastCat));
  ['来週の豚汁', '来週の土曜', '再来週'].forEach((_, i) => post(env, { action: 'deleteMenu', session: S, date: [nextSun, nextSat, after][i] }));
}
// 使われ方とふりかえり
{
  post(env, { action: 'logUsage', session: S, date: today, counts: { 'open:app': 2, 'sec:flow': 3, 'act:setDone': 1, 'bad key!': 9 } });
  post(env, { action: 'logUsage', session: S, date: today, counts: { 'open:app': 1, 'sec:shop': 1 }, batch: 'bx1' });
  post(env, { action: 'logUsage', session: S, date: today, counts: { 'open:app': 1, 'sec:shop': 1 }, batch: 'bx1' });
  const lg = env.ss.getSheetByName('使われ方').data;
  const n = lg.find(x => x[2] === 'open:app');
  ok(n && n[3] === 3 && !lg.some(x => x[2] === 'bad key!'), '使われ方：回数を足し込む・変な項目は捨てる');
  env.weeklyReview();
  const fr = env.ss.getSheetByName('ふりかえり').data;
  ok(fr.length === 2 && String(fr[1][2]).includes('3') && String(fr[1][4]).includes('写真'), 'ふりかえり：週の1行（見られていないセクションも）');
}
// 画面：ニュースは人1だけ、夜の順番、旅行中
{
  let bd = post(env, { action: 'boot', session: S, today }).data;
  const news = bd.ui.sections.find(x => x.key === 'news');
  ok(news.viewer === 'ケン' && typeof news.evening === 'number' && news.travel === false, '画面：見る人・夜の順番・旅行中');
  const trow = env.ss.getSheetByName('設定').data.find(x => x[0] === '旅行の期間'); trow[1] = '2026-12-28～2027-01-03'; env.onEdit();
  bd = post(env, { action: 'boot', session: S, today }).data;
  ok(bd.ui.tripFrom === '2026-12-28' && bd.ui.tripTo === '2027-01-03', '旅行の期間（全角の～）');
  trow[1] = '12/28から1/3'; env.onEdit();
  bd = post(env, { action: 'boot', session: S, today }).data;
  ok(bd.ui.tripFrom.slice(5) === '12-28' && bd.ui.tripTo.slice(5) === '01-03' && bd.ui.tripTo > bd.ui.tripFrom, '旅行の期間（年なし・年またぎ）');
}
// バックアップ：8週分を超えたら古いものを消す
{
  for (let i = 0; i < 10; i++) env.backupNow();
  ok(env.backups.filter(f => !f.trashed).length === 8, 'バックアップ：8つ残す');
}


// Muse：鍵で入って足す。読めるのは一覧だけ。取り消しは自分の鍵で24時間以内
{
  env.promptAnswer = 'まま';
  env.museNewKey();
  const KM = (env.dialog.match(/wgk_[0-9a-f]{64}/) || [])[0];
  ok(KM && !JSON.stringify(env.ss.getSheetByName('_keys').data).includes(KM), 'Muse: 鍵を作る（シートにはハッシュだけ）');
  const mpost = o => post(env, Object.assign({ action: 'muse', key: KM }, o));
  ok(post(env, { action: 'muse', key: 'wgk_' + '0'.repeat(64), op: 'list' }).code === 'bad_key', 'Muse: 違う鍵は断る');
  ok(post(env, { action: 'boot', key: KM, session: KM }).code === 'no_session', 'Muse: 鍵ではアプリのデータ（boot）は読めない');
  ok(mpost({ op: 'addDiary' }).code === 'unknown_op', 'Muse: 決めた操作以外はできない');
  const v0 = post(env, { action: 'ver', session: S }).v;
  let m = mpost({ op: 'shop.add', items: [{ name: '牛乳' }, { name: '大根' }, { name: '豆腐', qty: '2丁' }] });
  ok(m.ok && m.added.join() === '牛乳,豆腐' && m.skipped.join() === '大根', 'Muse: 買い物に足す（リストにある物は足さない） ' + JSON.stringify(m));
  ok(post(env, { action: 'ver', session: S }).v !== v0, 'Muse: 書いたら版が変わる（アプリがすぐ読み直す）');
  let bd = post(env, { action: 'boot', session: S, today }).data;
  ok(bd.shop.groups.some(g => g.items.some(x => x[1] === '豆腐' && x[2] === '2丁')), 'Muse: アプリにすぐ出る');
  m = mpost({ op: 'menu.add', dish: '鶏と大根の煮物', ingredients: [{ name: '鶏もも', qty: '300g' }, { name: 'しょうが', qty: '1片' }, { name: 'みりん' }], url: 'https://www.instagram.com/p/xyz/', hotcook: true, toShop: true, how: '全部入れて煮る' });
  ok(m.ok && m.date === today && m.shopAdded.join() === 'しょうが,みりん' && m.shopSkipped.join() === '鶏もも', 'Muse: 献立に入れ、材料のうちリストに無い物を買い物へ ' + JSON.stringify(m));
  bd = post(env, { action: 'boot', session: S, today }).data;
  const mm = bd.menu.find(x => x.date === today);
  ok(mm && mm.dish === '鶏と大根の煮物' && mm.hotcook && mm.ingredients.length === 3 && mm.note.includes('instagram'), 'Muse: 献立がアプリに出る');
  ok(mpost({ op: 'menu.add', date: today, dish: '別の料理' }).code === 'taken', 'Muse: 献立のある日は置きかえない（replaceが要る）');
  const m2 = mpost({ op: 'menu.add', dish: 'カレー' });
  ok(m2.ok && m2.date > today, 'Muse: 日を省くと次の空いている日');
  m = mpost({ op: 'note.add', text: '牛乳を足しました' });
  bd = post(env, { action: 'boot', session: S, today }).data;
  ok(m.ok && bd.notes.some(n => n.from === 'まま' && n.to === 'ケン' && n.text === '牛乳を足しました'), 'Muse: 申し送り（宛先を省くと相手）');
  ok(mpost({ op: 'duty.add', task: '絵本を返す', time: '9:00', date: today }).ok, 'Muse: 担当（その日だけ）');
  ok(mpost({ op: 'feedback.add', text: '文字が小さい' }).ok && env.ss.getSheetByName('要望').data.some(r => r.includes('文字が小さい') && r.includes('まま')), 'Muse: 要望');
  ok(mpost({ op: 'deadline.add', what: '予防接種の予約', due: '2099-02-01' }).ok && mpost({ op: 'outing.add', name: '動物園' }).ok && mpost({ op: 'decision.add', q: '年末どこへ', options: ['実家', '家'] }).ok, 'Muse: 期限・お出かけ・相談');
  ok(mpost({ op: 'topic.add', title: 'x', url: 'javascript:alert(1)' }).ok === false, 'Muse: https 以外のリンクは断る');
  const L = mpost({ op: 'list' });
  ok(L.ok && L.me === 'まま' && L.shop.items.some(x => x.name === '豆腐') && L.menu.some(x => x.dish === 'カレー') && !('diary' in L) && !('photos' in L) && !JSON.stringify(L).includes('@example.com'), 'Muse: 一覧（日記・写真・メールは出さない）');
  const tofuId = env.ss.getSheetByName('Museの記録').data.find(r => r.includes('豆腐'))[4];
  ok(mpost({ op: 'undo', id: tofuId }).ok && !env.ss.getSheetByName('買い物').data.some(r => r.includes('豆腐')), 'Muse: 取り消し');
  ok(mpost({ op: 'undo', id: 'sq' }).code === 'not_found', 'Muse: 自分の鍵で足した物以外は消せない');
  ok(mpost({ op: 'undo', id: 'menu:' + m2.date }).ok && !env.ss.getSheetByName('献立').data.some(r => r.includes('カレー')), 'Muse: 献立の取り消し');
  const kh = env.ss.getSheetByName('_keys').data; kh[1][kh[0].indexOf('状態')] = '止める';
  ok(mpost({ op: 'list' }).code === 'bad_key', 'Muse: 鍵を止めると使えない');
}


// 献立をアプリから入れる・直す・消す、返信
{
  let r = post(env, { action: 'saveMenu', session: S, menu: { date: today, dish: 'テスト丼', servings: '２人', hotcook: true, note: 'メモ', ingredients: [{ name: '米', qty: '2合' }, { name: 'た/まご', qty: '2' }], how: '炊く' } });
  let bd = post(env, { action: 'boot', session: S, today }).data;
  let mm = bd.menu.filter(x => x.date === today);
  ok(r.ok && mm.length === 1 && mm[0].dish === 'テスト丼' && mm[0].hotcook && mm[0].ingredients.length === 2 && mm[0].ingredients[1][0] === 'た まご' && mm[0].servings === '２', 'saveMenu: 入れる（その日を置きかえ、材料の区切り文字は消す）');
  r = post(env, { action: 'saveMenu', session: S, menu: { date: today, dish: 'テスト丼2', ingredients: [] } });
  bd = post(env, { action: 'boot', session: S, today }).data; mm = bd.menu.filter(x => x.date === today);
  ok(r.ok && mm.length === 1 && mm[0].dish === 'テスト丼2', 'saveMenu: 直す（同じ日は1つ）');
  ok(post(env, { action: 'saveMenu', session: S, menu: { date: today, dish: '' } }).code === 'bad_request', 'saveMenu: 料理名が空は断る');
  ok(post(env, { action: 'deleteMenu', session: S, date: today }).ok && !post(env, { action: 'boot', session: S, today }).data.menu.some(x => x.date === today), 'deleteMenu');
  env.wiki = { query: { redirects: [{ from: 'スパゲッティ・ボロネーゼ', to: 'ボロネーゼ' }], pages: {
    '1': { title: 'ミートソース' }, '2': { title: 'ボロネーゼ', pageimage: 'Bolo_pasta.jpg', thumbnail: { source: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/x/xx/Bolo.jpg/800px-Bolo.jpg?utm_source=x' } },
    '3': { title: '豚汁', pageimage: 'Ton.jpg', thumbnail: { source: 'http://evil.example/a.jpg' } } } } };
  env.commons = { query: { normalized: [{ from: 'File:Bolo_pasta.jpg', to: 'File:Bolo pasta.jpg' }], pages: { '-1': { title: 'File:Bolo pasta.jpg', imageinfo: [{ extmetadata: {
    Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Foo">Foo &amp; Bar</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } } }] } } } };
  post(env, { action: 'saveMenu', session: S, menu: { date: today, dish: 'ミートソース（ごはんかパスタ）', ingredients: [] } });
  bd = post(env, { action: 'boot', session: S, today }).data; mm = bd.menu.filter(x => x.date === today);
  ok(mm[0].photo === 'https://thumb.wikimedia.org/wikipedia/commons/thumb/x/xx/Bolo.jpg/800px-Bolo.jpg' && mm[0].photoBy === 'wiki' && mm[0].photoTitle === 'ボロネーゼ' && mm[0].photoCredit.artist === 'Foo & Bar' && mm[0].photoCredit.license === 'CC BY-SA 4.0' && mm[0].photoCredit.licenseUrl === 'https://creativecommons.org/licenses/by-sa/4.0' && mm[0].photoCredit.page === 'https://commons.wikimedia.org/wiki/File:Bolo_pasta.jpg', '献立の写真: 名前に合う記事の写真と作者・ライセンス（画像のない記事は飛ばして言いかえへ）' + JSON.stringify(mm[0].photoCredit));
  const calls = env.wikiCalls; env.onEdit(); bd = post(env, { action: 'boot', session: S, today }).data;
  ok(env.wikiCalls === calls && bd.menu.find(x => x.date === today).photo, '献立の写真: 2回目は覚えた物を使う');
  post(env, { action: 'saveMenu', session: S, menu: { date: today, dish: '豚汁', ingredients: [] } });
  bd = post(env, { action: 'boot', session: S, today }).data;
  ok(!bd.menu.find(x => x.date === today).photo, '献立の写真: https の wikimedia 以外は使わない');
  post(env, { action: 'deleteMenu', session: S, date: today });
  r = post(env, { action: 'addReply', session: S, reply: { id: 'rp1', target: 'topics:t1', text: '返信です' } });
  bd = post(env, { action: 'boot', session: S, today }).data;
  ok(r.ok && bd.replies.some(x => x.id === 'rp1' && x.target === 'topics:t1' && x.text === '返信です' && x.who), 'addReply: 返信がbootに出る');
  ok(post(env, { action: 'addReply', session: S, reply: { id: 'rp2', target: 'evil', text: 'x' } }).code === 'bad_request', 'addReply: 対象の形がおかしいと断る');
  ok(post(env, { action: 'addReply', session: S, reply: { id: 'rp4', target: 'decide:q1', text: 'そうしよう', parent: 'rp1' } }).ok && post(env, { action: 'boot', session: S, today }).data.replies.some(x => x.id === 'rp4' && x.parent === 'rp1'), 'addReply: コメントへの返信（返信先）');
  ok(post(env, { action: 'addReply', session: S, reply: { id: 'rp5', target: 'decide:q1', text: 'x', parent: 'a b<' } }).ok && post(env, { action: 'boot', session: S, today }).data.replies.find(x => x.id === 'rp5').parent === '', 'addReply: 返信先の形がおかしい時は空');
  ok(post(env, { action: 'addReply', session: S, reply: { id: 'rp3', target: 'notes:n1', text: '了解' } }).ok && post(env, { action: 'boot', session: S, today }).data.replies.some(x => x.id === 'rp3' && x.target === 'notes:n1'), 'addReply: 申し送りへの返信');
  ok(post(env, { action: 'addReply', session: S, reply: { id: 'rp3', target: 'decide:q1', text: '  ' } }).code === 'bad_request', 'addReply: 空は断る');
  ok(post(env, { action: 'deleteReply', session: S, id: 'rp1' }).ok && !post(env, { action: 'boot', session: S, today }).data.replies.some(x => x.id === 'rp1'), 'deleteReply: 自分の返信を消す');
}

// ログアウト
r = post(env, { action: 'logout', session: S });
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.code === 'no_session', 'logout');
// 旅行の期間：年のない書き方・年をまたぐ・ハイフン区切り
{
  const tr = (v, t) => JSON.stringify(env.tripRange(v, t));
  ok(tr('12/28～1/3', '2027-01-02') === '["2026-12-28","2027-01-03"]', '旅行: 年をまたぐ（年明けに見る）');
  ok(tr('12/28～1/3', '2026-12-20') === '["2026-12-28","2027-01-03"]', '旅行: 年をまたぐ（年末に見る）');
  ok(tr('1/5～1/8', '2026-11-20') === '["2027-01-05","2027-01-08"]', '旅行: 年のない先の期間は来年');
  ok(tr('2027-08-10 - 2027-08-15', '2026-11-20') === '["2027-08-10","2027-08-15"]', '旅行: ハイフン区切り');
  ok(tr('2027-08-10〜8/15', '2026-11-20') === '["2027-08-10","2027-08-15"]', '旅行: 後ろだけ年なし');
}
console.log(fails ? fails + ' NG' : 'ALL OK');
process.exit(fails ? 1 : 0);

