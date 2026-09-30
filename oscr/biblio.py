"""The bibliographic record of a paper, from its JATS full text and its Europe PMC `core` record.

**Two sources, both already at hand.** The JATS full text ("J") is cached forever; the Europe
PMC `core` search result ("E") comes with every pass of the harvester. Neither costs a request,
and each has what the other lacks: the JATS knows the affiliations, the corresponding authors,
the history dates, the references, the RRIDs and the availability statements; Europe PMC knows
the MeSH terms, the citation count, the open-access flag, the retractions and corrections, and
often the ISSN and the keywords that the JATS dropped.

**Two JATS flavours at Europe PMC** (measured on 3,529 cached full texts, 2026-09-26):

- 45% keep a normal `<back>`;
- 48% have none: the back matter (references, declarations, funding) sits in the last `<body>`
  sections (`article/body/sec/sec/ref-list`); the keywords become a "Keywords: a, b" paragraph in
  `abstract/sec[@sec-type="kwd-group"]`, the history dates a sentence in
  `front/notes/sec[@sec-type="history"]` ("Received 2021 Aug 24; Accepted 2022 Mar 12"), the
  publication date an untyped `<pub-date>` (the electronic one), the references' identifiers
  typed `ext-link`s; the ISSN, the subjects and the structured funding are gone;
- 7% are front matter only (conference abstracts, `article-type="abstract"`).

`sub-article` elements (eLife's assessments and reviews, authors' responses) are never read as
the paper: their keywords ("Important", "Convincing") and references are not the paper's.

**No email address, ever.** `<email>` elements are not read, and a last pass scrubs every string
of the record, since affiliations and statements also carry addresses as plain text.

**Merge.** `merge(j, e)` keeps, field by field, the first non-empty value and records its source
in `provenance`. `journal` and `dates` merge key by key (the ISSN from Europe PMC, the history
dates from the JATS): their provenance keys are dotted, e.g. `journal.issn`.
"""
from __future__ import annotations

import copy
import html
import re
import unicodedata
import xml.etree.ElementTree as ET
from collections.abc import Iterable, Iterator
from datetime import date
from typing import Any
from urllib.parse import unquote

from .jats import _analyze

XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

JATS, EPMC = "jats", "epmc"

SCALARS: tuple[str, ...] = ("type", "language", "abstract", "volume", "issue", "pages",
                            "cited_by_count", "is_open_access", "license", "references_count")
JOURNAL_KEYS: tuple[str, ...] = ("title", "issn", "eissn", "publisher", "nlm_ta")
DATE_KEYS: tuple[str, ...] = ("received", "accepted", "epub", "ppub", "collection",
                              "first_publication")
LISTS: tuple[str, ...] = ("keywords", "mesh", "subjects", "authors", "funding", "references",
                          "rrids", "statements", "integrity")
#: Every key of a record, in order. All are always present.
FIELDS: tuple[str, ...] = SCALARS + ("journal", "dates") + LISTS + ("provenance",)

#: The scalars that are None when unknown (0 and False are answers).
_NULLABLE = frozenset({"cited_by_count", "is_open_access", "references_count"})


def empty() -> dict:
    """A record with every key present and every value empty."""
    record: dict[str, Any] = {k: (None if k in _NULLABLE else "") for k in SCALARS}
    record["journal"] = dict.fromkeys(JOURNAL_KEYS, "")
    record["dates"] = dict.fromkeys(DATE_KEYS, "")
    record.update({k: [] for k in LISTS})
    record["provenance"] = {}
    return record


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


# ─── text ───────────────────────────────────────────────────────────────────

#: Never read: addresses, and the TeX or annotation copies of a formula.
_SKIP = frozenset({"email", "tex-math", "annotation", "annotation-xml"})

#: Elements that end a word: read end to end, "…RRID:SCR_001622</p><p>Next" gave one token.
_BLOCKS = frozenset({
    "p", "sec", "title", "label", "caption", "td", "th", "tr", "list-item", "fn", "ref",
    "mixed-citation", "element-citation", "kwd", "aff", "def", "term", "disp-quote", "table-wrap",
    "fig", "supplementary-material", "abstract", "notes", "ack", "app", "boxed-text",
    "statement", "attrib", "subject", "article-title", "journal-title", "break", "contrib",
    "corresp", "funding-source", "award-id", "meta-name", "meta-value"})

#: Not the paper: eLife's assessments and reviews, the authors' responses.
_NOT_THE_PAPER = frozenset({"sub-article", "response"})

#: Addresses as written in affiliations and statements, with the label that announces them.
#: Not a git remote: "git@github.com:lab/repo.git" is a code address, not a person's.
_EMAIL = re.compile(
    r"(?:\b(?:e-?mail(?:\s+address(?:es)?)?|electronic\s+address)\s*[:：]?\s*)?"
    r"[\w.+'%-]+\s?(?:@|\(at\)|\[at\]|\{at\})\s?[\w-]+(?:\s?(?:\.|\(dot\)|\[dot\])\s?[\w-]+)+"
    r"\b(?!:\w)", re.I)


