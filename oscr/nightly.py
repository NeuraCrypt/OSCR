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
import signal
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import catalog, cycles, preflight, watchdog

#: The night must be over this long before the next 04:17 (watchdog.NIGHTLY_AT), when the next one
#: starts: launchd does not start a job that is still running, so a night that runs over swallows the
#: next (2026-11-06). Every step stops at that hour, whatever its own limit.
NIGHT_MARGIN_S = 30 * 60
#: Each step's own limit, in seconds (the longest seen on 2026-11-06: export 5 h, deploy with its
#: build 7 h 11, when the 1,024 lots were all sent again every night). Any other step: STEP_LIMIT_S.
STEP_LIMITS_S: dict[str, float] = {"export": 6 * 3600, "forge": 3600, "dataset": 3 * 3600, "deploy": 6 * 3600}
STEP_LIMIT_S = 3600
#: A resumption with less time than this before the night's end does not start: the 04:17 run is near.
MIN_START_S = 20 * 60


class NightTooLong(Exception):
    """A step went past its limit or the night's end: the night stops there, its cycle failed."""


def night_end(now: float) -> float:
    """The hour this run must be over: the next 04:17 after `now`, less NIGHT_MARGIN_S."""
    at = datetime.fromtimestamp(now).replace(hour=watchdog.NIGHTLY_AT[0], minute=watchdog.NIGHTLY_AT[1],
                                             second=0, microsecond=0)
    if at.timestamp() <= now:
        at += timedelta(days=1)
    return at.timestamp() - NIGHT_MARGIN_S


@contextmanager
def limited(name: str, until: float) -> Iterator[None]:
    """Run the block for at most its step's limit and never past `until`: past it, NightTooLong is
    raised in the block (a SIGALRM: a subprocess under way is killed by subprocess.run as the error
    goes through; a long SQLite call is stopped when it returns)."""
    started = time.time()
    own = STEP_LIMITS_S.get(name, STEP_LIMIT_S)
    limit = min(own, until - started)
    why = (f"its limit is {own / 60:.0f} min" if own <= until - started
           else f"the night must end by {time.strftime('%H:%M', time.localtime(until))}, before the next 04:17")
    if limit <= 0:
        raise NightTooLong(f"night too long: no time left for step {name} ({why})")

    def ring(signum: int, frame: Any) -> None:
        raise NightTooLong(f"night too long: step {name} stopped after {(time.time() - started) / 60:.0f} min ({why})")

    previous = signal.signal(signal.SIGALRM, ring)
    signal.setitimer(signal.ITIMER_REAL, limit)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


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
              # The partners' files (oscr/outreach.py), every night; Software Heritage only when turned on.
              "outreach": cfg.get("OSCR_OUTREACH", "1") != "0",
              "swh": cfg.get("OSCR_SWH", "1") != "0",
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
    # What a dead run left (about the public database's size, 2026-11-05) is freed before the space
    # is counted: the lock is ours, no build is running.
    freed = catalog.remove_public_db_leftovers(out)
    if freed:
        say(f"removed the leftovers of a dead export: {freed / 1e9:.1f} GB freed")
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

    problems = preflight.run(cfg, dataset, cloudflare, need=preflight.needed(out, export="export" in todo))
    if problems:
        # Nothing was attempted: the watchdog tries again soon (a disk to mount, a network to wait for).
        cid = cycles.start_cycle("nightly")
        said = "; ".join(problems)
        with_step = cycles.start_step(cid, "preflight")
        cycles.finish_step(with_step, ok=False, detail=said)
        cycles.finish_cycle(cid, ok=False, detail=said)
        watchdog.mark("blocked")
        raise SystemExit(f"preflight: {said}")

    until = night_end(time.time())
    if resuming and until - time.time() < MIN_START_S:
        say(f"nothing resumed: the night ends at {time.strftime('%H:%M', time.localtime(until))}, the 04:17 run is near")
        return 0
    watchdog.mark("attempt")
    if resuming:
        watchdog.count_resume(start)
        say(f"resuming today's publication: {', '.join(todo)}")
    # When the data being published was exported: a resumption publishes today's export (its day began
    # at `start`); otherwise this run's. A run that began before today's 04:17 does not count as
    # today's night (watchdog.nightly_due).
    begun = start if resuming else time.time()
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
    # The scripts' text lots, kept from night to night on the external disk (oscr/scriptlots.py): the
    # first time, the lots online (website/public/scripts) are taken in as they are, frozen.
    from . import publish, scriptlots
    lots = scriptlots.site_store(publish.WEBSITE, cfg)

    def too_long(e: NightTooLong) -> SystemExit:
        # The night stops cleanly: its cycle failed with the reason, what was not run stays pending.
        cycles.finish_cycle(cid, ok=False, detail=str(e))
        return SystemExit(f"{time.strftime('%Y-%m-%d %H:%M')} {e}")

    if "export" in todo:
        try:
            with cycles.step(cid, "export"), limited("export", until):
                if (adopted := lots.adopt(publish.WEBSITE / "public" / "scripts")):
                    say(f"script lots: the {adopted} lots online are kept as they are, in {lots.lots}")
                heavy = scriptlots.heavy_folder(publish.WEBSITE, cfg)
                say(f"public catalogue → {catalog.generate(con, out, public=True, lots=lots, heavy=heavy)}")
        except NightTooLong as e:
            raise too_long(e) from e
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
            with limited(name, until):
                failed = send() or []
        except NightTooLong as e:
            cycles.finish_step(sid, ok=False, detail=str(e))
            raise too_long(e) from e
        except (Exception, SystemExit) as e:  # noqa: BLE001, recorded, and the others still run
            failed = [f"{label}: {e}"]
        cycles.finish_step(sid, ok=not failed, detail="\n".join(failed))
        errors.extend(failed)

    step("forge", "Forge", lambda: _forge(con, client, cfg, out, say))
    step("dataset", "Hugging Face", lambda: say(publish.publish_hf(out, dataset)))
    step("deploy", "Cloudflare", lambda: say(publish.deploy_cloudflare(out, cloudflare, lots=lots, until=until)))

    def linkfeeds() -> None:
        # One link per paper with a page, on Europe PMC and PubMed (docs/BADGE.md); nothing is sent
        # until the owner has registered and set the FTP account.
        from . import linkfeeds as lf
        folder = Path("data/linkfeeds")
        say("linkfeeds: " + lf.write(con, folder, cfg))
        say("linkfeeds: " + lf.upload(folder, cfg))

    step("linkfeeds", "Europe PMC and PubMed links", linkfeeds)

    def outreach() -> None:
        # The files the partners read (docs/BADGE_OUTREACH.md), for the owner to send: nothing is sent.
        from . import outreach as o
        say("outreach: " + o.write(con, Path("data/outreach"), cfg))

    step("outreach", "the partners' files", outreach)

    def swh() -> None:
        # A few "Save code now" requests a night, anonymous (decided 2026-11-04; OSCR_SWH=0 stops it).
        from . import outreach as o
        say(o.swh_save(con, Path("data/outreach"), cfg))

    step("swh", "Software Heritage", swh)

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
    watchdog.mark("success_begun", begun)
    watchdog.mark("published", articles)
    cycles.finish_cycle(cid, ok=not errors, detail="\n".join(errors))
    if errors:
        raise SystemExit("\n".join(errors))
    return 0
