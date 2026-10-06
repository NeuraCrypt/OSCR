"""The Mac's read-only view of the forges: GitBackend's counterpart (website/worker/forge/).

**What it is for** (night run 2026-09-28/29, phase 00; docs/DECISIONS.md D00-1 to D00-16). OSCR
hosts no Git repository: repositories live in each researcher's own GitHub account, and OSCR's
GitHub App acts on them with that person's consent, from the Worker. The Mac keeps OSCR's own
layer (links to papers, tracing maps pinned to commits, the licensed script copies) and needs to:

- follow a repository by its durable id, through renames and transfers (``repo_by_id``);
- poll the heads of public mirrors (``head``, with an ETag: an unchanged head costs a free 304);
- check that a tracing map's pinned commit and paths still exist (``has_commit``, ``files``);
- read files at a commit, for licenses, the script copies and alignments (``read``).

**What it never does.** The Mac never writes to a forge, never holds a user token or the GitHub
App's key, and never runs users' code. It reads metadata through the REST API with its own
read-only token (``org.oscr.github``, ``net.github_token``) and files through the git protocol,
with git hardened (``GIT_FLAGS``, ``git_env``): no hook, only the https protocol, no submodule,
no symbolic link, no LFS download, no credential prompt or helper. Clones are partial
(``--filter=blob:none``) and shallow, of one commit; nothing is built, installed or executed.

**Errors** are ``ForgeError`` with the codes of website/worker/forge/errors.ts. A rate limit is
``rate_limited`` with ``retry_after`` and is never waited out here (``patient=False``): the job
runner decides. No email address is copied from an answer (``RepoInfo`` has no field for one);
free text is masked where it is shown (``catalog.mask_emails``, in parity with the website's
``maskEmails`` through tests/fixtures/emails.json).

``reader("github")`` gives the GitHub reader; ``MemoryReader`` is the double of the tests.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote, unquote, urlsplit

from . import net
from .repos import _auth_github

#: The codes of website/worker/forge/errors.ts.
ERROR_CODES: tuple[str, ...] = (
    "invalid", "unauthorized", "forbidden", "not_found", "conflict", "not_mergeable", "archived",
    "gone", "too_large", "rate_limited", "unsupported", "unavailable",
)

FORGES: tuple[str, ...] = ("github", "memory")

#: An owner or a repository name (website/worker/account/repo.ts, `SEGMENT`).
SEGMENT = re.compile(r"^(?!\.+$)[A-Za-z0-9._-]{1,100}$")
OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")

GIT_TIMEOUT_S = 120
#: What `read` returns at most unless told otherwise.
READ_BYTES = 1_000_000

#: Every git call of this module carries these: no hook runs, only https is spoken, submodules
#: are not followed, symbolic links are not made, no credential helper or prompt is asked.
GIT_FLAGS: tuple[str, ...] = (
    "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "submodule.recurse=false",
    "-c", "core.symlinks=false",
    "-c", "credential.helper=",
    "-c", "core.askPass=false",
)


class ForgeError(Exception):
    """A forge's refusal or failure, with a code of ERROR_CODES. The message never holds a token,
    a header or a forge's answer copied as is."""

    def __init__(self, code: str, message: str, retry_after: int | None = None) -> None:
        if code not in ERROR_CODES:
            raise ValueError(f"unknown code {code}")
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


@dataclass(frozen=True)
class RepoRef:
    """A repository by its path (changes on a rename or a transfer)."""
    forge: str
    owner: str
    name: str


@dataclass(frozen=True)
class RepoKey:
    """A repository by the forge's durable id (GitHub: the numeric id, as text)."""
    forge: str
    id: str


@dataclass(frozen=True)
class RepoInfo:
    key: RepoKey
    ref: RepoRef
    default_branch: str | None
    archived: bool
    visibility: str
    pushed_at: str | None
    license_spdx: str | None
    size_kb: int
    web_url: str


@dataclass(frozen=True)
class Head:
    branch: str
    sha: str
    etag: str | None


class ForgeReader(Protocol):
    def repo(self, ref: RepoRef) -> RepoInfo: ...

    def repo_by_id(self, key: RepoKey) -> RepoInfo:
        """Follows renames and transfers."""
        ...

    def head(self, ref: RepoRef, branch: str | None = None, etag: str | None = None) -> Head | None:
        """A branch's head (the default branch when none is named); None when unchanged since
        `etag` (a 304, which costs no quota)."""
        ...

    def has_commit(self, ref: RepoRef, sha: str) -> bool: ...

    def files(self, ref: RepoRef, sha: str) -> list[str]: ...

    def read(self, ref: RepoRef, sha: str, path: str, max_bytes: int = READ_BYTES) -> bytes: ...


