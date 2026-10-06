"""HTTP, with the standard library (urllib), for GitHub's API and the registry's (D14-5, D14-3).

- **Debug output** (``--debug`` or ``OSCR_DEBUG=1``): each request's method and address, the answer's
  status, its request id and rate-limit headers, on standard error. **Never a token**: the
  ``Authorization`` header is never printed, and :func:`redact` removes every credential shape from
  what is printed (the registry's ``oscr_pat_`` and ``oscr_dc_``, GitHub's ``gh*_`` and
  ``github_pat_``, device codes, query parameters that carry one). Bodies are never printed.
- **Redirects**: followed within the same origin only, with the credential; to another origin the
  credential is dropped first (a token never follows a redirect off its host).
- **Errors** become :class:`HttpError`, with the status, the service's own message (cleaned), and for
  a 401 the exit code of a sign-in needed.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, TextIO

from . import __version__
from .errors import AUTH, CliError
from .sanitize import clean_line

USER_AGENT = f"oscr-cli/{__version__}"
TIMEOUT = 30


def redact(text: str) -> str:
    """The text without anything shaped like a credential."""
    s = str(text)
    s = re.sub(r"\b(?:gh[pousr]_|github_pat_|oscr_pat_|oscr_dc_|memtok_)[A-Za-z0-9_.-]+", "[…]", s)
    # A credential after its scheme: a long word of token characters (never an ordinary word after "token").
    s = re.sub(r"\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{20,}", r"\1 […]", s, flags=re.I)
    s = re.sub(r"([?&](?:code|state|access_token|refresh_token|client_secret|device_code|token)=)[^&\s]+", r"\1[…]", s, flags=re.I)
    return re.sub(r"[A-Za-z0-9_-]{40,}", "[…]", s)


class HttpError(CliError):
    def __init__(self, status: int, message: str, *, url: str = "", body: Any = None, headers: Mapping[str, str] | None = None):
        super().__init__(message, code=AUTH if status == 401 else None)
        self.status = status
        self.url = url
        self.body = body
        self.headers = dict(headers or {})


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: Any
    text: str
    url: str

    def header(self, name: str) -> str:
        low = name.lower()
        return next((v for k, v in self.headers.items() if k.lower() == low), "")


class _SameOriginRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect; drop the credential when it leaves the origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        a, b = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if (a.scheme, a.netloc.lower()) != (b.scheme, b.netloc.lower()):
            for h in list(new.headers):
                if h.lower() == "authorization":
                    del new.headers[h]
            for h in list(new.unredirected_hdrs):
                if h.lower() == "authorization":
                    del new.unredirected_hdrs[h]
        return new


Opener = Callable[[urllib.request.Request, float], Any]


def _default_opener() -> Opener:
    opener = urllib.request.build_opener(_SameOriginRedirects())
    return lambda req, timeout: opener.open(req, timeout=timeout)


@dataclass
class Http:
    """One client: its debug stream, and the opener (tests pass their own)."""

    debug: TextIO | None = None
    opener: Opener = field(default_factory=_default_opener)

    def log(self, text: str) -> None:
        if self.debug is not None:
            self.debug.write(f"[debug] {redact(text)}\n")
            self.debug.flush()

    def request(
        self,
        method: str,
        url: str,
        *,
        token: str | None = None,
        scheme: str = "Bearer",
        headers: Mapping[str, str] | None = None,
        json_body: Any = None,
        form: Mapping[str, str] | None = None,
        data: bytes | None = None,
        accept: str = "application/json",
        ok: tuple[int, ...] = (),
        timeout: float = TIMEOUT,
    ) -> Response:
        h = {"User-Agent": USER_AGENT, "Accept": accept}
        h.update(headers or {})
        body: bytes | None = data
        if json_body is not None:
            body = json.dumps(json_body).encode()
            h["Content-Type"] = "application/json"
        elif form is not None:
            body = urllib.parse.urlencode(form).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=body, method=method, headers=h)
        if token:
            # A normal header, so that a redirect within the origin keeps it; the redirect handler drops it
            # when the redirect leaves the origin.
            req.add_header("Authorization", f"{scheme} {token}")
        self.log(f"> {method} {url}")
        try:
            raw = self.opener(req, timeout)
            status = raw.status
            rheaders = dict(raw.headers.items())
            payload = raw.read()
            final = raw.geturl() if hasattr(raw, "geturl") else url
        except urllib.error.HTTPError as e:
            status = e.code
            rheaders = dict(e.headers.items()) if e.headers else {}
            payload = e.read() or b""
            final = url
        except urllib.error.URLError as e:
            self.log(f"< no answer ({e.reason})")
            raise CliError(f"{urllib.parse.urlsplit(url).netloc} could not be reached ({clean_line(e.reason)}): check the connection, then try again.") from e
        except TimeoutError as e:
            raise CliError(f"{urllib.parse.urlsplit(url).netloc} did not answer in {int(timeout)} s: try again.") from e
        shown = {k: v for k, v in rheaders.items() if k.lower() in ("x-request-id", "x-github-request-id", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after", "x-accepted-scopes", "x-oauth-scopes")}
        self.log(f"< {status} {' '.join(f'{k}={v}' for k, v in shown.items())}".rstrip())
        text = payload.decode("utf-8", "replace")
        parsed: Any = None
        ctype = next((v for k, v in rheaders.items() if k.lower() == "content-type"), "")
        if text and ("json" in ctype or text[:1] in "[{"):
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = None
        res = Response(status, rheaders, parsed, text, final)
        if status >= 400 and status not in ok:
            raise HttpError(status, error_message(status, parsed, text, url), url=url, body=parsed, headers=rheaders)
        return res


def error_message(status: int, body: Any, text: str, url: str) -> str:
    """The service's own words for an error (GitHub's ``message``, the registry's ``error.message``,
    OAuth's ``error_description``), cleaned; else the status."""
    host = urllib.parse.urlsplit(url).netloc
    words = ""
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            words = str(err.get("message") or err.get("code") or "")
        elif isinstance(body.get("message"), str):
            words = body["message"]
            details = [str(e.get("message") or " ".join(str(e.get(k)) for k in ("field", "code") if e.get(k))) for e in body.get("errors") or [] if isinstance(e, dict)]
            if details:
                words = f"{words} ({'; '.join(d for d in details if d)})"
        elif isinstance(body.get("error_description"), str):
            words = body["error_description"]
        elif isinstance(err, str):
            words = err
    words = clean_line(redact(words))[:300]
    return f"{host} answered {status}: {words}" if words else f"{host} answered {status}."
