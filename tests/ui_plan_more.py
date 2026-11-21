"""予定：4週間のカレンダーと「その先の4週間を見る」（見本モード）"""
import os, sys
from playwright.sync_api import sync_playwright
PORT = os.environ.get('WAGAYA_PORT', '8765')
errors = []
def ok(c, m):
    print(('ok ' if c else 'NG ') + m)
    if not c: errors.append(m)
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 390, 'height': 844})
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto('http://localhost:%s/?demo=1' % PORT); pg.wait_for_timeout(1200)
    sec = pg.locator('[data-sec=plan]')
    sec.scroll_into_view_if_needed(); pg.wait_for_timeout(700)
    grid = sec.locator('[role=group][aria-label*="カレンダー"]')
    # ホーム：カレンダーは2週間ぶん、その先のボタンは出さない（しぼっている間）
    ok(grid.locator('> div').count() == 2, 'ホームのカレンダーは2週間ぶん')
    ok(sec.get_by_role('button', name='その先の4週間を見る').count() == 0, 'ホームでしぼっている間は「その先」を出さない')
    ok('4週間の予定をすべて見る' in (sec.inner_text()), 'ホームの「すべて見る」は4週間')
    # 予定のタブ：4週間ぶん
    pg.locator('nav[aria-label=画面の切り替え] button', has_text='予定').click(); pg.wait_for_timeout(700)
    sec = pg.locator('[data-sec=plan]'); grid = sec.locator('[role=group][aria-label*="カレンダー"]')
    ok(grid.locator('> div').count() == 4 and grid.locator('button').count() == 28, '予定のタブのカレンダーは4週間（28日）')
    ok('4週間' in (grid.get_attribute('aria-label') or ''), 'カレンダーの読み上げは4週間')
    btn = sec.get_by_role('button', name='その先の4週間を見る')
    ok(btn.count() == 1, '「その先の4週間を見る」が出る')
    btn.click(); pg.wait_for_timeout(700)
    txt = sec.inner_text()
    ok('見本：その先の予定' in txt and txt.count('見本：帰省') == 1 and 'まで読み込みました' in txt, 'その先の予定が一覧に足される（続く予定は1回だけ）')
    btn2 = sec.get_by_role('button', name='さらに先の4週間を見る')
    ok(btn2.count() == 1, 'ボタンが「さらに先」に変わる')
    btn2.click(); pg.wait_for_timeout(700)
    txt = sec.inner_text()
    ok(txt.count('見本：その先の予定') == 2 and txt.count('見本：帰省') == 2, 'さらに先も足される')
    ok(grid.locator('button').count() == 28, 'カレンダーは4週間のまま')
    b.close()
print('errors:', errors)
sys.exit(1 if errors else 0)
