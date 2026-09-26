"""The JATS full text: every link of the paper, with the sentence and the section that carry it.

**Why the XML and not the search.** Measured 2026-09-25: the Europe PMC query
`github OR zenodo OR osf.io OR gitlab` returns 13.5% of EEG/MEG papers, while
33.3% carry such a link in their full text. The index under-reports by a factor
of 2.4. Papers "with code" are therefore not preselected: the XML of each one
is read (1.2 s and 145 KB per paper).

**Why CONTEXT matters more than the URL.** In `eeg-neurostream`, two GitHub
links: one is the authors' code, the other another lab's dataset. Nothing in
the URL tells them apart; the sentence and the section do. Each mention
therefore keeps:

- the SENTENCE that carries the link, split without cutting URLs;
- the path of section TITLES, from the widest to the nearest;
- the LOCATION: body, availability section, references, table, notes,
  supplementary material, acknowledgements;
- for a reference, the NAMES of the cited authors — cited software written by
  the paper's own authors is their own code.

Publishers put the availability statement in six different places: a titled
`<sec>` (Frontiers, Elsevier, eLife), a `sec-type` or a `notes-type` (Springer
Nature), a "Data Availability" `custom-meta` (PLOS), `<notes>` (MDPI), a row of
the key resources table (Cell Press STAR). All of them are read.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from . import links

XLINK = "{http://www.w3.org/1999/xlink}href"

#: An AVAILABILITY section title (what is shared, and where).
AVAILABILITY = re.compile(
    r"availab|accessib|\bsharing\b|\bdeposit|open (science|research|practices)"
    r"|reproducib|resource availability|data and (code|software|materials)"
    r"|code and data|supporting information|supplementary (material|information)",
    re.I)

#: A section title that speaks of CODE.
CODE_TITLE = re.compile(r"\bcodes?\b|\bsoftware\b|\bscripts?\b|\bimplementation\b"
                        r"|\bsource code\b|\bnotebooks?\b", re.I)

#: A Methods section: this is where the methods used are read.
METHODS_TITLE = re.compile(
    r"method|material|procedure|experimental (design|setup)|protocol|analys"
    r"|participants|recording|acquisition|preprocessing|statistic", re.I)

#: The `ext-link` types that are addresses (the others are accession numbers).
_LINK_TYPES = frozenset({"uri", "url", "ftp", "doi", "http", "https", "software", "data"})

#: Abbreviations that do not end a sentence.
_ABBREV = re.compile(r"(?:\be\.g|\bi\.e|\bet al|\bFigs?|\bEqs?|\bvs|\bcf|\bapprox"
                     r"|\bNo|\bRefs?|\bSuppl|\bSec|\bDr|\bProf|\bca|\bresp)\.$", re.I)


@dataclass
class Mention:
    """A link as the paper writes it, in its context."""

    url: str
    sentence: str
    sections: tuple[str, ...]
    location: str
    section_type: str = ""
    link_text: str = ""
    ref_authors: tuple[str, ...] = ()
    ref_year: str = ""

    @property
    def nearest_title(self) -> str:
        return self.sections[-1] if self.sections else ""


@dataclass
class Statement:
    """An availability statement (full text), with its title."""

    title: str
    text: str


@dataclass
class ArticleText:
    title: str = ""
    doi: str = ""
    pmcid: str = ""
    year: str = ""
    authors: list[str] = field(default_factory=list)       # surnames
    mentions: list[Mention] = field(default_factory=list)
    statements: list[Statement] = field(default_factory=list)
    methods: str = ""                                      # text of the Methods
    supplementary: list[tuple[str, str]] = field(default_factory=list)  # (file, caption)


def _text(e: ET.Element | None) -> str:
    if e is None:
        return ""
    return re.sub(r"\s+", " ", "".join(_pieces(e))).strip()


#: The elements that STICK to the previous word when read end to end: the
#: superscript reference call made "zenodo.15795242" + "93" read as
#: `zenodo.1579524293` (PMC12381021).
_DETACHED = frozenset({"xref", "sup", "sub"})


def _pieces(e: ET.Element):
    if e.text:
        yield e.text
    for child in e:
        detached = _name(child.tag) in _DETACHED
        if detached:
            yield " "
        yield from _pieces(child)
        if detached:
            yield " "
        if child.tail:
            yield child.tail


def _name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def parse(xml: str) -> ArticleText:
    """Parse a JATS paper. Never raises: a broken XML yields an empty paper."""
    root = _analyze(xml)
    art = ArticleText()
    if root is None:
        return art
    meta = root.find(".//front/article-meta")
    if meta is not None:
        art.title = _text(meta.find("title-group/article-title"))
        for aid in meta.findall("article-id"):
            t = aid.get("pub-id-type", "")
            if t == "doi":
                art.doi = _text(aid).lower()
            elif t in ("pmcid", "pmc"):
                v = _text(aid)
                art.pmcid = v if v.upper().startswith("PMC") else f"PMC{v}"
        for c in meta.findall(".//contrib-group/contrib"):
            if c.get("contrib-type", "author") != "author":
                continue
            s = _text(c.find(".//surname"))
            if s:
                art.authors.append(s)
        date = meta.find("pub-date/year")
        art.year = _text(date)
        for cm in meta.findall(".//custom-meta"):
            name = _text(cm.find("meta-name"))
            if re.search(r"availab", name, re.I):
                value = cm.find("meta-value")
                art.statements.append(Statement(name, _text(value)))
                # PLOS writes the statement as bare text in `meta-value`, without
                # a paragraph: read it as a paragraph (PMC12037073).
                if value is not None:
                    _paragraph(value, art, (name,), "availability", "custom-meta")
    body = root.find(".//body")
    back = root.find(".//back")
    meth: list[str] = []
    if body is not None:
        _walk(body, art, (), "body", "", meth)
    if back is not None:
        _walk(back, art, (), "back", "")
    art.methods = " ".join(meth) if meth else _text(body)
    return art


def _analyze(xml: str) -> ET.Element | None:
    try:
        return ET.fromstring(xml)
    except ET.ParseError:
        pass
    # An unknown named entity (&nbsp;) or a troublesome DOCTYPE: they are erased.
    cleaned = re.sub(r"<!DOCTYPE[^>]*>", "", xml)
    cleaned = re.sub(r"&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)\w+;", " ", cleaned)
    try:
        return ET.fromstring(cleaned)
    except ET.ParseError:
        return None


def _walk(e: ET.Element | None, art: ArticleText, sections: tuple[str, ...],
          location: str, sec_type: str, meth: list[str] | None = None) -> None:
    if e is None:
        return
    for child in list(e):
        name = _name(child.tag)
        if name in ("sec", "notes", "app", "boxed-text", "glossary"):
            title = _text(child.find("title"))
            child_type = child.get("sec-type", "") or child.get("notes-type", "")
            new_location = location
            if AVAILABILITY.search(title) or re.search(r"availab", child_type, re.I):
                new_location = "availability"
                art.statements.append(Statement(title or child_type, _text(child)))
            elif name == "notes" and location != "availability":
                new_location = "notes"
            elif name == "app":
                new_location = "appendix"
            elif re.search(r"acknowledg|funding", title, re.I):
                new_location = "acknowledgements"
            child_meth = meth
            if meth is not None and not sections and METHODS_TITLE.search(title + " " + child_type):
                meth.append(_text(child))
            _walk(child, art, sections + ((title,) if title else ()),
                  new_location, child_type or sec_type, child_meth)
        elif name == "ref-list":
            for ref in child.iter():
                if _name(ref.tag) == "ref":
                    _reference(ref, art, sections + ("References",))
        elif name == "table-wrap":
            title = _text(child.find(".//caption")) or _text(child.find("label"))
            for tr in child.iter():
                if _name(tr.tag) == "tr":
                    _paragraph(tr, art, sections + (title[:80],),
                               "availability" if location == "availability" else "table",
                               sec_type)
        elif name == "supplementary-material":
            file = child.get(XLINK, "")
            caption = _text(child.find("caption")) or _text(child.find("label"))
            media = child.find(".//media")
            if not file and media is not None:
                file = media.get(XLINK, "")
            art.supplementary.append((file, caption))
            _paragraph(child, art, sections, "supplementary", sec_type)
        elif name == "ack":
            _walk(child, art, sections + ("Acknowledgments",), "acknowledgements", "")
        elif name in ("p", "list-item", "fn", "def", "disp-quote", "attrib",
                      "caption", "statement"):
            _paragraph(child, art, sections, location, sec_type)
        elif name in ("title", "label"):
            continue
        else:
            _walk(child, art, sections, location, sec_type, meth)


def _reference(ref: ET.Element, art: ArticleText, sections: tuple[str, ...]) -> None:
    # An `element-citation` is a run of elements with no spaces between them:
    # read end to end, it gave "SchmidtF2022Data from: … Repository10.5061",
    # where no word has a boundary any more. Each element is kept apart.
    text = re.sub(r"\s+", " ", " ".join(ref.itertext())).strip()
    authors = tuple(_text(s) for s in ref.iter() if _name(s.tag) == "surname")
    year = next((_text(y) for y in ref.iter() if _name(y.tag) == "year"), "")
    seen: set[str] = set()
    for x in ref.iter():
        n = _name(x.tag)
        url = ""
        if n in ("ext-link", "uri"):
            url = x.get(XLINK, "") or _text(x)
        elif n == "pub-id" and x.get("pub-id-type") == "doi":
            url = _text(x)
        if url and url not in seen:
            seen.add(url)
            art.mentions.append(Mention(url, text[:600], sections, "references",
                                        "", _text(x), authors, year))
    for url in links.in_text(text):
        if not any(url in v or v in url for v in seen):
            seen.add(url)
            art.mentions.append(Mention(url, text[:600], sections, "references",
                                        "", "", authors, year))


def _paragraph(p: ET.Element, art: ArticleText, sections: tuple[str, ...],
               location: str, sec_type: str) -> None:
    text = _text(p)
    if not text:
        return
    # eLife cites its "generated" datasets with an `element-citation` INSIDE the
    # availability statement ("The following dataset was generated:"). It is a
    # signed reference, not a sentence: its authors tell whether the repository
    # is the paper's own (PMC9754634, Zenodo benchmark, 2026-09-25).
    citations = [x for x in p.iter() if _name(x.tag) in ("element-citation", "mixed-citation")]
    in_citation: set[int] = set()
    citation_texts: list[str] = []
    for c in citations:
        _reference(c, art, sections + ("Data citation",))
        in_citation.update(id(x) for x in c.iter())
        citation_texts.append(_text(c))
    if citations and len(text) - sum(map(len, citation_texts)) < 40:
        return
    anchors: list[tuple[str, str]] = []
    for x in p.iter():
        if id(x) in in_citation:
            continue
        if _name(x.tag) in ("ext-link", "uri", "self-uri", "inline-supplementary-material"):
            # An `ext-link` typed `gen`, `pdb`, `uniprot`… is an accession number
            # tagged by the publisher ("R81071" in an ethics committee number,
            # PMC12319822), not an address written by the author.
            if x.get("ext-link-type", "uri").lower() not in _LINK_TYPES:
                continue
            href = x.get(XLINK, "")
            shown = _text(x)
            if href or shown:
                anchors.append((href or shown, shown))
        elif _name(x.tag) == "pub-id" and x.get("pub-id-type") == "doi":
            anchors.append((_text(x), _text(x)))
    seen = {h for h, _ in anchors}
    for url in links.in_text(text):
        if any(url in ct for ct in citation_texts):
            continue
        if not any(url in h or h in url for h in seen if h):
            anchors.append((url, url))
            seen.add(url)
    for url, shown in anchors:
        art.mentions.append(Mention(url, sentence_around(text, shown or url),
                                    sections, location, sec_type, shown))


def sentence_around(text: str, anchor: str, margin: int = 400) -> str:
    """The sentence that contains `anchor`, split without cutting URLs."""
    i = text.find(anchor) if anchor else -1
    if i < 0:
        return text[:margin]
    # URLs are masked: their dots do not end sentences. But the punctuation that
    # follows the URL does: "(…dryad.np5hqc00n). All code…" (PMC12723408) — the
    # URL expression swallows it, so it is given back.
    def _mask(m: re.Match[str]) -> str:
        u = m.group(0)
        core = u.rstrip(links._TRAILING)
        return "x" * len(core) + u[len(core):]
    masked = links.URL_IN_TEXT.sub(_mask, text)
    start = 0
    for m in re.finditer(r"[.!?]\s+(?=[A-Z(\[])", masked[:i]):
        if not _ABBREV.search(masked[max(0, m.start() - 8):m.start() + 1]):
            start = m.end()
    end = len(text)
    for m in re.finditer(r"[.!?](\s+(?=[A-Z(\[])|$)", masked[i + len(anchor):]):
        j = i + len(anchor) + m.start()
        if not _ABBREV.search(masked[max(0, j - 8):j + 1]):
            end = j + 1
            break
    sentence = text[start:end].strip()
    if len(sentence.replace(anchor, "").strip(" ().;,[]")) < 25 and start > 0:
        # The link alone in parentheses after a full stop: "…are publicly
        # available. (link)." (PMC12381375). The sentence that carries it is the
        # previous one.
        before = masked[:start].rstrip()
        previous = 0
        for m in re.finditer(r"[.!?]\s+(?=[A-Z(\[])", before[:-1]):
            previous = m.end()
        sentence = text[previous:end].strip()
    if len(sentence) > 2 * margin:
        k = i - start
        sentence = sentence[max(0, k - margin):k + len(anchor) + margin]
    return sentence