def _local(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _squash(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _text(e: ET.Element | None, skip: frozenset[str] = _SKIP, links: bool = False) -> str:
    """The text of an element on one line. `links`: an address hidden behind its anchor text
    ("our repository") is written after it, in parentheses."""
    if e is None:
        return ""
    parts: list[str] = []
    _gather(e, skip, links, parts)
    return _squash("".join(parts))


def _gather(e: ET.Element, skip: frozenset[str], links: bool, parts: list[str]) -> None:
    if e.text:
        parts.append(e.text)
    for c in e:
        name = _local(c.tag)
        if name not in skip:
            block = name in _BLOCKS
            if block:
                parts.append(" ")
            start = len(parts)
            _gather(c, skip, links, parts)
            if links and name in ("ext-link", "uri"):
                href = unquote(c.get(XLINK_HREF) or "").strip()
                if _hidden_address(href, "".join(parts[start:])):
                    parts.append(f" ({href})")
            if block:
                parts.append(" ")
        if c.tail:
            parts.append(c.tail)


def _hidden_address(href: str, shown: str) -> bool:
    if not re.match(r"(?i)(?:https?|ftp)://|10\.\d{4,9}/", href):
        return False
    def bare(s: str) -> str:
        return re.sub(r"(?i)^(?:https?|ftp)://(?:www\.)?", "", s.strip()).rstrip("/").lower()
    return bare(href) not in bare(shown)


def _walk(e: ET.Element, skip: frozenset[str] = _NOT_THE_PAPER) -> Iterator[ET.Element]:
    """The descendants of `e` in document order, without the subtrees named in `skip`."""
    stack = list(reversed(e))
    while stack:
        c = stack.pop()
        if _local(c.tag) in skip:
            continue
        yield c
        stack.extend(reversed(c))


def _headed(title: str, paragraph: str) -> str:
    title = title.strip()
    return title + (" " if title[-1:] in ":.?!" else ": ") + paragraph


#: The sections that are not running text: the keywords of the flavour without `<back>`.
_NOT_TEXT_SECTIONS = frozenset({"kwd-group"})


def _paragraphs(e: ET.Element, links: bool = False) -> list[str]:
    """The paragraphs of an element, each as one line; a section's title opens its first
    paragraph ("Methods: …"). Figures, tables and labels are left out."""
    out: list[str] = []
    for c in e:
        name = _local(c.tag)
        if name in ("sec", "notes", "boxed-text", "app"):
            if (c.get("sec-type") or "").lower() in _NOT_TEXT_SECTIONS:
                continue
            inner = _paragraphs(c, links)
            title = _text(c.find("title"))
            if title and inner:
                inner[0] = _headed(title, inner[0])
            out += inner
        elif name in ("list", "list-item", "def-list", "def-item", "fn-group", "fn"):
            out += _paragraphs(c, links)
        elif name in ("p", "disp-quote", "statement", "def", "preformat", "verse-group"):
            t = _text(c, links=links)
            if t:
                out.append(t)
    return out


def _unique(values: Iterable[str]) -> list[str]:
    """Non-empty values, first spelling kept, duplicates dropped regardless of case."""
    seen: set[str] = set()
    out = []
    for v in values:
        key = v.casefold()
        if v and key not in seen:
            seen.add(key)
            out.append(v)
    return out


def _no_email(s: str) -> str:
    if "@" not in s and not re.search(r"(?i)[(\[{]at[)\]}]", s):
        return s
    s = _EMAIL.sub("", s)
    s = re.sub(r"\([ \t]*[,;:]?[ \t]*\)|\[[ \t]*\]", "", s)
    s = re.sub(r"[ \t]+([,;.])", r"\1", s)
    s = re.sub(r"([,;.])[,;.]+", r"\1", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    return s.strip()


def _scrub(value: Any) -> Any:
    """The same value with every email address removed from its strings."""
    if isinstance(value, str):
        return _no_email(value)
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items()}
    return value


# ─── identifiers ────────────────────────────────────────────────────────────

_ORCID = re.compile(r"(?<![\dX])(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dX])(?![\dX])", re.I)


def _orcid(value: str) -> str:
    """The bare ORCID iD (0000-0002-1825-0097) if its ISO 7064 MOD 11-2 check digit holds."""
    m = _ORCID.search(value or "")
    if not m:
        return ""
    digits = "".join(m.groups()).upper()
    total = 0
    for ch in digits[:-1]:
        total = (total + int(ch)) * 2
    check = (12 - total % 11) % 11
    if digits[-1] != ("X" if check == 10 else str(check)):
        return ""
    return "-".join(digits[i:i + 4] for i in range(0, 16, 4))


_CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"
_ROR = re.compile(r"(?:ror\.org/)?\b(0[a-hj-km-np-tv-z0-9]{6}\d{2})\b", re.I)


def _ror(value: str) -> str:
    """The bare ROR id (03vek6s52) if its ISO 7064 MOD 97-10 checksum holds."""
    m = _ROR.search(value or "")
    if not m:
        return ""
    ror = m.group(1).lower()
    n = 0
    for ch in ror[:7]:
        n = n * 32 + _CROCKFORD.index(ch)
    return ror if int(ror[7:]) == 98 - (n * 100) % 97 else ""


def _doi(value: str) -> str:
    v = unquote((value or "").strip())
    v = re.sub(r"(?i)^(?:https?://)?(?:dx\.)?doi\.org/|^doi:\s*", "", v).strip()
    v = v.rstrip(".,;:]}>'\"")
    while v.endswith(")") and v.count(")") > v.count("("):
        v = v[:-1]
    return v.lower() if re.fullmatch(r"10\.\d{4,9}/\S+", v) else ""


def _pmid(value: str) -> str:
    v = (value or "").strip()
    m = re.search(r"pubmed(?:\.ncbi\.nlm\.nih\.gov)?/(\d{1,9})\b", v)
    if m:
        return m.group(1)
    return v if re.fullmatch(r"\d{1,9}", v) else ""


def _issn(value: Any) -> str:
    m = re.fullmatch(r"(\d{4})[-‐‑–]?(\d{3}[\dX])", str(value or "").strip().upper())
    return f"{m.group(1)}-{m.group(2)}" if m else ""


def _funder_doi(value: str, bare_number: bool = False) -> str:
    """A Crossref Funder Registry id as a bare DOI (10.13039/501100001691)."""
    m = re.search(r"10\.13039/(\d+)", value or "")
    if m:
        return f"10.13039/{m.group(1)}"
    if bare_number and re.fullmatch(r"\d{6,12}", (value or "").strip()):
        return f"10.13039/{value.strip()}"
    return ""


#: ISO 639-2 codes (Europe PMC's "eng") → ISO 639-1 (the JATS "en").
_ISO639_2 = {
    "eng": "en", "fre": "fr", "fra": "fr", "ger": "de", "deu": "de", "spa": "es", "por": "pt",
    "ita": "it", "chi": "zh", "zho": "zh", "jpn": "ja", "rus": "ru", "dut": "nl", "nld": "nl",
    "pol": "pl", "kor": "ko", "tur": "tr", "cze": "cs", "ces": "cs", "swe": "sv", "nor": "no",
    "dan": "da", "fin": "fi", "hun": "hu", "gre": "el", "ell": "el", "heb": "he", "ara": "ar",
    "per": "fa", "fas": "fa", "ukr": "uk", "rum": "ro", "ron": "ro", "hrv": "hr", "srp": "sr",
    "slv": "sl", "slo": "sk", "slk": "sk", "bul": "bg", "lit": "lt", "lav": "lv", "est": "et",
    "ice": "is", "isl": "is", "cat": "ca", "glg": "gl", "baq": "eu", "eus": "eu", "tha": "th",
    "vie": "vi", "ind": "id", "may": "ms", "msa": "ms", "hin": "hi", "afr": "af"}


def _language(code: Any) -> str:
    c = str(code or "").strip().lower().replace("_", "-").split("-")[0]
    if not re.fullmatch(r"[a-z]{2,3}", c):
        return ""
    return _ISO639_2.get(c, c)


# ─── licenses ───────────────────────────────────────────────────────────────

_CC_URL = re.compile(r"creativecommons\.org/(?:licenses/(by(?:-nc)?(?:-nd|-sa)?)|publicdomain/(zero))"
                     r"/(\d(?:\.\d)?)", re.I)
_CC_NAME = re.compile(r"creative\s*commons|\bcc[\s-]*(?:by|0|zero)\b|\bcc0\b", re.I)


def _cc_url(s: str) -> str:
    """The SPDX id of a Creative Commons URL: .../licenses/by-nc/3.0 → CC-BY-NC-3.0."""
    m = _CC_URL.search(s or "")
    if not m:
        return ""
    if m.group(2):
        return "CC0-1.0"
    version = m.group(3) if "." in m.group(3) else m.group(3) + ".0"
    return f"CC-{m.group(1).upper()}-{version}"


def _cc_words(s: str) -> str:
    """The SPDX id of a license named in words: "Creative Commons Attribution-NonCommercial 4.0
    International License", "CC BY-NC-ND", Europe PMC's "cc by-nc". Without a version, 4.0,
    the spelling of `repos.py` ("cc by" → CC-BY-4.0)."""
    m = _CC_NAME.search(s or "")
    if not m:
        return ""
    tail = s[m.start():m.start() + 200]
    end = re.search(r"licen[cs]e|\.(?:\s|$)", tail, re.I)
    name = (tail[:end.end()] if end else tail).lower()
    if re.search(r"\bcc[\s-]*(?:0|zero)\b|\bcc0\b|commons\s+(?:zero|public\s+domain)", name):
        return "CC0-1.0"
    nc = re.search(r"non[\s-]?commercial|\bnc\b", name)
    nd = re.search(r"no[\s-]?deriv|\bnd\b", name)
    sa = re.search(r"share[\s-]?alike|\bsa\b", name)
    if not (re.search(r"attribution|\bby\b", name) or nc or nd or sa):
        return ""
    version = re.search(r"\b([1-4]\.0|2\.5)\b", name)
    return ("CC-BY" + ("-NC" if nc else "") + ("-ND" if nd else "-SA" if sa else "")
            + "-" + (version.group(1) if version else "4.0"))


def _license_id(text: str) -> str:
    """A license from a URL or a name; "other" for a license that is neither."""
    if not (text or "").strip():
        return ""
    return _cc_url(text) or _cc_words(text) or "other"


# ─── dates ──────────────────────────────────────────────────────────────────

_MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}


def _month(value: str) -> int:
    v = (value or "").strip().lower()
    if v.isdigit():
        return int(v) if 1 <= int(v) <= 12 else 0
    return _MONTHS.get(v[:3], 0)


def _iso(year: str, month: str = "", day: str = "") -> str:
    """An ISO date, as precise as what is known: 2026-03-14, 2026-03 or 2026."""
    y = (year or "").strip()
    if not re.fullmatch(r"\d{4}", y):
        return ""
    m = _month(month)
    if not m:
        return y
    d = int(day) if (day or "").strip().isdigit() else 0
    try:
        return date(int(y), m, d).isoformat() if d else f"{y}-{m:02d}"
    except ValueError:
        return f"{y}-{m:02d}"


def _iso_string(value: Any) -> str:
    m = re.match(r"(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", str(value or "").strip())
    return _iso(m.group(1), m.group(2) or "", m.group(3) or "") if m else ""


def _jats_date(e: ET.Element) -> str:
    iso = _iso_string(e.get("iso-8601-date"))
    return iso or _iso(_text(e.find("year")), _text(e.find("month")), _text(e.find("day")))


#: The history of the flavour without `<back>`, as one sentence.
_HISTORY = re.compile(r"\b(received|accepted|collection date|issue date)\s+(\d{4})"
                      r"(?:\s+([a-z]{3,9})\.?)?(?:\s+(\d{1,2}))?\b", re.I)
_HISTORY_KEYS = {"received": "received", "accepted": "accepted", "collection date": "collection",
                 "issue date": "ppub"}


def _jats_dates(meta: ET.Element, front: ET.Element) -> dict[str, str]:
    dates: dict[str, str] = {}
    for pd in meta.findall("pub-date"):
        kind = (pd.get("pub-type") or "").lower()
        dtype = (pd.get("date-type") or "").lower()
        fmt = (pd.get("publication-format") or "").lower()
        keys: tuple[str, ...] = ()
        if kind == "epub" or (dtype == "pub" and fmt != "print") or not (kind or dtype or fmt):
            keys = ("epub",)      # untyped: the electronic date (PMC's flavour without <back>)
        elif kind == "ppub" or (dtype == "pub" and fmt == "print"):
            keys = ("ppub",)
        elif kind == "epub-ppub":
            keys = ("epub", "ppub")
        elif kind == "collection" or dtype == "collection":
            keys = ("collection",)
        value = _jats_date(pd) if keys else ""
        for k in keys:
            if value:
                dates.setdefault(k, value)
    for d in meta.findall("history/date"):
        kind = (d.get("date-type") or "").lower()
        if kind in ("received", "accepted"):
            value = _jats_date(d)
            if value:
                dates.setdefault(kind, value)
    for sec in front.iter("sec"):
        if (sec.get("sec-type") or "").lower() == "history":
            for m in _HISTORY.finditer(_text(sec)):
                value = _iso(m.group(2), m.group(3) or "", m.group(4) or "")
                if value:
                    dates.setdefault(_HISTORY_KEYS[m.group(1).lower()], value)
    return dates


# ─── J: the JATS full text ──────────────────────────────────────────────────

def from_jats(xml: str) -> dict:
    """The record read from a JATS full text. Never raises: an unreadable text gives an
    empty record."""
    record = empty()
    if isinstance(xml, bytes):
        xml = xml.decode("utf-8", "replace")
    root = _analyze(xml) if isinstance(xml, str) and xml.strip() else None
    if root is None:
        return record
    art = root if _local(root.tag) == "article" else next(
        (e for e in root.iter() if _local(e.tag) == "article"), None)
    if art is None:
        return record
    front = art.find("front")
    meta = front.find("article-meta") if front is not None else None
    journal = front.find("journal-meta") if front is not None else None
    record["type"] = (art.get("article-type") or "").strip().lower()
    record["language"] = _language(art.get(XML_LANG))
    if journal is not None:
        record["journal"].update(_journal(journal))
    if meta is not None and front is not None:
        record["abstract"] = _abstract(meta)
        record["volume"] = _text(meta.find("volume"))
        record["issue"] = _text(meta.find("issue"))
        record["pages"] = _pages(meta)
        record["license"] = _jats_license(meta)
        record["dates"].update(_jats_dates(meta, front))
        record["keywords"] = _jats_keywords(meta, front, record["language"])
        record["subjects"] = _subjects(meta)
        record["authors"] = _jats_authors(meta)
        record["funding"] = _jats_funding(meta, art)
    record["references"], record["references_count"] = _references(art, meta)
    if "RRID" in xml:
        record["rrids"] = _rrids(art)
    record["statements"] = _statements(art, meta)
    return _finish(record, JATS)


def _finish(record: dict, source: str) -> dict:
    record = _scrub(record)
    provenance = {k: source for k in SCALARS + LISTS if not _is_empty(record[k])}
    for group in ("journal", "dates"):
        provenance.update({f"{group}.{k}": source for k, v in record[group].items()
                           if not _is_empty(v)})
    record["provenance"] = provenance
    return record


def _journal(jm: ET.Element) -> dict[str, str]:
    title = _text(jm.find("journal-title-group/journal-title")) or _text(jm.find("journal-title"))
    issn = eissn = ""
    loose = []
    for x in jm.findall("issn"):
        value = _issn(_text(x))
        kind = (x.get("pub-type") or x.get("publication-format") or "").lower()
        if not value:
            continue
        if kind in ("epub", "electronic", "online", "eissn"):
            eissn = eissn or value
        elif kind in ("ppub", "print", "pissn"):
            issn = issn or value
        else:
            loose.append(value)
    for value in loose:
        if not issn:
            issn = value
        elif not eissn and value != issn:
            eissn = value
    nlm = next((_text(x) for x in jm.findall("journal-id")
                if (x.get("journal-id-type") or "").lower() == "nlm-ta"), "")
    return {"title": title, "issn": issn, "eissn": eissn,
            "publisher": _text(jm.find("publisher/publisher-name")), "nlm_ta": nlm}


#: The abstract proper; the others are summaries, highlights or pictures.
_MAIN_ABSTRACTS = frozenset({"", "standard", "structured", "section", "abstract", "main"})
_NOT_ABSTRACTS = frozenset({
    "graphical", "toc-graphic", "toc", "teaser", "highlights", "author-highlights",
    "editor-highlights", "key-points", "short", "precis", "web-summary", "plain-language-summary",
    "executive-summary", "summary", "synopsis", "longsummary", "author-summary",
    "editor-summary", "lay-summary"})


def _abstract(meta: ET.Element) -> str:
    abstracts = [(a, (a.get("abstract-type") or "").strip().lower())
                 for a in meta.findall("abstract")]
    chosen = next((a for a, kind in abstracts if kind in _MAIN_ABSTRACTS), None)
    if chosen is None:
        chosen = next((a for a, kind in abstracts if kind not in _NOT_ABSTRACTS), None)
    if chosen is None:
        return ""
    paragraphs = _paragraphs(chosen) or [_text(chosen, _SKIP | {"title", "label"})]
    return "\n\n".join(p for p in paragraphs if p)


def _pages(meta: ET.Element) -> str:
    """"fpage-lpage" (a hyphen, as Europe PMC writes it), else the elocation-id. The flavour
    without <back> often drops <lpage> but keeps the range in <page-range>."""
    first, last = _text(meta.find("fpage")), _text(meta.find("lpage"))
    if first and last and last != first:
        return f"{first}-{last}"
    span = re.sub(r"\s*[-‐‑–—]\s*", "-", _text(meta.find("page-range")))  # emdash-ok: strips em dashes out of harvested page ranges
    if span and (not first or span.startswith(first + "-")):
        return span.split(",")[0].strip()
    return first or _text(meta.find("elocation-id"))


def _jats_license(meta: ET.Element) -> str:
    """The article's license: its URL first (`ali:license_ref`, `xlink:href`, an address in the
    text: 97% of the cached texts), else its name in the text."""
    licenses = meta.findall("permissions/license")
    urls, texts = [], []
    for lic in licenses:
        for e in lic.iter():
            if _local(e.tag) == "license_ref" and e.text:
                urls.append(e.text)
            if e.get(XLINK_HREF):
                urls.append(e.get(XLINK_HREF, ""))
        texts += [lic.get("license-type") or "", _text(lic)]
    for s in urls + texts:
        if _cc_url(s):
            return _cc_url(s)
    for s in texts:
        if _cc_words(s):
            return _cc_words(s)
    return "other" if any(t.strip() for t in texts + urls) else ""


def _keyword_list(words: Iterable[str]) -> list[str]:
    """Keywords, one per item: a `<kwd>` sometimes holds "Keywords: a; b; c"."""
    out = []
    for w in words:
        w = re.sub(r"(?i)^\s*(?:key\s*words?|index terms)\s*[:.]\s*", "", w or "")
        out += [_squash(x).strip(" .;,") for x in w.split(";")]
    return _unique(x for x in out if x and len(x) <= 200)


def _jats_keywords(meta: ET.Element, front: ET.Element, language: str) -> list[str]:
    words: list[str] = []
    for group in meta.findall("kwd-group"):
        if re.search("abbrev", group.get("kwd-group-type") or "", re.I):
            continue
        lang = _language(group.get(XML_LANG))
        if lang and language and lang != language:
            continue             # a translation of the keywords
        for k in group.iter():
            if _local(k.tag) in ("kwd", "compound-kwd"):
                words.append(_text(k))
    # The flavour without <back>: "Keywords: a, b, c" (also "Research organism: Mouse").
    sections = [s for a in meta.findall("abstract") for s in a.iter("sec")]
    sections += [s for n in front.findall("notes") for s in n.iter("sec")]
    for sec in sections:
        if (sec.get("sec-type") or "").lower() != "kwd-group":
            continue
        for p in sec.iter("p"):
            text = _text(p)
            label, colon, rest = text.partition(":")
            if not colon or len(label) > 40:
                label, rest = "", text
            if re.search("abbrev", label, re.I):
                continue
            words += re.split(r"[;,]\s+|;", rest)
    return _keyword_list(words)


#: Subject groups that hold no subject: article types, collections, flags and codes.
_NOT_SUBJECT_GROUPS = frozenset({
    "article-type", "legacy-article-type", "spie-art-type", "display-channel", "hwp-journal-coll",
    "category-taxonomy-collection", "allowcommenting", "badge", "featured", "online-only",
    "online-first", "special-article", "special", "toc-title", "type", "category-oup-series",
    "section", "lasker-awards"})
#: Words that make an article type, not a subject: "Original Research Article".
_TYPE_WORDS = frozenset(
    "a and of the to in article articles paper papers report reports research original review "
    "reviews brief short rapid invited systematic mini full regular communication communications "
    "letter letters editor editors editorial editorials commentary commentaries perspective "
    "perspectives opinion correspondence abstract abstracts erratum errata correction "
    "corrections corrigendum retraction note notes study protocol protocols method methods meta "
    "analysis update news discussion reply comment comments addendum highlight highlights "
    "feature features preprint poster oral presentation case investigation".split())


def _subject_ok(s: str, taxonomy: bool) -> bool:
    if not s or len(s) > 150 or s.isdigit() or ("/" in s and " " not in s and re.search(r"\d", s)):
        return False             # a code: "AcademicSubjects/SCI01870", "1506"
    words = re.findall(r"[a-z]+", s.lower())
    # PLOS's subject taxonomy ("Discipline-v3") has a "Research and Analysis Methods".
    return bool(words) and (taxonomy or not all(w in _TYPE_WORDS for w in words))


def _subjects(meta: ET.Element) -> list[str]:
    """The subjects of `article-categories`, all levels, without the table-of-contents headings
    that name an article type ("Research Article": 60% of the headings, 2026-09-26)."""
    out: list[str] = []

    def walk(group: ET.Element, taxonomy: bool) -> None:
        kind = (group.get("subj-group-type") or "").lower()
        if kind in _NOT_SUBJECT_GROUPS:
            return
        taxonomy = taxonomy or kind.startswith("discipline")
        out.extend(s for s in (_text(x) for x in group.findall("subject"))
                   if _subject_ok(s, taxonomy))
        for sub in group.findall("subj-group"):
            walk(sub, taxonomy)

    for group in meta.findall("article-categories/subj-group"):
        walk(group, False)
    return _unique(out)


# ─── J: authors ─────────────────────────────────────────────────────────────

#: A footnote of the author notes that gives the correspondence ("* Correspondence: …").
_CORRESPONDENCE = re.compile(r"correspond", re.I)
_AFF_SKIP = _SKIP | {"label", "institution-id", "xref", "fn"}
#: Inside a contributor, the members of a consortium are not the contributor.
_CONTRIB_SKIP = _NOT_THE_PAPER | {"contrib-group"}


def _jats_authors(meta: ET.Element) -> list[dict]:
    affs: dict[str, ET.Element] = {}
    for a in meta.iter("aff"):
        if a.get("id"):
            affs.setdefault(a.get("id", ""), a)
    for alt in meta.iter("aff-alternatives"):
        first = alt.find("aff")
        if alt.get("id") and first is not None:
            affs.setdefault(alt.get("id", ""), first)
    corresp = {c.get("id", "") for c in meta.iter("corresp") if c.get("id")}
    notes_text = [_text(c) for c in meta.iter("corresp")]
    for fn in (fn for notes in meta.findall("author-notes") for fn in notes.iter("fn")):
        text = _text(fn)
        if (fn.get("fn-type") or "").lower() in ("corresp", "correspondence") \
                or _CORRESPONDENCE.search(text[:60]):
            notes_text.append(text)
            if fn.get("id"):
                corresp.add(fn.get("id", ""))
    groups = meta.findall("contrib-group")
    referenced = {rid for g in groups for c in g.findall("contrib") for x in c.iter("xref")
                  for rid in (x.get("rid") or "").split() if rid in affs}
    # An <aff> that no contributor points to belongs to all of them (JATS convention).
    loose = [a for a in meta.findall("aff") if a.get("id") not in referenced]
    authors: list[dict] = []
    for group in groups:
        kind = (group.get("content-type") or "").lower()
        if kind and not kind.startswith("author"):
            continue             # editors, reviewers
        group_loose = [a for a in group.findall("aff") if a.get("id") not in referenced]
        for c in group.findall("contrib"):
            if (c.get("contrib-type") or "author").lower() != "author":
                continue
            given, family, name = _person(c)
            if not name:
                continue
            aff_ids: list[str] = []
            corresponding = (c.get("corresp") or "").lower() == "yes"
            for x in _walk(c, _CONTRIB_SKIP):
                if _local(x.tag) != "xref":
                    continue
                ref_type = (x.get("ref-type") or "").lower()
                for rid in (x.get("rid") or "").split():
                    if rid in affs and ref_type in ("aff", ""):
                        aff_ids.append(rid)
                    if rid in corresp:
                        corresponding = True
                if ref_type == "corresp":
                    corresponding = True
            elements = [affs[i] for i in aff_ids] + c.findall("aff")
            elements = elements or group_loose or loose
            authors.append({
                "position": len(authors) + 1, "name": name, "given": given, "family": family,
                "orcid": _contrib_orcid(c), "corresponding": corresponding,
                "affiliations": _unique(_affiliation(a) for a in elements),
                "ror": _unique(r for a in elements for r in _aff_rors(a))})
    if authors and not any(a["corresponding"] for a in authors):
        # A note that names the author without pointing to them: "Correspondence to: Ada
        # Example, …" (28 of 3,529 cached texts). The full name must be written.
        notes = f" {_fold(' '.join(notes_text))} "
        for a in authors:
            full = _fold(f"{a['given']} {a['family']}")
            if a["given"] and a["family"] and full and f" {full} " in notes:
                a["corresponding"] = True
    return authors


def _fold(s: str) -> str:
    """A name without case, accents or punctuation, words kept apart: "Ocio−Moliner" and
    "Ocio-Moliner" are both "ocio moliner"."""
    s = "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))
    return " ".join(re.findall(r"[a-z]+", s.lower()))


def _person(c: ET.Element) -> tuple[str, str, str]:
    """(given names, family name, "Given Family") of a contributor; a consortium has only a name."""
    name = c.find("name")
    if name is None:
        names = c.findall("name-alternatives/name")
        name = next((n for n in names if (n.get("name-style") or "western") == "western"),
                    names[0] if names else None)
    if name is None:
        name = c.find("string-name")
    if name is not None:
        given, family = _text(name.find("given-names")), _text(name.find("surname"))
        suffix = _text(name.find("suffix"))
        full = " ".join(x for x in (given, family, suffix) if x) or _text(name)
        return given, family, full
    return "", "", _text(c.find("collab"), _SKIP | {"contrib-group", "xref", "fn"})


def _contrib_orcid(c: ET.Element) -> str:
    for x in c.findall("contrib-id"):
        value = _text(x) or x.get(XLINK_HREF, "")
        if (x.get("contrib-id-type") or "").lower() == "orcid" or "orcid.org" in value.lower():
            if _orcid(value):
                return _orcid(value)
    for x in c.findall("uri") + c.findall("ext-link"):
        value = x.get(XLINK_HREF) or _text(x)
        if "orcid.org" in value.lower() and _orcid(value):
            return _orcid(value)
    return ""


def _affiliation(aff: ET.Element) -> str:
    """The text of an <aff>: no label, no identifier, no address. Parts written without a
    separator (`<institution>…</institution><country>…</country>`) are split by a comma."""
    parts = [aff.text or ""]
    kids = list(aff)
    for i, c in enumerate(kids):
        name = _local(c.tag)
        marker = name == "sup" and i == 0 and not (aff.text or "").strip()
        if name not in _AFF_SKIP and not marker:
            parts.append(_text(c, _AFF_SKIP))
            if not c.tail and i + 1 < len(kids) and _local(kids[i + 1].tag) not in _AFF_SKIP:
                parts.append(", ")
        parts.append(c.tail or "")
    return _tidy_affiliation("".join(parts))


#: A telephone number in an affiliation ("Saudi Arabia; Tel.: +966-…", "UK, +44 114 …"): 27 of the
#: 37,719 affiliations of the cache. Contact data, not an address of the institution.
_PHONE = re.compile(r"(?i)[;,]?\s*\b(?:tel|telephone|phone|fax|mobile)\b\.?\s*[:.]?\s*\+?\d[\d\s()./-]{5,}\d"
                    r"|[;,]?\s*\+\d{1,3}[\s-]?\(?\d[\d\s()./-]{5,}\d")


def _tidy_affiliation(s: str) -> str:
    s = _PHONE.sub("", _no_email(_squash(s)))
    s = re.sub(r"\s+([,;.])", r"\1", s)
    s = re.sub(r"([,;])(?:\s*[,;])+", r"\1", s)
    s = re.sub(r"^\d{1,2}(?=[A-Z][a-z]{2})", "", s)   # a glued footnote number: "1Department"
    return s.strip(" \t,;.:*†‡§¶#")


def _aff_rors(aff: ET.Element) -> list[str]:
    out = []
    for x in aff.iter("institution-id"):
        value = _text(x)
        if (x.get("institution-id-type") or "").lower() == "ror" or "ror.org" in value:
            out.append(_ror(value))
    return [r for r in out if r]


# ─── J: funding ─────────────────────────────────────────────────────────────

#: The `institution-id` types that carry a Crossref Funder Registry id.
_FUNDREF_TYPES = frozenset({"doi", "fundref", "funder-id", "open-funder-registry", "crossref",
                            "crossref-funder-id"})


def _awards(text: str) -> list[str]:
    """Award numbers: "2018-CDA02, 2020-CDA04" is two awards."""
    return [a for a in (x.strip(" .;,") for x in re.split(r"[;,]\s+", text or "")) if a]


def _funder(source: ET.Element) -> dict:
    name = re.sub(r"(?i)^the\s+", "", _text(source, _SKIP | {"institution-id"})).strip(" .;,")
    ids = [("href", source.get(XLINK_HREF) or "")]
    ids += [((x.get("institution-id-type") or "").lower(), _text(x))
            for x in source.iter("institution-id")]
    funder_id = next((d for kind, value in ids
                      if (d := _funder_doi(value, bare_number=kind in _FUNDREF_TYPES))), "")
    if not funder_id:
        funder_id = next((r for kind, value in ids
                          if (kind == "ror" or "ror.org" in value) and (r := _ror(value))), "")
    return {"funder": name, "funder_id": funder_id, "awards": []}


def _jats_funding(meta: ET.Element, art: ET.Element) -> list[dict]:
    entries: list[dict] = []
    for fg in meta.findall("funding-group") + meta.findall("support-group/funding-group"):
        for ag in fg.findall("award-group"):
            awards = [a for x in ag.findall("award-id") for a in _awards(_text(x))]
            sources = ag.findall("funding-source")
            if not sources and awards:
                entries.append({"funder": "", "funder_id": "", "awards": awards})
            for s in sources:
                entry = _funder(s)
                entry["awards"] = list(awards)
                entries.append(entry)
    return _merge_funders(entries or _inline_funding(art))


def _inline_funding(art: ET.Element) -> list[dict]:
    """Funders tagged inside a paragraph of the text ("supported by <funding-source>…"), when
    the front matter has none: 2% of the cached texts. An `award-id` goes to the funder its
    `rid` names, else to the funder written before it."""
    entries: list[dict] = []
    for part in (art.find("body"), art.find("back")):
        if part is None:
            continue
        for p in _walk(part):
            if _local(p.tag) != "p":
                continue
            last, by_id = None, {}
            for x in p.iter():
                name = _local(x.tag)
                if name == "funding-source":
                    last = _funder(x)
                    entries.append(last)
                    if x.get("id"):
                        by_id[x.get("id")] = last
                elif name == "award-id" and last is not None:
                    target = by_id.get(x.get("rid") or "", last)
                    target["awards"] += _awards(_text(x))
    return entries


def _funder_key(name: str) -> str:
    return re.sub(r"\W+", "", re.sub(r"\([^)]*\)", "", name).casefold())


def _merge_funders(entries: list[dict]) -> list[dict]:
    """One entry per funder: same name (ignoring case, punctuation and an acronym in
    parentheses), or same funder id."""
    merged: list[dict] = []
    for e in entries:
        key = _funder_key(e["funder"])
        same = next((m for m in merged if _funder_key(m["funder"]) == key
                     or (e["funder_id"] and m["funder_id"] == e["funder_id"])), None)
        if same is None:
            merged.append({"funder": e["funder"], "funder_id": e["funder_id"],
                           "awards": _unique(e["awards"])})
        else:
            same["funder"] = same["funder"] or e["funder"]
            same["funder_id"] = same["funder_id"] or e["funder_id"]
            same["awards"] = _unique(same["awards"] + e["awards"])
    return [m for m in merged if m["funder"] or m["awards"]]


# ─── J: references, RRIDs ───────────────────────────────────────────────────

_DOI_IN_TEXT = re.compile(r"\b10\.\d{4,9}/[^\s\"<>]+")


def _references(art: ET.Element, meta: ET.Element | None) -> tuple[list[dict], int | None]:
    """The cited DOIs and PMIDs, from every <ref-list> of the paper wherever it sits, and the
    number of references (None without a list: the count declared in <counts>, if any)."""
    refs: list[dict] = []
    seen: set[tuple[str, str]] = set()
    count, has_list = 0, False
    for e in _walk(art):
        name = _local(e.tag)
        if name == "ref-list":
            has_list = True
        elif name == "ref":
            count += 1
            ids = _ref_ids(e)
            if any(ids) and ids not in seen:
                seen.add(ids)
                refs.append({"doi": ids[0], "pmid": ids[1]})
    if has_list:
        return refs, count
    declared = meta.find("counts/ref-count") if meta is not None else None
    value = (declared.get("count") or "") if declared is not None else ""
    return refs, int(value) if value.isdigit() else None


def _ref_ids(ref: ET.Element) -> tuple[str, str]:
    dois, pmids = [], []
    for x in ref.iter():
        name = _local(x.tag)
        if name in ("pub-id", "object-id"):
            kind = (x.get("pub-id-type") or "").lower()
            if kind == "doi":
                dois.append(_text(x))
            elif kind == "pmid":
                pmids.append(_text(x))
        elif name in ("ext-link", "uri"):
            # The flavour without <back> types its identifiers as links.
            kind = (x.get("ext-link-type") or "").lower()
            href = x.get(XLINK_HREF) or _text(x)
            if kind == "doi" or "doi.org/10." in href:
                dois.append(href)
            elif kind == "pmid" or "pubmed" in href:
                pmids.append(href)
    doi = next((d for d in map(_doi, dois) if d), "")
    if not doi:
        m = _DOI_IN_TEXT.search(" ".join(ref.itertext()))
        doi = _doi(m.group(0)) if m else ""
    return doi, next((p for p in map(_pmid, pmids) if p), "")


_RRID = re.compile(r"RRID:\s?([A-Za-z]+)_([A-Za-z0-9_:-]+)")


#: The column that names the resource in a key resources table: eLife's "Designation" (its
#: first column is the type: "Antibody", "Software, algorithm"), Cell Press's "Reagent or
#: resource".
_NAME_COLUMNS = (re.compile(r"designation", re.I),
                 re.compile(r"reagent or resource|^\s*(?:resource|name|item)\b", re.I))


def _rrids(art: ET.Element) -> list[dict]:
    """Every RRID of the paper, once, with the name written before it. In a table (the "key
    resources table"), the name is the cell of the row that names the resource."""
    found: dict[str, dict] = {}

    def add(m: re.Match[str], name: str) -> None:
        rest = re.split("RRID", m.group(2))[0].rstrip(":-_")
        if not rest:
            return
        rrid = f"RRID:{m.group(1)}_{rest}"
        item = found.setdefault(rrid.upper(), {"rrid": rrid, "kind": m.group(1), "name": ""})
        item["name"] = item["name"] or _clip(name)

    in_tables: set[int] = set()
    for table in _walk(art):
        if _local(table.tag) != "table":
            continue
        rows = [[c for c in tr if _local(c.tag) in ("td", "th")] for tr in table.iter("tr")]
        texts = [[_text(c) for c in row] for row in rows]
        in_tables.update(id(x) for x in table.iter())
        header = next((t for row, t in zip(rows, texts) if row and all(_local(c.tag) == "th" for c in row)), [])
        column = next((i for pattern in _NAME_COLUMNS for i, h in enumerate(header) if pattern.search(h)), 0)
        for cells in texts:
            for i, t in enumerate(cells):
                for m in _RRID.finditer(t):
                    name = cells[column] if i != column and column < len(cells) else _rrid_name(t[:m.start()])
                    add(m, name)
    for p in _walk(art):
        if _local(p.tag) == "p" and id(p) not in in_tables:
            t = _text(p)
            for m in _RRID.finditer(t):
                add(m, _rrid_name(t[:m.start()]))
    whole = " ".join(_text(c) for c in art if _local(c.tag) not in _NOT_THE_PAPER)
    for m in _RRID.finditer(whole):
        add(m, "")
    return list(found.values())


def _rrid_name(before: str) -> str:
    """What names the resource: the text before the RRID, before the parenthesis that holds it,
    after the previous clause and the previous comma ("SPM12 (RRID:…), FSL (RRID:…)" → FSL)."""
    depth = 0
    for i in range(len(before) - 1, -1, -1):
        if before[i] in ")]":
            depth += 1
        elif before[i] in "([":
            if depth == 0:
                before = before[:i]
                break
            depth -= 1
    s = re.split(r"RRID:\s?\S+|[.;:!?](?:\s|$)", before.rstrip(" ,;:(["))[-1]
    s = s.split(",")[-1].strip(" ,;:()[]")
    return re.sub(r"(?i)^(?:and|or|as well as|&)\s+", "", s)


def _clip(s: str, limit: int = 80) -> str:
    s = _squash(s)
    if len(s) > limit:
        s = s[-limit:]
        s = s.split(" ", 1)[1] if " " in s else s
    return s


# ─── J: availability statements ─────────────────────────────────────────────

_ST_SUBJECT = r"(?:data(?:sets?)?|date|codes?|software|scripts?|materials?|resources?|protocols?|reagents?)"
_ST_ACCESS = r"(?:availab\w*|accessib\w*|sharing|shared|deposit\w*)"
#: An availability title: "Data availability", "Availability of data and materials",
#: "Data, code, and materials availability", "Resource availability", "Data sharing
#: statement", "Availability and implementation"… but not "Bioavailability of honey
#: phenolics" nor "Chromatin accessibility".
_STATEMENT_TITLE = re.compile(
    rf"\b{_ST_SUBJECT}\b.{{0,60}}?\b{_ST_ACCESS}"
    rf"|\b{_ST_ACCESS}\s+(?:of|for)\s+(?:the\s+)?(?:\w+\s+)?{_ST_SUBJECT}\b"
    r"|^availability(?:\s+(?:statement|and\s+implementation))?$"
    r"|^open\s+(?:science|research|practices?)\s+statement", re.I)
_CODE_TITLE = re.compile(r"\bcodes?\b|\bsoftware\b|\bscripts?\b|\bimplementation\b", re.I)
_DATA_TITLE = re.compile(r"\bdat[ae]\b|\bdatasets?\b", re.I)
_CODE_TEXT = re.compile(r"\bcodes?\b|\bsoftware\b|\bscripts?\b|\bnotebooks?\b|\bgithub\b"
                        r"|\bgitlab\b|\bbitbucket\b", re.I)
_DATA_TEXT = re.compile(r"\bdata\b|\bdatasets?\b", re.I)
_STATEMENT_ELEMENTS = frozenset({"sec", "notes", "fn", "app", "boxed-text"})


def _statement_title(title: str) -> bool:
    """A section title that announces a statement. At most six words: a review's "Recommendation
    3: choose the architecture by data availability" is a chapter, not a statement."""
    t = re.sub(r"^\s*(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+", "", title).strip(" .:")
    return 0 < len(t.split()) <= 6 and bool(_STATEMENT_TITLE.search(t))


def _statement_kind(title: str, text: str) -> str:
    """code, data or code_and_data. The title decides, except that a "Data availability" often
    also gives the code; a neutral title ("Resource availability") leaves it to the text."""
    code, data = bool(_CODE_TITLE.search(title)), bool(_DATA_TITLE.search(title))
    if code or data:
        if code and data:
            return "code_and_data"
        if code:
            return "code"
        return "code_and_data" if _CODE_TEXT.search(text) else "data"
    code, data = bool(_CODE_TEXT.search(text)), bool(_DATA_TEXT.search(text))
    return "code_and_data" if code and data else "code" if code else "data" if data else ""


def _statements(art: ET.Element, meta: ET.Element | None) -> list[dict]:
    """The availability statements, wherever the publisher put them: PLOS's `custom-meta`, a
    `<notes>`, a `sec-type="data-availability"`, a titled section of `<back>` or of the last
    body sections, PMC's "Associated Data" copy (deduplicated). A statement made of
    statements ("Resource availability" > "Data and code availability") gives its parts."""
    candidates: list[tuple[str, str, ET.Element | None]] = []
    if meta is not None:
        for cm in meta.iter("custom-meta"):
            name = _text(cm.find("meta-name"))
            if re.search("availab", name, re.I):
                candidates.append((name, _text(cm.find("meta-value"), links=True), None))
    found: list[tuple[ET.Element, str]] = []
    for e in _walk(art, _NOT_THE_PAPER | {"trans-abstract"}):
        name = _local(e.tag)
        if name not in _STATEMENT_ELEMENTS:
            continue
        kind = e.get("sec-type") or e.get("notes-type") or e.get("fn-type") or ""
        title = _text(e.find("title")) if name != "fn" else ""
        if re.search("availab", kind, re.I) or _statement_title(title):
            found.append((e, title or kind.replace("-", " ").replace("_", " ").capitalize()))
    chosen = {id(e) for e, _ in found}
    for e, title in found:
        if any(id(d) in chosen for d in e.iter() if d is not e):
            continue             # keep the innermost statements
        text = "\n\n".join(_paragraphs(e, links=True)) or _text(e, _SKIP | {"title", "label"}, links=True)
        candidates.append((title, text, e))
    statements, seen = [], set()
    for title, text, _ in candidates:
        key = re.sub(r"\W+", " ", text.casefold()).strip()
        kind = _statement_kind(title, text)
        if key and kind and key not in seen:
            seen.add(key)
            statements.append({"kind": kind, "title": title, "text": text})
    return statements


# ─── E: the Europe PMC `core` record ────────────────────────────────────────

def _str(value: Any) -> str:
    return _squash(str(value)) if value is not None else ""


def _items(container: Any, key: str) -> list:
    """`{"author": [...]}` → the list, whatever Europe PMC wrapped around it."""
    value = container.get(key) if isinstance(container, dict) else None
    if isinstance(value, list):
        return value
    return [] if value in (None, "") else [value]


#: MEDLINE publication types → JATS article types, in order of precedence (a retraction notice
#: is also a "Journal Article").
_MEDLINE_TYPES: tuple[tuple[str, str], ...] = (
    ("retraction of publication", "retraction"),
    ("published erratum", "correction"),
    ("expression of concern", "expression-of-concern"),
    ("preprint", "preprint"),
    ("editorial", "editorial"),
    ("comment", "article-commentary"),
    ("letter", "letter"),
    ("case reports", "case-report"),
    ("systematic review", "systematic-review"),
    ("meta-analysis", "systematic-review"),
    ("review", "review-article"),
    ("congress", "meeting-report"),
    ("news", "news"),
    ("journal article", "research-article"),
)


def _epmc_type(types: list[str]) -> str:
    """The JATS article type that Europe PMC copies into `pubTypeList` for the papers of PMC
    ("research-article"), else the MEDLINE types mapped to it."""
    jats = [t for t in types if re.fullmatch(r"[a-z]+(?:-[a-z]+)*", t) and t != "other"]
    if jats:
        return jats[0]
    lower = {t.lower() for t in types}
    for medline, jats_type in _MEDLINE_TYPES:
        if medline in lower:
            return jats_type
    if any("trial" in t or "study" in t for t in lower):
        return "research-article"
    return "other" if types else ""


#: The markup of `abstractText`. A bare "<" also occurs in the text ("p<0.05").
_HTML_TAG = re.compile(r"</?(?:i|b|u|em|strong|sup|sub|sc|span|a|p|br|div|ul|ol|li|italic|bold)"
                       r"\b[^>]*>", re.I)


def _epmc_abstract(value: Any) -> str:
    s = str(value or "")
    s = re.sub(r"(?is)<h\d[^>]*>(.*?)</h\d>", lambda m: "\n\n" + m.group(1).strip() + "\x00", s)
    s = re.sub(r"(?i)<br\s*/?>|</?p\b[^>]*>", "\n\n", s)
    s = html.unescape(_HTML_TAG.sub("", s))
    out = []
    for block in re.split(r"\n\s*\n", s):
        if "\x00" in block:
            title, _, rest = block.partition("\x00")
            block = _headed(_squash(title), rest) if _squash(rest) and _squash(title) else rest
        block = _squash(block)
        if block:
            out.append(block)
    return "\n\n".join(out)


def _epmc_issue_date(info: dict) -> str:
    """The issue date. `printPublicationDate` is "2022-06-01" for "2022 Jun": its day is made
    up, so `dateOfPublication` is read first."""
    m = re.match(r"(\d{4})(?:\s+([A-Za-z]{3,9}))?(?:\s+(\d{1,2}))?", _str(info.get("dateOfPublication")))
    if m:
        return _iso(m.group(1), m.group(2) or "", m.group(3) or "")
    year, month = info.get("yearOfPublication"), info.get("monthOfPublication")
    if isinstance(year, int) and year > 0:
        return _iso(str(year), str(month) if isinstance(month, int) and month > 0 else "")
    printed = _iso_string(info.get("printPublicationDate"))
    return printed[:7] if printed.endswith("-01") else printed


def _epmc_dates(core: dict, info: dict) -> dict[str, str]:
    dates = {"epub": _iso_string(core.get("electronicPublicationDate")),
             "first_publication": _iso_string(core.get("firstPublicationDate"))}
    issue = _epmc_issue_date(info)
    if issue:
        # An electronic-only journal's issue is a collection, not a print issue.
        model = _str(core.get("pubModel")).lower()
        dates["collection" if model in ("electronic", "electronic-ecollection") else "ppub"] = issue
    return {k: v for k, v in dates.items() if v}


#: `commentCorrectionList` relations → (kind, direction). "in": a notice about this paper
#: exists; "of": this paper is the notice about another one.
_RELATIONS: dict[str, tuple[str, str]] = {
    "retraction in": ("retraction", "in"), "partial retraction in": ("retraction", "in"),
    "retracted and republished in": ("retraction", "in"),
    "erratum in": ("correction", "in"), "correction in": ("correction", "in"),
    "corrected and republished in": ("correction", "in"),
    "expression of concern in": ("concern", "in"), "comment in": ("comment", "in"),
    "retraction of": ("retraction", "of"), "partial retraction of": ("retraction", "of"),
    "erratum for": ("correction", "of"), "correction for": ("correction", "of"),
    "expression of concern for": ("concern", "of"), "comment on": ("comment", "of"),
}
#: The article types of a notice, and the kind of notice: a notice keeps the reverse relation
#: that says what it is about ("Retraction of"), and only that one.
_NOTICES = {"retraction": "retraction", "partial-retraction": "retraction",
            "retraction-notice": "retraction", "correction": "correction", "erratum": "correction",
            "corrigendum": "correction", "expression-of-concern": "concern"}


def _integrity(core: dict, paper_type: str) -> list[dict]:
    out, seen = [], set()
    for c in _items(core.get("commentCorrectionList"), "commentCorrection"):
        if not isinstance(c, dict):
            continue
        relation = _str(c.get("type"))
        kind, direction = _RELATIONS.get(relation.lower(), ("", ""))
        if not kind or (direction == "of" and _NOTICES.get(paper_type) != kind):
            continue
        m = re.search(r"\bdoi:\s*(10\.\S+)", _str(c.get("reference")), re.I)
        item = {"kind": kind, "id": _str(c.get("id")), "source": _str(c.get("source")),
                "relation": relation, "doi": _doi(m.group(1)) if m else ""}
        key = (kind, item["source"], item["id"], relation.lower())
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def from_epmc(core: dict) -> dict:
    """The record read from one element of `resultList.result` (`resultType=core`)."""
    record = empty()
    if not isinstance(core, dict):
        return record
    info = core.get("journalInfo") if isinstance(core.get("journalInfo"), dict) else {}
    journal = info.get("journal") if isinstance(info.get("journal"), dict) else {}
    book = core.get("bookOrReportDetails") if isinstance(core.get("bookOrReportDetails"), dict) else {}
    record["type"] = _epmc_type([_str(t) for t in _items(core.get("pubTypeList"), "pubType")])
    record["language"] = _language(core.get("language"))
    record["abstract"] = _epmc_abstract(core.get("abstractText"))
    record["volume"] = _str(info.get("volume"))
    record["issue"] = _str(info.get("issue"))
    record["pages"] = _str(core.get("pageInfo"))
    count = _str(core.get("citedByCount"))
    record["cited_by_count"] = int(count) if count.isdigit() else None
    record["is_open_access"] = {"Y": True, "N": False}.get(_str(core.get("isOpenAccess")).upper())
    record["license"] = _license_id(_str(core.get("license")))
    record["journal"].update({
        "title": _str(journal.get("title")), "issn": _issn(journal.get("issn")),
        "eissn": _issn(journal.get("essn")),
        "publisher": _str(book.get("publisher")),          # a preprint's server
        "nlm_ta": _str(journal.get("medlineAbbreviation"))})
    record["dates"].update(_epmc_dates(core, info))
    record["keywords"] = _keyword_list(_str(k) for k in _items(core.get("keywordList"), "keyword"))
    record["mesh"] = _epmc_mesh(core)
    record["authors"] = _epmc_authors(core)
    entries = []
    for g in _items(core.get("grantsList"), "grant"):
        if isinstance(g, dict) and (_str(g.get("agency")) or _str(g.get("grantId"))):
            entries.append({"funder": _str(g.get("agency")), "funder_id": "",
                            "awards": _awards(_str(g.get("grantId")))})
    record["funding"] = _merge_funders(entries)
    record["integrity"] = _integrity(core, record["type"])
    return _finish(record, EPMC)


def _epmc_mesh(core: dict) -> list[dict]:
    """MeSH headings. A heading is a major topic when its descriptor or one of its qualifiers
    is starred (PubMed's [MAJR])."""
    out = []
    for h in _items(core.get("meshHeadingList"), "meshHeading"):
        if not isinstance(h, dict) or not _str(h.get("descriptorName")):
            continue
        quals = [q for q in _items(h.get("meshQualifierList"), "meshQualifier") if isinstance(q, dict)]
        major = any(_str(x.get("majorTopic_YN")).upper() == "Y" for x in [h, *quals])
        out.append({"term": _str(h.get("descriptorName")), "major": major,
                    "qualifiers": [_str(q.get("qualifierName")) for q in quals
                                   if _str(q.get("qualifierName"))]})
    return out


def _epmc_authors(core: dict) -> list[dict]:
    authors = []
    for a in _items(core.get("authorList"), "author"):
        if not isinstance(a, dict):
            continue
        given, family = _str(a.get("firstName")), _str(a.get("lastName"))
        name = (" ".join(x for x in (given, family) if x) or _str(a.get("collectiveName"))
                or _str(a.get("fullName")))
        if not name:
            continue
        ids = a.get("authorId")
        orcid = next((_orcid(_str(i.get("value"))) for i in (ids if isinstance(ids, list) else [ids])
                      if isinstance(i, dict) and _str(i.get("type")).upper() == "ORCID"), "")
        affiliations = [_tidy_affiliation(_str(x.get("affiliation")))
                        for x in _items(a.get("authorAffiliationDetailsList"), "authorAffiliation")
                        if isinstance(x, dict)]
        authors.append({"position": len(authors) + 1, "name": name, "given": given,
                        "family": family, "orcid": orcid, "corresponding": False,
                        "affiliations": _unique(affiliations), "ror": []})
    return authors


# ─── merge ──────────────────────────────────────────────────────────────────

def merge(*records: dict) -> dict:
    """One record from several, field by field: the first non-empty value wins, and
    `provenance[field]` names its source. `journal` and `dates` merge key by key.

    One addition, measured on 309 papers read both ways (2026-09-26): the JATS gives an ORCID
    to 16% of the authors, Europe PMC to 43%. An author kept from one source without an ORCID
    takes the ORCID of the same author in another source (same family name and initial, at
    the same position or the only one of that name): 631 more ORCIDs, no conflict.
    `provenance["authors.orcid"]` then names that source."""
    out = empty()
    provenance: dict[str, str] = {}
    kept_from: dict[str, int] = {}
    for key in SCALARS + LISTS:
        for i, rec in enumerate(records):
            if not _is_empty(rec.get(key)):
                out[key] = copy.deepcopy(rec[key])
                kept_from[key] = i
                source = (rec.get("provenance") or {}).get(key)
                if source:
                    provenance[key] = source
                break
    for i, rec in enumerate(records):
        if "authors" in kept_from and i != kept_from["authors"] and rec.get("authors") \
                and _fill_orcids(out["authors"], rec["authors"]):
            source = (rec.get("provenance") or {}).get("authors")
            if source:
                provenance.setdefault("authors.orcid", source)
    for group, keys in (("journal", JOURNAL_KEYS), ("dates", DATE_KEYS)):
        for key in keys:
            for rec in records:
                value = (rec.get(group) or {}).get(key)
                if not _is_empty(value):
                    out[group][key] = value
                    source = (rec.get("provenance") or {}).get(f"{group}.{key}")
                    if source:
                        provenance[f"{group}.{key}"] = source
                    break
    out = _scrub(out)          # whatever the records were made of
    out["provenance"] = provenance
    return out


def _same_person(a: dict, b: dict) -> bool:
    if _fold(a.get("family", "")) != _fold(b.get("family", "")):
        return False
    ga, gb = _fold(a.get("given", "")), _fold(b.get("given", ""))
    return not ga or not gb or ga[0] == gb[0]


def _fill_orcids(authors: list[dict], other: list[dict]) -> bool:
    """Give the authors without an ORCID the ORCID of the same author in `other`. True if any."""
    used = {a["orcid"] for a in authors if a.get("orcid")}
    filled = False
    for i, a in enumerate(authors):
        family = _fold(a.get("family", ""))
        if a.get("orcid") or not family:
            continue
        match = other[i] if i < len(other) and _same_person(a, other[i]) else None
        if match is None:
            same = [o for o in other if _same_person(a, o)]
            mine = [x for x in authors if _fold(x.get("family", "")) == family]
            match = same[0] if len(same) == 1 and len(mine) == 1 else None
        orcid = (match or {}).get("orcid") or ""
        if orcid and orcid not in used:
            a["orcid"] = orcid
            used.add(orcid)
            filled = True
    return filled
