"""The nightly publication, step by step, and its resumption.

`oscr nightly` runs the steps of `planned`. Each step is recorded in data/state/cycles.db, so that
what failed is known: when today's export succeeded and steps are left, the next run (the watchdog's,
oscr/watchdog.py) does those only, on the export already made, and neither the export (1 h 30) nor
the build (when dist/ is up to date, `publish.deploy_cloudflare`) is done again. The steps are safe
to run twice: what was already sent is known to each of them.

Before anything, `oscr/preflight.py` says what would make the night fail, in words.
"""
from __future__ import annotations

import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import catalog, cycles, preflight, watchdog


def stay_awake() -> None:
    """The Mac does not sleep while this process lives (`caffeinate` follows it and ends with it)."""
    try:
        subprocess.Popen(["/usr/bin/caffeinate", "-i", "-w", str(os.getpid())],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def planned(cfg: dict[str, str], dataset: str, cloudflare: str) -> list[str]:
    """The night's steps, in order, as the settings ask for them."""
    wanted = {"export": True, "forge": cfg.get("OSCR_FORGE_PUSH") == "remote", "dataset": bool(dataset),
              "deploy": bool(cloudflare),
              # The reader-side links (oscr/linkfeeds.py): written every night, sent once set up.
              "linkfeeds": cfg.get("OSCR_LINKFEEDS", "1") != "0",
              "reconcile": "remote" in (cfg.get("OSCR_D1_PUSH"), cfg.get("OSCR_COMMUNITY_PUSH")),
              "search": cfg.get("OSCR_D1_PUSH") == "remote",
              "community": cfg.get("OSCR_COMMUNITY_PUSH") == "remote", "scripts": bool(cfg.get("OSCR_SCRIPTS_DATASET")),
              "contacts": bool(cfg.get("OSCR_CONTACTS_DATASET"))}
    return [name for name, on in wanted.items() if on]


def _forge(con: Any, client: Any, cfg: dict[str, str], out: Path, say: Callable[[str], None]) -> list[str]:
    """The GitHub side (night phase 01, docs/FORGE.md), between the public export and the deployment:
    the public mirrors' heads, then OSCR's static layer into the export. Each part is attempted on
    its own; returns what failed."""
    from . import community, forgejobs, forgelayer, retention, social
    errors = []

    def part(name: str, run: Callable[[], str]) -> None:
        try:
            say(run())
        except (Exception, SystemExit) as e:  # noqa: BLE001, said with the others at the end
            errors.append(f"{name}: {e}")

    def forge_d1() -> Any:
        return community.open_d1("remote", settings=cfg, database="oscr_forge")

    part("Forge mirrors", lambda: "forge mirrors: " + forgejobs.mirrors(
        con, target="remote", folder=Path("data/community"), budget=int(cfg.get("OSCR_COMMUNITY_BUDGET", "10000")),
        settings=cfg, client=client, report=lambda m: print(m, flush=True)))
    part("Forge layer", lambda: "forge layer: " + forgelayer.write(con, forge_d1(), out))
    # Night phase 16: what is kept for a time only, deleted (oscr/retention.py).
    part("Forge retention", lambda: "forge " + retention.run(forge_d1(), budget=int(cfg.get("OSCR_RETENTION_BUDGET", "2000"))))
    # Night phase 08: the social layer's shards and the Explore page (docs/SOCIAL.md).
    part("Social layer", lambda: "social layer: " + social.write(forge_d1(), community.open_d1("remote", settings=cfg), out, con=con))
    if cfg.get("OSCR_D1_PUSH") == "remote":
        # The GitHub side's search index (forge_fts), with the papers' own push switch.
        def search() -> str:
            state = forgelayer.open_state(forgelayer.STATE_FOLDER)
            try:
                return social.push_search(community.open_d1("remote", settings=cfg, database="oscr_search"),
                                          social.search_docs(out), state)
            finally:
                state.close()
        part("Forge search", search)
    return errors


def run(con: Any, client: Any, cfg: dict[str, str], *, out: Path, dataset: str, cloudflare: str,
        resume: bool = False) -> int:
    def say(message: str) -> None:
        print(f"{time.strftime('%Y-%m-%d %H:%M')} {message}", flush=True)

    # One publication at a time (the 04:17 run, or the watchdog's catch-up): the lock is held until
    # this process ends.
    lock = watchdog.acquire_lock()
    if lock is None:
        say("another publication is running: nothing to do")
        return 0
    stay_awake()
    cycles.tidy()
    cycles.reap()
    start = watchdog.last_start(time.time())
    export_done, left = cycles.pending(start)
    steps = planned(cfg, dataset, cloudflare)
    todo = [s for s in steps if s in left] if export_done else []
    resuming = bool(todo)
    if resume and not resuming:
        say("nothing to resume: no step of today's export is left")
        return 0
    if export_done and left and not todo:
        # Steps the settings no longer ask for: the day counts them, so that it ends.
        watchdog.count_resume(start)
        say(f"nothing to resume: {', '.join(left)} are no longer asked for")
        return 0
    if not resuming:
        todo = steps

    problems = preflight.run(cfg, dataset, cloudflare)
    if problems:
        # Nothing was attempted: the watchdog tries again soon (a disk to mount, a network to wait for).
        cid = cycles.start_cycle("nightly")
        said = "; ".join(problems)
        with_step = cycles.start_step(cid, "preflight")
        cycles.finish_step(with_step, ok=False, detail=said)
        cycles.finish_cycle(cid, ok=False, detail=said)
        watchdog.mark("blocked")
        raise SystemExit(f"preflight: {said}")

    watchdog.mark("attempt")
    if resuming:
        watchdog.count_resume(start)
        say(f"resuming today's publication: {', '.join(todo)}")
    cid = cycles.start_cycle("resume" if resuming else "nightly")
    cycles.plan_steps(cid, todo)
    # Night phase 16: a file known as malware loses its text before anything is exported, and the
    # GitHub side's repository holding it is hidden (oscr/malware.py). Nothing is run.
    from . import malware
    if not resuming and malware.load():
        try:
            from . import community
            forge_d1 = community.open_d1("remote", settings=cfg, database="oscr_forge") if cfg.get("OSCR_FORGE_PUSH") == "remote" else None
            say(malware.scan(con, forge_d1))
        except Exception as e:  # noqa: BLE001, the nightly goes on; the harvester already refuses listed files
            say(f"malware scan failed: {e}")
    if "export" in todo:
        with cycles.step(cid, "export"):
            say(f"public catalogue → {catalog.generate(con, out, public=True)}")
    # Nothing leaves when the catalogue is empty or shrank by half: every upload below replaces
    # what is online (the site, D1's deletions, Hugging Face's history).
    articles = con.execute(f"SELECT COUNT(*) FROM article WHERE {catalog.IN_SCOPE}").fetchone()[0]
    if refused := watchdog.refuse_to_publish(articles):
        cycles.finish_cycle(cid, ok=False, detail=refused)
        raise SystemExit(f"{time.strftime('%Y-%m-%d %H:%M')} {refused}")

    # Each upload is attempted on its own: Hugging Face being down does not keep the website from
    # updating, and vice versa.
    errors: list[str] = []

    def step(name: str, label: str, send: Callable[[], list[str] | None]) -> None:
        if name not in todo:
            return
        sid = cycles.start_step(cid, name)
        try:
            failed = send() or []
        except (Exception, SystemExit) as e:  # noqa: BLE001, recorded, and the others still run
            failed = [f"{label}: {e}"]
        cycles.finish_step(sid, ok=not failed, detail="\n".join(failed))
        errors.extend(failed)

    from . import publish
    step("forge", "Forge", lambda: _forge(con, client, cfg, out, say))
    step("dataset", "Hugging Face", lambda: say(publish.publish_hf(out, dataset)))
    step("deploy", "Cloudflare", lambda: say(publish.deploy_cloudflare(out, cloudflare)))

    def linkfeeds() -> None:
        # One link per paper with a page, on Europe PMC and PubMed (docs/BADGE.md); nothing is sent
        # until the owner has registered and set the FTP account.
        from . import linkfeeds as lf
        folder = Path("data/linkfeeds")
        say("linkfeeds: " + lf.write(con, folder, cfg))
        say("linkfeeds: " + lf.upload(folder, cfg))

    step("linkfeeds", "Europe PMC and PubMed links", linkfeeds)

    def compare() -> None:
        # What D1 lost is forgotten here, so that the pushes below send it again (oscr/reconcile.py).
        from . import reconcile
        say(reconcile.run(cfg))

    def search() -> None:
        # The search's databases (docs/SEARCH.md): the day's changes, within the budget.
        from . import d1
        say("search (D1): " + d1.command(con, "push", target="remote", budget=int(cfg.get("OSCR_D1_BUDGET", "80000")),
                                           state_path=Path("data/d1/state.db"), folder=Path("data/d1/sql"), settings=cfg))

    def facts() -> None:
        # The sign-in's facts (docs/ACCOUNTS.md, docs/CONTRIBUTIONS.md): the day's changes.
        from . import community
        say("community (D1): " + community.command(con, "push", target="remote", folder=Path("data/community"),
                                                     budget=int(cfg.get("OSCR_COMMUNITY_BUDGET", "10000")), settings=cfg))

    def scripts() -> None:
        from .cli import _scripts
        say(_scripts(con, "publish", Path("data/scripts"), cfg["OSCR_SCRIPTS_DATASET"],
                       platform=cfg.get("OSCR_PLATFORM_NAME", "OSCR")))

    def contacts() -> None:
        # Private: contacts.publish refuses a dataset that is not private.
        from . import contacts as private
        say(private.publish(con, Path("data/contacts"), cfg["OSCR_CONTACTS_DATASET"],
                              platform=cfg.get("OSCR_PLATFORM_NAME", "OSCR")))

    step("reconcile", "D1 comparison", compare)
    step("search", "Search (D1)", search)
    step("community", "Community (D1)", facts)
    step("scripts", "Scripts on Hugging Face", scripts)
    step("contacts", "Contacts on Hugging Face", contacts)
    # It ran to its end: an upload that failed is said below and the watchdog resumes it.
    watchdog.mark("success")
    watchdog.mark("published", articles)
    cycles.finish_cycle(cid, ok=not errors, detail="\n".join(errors))
    if errors:
        raise SystemExit("\n".join(errors))
    return 0
