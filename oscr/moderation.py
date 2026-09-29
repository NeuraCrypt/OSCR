"""What moderation hid, for the Mac's public files (night phase 16; docs/MODERATION.md).

The Worker keeps the owner's decisions in D1 ``oscr_forge`` (``moderation``,
migrations/d1-forge/0010_moderation.sql) and drops what they hide from every answer it gives
(website/worker/forge/service/hidden.ts). Each night the Mac reads the same table, in key order, a
page at a time, and drops the same things from the static files it writes, so that signed-out readers
see what signed-in ones see:

- the forge layer (oscr/forgelayer.py): a hidden repository's entry says only that it is hidden, and
  why; its research issues, releases and packages are left out;
- the research issues' shards: a hidden issue, or one by a suspended account, is left out; a hidden
  comment, or one by a suspended account, keeps its place but not its words;
- the social layer and Explore (oscr/social.py): a suspended account's person entry, stars, follows and
  lists are left out (retroactively: the counts drop with them); a hidden profile's words are blank; a
  hidden list is left out; a hidden repository is not "alive";
- the search's index is made from those files (oscr/social.py ``search_docs``): it follows them.

It also writes ``forge/moderation.json`` into the public export: the public notices (what kind of
thing, why, when, the owner's redacted words, whether it was restored — never the hidden words, never
who reported), and the hidden repositories with their papers, so that a paper's page says in one line
that a repository linked to it is hidden (the tracing map stays explained). The site's build reads it
(website/scripts/data.mjs → src/data/moderation.json; the /notices/ page; the paper pages).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import catalog, community

PAGE = 1_000
EXPORT = Path("forge") / "moderation.json"

REASON_WORDS = {
    "spam": "spam or advertising",
    "abuse": "harassment, threats or abuse",
    "private_information": "private information about a person (doxxing)",
    "malware": "malware or a harmful file",
    "copyright": "a copyright or licence infringement",
    "impersonation": "impersonation of a person or an organisation",
    "misinformation": "deliberately false or misleading content",
    "unlawful": "unlawful content",
    "low_quality": "low quality or off-topic",
    "other": "another breach of the rules",
}
KIND_WORDS = {
    "account": "an account", "repo": "a repository", "research": "a research issue", "comment": "a comment on a research issue",
    "issue": "an issue", "pull": "a pull request", "release": "a release", "profile": "a profile's words", "list": "a star list",
    "status": "a commit status",
}


@dataclass
class Hidden:
    """What is hidden now, by the keys the files are built from."""
    accounts: set[str] = field(default_factory=set)
    github: set[str] = field(default_factory=set)
    repos: dict[str, dict[str, Any]] = field(default_factory=dict)     # "github:<id>" → its row
    research: set[int] = field(default_factory=set)
    comments: dict[tuple[int, int], str] = field(default_factory=dict)  # (issue, n) → the reason in words
    profiles: set[str] = field(default_factory=set)
    lists: set[tuple[str, int]] = field(default_factory=set)
    statuses: set[str] = field(default_factory=set)
    rows: list[dict[str, Any]] = field(default_factory=list)           # every row, hidden or restored

    def words(self, reason: str) -> str:
        return REASON_WORDS.get(reason, REASON_WORDS["other"])


def read(d1: community.D1 | None) -> Hidden:
    """Every row of ``moderation`` (none without ``d1``, or before its migration)."""
    h = Hidden()
    if d1 is None:
        return h
    after: tuple[str, str] | None = None
    while True:
        where = "" if after is None else (f"WHERE kind > {community.literal(after[0])} OR "
                                          f"(kind = {community.literal(after[0])} AND ref > {community.literal(after[1])})")
        try:
            page = d1.query(f"SELECT kind, ref, target, state, reason, notice, by_whom, appeal, appeal_kind, created_at, updated_at "
                            f"FROM moderation {where} ORDER BY kind, ref LIMIT {PAGE}")
        except (community.D1Error, Exception) as e:  # noqa: BLE001 — an older oscr_forge has no such table
            if "no such table" in str(e):
                return h
            raise
        h.rows += page
        if len(page) < PAGE:
            break
        after = (str(page[-1]["kind"]), str(page[-1]["ref"]))
    for r in h.rows:
        if r["state"] != "hidden":
            continue
        kind, key = r["kind"], str(r["ref"])
        if kind == "account":
            h.accounts.add(key)
        elif kind == "github":
            h.github.add(key)
        elif kind == "repo":
            h.repos[key] = r
        elif kind == "research" and key.isdigit():
            h.research.add(int(key))
        elif kind == "comment" and "#" in key:
            issue, n = key.split("#", 1)
            if issue.isdigit() and n.isdigit():
                h.comments[(int(issue), int(n))] = h.words(r["reason"])
        elif kind == "profile":
            h.profiles.add(key)
        elif kind == "list" and "/" in key:
            uid, n = key.rsplit("/", 1)
            if n.isdigit():
                h.lists.add((uid, int(n)))
        elif kind == "status":
            h.statuses.add(key)
    return h


def notices(h: Hidden) -> list[dict[str, Any]]:
    """The public notices, the newest first: what kind of thing, why, when, the owner's redacted words,
    whether it was restored. The GitHub account's row of a suspended account is its account's own."""
    out = []
    for r in sorted(h.rows, key=lambda x: (-int(x["updated_at"]), str(x["kind"]), str(x["ref"]))):
        if r["kind"] == "github" or r["kind"] not in KIND_WORDS:
            continue
        out.append({
            "date": time.strftime("%Y-%m-%d", time.gmtime(int(r["created_at"]))),
            "updated": time.strftime("%Y-%m-%d", time.gmtime(int(r["updated_at"]))),
            "what": KIND_WORDS[r["kind"]],
            "reason": h.words(r["reason"]),
            "notice": catalog.mask_emails(str(r["notice"] or ""))[:1000],
            "state": r["state"],
            "by": "the registry (known malware)" if r["by_whom"] == "registry" else "the owner",
            "counter_notice": r["appeal_kind"] == "counter_notice",
            "appeal": r["appeal"] or "",
        })
    return out


def write(h: Hidden, out: Path, repos: dict[str, dict[str, Any]], *, now: float | None = None) -> Path:
    """``out/forge/moderation.json``: the notices, and the hidden repositories ("owner/name" → why,
    since when, the DOIs of their papers)."""
    path = out / EXPORT
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"generated_at": int(time.time() if now is None else now), "notices": notices(h), "repos": repos}
    path.write_text(json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return path
