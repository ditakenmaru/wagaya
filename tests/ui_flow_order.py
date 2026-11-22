"""今日の流れの並び：これから → 時刻を過ぎてまだ → 済（見本モード）。python3 -m http.server 8765 を起動してから実行"""
import os
from playwright.sync_api import sync_playwright
PORT = os.environ.get('WAGAYA_PORT', '8765')
fails = 0
def ok(c, m):
    global fails
    if not c: fails += 1
    print('ok' if c else 'NG', m)
def order(pg, names):
    t = pg.locator('main, body').first.inner_text()
    pos = [t.find(n) for n in names]
    return pos
with sync_playwright() as p:
    b = p.chromium.launch()
    for hh, label in ((5, '朝5時'), (19, '夜19時')):
        pg = b.new_page(viewport={'width': 390, 'height': 844})
        pg.clock.install(time='2026-11-23T%02d:00:00' % hh)
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('http://localhost:%s/index.html?demo=1' % PORT); pg.wait_for_timeout(1800)
        sec = pg.locator('section, div').filter(has=pg.locator('#sec-flow')).last
        t = pg.locator('body').inner_text()
        a, z = t.find('起こして朝ごはん', t.find('今日の流れ') if '今日の流れ' in t else 0), t.find('寝かしつけ', t.find('今日の流れ') if '今日の流れ' in t else 0)
        if hh == 5:
            ok(0 <= a < z, label + '：朝の物が先（これから）')
        else:
            ok(0 <= z < a, label + '：朝が過ぎたら夜の物（寝かしつけ）が朝の物より上')
        ok(not errs, label + ' JSエラーなし ' + str(errs))
        pg.close()
    b.close()
print('FAIL', fails) if fails else print('ALL OK')
raise SystemExit(1 if fails else 0)
