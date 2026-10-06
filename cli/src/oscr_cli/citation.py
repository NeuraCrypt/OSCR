"""A repository's citation: ``CITATION.cff`` (a subset of YAML) or ``codemeta.json``, as APA and BibTeX
(``oscr cite``; D14-9).

A port of the website's ``src/lib/citation.ts`` (night phase 02), line for line, so that the terminal
and the site cite a repository the same way: ``tests/fixtures/checks-cases.json`` holds cases both read
(website/tests/forge-pages/checks-parity.test.ts, cli/tests/test_registry.py). An author's email
address is never read; every text is masked as the site masks it.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from .sanitize import mask_emails

Yaml = Any  # str | list[Yaml] | dict[str, Yaml]

# Keys a JavaScript object already has (`key in map` is true for them in the site's reader): the site
# never sets them, so neither does this port.
_JS_PROTO = frozenset({"constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable",
                       "toLocaleString", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"})

_ESC = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


def _scalar(raw: str) -> Yaml:
    s = raw.strip()
    if s.startswith('"'):
        m = re.match(r'^"((?:[^"\\]|\\.)*)"', s)
        if m:
            t = re.sub(r'\\(["\\/bfnrt])', lambda x: _ESC.get(x.group(1), x.group(1)), m.group(1))
            return re.sub(r"\\u([0-9a-fA-F]{4})", lambda x: chr(int(x.group(1), 16)), t)
    if s.startswith("'"):
        m = re.match(r"^'((?:[^']|'')*)'", s)
        if m:
            return m.group(1).replace("''", "'")
    if s.startswith("[") and s.endswith("]"):
        return [x for x in (_scalar(p) for p in s[1:-1].split(",")) if x != ""]
    return re.sub(r"\s+#.*$", "", s)


_KEY = re.compile(r"""^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:"'#][^:#]*?)\s*:(?=\s|$)""")


def _key_end(text: str) -> int:
    m = _KEY.match(text)
    return m.end() if m else -1


def _unquote_key(k: str) -> str:
    t = k.strip()
    if t.startswith(('"', "'")):
        v = _scalar(t)
        return ",".join(map(str, v)) if isinstance(v, list) else str(v)
    return t


def parse_yaml(text: str) -> Yaml:
    """A YAML document of mappings, sequences and scalars (block style, flow lists, | and > blocks):
    what citation files use. Anchors, tags and multi-documents are not read."""
    lines: list[list[Any]] = []
    for raw in re.sub(r"\r\n?", "\n", text).split("\n")[:5000]:
        if re.match(r"^\s*(?:#.*)?$", raw) or re.match(r"^(?:---|\.\.\.)\s*$", raw):
            lines.append([-1, ""])
            continue
        stripped = raw.lstrip()
        lines.append([len(raw) - len(stripped), raw.strip()])
    n = len(lines)
    i = 0

    def skip() -> None:
        nonlocal i
        while i < n and lines[i][0] < 0:
            i += 1

    def block(parent: int, folded: bool) -> str:
        nonlocal i
        out: list[str] = []
        base = -1
        while i < n:
            indent, t = lines[i]
            if 0 <= indent <= parent:
                break
            if indent >= 0 and base < 0:
                base = indent
            out.append("" if indent < 0 else " " * max(0, indent - base) + t)
            i += 1
        while out and out[-1] == "":
            out.pop()
        joined = "\n".join(out)
        return re.sub(r"([^\n])\n(?=[^\n ])", r"\1 ", joined) if folded else joined

    def value(rest: str, indent: int) -> Yaml:
        r = rest.strip()
        if r in ("|", "|-", ">", ">-"):
            return block(indent, r.startswith(">"))
        if r != "":
            return _scalar(r)
        skip()
        if i < n and lines[i][0] > indent:
            return node(lines[i][0])
        if i < n and lines[i][0] == indent and lines[i][1].startswith("- "):
            return node(indent)
        return ""

    def node(indent: int, depth: int = 0) -> Yaml:
        nonlocal i
        skip()
        if i >= n or depth > 50:
            return ""
        if lines[i][1] == "-" or lines[i][1].startswith("- "):
            seq: list[Yaml] = []
            while i < n:
                skip()
                if i >= n:
                    break
                ind, t = lines[i]
                if ind != indent or not (t == "-" or t.startswith("- ")):
                    break
                inner = t[1:].lstrip()
                inner_indent = indent + (len(t) - len(inner))
                if inner == "":
                    i += 1
                    seq.append(value("", indent))
                elif _key_end(inner) >= 0:
                    lines[i] = [inner_indent, inner]
                    seq.append(node(inner_indent, depth + 1))
                else:
                    i += 1
                    seq.append(_scalar(inner))
            return seq
        if _key_end(lines[i][1]) >= 0:
            mapping: dict[str, Yaml] = {}
            while i < n:
                skip()
                if i >= n:
                    break
                ind, t = lines[i]
                if ind != indent:
                    break
                end = _key_end(t)
                if end < 0:
                    break
                key = _unquote_key(re.sub(r":$", "", t[:end]))
                i += 1
                v = value(t[end:], indent)
                if key not in mapping and key not in _JS_PROTO:
                    mapping[key] = v
            return mapping
        s = _scalar(lines[i][1])
        i += 1
        return s

    skip()
    return node(lines[i][0]) if i < n else ""


