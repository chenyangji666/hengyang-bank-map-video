# -*- coding: utf-8 -*-
"""把建行、农行两份原始数据清洗成统一口径，并计算视频要用的统计指标。

输出：
  data/processed/branches.csv     - 141 个营业网点（统一字段）
  data/processed/branches.geojson - 同上，GeoJSON（GCJ-02）
  data/processed/stats.json       - 视频脚本与图表使用的统计
"""
import json, math, os, re
from collections import Counter, defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "processed")

DISTRICTS = {
    "430405": "珠晖区", "430406": "雁峰区", "430407": "石鼓区", "430408": "蒸湘区",
    "430412": "南岳区", "430421": "衡阳县", "430422": "衡南县", "430423": "衡山县",
    "430424": "衡东县", "430426": "祁东县", "430481": "耒阳市", "430482": "常宁市",
}
URBAN_CORE = {"430405", "430406", "430407", "430408"}
NAME2CODE = {v: k for k, v in DISTRICTS.items()}
CITY_CENTER = (112.5717, 26.8930)  # 衡阳市区（蒸湘区）参考点


def load_ccb():
    raw = json.load(open(os.path.join(RAW, "ccb_hengyang_pages.json"), encoding="utf-8"))
    rows = [r for p in raw["pages"] for r in p["OUTLET_DTL_LIST"]]
    out = []
    for r in rows:
        code = r["ADiv_Cd"]
        out.append({
            "bank": "CCB",
            "bank_name": "中国建设银行",
            "id": r["PK_ID"],
            "name": r["CCBIns_Nm"],
            "address": r["Dtl_Adr"],
            "lng": float(r["Lgt"]),
            "lat": float(r["Ltt"]),
            "district_code": code,
            "district": DISTRICTS.get(code, code),
            "level": "营业网点",
            "phone": r.get("Fix_TelNo", ""),
        })
    return out, raw.get("captured_at")


def load_abc():
    raw = json.load(open(os.path.join(RAW, "abc_hengyang_raw.json"), encoding="utf-8"))
    out = []
    for x in raw["items"]:
        code = x["BoroughId"]
        out.append({
            "bank": "ABC",
            "bank_name": "中国农业银行",
            "id": x["Code"],
            "name": x["Name"],
            "address": x["FullAddress"],
            "lng": float(x["Longitude"]),
            "lat": float(x["Latitude"]),
            "district_code": code,
            "district": DISTRICTS.get(code, x["Borough"]),
            "level": x.get("BranchLevel", ""),
            "phone": x.get("PhoneNumber", ""),
        })
    return out, None


