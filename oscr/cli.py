"""The OSCR command line.

    oscr run                             the daily pass (incremental)
    oscr watch                           continuously: new papers, the stock, re-verifications
    oscr nightly                         the publication: public catalogue, Hugging Face, website
    oscr align                           the paper ↔ code matches of papers with stored code
    oscr zenodo card 10.xxx/yyy          the proposed tracing map of a paper
    oscr zenodo deposit 10.xxx/yyy       its Zenodo DOI, once an author validated it (sandbox)
    oscr scan --since 2015-01-01 --until 2015-12-31 --max 500
    oscr doi 10.7554/eLife.100605 10.1038/s41597-025-06397-4
    oscr folder data/test_corpus         JATS files already on disk
    oscr reverify                        re-verify stale repositories
    oscr export                          regenerate the catalogue and its tables
    oscr dashboard                       the local dashboard (http://127.0.0.1:8790)
    oscr stats                           the library's figures
    oscr scripts audit|build|publish     the authors' scripts on Hugging Face (verified licenses only)
    oscr enrich [--all] [--epmc]         Phase 1: the enriched records of the papers already read
    oscr enrich --openalex [--all]       their OpenAlex works (free lookups by DOI; the owner's key), resumable
    oscr labels data/annotation/sample.csv   the owner's category labels (they win over the rules)
    oscr d1 build|push|status --local    Phase 3: the search's D1 databases, as deltas (docs/SEARCH.md)
    oscr community build|push --local    the sign-in's facts (ORCID iDs, repository owners) for D1 (--remote too)
    oscr jobs poll --local|--remote      Phase 6: the site's requests (submissions, corrections, validations…)
    oscr claims|reports|submissions list|accept|refuse   the owner's decisions (docs/CONTRIBUTIONS.md)
    oscr forge poll|mirrors|layer|status --local|--remote   the GitHub side (night phase 01, docs/FORGE.md):
                                         the forge jobs, the public mirrors' heads, OSCR's static layer.
                                         With OSCR_FORGE_PUSH=<target> in the settings, `oscr jobs poll`
                                         also polls the forge jobs there, and with OSCR_FORGE_PUSH=remote
                                         `oscr nightly` also reads the mirrors and writes the layer.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from datetime import date
from pathlib import Path

from . import catalog, db, harvest
from .net import Cache, Client, github_token
from .sources import europepmc

SETTINGS = Path.home() / ".config" / "oscr" / "settings"


def settings(path: Path = SETTINGS) -> dict[str, str]:
    """The Mac installation's settings (`KEY=value`, `#` for comments).

    Python reads them itself: launchd cannot start a shell script stored on the external
    disk (macOS refuses /bin/zsh to open the file, exit code 127), while it lets Python,
    and what Python starts, read and write there."""
    out: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip().strip("\"'")
    return out


def _scripts(con, action: str, folder: Path, dataset: str, *, platform: str, dry_run: bool = False) -> str:
    from . import scriptstore
    if action == "audit":
        return json.dumps(scriptstore.audit(con), ensure_ascii=False, indent=1)
    out = scriptstore.build(con, folder)
    done = (f"{len(out['blocks'])} new block(s) for {out['new_files']} new files, {out['manifests']} manifest(s) "
            f"written, {len(out['withdrawn'])} withdrawn; {out['repositories']} repositories published")
    if action == "build":
        return done
    if not dataset:
        raise SystemExit("scripts publish: --dataset (or OSCR_SCRIPTS_DATASET) is required")
    return done + "\n" + scriptstore.publish(con, folder, dataset, platform=platform, dry_run=dry_run)


def _options(a: argparse.Namespace) -> harvest.Options:
    return harvest.Options(db=Path(a.db), cache=Path(a.cache), clones=Path(a.clones), library=Path(a.library),
                           verify=not a.no_verify, metadata=not a.no_metadata, swh=not a.no_swh,
                           snapshots=a.snapshots, reverify_after_days=0 if a.reverify_all else 30,
                           contents=not a.no_contents, records=not a.no_records,
                           github_search=a.github_search or bool(github_token()))


def _article_id(con, doi: str) -> str:
    row = con.execute("SELECT id FROM article WHERE lower(doi) = lower(?)", (doi,)).fetchone()
    if row is None:
        raise SystemExit(f"{doi} is not in the database: run `oscr doi {doi}` first")
    return row["id"]


def _jobs(con, a: argparse.Namespace, cfg: dict[str, str], client: Client, opts: harvest.Options) -> str:
    """Phase 6: the site's requests, read from D1 community and answered (oscr/jobs.py)."""
    from . import community, jobs
    state = jobs.open_state(Path(a.folder) / "state.db")
    try:
        if a.command == "jobs" and a.action == "status":
            return jobs.status(state)
        target = "remote" if a.remote else "local" if a.local else ""
        kinds = {"claims": ("claim",), "reports": ("report",), "submissions": ("publish",)}.get(a.command, ())
        if a.command != "jobs" and a.action == "list":
            return jobs.describe_waiting(jobs.waiting(state, target or "remote", kinds) if target else
                                         jobs.waiting(state, "local", kinds) + jobs.waiting(state, "remote", kinds))
        if not target:
            raise SystemExit(f"{a.command} {a.action}: add --local (the local D1 of `wrangler dev`) or --remote "
                             f"(the Cloudflare database)")
        d1 = community.open_d1(target, settings=cfg, persist_to=Path(a.persist_to) if a.persist_to else None)
        runner = jobs.Runner(con, d1, state, jobs.MacHarvester(client, opts), instance=a.instance,
                             zenodo_community=cfg.get("OSCR_ZENODO_COMMUNITY", "oscr"),
                             platform=cfg.get("OSCR_PLATFORM_NAME", "Open Scientific Code Registry (OSCR)"),
                             budget=a.budget, report=lambda m: print(m, flush=True))
        try:
            if a.command == "jobs":
                out = jobs.poll(runner).describe(target)
                if cfg.get("OSCR_FORGE_PUSH") == target:
                    # The GitHub side's jobs (night phase 01), in the same state and budget; a failure is
                    # said, and the community's answers stand.
                    from . import forgejobs
                    try:
                        out += "\n" + forgejobs.command(
                            con, "poll", target=target, folder=Path(a.folder), budget=a.budget, settings=cfg,
                            persist_to=Path(a.persist_to) if a.persist_to else None, client=client,
                            report=lambda m: print(m, flush=True))
                    except (Exception, SystemExit) as e:
                        out += f"\nforge jobs: {e}"
                return out
            if a.id is None:
                raise SystemExit(f"{a.command} {a.action}: which one? (its number, from `oscr {a.command} list`)")
            accept = a.action == "accept"
            if a.command == "claims":
                return jobs.decide_claim(runner, a.id, accept, a.message)
            if a.command == "reports":
                return jobs.decide_report(runner, a.id, accept, a.message)
            return jobs.decide_submission(runner, a.id, accept, a.message)
        except community.D1Error as e:
            raise SystemExit(f"D1 ({target}): {e}") from None
    finally:
        state.close()


