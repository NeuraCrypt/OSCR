"""The badge's logo: the owner's wordmark, small, embedded in every badge (docs/BADGE.md).

    python3 tools/make_badge_logo.py

Reads `website/public/brand/logo-wordmark-white.png` (the wordmark cropped to its ink, white on
transparent, made by tools/make_logo_assets.py) and writes `website/src/lib/badge-logo.ts`: the
wordmark at LOGO_HEIGHT pixels (four times the height a 20-pixel badge draws it at, so that it stays
sharp on a high-density screen), as two PNG data URIs, white and in the logo's blue; and
`website/public/badge.png`, the mark alone on the logo's blue at four times its size, for what reads
no SVG (LaTeX, a word processor, an email, a social network's preview).

A badge is an SVG shown through an <img> (or GitHub's camo proxy): such an image may not load
anything outside itself, so the logo travels inside it, as shields.io does with its logos. No
dependency but the standard library: the reduction averages the coverage (alpha) of the source
pixels each target pixel covers (an area filter, exact for a flat-coloured mark).
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_logo_assets import BLUE, WHITE, read_png, write_png  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "website" / "public" / "brand" / "logo-wordmark-white.png"
TARGET = ROOT / "website" / "src" / "lib" / "badge-logo.ts"
PNG_BADGE = ROOT / "website" / "public" / "badge.png"
#: The PNG badge's margin around the mark, in pixels (6 at the badge's own size).
PNG_PAD = 24
#: The PNG's height in pixels.
LOGO_HEIGHT = 40


def coverage(path: Path, height: int) -> tuple[int, int, list[list[float]]]:
    """The mark's alpha, reduced to `height` rows by an area filter (0.0 to 1.0 a pixel)."""
    w, h, rows = read_png(path)
    alpha = [[row[4 * x + 3] / 255.0 for x in range(w)] for row in rows]
    # A summed-area table: the sum over any rectangle in four reads.
    sat = [[0.0] * (w + 1) for _ in range(h + 1)]
    for y in range(h):
        acc = 0.0
        for x in range(w):
            acc += alpha[y][x]
            sat[y + 1][x + 1] = sat[y][x + 1] + acc

    def area(x0: float, y0: float, x1: float, y1: float) -> float:
        # Integer bounds suffice at this reduction (about 12 source pixels a target pixel).
        a, b, c, d = int(x0), int(y0), max(int(x0) + 1, int(round(x1))), max(int(y0) + 1, int(round(y1)))
        c, d = min(c, w), min(d, h)
        n = (c - a) * (d - b)
        return (sat[d][c] - sat[b][c] - sat[d][a] + sat[b][a]) / n if n else 0.0

    scale = h / height
    width = max(1, round(w / scale))
    out = [[area(x * scale, y * scale, (x + 1) * scale, (y + 1) * scale) for x in range(width)] for y in range(height)]
    return width, height, out


def png(width: int, height: int, cov: list[list[float]], colour: tuple[int, int, int], tmp: Path) -> bytes:
    rows = []
    for line in cov:
        row = bytearray()
        for a in line:
            row += bytes((*colour, max(0, min(255, round(a * 255)))))
        rows.append(row)
    write_png(tmp, width, height, rows)
    data = tmp.read_bytes()
    tmp.unlink()
    return data


def main() -> int:
    width, height, cov = coverage(SOURCE, LOGO_HEIGHT)
    tmp = TARGET.with_suffix(".tmp.png")
    white = base64.b64encode(png(width, height, cov, WHITE, tmp)).decode()
    blue = base64.b64encode(png(width, height, cov, BLUE, tmp)).decode()
    TARGET.write_text(
        "// Made by tools/make_badge_logo.py from public/brand/logo-wordmark-white.png: do not edit by hand.\n"
        "// The owner's wordmark, small, embedded in every badge (an image shown through <img> loads\n"
        "// nothing outside itself). docs/BADGE.md.\n\n"
        f"/** The PNG's size in pixels: drawn at a quarter of it on a 20-pixel badge. */\n"
        f"export const LOGO_PX = {{ width: {width}, height: {height} }} as const;\n"
        f'/** White, for the logo\'s blue ground. */\nexport const LOGO_WHITE = "data:image/png;base64,{white}";\n'
        f'/** The logo\'s blue (#04408F), for a white ground. */\nexport const LOGO_BLUE = "data:image/png;base64,{blue}";\n',
        encoding="utf-8",
    )
    # The PNG badge: the white mark over the blue, the coverage blended (no alpha left).
    rows = [bytearray(bytes((*BLUE, 255)) * (width + 2 * PNG_PAD)) for _ in range(height + 2 * PNG_PAD)]
    for y, line in enumerate(cov):
        row = rows[y + PNG_PAD]
        for x, a in enumerate(line):
            i = 4 * (x + PNG_PAD)
            row[i:i + 3] = bytes(round(b + (c - b) * a) for b, c in zip(BLUE, WHITE))
    write_png(PNG_BADGE, width + 2 * PNG_PAD, height + 2 * PNG_PAD, rows, alpha=False)
    print(f"{PNG_BADGE.relative_to(ROOT)}: {width + 2 * PNG_PAD} x {height + 2 * PNG_PAD}")
    print(f"{TARGET.relative_to(ROOT)}: {width} x {height}, {len(white) + len(blue)} characters of base64")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
