"""新しいセクション（ふたりで決めること・期限・今週末・献立→買い物・夜の並び・旅行中）を見本モードで確かめる。
python3 -m http.server 8765 を立ててから実行する（ポートは環境変数 WAGAYA_PORT で変えられる）。"""
import asyncio, os
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

        # 下のタブ：今日／ふたりで／ごはん／予定／ニュース（見本は とと でログイン）
        nav = page.locator('nav[aria-label=画面の切り替え] button')
        labels = [ (await nav.nth(i).inner_text()).strip() for i in range(await nav.count()) ]
        print('nav tabs:', labels)
        async def go(name):
            await page.locator('nav[aria-label=画面の切り替え] button', has_text=name).click(); await page.wait_for_timeout(500)
        print('home shows hero and shop:', await page.locator('[data-sec=hero]').is_visible() and await page.locator('[data-sec=shop]').is_visible())
        await page.screenshot(path='/tmp/s_nav_today.png')
        await go('相談・連絡')
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
        # 来週の献立：週を「来週」に送る → 来週の火曜（見本：豚汁）
        wsec = page.locator('section[aria-labelledby=sec-week]')
        await wsec.get_by_role('group', name='週を選ぶ').get_by_role('button', name='来週').click(); await page.wait_for_timeout(400)
        await wsec.get_by_role('group', name='曜日を選ぶ').get_by_role('button').nth(2).click(); await page.wait_for_timeout(500)
        t = await wsec.inner_text()
        print('next week menu shown:', '見本：豚汁' in t and '来週火曜の夕ごはん' in t)
        # 来週の日にも献立を入れられる（水曜は空き）
        await wsec.get_by_role('group', name='曜日を選ぶ').get_by_role('button').nth(3).click(); await page.wait_for_timeout(300)
        await wsec.get_by_role('button', name='献立を入れる').click(); await page.wait_for_timeout(300)
        await page.fill('#ed-dish', '見本：焼き魚'); await page.fill('#ed-ings', '見本の魚 2切れ')
        await page.get_by_role('button', name='保存する').click(); await page.wait_for_timeout(500)
        print('next week menu saved:', '見本：焼き魚' in await wsec.inner_text())
        # 材料を送る前のシート：品ごとに行き先を選ぶ
        await wsec.get_by_role('group', name='曜日を選ぶ').get_by_role('button').nth(2).click(); await page.wait_for_timeout(400)
        await wsec.get_by_role('button', name='材料を買い物リストへ').click(); await page.wait_for_timeout(500)
        sheet = page.locator('section[aria-labelledby=ed-title]')
        rows = sheet.locator('[data-toshop]')
        rtext = [ (await rows.nth(i).inner_text()) for i in range(await rows.count()) ]
        daikon = [x for x in rtext if '大根' in x]
        print('sheet: 大根 is on list, no choice:', len(daikon) == 1 and 'リストにある' in daikon[0] and await sheet.get_by_role('group', name='大根をどこで買うか').count() == 0)
        pork = sheet.get_by_role('group', name='豚こま肉をどこで買うか')
        carrot = sheet.get_by_role('group', name='にんじんをどこで買うか')
        miso = sheet.get_by_role('group', name='みそをどこで買うか')
        print('sheet defaults: last category / shop:', await pork.get_by_role('button', name='WEBで頼む（冷凍・重いもの）').get_attribute('aria-pressed') == 'true'
              and await carrot.get_by_role('button', name='お店で買う').get_attribute('aria-pressed') == 'true'
              and await miso.get_by_role('button', name='お店で買う').get_attribute('aria-pressed') == 'true')
        await miso.get_by_role('button', name='家にある').click(); await page.wait_for_timeout(300)
        await page.screenshot(path='/tmp/s_toshop.png')
        print('send label counts 2:', await sheet.get_by_role('button', name='2品をまとめて送る').count() == 1)
        await sheet.get_by_role('button', name='2品をまとめて送る').click(); await page.wait_for_timeout(500)
        toast = await page.locator('[role=status][aria-live]').inner_text()
        print('menu to shop toast:', '2品' in toast and '家にある 1品' in toast, toast.strip()[:60])
        shop = page.locator('section[aria-labelledby=sec-shop]')
        groups = await shop.evaluate('''el => { const o = {}; el.querySelectorAll('button[aria-pressed]').forEach(b => { const box = b.parentElement, p = box && box.querySelector(':scope > p'); if (!p) return; const n = b.querySelector('span:nth-of-type(2)'); if (n) (o[p.textContent.trim()] = o[p.textContent.trim()] || []).push(n.textContent.trim()); }); return o; }''')
        print('sent to chosen categories, home item not sent:', '豚こま肉' in groups.get('WEBで頼む（冷凍・重いもの）', []) and 'にんじん' in groups.get('お店で買う', []) and not any('みそ' in v for v in groups.values()), groups)
        # 買い物の品名の横に、どの献立の材料か
        tags = shop.locator('[data-formenu]')
        tag_text = [ (await tags.nth(i).inner_text()) for i in range(await tags.count()) ]
        print('shop shows which menu:', any('豚汁' in x for x in tag_text) and any(x.startswith('来週火・木') or '・来週火・木' in x for x in tag_text), tag_text)
        await page.screenshot(path='/tmp/s_shop_formenu.png')
        await wsec.get_by_role('group', name='週を選ぶ').get_by_role('button', name='今週').click(); await page.wait_for_timeout(300)
        print('back to this week shows 今日:', '今日' in await wsec.get_by_role('group', name='曜日を選ぶ').inner_text())
        dow = await page.evaluate('new Date().getDay()')
        if dow >= 2:   # 今週の月曜（過ぎた日）には「材料を買い物リストへ」を出さない
            await wsec.get_by_role('group', name='曜日を選ぶ').get_by_role('button').nth(1).click(); await page.wait_for_timeout(300)
            print('past day hides send button:', await wsec.get_by_role('button', name='材料を買い物リストへ').count() == 0 and '鶏と大根の煮物' in await wsec.inner_text())

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
