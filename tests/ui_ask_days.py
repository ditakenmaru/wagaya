"""「別の日を代わってほしい」（翌日以降の担当を前もって頼む）を見本モードで確かめる。
python3 -m http.server 8765 を立ててから実行する（ポートは環境変数 WAGAYA_PORT）。"""
import asyncio, os, re
from playwright.async_api import async_playwright

URL = 'http://localhost:%s/index.html?demo=1' % os.environ.get('WAGAYA_PORT', '8765')


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, locale='ja-JP')
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_timeout(1500)
        # 見本は とと。「起こして朝ごはん」（毎日・とと）の名札を押す
        row = page.locator('button[aria-label^="担当：とと"]').first
        await row.scroll_into_view_if_needed(); await row.click(); await page.wait_for_timeout(400)
        t = await page.locator('body').inner_text()
        print('who sheet has other days:', '別の日を代わってほしい' in t and '明日' in t)
        await page.screenshot(path='/tmp/ask_sheet.png')
        # 明日を押す → 申し送りの下書き
        await page.get_by_role('button', name=re.compile('^明日 ')).first.click(); await page.wait_for_timeout(400)
        draft = await page.locator('#kizuki-input').input_value()
        print('draft:', draft)
        btn = page.get_by_role('button', name='の担当を代わってほしい')
        print('ask toggle label:', (await btn.inner_text()).strip(), await btn.get_attribute('aria-pressed'))
        await page.screenshot(path='/tmp/ask_compose.png')
        await page.get_by_role('button', name='送る', exact=True).click(); await page.wait_for_timeout(600)
        # 送った頼みは、もう一度開くと「返事待ち」
        await row.scroll_into_view_if_needed(); await row.click(); await page.wait_for_timeout(400)
        t2 = await page.get_by_role('button', name=re.compile('^明日 ')).first.inner_text()
        print('second open shows waiting:', '返事待ち' in t2)
        await page.screenshot(path='/tmp/ask_sheet2.png')
        print('errors:', errs)
        await b.close()

asyncio.run(main())