def _forge(con, a: argparse.Namespace, cfg: dict[str, str], client: Client) -> str:
    """The GitHub side (night phase 01): `oscr forge poll|mirrors|layer|status|retention` (oscr/forgejobs.py,
    oscr/forgelayer.py, night phase 16's oscr/retention.py; docs/FORGE.md)."""
    from . import forgejobs, forgelayer
    target = "remote" if a.remote else "local" if a.local else None
    if target is None and a.action != "status":
        raise SystemExit(f"forge {a.action}: add --local (the local D1 of `wrangler dev`) or --remote "
                         f"(the Cloudflare database oscr_forge)")
    common = {"target": target, "folder": Path(a.folder), "budget": a.budget, "settings": cfg,
              "persist_to": Path(a.persist_to) if a.persist_to else None,
              "report": lambda m: print(m, flush=True)}
    if a.action == "layer":
        return forgelayer.command(con, "layer", out=Path(a.export), **common)
    if a.action == "retention":
        # Night phase 16: what the privacy statement keeps for a time only (oscr/retention.py).
        from . import community, retention
        d1 = community.open_d1(target, settings=cfg, persist_to=common["persist_to"], database="oscr_forge")
        return retention.run(d1, budget=min(a.budget, 2_000))
    if a.action == "status":
        return "\n".join([forgejobs.command(con, "status", client=client, **common),
                          forgelayer.command(con, "status", out=Path(a.export), **common)])
    if a.action == "poll":
        return forgejobs.command(con, a.action, client=client, instance=a.instance, **common)
    return forgejobs.command(con, a.action, client=client, **common)


def _zenodo(con, a: argparse.Namespace) -> None:
    """Tracing maps and their DOIs (rules: CLAUDE.md, zenodo.py)."""
    from . import zenodo
    inv = zenodo.Invenio(a.instance, api_token=zenodo.token(a.instance))
    try:
        article_id = None
        if a.action in ("card", "validate", "deposit"):
            if not a.doi:
                raise SystemExit(f"zenodo {a.action}: the paper's DOI is missing")
            article_id = _article_id(con, a.doi)
        if a.action == "card":
            print(json.dumps(zenodo.map_of(con, article_id), ensure_ascii=False, indent=1))
        elif a.action == "validate":
            # For DEVELOPMENT: a test validation, which only the sandbox accepts. The
            # real one will come from the author, signed in with ORCID.
            card = zenodo.validate(con, article_id, orcid=a.orcid, name=a.name, proof="test")
            print(f"map validated (test) by {a.name} ({a.orcid}): {len(card['code'])} repository(ies)")
        elif a.action == "deposit":
            r = zenodo.deposit_map(con, inv, article_id, platform=a.platform, community=a.community,
                                   dry_run=a.dry_run)
            print(json.dumps(r, ensure_ascii=False, indent=1))
        elif a.action == "community":
            c = inv.community(a.community)
            if c is None and a.create:
                c = inv.create_community(
                    a.community, a.platform,
                    "Code tracing maps linking neuroscience papers to their authors' code, validated by "
                    "the authors. Each map is related to its paper (IsSupplementTo) and references the "
                    "code repository (References); the code itself is never redeposited.")
            print(f"{inv.base}/communities/{a.community}" + ("" if c else ": does not exist (--create)"))
        elif a.action == "linked":
            for r in inv.linked_to(a.doi or ""):
                print(r["id"], (r.get("metadata") or {}).get("title", ""), (r.get("links") or {}).get("self_html", ""))
    except zenodo.InvenioError as e:
        raise SystemExit(str(e)) from None
    finally:
        inv.close()


