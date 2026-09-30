"""A paper's methods, recognized by the stat_bruteforce catalog.

The catalog is arranged like stat_bruteforce's method → library catalog: by
FAMILY (Preprocessing, Spectral & time-frequency, Connectivity…). Each method
of the catalog carries the pattern that recognizes it in a sentence; they are
run over the paper's Methods (the whole body when the paper has no
recognizable Methods section).

What this allows: for a given method, finding the papers whose native code
implements it, REFERENCE implementations, written by the authors themselves.

The vocabulary is a frozen copy (`vocabulary/method_catalog.json`), refreshed
by the catalog export script in `tools/`.
"""
from __future__ import annotations

import functools
import json
import re
from pathlib import Path

VOCABULARY_FILE = Path(__file__).parent / "vocabulary" / "method_catalog.json"


@functools.lru_cache(maxsize=1)
def catalog() -> tuple[tuple[str, str, re.Pattern[str]], ...]:
    """(method, family, compiled pattern) for each method of the catalog."""
    if not VOCABULARY_FILE.exists():
        return ()
    d = json.loads(VOCABULARY_FILE.read_text())
    out = []
    for m in d.get("methods", []):
        try:
            out.append((m["method"], m["family"], re.compile(m["pattern"], re.I)))
        except re.error:
            continue
    return tuple(out)


def recognize(text: str) -> tuple[list[str], list[str]]:
    """(families, methods) named in the text, in catalog order."""
    if not text:
        return [], []
    methods, families = [], []
    for name, family, pattern in catalog():
        if pattern.search(text):
            methods.append(name)
            if family not in families:
                families.append(family)
    return families, methods