# ─── checks, before any request ──────────────────────────────────────────

def check_ref(ref: RepoRef) -> RepoRef:
    if ref.forge not in FORGES or not SEGMENT.match(ref.owner) or not SEGMENT.match(ref.name) \
            or ref.name.lower().endswith(".git"):
        raise ForgeError("invalid", "not a repository")
    return ref


def check_sha(sha: str) -> str:
    if not isinstance(sha, str) or not OBJECT_ID.match(sha):
        raise ForgeError("invalid", "not a full object id")
    return sha


def check_branch(name: str) -> str:
    """A subset of `git check-ref-format`, as website/worker/forge/paths.ts."""
    if not isinstance(name, str) or not name or name == "@" or len(name.encode()) > 255 \
            or name.startswith("/") or name.endswith(("/", ".")) or ".." in name or "@{" in name \
            or re.search(r"[\x00-\x20\x7f~^:?*\[\\]", name) \
            or any(not c or c.startswith(".") or c.endswith(".lock") for c in name.split("/")):
        raise ForgeError("invalid", "not a branch name")
    return name


def check_path(path: str) -> str:
    """Relative, "/"-separated, NFC; no empty component, no "." or "..", never into .git."""
    if not isinstance(path, str):
        raise ForgeError("invalid", "not a path")
    p = unicodedata.normalize("NFC", path)
    if not p or len(p.encode()) > 4096 or "\x00" in p \
            or any(c in ("", ".", "..") or c.lower() == ".git" for c in p.split("/")):
        raise ForgeError("invalid", "not a path")
    return p


def git_env() -> dict[str, str]:
    """git's environment here: no LFS download, no prompt, no system configuration."""
    return dict(os.environ, GIT_LFS_SKIP_SMUDGE="1", GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="false",
                SSH_ASKPASS="false", GIT_CONFIG_NOSYSTEM="1")


# ─── GitHub ───────────────────────────────────────────────────────────────

def _error(r: net.Response, now: float) -> ForgeError:
    """GitHub's answer as a ForgeError (the table of website/worker/forge/github/http.ts)."""
    s = r.status
    h = r.headers
    if s == 0 or s >= 500:
        return ForgeError("unavailable", f"the forge did not answer ({s})")
    if s in (403, 429):
        if h.get("x-ratelimit-remaining") == "0":
            reset = h.get("x-ratelimit-reset", "")
            wait = max(1, int(reset) - int(now)) if reset.isdigit() else 60
            return ForgeError("rate_limited", "the forge's hourly quota is spent", retry_after=wait)
        after = h.get("retry-after", "")
        if after.isdigit():
            return ForgeError("rate_limited", "the forge asks to slow down", retry_after=max(1, int(after)))
        if s == 429:
            return ForgeError("rate_limited", "the forge asks to slow down", retry_after=60)
        return ForgeError("forbidden", "the forge refused this")
    return ForgeError({401: "unauthorized", 404: "not_found", 409: "conflict", 410: "gone", 413: "too_large",
                       451: "gone"}.get(s, "invalid"), f"the forge answered {s}")


def _info(data: Any) -> RepoInfo:
    """A repository as the forge describes it. `email` is never read."""
    try:
        owner = data["owner"]["login"]
        spdx = (data.get("license") or {}).get("spdx_id")
        visibility = data.get("visibility") or ("private" if data.get("private") else "public")
        return RepoInfo(
            key=RepoKey("github", str(int(data["id"]))),
            ref=RepoRef("github", str(owner), str(data["name"])),
            default_branch=data.get("default_branch"),
            archived=bool(data.get("archived", False)),
            visibility=str(visibility),
            pushed_at=data.get("pushed_at"),
            license_spdx=spdx if spdx and spdx != "NOASSERTION" else None,
            size_kb=int(data.get("size") or 0),
            web_url=str(data["html_url"]),
        )
    except (KeyError, TypeError, ValueError) as e:
        raise ForgeError("unavailable", "unexpected answer from the forge") from e


Runner = Callable[..., subprocess.CompletedProcess]


