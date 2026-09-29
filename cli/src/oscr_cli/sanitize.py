"""What the network says, made harmless for a terminal (docs/CLI.md "Safety"; D14-5).

A title, a branch name, a comment or a file read from GitHub or from the registry is someone else's
text. Printed as it is, an escape sequence in it could move the cursor, rewrite what the terminal shows,
change its title, or (on some terminals) answer back as if typed. So every text that came from the
network passes through :func:`clean` before it is shown, in tables, in plain lines, and in the raw
strings of ``--jq`` and ``--template`` (JSON output escapes them itself):

- the C0 controls but the tab and the line feed, and DEL, become caret notation (``ESC`` → ``^[``,
  a carriage return → ``^M``), as ``cat -v`` shows them; a CRLF line end becomes a line feed first;
- the C1 controls (U+0080–U+009F, among them the single-character CSI) become ``\\u009b``;
- the Unicode controls that reorder text (bidirectional overrides and isolates, the marks) become
  ``<U+202E>``: text shown must read in the order it is stored ("Trojan source").

The same rule for the tool's own messages that quote such text: callers clean values, never the
colours the tool adds itself.

Email addresses are hidden in what the tool shows (CLAUDE.md), as the site hides them: :func:`mask_emails`
is the Mac's and the Worker's pattern (tests/fixtures/emails.json holds the three to one reading).
"""
from __future__ import annotations

import re

_CRLF = re.compile(r"\r\n")
_C0 = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_C1 = re.compile(r"[\x80-\x9f]")
_REORDER = re.compile(r"[؜‎‏‪-‮⁦-⁩]")


def _caret(m: re.Match[str]) -> str:
    c = ord(m.group())
    return "^?" if c == 0x7F else "^" + chr(c + 64)


def clean(text: object) -> str:
    """The text with every control that could act on a terminal made visible and inert."""
    s = "" if text is None else str(text)
    if not s:
        return s
    s = _CRLF.sub("\n", s)
    s = _C0.sub(_caret, s)
    s = _C1.sub(lambda m: f"\\u{ord(m.group()):04x}", s)
    return _REORDER.sub(lambda m: f"<U+{ord(m.group()):04X}>", s)


def clean_line(text: object) -> str:
    """One line: :func:`clean`, with line breaks and tabs as spaces (a table's cell, a status line)."""
    return re.sub(r"[\t\n]+", " ", clean(text)).strip()


EMAIL_MASK = "[email hidden]"
# The Mac's `_EMAIL_IN_TEXT` (oscr/catalog.py) and the Worker's (worker/forge/mask.ts), Unicode-aware.
_EMAIL = re.compile(r"(?<![\w.+%-])(?!git@)[\w.+%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")


def mask_emails(text: object) -> str:
    """The same text, every email address replaced by ``[email hidden]``."""
    s = "" if text is None else str(text)
    return _EMAIL.sub(EMAIL_MASK, s) if "@" in s else s


def shown(text: object) -> str:
    """A text from the network as the tool shows it: addresses hidden, controls inert."""
    return clean(mask_emails(text))
