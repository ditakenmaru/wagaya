"""予定：4週間のカレンダーと、‹ › で4週間ずつ先へ・戻る（見本モード）"""
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
    grid = sec.locator('[role=group][aria-label*="のカレンダー"]')
    # ホーム：カレンダーは2週間ぶん、送るボタンは出さない（しぼっている間）
    ok(grid.locator('> div').count() == 2, 'ホームのカレンダーは2週間ぶん')
    ok(sec.get_by_role('button', name='次の4週間へ').count() == 0, 'ホームでしぼっている間は ‹ › を出さない')
    ok('4週間の予定をすべて見る' in (sec.inner_text()), 'ホームの「すべて見る」は4週間')
    # 予定のタブ：4週間ぶんと ‹ ›
    def go(name):
        pg.locator('nav[aria-label=画面の切り替え] button', has_text=name).click(); pg.wait_for_timeout(700)
    go('予定')
    sec = pg.locator('[data-sec=plan]'); grid = sec.locator('[role=group][aria-label*="のカレンダー"]')
    nav = sec.locator('[role=group][aria-label="カレンダーを4週間ずつ送る"]')
    prev = nav.get_by_role('button', name='前の4週間へ'); nxt = nav.get_by_role('button', name='次の4週間へ')
    ok(grid.locator('> div').count() == 4 and grid.locator('button').count() == 28, '予定のタブのカレンダーは4週間（28日）')
    ok(nav.count() == 1 and prev.get_attribute('aria-disabled') == 'true' and nxt.get_attribute('aria-disabled') == 'false', '‹ は止まり、› は押せる（今日のページ）')
    ok('今日から4週間' in nav.inner_text() and '今日' in grid.inner_text(), '真ん中に「今日から4週間」、カレンダーに「今日」')
    first = grid.locator('button').first.get_attribute('aria-label')
    prev.click(force=True); pg.wait_for_timeout(300)
    ok(grid.locator('button').first.get_attribute('aria-label') == first, '今日より前へは戻らない')
    # 先へ
    nxt.click(); pg.wait_for_timeout(700)
    txt = sec.inner_text()
    ok('見本：その先の予定' in txt and '見本：帰省' in txt and '保育園お迎え' not in txt, '次の4週間：そのページの予定だけが出る')
    ok('今日' not in grid.inner_text() and grid.locator('button').count() == 28 and '〜' in nav.inner_text(), '先のページ：カレンダーに「今日」は無く、真ん中は日付の範囲')
    ok(grid.locator('button').first.get_attribute('aria-label') != first and prev.get_attribute('aria-disabled') == 'false', '先のページでは ‹ が押せる')
    ok(sec.locator('span', has_text='見本：帰省').count() >= 1, 'カレンダーに続く予定の帯が出る')
    # さらに先へ → 戻る → 今日へ
    nxt.click(); pg.wait_for_timeout(700)
    second = grid.locator('button').first.get_attribute('aria-label')
    prev.click(); pg.wait_for_timeout(400)
    ok(grid.locator('button').first.get_attribute('aria-label') != second and '見本：その先の予定' in sec.inner_text(), '‹ で1つ戻る（読んだページは覚えている）')
    nxt.click(); pg.wait_for_timeout(400)
    sec.get_by_role('button', name='今日へ').click(); pg.wait_for_timeout(400)
    ok(grid.locator('button').first.get_attribute('aria-label') == first and '保育園お迎え' in sec.inner_text() and sec.get_by_role('button', name='今日へ').count() == 0, '「今日へ」で今日のページに戻る')
    # 一覧の下の「次の4週間へ ›」も同じ動き
    sec.get_by_role('button', name='次の4週間へ ›').click(); pg.wait_for_timeout(500)
    ok('見本：その先の予定' in sec.inner_text(), '一覧の下の「次の4週間へ」でも進む')
    # タブを移ると今日のページに戻る
    go('ホーム'); go('予定')
    sec = pg.locator('[data-sec=plan]'); grid = sec.locator('[role=group][aria-label*="のカレンダー"]')
    ok(grid.locator('button').first.get_attribute('aria-label') == first, 'タブを移って戻ると今日のページ')
    b.close()
print('errors:', errors)
sys.exit(1 if errors else 0)
