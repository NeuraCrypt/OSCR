"""Finding a paper's code: gather the links, judge their role, one verdict per repository.

The same repository often comes back several times in a paper — in the
Methods, in the availability section, in the references. Each mention is
judged on its own (`role.judge`), then the verdicts for the same repository
are merged: the most convincing mention is kept, and the others are counted.

The result is a list of `Candidate`: a normalized repository, its role, its
confidence, where it was found, and the reasons for the verdict.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import jats, links, role

#: The extensions of a SCRIPT file attached as supplementary material.
SCRIPT_EXT = re.compile(r"\.(m|py|r|ipynb|jl|c|cpp|h|java|js|sh|rmd|mlx)$", re.I)
#: An attached archive is code only if its caption says so ("Source code 1").
ARCHIVE_EXT = re.compile(r"\.(zip|tar|gz|tgz|7z|rar)$", re.I)
# "function" is not one of them: "response function" appears in a thousand
# figure captions. Measured on the Zenodo benchmark (2026-09-25): .docx, .xlsx,
# .eps and .png files passed for code.
CODE_CAPTION = re.compile(r"\b(source )?codes?\b|\bscripts?\b|\bmatlab\b|\bpython\b"
                          r"|\bnotebooks?\b|\bsoftware\b|\btoolbox\b", re.I)

#: Order of preference between locations when two verdicts are equal.
_LOCATION_PRIORITY = {"availability": 0, "table": 1, "body": 2, "supplementary": 3,
                      "references": 4, "notes": 5, "appendix": 6, "back": 7, "acknowledgements": 8}


@dataclass
class Candidate:
    link: links.Link
    role: str
    confidence: str
    margin: float
    found_by: str                         # text:<location> | crossref | datacite | github …
    excerpt: str = ""                     # the sentence — internal use, never published
    section: str = ""
    reasons: list[str] = field(default_factory=list)
    scores: dict[str, float] = field(default_factory=dict)
    occurrences: int = 1


@dataclass
class Findings:
    """What the text of a paper says about its code."""

    candidates: list[Candidate] = field(default_factory=list)
    code_on_request: bool = False
    data_on_request: bool = False
    has_statement: bool = False
    statements: list[str] = field(default_factory=list)   # internal use


def _judge_all(mentions: list[jats.Mention], authors: list[str], title: str,
               origin: str, by_repo: dict[str, list[Candidate]]) -> None:
    for m in mentions:
        link = links.normalize(m.url)
        if link is None:
            continue
        if not _keep(link, m):
            continue
        v = role.judge(m, link, authors, title)
        found_by = f"{origin}:{m.location}" if origin == "text" else m.section_type.removesuffix(":own") or origin
        c = Candidate(link, v.role, v.confidence, v.margin, found_by,
                      m.sentence, m.nearest_title, v.reasons, v.scores)
        by_repo.setdefault(link.repo, []).append(c)


def _best(by_repo: dict[str, list[Candidate]]) -> list[Candidate]:
    out = []
    for cs in by_repo.values():
        cs.sort(key=lambda c: (c.role == "unknown", -max(c.scores.values(), default=0),
                               _LOCATION_PRIORITY.get(c.found_by.split(":")[-1], 9)))
        cs[0].occurrences = len(cs)
        out.append(cs[0])
    return out


def from_metadata(mentions: list[jats.Mention], authors: list[str],
                  title: str) -> list[Candidate]:
    """The repositories that Crossref and DataCite attach to the paper."""
    by_repo: dict[str, list[Candidate]] = {}
    _judge_all(mentions, authors, title, "metadata", by_repo)
    return _best(by_repo)


def merge(a: list[Candidate], b: list[Candidate]) -> list[Candidate]:
    """Merge two lists of candidates: the same repository keeps its best verdict.

    Except in one case: one path says "code", another "data" for the SAME
    archive. Both are true — the archive holds both —, and code is what we are
    after. For eLife 10.7554/elife.92344, the text says "the source code, are
    deposited in Dryad" and DataCite types the Dryad deposit "Dataset": the
    highest score (DataCite, 3.3 against 2.8) overrode the text, and the library
    lost the code (Zenodo benchmark, 2026-09-25).
    """
    by_repo: dict[str, list[Candidate]] = {}
    for c in a + b:
        by_repo.setdefault(c.link.repo, []).append(c)
    merged = []
    for cs in by_repo.values():
        total = sum(c.occurrences for c in cs)
        code = [c for c in cs if c.role == "code"]
        m = _best({"_": code or cs})[0]
        others = [c.found_by for c in cs if c.role == "data" and c is not m]
        if code and others:
            m.reasons = m.reasons + [f"the same archive is also declared 'data' ({others[0]})"]
        m.occurrences = total
        merged.append(m)
    return merged


def from_text(text: jats.ArticleText) -> Findings:
    """Every repository the paper cites, with its role."""
    by_repo: dict[str, list[Candidate]] = {}
    _judge_all(text.mentions, text.authors, text.title, "text", by_repo)

    for file, caption in text.supplementary:
        name = file.rsplit("/", 1)[-1]
        if not name:
            continue
        if SCRIPT_EXT.search(name) or (ARCHIVE_EXT.search(name) and CODE_CAPTION.search(caption)):
            ident = text.pmcid or text.doi
            link = links.Link(name, f"supp:{ident}/{name}", "supplementary",
                              "supplementary", identifier=name)
            m = jats.Mention(name, caption[:600], ("Supplementary material",),
                             "supplementary", link_text=name)
            v = role.judge(m, link, text.authors)
            by_repo.setdefault(link.repo, []).append(
                Candidate(link, v.role, v.confidence, v.margin, "text:supplementary",
                          caption[:600], "Supplementary material", v.reasons, v.scores))

    findings = Findings(candidates=_best(by_repo))

    for st in text.statements:
        findings.has_statement = True
        findings.statements.append(f"{st.title}: {st.text}"[:2000])
        for sentence in re.split(r"(?<=[.!?])\s+", st.text):
            if role.ON_REQUEST.search(sentence):
                if role.CODE_NOUNS.search(sentence):
                    findings.code_on_request = True
                if role.DATA_NOUNS.search(sentence):
                    findings.data_on_request = True
    return findings


def _keep(link: links.Link, m: jats.Mention) -> bool:
    """An `other` link (a lab website, a publisher page) is only kept if its
    sentence speaks of code: otherwise every Creative Commons license and every
    journal home page would be kept."""
    if link.kind != "other":
        return True
    if re.search(r"creativecommons|orcid\.org|ror\.org|clinicaltrials|doi\.org"
                 r"|crossref|pubmed|scholar\.google|elsevier|springer|wiley|frontiersin"
                 r"|mdpi|plos|nature\.com|sciencedirect|biorxiv|medrxiv|arxiv\.org|acs\.org|rsc\.org"
                 r"|tandfonline|sagepub|oup\.com|cell\.com|science\.org|pnas\.org|jneurosci\.org"
                 r"|elifesciences|ieee\.org|iop\.org|aps\.org|karger|thieme|jamanetwork|bmj\.com"
                 r"|cambridge\.org|annualreviews|physiology\.org|jstage", link.host):
        return False
    return bool(role.STRONG_CODE_NOUNS.search(m.sentence) and role.AVAILABILITY_VERBS.search(m.sentence))
