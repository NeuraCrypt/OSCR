"""The REVERSE search: repositories that cite the paper, without the paper citing them.

**Why.** An author often publishes the code AFTER the paper, or forgets to cite
it; but they write the DOI in the README so that the paper gets cited. Measured
2026-09-25: for eLife 10.7554/eLife.100605, the GitHub search "DOI in the
README" returns exactly the authors' two repositories; for MEG-SCANS, the
author's repository and two data mirrors. For papers of the week, nothing
yet — the README is not up to date. This path mostly serves OLDER papers.

**The trap.** A README that cites the DOI may be the authors', a
reimplementation by others, or a reading list ("awesome-…"). "Authors' code" is
only said if the ACCOUNT bears an author's name; otherwise the repository is
kept as "unknown", visible in the record, never counted.

**The rate.** The search API grants 10 requests/minute without a token, 30
with one. It is therefore only called by default if `GITHUB_TOKEN` exists
(GitHub Actions provides one), or on request (`--github-search`).

Hugging Face only covers arXiv papers: for them, the paper page
(`/api/papers/<id>`) sometimes names the GitHub repository.
"""
from __future__ import annotations

import re
import unicodedata

from ..jats import Mention
from ..net import Client

#: List repositories: they cite a hundred papers, none of them their own.
_LISTS = re.compile(r"awesome|reading|paper[-_ ]?list|papers$|survey|curated|collection"
                    r"|bibliograph|resources|literature|citations?", re.I)


def _flat(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower())
                   if c.isalnum() and not unicodedata.combining(c))


def author_account(account: str, authors: list[str]) -> str:
    """The author name the account bears ("schmidtfa" → "Schmidt"), or ''."""
    a = _flat(account)
    for author in authors:
        n = _flat(author)
        if len(n) >= 4 and n in a:
            return author
    return ""


def github_mentions(client: Client, doi: str, authors: list[str]) -> list[Mention]:
    if not doi:
        return []
    r = client.get("https://api.github.com/search/repositories",
                   params={"q": f'"{doi}" in:readme', "per_page": "20"}, ttl_s=7 * 86400)
    if not r.ok:
        return []
    mentions = []
    for d in (r.json() or {}).get("items", []):
        name, desc = d.get("full_name", ""), d.get("description") or ""
        if _LISTS.search(d.get("name", "")) or _LISTS.search(desc[:60]):
            continue
        author = author_account(d.get("owner", {}).get("login", ""), authors)
        sentence = (f"The README of {name} cites the paper's DOI"
                    + (f"; the account bears the name of author {author}" if author else ""))
        mentions.append(Mention(d.get("html_url", f"https://github.com/{name}"), sentence,
                                ("GitHub",), "metadata",
                                "github:readme" + (":own" if author else "")))
    return mentions


def arxiv_id(doi: str) -> str:
    m = re.match(r"10\.48550/arxiv\.(.+)$", doi or "", re.I)
    return m.group(1) if m else ""


def huggingface_mentions(client: Client, arxiv: str) -> list[Mention]:
    if not arxiv:
        return []
    r = client.get(f"https://huggingface.co/api/papers/{arxiv}", ttl_s=7 * 86400)
    if not r.ok:
        return []
    d = r.json() or {}
    repo = d.get("githubRepo") or ""
    if not repo:
        return []
    return [Mention(repo, f"The paper's Hugging Face page (arXiv {arxiv}) names this repository",
                    ("Hugging Face",), "metadata", "hf:paper:own")]
