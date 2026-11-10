# -*- coding: utf-8 -*-
"""逐帧渲染 → 直接管道送进 ffmpeg 编码，不落地中间图片。

用法：
  python scripts/render.py --out output/video_raw.mp4
  python scripts/render.py --out output/test.mp4 --from 60 --to 70
"""
import argparse, asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FF = r"C:\ffmpeg\bin\ffmpeg.exe"
URL = "http://127.0.0.1:8765/src/index.html"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "output", "video_raw.mp4"))
    ap.add_argument("--from", dest="t0", type=float, default=0.0)
    ap.add_argument("--to", dest="t1", type=float, default=None)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--skip-warm", action="store_true")
    args = ap.parse_args()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
            "--disable-lcd-text", "--hide-scrollbars", "--force-color-profile=srgb",
        ])
        page = await browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        page.on("pageerror", lambda e: print("PAGEERROR", str(e)[:300], flush=True))
        await page.goto(URL, wait_until="load")
        await page.wait_for_function("window.READY === true", timeout=90000)
        total = await page.evaluate("window.TIMELINE.total")
        t1 = args.t1 if args.t1 is not None else total
        print(f"timeline total={total:.2f}s, rendering {args.t0:.2f} → {t1:.2f}", flush=True)

        if not args.skip_warm:
            t = time.time()
            await page.evaluate("window.preWarm(1.0)")
            print(f"prewarm done in {time.time()-t:.1f}s", flush=True)

        n_frames = int(round((t1 - args.t0) * args.fps))
        cmd = [
            FF, "-y", "-nostats", "-loglevel", "error",
            "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", str(args.fps), "-i", "-",
            "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
            "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
            "-movflags", "+faststart", "-an", args.out,
        ]
        # 注意：stderr 不能走 PIPE——不读会把管道塞满，ffmpeg 卡住、stdin.close() 死锁
        errlog = open(args.out + ".ffmpeg.log", "wb")
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                stdout=subprocess.DEVNULL, stderr=errlog)
        t_start = time.time()
        try:
            for i in range(n_frames):
                t = args.t0 + i / args.fps
                await page.evaluate("t => window.renderAt(t)", t)
                img = await page.screenshot(type="jpeg", quality=96)
                proc.stdin.write(img)
                if i % 60 == 0:
                    el = time.time() - t_start
                    eta = el / (i + 1) * (n_frames - i - 1)
                    print(f"  frame {i}/{n_frames}  t={t:6.2f}s  elapsed {el:5.0f}s  eta {eta:5.0f}s", flush=True)
        finally:
            proc.stdin.close()
            rc = proc.wait()
            errlog.close()
            print("ffmpeg rc", rc, flush=True)
            if rc != 0:
                print(open(args.out + ".ffmpeg.log", encoding="utf-8", errors="ignore").read()[-1200:], flush=True)
        print(f"done in {time.time()-t_start:.1f}s → {args.out}", flush=True)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
