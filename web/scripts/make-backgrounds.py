#!/usr/bin/env python3
"""Generate the bundled virtual backgrounds.

Run from web/:  python3 scripts/make-backgrounds.py

The outputs are committed, so this only needs running when the set changes. It is
here rather than being a one-off because "how was this asset made" is otherwise
unanswerable, and because regenerating at a different size later should not mean
redrawing anything by hand.

Everything is procedural on purpose. A webinar background has to be quiet enough to
sit behind a talking head for an hour, which rules out most stock photography, and it
has to be ours to ship — a downloaded photograph is a licensing question wearing a
JPEG. Gradients, bokeh and studio vignettes are the categories that actually work,
and they are the ones that can be generated honestly.

The technique for anything smooth: draw the field at a fraction of the output size
and upscale with LANCZOS. A per-pixel loop at 1920x1080 in pure Python takes minutes;
at 1/12 scale it takes milliseconds, and resampling a gradient loses nothing because
there was no detail in it to lose.
"""

import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

W, H = 1920, 1080
THUMB = (320, 180)
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "backgrounds")

# Small enough to be fast, large enough that LANCZOS has something to work with.
FIELD = (W // 12, H // 12)


def lerp(a, b, t):
    return a + (b - a) * t


def mesh(stops, size=FIELD):
    """A mesh gradient: colour points pulling on every pixel by inverse square distance.

    Inverse SQUARE rather than inverse distance, because plain inverse distance leaves
    each stop looking like a spotlight with a hard centre.
    """
    img = Image.new("RGB", size)
    px = img.load()
    w, h = size
    for y in range(h):
        fy = y / (h - 1)
        for x in range(w):
            fx = x / (w - 1)
            r = g = b = 0.0
            total = 0.0
            for sx, sy, (cr, cg, cb) in stops:
                d = (fx - sx) ** 2 + (fy - sy) ** 2 + 0.004
                weight = 1.0 / d
                r += cr * weight
                g += cg * weight
                b += cb * weight
                total += weight
            px[x, y] = (int(r / total), int(g / total), int(b / total))
    return img


def linear(top, bottom, size=FIELD, angle=0.0):
    """A straight gradient, optionally rotated off the vertical."""
    img = Image.new("RGB", size)
    px = img.load()
    w, h = size
    ca, sa = math.cos(angle), math.sin(angle)
    for y in range(h):
        for x in range(w):
            t = ((x / (w - 1)) * sa + (y / (h - 1)) * ca + 1) / 2 if angle else y / (h - 1)
            t = min(1.0, max(0.0, t))
            px[x, y] = (
                int(lerp(top[0], bottom[0], t)),
                int(lerp(top[1], bottom[1], t)),
                int(lerp(top[2], bottom[2], t)),
            )
    return img


def upscale(field):
    return field.resize((W, H), Image.LANCZOS)


def vignette(img, strength=0.55, cx=0.5, cy=0.42):
    """Darken towards the edges, keyed off-centre.

    Off-centre because that is what a lit room looks like: one key light, brightest
    somewhere above the middle. Dead-centre reads as a computer-generated glow.
    """
    mask = Image.new("L", FIELD)
    mp = mask.load()
    w, h = FIELD
    for y in range(h):
        fy = (y / (h - 1) - cy) * 1.35
        for x in range(w):
            fx = x / (w - 1) - cx
            d = min(1.0, math.sqrt(fx * fx + fy * fy) / 0.78)
            mp[x, y] = int(255 * (1 - strength * d * d))
    mask = mask.resize((W, H), Image.LANCZOS)
    return Image.composite(img, Image.new("RGB", (W, H), (0, 0, 0)), mask)


def grain(img, amount=6, seed=1):
    """Fine monochrome noise, so a flat area does not band on an 8-bit display.

    Generated small and upscaled with NEAREST — grain wants to stay grain, and
    resampling it smoothly would turn it into blotches.
    """
    rnd = random.Random(seed)
    small = Image.new("L", (W // 2, H // 2))
    sp = small.load()
    for y in range(H // 2):
        for x in range(W // 2):
            sp[x, y] = 128 + rnd.randint(-amount, amount)
    noise = small.resize((W, H), Image.NEAREST)
    return Image.blend(img, Image.merge("RGB", (noise, noise, noise)), 0.055)


def bokeh(base, circles, palette, seed=7, blur=26):
    """Soft out-of-focus highlights. What makes a dark background read as a room."""
    rnd = random.Random(seed)
    layer = base.copy()
    draw = ImageDraw.Draw(layer, "RGBA")
    for _ in range(circles):
        r = rnd.randint(40, 190)
        x = rnd.randint(-60, W + 60)
        y = rnd.randint(-60, H + 60)
        colour = rnd.choice(palette)
        alpha = rnd.randint(28, 92)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=colour + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(blur))


# ------------------------------------------------------------------ the ten


def slate():
    """Studio charcoal. The safest background there is: dark, quiet, no content."""
    img = upscale(linear((58, 62, 72), (24, 26, 32)))
    return grain(vignette(img, 0.5), 5, 11)


def mist():
    """A neutral photographic backdrop — light grey, softly lit from above."""
    img = upscale(linear((238, 240, 243), (196, 201, 209)))
    return grain(vignette(img, 0.22, 0.5, 0.32), 4, 12)


def linen():
    """Warm off-white with a paper texture. Reads as a bright, plain wall."""
    img = upscale(linear((246, 243, 236), (226, 220, 208)))
    img = grain(img, 9, 13)
    return vignette(img, 0.18, 0.5, 0.35)


def dusk():
    return grain(
        vignette(
            upscale(
                mesh([
                    (0.08, 0.12, (72, 56, 148)),
                    (0.92, 0.08, (38, 44, 116)),
                    (0.20, 0.95, (26, 24, 62)),
                    (0.85, 0.90, (96, 52, 132)),
                ])
            ),
            0.3,
        ),
        4,
        14,
    )


def aurora():
    return grain(
        vignette(
            upscale(
                mesh([
                    (0.05, 0.20, (16, 88, 104)),
                    (0.55, 0.02, (30, 132, 128)),
                    (0.95, 0.45, (22, 74, 118)),
                    (0.35, 0.98, (12, 44, 68)),
                ])
            ),
            0.28,
        ),
        4,
        15,
    )


def ember():
    return grain(
        vignette(
            upscale(
                mesh([
                    (0.10, 0.05, (196, 118, 74)),
                    (0.90, 0.15, (168, 74, 92)),
                    (0.25, 0.92, (92, 44, 66)),
                    (0.95, 0.95, (58, 32, 52)),
                ])
            ),
            0.32,
        ),
        4,
        16,
    )


def bokeh_warm():
    """A lit room behind you, out of focus."""
    base = upscale(linear((44, 34, 28), (18, 14, 14)))
    lit = bokeh(base, 26, [(255, 196, 116), (255, 158, 96), (214, 152, 88)], 21, 30)
    return grain(vignette(lit, 0.42), 5, 17)


def bokeh_cool():
    """An office at night. Cooler, sparser, a little more formal."""
    base = upscale(linear((26, 34, 50), (12, 16, 26)))
    lit = bokeh(base, 22, [(140, 190, 255), (108, 148, 226), (86, 200, 208)], 33, 32)
    return grain(vignette(lit, 0.44), 5, 18)


def grid():
    """A blueprint grid, very faint. Technical without being busy."""
    img = upscale(linear((245, 247, 250), (223, 229, 238)))
    draw = ImageDraw.Draw(img, "RGBA")
    step = 60
    for x in range(0, W + 1, step):
        draw.line([(x, 0), (x, H)], fill=(120, 140, 170, 26), width=1)
    for y in range(0, H + 1, step):
        draw.line([(0, y), (W, y)], fill=(120, 140, 170, 26), width=1)
    for x in range(0, W + 1, step * 5):
        draw.line([(x, 0), (x, H)], fill=(96, 122, 160, 40), width=2)
    for y in range(0, H + 1, step * 5):
        draw.line([(0, y), (W, y)], fill=(96, 122, 160, 40), width=2)
    return grain(vignette(img, 0.2, 0.5, 0.4), 3, 19)


def arc():
    """Large soft arcs in the product blue. A presentation backdrop."""
    img = upscale(linear((247, 249, 252), (228, 236, 248)))
    layer = img.copy()
    draw = ImageDraw.Draw(layer, "RGBA")
    for i, (r, alpha) in enumerate([(1500, 34), (1150, 40), (800, 46), (470, 54)]):
        cx, cy = int(W * 0.86), int(H * 1.02)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(11, 92, 255, alpha), width=90 - i * 12)
    layer = layer.filter(ImageFilter.GaussianBlur(2))
    return grain(vignette(layer, 0.16, 0.4, 0.38), 3, 20)


BACKGROUNDS = [
    ("slate", slate),
    ("mist", mist),
    ("linen", linen),
    ("dusk", dusk),
    ("aurora", aurora),
    ("ember", ember),
    ("bokeh-warm", bokeh_warm),
    ("bokeh-cool", bokeh_cool),
    ("grid", grid),
    ("arc", arc),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, build in BACKGROUNDS:
        img = build()
        # WebP at quality 82 for the full size: it is a third of the JPEG for the same
        # picture, and every browser that can run WebGL segmentation can decode it.
        full = os.path.join(OUT, f"{name}.webp")
        img.save(full, "WEBP", quality=82, method=5)
        thumb = os.path.join(OUT, f"{name}-thumb.webp")
        img.resize(THUMB, Image.LANCZOS).save(thumb, "WEBP", quality=80, method=5)
        print(f"{name:12} {os.path.getsize(full) // 1024:>5} KB   thumb "
              f"{os.path.getsize(thumb) // 1024:>3} KB")


if __name__ == "__main__":
    main()
