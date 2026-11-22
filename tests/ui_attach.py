"""相談の添付（画像・PDF）：見本モード。python3 -m http.server 8765 を起動してから実行（別のポートなら WAGAYA_PORT）"""
import os, base64
from playwright.sync_api import sync_playwright
PORT = os.environ.get('WAGAYA_PORT', '8765')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
PDF = b'%PDF-1.4\ntrailer<</Root 1 0 R>>\n%%EOF'
fails = 0
def ok(c, m):
    global fails
    if not c: fails += 1
    print('ok' if c else 'NG', m)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 844})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:%s/index.html?demo=1' % PORT); pg.wait_for_timeout(1500)
    pg.get_by_text('＋ 相談').first.click(); pg.wait_for_timeout(400)
    pg.fill('#ed-q', '見本：家具の配置')
    pg.set_input_files('#attach-pick', [{'name': 'a.png', 'mimeType': 'image/png', 'buffer': PNG}, {'name': '見積.pdf', 'mimeType': 'application/pdf', 'buffer': PDF}, {'name': 'x.txt', 'mimeType': 'text/plain', 'buffer': b'x'}])
    pg.wait_for_timeout(1500)
    ok(pg.locator('button[aria-label^="外す"], button[aria-label$="を外す"]').count() == 2, '編集画面：画像とPDFが並ぶ（txtは入らない）')
    pg.locator('button[aria-label$="を外す"]').first.click(); pg.wait_for_timeout(200)
    ok(pg.locator('button[aria-label$="を外す"]').count() == 1, '編集画面：×で外せる')
    pg.set_input_files('#attach-pick', [{'name': 'b.png', 'mimeType': 'image/png', 'buffer': PNG}]); pg.wait_for_timeout(1200)
    ok(pg.locator('button[aria-label$="を外す"]').count() == 2, '編集画面：あとから足せる')
    pg.set_input_files('#attach-pick', [{'name': 'c%d.png' % i, 'mimeType': 'image/png', 'buffer': PNG} for i in range(3)]); pg.wait_for_timeout(1500)
    ok(pg.locator('button[aria-label$="を外す"]').count() == 3, '編集画面：3つまで')
    pg.get_by_role('button', name='保存').first.click(); pg.wait_for_timeout(700)
    card = pg.locator('.dcard', has_text='見本：家具の配置')
    ok(card.locator('button[aria-label^="画像を開く"], button[aria-label^="PDFを開く"]').count() == 3, 'カード：サムネイルが3つ出る')
    card.locator('button[aria-label^="画像を開く"]').first.click(); pg.wait_for_timeout(400)
    ok(pg.locator('div[aria-label="添付を見る"] img').count() == 1, '拡大表示が開く')
    pg.locator('div[aria-label="添付を見る"] button[aria-label="閉じる"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator('div[aria-label="添付を見る"]').count() == 0, '拡大表示を閉じる')
    card.get_by_text('詳細を見る').first.click(); pg.wait_for_timeout(500)
    ok(pg.locator('section[aria-labelledby="dt-title"] button[aria-label^="画像を開く"]').count() >= 1, '詳細：サムネイルが出る')
    ok(not errs, 'エラーなし ' + str(errs))
    b.close()
raise SystemExit(1 if fails else 0)
