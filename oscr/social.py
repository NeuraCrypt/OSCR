"""The social layer's static files (night phase 08, E3; docs/SOCIAL.md).

The Worker writes the registry's own stars, follows, lists and profiles into D1 ``oscr_forge``
(migrations/d1-forge/0008_social.sql) and never counts them: no count row is ever written. Each
night the Mac reads those tables (in key order, a page at a time) and writes the static files a
signed-out reader's page reads, asking the Worker nothing:

- ``social/NN.json``, 64 shards (NN = the first byte of the key's SHA-256, mod 64), each an object
  keyed by
  - ``repo:<forge>:<id>``, ``paper:doi:10.…``, ``topic:<name>``: the stars and the watchers, and the
    handles of the stargazers whose profile is public (the newest 100);
  - ``person:<github login>`` and ``person:<ORCID iD>``: a person's public profile (their words,
    their handles, their pinned items, public lists, stars and follows; a private profile says only
    that it is private), their followers and following; a catalogue author followed by ORCID iD
    before they have an account has an entry with their followers only;
  - ``owner:<forge>:<login>``: an organization's followers;
- ``social/explore.json``: the Explore page — the repositories, papers and people most starred and
  followed in the last 7 days (trending), the topics (the curated ones, then the starred ones) with
  their aliases, and the collections (public star lists the owner accepted, ``oscr social
  collections``).

What never leaves: an account's id, a private list, a private profile's stars, lists and follows,
the threads a person follows, notification states, events (the inbox is the reader's own), an email
address (every text is masked again), a repository hidden, waiting for deletion or deleted.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from collections import Counter, defaultdict
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import catalog, community

SHARDS = 64
FOLDER = Path("social")
EXPLORE = "explore.json"
PAGE = 1_000
TRENDING_DAYS = 7
TRENDING_TOP = 25
STARGAZERS_SHOWN = 100
PERSON_STARS_SHOWN = 300
ALIVE = ("active", "archived")

# The curated topics of the Explore page (GitHub's "featured topics"): the owner edits this list.
FEATURED_TOPICS: dict[str, str] = {
    "eeg": "Electroencephalography: recording, preprocessing and analysis code.",
    "meg": "Magnetoencephalography.",
    "fmri": "Functional MRI: preprocessing, models and statistics.",
    "neuroimaging": "Brain imaging in general: MRI, PET, diffusion.",
    "electrophysiology": "Extracellular and intracellular recordings, spike sorting.",
    "spike-sorting": "Separating the spikes of single neurons.",
    "calcium-imaging": "Two-photon and one-photon calcium imaging pipelines.",
    "connectomics": "Structural and functional connectivity.",
    "computational-neuroscience": "Models of neurons, circuits and behaviour.",
    "brain-computer-interface": "Decoding brain signals in real time.",
    "reproducibility": "Code, environments and data that let results be run again.",
    "tracing-maps": "The registry's own: which lines of code implement which sentence of a paper.",
}
# A topic's other names: a star of an alias counts for the topic.
TOPIC_ALIASES: dict[str, str] = {
    "electroencephalography": "eeg",
    "magnetoencephalography": "meg",
    "functional-mri": "fmri",
    "bci": "brain-computer-interface",
    "ephys": "electrophysiology",
    "comp-neuro": "computational-neuroscience",
}

_TOPIC = re.compile(r"^[a-z0-9][a-z0-9-]{0,49}$")
_LOGIN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38})$")
_ORCID = re.compile(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")
_HTTPS = re.compile(r"^https://[^\s@/]+\.[^\s@/]+(?:/[^\s@]*)?$")


class SocialError(RuntimeError):
    pass


def shard(key: str) -> str:
    """The shard of a key: the first byte of its SHA-256, mod 64, two digits (the website's
    ``socialShard``, src/lib/social.ts)."""
    return f"{hashlib.sha256(key.encode()).digest()[0] % SHARDS:02d}"


def rows(d1: community.D1, table: str, columns: str, keys: tuple[str, ...], where: str = "") -> list[dict[str, Any]]:
    """Every row of ``table`` in key order, a page at a time (text keys; never more than a page in
    memory from D1 at once)."""
    out: list[dict[str, Any]] = []
    after: tuple[Any, ...] | None = None
    while True:
        cond = []
        if after is not None:
            ranges = [" AND ".join([*(f"{k} = {community.literal(after[j])}" for j, k in enumerate(keys[:i])),
                                    f"{keys[i]} > {community.literal(after[i])}"]) for i in range(len(keys))]
            cond.append("(" + " OR ".join(f"({r})" for r in ranges) + ")")
        if where:
            cond.append(f"({where})")
        sql = f"SELECT {columns} FROM {table}" + (f" WHERE {' AND '.join(cond)}" if cond else "") + \
              f" ORDER BY {', '.join(keys)} LIMIT {PAGE}"
        page = d1.query(sql)
        out += page
        if len(page) < PAGE:
            return out
        after = tuple(page[-1][k] for k in keys)


def _json(text: Any, empty: Any) -> Any:
    try:
        value = json.loads(text) if isinstance(text, str) else empty
    except ValueError:
        return empty
    return value if isinstance(value, type(empty)) else empty


def _text(value: Any, n: int) -> str:
    return catalog.mask_emails(str(value or ""))[:n]


def handles(people: community.D1) -> tuple[dict[str, dict[str, str | None]], dict[str, str]]:
    """Each account's public handles (its GitHub login, its ORCID iD), and the accounts by the
    targets that name them ("github:<numeric id>", "orcid:<iD>"), from oscr_community."""
    users = {r["id"]: {"github": (r["github_login"] or "").lower() or None, "orcid": r["orcid"] or None}
             for r in rows(people, "users", "id, github_login, orcid", ("id",))}
    by_target: dict[str, str] = {}
    for r in rows(people, "identities", "provider, subject, user_id", ("provider", "subject"), "provider IN ('github', 'orcid')"):
        if r["user_id"] in users:
            by_target[f"{r['provider']}:{r['subject']}"] = r["user_id"]
    for uid, h in users.items():
        if h["orcid"]:
            by_target.setdefault(f"orcid:{h['orcid']}", uid)
    return users, by_target


def _profile(p: dict[str, Any] | None, now: float) -> dict[str, Any]:
    if not p:
        return {"name": "", "bio": "", "pronouns": "", "location": "", "website": "", "links": [], "company": "",
                "pinned": [], "status": "", "busy": False, "readme": True, "timezone": ""}
    live = not p.get("status_until") or p["status_until"] > now
    return {
        "name": _text(p["name"], 100).replace("@", " "),
        "bio": _text(p["bio"], 300),
        "pronouns": _text(p["pronouns"], 40),
        "location": _text(p["location"], 100),
        "timezone": _text(p["timezone"], 64),
        "website": p["website"] if _HTTPS.match(p["website"] or "") else "",
        "links": [u for u in _json(p["links"], [])[:4] if isinstance(u, str) and _HTTPS.match(u)],
        "company": _text(p["company"], 100),
        "pinned": [x for x in _json(p["pinned"], [])[:6] if isinstance(x, str)],
        "status": _text(p["status"], 80) if live else "",
        "busy": bool(live and p["busy"]),
        "readme": bool(p["readme"]),
    }


def build(forge: community.D1, people: community.D1, *, names: dict[str, str] | None = None,
          now: float | None = None) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """The shards' entries by key, and the Explore page's data."""
    now = time.time() if now is None else now
    names = names or {}
    users, by_target = handles(people)
    repos = {f"repo:{r['forge']}:{r['repo_id']}": r for r in rows(forge, "repos", "forge, repo_id, owner_login, name, state",
                                                                    ("forge", "repo_id"))}
    alive = {k: f"{r['owner_login']}/{r['name']}" for k, r in repos.items() if r["state"] in ALIVE and r["name"]}
    stars = rows(forge, "stars", "user_id, subject, at", ("user_id", "subject"))
    follows = rows(forge, "follows", "user_id, target, level, at", ("user_id", "target"),
                   "substr(target, 1, 7) != 'thread:' AND level != 'ignore'")
    lists = rows(forge, "star_lists", "user_id, list_id, name, description, public, collection, at", ("user_id", "list_id"))
    items = rows(forge, "star_list_items", "user_id, subject, list_id, at", ("user_id", "subject", "list_id"))
    profiles = {r["user_id"]: r for r in rows(forge, "profiles", "*", ("user_id",))}

    def handle(uid: str) -> str | None:
        h = users.get(uid) or {}
        login, orcid = h.get("github"), h.get("orcid")
        return login if login and _LOGIN.match(login) else orcid if orcid and _ORCID.match(orcid) else None

    def public(uid: str) -> bool:
        p = profiles.get(uid)
        return handle(uid) is not None and not (p and p["private"])

    def shown(subject: str) -> bool:
        """A subject the public files may name: a repository alive in the registry, a paper, a topic."""
        if subject.startswith("repo:"):
            return subject in alive
        if subject.startswith("topic:"):
            return bool(_TOPIC.match(subject[6:]))
        return subject.startswith("paper:doi:10.")

    entries: dict[str, dict[str, Any]] = {}
    subject_entry = lambda k: entries.setdefault(k, {"stars": 0, "watchers": 0, "stargazers": []})  # noqa: E731
    for s in sorted(stars, key=lambda x: -x["at"]):
        if not shown(s["subject"]) or s["user_id"] not in users:
            continue
        e = subject_entry(s["subject"])
        e["stars"] += 1
        h = handle(s["user_id"])
        if public(s["user_id"]) and h and len(e["stargazers"]) < STARGAZERS_SHOWN:
            e["stargazers"].append(h)
    followers: Counter[str] = Counter()
    following: Counter[str] = Counter()
    for f in follows:
        t = f["target"]
        if t.startswith(("repo:", "paper:")):
            if shown(t):
                subject_entry(t)["watchers"] += 1
        elif t.startswith(("github:", "orcid:")):
            uid = by_target.get(t)
            key = f"person:{handle(uid)}" if uid and handle(uid) else (f"person:{t[6:]}" if t.startswith("orcid:") else None)
            if key:
                followers[key] += 1
            following[f["user_id"]] += 1
        elif t.startswith("owner:"):
            followers[t] += 1
    for key, n in followers.items():
        if key.startswith("owner:"):
            entries.setdefault(key, {})["followers"] = n
    # People: every account with a handle and anything public, and every author followed by ORCID iD.
    mine_lists: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for li in lists:
        mine_lists[li["user_id"]].append(li)
    mine_items: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for it in items:
        mine_items[(it["user_id"], it["list_id"])].append(it)
    mine_stars: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for s in stars:
        mine_stars[s["user_id"]].append(s)
    mine_follows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in follows:
        mine_follows[f["user_id"]].append(f)
    active = set(profiles) | set(mine_stars) | set(mine_follows) | set(mine_lists)
    for uid in sorted(active):
        h = handle(uid)
        if not h:
            continue
        key = f"person:{h}"
        p = profiles.get(uid)
        entry: dict[str, Any] = {"handles": {"github": users[uid]["github"], "orcid": users[uid]["orcid"]},
                                 "followers": followers.get(key, 0) + (followers.get(f"person:{users[uid]['orcid']}", 0)
                                                                       if users[uid]["orcid"] and users[uid]["orcid"] != h else 0)}
        if p and p["private"]:
            entry["private"] = True
        else:
            entry["profile"] = _profile(p, now)
            entry["following"] = following.get(uid, 0)
            entry["stars"] = [s["subject"] for s in sorted(mine_stars[uid], key=lambda x: -x["at"]) if shown(s["subject"])][:PERSON_STARS_SHOWN]
            entry["lists"] = [{"id": li["list_id"], "name": _text(li["name"], 32), "description": _text(li["description"], 160),
                               "items": [i["subject"] for i in sorted(mine_items[(uid, li["list_id"])], key=lambda x: -x["at"]) if shown(i["subject"])]}
                              for li in sorted(mine_lists[uid], key=lambda x: x["list_id"]) if li["public"]]
            entry["follows"] = sorted({f["target"] for f in mine_follows[uid]
                                       if f["target"].startswith(("orcid:", "owner:", "paper:", "journal:", "tool:", "dataset:", "category:"))
                                       or (f["target"].startswith("repo:") and f["target"] in alive)}
                                      | {f"person:{handle(by_target[f['target']])}" for f in mine_follows[uid]
                                         if f["target"].startswith("github:") and by_target.get(f["target"]) and handle(by_target[f["target"]])})
        entries[key] = entry
        orcid = users[uid]["orcid"]
        if orcid and orcid != h:
            entries[f"person:{orcid}"] = {"see": key}
    for key, n in followers.items():
        if key.startswith("person:") and key not in entries:
            entries[key] = {"followers": n, "account": False}
    # The registry's names, for the pages (never a person's label).
    for key, e in entries.items():
        if key in alive:
            e["name"] = alive[key]
        elif key in names:
            e["name"] = names[key][:300]
    def person(target: str) -> str | None:
        uid = by_target.get(target)
        return handle(uid) if uid and public(uid) else None

    return entries, explore(stars, follows, lists, items, alive, names, handle, public, shown, person, now)


def explore(stars: list[dict[str, Any]], follows: list[dict[str, Any]], lists: list[dict[str, Any]],
            items: list[dict[str, Any]], alive: dict[str, str], names: dict[str, str],
            handle: Callable[[str], str | None], public: Callable[[str], bool], shown: Callable[[str], bool],
            person: Callable[[str], str | None], now: float) -> dict[str, Any]:
    since = now - TRENDING_DAYS * 86_400
    week: Counter[str] = Counter(s["subject"] for s in stars if s["at"] > since and shown(s["subject"]))
    total: Counter[str] = Counter(s["subject"] for s in stars if shown(s["subject"]))
    trending_repos = [{"subject": k, "name": alive[k], "stars": total[k], "week": n}
                      for k, n in sorted(week.items(), key=lambda x: (-x[1], x[0])) if k.startswith("repo:")][:TRENDING_TOP]
    trending_papers = [{"subject": k, "doi": k[10:], "title": names.get(k, ""), "stars": total[k], "week": n}
                       for k, n in sorted(week.items(), key=lambda x: (-x[1], x[0])) if k.startswith("paper:")][:TRENDING_TOP]
    # People: followed in the week, named by their handle only when their account's profile is public.
    people_week: Counter[str] = Counter()
    for f in follows:
        if f["at"] > since and f["target"].startswith(("github:", "orcid:")):
            h = person(f["target"])
            if h:
                people_week[h] += 1
    trending_people = [{"handle": h, "week": n} for h, n in sorted(people_week.items(), key=lambda x: (-x[1], x[0]))][:TRENDING_TOP]
    topics: Counter[str] = Counter()
    for s in stars:
        if s["subject"].startswith("topic:"):
            name = s["subject"][6:]
            topics[TOPIC_ALIASES.get(name, name)] += 1
    topic_list = [{"name": t, "description": d, "featured": True, "stars": topics.get(t, 0),
                   "aliases": sorted(a for a, v in TOPIC_ALIASES.items() if v == t)} for t, d in FEATURED_TOPICS.items()]
    topic_list += [{"name": t, "description": "", "featured": False, "stars": n, "aliases": []}
                   for t, n in sorted(topics.items(), key=lambda x: (-x[1], x[0])) if t not in FEATURED_TOPICS][:100]
    by_list: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for it in items:
        by_list[(it["user_id"], it["list_id"])].append(it)
    collections = []
    for li in sorted(lists, key=lambda x: (-x["at"], x["list_id"])):
        if li["collection"] != "accepted" or not li["public"] or not public(li["user_id"]):
            continue
        entries = [i["subject"] for i in sorted(by_list[(li["user_id"], li["list_id"])], key=lambda x: -x["at"]) if shown(i["subject"])]
        collections.append({"name": _text(li["name"], 32), "description": _text(li["description"], 160), "by": handle(li["user_id"]),
                            "items": [{"subject": s, "name": alive.get(s) or names.get(s, "") or s.split(":", 2)[-1]} for s in entries]})
    return {"generated_at": int(now), "days": TRENDING_DAYS, "repositories": trending_repos, "papers": trending_papers,
            "people": trending_people, "topics": topic_list, "collections": collections}


def paper_names(con: sqlite3.Connection) -> dict[str, str]:
    """The catalogue's titles of papers with a page, by subject ("paper:doi:10.…")."""
    from . import entities
    return {f"paper:doi:{r['doi'].lower()}": (r["title"] or "")[:300]
            for r in con.execute(f"SELECT doi, title FROM article WHERE doi IS NOT NULL AND doi != '' AND id IN ({entities.PAGES_SQL})")}