# ── the citation ──


@dataclass
class Person:
    family: str
    given: str
    name: str
    orcid: str | None


@dataclass
class Work:
    type: str
    title: str
    authors: list[Person] = field(default_factory=list)
    version: str = ""
    year: str = ""
    month: str = ""
    doi: str | None = None
    url: str = ""
    journal: str = ""
    volume: str = ""
    issue: str = ""
    pages: str = ""
    publisher: str = ""


@dataclass
class Citation:
    work: Work
    software: Work
    preferred: bool
    source: str
    message: str

    def as_json(self) -> dict[str, Any]:
        return asdict(self)


def _str(v: Yaml) -> str:
    return mask_emails(v).strip() if isinstance(v, str) else ""


def _obj(v: Yaml) -> dict[str, Yaml]:
    return v if isinstance(v, dict) else {}


def _orcid(v: str) -> str | None:
    m = re.search(r"(\d{4}-\d{4}-\d{4}-\d{3}[\dX])", v)
    return f"https://orcid.org/{m.group(1)}" if m else None


def doi_of(v: str) -> str | None:
    """A DOI in any of its forms, bare (``10.…``), or None."""
    m = re.search(r'(10\.\d{4,9}/[^\s"<>]+)', v)
    return re.sub(r"[.,;]+$", "", m.group(1)) if m else None


def _people(v: Yaml) -> list[Person]:
    out = []
    for p in (v if isinstance(v, list) else []):
        o = _obj(p)
        person = Person(
            family=" ".join(x for x in (_str(o.get("name-particle")), _str(o.get("family-names"))) if x),
            given=_str(o.get("given-names")),
            name=_str(o.get("name")) or _str(o.get("alias")),
            orcid=_orcid(_str(o.get("orcid"))),
        )
        if person.family or person.given or person.name:
            out.append(person)
    return out[:200]


def _https(v: str) -> bool:
    return v.startswith("https://")


def _work(m: dict[str, Yaml], kind: str) -> Work:
    date = _str(m.get("date-released")) or _str(m.get("date-published"))
    ids = [_obj(x) for x in (m.get("identifiers") if isinstance(m.get("identifiers"), list) else [])]
    doi = doi_of(_str(m.get("doi")))
    if doi is None:
        found = next((x for x in ids if _str(x.get("type")) == "doi"), None)
        doi = doi_of(_str(found.get("value")) if found else "")
    year_m = re.match(r"^\d{4}", date)
    month_m = re.match(r"^\d{4}-(\d{2})", date)
    start, end = _str(m.get("start")), _str(m.get("end"))
    pages = f"{start}–{end}" if start and end else (_str(m.get("pages")) or start)
    code = _str(m.get("repository-code"))
    url = code if _https(code) else (_str(m.get("url")) if _https(_str(m.get("url"))) else "")
    return Work(
        type=_str(m.get("type")) or kind,
        title=_str(m.get("title")),
        authors=_people(m.get("authors")),
        version=_str(m.get("version")),
        year=_str(m.get("year")) or (year_m.group(0) if year_m else ""),
        month=_str(m.get("month")) or (month_m.group(1) if month_m else ""),
        doi=doi,
        url=url,
        journal=_str(m.get("journal")) or _str(_obj(m.get("conference")).get("name")),
        volume=_str(m.get("volume")),
        issue=_str(m.get("issue")),
        pages=pages,
        publisher=_str(_obj(m.get("publisher")).get("name")) or _str(m.get("publisher")),
    )


def citation_of_cff(text: str) -> Citation | None:
    """A CITATION.cff file as the citation GitHub offers; None when it has no title or no author."""
    root = _obj(parse_yaml(text))
    software = _work(root, "software")
    if not software.title or not software.authors:
        return None
    pref = _obj(root.get("preferred-citation"))
    preferred = _work(pref, "article") if pref else None
    ok = bool(preferred and preferred.title and preferred.authors)
    return Citation(work=preferred if ok and preferred else software, software=software, preferred=ok, source="CITATION.cff", message=_str(root.get("message")))