def haversine_m(a, b):
    R = 6371000.0
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp = p2 - p1
    dl = math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def nearest_stats(pts):
    ds = []
    for i, p in enumerate(pts):
        d = min(haversine_m(p, q) for j, q in enumerate(pts) if i != j)
        ds.append(d)
    ds.sort()
    n = len(ds)
    return {
        "mean_m": round(sum(ds) / n),
        "median_m": round(ds[n // 2]),
        "p90_m": round(ds[int(n * 0.9)]),
        "min_m": round(ds[0]),
        "max_m": round(ds[-1]),
    }


def main():
    ccb, ccb_at = load_ccb()
    abc, _ = load_abc()
    rows = ccb + abc

    for r in rows:
        r["is_urban_core"] = r["district_code"] in URBAN_CORE
        r["is_township"] = bool(re.search(r"[镇乡]", r["address"] or ""))

    ccb_rows = [r for r in rows if r["bank"] == "CCB"]
    abc_rows = [r for r in rows if r["bank"] == "ABC"]

    by_district = {}
    for code, name in DISTRICTS.items():
        by_district[name] = {
            "code": code,
            "is_urban_core": code in URBAN_CORE,
            "ccb": sum(1 for r in ccb_rows if r["district_code"] == code),
            "abc": sum(1 for r in abc_rows if r["district_code"] == code),
        }

    def bank_stats(rs):
        pts = [(r["lng"], r["lat"]) for r in rs]
        return {
            "total": len(rs),
            "urban_core": sum(1 for r in rs if r["is_urban_core"]),
            "county": sum(1 for r in rs if not r["is_urban_core"]),
            "township": sum(1 for r in rs if r["is_township"]),
            "districts_covered": len({r["district_code"] for r in rs}),
            "nearest": nearest_stats(pts),
            "centroid": [round(sum(p[0] for p in pts) / len(pts), 6), round(sum(p[1] for p in pts) / len(pts), 6)],
            "bbox": {
                "minLng": min(p[0] for p in pts), "maxLng": max(p[0] for p in pts),
                "minLat": min(p[1] for p in pts), "maxLat": max(p[1] for p in pts),
            },
            "mean_dist_to_center_km": round(sum(haversine_m(CITY_CENTER, p) for p in pts) / len(pts) / 1000, 1),
            "max_dist_to_center_km": round(max(haversine_m(CITY_CENTER, p) for p in pts) / 1000, 1),
        }

    s_ccb, s_abc = bank_stats(ccb_rows), bank_stats(abc_rows)

    # 两行“贴身”网点对
    pairs = []
    for a in ccb_rows:
        for b in abc_rows:
            d = haversine_m((a["lng"], a["lat"]), (b["lng"], b["lat"]))
            if d <= 500:
                pairs.append({"ccb": a["name"], "abc": b["name"], "m": round(d)})
    pairs.sort(key=lambda x: x["m"])

    stats = {
        "captured_at": ccb_at,
        "totals": {"ccb": s_ccb["total"], "abc": s_abc["total"], "all": len(rows)},
        "ccb": s_ccb,
        "abc": s_abc,
        "ratio": round(s_abc["total"] / s_ccb["total"], 2),
        "by_district": by_district,
        "districts": DISTRICTS,
        "city_center": CITY_CENTER,
        "close_pairs_500m": len(pairs),
        "close_pairs_300m": sum(1 for p in pairs if p["m"] <= 300),
        "close_pairs_200m": sum(1 for p in pairs if p["m"] <= 200),
        "closest_pairs": pairs[:10],
        "township_by_bank": {"ccb": s_ccb["township"], "abc": s_abc["township"]},
        "sources": {
            "ccb": "中国建设银行官网「网点及ATM查询」https://www.ccb.com/cn/home/map/branchSearch.html （接口 TXCODE=NZX013，ADiv_Cd=430400，营业网点）",
            "abc": "中国农业银行官网「营业机构查询」https://app.abchina.com.cn/branch/ （接口 /mobileSite/Branch/mobileSearchBranch，cityId=430400，营业网点）",
        },
        "crs": "GCJ-02（建行页面显式声明 BMAP_COORD_GCJ02；农行与建行同址网点距离中位数 <200m，判定同属 GCJ-02）",
    }

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)

    # CSV
    import csv
    cols = ["bank", "bank_name", "id", "name", "address", "lng", "lat",
            "district_code", "district", "is_urban_core", "is_township", "level", "phone"]
    with open(os.path.join(OUT, "branches.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: r[k] for k in cols})

    # GeoJSON
    gj = {
        "type": "FeatureCollection",
        "name": "hengyang_bank_branches",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [{
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r["lng"], r["lat"]]},
            "properties": {k: r[k] for k in cols if k not in ("lng", "lat")},
        } for r in rows],
    }
    with open(os.path.join(OUT, "branches.geojson"), "w", encoding="utf-8") as f:
        json.dump(gj, f, ensure_ascii=False, indent=1)

    print(json.dumps({
        "totals": stats["totals"], "ratio": stats["ratio"],
        "ccb": {k: s_ccb[k] for k in ("urban_core", "county", "township", "mean_dist_to_center_km", "max_dist_to_center_km")},
        "abc": {k: s_abc[k] for k in ("urban_core", "county", "township", "mean_dist_to_center_km", "max_dist_to_center_km")},
        "nearest_ccb": s_ccb["nearest"], "nearest_abc": s_abc["nearest"],
        "pairs": {k: stats[k] for k in ("close_pairs_500m", "close_pairs_300m", "close_pairs_200m")},
    }, ensure_ascii=False, indent=1))
    print("\n按区县：")
    for name, d in by_district.items():
        print(f"  {name:<5} 建行 {d['ccb']:>2}  农行 {d['abc']:>2}")


if __name__ == "__main__":
    main()