class GitHubReader:
    """GitHub, read only: REST for `repo`, `repo_by_id`, `head` and `has_commit` (the Mac's
    read-only token, polite per host, never waiting out a quota); git for `files` and `read`, a
    partial shallow clone of one commit per repository, kept for the reader's life (`close()`
    removes it)."""

    def __init__(self, client: net.Client | None = None, *, api: str = "https://api.github.com",
                 web: str = "https://github.com", runner: Runner = subprocess.run,
                 workdir: Path | None = None, clock: Callable[[], float] = time.time) -> None:
        self.client = client if client is not None else net.Client()
        self.api = api.rstrip("/")
        self.web = web.rstrip("/")
        self.runner = runner
        self.workdir = workdir
        self.clock = clock
        self._clones: dict[tuple[str, str, str], Path] = {}

    # REST

    def _get(self, path: str, headers: dict[str, str] | None = None) -> net.Response:
        h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", **(headers or {})}
        r = self.client.get(f"{self.api}{path}", headers=h, patient=False)
        if r.status == 304 or r.ok:
            return r
        raise _error(r, self.clock())

    @staticmethod
    def _repo_path(ref: RepoRef) -> str:
        check_ref(ref)
        return f"/repos/{quote(ref.owner, safe='')}/{quote(ref.name, safe='')}"

    def _json(self, r: net.Response) -> Any:
        try:
            return r.json()
        except ValueError as e:
            raise ForgeError("unavailable", "unexpected answer from the forge") from e

    def repo(self, ref: RepoRef) -> RepoInfo:
        return _info(self._json(self._get(self._repo_path(ref))))

    def repo_by_id(self, key: RepoKey) -> RepoInfo:
        if key.forge != "github" or not re.fullmatch(r"\d{1,20}", key.id):
            raise ForgeError("invalid", "not a GitHub repository id")
        return _info(self._json(self._get(f"/repositories/{key.id}")))

    def head(self, ref: RepoRef, branch: str | None = None, etag: str | None = None) -> Head | None:
        path = self._repo_path(ref)
        if branch is None:
            branch = self.repo(ref).default_branch
            if not branch:
                raise ForgeError("not_found", "the repository has no branch")
        check_branch(branch)
        r = self._get(f"{path}/branches/{quote(branch, safe='/')}", {"If-None-Match": etag} if etag else None)
        if r.status == 304:
            return None
        data = self._json(r)
        try:
            sha = check_sha(data["commit"]["sha"])
        except (KeyError, TypeError, ForgeError) as e:
            raise ForgeError("unavailable", "unexpected answer from the forge") from e
        return Head(branch=branch, sha=sha, etag=r.headers.get("etag"))

    def has_commit(self, ref: RepoRef, sha: str) -> bool:
        path = f"{self._repo_path(ref)}/commits/{check_sha(sha)}"
        try:
            self._get(path, {"Accept": "application/vnd.github.sha"})
        except ForgeError as e:
            if e.code in ("not_found", "invalid", "conflict"):
                return False
            raise
        return True

    # git

    def _git(self, args: list[str], *, binary: bool = False) -> subprocess.CompletedProcess:
        # The Mac's read-only token rides in a header when there is one (repos._auth_github).
        cmd = ["git", *GIT_FLAGS, *_auth_github(), *args]
        try:
            return self.runner(cmd, env=git_env(), capture_output=True, text=not binary, timeout=GIT_TIMEOUT_S)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise ForgeError("unavailable", "git did not answer") from e

    @staticmethod
    def _stderr(p: subprocess.CompletedProcess) -> str:
        err = p.stderr
        return err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err or "")

    def _failed(self, p: subprocess.CompletedProcess, what: str) -> ForgeError:
        err = self._stderr(p)
        if re.search(r"not found|not our ref|couldn't find remote ref|does not exist|exists on disk, but not in|"
                     r"invalid object name|bad revision|unadvertised object", err, re.I):
            return ForgeError("not_found", f"{what}: not found")
        if re.search(r"Authentication failed|could not read Username|terminal prompts disabled", err, re.I):
            return ForgeError("not_found", f"{what}: not found (or not public)")
        return ForgeError("unavailable", f"{what}: git failed")

    def _clone(self, ref: RepoRef, sha: str) -> Path:
        """A partial, shallow clone of this one commit (no file content until read)."""
        check_ref(ref)
        check_sha(sha)
        key = (ref.owner.lower(), ref.name.lower(), sha)
        if key in self._clones:
            return self._clones[key]
        d = Path(tempfile.mkdtemp(prefix="oscr-forge-", dir=self.workdir))
        url = f"{self.web}/{quote(ref.owner, safe='')}/{quote(ref.name, safe='')}.git"
        for args in (["init", "--quiet", str(d)],
                     ["-C", str(d), "remote", "add", "origin", url],
                     ["-C", str(d), "fetch", "--quiet", "--depth=1", "--filter=blob:none", "--no-tags",
                      "--no-recurse-submodules", "origin", sha]):
            p = self._git(args)
            if p.returncode != 0:
                shutil.rmtree(d, ignore_errors=True)
                raise self._failed(p, "the commit")
        self._clones[key] = d
        return d

    def files(self, ref: RepoRef, sha: str) -> list[str]:
        d = self._clone(ref, sha)
        p = self._git(["-C", str(d), "ls-tree", "-r", "-z", "--name-only", sha])
        if p.returncode != 0:
            raise self._failed(p, "the tree")
        return [f for f in str(p.stdout).split("\x00") if f]

    def read(self, ref: RepoRef, sha: str, path: str, max_bytes: int = READ_BYTES) -> bytes:
        p = check_path(path)
        d = self._clone(ref, sha)
        size = self._git(["-C", str(d), "cat-file", "-s", f"{sha}:{p}"])
        if size.returncode != 0:
            raise self._failed(size, "the file")
        try:
            n = int(str(size.stdout).strip())
        except ValueError as e:
            raise ForgeError("unavailable", "unexpected answer from git") from e
        if n > max_bytes:
            raise ForgeError("too_large", f"the file is larger than {max_bytes} bytes")
        blob = self._git(["-C", str(d), "cat-file", "blob", f"{sha}:{p}"], binary=True)
        if blob.returncode != 0:
            raise self._failed(blob, "the file")
        return bytes(blob.stdout)

    def close(self) -> None:
        for d in self._clones.values():
            shutil.rmtree(d, ignore_errors=True)
        self._clones.clear()


