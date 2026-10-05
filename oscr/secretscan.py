"""The secrets scan after the push (night phase 11, E3; docs/SECURITY_QUALITY.md, D00-11).

GitHub's push protection refuses a push that carries a secret, on public repositories; pushes never
pass through the registry, so the registry cannot refuse one (D00-11). What it can do, it does: once
the push has landed, it scans the files it already reads and **reports, never blocks**. A leaked
token reaches its provider through GitHub's own partner programme, not through the registry; the
registry never calls a provider, never validates a token, never keeps a value.

What a finding is: a kind ("a GitHub token"), the path and the line, and a short *hint* (the value's
first characters, the rest hidden) that is enough to find it and never enough to use it. The value
itself is never stored, published, shown whole or sent anywhere.

Two families of patterns:

- **Structured** tokens with a prefix or a shape of their own (few false alarms): GitHub, GitLab,
  AWS, Google, Slack, Stripe, OpenAI, Anthropic, Hugging Face, npm, PyPI, SendGrid, Twilio, a
  private key block, a password in a URL. The same list as the web editor's warning
  (website/src/lib/secrets.ts), kept in step by a shared fixture
  (tests/fixtures/secret_patterns.json).
- **Paired** (generic): an assignment whose name says "secret", "password", "api key", "token" and
  whose value looks like a real one (long, mixed, not a placeholder). A paired finding is marked
  ``paired`` so the report can say it is a guess.

Custom patterns (the owner's) carry a **test string** and support a **dry run**: the scan reports
what the pattern matches in its test string without reading any repository. **Path exclusions** skip
the files the owner names (fixtures, vendored code, lock files). Each kind carries **remediation
guidance** in words.

Nothing here opens a network connection or runs any code: it compiles regular expressions and reads
text.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path

#: Texts larger than this are scanned in their first part only (as the web editor's own limit).
SCAN_CHARS = 2_000_000
#: Findings reported at most, per file.
MAX_FINDINGS = 50

# Structured patterns (a prefix or a shape of their own). Kept in step with website/src/lib/secrets.ts
# by tests/test_secretscan.py against tests/fixtures/secret_patterns.json.
STRUCTURED: list[tuple[str, str]] = [
    ("a GitHub token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b"),
    ("a GitLab token", r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
    ("an AWS access key", r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b"),
    ("a Google API key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("a private key", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----"),
    ("a Slack token", r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b"),
    ("a Slack webhook", r"https://hooks\.slack\.com/services/T[A-Za-z0-9_]+/B[A-Za-z0-9_]+/[A-Za-z0-9_]+"),
    ("a Stripe live key", r"\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b"),
    ("an OpenAI key", r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b"),
    ("an Anthropic key", r"\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}\b"),
    ("a Hugging Face token", r"\bhf_[A-Za-z0-9]{30,}\b"),
    ("an npm token", r"\bnpm_[A-Za-z0-9]{36}\b"),
    ("a PyPI token", r"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b"),
    ("a SendGrid key", r"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b"),
    ("a Twilio key", r"\bSK[0-9a-fA-F]{32}\b"),
    ("a Discord webhook", r"https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]{60,}"),
    ("a password in an address", r"\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@\"']{1,64}:[^\s@/\"']{3,128}@[A-Za-z0-9.-]+"),
]

# Paired (generic): a key-ish name next to a value-ish string. Lower confidence (marked paired).
_PAIR = re.compile(
    r"""(?ix)
    \b (?P<name>[A-Za-z0-9_.\-]*  (?:secret|password|passwd|pwd|api[_-]?key|access[_-]?key|
                                   auth[_-]?token|client[_-]?secret|private[_-]?key|token) )
    \s* [:=] \s*
    (?P<q>["'])? (?P<value>[^\s"']{8,100}) (?(q)\2)
    """,
)

# Documentation placeholders and obvious non-secrets.
_PLACEHOLDER = re.compile(r"EXAMPLE|X{8,}|x{8,}|0{12,}|\*{4,}|your[_-]?(?:token|key|secret|password|pass|api)|here|<[^>]+>|\$\{|%\(|\{\{|changeme|redacted|placeholder|dummy|sample|test[_-]?key", re.I)
# A paired value that is plainly not a secret (a path, a boolean, a number, a template).
_WEAK_VALUE = re.compile(r"^(?:true|false|null|none|nil|/|\./|\.\./|https?://|[0-9.]+|[A-Za-z]+(?:[._][A-Za-z]+)*)$", re.I)

# Remediation in words, by kind (the report shows it; it never names the platform's internals).
REMEDIATION: dict[str, str] = {
    "default": "Treat this value as compromised. Revoke it with the provider, remove it from the "
               "history (not only the latest commit), and keep it out of the code: read it from the "
               "environment or a secret store instead.",
    "a private key": "Revoke and rotate the key pair. A private key committed to a public repository "
                     "is compromised the moment it is pushed, whatever the history is rewritten to.",
    "a password in an address": "Change the password, and keep credentials out of connection URLs: "
                                "pass them through the environment or a configuration the code reads.",
}


@dataclass(frozen=True)
class Finding:
    kind: str
    path: str
    line: int
    hint: str       # the value's first characters, the rest hidden
    paired: bool = False

    def remediation(self) -> str:
        return REMEDIATION.get(self.kind, REMEDIATION["default"])

    def as_row(self) -> dict[str, object]:
        return {"kind": self.kind, "path": self.path, "line": self.line, "hint": self.hint,
                "paired": self.paired}


def _hide(value: str) -> str:
    keep = min(6, len(value) // 4)
    return (value[:keep] + "\u2026") if keep else "\u2026"


def _lines(text: str) -> list[int]:
    starts = [0]
    i = text.find("\n")
    while i >= 0:
        starts.append(i + 1)
        i = text.find("\n", i + 1)
    return starts


def _line_at(starts: list[int], offset: int) -> int:
    lo, hi = 0, len(starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if starts[mid] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


def scan_text(path: str, text: str, *, custom: list[dict] | None = None) -> list[Finding]:
    """The secrets a text seems to hold, by line. ``custom`` is a list of {name, regex} the owner
    added. A placeholder ("ghp_XXXX...", "your-token-here") is never a finding."""
    t = text[:SCAN_CHARS]
    starts = _lines(t)
    out: list[Finding] = []
    seen: set[tuple[int, str]] = set()

    def add(kind: str, start: int, matched: str, paired: bool) -> bool:
        if _PLACEHOLDER.search(matched):
            return True
        line = _line_at(starts, start)
        key = (line, kind)
        if key in seen:
            return True
        seen.add(key)
        out.append(Finding(kind, path, line, _hide(matched), paired))
        return len(out) < MAX_FINDINGS

    patterns = [(k, re.compile(p)) for k, p in STRUCTURED]
    for name, spec in (custom or []):
        try:
            patterns.append((name, re.compile(spec)))
        except re.error:
            continue
    for kind, rx in patterns:
        for m in rx.finditer(t):
            if not add(kind, m.start(), m.group(0), False):
                return sorted(out, key=lambda f: (f.line, f.kind))
    for m in _PAIR.finditer(t):
        value = m.group("value")
        if _WEAK_VALUE.match(value) or value.count(" ") or len(set(value)) < 5:
            continue
        if not add("a secret in an assignment", m.start("value"), value, True):
            return sorted(out, key=lambda f: (f.line, f.kind))
    return sorted(out, key=lambda f: (f.line, f.kind))


def excluded(path: str, exclusions: list[str]) -> bool:
    """Whether a path is skipped by the owner's exclusions (glob, on the path or its base name)."""
    base = Path(path).name
    return any(fnmatch(path, g) or fnmatch(base, g) for g in exclusions)


def dry_run(name: str, regex: str, test_string: str) -> dict[str, object]:
    """What a custom pattern matches in its own test string, reading no repository. The owner checks
    a pattern before it ever runs over the files."""
    try:
        rx = re.compile(regex)
    except re.error as e:
        return {"name": name, "ok": False, "error": str(e), "matches": []}
    matches = [_hide(m.group(0)) for m in rx.finditer(test_string)]
    return {"name": name, "ok": True, "matches": matches, "count": len(matches)}


def in_words(findings: list[Finding]) -> list[str]:
    """The findings in one sentence each: "Line 12 of config.py: a GitHub token (ghp_ab...)."."""
    return [f"Line {f.line} of {f.path}: {f.kind} ({f.hint})" + (", a guess" if f.paired else "") + "."
            for f in findings]


def load_config(settings: dict | None) -> tuple[list[str], list[tuple[str, str]]]:
    """The owner's exclusions and custom patterns, from a JSON file (``OSCR_SECRETS_CONFIG`` or
    data/security/secrets.json). Missing or malformed: no exclusion, no custom pattern."""
    where = (settings or {}).get("OSCR_SECRETS_CONFIG", "") or str(Path("data") / "security" / "secrets.json")
    try:
        data = json.loads(Path(where).read_text("utf-8"))
    except (OSError, ValueError):
        return [], []
    exclusions = [g for g in data.get("exclude", []) if isinstance(g, str)]
    custom = [(c["name"], c["regex"]) for c in data.get("custom", [])
              if isinstance(c, dict) and isinstance(c.get("name"), str) and isinstance(c.get("regex"), str)]
    return exclusions, custom
