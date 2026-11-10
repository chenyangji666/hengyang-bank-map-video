# -*- coding: utf-8 -*-
"""生成中文旁白，并按实际音频时长排出视频时间轴。

输入  src/script.json
输出  output/audio/<scene>.mp3、src/timeline.json
"""
import asyncio, json, os, re, subprocess
import edge_tts

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
AUDIO = os.path.join(ROOT, "output", "audio")
FFPROBE = r"C:\ffmpeg\bin\ffprobe.exe"


def dur(path):
    if os.path.exists(FFPROBE):
        out = subprocess.check_output([
            FFPROBE, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path])
        return float(out.strip())
    raise RuntimeError("需要 ffprobe 来测量音频时长")


SPLIT_RE = re.compile(r"(?<=[。！？；，：])")


def split_caption(text, max_len=26):
    """按标点切句，过长的再按字数切。"""
    parts = [p for p in SPLIT_RE.split(text) if p.strip()]
    out = []
    for p in parts:
        if len(p) <= max_len:
            out.append(p)
        else:
            for i in range(0, len(p), max_len):
                out.append(p[i:i + max_len])
    # 合并太短的片段
    merged = []
    for p in out:
        if merged and len(merged[-1]) < 8:
            merged[-1] += p
        else:
            merged.append(p)
    return merged


async def main():
    cfg = json.load(open(os.path.join(ROOT, "src", "script.json"), encoding="utf-8"))
    os.makedirs(AUDIO, exist_ok=True)
    voice = cfg.get("voice", "zh-CN-YunjianNeural")
    rate = cfg.get("rate", "+0%")

    scenes, t = [], 0.0
    for sc in cfg["scenes"]:
        mp3 = os.path.join(AUDIO, sc["id"] + ".mp3")
        if not (os.path.exists(mp3) and os.path.getsize(mp3) > 1000):
            await edge_tts.Communicate(sc["narration"], voice, rate=rate).save(mp3)
        d = dur(mp3)
        pad_in = sc.get("pad_in", 0.4)
        pad_out = sc.get("pad_out", 0.8)
        length = max(sc.get("min", 0), pad_in + d + pad_out)

        # 字幕按字数比例分配
        caps = split_caption(sc["caption"])
        total_chars = sum(len(c) for c in caps) or 1
        ct, items = t + pad_in, []
        for c in caps:
            cd = d * len(c) / total_chars
            items.append({"text": c, "start": round(ct, 3), "end": round(ct + cd, 3)})
            ct += cd

        scenes.append({
            "id": sc["id"],
            "start": round(t, 3),
            "end": round(t + length, 3),
            "duration": round(length, 3),
            "audio": sc["id"] + ".mp3",
            "audio_start": round(t + pad_in, 3),
            "audio_duration": round(d, 3),
            "captions": items,
            "caption_full": sc["caption"],
        })
        t += length

    timeline = {
        "fps": cfg.get("fps", 30),
        "total": round(t, 3),
        "voice": voice,
        "scenes": scenes,
    }
    with open(os.path.join(ROOT, "src", "timeline.json"), "w", encoding="utf-8") as f:
        json.dump(timeline, f, ensure_ascii=False, indent=1)

    for s in scenes:
        print(f"{s['id']:<12} {s['start']:>7.2f} → {s['end']:>7.2f}  ({s['duration']:.2f}s, 语音 {s['audio_duration']:.2f}s)")
    print(f"总时长 {t:.2f}s = {int(t//60)}:{t%60:05.2f}")


if __name__ == "__main__":
    asyncio.run(main())
