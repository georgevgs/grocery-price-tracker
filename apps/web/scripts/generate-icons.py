#!/usr/bin/env python3
"""Generate the Τιμούλα app icons into apps/web/public/.

The brand mark is a bold capital «Τ» in ink (#0e0e0c) on the app's accent
field (#ccff00). The Τ is drawn as geometric strokes rather than set from a
font, so it renders identically everywhere and matches the app's hard-edged,
neo-brutalist identity — no dependency on a Greek-capable font being present.

Requires Pillow (`pip install pillow`). Outputs:
  pwa-192.png            192, purpose "any"   — rounded badge + ink frame
  pwa-512.png            512, purpose "any"
  pwa-maskable-512.png   512, purpose "maskable" — full-bleed, Κ in safe zone
  apple-touch-icon.png   180, iOS home screen (opaque)
  favicon.svg            vector, same geometry

Usage: python3 apps/web/scripts/generate-icons.py [output_dir]
"""
import os
import sys

from PIL import Image, ImageDraw

ACCENT = (204, 255, 0, 255)   # --color-accent  #ccff00
INK = (14, 14, 12, 255)       # --color-ink     #0e0e0c

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "public")
SS = 4  # supersample for crisp antialiased edges


def mark_polys(height):
    """Geometric capital Tau in local top-left coords; returns polygons."""
    t = 0.190 * height          # stroke thickness (bold)
    w = 0.820 * height          # top-bar width
    bar = [(0, 0), (w, 0), (w, t), (0, t)]
    stem = [((w - t) / 2, 0), ((w + t) / 2, 0), ((w + t) / 2, height), ((w - t) / 2, height)]
    return [bar, stem]


def _bbox(polys):
    xs = [p[0] for poly in polys for p in poly]
    ys = [p[1] for poly in polys for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def draw_mark(draw, size, k_ratio, fill=INK):
    polys = mark_polys(k_ratio * size)
    x0, y0, x1, y1 = _bbox(polys)
    ox = (size - (x1 - x0)) / 2.0 - x0   # optically center the ink bbox
    oy = (size - (y1 - y0)) / 2.0 - y0
    for poly in polys:
        draw.polygon([(px + ox, py + oy) for px, py in poly], fill=fill)


def render(size, *, opaque, frame, k_ratio):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if opaque:
        d.rectangle([0, 0, s, s], fill=ACCENT)
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(0.205 * s), fill=ACCENT)
    if frame:
        m = int(0.086 * s)
        d.rounded_rectangle([m, m, s - 1 - m, s - 1 - m], radius=int(0.125 * s),
                            outline=INK, width=max(2, int(0.055 * s)))
    draw_mark(d, s, k_ratio)
    return img.resize((size, size), Image.LANCZOS)


def favicon_svg():
    s = 100
    polys = mark_polys(0.56 * s)
    x0, y0, x1, y1 = _bbox(polys)
    ox = (s - (x1 - x0)) / 2.0 - x0
    oy = (s - (y1 - y0)) / 2.0 - y0
    parts = []
    for poly in polys:
        p = " ".join(f"{px + ox:.2f},{py + oy:.2f}" for px, py in poly)
        parts.append(f'<polygon points="{p}" fill="#0e0e0c"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">'
            f'<rect width="{s}" height="{s}" rx="22" fill="#ccff00"/>'
            + "".join(parts) + "</svg>\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        (render(192, opaque=False, frame=True, k_ratio=0.50), "pwa-192.png"),
        (render(512, opaque=False, frame=True, k_ratio=0.50), "pwa-512.png"),
        (render(512, opaque=True, frame=False, k_ratio=0.46), "pwa-maskable-512.png"),
        (render(180, opaque=True, frame=True, k_ratio=0.50), "apple-touch-icon.png"),
    ]
    for img, name in jobs:
        img.save(os.path.join(OUT, name))
        print("wrote", name, img.size)
    with open(os.path.join(OUT, "favicon.svg"), "w") as f:
        f.write(favicon_svg())
    print("wrote favicon.svg")


if __name__ == "__main__":
    main()
