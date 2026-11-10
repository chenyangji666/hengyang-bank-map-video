# -*- coding: utf-8 -*-
"""渲染若干关键帧做视觉预览。"""
import asyncio, os, sys
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "output", "preview")
URL = "http://127.0.0.1:8765/src/index.html"


async def main():
    os.makedirs(OUT, exist_ok=True)
    times = [float(x) for x in (sys.argv[1:] or [4, 18, 34, 44, 56, 68, 84, 96, 112, 120])]
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
            "--disable-lcd-text", "--hide-scrollbars",
        ])
        page = await browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        page.on("console", lambda m: print("CONSOLE", m.type, m.text[:200]))
        page.on("pageerror", lambda e: print("PAGEERROR", str(e)[:300]))
        await page.goto(URL, wait_until="load")
        await page.wait_for_function("window.READY === true", timeout=60000)
        print("timeline", await page.evaluate("window.TIMELINE.total"))
        await page.evaluate("window.preWarm(1.5)")
        for t in times:
            await page.evaluate("t => window.renderAt(t)", t)
            await page.wait_for_timeout(120)
            p = os.path.join(OUT, f"t{t:06.1f}.png")
            await page.screenshot(path=p)
            print("shot", p)
        await browser.close()


asyncio.run(main())