def citation_of_codemeta(text: str) -> Citation | None:
    """A codemeta.json file as a citation of the software; None when it has no name or no author."""
    try:
        j = json.loads(text)
    except ValueError:
        return None
    if not isinstance(j, dict):
        return None

    def s(v: Any) -> str:
        return mask_emails(v).strip() if isinstance(v, str) else ""

    def lst(v: Any) -> list[Any]:
        return v if isinstance(v, list) else ([v] if v else [])

    authors = []
    for a in lst(j.get("author")):
        a = a if isinstance(a, dict) else {}
        p = Person(family=s(a.get("familyName")), given=s(a.get("givenName")), name=s(a.get("name")), orcid=_orcid(s(a.get("@id")) or s(a.get("identifier"))))
        if p.family or p.given or p.name:
            authors.append(p)
    date = s(j.get("datePublished")) or s(j.get("dateModified"))
    y, mo = re.match(r"^\d{4}", date), re.match(r"^\d{4}-(\d{2})", date)
    doi = doi_of(s(j.get("identifier")))
    if doi is None:
        doi = doi_of(s(j.get("@id")))
    software = Work(type="software", title=s(j.get("name")), authors=authors, version=s(j.get("version")) or s(j.get("softwareVersion")),
                    year=y.group(0) if y else "", month=mo.group(1) if mo else "", doi=doi,
                    url=s(j.get("codeRepository")) if _https(s(j.get("codeRepository"))) else "")
    if not software.title or not authors:
        return None
    return Citation(work=software, software=software, preferred=False, source="codemeta.json", message="")


# ── APA and BibTeX ──


def _initials(given: str) -> str:
    return " ".join("-".join(f"{p[0].upper()}." for p in g.split("-") if p) for g in re.split(r"\s+", given) if g)


def _apa_name(p: Person) -> str:
    if p.family:
        return f"{p.family}, {_initials(p.given)}" if p.given else p.family
    return p.name or p.given


def apa(w: Work) -> str:
    """APA 7: authors (up to 20), year, title, version or journal, DOI or address."""
    names = [_apa_name(p) for p in w.authors]
    if len(names) == 1:
        who = names[0]
    elif len(names) <= 20:
        who = f"{', '.join(names[:-1])}, & {names[-1] if names else 'undefined'}"
    else:
        who = f"{', '.join(names[:19])}, … {names[-1]}"
    year = f"{who if who.endswith('.') else who + '.'} ({w.year or 'n.d.'})"
    link = f"https://doi.org/{w.doi}" if w.doi else w.url

    def end(s: str) -> str:
        return s if re.search(r"[.?!]$", s) else f"{s}."

    if w.type == "software" or not w.journal:
        version = f" (Version {w.version})" if w.version else ""
        kind = " [Computer software]" if w.type == "software" else ""
        return " ".join(x for x in (end(year), f"{w.title}{version}{kind}.", end(w.publisher) if w.publisher else "", link) if x)
    where = f"{w.journal}{', ' + w.volume if w.volume else ''}{'(' + w.issue + ')' if w.issue else ''}{', ' + w.pages if w.pages else ''}."
    return " ".join(x for x in (end(year), end(w.title), where, link) if x)


MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def _bib(s: str) -> str:
    return re.sub(r"([&%$#_])", r"\\\1", re.sub(r"[{}\\]", "", s))


def _js_number(s: str) -> float:
    t = s.strip()
    if not t:
        return 0.0
    try:
        return float(t)
    except ValueError:
        return float("nan")


def bibtex(w: Work) -> str:
    """BibTeX: @software for the software (with its version), @article or @misc for a paper."""
    first = w.authors[0] if w.authors else None
    who = re.sub(r"[^A-Za-z0-9]", "", (first.family or first.name) if first and (first.family or first.name) else "anonymous")
    word = re.sub(r"[^A-Za-z0-9-]", "", re.split(r"\s+", w.title)[0])
    key = f"{who}_{word}_{w.year or 'nd'}"
    kind = "software" if w.type == "software" else ("article" if w.journal else "misc")
    author = " and ".join((f"{_bib(p.family)}, {_bib(p.given)}" if p.given else _bib(p.family)) if p.family else f"{{{_bib(p.name or p.given)}}}" for p in w.authors)
    fields = [
        ("author", author),
        ("title", f"{{{_bib(w.title)}}}"),
        ("journal", _bib(w.journal)),
        ("volume", _bib(w.volume)),
        ("number", _bib(w.issue)),
        ("pages", _bib(w.pages.replace("–", "--", 1))),
        ("version", _bib(w.version)),
        ("year", _bib(w.year)),
        ("doi", w.doi or ""),
        ("url", w.url),
    ]
    month = _js_number(w.month)
    lines = [f"  {k} = {{{v}}}" for k, v in fields if v]
    if 1 <= month <= 12 and month == int(month):
        lines.insert(len(lines) - 1, f"  month = {MONTHS[int(month) - 1]}")
    body = ",\n".join(lines)
    return f"@{kind}{{{key},\n{body}\n}}"
