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
    SpreadsheetApp: { getActive: () => ss, getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() {} }), alert() {} }) },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: s => ({ s, setMimeType() { return JSON.parse(s); } }), MimeType: { JSON: 'json' } },
    Utilities: {
      formatDate: fmt, getUuid: () => crypto.randomUUID(),
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => b > 127 ? b - 256 : b),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, base64Encode: b => Buffer.from(b).toString('base64')
    },
    UrlFetchApp: { fetch: (u) => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(env.token) }), fetchAll: () => [] },
    ScriptApp: { getProjectTriggers: () => triggers, newTrigger: h => { const mk = { create: () => triggers.push({ getHandlerFunction: () => h }) }; const wk = { atHour: () => mk }; return { timeBased: () => ({ everyHours: () => mk, onWeekDay: () => wk }) }; }, WeekDay: { FRIDAY: 5, SUNDAY: 0 }, getOAuthToken: () => 't' },
    Drive: { Files: {
      list: (q) => { env.counts.drive++; if (q && /in parents/.test(q.q || '') && env.backups) return { files: env.backups.filter(f => !f.trashed).slice().reverse() }; return { files: [] }; },
      create: (r) => ({ id: 'folder1' }), get: (id) => ({ id, trashed: false }),
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
ok(env.toasts.some(t => t.indexOf('反映') >= 0), 'メニュー: アプリに反映のお知らせ');

// カレンダーの頭の名前
env.ss.getSheetByName('設定').data.find(r => r[0] === 'カレンダーID')[1] = 'cal';
env.calItems = [{ summary: 'まま: 面談', start: { dateTime: new Date().toISOString() } }, { summary: 'パパ：歯医者', start: { dateTime: new Date().toISOString() } }];
env.onEdit();
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.data.plans[0].who === 'まま' && b2.data.plans[0].what === '面談' && b2.data.plans[1].who === 'ケン', 'カレンダー: 頭の名前で担当');

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
r2 = post(env, { action: 'saveTopic', session: S, topic: { id: 't1', title: 'フーコックのしおり', url: 'https://claude.ai/artifact/x', note: '旅' } });
ok(r2.ok, 'saveTopic');
r2 = post(env, { action: 'saveTopic', session: S, topic: { id: 't2', title: '危ない', url: 'javascript:alert(1)' } });
ok(!r2.ok, 'saveTopic: https 以外は断る');
b3 = post(env, { action: 'boot', session: S, today }).data;
ok(b3.topics.length === 1 && b3.topics[0].title === 'フーコックのしおり', 'boot: 話題');
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
ok(b3.api === 9, 'boot に api の版');
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

// ログアウト
r = post(env, { action: 'logout', session: S });
b2 = post(env, { action: 'boot', session: S, today });
ok(b2.code === 'no_session', 'logout');
console.log(fails ? fails + ' NG' : 'ALL OK');
process.exit(fails ? 1 : 0);
