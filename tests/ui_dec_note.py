"""相談のタイトルと説明：説明は長ければ「全部読む」（見本モード）。python3 -m http.server 8765 を起動してから実行"""
import os
from playwright.sync_api import sync_playwright
PORT = os.environ.get('WAGAYA_PORT', '8765')
fails = 0
def ok(c, m):
    global fails
    if not c: fails += 1
    print('ok' if c else 'NG', m)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 844})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:%s/index.html?demo=1' % PORT); pg.wait_for_timeout(1500)
    pg.get_by_text('＋ 相談').first.click(); pg.wait_for_timeout(300)
    ok(pg.get_by_text('タイトル（短く）').count() == 1, 'タイトルの欄')
    long_q = '売るもの　以下のものについてカテゴライズしてみました。いや、これは残しておいた方がいい、これは追加で売ろう'
    pg.fill('#ed-q', long_q)
    btn = pg.get_by_role('button', name='最初の区切りまでをタイトルに、残りを説明にする')
    ok(btn.count() == 1, '長いタイトルに「分ける」ボタンが出る')
    btn.click(); pg.wait_for_timeout(200)
    ok(pg.locator('#ed-q').input_value() == '売るもの' and pg.locator('#ed-qnote').input_value().startswith('以下のもの'), 'タイトルと説明に分かれる')
    pg.fill('#ed-qnote', '以下のものについて。' * 20)
    pg.get_by_role('button', name='保存').first.click(); pg.wait_for_timeout(600)
    card = pg.locator('.dcard', has_text='売るもの')
    ok(card.count() == 1, 'カードができる')
    tg = card.get_by_role('button', name='説明を全部読む')
    ok(tg.count() == 1, '長い説明は「説明を全部読む」')
    h0 = card.locator('p').first.evaluate('e=>e.getBoundingClientRect().height'); tg.click(); pg.wait_for_timeout(200)
    h1 = card.locator('p').first.evaluate('e=>e.getBoundingClientRect().height')
    ok(h1 > h0 and card.get_by_role('button', name='閉じる').count() >= 1, '開くと全文が出る')
    ok(not errs, 'JSエラーなし ' + str(errs))
    b.close()
print('FAIL', fails) if fails else print('ALL OK')
raise SystemExit(1 if fails else 0)