# ─── the double ───────────────────────────────────────────────────────────

@dataclass
class _MemRepo:
    info: RepoInfo
    branches: dict[str, str] = field(default_factory=dict)
    commits: dict[str, dict[str, bytes]] = field(default_factory=dict)


class MemoryReader:
    """A dict-backed ForgeReader for the tests: repositories by id, old paths that redirect,
    branch heads with ETags, and the files of each commit."""

    def __init__(self) -> None:
        self._repos: dict[str, _MemRepo] = {}
        self._paths: dict[tuple[str, str], str] = {}
        #: Calls made, as (method, arguments): what a test counts.
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def add(self, owner: str, name: str, *, id: str, files: dict[str, bytes], sha: str,
            branch: str = "main", license_spdx: str | None = None, archived: bool = False) -> RepoRef:
        ref = RepoRef("memory", owner, name)
        info = RepoInfo(RepoKey("memory", id), ref, branch, archived, "public", None, license_spdx,
                        sum(len(b) for b in files.values()) // 1024, f"https://memory.forge.test/{owner}/{name}")
        self._repos[id] = _MemRepo(info, {branch: check_sha(sha)}, {sha: dict(files)})
        self._paths[(owner.lower(), name.lower())] = id
        return ref

    def push(self, id: str, branch: str, sha: str, files: dict[str, bytes]) -> None:
        r = self._repos[id]
        r.branches[check_branch(branch)] = check_sha(sha)
        r.commits[sha] = dict(files)

    def rename(self, id: str, owner: str, name: str) -> None:
        """A rename or a transfer: the old path still redirects, as GitHub's does for a while."""
        r = self._repos[id]
        r.info = RepoInfo(r.info.key, RepoRef("memory", owner, name), r.info.default_branch, r.info.archived,
                          r.info.visibility, r.info.pushed_at, r.info.license_spdx, r.info.size_kb,
                          f"https://memory.forge.test/{owner}/{name}")
        self._paths[(owner.lower(), name.lower())] = id

    def _find(self, ref: RepoRef) -> _MemRepo:
        check_ref(ref)
        id = self._paths.get((ref.owner.lower(), ref.name.lower()))
        if id is None:
            raise ForgeError("not_found", "no such repository")
        return self._repos[id]

    def repo(self, ref: RepoRef) -> RepoInfo:
        self.calls.append(("repo", (ref,)))
        return self._find(ref).info

    def repo_by_id(self, key: RepoKey) -> RepoInfo:
        self.calls.append(("repo_by_id", (key,)))
        if key.forge != "memory" or key.id not in self._repos:
            raise ForgeError("not_found", "no such repository")
        return self._repos[key.id].info

    def head(self, ref: RepoRef, branch: str | None = None, etag: str | None = None) -> Head | None:
        self.calls.append(("head", (ref, branch, etag)))
        r = self._find(ref)
        name = check_branch(branch or r.info.default_branch or "")
        if name not in r.branches:
            raise ForgeError("not_found", "no such branch")
        sha = r.branches[name]
        tag = f'"{sha}"'
        return None if etag == tag else Head(name, sha, tag)

    def has_commit(self, ref: RepoRef, sha: str) -> bool:
        self.calls.append(("has_commit", (ref, sha)))
        return check_sha(sha) in self._find(ref).commits

    def files(self, ref: RepoRef, sha: str) -> list[str]:
        self.calls.append(("files", (ref, sha)))
        commit = self._find(ref).commits.get(check_sha(sha))
        if commit is None:
            raise ForgeError("not_found", "no such commit")
        return sorted(commit)

    def read(self, ref: RepoRef, sha: str, path: str, max_bytes: int = READ_BYTES) -> bytes:
        self.calls.append(("read", (ref, sha, path)))
        commit = self._find(ref).commits.get(check_sha(sha))
        p = check_path(path)
        if commit is None or p not in commit:
            raise ForgeError("not_found", "no such file")
        if len(commit[p]) > max_bytes:
            raise ForgeError("too_large", f"the file is larger than {max_bytes} bytes")
        return commit[p]


def reader(forge: str) -> ForgeReader:
    """The reader of a forge: GitHub's, or the test double."""
    if forge == "github":
        return GitHubReader()
    if forge == "memory":
        return MemoryReader()
    raise ForgeError("unsupported", f"no reader for {forge!r}")


# ─── trace points: permalinks (night phase 02, E4) ───────────────────────

#: GitHub's line anchors: #L3, #L3-L7 (either order); columns (#L3C1-L7C9) are ignored.
_LINE_ANCHOR = re.compile(r"^L(\d{1,7})(?:C\d{1,5})?(?:-L(\d{1,7})(?:C\d{1,5})?)?$")
_UNSAFE_URL = re.compile(r"[\s\x00-\x1f\x7f\\]|%(?![0-9A-Fa-f]{2})|%2f", re.IGNORECASE)
_DOT_SEGMENT = re.compile(r"/(?:\.|%2e){1,2}(?=/|$|[?#])", re.IGNORECASE)


@dataclass(frozen=True)
class TracePoint:
    """A place in a repository's history: a file at a commit id, and its lines if any."""
    forge: str
    owner: str
    name: str
    commit: str
    path: str
    lines: tuple[int, int] | None

    def as_dict(self) -> dict[str, Any]:
        return {"forge": self.forge, "owner": self.owner, "name": self.name, "commit": self.commit,
                "path": self.path,
                "lines": None if self.lines is None else {"start": self.lines[0], "end": self.lines[1]}}


def parse_permalink(url: str, *, web: str = "https://github.com",
                    sites: tuple[str, ...] = ()) -> TracePoint | None:
    """A permalink → its trace point, or None: GitHub's ``https://github.com/<o>/<r>/blob/<sha>/
    <path>#L1-L5`` and the registry's own ``/r/<o>/<r>/blob/<sha>/<path>#L1-L5`` (relative, or on
    one of ``sites``). An address at a branch is none (it moves). The website reads them the same
    way (website/src/lib/traced.ts ``parsePermalink``; both checked against
    tests/fixtures/permalinks.json)."""
    if not isinstance(url, str) or not url or len(url) > 4096 or _UNSAFE_URL.search(url) \
            or _DOT_SEGMENT.search(url):
        return None
    relative = url.startswith("/") and not url.startswith("//")
    if not relative and not re.match(r"^https?://", url, re.IGNORECASE):
        return None
    try:
        u = urlsplit(url)
        w = urlsplit(web)
    except ValueError:
        return None
    try:
        parts = [unquote(p, errors="strict") for p in u.path.split("/")]
    except UnicodeDecodeError:
        return None
    if parts[0] != "":
        return None
    parts = parts[1:]
    host = (u.hostname or "").lower()
    site_hosts = {(urlsplit(s).hostname or "").lower() for s in sites}
    if relative or host in site_hosts:
        if not parts or parts[0] != "r":
            return None
        parts = parts[1:]
    elif host == (w.hostname or "").lower():
        if u.scheme.lower() != w.scheme.lower():
            return None
    else:
        return None
    if len(parts) < 5:
        return None
    owner, name, kind, commit, *rest = parts
    if kind != "blob" or not OBJECT_ID.match(commit) or not SEGMENT.match(owner) or not SEGMENT.match(name):
        return None
    if not rest or any(s in ("", ".", "..") or re.search(r"[\x00-\x1f]", s) for s in rest):
        return None
    lines: tuple[int, int] | None = None
    if u.fragment:
        m = _LINE_ANCHOR.match(u.fragment)
        a = int(m.group(1)) if m else 0
        b = int(m.group(2) or m.group(1)) if m else 0
        if not m or a < 1 or b < 1:
            return None
        lines = (min(a, b), max(a, b))
    return TracePoint("github", owner, re.sub(r"\.git$", "", name, flags=re.IGNORECASE), commit,
                      "/".join(rest), lines)
