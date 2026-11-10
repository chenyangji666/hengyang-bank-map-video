# -*- coding: utf-8 -*-
"""抓取中国建设银行官网「网点及ATM查询」衡阳市全部营业网点（官方 TXCODE=NZX013 接口）。

输出：data/raw/ccb_hengyang_pages.json（逐页原始响应 + 抓取元信息）
"""
import json, os, ssl, time
import requests
from requests.adapters import HTTPAdapter

class LegacyTLSAdapter(HTTPAdapter):
    """建行/农行官网仍在使用旧式 TLS 重协商，Python 默认会拒绝，这里显式放开。"""

    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.options |= 0x4  # SSL_OP_LEGACY_SERVER_CONNECT
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)

BASE = ("https://www3.ccb.com/tran/WCCMainPlatV5?CCB_IBSVersion=V5"
        "&SERVLET_NAME=WCCMainPlatV5&isAjaxRequest=true")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
HDRS = {"User-Agent": UA, "Referer": "https://www.ccb.com/cn/home/map/branchSearch.html"}
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

s = requests.Session()
s.trust_env = False  # 不走系统代理，代理会破坏旧式 TLS 重协商
s.headers.update(HDRS)
s.mount("https://", LegacyTLSAdapter())
s.mount("http://", LegacyTLSAdapter())
# 先访问一次，建立会话 cookie
s.get(BASE + "&TXCODE=100119", timeout=30)

def q(page, adiv="430400", mtd=1):
    url = (BASE + "&TXCODE=NZX013&Enqr_Cnd_Cntnt=%EF%BC%9D011860003&isJSONRequest=true"
           f"&ADiv_Cd={adiv}&Kywd_List_Cntnt=&Enqr_MtdCd={mtd}&PAGE_JUMP={page}&Cur_StCd=4")
    r = s.get(url, timeout=40)
    r.raise_for_status()
    return json.loads(r.text.strip())

pages, meta = [], {}
p = 1
while True:
    d = q(p)
    if d.get("SUCCESS") != "true":
        raise SystemExit(f"页 {p} 失败: {d}")
    meta = {"TOTAL_PAGE": d.get("TOTAL_PAGE"), "TOTAL_REC": d.get("TOTAL_REC")}
    rows = d.get("OUTLET_DTL_LIST", [])
    print(f"page {p}: {len(rows)} 条, total={meta['TOTAL_REC']}")
    pages.append(d)
    if p >= int(d.get("TOTAL_PAGE", 1)) or not rows:
        break
    p += 1
    time.sleep(0.6)

out = {
    "source": "中国建设银行官网 网点及ATM查询",
    "endpoint": "https://www3.ccb.com/tran/WCCMainPlatV5 TXCODE=NZX013",
    "query": {"ADiv_Cd": "430400", "Enqr_MtdCd": 1, "Enqr_Cnd_Cntnt": "011860003"},
    "captured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    "meta": meta,
    "pages": pages,
}
dst = os.path.join(ROOT, "data", "raw", "ccb_hengyang_pages.json")
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(dst, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("saved", dst, "records:", sum(len(x.get("OUTLET_DTL_LIST", [])) for x in pages))
