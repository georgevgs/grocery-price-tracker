#!/usr/bin/env python3
"""Generate the Τιμούλα app icons into apps/web/public/.

The brand mark is a handwritten lowercase «τ» (Greek tau) in ink (#0e0e0c) on
the app's accent field (#ccff00). The τ outline is baked from Playpen Sans
(weight 800) into the SVG path below, then flattened to polygons here — so the
icons render identically everywhere with no font or network dependency, and
match the app's warm, hand-drawn identity. The same path drives favicon.svg and
the in-app <Logomark>/<Wordmark> (see src/components/BrandLogo.tsx).

Requires Pillow (`pip install pillow`). Outputs:
  pwa-192.png            192, purpose "any"   — rounded badge + ink frame
  pwa-512.png            512, purpose "any"
  pwa-maskable-512.png   512, purpose "maskable" — full-bleed, τ in safe zone
  apple-touch-icon.png   180, iOS home screen (opaque)
  favicon.svg            vector, same geometry

Usage: python3 apps/web/scripts/generate-icons.py [output_dir]
"""
import os
import re
import sys

from PIL import Image, ImageDraw

ACCENT = (204, 255, 0, 255)   # --color-accent  #ccff00
INK = (14, 14, 12, 255)       # --color-ink     #0e0e0c

# Handwritten «τ» outline (Playpen Sans, weight 800), in a 549.3 x 557.1
# box, y-down. Commands are absolute M/L/Q/Z as emitted by fontTools' SVG pen.
TAU_PATH = (
    "M302 557Q248 557 217 536Q185 515 169 481Q153 447 148 408Q143 368 143"
    " 331Q143 296 145 266Q146 235 149 207Q151 178 154 151Q134 152 116 153"
    "Q97 154 81 156Q38 161 23 146Q7 131 2 104Q-5 65 10 40Q25 15 56 10Q94 "
    "3 154 4Q213 5 275 7Q334 8 385 9Q435 9 470 2Q501 -4 518 7Q535 18 543 "
    "38Q550 58 549 81Q548 107 537 125Q526 142 500 147Q489 149 476 151Q462"
    " 152 446 153Q430 153 413 154Q395 154 377 154Q358 153 338 153Q336 171"
    " 335 191Q333 211 332 232Q330 252 330 273Q329 293 329 314Q329 348 334"
    " 365Q339 381 348 386Q356 391 365 391Q377 391 386 384Q395 377 406 363"
    "Q416 351 429 341Q441 331 458 331Q474 331 491 342Q507 353 519 371Q531"
    " 388 531 409Q531 431 522 450Q512 469 496 485Q472 509 439 525Q405 541"
    " 369 549Q333 557 302 557Z"
)
TAU_W, TAU_H = 549.3000, 557.1000

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "public")
SS = 4  # supersample for crisp antialiased edges


def _flatten(path, steps=24):
    """Parse absolute M/L/Q/Z and return contours as lists of (x, y)."""
    contours, cur, start, px, py = [], [], (0.0, 0.0), 0.0, 0.0
    for cmd, chunk in re.findall(r"([MLQZ])([-0-9.eE ]*)", path):
        nums = [float(n) for n in chunk.split()]
        if cmd == "M":
            if cur:
                contours.append(cur)
            px, py = nums[0], nums[1]
            start, cur = (px, py), [(px, py)]
        elif cmd == "L":
            for i in range(0, len(nums), 2):
                px, py = nums[i], nums[i + 1]
                cur.append((px, py))
        elif cmd == "Q":
            for i in range(0, len(nums), 4):
                cx, cy, ex, ey = nums[i:i + 4]
                for s in range(1, steps + 1):
                    t = s / steps
                    mt = 1 - t
                    x = mt * mt * px + 2 * mt * t * cx + t * t * ex
                    y = mt * mt * py + 2 * mt * t * cy + t * t * ey
                    cur.append((x, y))
                px, py = ex, ey
        elif cmd == "Z":
            cur.append(start)
    if cur:
        contours.append(cur)
    return contours


def draw_mark(draw, size, ratio, fill=INK, nudge_up=0.0):
    """Draw the τ, scaled to `ratio` of `size` in height and centred."""
    th = ratio * size
    sc = th / TAU_H
    tw = TAU_W * sc
    ox = (size - tw) / 2.0
    oy = (size - th) / 2.0 - nudge_up * size
    for contour in _flatten(TAU_PATH):
        draw.polygon([(ox + x * sc, oy + y * sc) for x, y in contour], fill=fill)


def render(size, *, opaque, frame, ratio):
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
    draw_mark(d, s, ratio, nudge_up=0.01)
    return img.resize((size, size), Image.LANCZOS)


def favicon_svg():
    s = 100
    ratio = 0.56
    th = ratio * s
    sc = th / TAU_H
    tw = TAU_W * sc
    ox = (s - tw) / 2.0
    oy = (s - th) / 2.0 - 0.5
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">'
            f'<rect width="{s}" height="{s}" rx="22" fill="#ccff00"/>'
            f'<path transform="translate({ox:.2f} {oy:.2f}) scale({sc:.5f})" '
            f'd="{TAU_PATH}" fill="#0e0e0c"/></svg>\n')


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        (render(192, opaque=False, frame=True, ratio=0.50), "pwa-192.png"),
        (render(512, opaque=False, frame=True, ratio=0.50), "pwa-512.png"),
        (render(512, opaque=True, frame=False, ratio=0.46), "pwa-maskable-512.png"),
        (render(180, opaque=True, frame=True, ratio=0.50), "apple-touch-icon.png"),
    ]
    for img, name in jobs:
        img.save(os.path.join(OUT, name))
        print("wrote", name, img.size)
    with open(os.path.join(OUT, "favicon.svg"), "w") as f:
        f.write(favicon_svg())
    print("wrote favicon.svg")


if __name__ == "__main__":
    main()