#: The researchers' command line's own commands (cli/, the `oscr_cli` package: DECISIONS.md D14-1). The
#: harvester has none of them; given one, argparse refuses it as always (exit 2), and a line says where
#: that command lives. `run` is the harvester's here (the researchers' `oscr run` lists CI runs).
RESEARCHER_COMMANDS = frozenset({
    "auth", "repo", "pr", "issue", "release", "paper", "trace", "cite", "check", "search", "api", "browse",
    "workflow", "config", "alias", "completion", "mcp", "help",
})


def researchers_hint(argv: list[str], harvester: set[str]) -> None:
    """After argparse's own refusal: the researchers' tool, when the command word (the first word that is
    a command of either tool) is one of its commands."""
    word = next((w for w in argv if w in RESEARCHER_COMMANDS or w in harvester), None)
    if word in RESEARCHER_COMMANDS and word not in harvester:
        print(f"note: `{word}` is a command of the researchers' `oscr` (cli/, docs/CLI.md), not of the "
              f"harvester's. In this repository it runs as `PYTHONPATH=cli/src .venv/bin/python -m oscr_cli {word}`; "
              "elsewhere, as the `oscr` installed with `uv tool install ./cli` or `pipx install ./cli`.",
              file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    cfg = settings()
    p = argparse.ArgumentParser(prog="oscr", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default="data/oscr.db")
    p.add_argument("--cache", default="data/cache")
    p.add_argument("--clones", default="data/clones")
    p.add_argument("--library", default="library")
    p.add_argument("--out", default="data/export", help="where `export` and the passes write the catalogue")
    p.add_argument("--no-verify", action="store_true", help="do not query the repositories")
    p.add_argument("--no-metadata", action="store_true", help="neither Crossref nor DataCite")
    p.add_argument("--no-swh", action="store_true", help="do not query Software Heritage")
    p.add_argument("--snapshots", action="store_true", help="archive the repositories whose license allows it")
    p.add_argument("--reverify-all", action="store_true", help="re-verify every repository, even recently verified")
    p.add_argument("--no-contents", action="store_true", help="do not fetch the scripts' text")
    p.add_argument("--public", action="store_true",
                   help="publishable catalogue: only scripts whose license allows it keep their text")
    p.add_argument("--mirror", default="", help="copy the republishable scripts into this folder (for a public git repository)")
    p.add_argument("--github-search", action="store_true", help="look for READMEs citing the DOI (10/min without a token)")
    p.add_argument("--offline", action="store_true", help="the cache only")
    p.add_argument("--no-records", action="store_true", help="do not write library/<paper>/record.json (the database is the reference)")
    sp = p.add_subparsers(dest="command", required=True)

    r = sp.add_parser("run", help="incremental pass from the last cursor")
    r.add_argument("--domain", default="neuro", help="neuro | electrophysiology | a Europe PMC query")
    r.add_argument("--days", type=int, default=7, help="first pass: that many days back")
    r.add_argument("--max", type=int, default=None)

    s = sp.add_parser("scan", help="scan a date range")
    s.add_argument("--domain", default="neuro")
    s.add_argument("--since", required=True)
    s.add_argument("--until", default=date.today().isoformat())
    s.add_argument("--max", type=int, default=None)
    s.add_argument("--rescan", action="store_true", help="read papers already seen again")

    # By default, what the settings say (~/.config/oscr/settings).
    w = sp.add_parser("watch", help="run continuously: new papers every hour, the stock in between")
    w.add_argument("--domain", default=cfg.get("OSCR_DOMAIN", "neuro"))
    w.add_argument("--news-minutes", type=float, default=cfg.get("OSCR_NEWS_MINUTES", "60"))
    w.add_argument("--slice-minutes", type=float, default=cfg.get("OSCR_SLICE_MINUTES", "30"))
    w.add_argument("--idle-minutes", type=float, default=15, help="nap once the stock is done")
    w.add_argument("--back-to", type=int, default=cfg.get("OSCR_BACK_TO", "2000"))
    w.add_argument("--max-hours", type=float, default=24,
                   help="hand back control after that many hours (launchd starts a fresh process)")

    b = sp.add_parser("backfill", help="walk back into the stock, month by month, within a time budget")
    b.add_argument("--domain", default="neuro")
    b.add_argument("--hours", type=float, default=1.0, help="time budget of this pass")
    b.add_argument("--back-to", type=int, default=2000, help="the oldest year to walk back to")

    d = sp.add_parser("doi", help="scan papers known by their DOI")
    d.add_argument("dois", nargs="*")
    d.add_argument("--file", help="one DOI per line")

    f = sp.add_parser("folder", help="scan local JATS files")
    f.add_argument("path")

    v = sp.add_parser("reverify", help="re-verify stale or unreachable repositories")
    v.add_argument("--max", type=int, default=None)

    al = sp.add_parser("align", help="compute the paper ↔ code matches of papers whose code text is stored")
    al.add_argument("dois", nargs="*", help="only these papers (default: every paper still without matches)")
    al.add_argument("--force", action="store_true", help="recompute papers that already have matches")
    al.add_argument("--hours", type=float, default=None, help="time budget")

    sp.add_parser("export", help="regenerate the catalogue and its tables")

    dash = sp.add_parser("dashboard", help="the local dashboard: the database's table (http://127.0.0.1:8790)")
    dash.add_argument("--port", type=int, default=8790)

    hf = sp.add_parser("publish-hf", help="publish the catalogue and the scripts to a Hugging Face dataset")
    hf.add_argument("dataset", help="dataset id, e.g. user/oscr-catalog")
    hf.add_argument("--dry-run", action="store_true", help="prepare without sending anything")
    sp.add_parser("stats", help="the library's figures")

    ze = sp.add_parser("zenodo", help="tracing maps: author validation, Zenodo DOI (sandbox by default)")
    ze.add_argument("action", choices=["card", "validate", "deposit", "community", "linked"])
    ze.add_argument("doi", nargs="?", help="the paper's DOI")
    ze.add_argument("--instance", choices=["sandbox", "zenodo"], default=cfg.get("OSCR_ZENODO_INSTANCE", "sandbox"))
    ze.add_argument("--community", default=cfg.get("OSCR_ZENODO_COMMUNITY", "oscr"))
    ze.add_argument("--platform", default=cfg.get("OSCR_PLATFORM_NAME", "Open Scientific Code Registry (OSCR)"))
    ze.add_argument("--orcid", default="", help="validate: the author's ORCID")
    ze.add_argument("--name", default="", help='validate: "Family, Given"')
    ze.add_argument("--create", action="store_true", help="community: create it when it does not exist")
    ze.add_argument("--dry-run", action="store_true", help="deposit: show the record without sending anything")

    en = sp.add_parser("enrich", help="Phase 1: the enriched records (bibliography, people, subjects, "
                                      "categories, datasets, repository tools) of the papers already read")
    en.add_argument("--all", action="store_true", help="every paper, not only those never enriched")
    en.add_argument("--epmc", action="store_true",
                    help="first fetch the Europe PMC core results of the papers that have none (100 per request)")
    en.add_argument("--openalex", action="store_true",
                    help="look the papers up in OpenAlex (one free call each, by DOI) and enrich them again with "
                         "it: those never asked, and those OpenAlex did not know a week ago; with --all, every "
                         "paper not asked in the last 20 hours. Resumable; stops for the day on a 429")
    en.add_argument("--hours", type=float, default=0, help="--openalex: stop after this many hours (0: no limit)")
    en.add_argument("--max", type=int, default=None)

    lb = sp.add_parser("labels", help="import the owner's category labels from the annotation file")
    lb.add_argument("csv", nargs="?", default="data/annotation/sample.csv")

    ct = sp.add_parser("contacts", help="the authors' contact details: PRIVATE, to the private dataset only")
    ct.add_argument("action", choices=["summary", "build", "publish"],
                    help="summary: counts; build: contacts.parquet in --folder; publish: build, check that the "
                         "dataset is private, send")
    ct.add_argument("--folder", default="data/contacts")
    ct.add_argument("--dataset", default=cfg.get("OSCR_CONTACTS_DATASET", "OpenScientificCodeRegistry/Private"))
    ct.add_argument("--dry-run", action="store_true", help="publish: build and check, send nothing")

    sc = sp.add_parser("scripts", help="the authors' scripts on Hugging Face: deduplicated Parquet blocks, "
                                       "one manifest per repository, verified licenses only")
    sc.add_argument("action", choices=["audit", "build", "publish"],
                    help="audit: what would leave and why the rest stays; build: new blocks and manifests; "
                         "publish: build, then send what the dataset does not have yet")
    sc.add_argument("--folder", default="data/scripts", help="where the blocks and manifests are written")
    sc.add_argument("--dataset", default=cfg.get("OSCR_SCRIPTS_DATASET", ""), help="Hugging Face org/dataset")
    sc.add_argument("--dry-run", action="store_true", help="publish: build and count, send nothing")

    dd = sp.add_parser("d1", help="Phase 3: the search's D1 databases (catalogue and full-text index), pushed as "
                                  "deltas within a daily budget of rows written")
    dd.add_argument("action", choices=["build", "push", "status"],
                    help="build: write the next delta as SQL files; push: build, apply, record; status: what was pushed")
    target = dd.add_mutually_exclusive_group()
    target.add_argument("--local", action="store_true", help="the local D1 of `wrangler dev --env local` (default)")
    target.add_argument("--remote", action="store_true", help="the Cloudflare databases (once approved: docs/SEARCH.md)")
    dd.add_argument("--budget", type=int, default=int(cfg.get("OSCR_D1_BUDGET", "80000")), help="rows written a day")
    dd.add_argument("--state", default="data/d1/state.db", help="the push's state: keys, row hashes, budget")
    dd.add_argument("--sql-dir", default="data/d1/sql", help="where the SQL files are written")
    dd.add_argument("--reset", action="store_true",
                    help="the target's databases were recreated empty: forget what they held, send everything")
    cm = sp.add_parser("community", help="the facts the sign-in verifies (ORCID iDs of papers with a page, owners of "
                                         "their repositories, which paper each is the code of), as deltas for the D1 "
                                         "community database")
    cm.add_argument("action", choices=["build", "push", "status"])
    where = cm.add_mutually_exclusive_group()
    where.add_argument("--local", action="store_true", help="the local D1 of `wrangler dev`")
    where.add_argument("--remote", action="store_true",
                       help="the Cloudflare database: the REST API with OSCR_D1_ACCOUNT_ID, OSCR_D1_COMMUNITY_ID and the "
                            "keychain's token, else wrangler's own login")
    cm.add_argument("--folder", default="data/community", help="the SQL files and the push's state")
    cm.add_argument("--budget", type=int, default=None, help="rows written a day (default 10,000)")

    # Phase 6: the site's requests, and the owner's decisions (docs/CONTRIBUTIONS.md).
    def community_target(parser: argparse.ArgumentParser) -> None:
        group = parser.add_mutually_exclusive_group()
        group.add_argument("--local", action="store_true", help="the local D1 of `wrangler dev --env local`")
        group.add_argument("--remote", action="store_true", help="the Cloudflare database (as `community push --remote`)")
        parser.add_argument("--folder", default="data/community", help="the state (shared with `oscr community`)")
        parser.add_argument("--persist-to", default="", help="the local D1's state folder, when not website/.wrangler/state")
        parser.add_argument("--budget", type=int, default=int(cfg.get("OSCR_COMMUNITY_BUDGET", "10000")),
                            help="rows written a day, the facts push's included (default 10,000)")
        parser.add_argument("--instance", choices=["sandbox", "zenodo"], default=cfg.get("OSCR_ZENODO_INSTANCE", "sandbox"),
                            help="the Zenodo of the maps' deposits (the sandbox while the platform is built)")

    jb = sp.add_parser("jobs", help="Phase 6: read the site's requests from D1 (submissions, corrections, validations, "
                                    "claims, removal requests) and answer them")
    jb.add_argument("action", choices=["poll", "status"])
    community_target(jb)
    for name, verbs, what in (("claims", ["list", "accept", "refuse"], "the claims that wait for the owner"),
                              ("reports", ["list", "accept", "reject"], "the requests to remove a record"),
                              ("submissions", ["list", "accept", "refuse"],
                               "the submissions published by someone who is not among the paper's authors")):
        dp = sp.add_parser(name, help=f"Phase 6: {what}")
        dp.add_argument("action", choices=verbs)
        dp.add_argument("id", type=int, nargs="?", help="its number, from the list")
        dp.add_argument("--message", default="", help="your words for the person who asked (shown on their account page)")
        community_target(dp)

    fg = sp.add_parser("forge", help="the GitHub side (night phase 01): the forge jobs, the public mirrors' heads, "
                                     "OSCR's static layer (docs/FORGE.md)")
    fg.add_argument("action", choices=["poll", "mirrors", "layer", "status", "retention"])
    fg_where = fg.add_mutually_exclusive_group()
    fg_where.add_argument("--local", action="store_true", help="the local D1 of `wrangler dev --env local`")
    fg_where.add_argument("--remote", action="store_true",
                          help="the Cloudflare database oscr_forge: the REST API with OSCR_D1_ACCOUNT_ID, "
                               "OSCR_D1_FORGE_ID and the keychain's token, else wrangler's own login")
    fg.add_argument("--folder", default="data/community", help="the state (shared with `oscr community` and `oscr jobs`)")
    fg.add_argument("--persist-to", default="", help="the local D1's state folder, when not website/.wrangler/state")
    fg.add_argument("--budget", type=int, default=int(cfg.get("OSCR_COMMUNITY_BUDGET", "10000")),
                    help="rows written a day, the facts push's included (default 10,000)")
    fg.add_argument("--export", default="data/public",
                    help="layer: the public export, whose forge/layer/ the shards go to")
    fg.add_argument("--instance", choices=["sandbox", "zenodo"], default=cfg.get("OSCR_ZENODO_INSTANCE", "sandbox"),
                    help="poll: the Zenodo of a release map's deposit (night phase 07; the sandbox by default)")

    mw = sp.add_parser("malware", help="night phase 16: files whose SHA-256 is on the local known-malware list "
                                       "(data/malware/sha256.txt or OSCR_MALWARE_LIST) lose their text; the GitHub side's "
                                       "repositories holding one are hidden. Nothing is run, nothing fetched.")
    mw.add_argument("action", choices=["scan", "status"])
    mw_where = mw.add_mutually_exclusive_group()
    mw_where.add_argument("--local", action="store_true", help="also hide in the local D1 of `wrangler dev --env local`")
    mw_where.add_argument("--remote", action="store_true", help="also hide in the Cloudflare database oscr_forge")
    mw.add_argument("--persist-to", default="", help="the local D1's state folder, when not website/.wrangler/state")

    se = sp.add_parser("security", help="night phase 11: security and quality facts computed on the Mac and pushed to "
                                        "oscr_forge, the dependency graph from environment files (docs/SECURITY_QUALITY.md). "
                                        "Nothing is run, nothing resolved, nothing installed.")
    se.add_argument("action", choices=["scan", "status"])
    se_where = se.add_mutually_exclusive_group()
    se_where.add_argument("--local", action="store_true", help="the local D1 of `wrangler dev --env local`")
    se_where.add_argument("--remote", action="store_true", help="the Cloudflare database oscr_forge")
    se.add_argument("--folder", default="data/community", help="the state (the budget ledger, shared with the other pushers)")
    se.add_argument("--persist-to", default="", help="the local D1's state folder, when not website/.wrangler/state")
    se.add_argument("--budget", type=int, default=int(cfg.get("OSCR_COMMUNITY_BUDGET", "10000")),
                    help="rows written a day, the facts push's included (default 10,000)")

    so = sp.add_parser("social", help="the social layer (night phase 08): the static shards of stars, follows and "
                                      "profiles, the Explore page, the collections (docs/SOCIAL.md)")
    so.add_argument("action", choices=["layer", "search", "collections", "accept", "decline"])
    so_where = so.add_mutually_exclusive_group()
    so_where.add_argument("--local", action="store_true", help="the local D1s of `wrangler dev --env local`")
    so_where.add_argument("--remote", action="store_true", help="the Cloudflare databases oscr_forge and oscr_community")
    so.add_argument("--persist-to", default="", help="the local D1's state folder, when not website/.wrangler/state")
    so.add_argument("--folder", default="data/community", help="search: the state of what was pushed (shared with `oscr forge`)")
    so.add_argument("--export", default="data/public",
                    help="layer: the public export, whose social/ the files go to; search: the export the index is made from")
    so.add_argument("--handle", default="", help="accept, decline: the person who proposed the list (GitHub login or ORCID iD)")
    so.add_argument("--list", type=int, default=0, help="accept, decline: the list's number")

    n = sp.add_parser("nightly", help="the publication: public catalogue, then Hugging Face and the website")
    n.add_argument("--out", default="data/public", help="a separate folder, only ever generated in public mode")
    n.add_argument("--dataset", default=cfg.get("OSCR_HF_DATASET", ""), help="Hugging Face user/dataset (empty: send nothing)")
    n.add_argument("--cloudflare", default=cfg.get("OSCR_CLOUDFLARE_PROJECT", ""),
                   help="Cloudflare Pages project to rebuild and put online (empty: none)")

    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        if e.code == 2:
            researchers_hint(sys.argv[1:] if argv is None else argv, set(sp.choices))
        raise
    if a.command == "dashboard":
        from . import dashboard
        db.open_db(a.db).close()  # creates or updates the schema, then read-only
        dashboard.serve(Path(a.db), a.port)
        return 0
    opts = _options(a)
    con = db.open_db(opts.db)
    client = Client(Cache(opts.cache), offline=a.offline)
    t0 = time.time()
    try:
        if a.command == "run":
            print(harvest.run_pass(con, client, a.domain, opts, initial_days=a.days, maximum=a.max))
        elif a.command == "watch":
            # Without the "reverse" GitHub search (2 s per paper, nothing more than the
            # text on open-access papers), unless asked.
            opts.github_search = a.github_search
            # launchd stops with SIGTERM: turn it into a clean exit, so that temporary
            # clones are cleaned up and the database closed.
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
            print(f"{time.strftime('%Y-%m-%d %H:%M')} watch \"{a.domain}\": new papers every "
                  f"{a.news_minutes:g} min, the stock in slices of {a.slice_minutes:g} min back to {a.back_to}",
                  flush=True)
            harvest.watch(con, client, a.domain, opts, news_s=a.news_minutes * 60, slice_s=a.slice_minutes * 60,
                          idle_s=a.idle_minutes * 60, back_to=a.back_to, max_duration_s=a.max_hours * 3600,
                          report=lambda m: print(m, flush=True))
        elif a.command == "backfill":
            # The "reverse" GitHub search costs 2 s per paper with a token (30/min) and
            # found nothing beyond the text on 177 open-access papers: in the stock, only
            # when asked.
            opts.github_search = a.github_search
            t = harvest.backfill(con, client, a.domain, opts, max_duration_s=a.hours * 3600, back_to=a.back_to)
            print(t, "(budget spent, resuming at the next pass)" if t.interrupted else "")
        elif a.command == "scan":
            q = europepmc.query(a.domain, a.since, a.until)
            _, _, total = europepmc.search(client, q, size=1)
            print(f"{total} papers for \"{a.domain}\" from {a.since} to {a.until}")
            t = harvest.scan_query(con, client, q, opts, maximum=a.max, already="rescan" if a.rescan else "skip")
            db.log_event(con, "scan", domain=a.domain, since=a.since, until=a.until, articles=t.articles, total=total)
            print(t)
        elif a.command == "doi":
            dois = list(a.dois)
            if a.file:
                dois += [l.strip() for l in Path(a.file).read_text().splitlines() if l.strip()]
            for doi in dois:
                art = europepmc.by_doi(client, doi)
                if art is None:
                    art = europepmc.EpmcArticle(id=europepmc.identifier(doi.lower(), ""), doi=doi.lower(), source="doi")
                print(f"{doi} → {harvest.scan_article(con, client, art, opts)}")
        elif a.command == "folder":
            t = harvest.scan_folder(con, client, Path(a.path), opts)
            db.log_event(con, "folder", path=Path(a.path).name, articles=t.articles)
            print(t)
        elif a.command == "align":
            deadline = time.time() + a.hours * 3600 if a.hours else None
            if a.dois:
                for doi in a.dois:
                    print(f"{doi} → {harvest.align_article(con, client, _article_id(con, doi))} matches")
                    con.commit()
            else:
                print(f"{harvest.align_pending(con, client, force=a.force, deadline=deadline)} papers aligned")
        elif a.command == "nightly":
            now = lambda: time.strftime("%Y-%m-%d %H:%M")  # noqa: E731
            out = Path(a.out)
            # Night phase 16: a file known as malware loses its text before anything is exported, and the
            # GitHub side's repository holding it is hidden (oscr/malware.py). Nothing is run.
            from . import malware
            if malware.load():
                try:
                    from . import community
                    forge_d1 = community.open_d1("remote", settings=cfg, database="oscr_forge") if cfg.get("OSCR_FORGE_PUSH") == "remote" else None
                    print(f"{now()} " + malware.scan(con, forge_d1), flush=True)
                except Exception as e:  # noqa: BLE001 — the nightly goes on; the harvester already refuses listed files
                    print(f"{now()} malware scan failed: {e}", flush=True)
            print(f"{now()} public catalogue → {catalog.generate(con, out, public=True)}", flush=True)
            from . import publish
            # Each upload is attempted on its own: Hugging Face being down does not keep
            # the website from updating, and vice versa.
            errors = []
            if cfg.get("OSCR_FORGE_PUSH") == "remote":
                # The GitHub side (night phase 01, docs/FORGE.md), between the public export and the
                # deployment: the public mirrors' heads, then OSCR's static layer into the export.
                from . import community, forgejobs, forgelayer
                try:
                    print(f"{now()} forge mirrors: " + forgejobs.mirrors(
                        con, target="remote", folder=Path("data/community"),
                        budget=int(cfg.get("OSCR_COMMUNITY_BUDGET", "10000")), settings=cfg, client=client,
                        report=lambda m: print(m, flush=True)), flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Forge mirrors: {e}")
                try:
                    forge_d1 = community.open_d1("remote", settings=cfg, database="oscr_forge")
                    print(f"{now()} forge layer: " + forgelayer.write(con, forge_d1, out), flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Forge layer: {e}")
                # Night phase 16: what is kept for a time only, deleted (oscr/retention.py).
                from . import retention
                try:
                    print(f"{now()} forge " + retention.run(community.open_d1("remote", settings=cfg, database="oscr_forge"),
                                                              budget=int(cfg.get("OSCR_RETENTION_BUDGET", "2000"))), flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Forge retention: {e}")
                # Night phase 08: the social layer's shards and the Explore page (docs/SOCIAL.md).
                from . import social
                try:
                    print(f"{now()} social layer: " + social.write(
                        community.open_d1("remote", settings=cfg, database="oscr_forge"),
                        community.open_d1("remote", settings=cfg), out, con=con), flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Social layer: {e}")
                # The GitHub side's search index (forge_fts), with the papers' own push switch.
                if cfg.get("OSCR_D1_PUSH") == "remote":
                    try:
                        state = forgelayer.open_state(forgelayer.STATE_FOLDER)
                        try:
                            print(f"{now()} " + social.push_search(community.open_d1("remote", settings=cfg, database="oscr_search"),
                                                                   social.search_docs(out), state), flush=True)
                        finally:
                            state.close()
                    except (Exception, SystemExit) as e:
                        errors.append(f"Forge search: {e}")
            if a.dataset:
                try:
                    print(f"{now()} {publish.publish_hf(out, a.dataset)}", flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Hugging Face: {e}")
            if a.cloudflare:
                try:
                    print(f"{now()} {publish.deploy_cloudflare(out, a.cloudflare)}", flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Cloudflare: {e}")
            if cfg.get("OSCR_D1_PUSH") == "remote":
                # The search's databases (docs/SEARCH.md): the day's changes, within the budget.
                from . import d1
                try:
                    print(f"{now()} search (D1): " + d1.command(
                        con, "push", target="remote", budget=int(cfg.get("OSCR_D1_BUDGET", "80000")),
                        state_path=Path("data/d1/state.db"), folder=Path("data/d1/sql"), settings=cfg), flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Search (D1): {e}")
            if cfg.get("OSCR_COMMUNITY_PUSH") == "remote":
                # The sign-in's facts (docs/ACCOUNTS.md, docs/CONTRIBUTIONS.md): the day's changes.
                from . import community
                try:
                    print(f"{now()} community (D1): " + community.command(
                        con, "push", target="remote", folder=Path("data/community"),
                        budget=int(cfg.get("OSCR_COMMUNITY_BUDGET", "10000")), settings=cfg), flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Community (D1): {e}")
            if cfg.get("OSCR_SCRIPTS_DATASET"):
                try:
                    print(f"{now()} " + _scripts(con, "publish", Path("data/scripts"), cfg["OSCR_SCRIPTS_DATASET"],
                                                 platform=cfg.get("OSCR_PLATFORM_NAME", "OSCR")), flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Scripts on Hugging Face: {e}")
            if cfg.get("OSCR_CONTACTS_DATASET"):
                # Private: contacts.publish refuses a dataset that is not private.
                from . import contacts
                try:
                    print(f"{now()} " + contacts.publish(con, Path("data/contacts"), cfg["OSCR_CONTACTS_DATASET"],
                                                         platform=cfg.get("OSCR_PLATFORM_NAME", "OSCR")), flush=True)
                except (Exception, SystemExit) as e:
                    errors.append(f"Contacts on Hugging Face: {e}")
            if errors:
                raise SystemExit("\n".join(errors))
        elif a.command == "enrich":
            from . import enrich
            if a.openalex:
                print(enrich.openalex_pass(con, client, everything=a.all, maximum=a.max,
                                           deadline=time.time() + a.hours * 3600 if a.hours else None,
                                           report=lambda m: print(m, flush=True)))
            else:
                print(enrich.backfill(con, client, everything=a.all, epmc=a.epmc, maximum=a.max))
        elif a.command == "labels":
            from . import enrich
            print(enrich.import_owner_labels(con, Path(a.csv)))
        elif a.command == "scripts":
            print(_scripts(con, a.action, Path(a.folder), a.dataset, dry_run=a.dry_run,
                           platform=cfg.get("OSCR_PLATFORM_NAME", "Open Scientific Code Registry (OSCR)")))
        elif a.command == "contacts":
            from . import contacts
            platform = cfg.get("OSCR_PLATFORM_NAME", "Open Scientific Code Registry (OSCR)")
            if a.action == "summary":
                print(contacts.summary(con))
            elif a.action == "build":
                print(contacts.build(con, Path(a.folder), platform=platform))
            else:
                print(contacts.publish(con, Path(a.folder), a.dataset, platform=platform, dry_run=a.dry_run))
        elif a.command == "community":
            from . import community
            print(community.command(con, a.action, target="remote" if a.remote else "local" if a.local else None,
                                    folder=Path(a.folder), budget=a.budget, settings=cfg))
        elif a.command == "malware":
            from . import community, malware
            digests = malware.load()
            if a.action == "status":
                print(f"{len(digests):,} digests on the list at {malware.list_path()}" if digests else
                      f"no list at {malware.list_path()}: fetch one (docs/MODERATION.md, “Known malware”)")
            else:
                target = "remote" if a.remote else "local" if a.local else None
                forge_d1 = community.open_d1(target, settings=cfg, persist_to=Path(a.persist_to) if a.persist_to else None,
                                             database="oscr_forge") if target and digests else None
                print(malware.scan(con, forge_d1, digests=digests))
        elif a.command in ("jobs", "claims", "reports", "submissions"):
            print(_jobs(con, a, cfg, client, opts))
        elif a.command == "forge":
            print(_forge(con, a, cfg, client))
        elif a.command == "security":
            from . import security
            print(security.command(con, a.action, target="remote" if a.remote else "local" if a.local else None,
                                   folder=Path(a.folder), budget=a.budget, settings=cfg,
                                   persist_to=Path(a.persist_to) if a.persist_to else None,
                                   report=lambda m: print(m, flush=True)))
        elif a.command == "social":
            from . import social
            print(social.command(con, a.action, target="remote" if a.remote else "local" if a.local else None,
                                 out=Path(a.export), settings=cfg, persist_to=Path(a.persist_to) if a.persist_to else None,
                                 handle=a.handle, list_id=a.list, folder=Path(a.folder)))
        elif a.command == "zenodo":
            _zenodo(con, a)
        elif a.command == "d1":
            from . import d1
            print(d1.command(con, a.action, target="remote" if a.remote else "local", budget=a.budget,
                             state_path=Path(a.state), folder=Path(a.sql_dir), settings=cfg, reset=a.reset))
        elif a.command == "reverify":
            print(f"{harvest.reverify(con, client, opts, maximum=a.max)} papers re-verified")
        if a.command in ("run", "scan", "backfill", "doi", "folder", "reverify", "align", "export"):
            path = catalog.generate(con, Path(a.out), public=a.public, mirror=Path(a.mirror) if a.mirror else None)
            print(f"catalogue → {path}")
        if a.command == "publish-hf":
            from . import publish
            print(publish.publish_hf(Path(a.out), a.dataset, dry_run=a.dry_run,
                                     mirror=Path(a.mirror) if a.mirror else None))
        if a.command == "stats":
            print(json.dumps(catalog.figures(con), ensure_ascii=False, indent=1))
    finally:
        con.commit()
        con.close()
        client.close()
    print(f"({time.time() - t0:.0f} s, requests: {client.requests})", file=sys.stderr)
    return 0
