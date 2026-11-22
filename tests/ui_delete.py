"""相談・決まったこと・申し送りの「消す」（2回押し）：見本モード。python3 -m http.server 8765 を起動してから実行（別のポートなら WAGAYA_PORT）"""
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
    # 相談カード
    pg.get_by_text('＋ 相談').first.click(); pg.wait_for_timeout(300)
    pg.fill('#ed-q', '見本：消す相談'); pg.get_by_role('button', name='保存').first.click(); pg.wait_for_timeout(600)
    card = pg.locator('.dcard', has_text='見本：消す相談')
    ok(card.count() == 1, '相談カードができる')
    card.get_by_role('button', name='消す', exact=True).click(); pg.wait_for_timeout(200)
    ok(pg.locator('.dcard', has_text='見本：消す相談').count() == 1, '1回目では消えない')
    ok(pg.locator('.dcard', has_text='見本：消す相談').get_by_role('button', name='もう一度で消す').count() == 1, '1回目で「もう一度で消す」に変わる')
    pg.locator('.dcard', has_text='見本：消す相談').get_by_role('button', name='もう一度で消す').click(); pg.wait_for_timeout(500)
    ok(pg.locator('.dcard', has_text='見本：消す相談').count() == 0, '2回目で消える')
    # 決まったこと（アーカイブ）
    pg.get_by_text('決まったこと（アーカイブ').first.click(); pg.wait_for_timeout(400)
    n0 = pg.locator('article[role="listitem"]', has_text='決まった').count()
    ok(n0 >= 1, 'アーカイブに見本がある')
    art = pg.locator('article[role="listitem"]', has_text='✓ 決まった').first
    art.get_by_role('button', name='消す', exact=True).click(); pg.wait_for_timeout(200)
    art = pg.locator('article[role="listitem"]', has_text='✓ 決まった').first
    art.get_by_role('button', name='もう一度で消す').click(); pg.wait_for_timeout(500)
    ok(pg.locator('article[role="listitem"]', has_text='✓ 決まった').count() == n0 - 1, 'アーカイブからも消せる')
    # 申し送り（自分が書いた物だけ消せる）
    pg.get_by_role('button', name='相談・連絡').first.click(); pg.wait_for_timeout(500)
    pg.get_by_role('button').filter(has_text='申し送り').first.click(); pg.wait_for_timeout(600)
    pg.fill('#note-input', '見本：消す申し送り'); pg.get_by_role('button', name='送る').last.click(); pg.wait_for_timeout(800)
    note = pg.locator('div', has=pg.locator('p', has_text='見本：消す申し送り')).filter(has=pg.get_by_role('button', name='返信')).last
    ok(note.get_by_role('button', name='消す', exact=True).count() == 1, '申し送り：自分が書いた物に「消す」が出る')
    ok(pg.locator('[aria-labelledby="notes-title"]').get_by_role('button', name='消す', exact=True).count() == 1, '申し送り：他の人が書いた物・担当替えの頼みには出ない')
    note.get_by_role('button', name='消す', exact=True).click(); pg.wait_for_timeout(200)
    pg.get_by_role('button', name='もう一度で消す').click(); pg.wait_for_timeout(500)
    ok(pg.locator('p', has_text='見本：消す申し送り').count() == 0, '申し送り：2回目で消える')
    ok(not errs, 'エラーなし ' + str(errs))
    b.close()
raise SystemExit(1 if fails else 0)
