# -*- coding: utf-8 -*-
"""换旁白音色，但保持已渲染视频的场景边界不变。

做法：按现有 timeline.json 里每个场景的固定时长，倒推这句旁白能用的最大时长；
用 edge-tts 生成，超长就自动提高语速，直到正好塞进这个窗口。
"""
import asyncio, json, os, re, subprocess
import edge_tts

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
AUDIO = os.path.join(ROOT, "output", "audio")
FFPROBE = r"C:\ffmpeg\bin\ffprobe.exe"
VOICE = "zh-CN-XiaoxiaoNeural"
RATES = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28]


def dur(path):
    out = subprocess.check_output([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                   "-of", "default=nw=1:nokey=1", path])
    return float(out.strip())


SPLIT_RE = re.compile(r"(?<=[。！？；，：])")


def split_caption(text, max_len=26):
    parts = [p for p in SPLIT_RE.split(text) if p.strip()]
    out = []
    for p in parts:
        if len(p) <= max_len:
            out.append(p)
        else:
            for i in range(0, len(p), max_len):
                out.append(p[i:i + max_len])
    merged = []
    for p in out:
        if merged and len(merged[-1]) < 8:
            merged[-1] += p
        else:
            merged.append(p)
    return merged


async def main():
    tl = json.load(open(os.path.join(ROOT, "src", "timeline.json"), encoding="utf-8"))
    cfg = json.load(open(os.path.join(ROOT, "src", "script.json"), encoding="utf-8"))
    meta = {s["id"]: s for s in cfg["scenes"]}

    total_audio = 0
    for sc in tl["scenes"]:
        sid = sc["id"]
        m = meta[sid]
        pad_in = m.get("pad_in", 0.4)
        pad_out = m.get("pad_out", 0.8)
        window = sc["duration"] - pad_in - pad_out - 0.12  # 留一点余量

        mp3 = os.path.join(AUDIO, sid + ".mp3")
        chosen = None
        for r in RATES:
            await edge_tts.Communicate(m["narration"], VOICE, rate=f"+{r}%").save(mp3)
            d = dur(mp3)
            if d <= window:
                chosen = (r, d)
                break
        if chosen is None:
            raise SystemExit(f"{sid} 即使 +{RATES[-1]}% 仍超时")
        rate, d = chosen
        total_audio += d
        print(f"{sid:<12} rate +{rate}%  audio {d:.2f}s / window {window:.2f}s")

        # 重排字幕（场景起止不变）
        caps = split_caption(m["caption"])
        total_chars = sum(len(c) for c in caps) or 1
        ct, items = sc["start"] + pad_in, []
        for c in caps:
            cd = d * len(c) / total_chars
            items.append({"text": c, "start": round(ct, 3), "end": round(ct + cd, 3)})
            ct += cd
        sc["captions"] = items
        sc["audio"] = sid + ".mp3"
        sc["audio_start"] = round(sc["start"] + pad_in, 3)
        sc["audio_duration"] = round(d, 3)

    tl["voice"] = VOICE
    tl["voice_rate"] = "+varies%"
    with open(os.path.join(ROOT, "src", "timeline.json"), "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=1)
    print(f"总时长仍为 {tl['total']:.2f}s，旁白合计 {total_audio:.2f}s")


if __name__ == "__main__":
    asyncio.run(main())
