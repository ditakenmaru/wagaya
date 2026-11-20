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
        print('who sheet has other days:', '別の日を代わってほしい' in t and '明日' in t, '| tomorrow already taken:', '代わってもらう' in t)
        await page.screenshot(path='/tmp/ask_sheet.png')
        # 明日を押す → 申し送りの下書き
        chip = page.get_by_role('button', name=re.compile('頼む$')).first
        chipName = (await chip.inner_text()).split('\n')[0]
        await chip.click(); await page.wait_for_timeout(400)
        draft = await page.locator('#kizuki-input').input_value()
        print('draft:', draft)
        btn = page.get_by_role('button', name='の担当を代わってほしい')
        print('ask toggle label:', (await btn.inner_text()).strip(), await btn.get_attribute('aria-pressed'))
        await page.screenshot(path='/tmp/ask_compose.png')
        await page.get_by_role('button', name='送る', exact=True).click(); await page.wait_for_timeout(600)
        # 送った頼みは、もう一度開くと「返事待ち」
        await row.scroll_into_view_if_needed(); await row.click(); await page.wait_for_timeout(400)
        t2 = await page.get_by_role('button', name=chipName).first.inner_text()
        print('second open shows waiting:', '返事待ち' in t2)
        await page.screenshot(path='/tmp/ask_sheet2.png')
        # 見本：明日の「起こして朝ごはん」は まま が引き受け済み → 申し送りの「やっぱり自分でやる」を2回押して取り消す
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        await page.goto(URL); await page.wait_for_timeout(1500)
        await page.locator('nav[aria-label=画面の切り替え] button', has_text='相談・連絡').click(); await page.wait_for_timeout(500)
        await page.get_by_role('button', name='申し送り').first.click(); await page.wait_for_timeout(500)
        cbtn = page.get_by_role('button', name='やっぱり自分でやる')
        print('cancel button shown:', await cbtn.count() == 1)
        await cbtn.scroll_into_view_if_needed(); await cbtn.click(); await page.wait_for_timeout(200)
        armed = page.get_by_role('button', name='もう一度で取り消す')
        print('armed:', await armed.count() == 1)
        await page.screenshot(path='/tmp/ask_cancel_armed.png')
        await armed.click(); await page.wait_for_timeout(600)
        body = await page.locator('body').inner_text()
        print('canceled text:', 'ととの担当に戻りました' in body, '| toast:', '自分でやります' in body)
        await page.screenshot(path='/tmp/ask_cancel_done.png')
        # 引き受けた側：見本の「寝かしつけ」（ままから、今日）を「代わる」→「戻してもらえる？と頼む」が出る（一方的には戻せない）
        await page.get_by_role('button', name='代わる', exact=True).first.click(); await page.wait_for_timeout(600)
        back = page.get_by_role('button', name='戻してもらえる？と頼む')
        print('ask-back shown:', await back.count() >= 1, '| no unilateral cancel for helper:', await page.get_by_role('button', name='やっぱりむずかしい').count() == 0)
        await back.first.scroll_into_view_if_needed(); await back.first.click(); await page.wait_for_timeout(500)
        print('ask-back draft:', await page.locator('#kizuki-input').input_value())
        await page.screenshot(path='/tmp/ask_back.png')
        await page.get_by_role('button', name='送る', exact=True).last.click(); await page.wait_for_timeout(700)
        body = await page.locator('body').inner_text()
        print('ask-back sent, toast:', '返事があるまでは自分の担当のままです' in body, '| waiting shown:', '戻してもらえるか頼み中' in body, '| no 2nd ask-back:', await page.get_by_role('button', name='戻してもらえる？と頼む').count() == 0)
        print('errors:', errs)
        await b.close()

asyncio.run(main())
