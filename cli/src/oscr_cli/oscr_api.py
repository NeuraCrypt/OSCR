"""The registry's public API (/api/forge/v1, docs/API.md), as the tool asks it: with the registry's own token
(never a GitHub token: those go to GitHub only, D00-3), the answers' errors said in words."""
from __future__ import annotations

import urllib.parse
from collections.abc import Mapping
from typing import Any

from . import accounts
from .errors import AuthError, CliError
from .http import HttpError, Response

API = "/api/forge/v1"
API_VERSION = "2026-09-29"


def url(ctx: Any, path: str, params: Mapping[str, Any] | None = None, host: str | None = None) -> str:
    q = ""
    if params:
        pairs: list[tuple[str, str]] = []
        for k, v in params.items():
            if v is None:
                continue
            for one in v if isinstance(v, (list, tuple)) else [v]:
                pairs.append((k, str(one)))
        q = "?" + urllib.parse.urlencode(pairs) if pairs else ""
    return ctx.config.base_url(host) + API + path + q


def call(ctx: Any, method: str, path: str, *, params: Mapping[str, Any] | None = None, body: Any = None, token: str | None | bool = True,
         ok: tuple[int, ...] = (), host: str | None = None) -> Response:
    """A call of the registry's API: signed with the registry's token unless ``token`` is False."""
    t: str | None
    if token is True:
        t = accounts.oscr_token(ctx)
    elif token is False:
        t = None
    else:
        t = token
    headers = {"X-Api-Version": API_VERSION}
    try:
        return ctx.http.request(method, url(ctx, path, params, host), token=t, headers=headers, json_body=body, ok=ok)
    except HttpError as e:
        code = e.body.get("error", {}).get("code") if isinstance(e.body, dict) and isinstance(e.body.get("error"), dict) else None
        if e.status == 401:
            raise AuthError(e.message, hint="Your registry token was refused: `oscr auth login --oscr` gets a new one.") from e
        if e.status == 403 and code == "insufficient_scope":
            raise CliError(e.message, hint="Sign in again with the scope it names: `oscr auth refresh --oscr --scopes …`.") from e
        raise


def get(ctx: Any, path: str, **params: Any) -> Any:
    return call(ctx, "GET", path, params=params).body


def post(ctx: Any, path: str, body: Any) -> Any:
    return call(ctx, "POST", path, body=body).body


def cli_meta(ctx: Any) -> dict[str, Any]:
    """What the command line needs to know of this registry (GET /api/forge/v1/cli, no token): the GitHub
    App's public client id, GitHub's addresses, the device flow's routes."""
    res = call(ctx, "GET", "/cli", token=False)
    return res.body if isinstance(res.body, dict) else {}
