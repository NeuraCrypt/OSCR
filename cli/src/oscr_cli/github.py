"""GitHub's REST API, asked directly with the person's own GitHub token (D00-3, D00-5, D14-10): the
registry never sees it. Without a token, the public reads GitHub allows anonymously (60 an hour an
address); the answers' email fields are never kept nor shown."""
from __future__ import annotations

import re
import urllib.parse
from collections.abc import Mapping
from typing import Any

from . import accounts
from .errors import AuthError, CliError
from .http import HttpError, Response

API_VERSION = "2022-11-28"
HEADERS = {"X-GitHub-Api-Version": API_VERSION}
ACCEPT = "application/vnd.github+json"


def token(ctx: Any, *, anonymous_ok: bool = False) -> str | None:
    try:
        return accounts.github_token(ctx)
    except AuthError:
        if anonymous_ok:
            return None
        raise


def url(ctx: Any, path: str, params: Mapping[str, Any] | None = None) -> str:
    q = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
    return f"{ctx.config.github_api}{path}{'?' + q if q else ''}"


def _strip_emails(v: Any) -> Any:
    """GitHub's answers carry `email` fields: dropped before anything else reads them."""
    if isinstance(v, dict):
        return {k: _strip_emails(x) for k, x in v.items() if k != "email" and not k.endswith("_email")}
    if isinstance(v, list):
        return [_strip_emails(x) for x in v]
    return v


def call(ctx: Any, method: str, path: str, *, params: Mapping[str, Any] | None = None, body: Any = None,
         anonymous_ok: bool = False, ok: tuple[int, ...] = (), accept: str = ACCEPT) -> Response:
    t = token(ctx, anonymous_ok=anonymous_ok or method == "GET")
    try:
        res = ctx.http.request(method, url(ctx, path, params), token=t, headers=HEADERS, json_body=body, ok=ok, accept=accept)
    except HttpError as e:
        if e.status == 401:
            raise AuthError(e.message, hint="Your GitHub token was refused: `oscr auth refresh --github`.") from e
        if e.status in (403, 429) and (e.headers.get("X-RateLimit-Remaining") == "0" or e.headers.get("x-ratelimit-remaining") == "0"):
            raise CliError("GitHub's rate limit for you is spent for now.", hint="Sign in (`oscr auth login --github`) for 5,000 requests an hour, or wait.") from e
        if e.status == 404:
            raise CliError(f"GitHub has no such thing, or it is private: {path}", hint="" if t else "Sign in with `oscr auth login --github` to see what your account may see.") from e
        raise
    res.body = _strip_emails(res.body)
    return res


def get(ctx: Any, path: str, **params: Any) -> Any:
    return call(ctx, "GET", path, params=params).body


def pages(ctx: Any, path: str, params: Mapping[str, Any] | None = None, *, limit: int = 30) -> list[Any]:
    """A list, page after page (GitHub's Link header), up to ``limit`` items."""
    out: list[Any] = []
    p = dict(params or {})
    p.setdefault("per_page", min(100, max(1, limit)))
    next_url: str | None = url(ctx, path, p)
    t = token(ctx, anonymous_ok=True)
    while next_url and len(out) < limit:
        try:
            res = ctx.http.request("GET", next_url, token=t, headers=HEADERS, accept=ACCEPT)
        except HttpError as e:
            if e.status == 404:
                raise CliError(f"GitHub has no such thing, or it is private: {path}") from e
            raise
        items = res.body if isinstance(res.body, list) else (res.body or {}).get("items") or []
        out.extend(_strip_emails(items))
        m = re.search(r'<([^>]+)>;\s*rel="next"', res.header("Link"))
        nxt = m.group(1) if m else None
        # Only GitHub's own API address is followed.
        next_url = nxt if nxt and nxt.startswith(ctx.config.github_api + "/") else None
    return out[:limit]
