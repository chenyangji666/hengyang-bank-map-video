# -*- coding: utf-8 -*-
"""合成配乐底床，并把旁白按时间轴混成一条 48k 立体声 WAV。"""
import json, os, subprocess, wave
import numpy as np
from scipy.signal import butter, sosfilt

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FF = r"C:\ffmpeg\bin\ffmpeg.exe"
SR = 48000

timeline = json.load(open(os.path.join(ROOT, "src", "timeline.json"), encoding="utf-8"))
TOTAL = timeline["total"]
N = int(TOTAL * SR) + SR // 2


def lowpass(x, cutoff, order=2):
    sos = butter(order, min(cutoff, SR / 2 - 100) / (SR / 2), btype="low", output="sos")
    return sosfilt(sos, x)


def highpass(x, cutoff, order=2):
    sos = butter(order, cutoff / (SR / 2), btype="high", output="sos")
    return sosfilt(sos, x)


def bandpass(x, lo, hi):
    return highpass(lowpass(x, hi), lo)


def build_bed():
    t = np.arange(N) / SR
    bed = np.zeros(N, dtype=np.float64)

    # 低频铺底：D2 / A2 / F3 / A3，缓慢呼吸
    for f, amp, rate, ph in [
        (73.42, 0.090, 0.021, 0.0),
        (110.00, 0.062, 0.017, 1.3),
        (146.83, 0.030, 0.013, 2.7),
        (174.61, 0.024, 0.011, 4.1),
    ]:
        lfo = 0.62 + 0.38 * np.sin(2 * np.pi * rate * t + ph)
        bed += amp * np.sin(2 * np.pi * f * t + ph) * lfo

    bed += 0.026 * np.sin(2 * np.pi * 73.9 * t + 0.7) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.009 * t))

    rng = np.random.default_rng(20261110)
    air = bandpass(rng.standard_normal(N), 1100, 6200)
    air /= (np.abs(air).max() + 1e-9)
    bed += 0.022 * air * (0.55 + 0.45 * np.sin(2 * np.pi * 0.015 * t + 2.0))

    # 场景切换的 whoosh
    for sc in timeline["scenes"]:
        c = int(sc["start"] * SR)
        ln = int(1.6 * SR)
        s0 = c - ln // 3
        if s0 < 0 or s0 + ln > N:
            continue
        seg = bandpass(rng.standard_normal(ln), 140, 1800)
        seg /= (np.abs(seg).max() + 1e-9)
        e = np.exp(-((np.arange(ln) - ln * 0.42) ** 2) / (2 * (ln * 0.16) ** 2))
        bed[s0:s0 + ln] += 0.06 * seg * e

    # 60 BPM 的极轻脉冲
    for k in np.arange(1.0, TOTAL, 2.0):
        c = int(k * SR)
        ln = int(0.32 * SR)
        if c + ln > N:
            break
        tt = np.arange(ln) / SR
        thump = np.sin(2 * np.pi * 52 * tt) * np.exp(-tt * 17)
        bed[c:c + ln] += 0.045 * thump

    bed = lowpass(bed, 9500)
    bed /= (np.abs(bed).max() + 1e-9)
    bed *= 0.6
    return bed


def write_wav(path, data):
    x = (np.clip(data, -1, 1) * 32767).astype(np.int16)
    st = np.stack([x, x], axis=1)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(st.tobytes())


def main():
    bed = build_bed()
    bed_path = os.path.join(ROOT, "output", "audio", "bed.wav")
    write_wav(bed_path, bed * 0.5)
    print("bed", bed_path, f"{len(bed)/SR:.1f}s")

    inputs, filters, labels = [], [], []
    for i, sc in enumerate(timeline["scenes"]):
        p = os.path.join(ROOT, "output", "audio", sc["audio"])
        inputs += ["-i", p]
        delay = int(round(sc["audio_start"] * 1000))
        filters.append(
            f"[{i+1}:a]aresample={SR},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"volume=1.0,adelay={delay}|{delay}[n{i}]")
        labels.append(f"[n{i}]")

    filt = ";".join(filters)
    filt += ";[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.40[bed]"
    filt += ";" + "".join(labels) + "[bed]amix=inputs=%d:normalize=0,alimiter=limit=0.92[aout]" % (len(labels) + 1)

    out = os.path.join(ROOT, "output", "audio", "mix.wav")
    cmd = [FF, "-y", "-i", bed_path] + inputs + [
        "-filter_complex", filt, "-map", "[aout]",
        "-ac", "2", "-ar", str(SR), "-c:a", "pcm_s16le", out,
    ]
    subprocess.run(cmd, check=True)
    print("mixed", out)


if __name__ == "__main__":
    main()
