"""過去の日記（アーカイブ）：見本モード。python3 -m http.server 8765 を起動してから実行"""
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
    pg.goto('http://localhost:%s/index.html?demo=1' % PORT); pg.wait_for_timeout(1800)
    t = pg.locator('[data-diary-archive]')
    ok(t.count() == 1 and '3件' in t.inner_text(), '「過去の日記（アーカイブ 3件）」が出る')
    ok(pg.get_by_text('お風呂でふたりとも').count() == 0, '閉じている時は中身を出さない')
    t.scroll_into_view_if_needed(); t.click(); pg.wait_for_timeout(300)
    ok(pg.get_by_text('お風呂でふたりとも').count() == 1 and pg.get_by_text('公園で初めて滑り台').count() == 1, '開くと日ごとに並ぶ')
    pos = pg.locator('body').inner_text()
    ok(pos.find('お風呂でふたりとも') < pos.find('朝ごはんをよく食べた') < pos.find('公園で初めて'), '新しい日・遅い時刻が上')
    more = pg.get_by_role('button', name='続きを読む')
    ok(more.count() >= 1, '長い日記は「続きを読む」')
    t.screenshot(path='/tmp/diary_arch.png')
    more.first.click(); pg.wait_for_timeout(200)
    ok(pg.get_by_role('button', name='閉じる ⌃').count() >= 1, '開くと「閉じる」')
    t.click(); pg.wait_for_timeout(200)
    ok(pg.get_by_text('お風呂でふたりとも').count() == 0, 'もう一度押すと閉じる')
    ok(not errs, 'JSエラーなし ' + str(errs))
    b.close()
print('FAIL', fails) if fails else print('ALL OK')
raise SystemExit(1 if fails else 0)
