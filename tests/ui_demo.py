import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, has_touch=True)
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8765/index.html?demo=1')
        await page.wait_for_timeout(1500)
        # flow edit
        await page.get_by_role('button', name='直す', exact=True).first.click(); await page.wait_for_timeout(400)
        await page.locator('#sec-flow').scroll_into_view_if_needed(); await page.wait_for_timeout(400)
        await page.screenshot(path='/tmp/u_flowedit.png')
        await page.get_by_role('button', name='ゴミ出し').click(); await page.wait_for_timeout(600)
        await page.screenshot(path='/tmp/u_editor.png')
        # change to 今日だけ and save
        await page.get_by_role('button', name='今日だけ').click(); await page.wait_for_timeout(200)
        await page.get_by_role('button', name='保存する').click(); await page.wait_for_timeout(600)
        await page.get_by_role('button', name='完了').first.click(); await page.wait_for_timeout(400)
        txt = await page.locator('section[aria-labelledby=sec-flow]').inner_text()
        print('flow has ゴミ出し today-only:', 'ゴミ出し' in txt and '今日だけ' in txt)
        # add new duty
        await page.get_by_role('button', name='担当を足す').click(); await page.wait_for_timeout(400)
        await page.fill('#ed-task', '薬を飲ませる'); await page.fill('#ed-time', '19:30')
        await page.get_by_role('button', name='保存する').click(); await page.wait_for_timeout(500)
        txt = await page.locator('section[aria-labelledby=sec-flow]').inner_text()
        print('new duty shown:', '薬を飲ませる' in txt)
        # 時刻なし・消す2回押し
        await page.get_by_role('button', name='担当を足す').click(); await page.wait_for_timeout(300)
        await page.fill('#ed-task', '洗濯物をたたむ'); await page.get_by_role('button', name='時刻なし').click(); await page.wait_for_timeout(200)
        await page.screenshot(path='/tmp/u_notime.png')
        await page.get_by_role('button', name='保存する').click(); await page.wait_for_timeout(400)
        txt = await page.locator('section[aria-labelledby=sec-flow]').inner_text()
        print('no-time duty as いつでも:', 'いつでも' in txt and '洗濯物をたたむ' in txt)
        await page.get_by_role('button', name='直す', exact=True).first.click(); await page.wait_for_timeout(300)
        await page.get_by_role('button', name='洗濯物をたたむ').click(); await page.wait_for_timeout(300)
        await page.get_by_role('button', name='消す', exact=True).click(); await page.wait_for_timeout(200)
        still = await page.get_by_role('button', name='本当に消す（もう一度押す）').count()
        await page.get_by_role('button', name='本当に消す（もう一度押す）').click(); await page.wait_for_timeout(400)
        txt = await page.locator('section[aria-labelledby=sec-flow]').inner_text()
        print('two-step delete:', still == 1 and '洗濯物をたたむ' not in txt)
        await page.get_by_role('button', name='完了').first.click(); await page.wait_for_timeout(300)
        # topics
        await page.locator('#sec-topics').scroll_into_view_if_needed(); await page.wait_for_timeout(500)
        await page.screenshot(path='/tmp/u_topics.png')
        # shop
        for i in range(10):
            await page.mouse.wheel(0, 600); await page.wait_for_timeout(200)
        await page.locator('#w-shop').scroll_into_view_if_needed(); await page.wait_for_timeout(1200)
        await page.locator('#w-shop').screenshot(path='/tmp/u_shop.png')
        await page.get_by_role('button', name='＋ 牛乳').click(); await page.wait_for_timeout(400)
        await page.get_by_label('足す品名').fill('卵'); await page.get_by_label('足す品名').press('Enter'); await page.wait_for_timeout(400)
        st = await page.locator('#w-shop').inner_text()
        print('shop has 牛乳 & 卵:', '牛乳' in st and '卵' in st, '| suggest 牛乳 removed:', '＋ 牛乳' not in st)
        # feedback
        await page.get_by_role('button', name='アプリへの要望・不具合を書く').click(); await page.wait_for_timeout(500)
        await page.screenshot(path='/tmp/u_fb.png')
        print('errors:', errs)
        await b.close()
asyncio.run(main())
