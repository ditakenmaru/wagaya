"""添付の送信中に「保存」→ 画面を閉じて下に「送っています」、終わったら自動で保存（見本モード）。python3 -m http.server 8765 を起動してから実行"""
import os, base64
from playwright.sync_api import sync_playwright
PORT = os.environ.get('WAGAYA_PORT', '8765')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
fails = 0
def ok(c, m):
    global fails
    if not c: fails += 1
    print('ok' if c else 'NG', m)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 844})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    # 画像の読み込みを1.5秒遅らせて「送信中」を作る
    pg.add_init_script("""if(window.createImageBitmap){const o=window.createImageBitmap.bind(window);window.createImageBitmap=(...a)=>new Promise(r=>setTimeout(()=>r(o(...a)),1500));}const d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');Object.defineProperty(HTMLImageElement.prototype,'src',{set(v){const t=this;setTimeout(()=>d.set.call(t,v),1500)},get(){return d.get.call(this)}});""")
    pg.goto('http://localhost:%s/index.html?demo=1' % PORT); pg.wait_for_timeout(1500)
    pg.get_by_text('＋ 相談').first.click(); pg.wait_for_timeout(400)
    pg.fill('#ed-q', '見本：送信中に保存')
    pg.set_input_files('#attach-pick', [{'name': 'a.png', 'mimeType': 'image/png', 'buffer': PNG}]); pg.wait_for_timeout(300)
    pg.get_by_role('button', name='保存').first.click(); pg.wait_for_timeout(400)
    ok(pg.locator('[data-upbar]').count() == 1, '送信中に保存：下に「送っています」が出る')
    ok(not pg.locator('#ed-q').is_visible(), '送信中に保存：編集画面はすぐ閉じる')
    ok(pg.locator('.dcard', has_text='見本：送信中に保存').count() == 0, '送信中に保存：まだ相談は作られない')
    pg.wait_for_timeout(2500)
    ok(pg.locator('[data-upbar]').count() == 0, '終わると下の表示が消える')
    card = pg.locator('.dcard', has_text='見本：送信中に保存')
    ok(card.count() == 1 and card.locator('button[aria-label*="画像"], img').count() >= 1, '終わると相談が添付つきで保存される')
    ok(not errs, 'JSエラーなし ' + str(errs))
    b.close()
print('FAIL', fails) if fails else print('ALL OK')
raise SystemExit(1 if fails else 0)
