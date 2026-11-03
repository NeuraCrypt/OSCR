"""The registry's badge in a README (`oscr badge`): its addresses and snippets, the same as the site's
(website/src/lib/badge.ts, `badgeUrls` and `snippet`), and its place in the file, between two marks,
so that writing it again replaces it instead of adding it twice. Text only: nothing is run."""
from __future__ import annotations

import re
from urllib.parse import quote

#: The marks around the badge, by markup (the site's README_MARKS for Markdown and HTML).
MARKS = {
    "markdown": ("<!-- oscr-badge:start -->", "<!-- oscr-badge:end -->"),
    "html": ("<!-- oscr-badge:start -->", "<!-- oscr-badge:end -->"),
    "rst": (".. oscr-badge:start", ".. oscr-badge:end"),
    "asciidoc": ("// oscr-badge:start", "// oscr-badge:end"),
    "org": ("# oscr-badge:start", "# oscr-badge:end"),
}
FORMATS = tuple(MARKS)
#: The README a format is usually written in, in the order they are looked for.
README_NAMES = {"README.md": "markdown", "README.markdown": "markdown", "README.rst": "rst", "README.adoc": "asciidoc",
                "README.asciidoc": "asciidoc", "README.org": "org", "README.html": "html", "README": "markdown"}
STYLES = ("flat", "large", "mark", "card")
SHOWS = ("status", "doi", "map", "code", "scripts", "language", "license", "journal")


def doi_path(doi: str) -> str:
    """A DOI in a path: every character but the slash percent-encoded."""
    return "/".join(quote(part, safe="") for part in doi.split("/"))


def urls(site: str, *, doi: str = "", repo: str = "", style: str = "flat", show: str = "status") -> dict[str, str]:
    """The badge's image and link, for a paper (its DOI) or a repository (host/owner/name)."""
    site = site.rstrip("/")
    query = "&".join(f"{k}={v}" for k, v in (("style", style), ("show", show)) if v and v != {"style": "flat", "show": "status"}[k])
    if doi and re.search(r"\.(svg|json)$", doi, re.I):
        q = f"doi={quote(doi, safe='')}"
        return {"image": f"{site}/badge/doi.svg?{q}{'&' + query if query else ''}", "link": f"{site}/badge/doi?{q}"}
    base = f"{site}/badge/doi/{doi_path(doi)}" if doi else f"{site}/badge/repo/{repo.lower()}"
    return {"image": f"{base}.svg{'?' + query if query else ''}", "link": base}


def snippet(fmt: str, image: str, link: str, alt: str) -> str:
    """The badge in a markup (the site's `snippet`)."""
    if fmt == "markdown":
        return f"[![{alt.replace('[', '').replace(']', '')}]({image})]({link})"
    if fmt == "html":
        esc = lambda s: s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")  # noqa: E731
        return f'<a href="{esc(link)}"><img src="{esc(image)}" alt="{esc(alt)}"></a>'
    if fmt == "rst":
        return f".. image:: {image}\n   :target: {link}\n   :alt: {alt}"
    if fmt == "asciidoc":
        return f'image:{image}[{alt.replace("]", "")},link="{link}"]'
    if fmt == "org":
        return f"[[{link}][{image}]]"
    raise ValueError(fmt)


def _block(fmt: str, text: str) -> str:
    start, end = MARKS[fmt]
    return f"{start}\n{text}\n{end}"


def _title_end(lines: list[str], fmt: str) -> int:
    """The index of the line after the document's title (0 when it has none at its top)."""
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if fmt == "markdown" and i < len(lines) and lines[i].startswith("---") and lines[i].strip() == "---":
        # A front matter (a Hugging Face card's YAML): the badge goes after it, never inside.
        j = next((k for k in range(i + 1, len(lines)) if lines[k].strip() == "---"), None)
        if j is not None:
            i = j + 1
            while i < len(lines) and not lines[i].strip():
                i += 1
    if i >= len(lines):
        return i
    line = lines[i]
    if fmt in ("markdown", "html"):
        if re.match(r"^#\s", line) or re.match(r"(?i)^<h1[\s>]", line):
            return i + 1
        if i + 1 < len(lines) and re.match(r"^=+\s*$", lines[i + 1]) and line.strip():
            return i + 2
    elif fmt == "rst":
        over = re.match(r"^([=#*~^-])\1+\s*$", line)
        if over and i + 2 < len(lines) and lines[i + 2].strip() == line.strip():
            return i + 3
        if i + 1 < len(lines) and line.strip() and re.match(r"^([=#*~^-])\1+\s*$", lines[i + 1]):
            return i + 2
    elif fmt == "asciidoc":
        if re.match(r"^=\s", line):
            j = i + 1
            while j < len(lines) and lines[j].strip() and not lines[j].startswith("="):  # the header's author/revision lines
                j += 1
            return j
    elif fmt == "org":
        j = i
        while j < len(lines) and re.match(r"(?i)^#\+\w+:", lines[j]):
            j += 1
        if j < len(lines) and re.match(r"^\*\s", lines[j]):
            j += 1
        return j
    return i if fmt == "markdown" and i > 0 else 0


def insert(readme: str, fmt: str, text: str) -> str:
    """The README with the badge between its marks: replaced where the marks are, else put under the
    title (after a front matter), else at the top. Idempotent."""
    start, end = MARKS[fmt]
    block = _block(fmt, text)
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    if pattern.search(readme):
        return pattern.sub(lambda _: block, readme, count=1)
    lines = readme.split("\n")
    at = _title_end(lines, fmt)
    before, after = lines[:at], lines[at:]
    while before and not before[-1].strip():
        before.pop()
    while after and not after[0].strip():
        after.pop(0)
    parts = []
    if before:
        parts.append("\n".join(before))
    parts.append(block)
    if after:
        parts.append("\n".join(after))
    out = "\n\n".join(parts)
    return out if out.endswith("\n") else out + "\n"


def remove(readme: str, fmt: str) -> str:
    """The README without the badge's marks and what is between them."""
    start, end = MARKS[fmt]
    out = re.sub(r"\n*" + re.escape(start) + r".*?" + re.escape(end) + r"\n*", "\n\n", readme, count=1, flags=re.S)
    return out.lstrip("\n") if not readme.startswith("\n") else out


def has_marks(readme: str, fmt: str) -> bool:
    start, end = MARKS[fmt]
    return start in readme and end in readme
