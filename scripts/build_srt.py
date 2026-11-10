# -*- coding: utf-8 -*-
"""从 timeline.json 导出 SRT 字幕。"""
import json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
tl = json.load(open(os.path.join(ROOT, "src", "timeline.json"), encoding="utf-8"))


def ts(t):
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


lines, i = [], 1
for sc in tl["scenes"]:
    for c in sc["captions"]:
        lines.append(f"{i}\n{ts(c['start'])} --> {ts(c['end'])}\n{c['text']}\n")
        i += 1

out = os.path.join(ROOT, "output", "hengyang_banks.srt")
open(out, "w", encoding="utf-8").write("\n".join(lines))
print("saved", out, i - 1, "cues")
