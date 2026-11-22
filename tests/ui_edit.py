"""相談・決まったこと・申し送りの「編集／直す」：見本モード。python3 -m http.server 8765 を起動してから実行（別のポートなら WAGAYA_PORT）"""
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
    pg.fill('#ed-q', '見本：直す相談'); pg.get_by_role('button', name='保存').first.click(); pg.wait_for_timeout(600)
    card = pg.locator('.dcard', has_text='見本：直す相談')
    card.get_by_role('button', name='編集', exact=True).click(); pg.wait_for_timeout(400)
    ok(pg.locator('#ed-q').input_value() == '見本：直す相談', '相談：「編集」で編集画面が開く')
    ok(pg.get_by_text('答えはリセットされ').count() == 0, '相談：まだ誰も答えていなければリセットの注意は出さない')
    pg.fill('#ed-q', '見本：直した相談'); pg.get_by_role('button', name='保存').first.click(); pg.wait_for_timeout(600)
    ok(pg.locator('.dcard', has_text='見本：直した相談').count() == 1 and pg.locator('.dcard', has_text='見本：直す相談').count() == 0, '相談：直した文になる')
    pg.get_by_text('決まったこと（アーカイブ').first.click(); pg.wait_for_timeout(400)
    art = pg.locator('article[role="listitem"]', has_text='✓ 決まった').first
    art.get_by_role('button', name='編集', exact=True).click(); pg.wait_for_timeout(400)
    ok(pg.locator('#ed-q').count() == 1 and len(pg.locator('#ed-q').input_value()) > 0, '決まったこと：「編集」で編集画面が開く')
    pg.keyboard.press('Escape'); pg.get_by_role('button', name='やめる').first.click() if pg.get_by_role('button', name='やめる').count() else None
    pg.wait_for_timeout(300)
    pg.reload(); pg.wait_for_timeout(1500)
    pg.get_by_role('button', name='相談・連絡').first.click(); pg.wait_for_timeout(500)
    pg.get_by_role('button').filter(has_text='申し送り').first.click(); pg.wait_for_timeout(600)
    pg.fill('#note-input', '見本：直す申し送り'); pg.get_by_role('button', name='送る').last.click(); pg.wait_for_timeout(800)
    sheet = pg.locator('[aria-labelledby="notes-title"]')
    ok(sheet.get_by_role('button', name='直す', exact=True).count() == 1, '申し送り：自分が書いた物に「直す」が出る')
    sheet.get_by_role('button', name='直す', exact=True).click(); pg.wait_for_timeout(300)
    ok(pg.locator('#note-input').input_value() == '見本：直す申し送り', '申し送り：文が入力欄に入る')
    ok(sheet.get_by_role('button', name='直して保存').count() == 1, '申し送り：ボタンが「直して保存」になる')
    pg.fill('#note-input', '見本：直した申し送り'); sheet.get_by_role('button', name='直して保存').click(); pg.wait_for_timeout(600)
    ok(sheet.get_by_text('見本：直した申し送り').count() >= 1 and sheet.get_by_text('見本：直す申し送り').count() == 0, '申し送り：直した文になる')
    ok(pg.locator('#note-input').input_value() == '' and sheet.get_by_role('button', name='送る').count() == 1, '申し送り：保存後は送る状態に戻る')
    ok(not errs, 'JSエラーなし ' + str(errs))
    b.close()
print('FAIL', fails) if fails else print('ALL OK')
raise SystemExit(1 if fails else 0)
