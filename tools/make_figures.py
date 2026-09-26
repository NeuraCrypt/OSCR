#!/usr/bin/env python3
"""The README figures, drawn from the harvester's database as SVG, light and dark.

    python tools/make_figures.py
    python tools/make_figures.py --db data/oscr.db --out docs/assets/figures --date 2026-09-26

Standard library only (sqlite3 and string building): the figures can be redrawn on any
machine that holds the database, with nothing to install, and an SVG is text, so a change
in a figure is a readable diff. The database is opened READ-ONLY, inside one read
transaction: the harvester keeps writing (WAL) while this runs, and every number comes
from the same snapshot.

Each figure is written twice, `<name>-light.svg` and `<name>-dark.svg`, for the
`<picture>` + `prefers-color-scheme` pairs of README.md:

- `kpis`: papers read, papers with the authors' code, code repositories, scripts kept as text;
- `hosts`: where the authors' code lives;
- `years`: papers read and papers with verified code, by publication year;
- `languages`: languages of the harvested scripts;
- `licenses`: licenses of the authors' repositories, and whether their text may be republished;
- `ladder`: the evidence ladder, found → alive → inventoried → imported.

`figures.json` holds every number drawn: the table view of the charts.

The colors are a validated palette (categorical slots 1-2 and a one-hue ordinal ramp),
checked for color-vision deficiency and contrast against GitHub's light (#ffffff) and
dark (#0d1117) pages. Text never wears a series color; bars are at most 24 px thick,
rounded at their data end only, with the value at the tip.
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

#: Statuses of an article whose authors' code was found (db.STATUSES).
CODE_STATUSES: tuple[str, ...] = ("code_verified", "code_found", "code_empty", "code_dead")
#: The evidence ladder, lowest to highest (db.LEVELS), and what each level means.
LEVELS: tuple[str, ...] = ("found", "alive", "inventoried", "imported")
LEVEL_NOTES: dict[str, str] = {
    "found": "cited by the paper",
    "alive": "the link answers",
    "inventoried": "files listed, commit recorded",
    "imported": "snapshot kept, license permitting",
}
#: `repository.redistributable` values under which the public catalogue republishes the
#: text of a script (catalog.PUBLISHABLE).
REPUBLISHABLE: frozenset[str] = frozenset({"yes", "with_conditions"})
#: What this script reads. A missing table or column means the wrong database (an older
#: schema, say), and is reported as such.
REQUIRED: dict[str, tuple[str, ...]] = {
    "article": ("id", "published", "status", "has_fulltext", "scanned_at"),
    "link": ("article_id", "repo", "host", "role"),
    "repository": ("repo", "state", "license", "redistributable"),
    "script": ("repo", "origin", "level"),
    "file": ("repo", "language", "kind", "text"),
}
#: Named rows before the tail folds into "Other": eight rows at most, the ceiling of a
#: bar chart that is read, not decoded.
TOP = 7
FIGURES: tuple[str, ...] = ("kpis", "hosts", "years", "languages", "licenses", "ladder")


# ── the numbers ─────────────────────────────────────────────────────────────

@dataclass
class Data:
    """Every number the figures draw; `as_json()` is their table view."""
    papers_read: int = 0
    fulltext: int = 0
    with_code: int = 0
    verified: int = 0
    repositories: int = 0
    alive: int = 0
    scripts: int = 0
    script_bytes: int = 0
    hosts: list[tuple[str, int]] = field(default_factory=list)
    years: list[tuple[int, int, int]] = field(default_factory=list)  # (year, read, verified)
    undated: int = 0
    languages: list[tuple[str, int]] = field(default_factory=list)
    licenses: list[tuple[str, int, int]] = field(default_factory=list)  # (label, republished, link only)
    ladder: list[tuple[str, int]] = field(default_factory=list)

    def as_json(self) -> dict[str, Any]:
        return {
            "kpis": {"papers_read": self.papers_read, "with_fulltext": self.fulltext,
                     "with_authors_code": self.with_code, "with_verified_code": self.verified,
                     "code_repositories": self.repositories, "alive_repositories": self.alive,
                     "scripts_kept_as_text": self.scripts, "script_text_bytes": self.script_bytes},
            "hosts": [{"host": h, "repositories": v} for h, v in self.hosts],
            "years": [{"year": y, "papers_read": r, "with_verified_code": v} for y, r, v in self.years],
            "undated_papers": self.undated,
            "languages": [{"language": lang, "scripts": v} for lang, v in self.languages],
            "licenses": [{"license": lic, "text_republished": a, "link_only": b}
                         for lic, a, b in self.licenses],
            "ladder": [{"level": lvl, "repositories": v} for lvl, v in self.ladder],
        }


_HOST_LABELS: dict[str, str] = {
    "github.com": "GitHub", "gist.github.com": "GitHub", "gitlab.com": "GitLab",
    "zenodo.org": "Zenodo", "osf.io": "OSF", "figshare.com": "figshare",
    "gin.g-node.org": "G-Node GIN", "doi.gin.g-node.org": "G-Node GIN", "datadryad.org": "Dryad",
    "huggingface.co": "Hugging Face", "codeberg.org": "Codeberg", "bitbucket.org": "Bitbucket",
    "sourceforge.net": "SourceForge", "codeocean.com": "Code Ocean",
    "modeldb.science": "ModelDB", "senselab.med.yale.edu": "ModelDB", "modeldb.yale.edu": "ModelDB",
    "opensourcebrain.org": "Open Source Brain", "v2.opensourcebrain.org": "Open Source Brain",
    "archive.softwareheritage.org": "Software Heritage",
}
#: A repository known only by its DOI has the host `doi:<registrant>` (links.DOI_PREFIXES).
_DOI_LABELS: dict[str, str] = {
    "zenodo": "Zenodo", "osf": "OSF", "figshare": "figshare", "gin": "G-Node GIN",
    "dryad": "Dryad", "codeocean": "Code Ocean", "dataverse": "Dataverse",
    "mendeley": "Mendeley Data", "openneuro": "OpenNeuro", "dandi": "DANDI",
}
#: License values that are not SPDX identifiers (repos.normalize_license).
_LICENSE_LABELS: dict[str, str] = {"other": "Unrecognized license", "other-open": "Other open license"}


def host_label(host: str, repo: str) -> str:
    """The host a reader recognizes: `github.com` and `gist.github.com` are both GitHub,
    a self-hosted GitLab is GitLab, a DOI names its archive. Personal pages and
    institutional forges fall into "Other"."""
    if repo.startswith("supp:"):
        return "Supplementary files"
    h = (host or "").lower()
    if h.startswith("doi:"):
        return _DOI_LABELS.get(h[4:], "Other")
    h = h.removeprefix("www.")
    if h in _HOST_LABELS:
        return _HOST_LABELS[h]
    if h.startswith("gitlab.") or ".gitlab." in h:
        return "GitLab"
    if h.endswith(".figshare.com"):
        return "figshare"
    return "Other"


def license_label(license_: str, redistributable: str) -> str:
    if license_:
        return _LICENSE_LABELS.get(license_, license_)
    # No license string. A repository checked and found without a license is "all rights
    # reserved"; one whose license could not be determined (a dead link, an archive with
    # no license metadata) is a different case, and is not drawn as the same bar.
    return "No license" if redistributable == "no" else "Not determined"


def fold(counts: dict[str, int], top: int = TOP, other: str = "Other") -> list[tuple[str, int]]:
    """The `top` largest named rows, largest first (ties by name), then one `other` row
    that sums the tail and anything already filed under `other`."""
    named = sorted(((k, v) for k, v in counts.items() if k != other and v > 0),
                   key=lambda kv: (-kv[1], kv[0].lower()))
    rows = named[:top]
    rest = sum(v for _, v in named[top:]) + counts.get(other, 0)
    return rows + ([(other, rest)] if rest else [])


def open_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise SystemExit(f"no database at {path}: run the harvester first (`oscr run`), or pass --db")
    con = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    con.row_factory = sqlite3.Row
    for table, columns in REQUIRED.items():
        found = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        missing = [c for c in columns if c not in found]
        if missing:
            con.close()
            what = f"table `{table}`" if not found else f"`{table}.{', '.join(missing)}`"
            raise SystemExit(f"{path} is not an OSCR database with the English schema: {what} is missing")
    return con


def _one(con: sqlite3.Connection, sql: str, *args: Any) -> int:
    return con.execute(sql, args).fetchone()[0] or 0


def collect(path: Path) -> Data:
    con = open_readonly(path)
    try:
        con.execute("BEGIN")  # one snapshot for every query, while the harvester writes
        code_repos = "SELECT repo FROM link WHERE role = 'code'"
        scripts = f"FROM file WHERE kind = 'script' AND text IS NOT NULL AND repo IN ({code_repos})"
        marks = ",".join("?" * len(CODE_STATUSES))
        d = Data()
        d.papers_read = _one(con, "SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL")
        d.fulltext = _one(con, "SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL AND has_fulltext = 1")
        d.with_code = _one(con, f"SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL "
                                f"AND status IN ({marks})", *CODE_STATUSES)
        d.verified = _one(con, "SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL "
                               "AND status = 'code_verified'")
        d.repositories = _one(con, f"SELECT COUNT(DISTINCT repo) FROM ({code_repos})")
        d.alive = _one(con, f"SELECT COUNT(*) FROM repository WHERE state = 'alive' AND repo IN ({code_repos})")
        d.scripts = _one(con, f"SELECT COUNT(*) {scripts}")
        d.script_bytes = _one(con, f"SELECT SUM(LENGTH(CAST(text AS BLOB))) {scripts}")

        hosts: dict[str, int] = {}
        for r in con.execute("SELECT repo, MIN(host) AS host FROM link WHERE role = 'code' GROUP BY repo"):
            label = host_label(r["host"], r["repo"])
            hosts[label] = hosts.get(label, 0) + 1
        d.hosts = fold(hosts)

        for r in con.execute(
                "SELECT CAST(substr(published, 1, 4) AS INTEGER) AS year, COUNT(*) AS n, "
                "SUM(status = 'code_verified') AS v FROM article "
                "WHERE scanned_at IS NOT NULL AND published GLOB '[12][0-9][0-9][0-9]*' "
                "GROUP BY year ORDER BY year"):
            d.years.append((r["year"], r["n"], r["v"] or 0))
        d.undated = d.papers_read - sum(read for _, read, _ in d.years)

        languages: dict[str, int] = {}
        for r in con.execute(f"SELECT language, COUNT(*) AS n {scripts} GROUP BY language"):
            label = r["language"] or "Unknown"
            languages[label] = languages.get(label, 0) + r["n"]
        d.languages = fold(languages)

        split: dict[str, list[int]] = {}  # label → [text republished, link only]
        for r in con.execute(f"SELECT license, redistributable FROM repository WHERE repo IN ({code_repos})"):
            row = split.setdefault(license_label(r["license"] or "", r["redistributable"] or ""), [0, 0])
            row[0 if r["redistributable"] in REPUBLISHABLE else 1] += 1
        other = "Other licenses"
        rows = fold({k: a + b for k, (a, b) in split.items()}, other=other)
        shown = {label for label, _ in rows if label != other}
        for label, _ in rows:
            keys = [label] if label != other else [k for k in split if k not in shown]
            d.licenses.append((label, sum(split[k][0] for k in keys), sum(split[k][1] for k in keys)))

        best: dict[str, int] = {}
        for r in con.execute("SELECT repo, level FROM script WHERE origin = 'native'"):
            if r["level"] in LEVELS:
                best[r["repo"]] = max(best.get(r["repo"], 0), LEVELS.index(r["level"]))
        d.ladder = [(lvl, sum(1 for b in best.values() if b >= i)) for i, lvl in enumerate(LEVELS)]
        return d
    finally:
        con.close()


# ── drawing ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Theme:
    name: str
    background: str
    border: str
    ink: str       # titles, values, category labels
    ink_2: str     # subtitles, ticks, notes
    ink_3: str     # footnotes
    grid: str      # hairline gridlines and dividers
    axis: str      # the baseline
    series: tuple[str, str]  # categorical slots 1 and 2
    other: str     # de-emphasis: the "Other" row, the part of a column that is context
    ramp: tuple[str, str, str, str]  # ordinal, found → imported


LIGHT = Theme("light", background="#ffffff", border="#d0d7de", ink="#0b0b0b", ink_2="#52514e",
              ink_3="#6e6d68", grid="#e1e0d9", axis="#a8a69e", series=("#2a78d6", "#eb6834"),
              other="#b5b3ab", ramp=("#86b6ef", "#5598e7", "#2a78d6", "#1c5cab"))
DARK = Theme("dark", background="#0d1117", border="#30363d", ink="#ffffff", ink_2="#c3c2b7",
             ink_3="#9e9d97", grid="#2c2c2a", axis="#5b5a55", series=("#3987e5", "#d95926"),
             other="#4f4e4a", ramp=("#184f95", "#256abf", "#3987e5", "#6da7ec"))
THEMES: tuple[Theme, ...] = (LIGHT, DARK)

FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
TNUM = "font-variant-numeric:tabular-nums;font-feature-settings:'tnum'"


def css(t: Theme) -> str:
    return (f"text{{font-family:{FONT};fill:{t.ink}}}"
            ".title{font-size:15px;font-weight:600}"
            f".sub{{font-size:12.5px;fill:{t.ink_2}}}"
            ".cat{font-size:12.5px}"
            f".muted{{fill:{t.ink_2}}}"
            f".val{{font-size:12px;{TNUM}}}"
            f".tick{{font-size:11.5px;fill:{t.ink_2};{TNUM}}}"
            f".foot{{font-size:11px;fill:{t.ink_3}}}"
            f".kl{{font-size:13px;fill:{t.ink_2}}}"
            f".kv{{font-size:34px;font-weight:600;{TNUM}}}"
            f".ks{{font-size:12px;fill:{t.ink_2};{TNUM}}}")


def esc(s: Any) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def n(v: float) -> str:
    """A coordinate: one decimal at most, no trailing zero."""
    return str(int(v)) if v == int(v) else f"{v:.1f}".rstrip("0").rstrip(".")


def fmt(v: int) -> str:
    return f"{v:,}"


def pct(part: int, whole: int) -> str:
    if whole <= 0:
        return "–"
    p = 100 * part / whole
    if part == 0:
        return "0%"
    if p < 1:
        return "<1%"
    if part < whole and p >= 99.5:
        return ">99%"
    return f"{p:.0f}%"


def text_width(s: str, size: float, bold: bool = False) -> float:
    """An estimate of the rendered width of `s` in a system sans, good enough to decide
    whether a label fits (there is no font engine in the standard library)."""
    w = 0.0
    for ch in s:
        if ch in "il.,:;|!'`":
            w += 0.28
        elif ch in "fjrtI()[]/- ":
            w += 0.34
        elif ch.isdigit():
            w += 0.56
        elif ch in "mwMW%@":
            w += 0.86
        elif ch.isupper():
            w += 0.68
        else:
            w += 0.54
    return w * size * (1.06 if bold else 1.0)


def clip(s: str, size: float, width: float) -> str:
    """`s`, cut with an ellipsis if it would not fit: a label is never drawn past its room."""
    if text_width(s, size) <= width:
        return s
    while s and text_width(s + "…", size) > width:
        s = s[:-1]
    return s.rstrip() + "…"


def wrap(s: str, size: float, width: float) -> list[str]:
    lines: list[str] = []
    for word in s.split():
        if lines and text_width(lines[-1] + " " + word, size) <= width:
            lines[-1] += " " + word
        else:
            lines.append(word)
    return lines or [""]


def nice_ticks(vmax: float, target: int = 4) -> list[int]:
    """Round, evenly spaced integer ticks from 0 that cover `vmax` (1, 2, 5, 10, 25… steps)."""
    if vmax <= 0:
        return [0, 1]
    raw = vmax / target
    mag = 10 ** math.floor(math.log10(raw))
    step = 10 * mag
    for m in (1, 2, 2.5, 5, 10):
        if m * mag >= raw and m * mag == int(m * mag):
            step = m * mag
            break
    step = max(1, int(step))
    return list(range(0, math.ceil(vmax / step) * step + 1, step))


def hbar(x: float, y: float, w: float, h: float, r: float = 4) -> str:
    """A horizontal bar from the baseline `x`, rounded at its data end only."""
    if w <= 0:
        return ""
    r = min(r, w, h / 2)
    x1, y1 = x + w, y + h
    return (f"M{n(x)},{n(y)}H{n(x1 - r)}Q{n(x1)},{n(y)} {n(x1)},{n(y + r)}V{n(y1 - r)}"
            f"Q{n(x1)},{n(y1)} {n(x1 - r)},{n(y1)}H{n(x)}Z")


def vbar(x: float, top: float, w: float, h: float, r: float = 4) -> str:
    """A column standing on its baseline, rounded at its top only."""
    if h <= 0:
        return ""
    r = min(r, h, w / 2)
    base = top + h
    return (f"M{n(x)},{n(base)}V{n(top + r)}Q{n(x)},{n(top)} {n(x + r)},{n(top)}H{n(x + w - r)}"
            f"Q{n(x + w)},{n(top)} {n(x + w)},{n(top + r)}V{n(base)}Z")


def rect(x: float, y: float, w: float, h: float) -> str:
    """A square-ended segment (the inside of a stack)."""
    if w <= 0 or h <= 0:
        return ""
    return f"M{n(x)},{n(y)}H{n(x + w)}V{n(y + h)}H{n(x)}Z"


def mark(d: str, fill: str, tip: str) -> str:
    """A data mark and its native tooltip (shown when the SVG is opened on its own)."""
    return f'<path d="{d}" fill="{fill}"><title>{esc(tip)}</title></path>' if d else ""


def text(x: float, y: float, s: str, cls: str, anchor: str = "start", weight: str = "") -> str:
    a = "" if anchor == "start" else f' text-anchor="{anchor}"'
    w = f' font-weight="{weight}"' if weight else ""
    return f'<text x="{n(x)}" y="{n(y)}" class="{cls}"{a}{w}>{esc(s)}</text>'


def line(x1: float, y1: float, x2: float, y2: float, color: str) -> str:
    return f'<path d="M{n(x1)},{n(y1)}L{n(x2)},{n(y2)}" stroke="{color}" stroke-width="1" fill="none"/>'


def swatch(x: float, y: float, color: str) -> str:
    return f'<rect x="{n(x)}" y="{n(y - 9)}" width="10" height="10" rx="2" fill="{color}"/>'


def svg(t: Theme, name: str, width: int, height: int, title: str, desc: str, body: list[str]) -> str:
    ident = f"oscr-{name}-{t.name}"
    return "\n".join([
        (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
         f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="{ident}-t {ident}-d">'),
        f'<title id="{ident}-t">{esc(title)}</title>',
        f'<desc id="{ident}-d">{esc(desc)}</desc>',
        f"<style>{css(t)}</style>",
        (f'<rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="10" '
         f'fill="{t.background}" stroke="{t.border}"/>'),
        *[b for b in body if b],
        "</svg>", ""])


def header(title: str, subtitle: str, width: int, x: float = 20) -> tuple[list[str], float]:
    """Title and wrapped subtitle; returns their markup and the baseline of the last line."""
    out = [text(x, 34, title, "title")]
    y = 34.0
    for part in wrap(subtitle, 12.5, width - 2 * x):
        y += 19
        out.append(text(x, y, part, "sub"))
    return out, y


def source(height: int, when: str, extra: str = "", x: float = 20) -> str:
    return text(x, height - 14, f"Source: OSCR harvester database, {when}{extra}", "foot")


def empty(t: Theme, name: str, width: int, height: int, title: str, when: str) -> str:
    body = [text(20, 34, title, "title"),
            text(width / 2, height / 2, "No data yet", "sub", anchor="middle"),
            source(height, when)]
    return svg(t, name, width, height, title, f"{title}: no data yet.", body)


PANEL_W, PANEL_H = 400, 340
WIDE_W = 820


def bars(t: Theme, name: str, title: str, subtitle: str, rows: list[tuple[str, int]], unit: str,
         when: str) -> str:
    """Horizontal bars, one series: slot 1 for every named row and the de-emphasis gray
    for "Other"; the value at each tip, so no axis is needed."""
    if not rows:
        return empty(t, name, PANEL_W, PANEL_H, title, when)
    body, y = header(title, subtitle, PANEL_W)
    top, bottom = y + 22, PANEL_H - 40
    band = min(34.0, (bottom - top) / len(rows))
    thick = min(20.0, band * 0.62)
    label_w = min(150.0, max(text_width(label, 12.5) for label, _ in rows))
    x0 = 20 + label_w + 10
    span = PANEL_W - 20 - x0 - max(text_width(fmt(v), 12) for _, v in rows) - 6
    vmax = max(v for _, v in rows) or 1
    for i, (label, v) in enumerate(rows):
        yc = top + band * i + band / 2
        w = span * v / vmax
        is_other = label == "Other"
        body.append(text(x0 - 10, yc + 4.5, clip(label, 12.5, label_w), "cat muted" if is_other else "cat",
                         anchor="end"))
        body.append(mark(hbar(x0, yc - thick / 2, w, thick), t.other if is_other else t.series[0],
                         f"{label}: {fmt(v)} {unit}"))
        body.append(text(x0 + w + 6, yc + 4, fmt(v), "val"))
    body.append(line(x0 - 0.5, top, x0 - 0.5, top + band * len(rows), t.axis))
    body.append(source(PANEL_H, when))
    desc = (f"{subtitle}. " + "; ".join(f"{label}: {fmt(v)}" for label, v in rows)
            + f". Source: OSCR harvester database, {when}.")
    return svg(t, name, PANEL_W, PANEL_H, title, desc, body)


def licenses(t: Theme, d: Data, when: str) -> str:
    """Horizontal stacked bars, two series (text republished, link + commit only), with
    a legend: identity never rests on color alone."""
    title = "Licenses of the authors' repositories"
    rows = d.licenses
    if not rows:
        return empty(t, "licenses", PANEL_W, PANEL_H, title, when)
    total = sum(a + b for _, a, b in rows)
    republished = sum(a for _, a, _ in rows)
    subtitle = (f"{pct(republished, total)} of {fmt(total)} repositories let their scripts' text "
                "be republished; the others stay a link and a commit")
    body, y = header(title, subtitle, PANEL_W)
    ly, x = y + 22, 20.0
    for label, color in (("Text republished", t.series[0]), ("Link + commit only", t.series[1])):
        body += [swatch(x, ly, color), text(x + 15, ly, label, "sub")]
        x += 15 + text_width(label, 12.5) + 18
    top, bottom = ly + 12, PANEL_H - 40
    band = min(34.0, (bottom - top) / len(rows))
    thick = min(20.0, band * 0.62)
    label_w = min(140.0, max(text_width(label, 12.5) for label, _, _ in rows))
    x0 = 20 + label_w + 10
    span = PANEL_W - 20 - x0 - max(text_width(fmt(a + b), 12) for _, a, b in rows) - 6
    vmax = max(a + b for _, a, b in rows) or 1
    for i, (label, a, b) in enumerate(rows):
        yc = top + band * i + band / 2
        wa, wb = span * a / vmax, span * b / vmax
        y0 = yc - thick / 2
        tip = f"{label}: {fmt(a + b)} repositories ({fmt(a)} text republished, {fmt(b)} link + commit only)"
        body.append(text(x0 - 10, yc + 4.5, clip(label, 12.5, label_w), "cat", anchor="end"))
        if a and b:  # a stack: a 2 px surface gap between the segments, the end rounded
            body.append(mark(rect(x0, y0, max(wa - 2, 0.5), thick), t.series[0], tip))
            body.append(mark(hbar(x0 + wa, y0, wb, thick), t.series[1], tip))
        else:
            body.append(mark(hbar(x0, y0, wa or wb, thick), t.series[0] if a else t.series[1], tip))
        body.append(text(x0 + wa + wb + 6, yc + 4, fmt(a + b), "val"))
    body.append(line(x0 - 0.5, top, x0 - 0.5, top + band * len(rows), t.axis))
    body.append(source(PANEL_H, when))
    desc = (f"{subtitle}. " + "; ".join(f"{label}: {fmt(a)} text republished, {fmt(b)} link only"
                                        for label, a, b in rows) + f". Source: OSCR harvester database, {when}.")
    return svg(t, "licenses", PANEL_W, PANEL_H, title, desc, body)


def ladder(t: Theme, d: Data, when: str) -> str:
    """The four levels of evidence as an ordinal ramp (one hue, darker = stronger), each
    bar a share of the repositories found."""
    title = "The evidence ladder"
    rows = d.ladder
    if not rows or not rows[0][1]:
        return empty(t, "ladder", PANEL_W, PANEL_H, title, when)
    subtitle = "Authors' repositories by the highest level of evidence reached"
    body, y = header(title, subtitle, PANEL_W)
    top, bottom = y + 16, PANEL_H - 40
    band = (bottom - top) / len(rows)
    thick = 18.0
    found = rows[0][1]
    labels = [fmt(v) if i == 0 else f"{fmt(v)} · {pct(v, found)}" for i, (_, v) in enumerate(rows)]
    span = PANEL_W - 40 - max(text_width(s, 12) for s in labels) - 6
    for i, (level, v) in enumerate(rows):
        yt = top + band * i
        body.append(f'<text x="20" y="{n(yt + 16)}" class="cat"><tspan font-weight="600">'
                    f'{esc(level.capitalize())}</tspan><tspan class="muted"> · {esc(LEVEL_NOTES[level])}'
                    "</tspan></text>")
        w = span * v / found
        by = yt + 24
        body.append(mark(hbar(20, by, w, thick), t.ramp[i],
                         f"{level.capitalize()}: {fmt(v)} repositories, {pct(v, found)} of those found"))
        body.append(text(20 + w + 6, by + thick / 2 + 4, labels[i], "val"))
    body.append(line(19.5, top + 22, 19.5, top + band * (len(rows) - 1) + 26 + thick, t.axis))
    body.append(source(PANEL_H, when))
    desc = (f"{subtitle}. " + "; ".join(f"{lvl} ({LEVEL_NOTES[lvl]}): {fmt(v)}" for lvl, v in rows)
            + f". Source: OSCR harvester database, {when}.")
    return svg(t, "ladder", PANEL_W, PANEL_H, title, desc, body)


def years(t: Theme, d: Data, when: str) -> str:
    """Columns of papers read per publication year; the part whose authors' code was
    verified at the source is the accent, the rest is context. One axis: papers."""
    title = "Code availability by publication year"
    height = 330
    if not d.years:
        return empty(t, "years", WIDE_W, height, title, when)
    subtitle = ("Papers read per publication year; in color, those whose authors' code was verified "
                "at the source, with its share above each column")
    body, y = header(title, subtitle, WIDE_W, x=24)
    ly, x = y + 22, 24.0
    for label, color in (("With verified code", t.series[0]), ("Other papers read", t.other)):
        body += [swatch(x, ly, color), text(x + 15, ly, label, "sub")]
        x += 15 + text_width(label, 12.5) + 18
    first, last = d.years[0][0], d.years[-1][0]
    by_year = {yr: (read, verified) for yr, read, verified in d.years}
    ticks = nice_ticks(max(read for _, read, _ in d.years))
    left = 24 + max(text_width(fmt(v), 11.5) for v in ticks) + 10
    right, top, base = WIDE_W - 24, ly + 26, height - 62
    scale = (base - top) / ticks[-1]
    for v in ticks:
        yy = base - v * scale
        if v:
            body.append(line(left, yy, right, yy, t.grid))
        body.append(text(left - 8, yy + 4, fmt(v), "tick", anchor="end"))
    span_years = range(first, last + 1)
    band = (right - left) / len(span_years)
    col = min(24.0, band * 0.6)
    every = max(1, math.ceil(40 / band))  # year labels never collide
    best = max(d.years, key=lambda row: (row[2] / row[1] if row[1] else 0, row[0]))[0]
    for i, yr in enumerate(span_years):
        cx = left + band * i + band / 2
        if (last - yr) % every == 0:
            body.append(text(cx, base + 18, str(yr), "tick", anchor="middle"))
        if yr not in by_year:
            continue
        read, verified = by_year[yr]
        hv, hr = verified * scale, read * scale
        tip = f"{yr}: {fmt(read)} papers read, {fmt(verified)} with verified code ({pct(verified, read)})"
        if verified and hr - hv > 0:
            body.append(mark(rect(cx - col / 2, base - hv, col, hv), t.series[0], tip))
            body.append(mark(vbar(cx - col / 2, base - hr, col, max(hr - hv - 2, 0.5)), t.other, tip))
        else:
            body.append(mark(vbar(cx - col / 2, base - hr, col, hr), t.series[0] if verified else t.other, tip))
        if band >= 30 or yr in (last, best):  # selective labels when the years are many
            body.append(text(cx, base - hr - 7, pct(verified, read), "val", anchor="middle", weight="600"))
    # A run of years with nothing read is not "no code": the backfill has not reached it.
    run: list[int] = []
    for yr in [*span_years, None]:
        if yr is not None and yr not in by_year:
            run.append(yr)
            continue
        if len(run) >= 2 and text_width("no papers read yet", 11.5) < band * len(run) - 8:
            cx = left + band * (run[0] - first + len(run) / 2)
            body.append(text(cx, base - 10, "no papers read yet", "tick", anchor="middle"))
        run = []
    body.append(line(left, base + 0.5, right, base + 0.5, t.axis))
    extra = f" · {fmt(d.undated)} papers without a publication date are not shown" if d.undated else ""
    body.append(source(height, when, extra, x=24))
    desc = (f"{subtitle}. " + "; ".join(f"{yr}: {fmt(r)} read, {fmt(v)} with verified code ({pct(v, r)})"
                                        for yr, r, v in d.years) + f". Source: OSCR harvester database, {when}.")
    return svg(t, "years", WIDE_W, height, title, desc, body)


def kpis(t: Theme, d: Data, when: str) -> str:
    """Four stat tiles: the numbers are the chart."""
    height = 164
    mb = d.script_bytes / 1e6
    size = f"{mb:,.0f} MB" if mb >= 10 else f"{mb:,.1f} MB"
    tiles = [
        ("Papers read", d.papers_read, f"{fmt(d.fulltext)} with full text"),
        ("With the authors' code", d.with_code,
         f"{pct(d.with_code, d.papers_read)} of papers read; {fmt(d.verified)} verified at the source"),
        ("Code repositories", d.repositories, f"{fmt(d.alive)} alive at the last check"),
        ("Scripts kept as text", d.scripts, f"{size} of source text"),
    ]
    width = (WIDE_W - 48) / len(tiles)
    body: list[str] = []
    for i, (label, value, sub) in enumerate(tiles):
        x = 24 + width * i
        if i:
            body.append(line(x - 12, 26, x - 12, 126, t.grid))
        body.append(text(x, 46, label, "kl"))
        body.append(text(x, 88, fmt(value), "kv"))
        for j, part in enumerate(wrap(sub, 12, width - 22)[:2]):
            body.append(text(x, 110 + 16 * j, part, "ks"))
    body.append(source(height, when, x=24))
    desc = "; ".join(f"{label}: {fmt(value)} ({sub})" for label, value, sub in tiles)
    return svg(t, "kpis", WIDE_W, height, "OSCR in numbers",
               f"{desc}. Source: OSCR harvester database, {when}.", body)


def render(name: str, t: Theme, d: Data, when: str) -> str:
    if name == "kpis":
        return kpis(t, d, when)
    if name == "years":
        return years(t, d, when)
    if name == "hosts":
        return bars(t, "hosts", "Where the authors' code lives",
                    f"{fmt(d.repositories)} code repositories found, by host", d.hosts, "repositories", when)
    if name == "languages":
        return bars(t, "languages", "Languages of the harvested scripts",
                    f"{fmt(d.scripts)} scripts kept as text, by language", d.languages, "scripts", when)
    if name == "licenses":
        return licenses(t, d, when)
    if name == "ladder":
        return ladder(t, d, when)
    raise ValueError(f"unknown figure: {name}")


def write_all(d: Data, out: Path, when: str, source_name: str) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name in FIGURES:
        for t in THEMES:
            path = out / f"{name}-{t.name}.svg"
            path.write_text(render(name, t, d, when), encoding="utf-8")
            written.append(path)
    path = out / "figures.json"
    path.write_text(json.dumps({"generated": when, "database": source_name, **d.as_json()},
                               indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    written.append(path)
    return written


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="make_figures", description=(__doc__ or "").split("\n\n")[0])
    p.add_argument("--db", default="data/oscr.db", help="the harvester's database (opened read-only)")
    p.add_argument("--out", default="docs/assets/figures", help="where the SVG files are written")
    p.add_argument("--date", default=datetime.now(UTC).date().isoformat(),
                   help="the date printed under each figure (default: today, UTC)")
    a = p.parse_args(argv)
    d = collect(Path(a.db))
    written = write_all(d, Path(a.out), a.date, Path(a.db).name)
    print(f"{len(written)} files → {a.out} ({fmt(d.papers_read)} papers, {fmt(d.repositories)} repositories)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
