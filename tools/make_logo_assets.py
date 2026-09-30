"""The website's logo files, made from the owner's logo (2026-09-29).

    python3 tools/make_logo_assets.py website/public/brand/logo-original.png

The owner's file is a 2000 × 2000 PNG: the wordmark in its blue on a transparent ground, with a
wide margin. This writes, in `website/public/`:

- `brand/logo-wordmark.png` and `brand/logo-wordmark-white.png`: the wordmark cropped to its ink,
  full size, in its blue and in white, on transparent (the Brand page's downloads);
- `brand/logo-wordmark-600.png` (the About and Brand pages) and `brand/logo-masthead.png` (white,
  320 pixels wide: the masthead);
- `favicon-32.png`, `favicon.ico` (the same PNG inside), `apple-touch-icon.png` (180) and
  `icon-512.png`: the white wordmark on the logo's blue, square;
- `og-image.png`: 1200 × 630, the blue wordmark on white, a rule of the masthead's colour at its
  foot (the preview of a link to the site).

No dependency but the standard library and macOS's `sips`, which resamples (Core Image): a small
PNG reader and writer below (8-bit, no interlacing). The colours are flat, every pixel the logo's
blue or white, and the coverage is in the alpha channel, so the files stay small.
"""
from __future__ import annotations

import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

#: The logo's blue, as the owner's file draws it (#04408F).
BLUE = (4, 64, 143)
WHITE = (255, 255, 255)
#: The masthead's colour (website/src/styles/science.css --masthead).
MASTHEAD = (0x1F, 0x3B, 0x4D)

Rows = list[bytearray]


