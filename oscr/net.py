"""The network: a polite client that waits, retries and keeps what it has read.

**Why a single client.** Every source of the harvester is a free public service
queried without a key. What keeps them free is not hammering them. Politeness
therefore cannot be left to each module: a minimum interval PER HOST is enforced
here, once and for all.

**Why an on-disk cache.** A full text does not change, and resuming after an
outage must not download anything again. The cache lives in `data/cache/`,
never published: we host neither the PDF nor the full text of an article, only
what we extracted from it.

**What it does not send.** No contact address by default. Crossref and OpenAlex
serve requests that carry one better (the "polite pool"); it is up to the user
to give it, through the `OSCR_CONTACT` variable.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any
from urllib.parse import urlsplit

import httpx

#: Minimum interval between two requests to the same host, in seconds.
#: Europe PMC sustained 1.4 requests/s without throttling (measured 2026-09-25);
#: Zenodo limits guests to 60 requests/minute; the anonymous GitHub API grants
#: only 60 per hour — it is only called with a token.
INTERVALS: dict[str, float] = {
    "www.ebi.ac.uk": 0.75,
    "api.crossref.org": 0.5,
    "api.datacite.org": 0.5,
    # Zenodo: 60/min AND 2,000/h for a guest — the hourly limit is the one that bites.
    "zenodo.org": 1.8,
    "api.github.com": 0.8,
    "api.osf.io": 0.5,
    "api.figshare.com": 0.5,
    "huggingface.co": 0.5,
    "archive.softwareheritage.org": 1.0,
}
DEFAULT_INTERVAL: float = 1.0

#: The statuses worth another attempt: too many requests, and transient server
#: failures. A 404 is an answer, not an outage.
RETRYABLE: frozenset[int] = frozenset({429, 500, 502, 503, 504})
ATTEMPTS: int = 4
MAX_WAIT_S: float = 120.0

USER_AGENT: str = "oscr/0.2 (Open Scientific Code Registry; native-code harvester)"



class Outage(RuntimeError):
    """The network or the server failed, not the resource: retry later, and above
    all conclude nothing (a paper read during an outage is not a paper
    "without full text")."""


class Unavailable(RuntimeError):
    """The server answers, but not for this resource: it fails alone, again and again
    (Europe PMC's full text of PMC13324234 answered 500 for hours on 2026-09-26 while
    every other one came back). Not an outage: waiting would block the pass forever."""


def is_transient(status: int) -> bool:
    """An outage response (network down, server overloaded), not an answer about the resource."""
    return status == 0 or status in RETRYABLE


def contact() -> str:
    """The address the user chose to declare, or nothing."""
    return os.environ.get("OSCR_CONTACT", "").strip()


@dataclass
class Response:
    url: str
    status: int
    text: str
    from_cache: bool = False
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def json(self) -> Any:
        return json.loads(self.text) if self.text else None


class Cache:
    """One file per URL, named by the digest of the URL."""

    def __init__(self, folder: Path) -> None:
        self.folder = Path(folder)

    def _path(self, key: str) -> Path:
        h = hashlib.sha256(key.encode()).hexdigest()
        return self.folder / h[:2] / h

    def read(self, key: str, ttl_s: float | None) -> Response | None:
        p = self._path(key)
        meta = p.with_suffix(".meta")
        if not p.exists() or not meta.exists():
            return None
        m = json.loads(meta.read_text())
        if ttl_s is not None and time.time() - m["t"] > ttl_s:
            return None
        return Response(url=m["url"], status=m["status"], text=p.read_text(), from_cache=True)

    def write(self, key: str, r: Response) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Write next to it, then rename: an interruption halfway never leaves a
        # truncated file that the next read would take for complete.
        tmp = p.with_suffix(".tmp")
        tmp.write_text(r.text)
        tmp.replace(p)
        p.with_suffix(".meta").write_text(json.dumps(
            {"url": r.url, "status": r.status, "t": time.time()}))


class Client:
    """The harvester's HTTP client. Synchronous, polite, cached."""

    def __init__(self, cache: Cache | None = None, *, timeout_s: float = 30.0,
                 offline: bool = False) -> None:
        self.cache = cache
        self.offline = offline
        ua = USER_AGENT + (f" mailto:{contact()}" if contact() else "")
        self._http = httpx.Client(timeout=timeout_s, follow_redirects=True,
                                  headers={"User-Agent": ua})
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()
        #: Requests actually sent, per host — the network cost of a pass.
        self.requests: dict[str, int] = {}

    def close(self) -> None:
        self._http.close()

    def _wait(self, host: str, url: str = "") -> None:
        with self._lock:
            gap = INTERVALS.get(host, DEFAULT_INTERVAL)
            if host == "api.github.com" and "/search/" in url:
                # GitHub search has its own quota: 10/min without a token, 30 with one.
                gap = 2.1 if os.environ.get("GITHUB_TOKEN") else 6.5
                host = "api.github.com/search"
            remaining = self._last.get(host, 0.0) + gap - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
            self._last[host] = time.monotonic()

    def _headers(self, host: str) -> dict[str, str]:
        token = os.environ.get("GITHUB_TOKEN", "").strip()
        if host == "api.github.com" and token:
            return {"Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json"}
        return {}

    def get(self, url: str, *, params: dict[str, Any] | None = None,
            ttl_s: float | None = None, headers: dict[str, str] | None = None,
            method: str = "GET", patient: bool = True) -> Response:
        """A polite GET (or HEAD). `ttl_s=None`: no cache; `float('inf')`: keep
        forever (a full text). `patient=False`: an exhausted quota (429, or 403
        with zero quota left) returns the response instead of waiting — for a
        service this pass can do without."""
        key = str(httpx.URL(url, params=params)) if params else url
        if self.cache is not None and ttl_s is not None and method == "GET":
            seen = self.cache.read(key, None if ttl_s == float("inf") else ttl_s)
            if seen is not None:
                return seen
        if self.offline:
            return Response(url=key, status=0, text="")
        host = urlsplit(url).hostname or ""
        h = dict(self._headers(host))
        h.update(headers or {})
        last_error: Exception | None = None
        for attempt in range(ATTEMPTS):
            self._wait(host, url)
            self.requests[host] = self.requests.get(host, 0) + 1
            try:
                r = self._http.request(method, url, params=params, headers=h)
            except httpx.TransportError as e:
                last_error = e
                time.sleep(min(MAX_WAIT_S, 2.0 ** attempt))
                continue
            # GitHub says "quota exhausted" with a 403, not a 429: without this
            # case, the search silently returned zero repositories.
            quota = r.status_code == 403 and r.headers.get("x-ratelimit-remaining") == "0"
            if not patient and (r.status_code == 429 or quota):
                return Response(url=str(r.url), status=r.status_code, text="",
                                headers={k.lower(): v for k, v in r.headers.items()})
            if (r.status_code in RETRYABLE or quota) and attempt < ATTEMPTS - 1:
                time.sleep(_retry_delay(r, attempt))
                continue
            resp = Response(url=str(r.url), status=r.status_code,
                            text=r.text if method == "GET" else "",
                            headers={k.lower(): v for k, v in r.headers.items()})
            # Only what has a chance of staying true is kept: a 2xx response, or
            # a 404 (the repository does not exist). An outage is never cached.
            if (self.cache is not None and ttl_s is not None and method == "GET"
                    and (resp.ok or resp.status in (404, 410))):
                self.cache.write(key, resp)
            return resp
        return Response(url=key, status=0, text=f"network outage: {last_error!r}")


    def _stream(self, url: str, max_bytes: int, out: IO[bytes]) -> bool:
        """Stream `url` into `out`, abandoned beyond `max_bytes`: a 4 GB data
        archive must not be read to look for three scripts in it. True if the
        whole file arrived."""
        if self.offline:
            return False
        host = urlsplit(url).hostname or ""
        for attempt in range(ATTEMPTS):
            self._wait(host, url)
            self.requests[host] = self.requests.get(host, 0) + 1
            out.seek(0)
            out.truncate()
            try:
                with self._http.stream("GET", url, headers=self._headers(host)) as r:
                    if r.status_code in RETRYABLE and attempt < ATTEMPTS - 1:
                        time.sleep(_retry_delay(r, attempt))
                        continue
                    if r.status_code != 200:
                        return False
                    announced = r.headers.get("content-length")
                    if announced and announced.isdigit() and int(announced) > max_bytes:
                        return False
                    received = 0
                    for chunk in r.iter_bytes():
                        received += len(chunk)
                        if received > max_bytes:
                            return False
                        out.write(chunk)
                    return True
            except httpx.TransportError:
                time.sleep(min(MAX_WAIT_S, 2.0 ** attempt))
        return False

    def download(self, url: str, max_bytes: int) -> bytes | None:
        """A small binary file (a remote script), in memory."""
        buffer = io.BytesIO()
        return buffer.getvalue() if self._stream(url, max_bytes, buffer) else None

    def download_archive(self, url: str, max_bytes: int) -> IO[bytes] | None:
        """A code archive, through the DISK beyond 1 MB: a 60 MB zip went through
        memory twice (the chunks, then their join) — that was the 280 MB peak of
        the pass. The caller closes it (`with`)."""
        f = tempfile.SpooledTemporaryFile(max_size=1_000_000)
        if not self._stream(url, max_bytes, f):
            f.close()
            return None
        f.seek(0)
        return f


def _retry_delay(r: httpx.Response, attempt: int) -> float:
    """What the server asks for (Retry-After, or GitHub's reset time), otherwise
    an exponential backoff."""
    ra = r.headers.get("retry-after")
    if ra and ra.isdigit():
        return min(MAX_WAIT_S, float(ra))
    reset = r.headers.get("x-ratelimit-reset")
    if r.headers.get("x-ratelimit-remaining") == "0" and reset and reset.isdigit():
        return min(MAX_WAIT_S, max(1.0, float(reset) - time.time()))
    return min(MAX_WAIT_S, 2.0 ** (attempt + 1))
