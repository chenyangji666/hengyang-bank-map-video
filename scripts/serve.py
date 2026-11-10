# -*- coding: utf-8 -*-
"""本地静态服务器 + 高德卫星瓦片缓存代理。

- /                → 项目根目录静态文件
- /tiles/sat/z/x/y → 高德卫星影像（style=6），磁盘缓存
- /tiles/lbl/z/x/y → 高德路网注记（style=8），磁盘缓存
"""
import os, sys, threading, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CACHE = os.path.join(ROOT, "output", "tilecache")
os.makedirs(CACHE, exist_ok=True)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
_lock = threading.Lock()


def fetch(url, dst):
    if os.path.exists(dst) and os.path.getsize(dst) > 200:
        return True
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.amap.com/"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=25) as r:
            data = r.read()
        if len(data) < 200:
            return False
        tmp = dst + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dst)
        return True
    except Exception as e:
        print("tile fail", url, e, flush=True)
        return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/tiles/"):
            return self.tile(path)
        return super().do_GET()

    def tile(self, path):
        try:
            _, _, kind, z, x, y = path.split("/")
            y = y.split(".")[0]
            z, x, y = int(z), int(x), int(y)
        except Exception:
            self.send_error(400)
            return
        ext = "jpg" if kind == "sat" else "png"
        dst = os.path.join(CACHE, f"{kind}_{z}_{x}_{y}.{ext}")
        if kind == "sat":
            srv = 1 + (x + y) % 4
            url = f"https://webst0{srv}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}"
        else:
            srv = 1 + (x + y) % 4
            url = f"https://wprd0{srv}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=8"
        if not fetch(url, dst):
            self.send_error(404)
            return
        with open(dst, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg" if ext == "jpg" else "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"serving {ROOT} at http://127.0.0.1:{port}", flush=True)
    srv.serve_forever()
