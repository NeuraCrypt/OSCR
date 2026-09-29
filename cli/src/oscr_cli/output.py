"""Output for terminals and for pipes (docs/CLI.md "Output"; ``oscr help formatting``; D14-5).

- **A terminal**: aligned columns cut to its width, colours (unless ``NO_COLOR``, ``--color never`` or
  ``color = never``), a spinner while waiting (unless ``spinner = false`` or ``OSCR_SPINNER_DISABLED``).
- **A pipe or a file**: one line per item, fields separated by tabs, nothing cut, no colour, no spinner:
  what ``cut``, ``awk`` and ``sort`` read.
- **``--json fields``**: the fields named, as JSON (``--json`` alone lists a command's fields); then
  ``--jq`` filters it (a subset of jq: jq.py) or ``--template`` renders it (a subset of Go's templates:
  template.py). JSON escapes every control character itself; the raw strings ``--jq`` and
  ``--template`` print are cleaned like every text shown (sanitize.py).
- **Accessible colours** (``accessible_colors = true``): a status is never told by red against green;
  bold and underline mark it, and its word always says it.

The tool's own colours are added after the network's text is cleaned: nothing from the network can
carry an escape sequence to the terminal.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, TextIO

from .errors import UsageError
from .sanitize import clean, clean_line

STYLES = {
    "bold": "1",
    "muted": "2",
    "ok": "32",
    "warning": "33",
    "failure": "31",
    "link": "4",
    "heading": "1",
}
# Accessible colours: shapes, never red against green.
ACCESSIBLE = {"ok": "1", "warning": "1;4", "failure": "1;4;7", "muted": "2", "bold": "1", "link": "4", "heading": "1"}


def _isatty(stream: Any) -> bool:
    try:
        return bool(stream.isatty())
    except (AttributeError, ValueError, OSError):
        return False


class IO:
    """Where the tool writes and reads, and how (a terminal or not, colours, a spinner, prompts)."""

    def __init__(
        self,
        *,
        stdout: TextIO | None = None,
        stderr: TextIO | None = None,
        stdin: TextIO | None = None,
        env: Mapping[str, str] | None = None,
        color: str = "auto",
        accessible: bool = False,
        spinner: bool = True,
        prompt: bool = True,
        force_tty: bool | None = None,
    ):
        self.out = stdout if stdout is not None else sys.stdout
        self.err = stderr if stderr is not None else sys.stderr
        self.inp = stdin if stdin is not None else sys.stdin
        self.env = env if env is not None else os.environ
        tty = self.env.get("OSCR_FORCE_TTY")
        self.out_tty = force_tty if force_tty is not None else (bool(tty) and tty != "0") or _isatty(self.out)
        self.err_tty = _isatty(self.err) or (force_tty is True)
        self.in_tty = _isatty(self.inp)
        self.color = self._decide_color(color)
        self.accessible = accessible
        self.spinner = spinner and self.err_tty and not self.env.get("OSCR_SPINNER_DISABLED")
        self.prompt = prompt and self.in_tty and self.out_tty

    def _decide_color(self, setting: str) -> bool:
        if setting == "never" or self.env.get("NO_COLOR", "") != "":
            return False
        if setting == "always" or self.env.get("CLICOLOR_FORCE", "0") not in ("", "0"):
            return True
        return self.out_tty and self.env.get("TERM", "") != "dumb"

    # ── writing ──
    def style(self, text: str, name: str) -> str:
        if not self.color or not text:
            return text
        code = (ACCESSIBLE if self.accessible else STYLES).get(name)
        return f"\033[{code}m{text}\033[0m" if code else text

    def print(self, text: str = "") -> None:
        self.out.write(text + "\n")

    def write(self, text: str) -> None:
        self.out.write(text)

    def say(self, text: str) -> None:
        """A status line, on standard error (never mixed into what a pipe reads)."""
        self.err.write(text + "\n")
        self.err.flush()

    def warn(self, text: str) -> None:
        self.say(self.style("Warning:", "warning") + " " + text)

    # ── tables ──
    def width(self) -> int:
        return shutil.get_terminal_size((100, 24)).columns

    def table(self, rows: Sequence[Sequence[Any]], *, headers: Sequence[str] | None = None, styles: Sequence[str | None] | None = None) -> None:
        """Rows of network text: aligned and cut to the terminal's width, or tab-separated in a pipe."""
        cells = [[clean_line(c) for c in r] for r in rows]
        if not self.out_tty:
            for r in cells:
                self.print("\t".join(r))
            return
        if not cells:
            return
        n = max(len(r) for r in cells)
        heads = list(headers or [])
        widths = [max(len(r[i]) if i < len(r) else 0 for r in cells + ([heads] if heads else [])) for i in range(n)]
        total = self.width()
        # Cut the widest column first until the row fits (at least 8 characters a column).
        while sum(widths) + 2 * (n - 1) > total and max(widths) > 8:
            i = widths.index(max(widths))
            widths[i] -= 1
        if heads:
            self.print("  ".join(self.style(h.upper().ljust(widths[i]) if i < n - 1 else h.upper(), "muted") for i, h in enumerate(heads)).rstrip())
        for r in cells:
            parts = []
            for i in range(n):
                c = r[i] if i < len(r) else ""
                if len(c) > widths[i]:
                    c = c[: max(1, widths[i] - 1)] + "…"
                padded = c.ljust(widths[i]) if i < n - 1 else c
                st = styles[i] if styles and i < len(styles) else None
                parts.append(self.style(padded, st) if st else padded)
            self.print("  ".join(parts).rstrip())

    # ── waiting ──
    def waiting(self, words: str) -> Spinner:
        return Spinner(self, words)


