"""Museに整えてもらう：気づきの入力から下書きを作り、やめたら入力に戻る（見本モード）"""
import os, sys
from playwright.sync_api import sync_playwright
PORT = os.environ.get('WAGAYA_PORT', '8765')
errors = []
def ok(c, m):
    print(('ok ' if c else 'NG ') + m)
    if not c: errors.append(m)
with sync_playwright() as p:
    b = p.chromium.launch()
    cx = b.new_context(viewport={'width': 390, 'height': 844}); cx.grant_permissions(['clipboard-read', 'clipboard-write'])
    pg = cx.new_page()
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.add_init_script("window.open = function (u) { window.__opened = u; return null; }")
    pg.goto('http://localhost:%s/?demo=1' % PORT); pg.wait_for_timeout(1200)
    # 気づきの入力を開く（アプリの関数を直接呼ぶ：入口のボタンは写真の見出しの中）
    opened = pg.evaluate("""() => { const b = [...document.querySelectorAll('button')].find(x => /気づき/.test(x.getAttribute('aria-label') || x.textContent || '') && !/閉じる/.test(x.getAttribute('aria-label') || '')); if (b) { b.click(); return true; } return false; }""")
    ok(opened, '気づきの入力を開くボタンがある')
    pg.wait_for_timeout(400)
    ta = pg.locator('#kizuki-input')
    # 空のまま押すと案内だけ
    pg.get_by_role('button', name='Museに整えてもらう').first.click(); pg.wait_for_timeout(300)
    ok(pg.locator('#muse-title').is_hidden() or 'Museに整えてもらう' not in (pg.locator('#muse-title').text_content() or '') or pg.locator('#muse-input').input_value() == '', '空の時は下書きを作らない')
    ta.fill('えーと きょう はじめて じぶんで くつを はいた'); ta.dispatch_event('change'); pg.wait_for_timeout(200)
    pg.get_by_role('button', name='Museに整えてもらう').first.click(); pg.wait_for_timeout(400)
    draft = pg.locator('#muse-input').input_value()
    ok(pg.locator('#muse-title').text_content() == 'Museに整えてもらう', '見出しが「Museに整えてもらう」')
    ok('くつを はいた' in draft and 'diary.add' in draft and '誤変換' in draft, '下書きに文と頼み（日記に入れる）が入る')
    # やめる → 入力に戻り、文は残る
    pg.get_by_role('button', name='やめる').click(); pg.wait_for_timeout(400)
    ok(ta.input_value() == 'えーと きょう はじめて じぶんで くつを はいた', 'やめたら入力に戻り、文は残る')
    # 送る（コピーして開く）→ 下書きは消える
    pg.get_by_role('button', name='Museに整えてもらう').first.click(); pg.wait_for_timeout(300)
    pg.get_by_role('button', name='文をコピーしてMuseを開く').click(); pg.wait_for_timeout(400)
    ok(pg.evaluate('window.__opened') == 'https://muse.ai/', 'Museを開く')
    ok(ta.input_value() == '', '送ったら、こちらの下書きは消える（二重に入らない）')
    # 「元に戻す」で下書きが戻る
    pg.get_by_role('button', name='元に戻す').click(); pg.wait_for_timeout(400)
    ok(ta.input_value() == 'えーと きょう はじめて じぶんで くつを はいた', '元に戻すで下書きが戻る')
    # コピーできない時は下書きを消さない
    pg.evaluate("() => { navigator.clipboard.writeText = function () { return Promise.reject(new Error('x')); }; }")
    pg.get_by_role('button', name='Museに整えてもらう').first.click(); pg.wait_for_timeout(300)
    pg.get_by_role('button', name='文をコピーしてMuseを開く').click(); pg.wait_for_timeout(500)
    ok(ta.input_value() == 'えーと きょう はじめて じぶんで くつを はいた', 'コピーできない時は下書きが残る')
    # 担当に付けた申し送りは、整えた文を返してもらうだけ（Museからは担当に付けられない）
    pg.evaluate("() => document.querySelector('button[aria-label=\"気づきの入力を閉じる\"]').click()"); pg.wait_for_timeout(400)
    pg.evaluate("() => document.querySelector('button[aria-label=\"「犬の散歩」の申し送りを書く\"]').click()"); pg.wait_for_timeout(400)
    ta.fill('さんぽは みじかめで'); ta.dispatch_event('change'); pg.wait_for_timeout(200)
    pg.get_by_role('button', name='Museに整えてもらう').first.click(); pg.wait_for_timeout(300)
    d2 = pg.locator('#muse-input').input_value()
    ok('アプリには入れないでください' in d2 and 'note.add' not in d2 and '犬の散歩' not in d2, '担当に付けた申し送りは返してもらうだけ（担当名は入れない）')
    pg.get_by_role('button', name='やめる').click(); pg.wait_for_timeout(300)
    # Museに出さない担当に付けた文には、ボタンを出さない
    pg.evaluate("() => document.querySelector('button[aria-label=\"気づきの入力を閉じる\"]').click()"); pg.wait_for_timeout(400)
    pg.evaluate("() => document.querySelector('button[aria-label=\"「お風呂」の申し送りを書く\"]').click()"); pg.wait_for_timeout(400)
    sheet = pg.locator('#kizuki-input').locator('xpath=ancestor::section[1]')
    ok(sheet.get_by_role('button', name='Museに整えてもらう').count() == 0, 'Museに出さない担当では「Museに整えてもらう」を出さない')
    b.close()
print('errors:', errors)
sys.exit(1 if errors else 0)
