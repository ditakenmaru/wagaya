"""大項目と小項目（今日の流れ）を見本モードで確かめる。python3 -m http.server 8765 を立ててから実行。"""
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
        await page.goto(URL); await page.wait_for_timeout(1500)
        more = page.locator('[data-sec=flow]').get_by_role('button', name=re.compile('すべて見る'))
        if await more.count(): await more.first.click(); await page.wait_for_timeout(400)
        grp = page.locator('[role=group][aria-label=小項目]').first
        await grp.scroll_into_view_if_needed()
        subs = grp.locator('button')
        print('subs:', await subs.count(), [ (await subs.nth(i).inner_text()).strip() for i in range(await subs.count()) ])
        parent = page.get_by_role('button', name='朝の準備')
        print('parent count label:', '0 / 3' in await parent.first.inner_text())
        await page.screenshot(path='/tmp/sub_0.png')
        # 大項目を押す → 小項目も全部済
        await parent.first.click(); await page.wait_for_timeout(400)
        states = [await subs.nth(i).get_attribute('aria-pressed') for i in range(3)]
        print('parent check -> all subs:', states, await parent.first.get_attribute('aria-pressed'))
        await page.screenshot(path='/tmp/sub_1.png')
        # 小項目を1つ外す → 大項目も外れる
        await subs.nth(1).click(); await page.wait_for_timeout(400)
        print('uncheck one -> parent:', await parent.first.get_attribute('aria-pressed'), '| label 2/3:', '2 / 3' in await parent.first.inner_text())
        # もう一度入れる → 大項目も済
        await subs.nth(1).click(); await page.wait_for_timeout(400)
        print('recheck -> parent:', await parent.first.get_attribute('aria-pressed'))
        # 大項目をもう一度 → 全部外れる
        await parent.first.click(); await page.wait_for_timeout(400)
        print('parent uncheck -> subs:', [await subs.nth(i).get_attribute('aria-pressed') for i in range(3)])
        # 2つ済 → 大項目を押す（全部済）→「元に戻す」で前の2つは済のまま
        await subs.nth(0).click(); await page.wait_for_timeout(300)
        await subs.nth(1).click(); await page.wait_for_timeout(300)
        await parent.first.click(); await page.wait_for_timeout(300)
        await page.get_by_role('button', name='元に戻す').click(); await page.wait_for_timeout(500)
        print('undo keeps earlier:', [await subs.nth(i).get_attribute('aria-pressed') for i in range(3)], await parent.first.get_attribute('aria-pressed'))
        await subs.nth(0).click(); await page.wait_for_timeout(300); await subs.nth(1).click(); await page.wait_for_timeout(300)
        # 編集：「直す」→ 一覧に字下げ → 大項目を開くと「小項目を足す」
        await page.get_by_role('button', name='直す', exact=True).first.click(); await page.wait_for_timeout(400)
        body = await page.locator('body').inner_text()
        print('edit list indented:', '└ 水筒の準備' in body)
        await page.locator('button', has_text='朝の準備').filter(has_text='毎日').first.click(); await page.wait_for_timeout(400)
        print('parent editor:', await page.get_by_role('button', name='＋ 小項目を足す').count() == 1, '| delete label:', await page.get_by_role('button', name='消す（小項目3件も）').count() == 1)
        priv = page.get_by_role('button', name='Museに渡さない')
        print('priv toggle:', await priv.count() == 1, await priv.get_attribute('aria-pressed'))
        await priv.click(); await page.wait_for_timeout(200)
        print('priv on:', await priv.get_attribute('aria-pressed'))
        await priv.click(); await page.wait_for_timeout(200)
        await page.get_by_role('button', name='＋ 小項目を足す').click(); await page.wait_for_timeout(400)
        await page.fill('#ed-task', 'ハンカチ')
        body = await page.locator('body').inner_text()
        print('child editor hides time:', await page.locator('#ed-time').count() == 0, '| hint:', '大項目「朝の準備」と同じ' in body)
        await page.screenshot(path='/tmp/sub_child_editor.png')
        await page.get_by_role('button', name='保存する').click(); await page.wait_for_timeout(500)
        body = await page.locator('body').inner_text()
        print('child added:', '└ ハンカチ' in body)
        print('errors:', errs)
        await b.close()

asyncio.run(main())
