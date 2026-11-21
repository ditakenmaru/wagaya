"""右上のメニューの「移動」（各セクションへ）を見本モードで確かめる。python3 -m http.server 8765 を立ててから実行。"""
import asyncio, os
from playwright.async_api import async_playwright

URL = 'http://localhost:%s/index.html?demo=1' % os.environ.get('WAGAYA_PORT', '8765')


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await (await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, locale='ja-JP')).new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(1500)
        await page.locator('button[aria-label^="メニュー"]').click(); await page.wait_for_timeout(500)
        nav = page.locator('nav[aria-labelledby=nav-title]')
        print('groups:', (await nav.inner_text()).replace('\n', ' | ')[:300])
        await page.screenshot(path='/tmp/menu_nav.png')
        # 「買い物」へ
        await nav.get_by_role('button', name='買い物').first.click(); await page.wait_for_timeout(900)
        cur = await page.locator('[aria-current=page]').first.inner_text()
        top = await page.evaluate("(() => { const el = document.querySelector('[data-sec=shop]'); return el ? Math.round(el.getBoundingClientRect().top) : null; })()")
        print('after 買い物: tab', cur.strip(), '| shop top', top, '| sheet closed:', await nav.is_hidden())
        # 申し送り
        await page.locator('button[aria-label^="メニュー"]').click(); await page.wait_for_timeout(400)
        await nav.get_by_role('button', name='申し送り').click(); await page.wait_for_timeout(600)
        print('notes open:', await page.locator('text=申し送り').count() > 0)
        print('errors:', errs)
        await b.close()

asyncio.run(main())
