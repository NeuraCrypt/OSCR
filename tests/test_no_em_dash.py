"""The em dash "—" (U+2014) is banned from every text OSCR shows: it reads as AI-generated text
and hurts the project's scientific credibility (the owner's firm rule; CLAUDE.md, the website's
style). Proper ASCII punctuation is used instead (a comma, a colon, or parentheses, chosen by the
sense). This test scans the Mac's own source (oscr/ and tools/) for a literal em dash and fails
listing every offender. The website is guarded the same way by website/scripts/check.mjs, which
scans the built HTML.

A few regexes and strip() calls legitimately MATCH the em dash to strip it OUT of harvested data
(page ranges, author names, section titles); those lines carry an `# emdash-ok` marker and are the
only ones allowed to hold the character."""
from pathlib import Path

EM_DASH = "—"
ALLOW_MARKER = "emdash-ok"
ROOT = Path(__file__).resolve().parents[1]

# The trees scanned and the file kinds a person may read (code, generated strings, notices, the
# dashboard, SQL comments, shell and launchd messages).
SCANNED = [
    (ROOT / "oscr", ("*.py", "*.html", "*.sql")),
    (ROOT / "tools", ("*.py", "*.sh", "*.plist")),
]


def _offenders():
    """Every (path, line number, text) that still holds an em dash, marker lines excluded."""
    hits = []
    for base, patterns in SCANNED:
        for pattern in patterns:
            for path in sorted(base.rglob(pattern)):
                text = path.read_text(encoding="utf-8", errors="replace")
                if EM_DASH not in text:
                    continue
                for num, line in enumerate(text.splitlines(), 1):
                    if EM_DASH in line and ALLOW_MARKER not in line:
                        hits.append((path.relative_to(ROOT), num, line.strip()))
    return hits


def test_no_em_dash_in_mac_source():
    offenders = _offenders()
    assert not offenders, "em dash (U+2014) is banned from visible text; found in:\n" + "\n".join(
        f"  {path}:{num}: {line}" for path, num, line in offenders
    )