def shards(entries: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {f"{n:02d}": {} for n in range(SHARDS)}
    for key in sorted(entries):
        out[shard(key)][key] = entries[key]
    return out


def write(forge: community.D1 | None, people: community.D1 | None, out: Path, *, con: sqlite3.Connection | None = None,
          now: float | None = None) -> str:
    """The nightly hook: the 64 shards and the Explore page under ``out/social/``. Without the
    databases (the owner's steps not done), empty files, so that the pages say "nothing yet"."""
    folder = out / FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    if forge is None or people is None:
        entries, data = {}, {"generated_at": int(time.time() if now is None else now), "days": TRENDING_DAYS,
                             "repositories": [], "papers": [], "people": [], "topics": [], "collections": []}
    else:
        try:
            entries, data = build(forge, people, names=paper_names(con) if con is not None else None, now=now)
        except community.D1Error as e:
            raise SocialError(f"the social tables could not be read: {e}") from None
    for n, content in shards(entries).items():
        tmp = folder / f"{n}.json.tmp"
        tmp.write_text(json.dumps(content, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
        tmp.replace(folder / f"{n}.json")
    tmp = folder / f"{EXPLORE}.tmp"
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(folder / EXPLORE)
    people_n = sum(1 for k in entries if k.startswith("person:") and "see" not in entries[k])
    return (f"{len(entries)} entries in {SHARDS} shards ({people_n} people); explore: {len(data['repositories'])} trending "
            f"repositories, {len(data['papers'])} papers, {len(data['topics'])} topics, {len(data['collections'])} collections → {folder}")


# ---------------------------------------------------------------------------------------
# The GitHub side's search (night phase 08, E4): forge_fts in oscr_search, from the PUBLIC files.

SEARCH_STATE = """
CREATE TABLE IF NOT EXISTS social_search (
    key    TEXT PRIMARY KEY,
    rowid  INTEGER NOT NULL UNIQUE,
    hash   TEXT NOT NULL
);
"""
#: Changes pushed in one run (a DELETE and an INSERT each): the rest goes the next night.
MAX_SEARCH_CHANGES = 2_000
SEARCH_CHUNK = 100


def _words(*parts: Any) -> str:
    return " ".join(str(p) for p in parts if p).replace("\n", " ")[:4000]


def _load(folder: Path) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in sorted(folder.glob("[0-9][0-9].json")) if folder.is_dir() else []:
        try:
            content = json.loads(f.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if isinstance(content, dict):
            out.update(content)
    return out


def search_docs(out: Path) -> dict[str, dict[str, Any]]:
    """The search's documents, by key, from the night's public files only (the forge layer, the
    research issues, the social layer, the Explore page): what the static site already shows."""
    docs: dict[str, dict[str, Any]] = {}
    social_entries = _load(out / FOLDER)
    for path, e in _load(out / "forge" / "layer").items():
        if not isinstance(e, dict) or e.get("state") in ("hidden", "pending_deletion", "deleted") or "/" not in path:
            continue
        owner, name = path.split("/", 1)
        key = f"repo:{e.get('forge') or 'github'}:{e['id']}" if e.get("id") else f"repo-path:{path}"
        papers = [p for p in e.get("papers") or [] if isinstance(p, dict)][:10]
        stars = (social_entries.get(key) or {}).get("stars", 0) if isinstance(social_entries.get(key), dict) else 0
        docs[key] = {
            "title": _words(owner, name, path),
            "text": _words(*(p.get("title") for p in papers)),
            "ids": _words(path, owner, name, *(p.get("doi") for p in papers)),
            "kind": "zzkall zzkrepository",
            "fx": {"k": "repository", "path": path, "url": f"/r/{path}/", "mode": e.get("mode"), "stars": stars,
                   "papers": [{"doi": p.get("doi"), "title": _text(p.get("title"), 200)} for p in papers[:3]]},
        }
    for n, e in _load(out / "forge" / "research").items():
        issue = e.get("issue") if isinstance(e, dict) else None
        if not isinstance(issue, dict):
            continue
        repo = (issue.get("repo") or {}).get("path") if isinstance(issue.get("repo"), dict) else None
        doi = str(issue.get("paper") or "").removeprefix("doi:")
        docs[f"research:{n}"] = {
            "title": _words(issue.get("title")),
            "text": _words(_text(issue.get("body"), 2000), *(issue.get("labels") or [])),
            "ids": _words(f"research {n}", doi, repo),
            "kind": f"zzkall zzkissue zzs{issue.get('state')} zzt{str(issue.get('type') or '').replace('_', '')}",
            "fx": {"k": "issue", "n": int(n), "title": _text(issue.get("title"), 200), "url": f"/research/{n}", "state": issue.get("state"),
                   "type": issue.get("type"), "paper": doi, "repo": repo, "comments": issue.get("comments", 0)},
        }
    for key, e in social_entries.items():
        if not key.startswith("person:") or not isinstance(e, dict) or "profile" not in e:
            continue
        handle = key[7:]
        prof = e["profile"]
        hs = e.get("handles") or {}
        docs[key] = {
            "title": _words(prof.get("name"), handle),
            "text": _words(prof.get("bio"), prof.get("company"), prof.get("location")),
            "ids": _words(handle, hs.get("github"), hs.get("orcid")),
            "kind": "zzkall zzkperson",
            "fx": {"k": "person", "handle": handle, "name": _text(prof.get("name"), 100), "bio": _text(prof.get("bio"), 160),
                   "url": f"/u/{handle}/", "followers": e.get("followers", 0)},
        }
    try:
        explore_data = json.loads((out / FOLDER / EXPLORE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        explore_data = {}
    for t in explore_data.get("topics") or []:
        if not isinstance(t, dict) or not _TOPIC.match(str(t.get("name") or "")):
            continue
        docs[f"topic:{t['name']}"] = {
            "title": _words(t["name"], t["name"].replace("-", " "), *(t.get("aliases") or [])),
            "text": _words(t.get("description")),
            "ids": _words(t["name"]),
            "kind": "zzkall zzktopic",
            "fx": {"k": "topic", "name": t["name"], "description": _text(t.get("description"), 200), "stars": t.get("stars", 0),
                   "featured": bool(t.get("featured")), "url": f"/explore/?topic={t['name']}"},
        }
    return docs


def push_search(search: community.D1, docs: dict[str, dict[str, Any]], state: sqlite3.Connection, *,
                limit: int = MAX_SEARCH_CHANGES) -> str:
    """The documents that changed since the last push, into forge_fts: a DELETE and an INSERT each (a
    removed one, its DELETE), in parts of SEARCH_CHUNK statements, each recorded once accepted; at
    most ``limit`` changes a run."""
    state.executescript(SEARCH_STATE)
    known = {r[0]: (r[1], r[2]) for r in state.execute("SELECT key, rowid, hash FROM social_search")}
    next_id = (state.execute("SELECT coalesce(max(rowid), 0) FROM social_search").fetchone()[0] or 0) + 1
    changes: list[tuple[str, int, str | None, list[str]]] = []
    for key in sorted(docs):
        d = docs[key]
        h = hashlib.sha256(json.dumps(d, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        had = known.get(key)
        if had and had[1] == h:
            continue
        rowid = had[0] if had else next_id
        if not had:
            next_id += 1
        values = ", ".join(community.literal(v) for v in (rowid, d["title"], d["text"], d["ids"], d["kind"],
                                                             json.dumps(d["fx"], ensure_ascii=False, separators=(",", ":"))))
        sql = ([f"DELETE FROM forge_fts WHERE rowid = {rowid}"] if had else []) + \
              [f"INSERT INTO forge_fts (rowid, title, text, ids, kind, fx) VALUES ({values})"]
        changes.append((key, rowid, h, sql))
    for key, (rowid, _) in sorted(known.items()):
        if key not in docs:
            changes.append((key, rowid, None, [f"DELETE FROM forge_fts WHERE rowid = {rowid}"]))
    todo, later = changes[:limit], max(0, len(changes) - limit)
    applied = 0
    part: list[tuple[str, int, str | None, list[str]]] = []

    def flush() -> None:
        nonlocal applied
        if not part:
            return
        search.run([s for c in part for s in c[3]])
        for key, rowid, h, _ in part:
            if h is None:
                state.execute("DELETE FROM social_search WHERE key = ?", (key,))
            else:
                state.execute("INSERT INTO social_search (key, rowid, hash) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET hash = excluded.hash",
                              (key, rowid, h))
        state.commit()
        applied += len(part)
        part.clear()

    for c in todo:
        part.append(c)
        if sum(len(x[3]) for x in part) >= SEARCH_CHUNK:
            flush()
    flush()
    return f"search: {len(docs)} documents, {applied} changes pushed" + (f", {later} wait for the next run" if later else "")


# ---------------------------------------------------------------------------------------
# Collections: the owner's decision on the public lists proposed as collections.

def proposed(forge: community.D1) -> list[dict[str, Any]]:
    return rows(forge, "star_lists", "user_id, list_id, name, description, public, collection, at", ("user_id", "list_id"),
                "collection = 'proposed'")


def decide(forge: community.D1, people: community.D1, handle: str, list_id: int, accept: bool) -> str:
    """Accept or decline a proposed collection (1 row in oscr_forge, from the facts push's budget)."""
    users, _ = handles(people)
    uid = next((u for u, h in users.items() if handle.lower() in (h["github"], (h["orcid"] or "").lower())), None)
    if uid is None:
        raise SocialError(f"no account has the handle {handle!r}")
    decision = "accepted" if accept else "declined"
    n = forge.run([f"UPDATE star_lists SET collection = {community.literal(decision)} WHERE user_id = {community.literal(uid)} "
                   f"AND list_id = {int(list_id)} AND public = 1 AND collection IN ('proposed', 'accepted', 'declined')"])
    if not n:
        raise SocialError(f"{handle}'s list {list_id} is not a public list proposed as a collection")
    return f"{handle}'s list {list_id}: {decision}"


def command(con: sqlite3.Connection, action: str, *, target: str | None, out: Path, settings: dict[str, str] | None = None,
            persist_to: Path | None = None, handle: str = "", list_id: int = 0, now: float | None = None) -> str:
    """``oscr social layer|search|collections|accept|decline``: its answer in words."""
    if target not in ("local", "remote"):
        raise SystemExit("social: add --local (the local D1 of `wrangler dev`) or --remote (the Cloudflare databases)")
    if action == "search":
        from . import forgelayer
        state = forgelayer.open_state(forgelayer.STATE_FOLDER)
        try:
            search = community.open_d1(target, settings=settings, persist_to=persist_to, database="oscr_search")
            return push_search(search, search_docs(out), state)
        except community.D1Error as e:
            raise SystemExit(f"social search ({target}): {e}. Is oscr_search migrated? npx wrangler d1 migrations apply "
                             f"oscr_search --{target}" + (" --env local" if target == "local" else "")) from None
        finally:
            state.close()
    try:
        forge = community.open_d1(target, settings=settings, persist_to=persist_to, database="oscr_forge")
        people = community.open_d1(target, settings=settings, persist_to=persist_to)
        if action == "layer":
            return write(forge, people, out, con=con, now=now)
        if action == "collections":
            users, _ = handles(people)
            lines = [f"{(users.get(li['user_id']) or {}).get('github') or (users.get(li['user_id']) or {}).get('orcid') or '?'} "
                     f"list {li['list_id']}: {li['name']} — {li['description']}" for li in proposed(forge)]
            return "\n".join(lines) or "no list is proposed as a collection"
        if action in ("accept", "decline"):
            if not handle or not list_id:
                raise SystemExit(f"social {action}: name the person (--handle) and the list (--list)")
            return decide(forge, people, handle, list_id, action == "accept")
    except (community.D1Error, SocialError) as e:
        raise SystemExit(f"social {action} ({target}): {e}") from None
    raise SystemExit(f"social {action}: not an action (layer, search, collections, accept, decline)")
