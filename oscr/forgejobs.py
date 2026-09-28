"""The GitHub side (night phase 01), on the Mac: the forge jobs (link, push, archive, delete_due,
reconcile) and the polling of public mirrors (docs/FORGE.md, "The Mac's jobs").

STUB, created by the foundation (F) of phase 01 so that `oscr forge`, `oscr jobs poll` and
`oscr nightly` have their hooks; owned by E9, which builds it. Until then every entry point says it
is not built, and nothing is read or written.

    oscr forge poll --local|--remote      the forge jobs
    oscr forge mirrors --local|--remote   the public mirrors' heads
    oscr forge status                     what was done, the rows written today
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

# The Mac's state of the forge jobs, in data/community/state.db (shared with the facts push and
# the community jobs): the contract oscr/forgelayer.py reads (forge_commit, forge_archive).
STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS forge_job (
    target      TEXT NOT NULL,              -- local | remote
    id          INTEGER NOT NULL,           -- oscr_forge jobs.id
    kind        TEXT NOT NULL,
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    ref         TEXT NOT NULL DEFAULT '',
    user_id     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    not_before  INTEGER,
    status      TEXT NOT NULL DEFAULT 'new',   -- new | done | skipped | failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT '',
    updated_at  REAL NOT NULL,
    PRIMARY KEY (target, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_cursor (
    target   TEXT PRIMARY KEY,
    last_id  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS forge_repo (
    target      TEXT NOT NULL,
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,              -- a repository some job named: the mirrors read it by key
    learned_at  REAL NOT NULL,
    PRIMARY KEY (target, forge, repo_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_etag (
    target      TEXT NOT NULL,
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    branch      TEXT NOT NULL,
    sha         TEXT NOT NULL,
    etag        TEXT NOT NULL DEFAULT '',
    checked_at  REAL NOT NULL,
    PRIMARY KEY (target, forge, repo_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_commit (
    target      TEXT NOT NULL,
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    sha         TEXT NOT NULL,
    reachable   INTEGER NOT NULL,           -- 1: still at the source; 0: no longer
    checked_at  REAL NOT NULL,
    PRIMARY KEY (target, forge, repo_id, sha)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_archive (
    target          TEXT NOT NULL,
    job_id          INTEGER NOT NULL,
    forge           TEXT NOT NULL,
    repo_id         TEXT NOT NULL,
    url             TEXT NOT NULL,
    at              REAL NOT NULL,
    http_status     INTEGER NOT NULL,
    request_status  TEXT NOT NULL DEFAULT '',
    task_status     TEXT NOT NULL DEFAULT '',
    request_id      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (target, job_id)
) WITHOUT ROWID;
"""


class NotBuilt(RuntimeError):
    """This part of the GitHub side is not built yet (phase 01, E9)."""


def command(con: Any, action: str, *, target: str | None, folder: Path, **_: Any) -> str:
    """`oscr forge poll|mirrors|status`: not built yet."""
    raise SystemExit(f"forge {action}: not built yet (night phase 01, E9)")


def mirrors(con: Any, *, target: str, folder: Path, **_: Any) -> str:
    """The public mirrors' heads, for `oscr nightly`: not built yet."""
    raise NotBuilt("the forge mirrors are not built yet (night phase 01, E9)")