def read_png(path: Path) -> tuple[int, int, Rows]:
    """An 8-bit PNG as rows of RGBA bytes."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")
    pos, idat, palette, trns = 8, b"", b"", b""
    width = height = ctype = 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or interlace:
                raise SystemExit(f"{path}: only 8-bit, non-interlaced PNGs")
        elif kind == b"PLTE":
            palette = body
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat += body
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    raw, stride = zlib.decompress(idat), width * channels
    prev, rows, i = bytearray(stride), [], 0
    for _ in range(height):
        kind, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            left = line[x - channels] if x >= channels else 0
            up, corner = prev[x], (prev[x - channels] if x >= channels else 0)
            if kind == 1:
                line[x] = (line[x] + left) & 255
            elif kind == 2:
                line[x] = (line[x] + up) & 255
            elif kind == 3:
                line[x] = (line[x] + ((left + up) >> 1)) & 255
            elif kind == 4:
                p = left + up - corner
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - corner)
                line[x] = (line[x] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 255
        rows.append(line)
        prev = line
    out: Rows = []
    for line in rows:
        rgba = bytearray(width * 4)
        for x in range(width):
            if ctype == 6:
                rgba[4 * x:4 * x + 4] = line[4 * x:4 * x + 4]
            elif ctype == 2:
                rgba[4 * x:4 * x + 4] = line[3 * x:3 * x + 3] + b"\xff"
            elif ctype == 0:
                rgba[4 * x:4 * x + 4] = bytes([line[x]] * 3) + b"\xff"
            elif ctype == 4:
                rgba[4 * x:4 * x + 4] = bytes([line[2 * x]] * 3 + [line[2 * x + 1]])
            else:
                k = line[x]
                rgba[4 * x:4 * x + 4] = palette[3 * k:3 * k + 3] + bytes([trns[k] if k < len(trns) else 255])
        out.append(rgba)
    return width, height, out


def _chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def write_png(path: Path, width: int, height: int, rows: Rows, alpha: bool = True) -> int:
    """RGBA rows as a PNG (RGB when `alpha` is false), each row with the smallest of three filters."""
    channels, raw, prev = (4 if alpha else 3), bytearray(), b""
    for rgba in rows:
        line = bytes(rgba) if alpha else bytes(b for x in range(width) for b in rgba[4 * x:4 * x + 3])
        prev = prev or bytes(len(line))
        sub = bytes((line[x] - (line[x - channels] if x >= channels else 0)) & 255 for x in range(len(line)))
        up = bytes((line[x] - prev[x]) & 255 for x in range(len(line)))
        cost = lambda row: sum(v if v < 128 else 256 - v for v in row)  # noqa: E731
        kind, best = min(((0, line), (1, sub), (2, up)), key=lambda c: cost(c[1]))
        raw += bytes([kind]) + best
        prev = line
    header = struct.pack(">IIBBBBB", width, height, 8, 6 if alpha else 2, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + _chunk(b"IEND", b"")
    path.write_bytes(data)
    return len(data)


def flat(rows: Rows, color: tuple[int, int, int]) -> Rows:
    """Every pixel in one colour, its alpha kept."""
    out = []
    for line in rows:
        n, px = len(line) // 4, bytearray(line)
        for c in range(3):
            px[c::4] = bytes([color[c]]) * n
        out.append(px)
    return out


def resample(src: Path, width: int, color: tuple[int, int, int], dst: Path) -> tuple[int, int, Rows]:
    """`src` resampled by sips to `width` pixels, its colours made flat again."""
    subprocess.run(["sips", "--resampleWidth", str(width), str(src), "--out", str(dst)], check=True, capture_output=True)
    w, h, rows = read_png(dst)
    rows = flat(rows, color)
    write_png(dst, w, h, rows)
    return w, h, rows


def canvas(width: int, height: int, color: tuple[int, int, int], mark: tuple[int, int, Rows]) -> Rows:
    """A plain canvas with `mark` (RGBA) blended in at its centre."""
    rows = [bytearray(bytes([*color, 255]) * width) for _ in range(height)]
    mw, mh, mrows = mark
    ox, oy = (width - mw) // 2, (height - mh) // 2
    for y in range(mh):
        for x in range(mw):
            a = mrows[y][4 * x + 3] / 255
            if a:
                i = 4 * (ox + x)
                for c in range(3):
                    rows[oy + y][i + c] = round(mrows[y][4 * x + c] * a + rows[oy + y][i + c] * (1 - a))
    return rows


def main(original: Path, public: Path) -> None:
    w, h, rows = read_png(original)
    inked = [(x, y) for y, line in enumerate(rows) for x in range(w) if line[4 * x + 3]]
    x0, x1 = min(x for x, _ in inked), max(x for x, _ in inked)
    y0, y1 = min(y for _, y in inked), max(y for _, y in inked)
    crop = [bytearray(rows[y][4 * x0:4 * (x1 + 1)]) for y in range(y0, y1 + 1)]
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    brand = public / "brand"
    brand.mkdir(parents=True, exist_ok=True)
    sizes = {}
    sizes["brand/logo-wordmark.png"] = write_png(brand / "logo-wordmark.png", cw, ch, flat(crop, BLUE))
    sizes["brand/logo-wordmark-white.png"] = write_png(brand / "logo-wordmark-white.png", cw, ch, flat(crop, WHITE))
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        resample(brand / "logo-wordmark.png", 600, BLUE, brand / "logo-wordmark-600.png")
        resample(brand / "logo-wordmark-white.png", 320, WHITE, brand / "logo-masthead.png")
        for size, mark in ((32, 28), (180, 156), (512, 440)):
            m = resample(brand / "logo-wordmark-white.png", mark, WHITE, t / f"mark-{size}.png")
            name = {32: "favicon-32.png", 180: "apple-touch-icon.png", 512: "icon-512.png"}[size]
            sizes[name] = write_png(public / name, size, size, canvas(size, size, BLUE, m), alpha=False)
        png = (public / "favicon-32.png").read_bytes()
        ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(png), 22) + png
        (public / "favicon.ico").write_bytes(ico)
        og = canvas(1200, 630, WHITE, resample(brand / "logo-wordmark.png", 760, BLUE, t / "og-mark.png"))
        for y in range(630 - 14, 630):
            og[y] = bytearray(bytes([*MASTHEAD, 255]) * 1200)
        sizes["og-image.png"] = write_png(public / "og-image.png", 1200, 630, og, alpha=False)
    print(f"wordmark {cw} × {ch} (cropped from {w} × {h}); " + ", ".join(f"{k} {v:,} bytes" for k, v in sizes.items()))


if __name__ == "__main__":
    here = Path(__file__).resolve().parents[1] / "website" / "public"
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else here / "brand" / "logo-original.png", here)