class Spinner:
    """A line that says what the tool waits for; animated in a terminal unless asked not to be."""

    FRAMES = "|/-\\"

    def __init__(self, io: IO, words: str):
        self.io = io
        self.words = words
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> Spinner:
        if self.io.spinner:
            self._thread = threading.Thread(target=self._spin, daemon=True)
            self._thread.start()
        else:
            self.io.say(self.words)
        return self

    def _spin(self) -> None:
        i = 0
        while not self._stop.wait(0.12):
            self.io.err.write(f"\r{self.FRAMES[i % 4]} {self.words}")
            self.io.err.flush()
            i += 1

    def __exit__(self, *exc: object) -> None:
        if self._thread:
            self._stop.set()
            self._thread.join()
            self.io.err.write("\r" + " " * (len(self.words) + 2) + "\r")
            self.io.err.flush()


# ── --json, --jq, --template ──


def add_format_flags(parser: Any, fields: Sequence[str]) -> None:
    """``--json [fields]``, ``--jq``, ``--template`` on a command whose objects have these fields."""
    g = parser.add_argument_group("formatting (oscr help formatting)")
    g.add_argument("--json", nargs="?", const="", default=None, metavar="FIELDS",
                   help=f"print these comma-separated fields as JSON; alone: list the fields ({', '.join(fields[:6])}…)")
    g.add_argument("-q", "--jq", default=None, metavar="EXPR", help="filter the JSON with a jq expression (a subset: oscr help formatting)")
    g.add_argument("-t", "--template", default=None, metavar="TMPL", help="render the JSON with a Go-style template (a subset)")
    parser.set_defaults(json_fields=list(fields))


def wants_json(args: Any) -> bool:
    return getattr(args, "json", None) is not None


def pick(obj: Mapping[str, Any], fields: Iterable[str]) -> dict[str, Any]:
    return {f: obj.get(f) for f in fields}


def emit(io: IO, args: Any, data: Any, human: Callable[[], None]) -> None:
    """Print ``data`` (a dict or a list of dicts) as the flags ask: JSON with fields, filtered, templated,
    or for people (``human``)."""
    jq_expr = getattr(args, "jq", None)
    tmpl = getattr(args, "template", None)
    if not wants_json(args):
        if jq_expr is not None or tmpl is not None:
            raise UsageError("--jq and --template read the JSON: add --json with the fields.")
        human()
        return
    known: list[str] = list(getattr(args, "json_fields", []) or [])
    if args.json == "":
        io.say("Choose the fields to print as JSON, separated by commas:")
        for f in known:
            io.print(f"  {f}")
        raise UsageError("--json needs the fields to print.")
    asked = [f.strip() for f in args.json.split(",") if f.strip()]
    unknown = [f for f in asked if f not in known]
    if unknown:
        raise UsageError(f"Unknown JSON field{'s' if len(unknown) > 1 else ''}: {', '.join(unknown)}. The fields: {', '.join(known)}.")
    shaped = [pick(d, asked) for d in data] if isinstance(data, list) else pick(data, asked)
    if jq_expr is not None and tmpl is not None:
        raise UsageError("Use --jq or --template, not both.")
    if jq_expr is not None:
        from . import jq

        for value in jq.run(jq_expr, shaped):
            io.print(clean(value) if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
        return
    if tmpl is not None:
        from . import template

        io.write(clean(template.render(tmpl, shaped, color=io.color)))
        return
    io.print(json.dumps(shaped, indent=2 if io.out_tty else None, ensure_ascii=False))


def ago(ts: str | None, now: float | None = None) -> str:
    """An ISO time as people say it: "3 hours ago", "in 2 days"; the date beyond a month."""
    if not ts:
        return ""
    from datetime import datetime, timezone

    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return clean_line(ts)
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    delta = (now if now is not None else time.time()) - t.timestamp()
    future = delta < 0
    d = abs(delta)
    for unit, secs in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if d >= secs:
            n = int(d // secs)
            if unit == "day" and n > 30:
                return t.date().isoformat()
            words = f"{n} {unit}{'s' if n != 1 else ''}"
            return f"in {words}" if future else f"{words} ago"
    return "just now"
