"""Génère la banque de sons originaux de Debout ! (synthèse pure, aucun échantillon externe)."""
import os, subprocess, sys
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100
OUT = sys.argv[1] if len(sys.argv) > 1 else "sounds"
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(42)


def t(d):
    return np.arange(int(SR * d)) / SR


def env(n, a=0.005, r=0.05, d=None):
    e = np.ones(n)
    na, nr = int(SR * a), int(SR * r)
    if na: e[:na] = np.linspace(0, 1, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return e


def sq(f, d, duty=0.5):
    return signal.square(2 * np.pi * f * t(d), duty)


def saw(f, d):
    return signal.sawtooth(2 * np.pi * f * t(d))


def sine(f, d):
    return np.sin(2 * np.pi * f * t(d))


def tri(f, d):
    return signal.sawtooth(2 * np.pi * f * t(d), 0.5)


def lp(x, fc, order=4):
    b, a = signal.butter(order, fc / (SR / 2), "low")
    return signal.lfilter(b, a, x)


def hp(x, fc, order=2):
    b, a = signal.butter(order, fc / (SR / 2), "high")
    return signal.lfilter(b, a, x)


def bp(x, lo, hi, order=2):
    b, a = signal.butter(order, [lo / (SR / 2), hi / (SR / 2)], "band")
    return signal.lfilter(b, a, x)


def sil(d):
    return np.zeros(int(SR * d))


def cat(*parts):
    return np.concatenate(parts)


def sweep(f0, f1, d, kind="sine", log=False):
    tt = t(d)
    if log:
        f = f0 * (f1 / f0) ** (tt / d)
    else:
        f = f0 + (f1 - f0) * tt / d
    ph = 2 * np.pi * np.cumsum(f) / SR
    if kind == "sine": return np.sin(ph)
    if kind == "saw": return 2 * ((ph / (2 * np.pi)) % 1) - 1
    if kind == "sq": return np.sign(np.sin(ph))
    return np.sin(ph)


def mix_at(base, x, start):
    i = int(start * SR)
    end = min(len(base), i + len(x))
    base[i:end] += x[: end - i]
    return base


def note(n):  # n = demi-tons depuis La 440
    return 440.0 * 2 ** (n / 12)


def bell(f, d, partials=((1, 1), (2.76, .5), (5.4, .25), (8.93, .12)), decay=3.0):
    tt = t(d)
    x = sum(a * np.sin(2 * np.pi * f * m * tt) * np.exp(-decay * m ** 0.5 * tt) for m, a in partials)
    return x * env(len(tt), a=0.002, r=0.02)


def pluck(f, d, decay=6):
    tt = t(d)
    return (np.sin(2 * np.pi * f * tt) + .3 * np.sin(4 * np.pi * f * tt)) * np.exp(-decay * tt) * env(len(tt), .002, .02)


def brass(f, d):
    x = saw(f, d) + .5 * saw(f * 1.004, d)
    tt = t(d)
    cut = 600 + 2500 * (1 - np.exp(-tt * 18))
    # filtre balayé approximé par deux filtres mélangés
    y = lp(x, 900) * 0.5 + lp(x, 2600) * 0.5 * (1 - np.exp(-tt * 12))
    return y * env(len(tt), .02, .06)


def kick(d=0.25):
    tt = t(d)
    f = 50 + 120 * np.exp(-tt * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9)


def hat(d=0.06):
    return hp(rng.standard_normal(int(SR * d)), 7000) * np.exp(-t(d) * 60)


def snare(d=0.18):
    tt = t(d)
    return (bp(rng.standard_normal(len(tt)), 1500, 6000) * .7 + np.sin(2 * np.pi * 190 * tt) * .5) * np.exp(-tt * 22)


def tom(f, d=0.35):
    tt = t(d)
    ff = f * (1 + .5 * np.exp(-tt * 25))
    return np.sin(2 * np.pi * np.cumsum(ff) / SR) * np.exp(-tt * 8)


def finish(x, gain_db=-1.0):
    x = x - np.mean(x)
    x = x / (np.max(np.abs(x)) + 1e-9)
    x *= 10 ** (gain_db / 20)
    # légère compression douce pour que ça sonne fort
    x = np.tanh(1.6 * x) / np.tanh(1.6)
    x *= 10 ** (gain_db / 20)
    n = int(.01 * SR)
    x[:n] *= np.linspace(0, 1, n)
    x[-n:] *= np.linspace(1, 0, n)
    return x


SOUNDS = {}


def S(name):
    def deco(fn):
        SOUNDS[name] = fn
        return fn
    return deco


# ---------------- Sons de base ----------------

@S("classique")
def _():
    beep = sq(2048, .09) * env(int(SR * .09), .002, .01)
    beep = lp(beep, 6000)
    group = cat(*[cat(beep, sil(.07)) for _ in range(4)])
    return cat(*[cat(group, sil(.45)) for _ in range(5)])


@S("sirene")
def _():
    x = cat(*[cat(sweep(650, 1350, .9, "saw", log=True), sweep(1350, 650, .9, "saw", log=True)) for _ in range(4)])
    return lp(x, 3500)


@S("klaxon")
def _():
    def honk(d):
        return lp(saw(340, d) + saw(428, d) + .6 * saw(512, d), 2200) * env(int(SR * d), .01, .03)
    p = cat(honk(.18), sil(.08), honk(.18), sil(.08), honk(.7), sil(.5))
    return cat(p, p, p)


@S("fanfare")
def _():
    seq = [(0, .16), (4, .16), (7, .16), (12, .45), (7, .16), (12, .7), (None, .3),
           (5, .16), (9, .16), (12, .16), (17, .45), (16, .16), (14, .16), (12, .8), (None, .4)]
    parts = []
    for n, d in seq:
        if n is None:
            parts.append(sil(d))
        else:
            f = note(n - 9)  # autour de Do4
            parts.append(brass(f, d) + .5 * brass(f / 2, d))
    return cat(*parts, *parts)


@S("ecole")
def _():
    d = 3.0
    tt = t(d)
    x = sum(a * np.sin(2 * np.pi * f * tt) for f, a in ((1180, 1), (2950, .5), (4400, .3)))
    am = (signal.square(2 * np.pi * 22 * tt) + 1) / 2
    am = lp(am, 400)
    x = x * (.25 + .75 * am) * env(len(tt), .01, .05)
    return cat(x, sil(.6), x, sil(.6))


@S("chiptune")
def _():
    mel = [12, None, 7, 12, 15, 14, 12, None, 10, 12, 7, None, 3, 5, 7, None,
           12, None, 7, 12, 15, 17, 19, None, 17, 15, 14, 12, 10, 12, None, None]
    bass = [0, 0, -5, -5, -4, -4, -2, -2]
    step = .12
    out = np.zeros(int(SR * step * len(mel)))
    for i, n in enumerate(mel):
        if n is not None:
            x = sq(note(n), step * .9, .25) * env(int(SR * step * .9), .002, .02) * .5
            mix_at(out, x, i * step)
    for i in range(len(mel) // 4):
        b = bass[i % len(bass)]
        x = tri(note(b - 24), step * 3.8) * env(int(SR * step * 3.8), .005, .05) * .6
        mix_at(out, x, i * step * 4)
    return cat(out, out)


@S("sonar")
def _():
    out = np.zeros(int(SR * 7.2))
    for k in range(4):
        for e, a in ((0, 1), (.35, .35), (.7, .12)):
            mix_at(out, bell(1250, 1.4, ((1, 1), (2.01, .1)), decay=2.2) * a, k * 1.8 + e)
    return out


@S("carillon")
def _():
    seq = [7, 11, 14, 19, 14, 11, 7, 2, 7, 11, 14, 19, 23, 19, 14, 11]
    out = np.zeros(int(SR * (len(seq) * .32 + 2)))
    for i, n in enumerate(seq):
        mix_at(out, bell(note(n), 2.0, decay=2.0) * .6, i * .32)
    return out


@S("recul")
def _():
    b = sine(1040, .45) * env(int(SR * .45), .005, .01) + .3 * sq(1040, .45) * env(int(SR * .45), .005, .01)
    return cat(*[cat(b, sil(.45)) for _ in range(8)])


@S("coucou")
def _():
    def cu(f, d):
        x = sine(f, d) + .25 * sine(2 * f, d)
        return lp(x, 2500) * env(int(SR * d), .02, .08)
    p = cat(cu(784, .28), sil(.06), cu(622, .45), sil(.5))
    return cat(p, p, p, p, sil(.3))


@S("laser")
def _():
    z = cat(*[cat(sweep(2600, 300, .22, "sq", log=True) * env(int(SR * .22), .002, .03), sil(.05)) for _ in range(3)])
    return cat(z, sil(.5), z, sil(.5), z, sil(.5), z, sil(.5))


@S("gong")
def _():
    d = 4.0
    x = bell(110, d, ((1, 1), (1.41, .6), (2.13, .5), (2.75, .35), (3.6, .2), (4.9, .12)), decay=0.9)
    x += lp(rng.standard_normal(len(x)), 900) * np.exp(-t(d) * 5) * .2
    return cat(x, x)


# ---------------- Sons exclusifs « surprise de la semaine » ----------------

@S("kazoo")
def _():
    mel = [(0, .25), (2, .25), (4, .25), (5, .5), (4, .25), (2, .25), (0, .5), (7, .75), (None, .25),
           (5, .25), (4, .25), (2, .25), (4, .5), (0, 1.0), (None, .5)]
    parts = []
    for n, d in mel:
        if n is None:
            parts.append(sil(d)); continue
        tt = t(d)
        f = note(n - 9) * (1 + .012 * np.sin(2 * np.pi * 6 * tt))
        x = 2 * ((np.cumsum(f) / SR) % 1) - 1
        x = bp(x, 400, 3200) + .2 * rng.standard_normal(len(tt)) * .1
        parts.append(np.tanh(3 * x) * env(len(tt), .02, .04))
    return cat(*parts, *parts)


@S("microondes")
def _():
    beep = sine(1600, .25) * env(int(SR * .25), .003, .02)
    hum = (sine(100, 2.5) + .4 * sine(200, 2.5) + .05 * rng.standard_normal(int(SR * 2.5))) * .25
    hum = lp(hum, 800) * env(len(hum), .1, .2)
    p = cat(hum, sil(.1), beep, sil(.25), beep, sil(.25), beep, sil(.8))
    return cat(p, p)


@S("decollage")
def _():
    d = 7.0
    tt = t(d)
    rumble = lp(rng.standard_normal(len(tt)), 180) * 3
    roar = bp(rng.standard_normal(len(tt)), 600, 4000) * (tt / d) ** 1.5
    whine = sweep(300, 2400, d, "saw", log=True) * .15 * (tt / d)
    x = (rumble + roar + whine) * np.minimum(1, tt / 1.5)
    return x


@S("boite")
def _():
    seq = [12, 16, 19, 24, 19, 16, 14, 17, 21, 24, 21, 17, 12, 16, 19, 23, 26, 23, 19, 16, 24, None, 12, None]
    out = np.zeros(int(SR * (len(seq) * .2 + 1.5)))
    for i, n in enumerate(seq):
        if n is not None:
            mix_at(out, pluck(note(n + 3), 1.2, decay=4) * .5, i * .2)
    return out


@S("stade")
def _():
    d = 7.0
    tt = t(d)
    crowd = bp(rng.standard_normal(len(tt)), 300, 2500)
    swell = .4 + .6 * (np.sin(2 * np.pi * tt / 3.5 - np.pi / 2) + 1) / 2
    x = crowd * swell * .6
    horn = lp(saw(233, 1.0) + saw(294, 1.0) + saw(349, 1.0), 2000) * env(int(SR * 1.0), .02, .1)
    for s in (0.5, 1.7, 4.0, 5.2):
        mix_at(x, horn * .5, s)
    clap_t = np.arange(0, d - .1, .5)
    for s in clap_t:
        mix_at(x, hp(rng.standard_normal(int(SR * .05)), 1500) * np.exp(-t(.05) * 70) * .9, s)
    return x


@S("disco")
def _():
    bar = 2.0
    out = np.zeros(int(SR * bar * 4))
    bassline = [0, 12, 0, 12, 5, 17, 5, 17, 7, 19, 7, 19, 3, 15, 3, 15]
    for b in range(4):
        base = b * bar
        for i in range(4):
            mix_at(out, kick() * .9, base + i * .5)
            mix_at(out, hat() * .4, base + i * .5 + .25)
        mix_at(out, snare() * .6, base + .5)
        mix_at(out, snare() * .6, base + 1.5)
        for i in range(4):
            n = bassline[(b * 4 + i) % len(bassline)]
            x = lp(saw(note(n - 33), .45), 700) * env(int(SR * .45), .005, .05) * .6
            mix_at(out, x, base + i * .5)
        mix_at(out, lp(brass(note(3 + (b % 2) * 2), .4), 3000) * .4, base + 1.75)
    return out


@S("alerte")
def _():
    w = sweep(400, 1200, .7, "saw", log=False) * env(int(SR * .7), .01, .05)
    w = lp(w, 3000)
    return cat(*[cat(w, sil(.15)) for _ in range(8)])


@S("tambours")
def _():
    pat = [(0, 160), (.25, 160), (.5, 120), (.625, 120), (.75, 90), (1.0, 160), (1.25, 90), (1.5, 120), (1.75, 160)]
    out = np.zeros(int(SR * 8.0))
    for bar in range(4):
        for s, f in pat:
            mix_at(out, tom(f) * .8, bar * 2 + s)
        mix_at(out, kick(.4) * .7, bar * 2)
    return out


def write(name, x):
    x = finish(x)
    wav = f"/tmp/snd_{name}.wav"
    wavfile.write(wav, SR, (x * 32767).astype(np.int16))
    mp3 = os.path.join(OUT, f"{name}.mp3")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-codec:a", "libmp3lame",
                    "-b:a", "80k", mp3], check=True)
    os.remove(wav)
    print(f"{name:12s} {len(x)/SR:5.1f}s {os.path.getsize(mp3)//1024} KB")


if __name__ == "__main__":
    for name, fn in SOUNDS.items():
        write(name, fn())
    # silence pour « débloquer » l'audio sur iPhone et garder la session audio active
    sw = "/tmp/snd_silence.wav"
    wavfile.write(sw, SR, np.zeros(SR * 2, dtype=np.int16))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", sw, "-ac", "1", "-codec:a", "libmp3lame",
                    "-b:a", "32k", os.path.join(OUT, "silence.mp3")], check=True)
