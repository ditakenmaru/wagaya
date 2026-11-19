"""新しいセクション（ふたりで決めること・期限・今週末・献立→買い物・夜の並び・旅行中）を見本モードで確かめる。
python3 -m http.server 8765 を立ててから実行する。"""
import asyncio
from playwright.async_api import async_playwright

URL = 'http://localhost:8765/index.html?demo=1'


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, locale='ja-JP')
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_timeout(1500)

        # 下のタブ：今日／ふたりで／ごはん／予定／ニュース（見本は とと でログイン）
        nav = page.locator('nav[aria-label=画面の切り替え] button')
        labels = [ (await nav.nth(i).inner_text()).strip() for i in range(await nav.count()) ]
        print('nav tabs:', labels)
        async def go(name):
            await page.locator('nav[aria-label=画面の切り替え] button', has_text=name).click(); await page.wait_for_timeout(500)
        print('home shows hero and shop:', await page.locator('[data-sec=hero]').is_visible() and await page.locator('[data-sec=shop]').is_visible())
        await page.screenshot(path='/tmp/s_nav_today.png')
        await go('ふたりで')
        print('two: notes card + decide, no hero:', await page.get_by_role('button', name='申し送り').first.is_visible() and await page.locator('[data-sec=decide]').is_visible() and not await page.locator('[data-sec=hero]').is_visible())
        await page.screenshot(path='/tmp/s_nav_two.png')

        # ふたりで決めること：自分（とと）は答え済み。ままの答え待ち → 決まりにはできない
        dec = page.locator('section[aria-labelledby=sec-decide]')
        await dec.scroll_into_view_if_needed()
        t = await dec.inner_text()
        print('decide shows waiting for mama:', 'ままの答え待ち' in t and 'これで決まりにする' not in t)
        await page.screenshot(path='/tmp/s_decide.png')
        # 新しい相談を足す
        await page.get_by_role('button', name='相談を足す').click(); await page.wait_for_timeout(300)
        await page.fill('#ed-q', 'ホットクックのセットは誰？')
        await page.fill('#ed-opts', 'とと\nまま')
        await page.get_by_role('button', name='保存する').click(); await page.wait_for_timeout(400)
        t = await dec.inner_text()
        print('new decision listed:', 'ホットクックのセットは誰？' in t and '話したい' in t)
        await page.get_by_role('button', name='まま', exact=True).last.click(); await page.wait_for_timeout(300)

        # 期限
        dl = page.locator('section[aria-labelledby=sec-deadline]')
        await dl.scroll_into_view_if_needed()
        t = await dl.inner_text()
        print('deadline today label:', '（今日）' in t)
        await page.get_by_role('button', name='済にする').first.click(); await page.wait_for_timeout(300)
        await page.get_by_role('button', name='期限を足す').click(); await page.wait_for_timeout(300)
        await page.fill('#ed-what', 'パスポートを受け取る')
        await page.get_by_role('button', name='保存する').click(); await page.wait_for_timeout(400)
        t = await dl.inner_text()
        print('deadline added:', 'パスポートを受け取る' in t)
        await page.screenshot(path='/tmp/s_deadline.png')

        # 献立 → 買い物
        await go('ごはん'); await page.wait_for_timeout(800)
        print('food: week+shop visible:', await page.locator('[data-sec=week]').is_visible() and await page.locator('[data-sec=shop]').is_visible())
        await page.screenshot(path='/tmp/s_nav_food.png')
        wk = page.locator('#w-week'); await wk.scroll_into_view_if_needed(); await page.wait_for_timeout(1200)
        btn = page.get_by_role('button', name='材料を買い物リストへ')
        if await btn.count():
            await btn.click(); await page.wait_for_timeout(400)
            toast = await page.locator('[role=status][aria-live]').inner_text()
            print('menu to shop toast:', '買い物リストに足しました' in toast or 'もう全部リストにあります' in toast, toast.strip()[:40])
        else:
            print('menu to shop: no ingredients today (ok)')

        # 今週末
        await go('予定')
        await page.screenshot(path='/tmp/s_nav_plan.png')
        we = page.locator('section[aria-labelledby=sec-weekend]')
        await we.scroll_into_view_if_needed(); await page.wait_for_timeout(500)
        t0 = await we.inner_text()
        print('outing needs both:', 'ととも「行きたい」を押すと' in t0 and 'に行く' not in t0)
        await we.get_by_role('button', name='行きたい').first.click(); await page.wait_for_timeout(300)
        await we.get_by_role('button', name='に行く').first.click(); await page.wait_for_timeout(400)
        t = await we.inner_text()
        print('outing planned:', 'に行く' in t and 'やめる' in t)
        await page.screenshot(path='/tmp/s_weekend.png')

        # ニュースは見る人＝人1（見本は とと でログイン → 出る）
        await go('ニュース')
        print('news visible for p1:', await page.locator('[data-sec=news]').is_visible())
        print('errors:', errs)
        await b.close()

asyncio.run(main())
