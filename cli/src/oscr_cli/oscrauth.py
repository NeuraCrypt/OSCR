"""The registry's own device-code flow, for a registry token (D14-2; docs/API.md "The command line's
sign-in"; ``oscr help auth``).

1. ``POST /api/v1/device/code`` with the scopes and the life asked: the registry answers a device code
   (the tool's secret, kept in memory only), a user code of 8 letters, and the address of its approval
   page. It writes nothing yet.
2. The person opens the page (the tool opens it when it can), signs in with ORCID, GitHub or Google,
   **types the code this terminal shows**, reads what the token may do, and approves or refuses.
3. The tool polls ``POST /api/v1/device/token`` every 5 s at most, for 15 minutes at most; once
   approved, the token is made and answered once, and goes to the keychain.

The page the tool opens must be on the registry's own host: an answer naming another is refused.
``oscr auth logout`` revokes the token itself (``POST /api/v1/token/revoke``) before removing it.
"""
from __future__ import annotations

import re
import time
import urllib.parse
from typing import Any

from . import accounts, oscr_api
from .errors import AuthError, CliError, UsageError
from .http import HttpError
from .sanitize import clean_line

#: What a new token may do unless the person asks for other scopes: read the registry's layer over
#: repositories and its research issues. Writes are asked for explicitly (--scopes).
DEFAULT_SCOPES = ("repos:read", "research:read")
SCOPES = ("repos:read", "research:read", "research:write", "social:read", "social:write", "notifications:read",
          "notifications:write", "hooks:read", "hooks:write", "statuses:write")
DEFAULT_DAYS = 90
MIN_INTERVAL = 5
MAX_WAIT = 15 * 60
TOKEN_SHAPE = re.compile(r"^oscr_pat_[A-Za-z0-9_-]{43}$")
DEVICE_SHAPE = re.compile(r"^oscr_dc_[A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{43}$")
USER_CODE = re.compile(r"^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$")

sleep = time.sleep
now = time.time


def parse_scopes(text: str | None) -> list[str]:
    if not text:
        return list(DEFAULT_SCOPES)
    out: list[str] = []
    for s in re.split(r"[\s,]+", text.strip()):
        if not s:
            continue
        if s not in SCOPES:
            raise UsageError(f"“{s}” is not a scope of the registry's tokens. The scopes: {', '.join(SCOPES)}.")
        if s not in out:
            out.append(s)
    return out or list(DEFAULT_SCOPES)


def _check_page(ctx: Any, uri: str) -> str:
    u = urllib.parse.urlsplit(uri)
    base = urllib.parse.urlsplit(ctx.config.base_url())
    if (u.scheme, u.netloc.lower()) != (base.scheme, base.netloc.lower()) or not u.path.startswith("/device/"):
        raise CliError("The registry's answer named a page elsewhere than its own approval page: the tool does not open it.")
    return uri


def device_login(ctx: Any, *, scopes: list[str], days: int, open_browser: bool = True, name: str = "Command line") -> dict[str, Any]:
    if not 1 <= days <= 366:
        raise UsageError("A registry token lives 1 to 366 days.")
    try:
        start = oscr_api.call(ctx, "POST", "/device/code", body={"scopes": scopes, "days": days, "name": name}, token=False).body or {}
    except HttpError as e:
        raise CliError(f"{ctx.config.host} refused to start the sign-in: {e.message}") from e
    device, code, uri = start.get("device_code"), start.get("user_code"), start.get("verification_uri")
    if not (isinstance(device, str) and DEVICE_SHAPE.match(device) and isinstance(code, str) and USER_CODE.match(code) and isinstance(uri, str)):
        raise CliError("The registry's answer to the sign-in is not readable.")
    uri = _check_page(ctx, uri)
    interval = max(MIN_INTERVAL, int(start.get("interval") or MIN_INTERVAL))
    deadline = now() + min(int(start.get("expires_in") or MAX_WAIT), MAX_WAIT)
    site = ctx.config.site_name
    ctx.io.say(f"{site}: open {clean_line(uri)}\n  sign in, then type the code {code} and approve (it may: {', '.join(scopes)}; for {days} days)")
    if open_browser and ctx.io.out_tty and ctx.config.get("browser") != "none":
        ctx.browse(uri)
    with ctx.io.waiting(f"Waiting for your approval on {site}…"):
        while True:
            if now() >= deadline:
                raise AuthError("The code expired before it was approved (15 minutes).", hint="Run `oscr auth login --oscr` again.")
            sleep(interval)
            res = oscr_api.call(ctx, "POST", "/device/token", body={"device_code": device}, token=False, ok=(400, 429))
            body = res.body if isinstance(res.body, dict) else {}
            if res.status == 200 and body.get("access_token"):
                break
            err = body.get("error") if isinstance(body.get("error"), dict) else {}
            what = err.get("code")
            if what == "authorization_pending":
                continue
            if what in ("slow_down", "rate_limited") or res.status == 429:
                interval = max(interval + 5, int(err.get("interval") or 0))
                continue
            if what == "access_denied":
                raise AuthError("The sign-in was refused on the registry's page.")
            if what == "expired_token":
                raise AuthError(f"The code expired or was used already: {clean_line(err.get('message') or '')}", hint="Run `oscr auth login --oscr` again.")
            raise AuthError(f"The registry refused the sign-in: {clean_line(err.get('message') or what or res.status)}")
    token = str(body["access_token"])
    if not TOKEN_SHAPE.match(token):
        raise AuthError("The registry's answer holds no usable token.")
    return _account(ctx, token, body)


def _account(ctx: Any, token: str, made: dict[str, Any] | None = None) -> dict[str, Any]:
    me = oscr_api.call(ctx, "GET", "/user", token=token).body or {}
    tok = me.get("token") or {}
    # The account's public handle: its GitHub login, else its ORCID iD, else (signed in with Google
    # only) the token's public id.
    user = str(me.get("github") or me.get("orcid") or (f"account-{tok.get('id')}" if tok.get("id") else ""))
    if not user or "@" in user or any(c.isspace() for c in user):
        raise AuthError("The registry did not say whose token this is.")
    expires = (made or {}).get("expires_at") or tok.get("expires_at")
    facts: dict[str, Any] = {"github": me.get("github"), "orcid": me.get("orcid"), "scopes": tok.get("scopes") or (made or {}).get("scopes") or [],
                             "token_id": tok.get("id"), "signed_in_at": int(now())}
    if isinstance(expires, str):
        from datetime import datetime

        try:
            facts["expires_at"] = int(datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp())
        except ValueError:
            pass
    return {"user": user, "facts": facts, "secret": {"token": token}}


def login(ctx: Any, *, scopes: str | None = None, days: int | None = None, open_browser: bool = True) -> str:
    got = device_login(ctx, scopes=parse_scopes(scopes), days=days or DEFAULT_DAYS, open_browser=open_browser)
    accounts.save(ctx, accounts.OSCR, ctx.config.host, got["user"], got["secret"], got["facts"])
    return got["user"]


def with_token(ctx: Any, token: str) -> str:
    token = token.strip()
    if not TOKEN_SHAPE.match(token):
        raise UsageError("This is not a registry token (oscr_pat_…): paste one on standard input.")
    got = _account(ctx, token)
    accounts.save(ctx, accounts.OSCR, ctx.config.host, got["user"], got["secret"], got["facts"])
    return got["user"]


def check(ctx: Any, host: str, token: str) -> dict[str, Any] | None:
    try:
        return oscr_api.call(ctx, "GET", "/user", token=token, host=host).body
    except CliError:
        return None


def revoke(ctx: Any, host: str, user: str) -> None:
    """The token revokes itself; when that fails, the person is told where to revoke it."""
    try:
        c = accounts.credential(ctx, accounts.OSCR, host=host, user=user, env_first=False)
    except AuthError:
        return
    try:
        oscr_api.call(ctx, "POST", "/token/revoke", body={}, token=c.token, ok=(401,), host=host)
    except CliError as e:
        ctx.io.warn(f"The registry could not revoke the token now ({e.message}): revoke it on {ctx.config.base_url(host)}/settings/tokens/.")


def refresh(ctx: Any, c: accounts.Credential, *, scopes: str | None = None, days: int | None = None, open_browser: bool = True) -> None:
    """A new token approved again (the same scopes unless others are asked), then the old one revoked."""
    old_scopes = ",".join(c.facts.get("scopes") or []) or None
    got = device_login(ctx, scopes=parse_scopes(scopes or old_scopes), days=days or DEFAULT_DAYS, open_browser=open_browser)
    old = c.token
    accounts.save(ctx, accounts.OSCR, c.host, got["user"], got["secret"], got["facts"])
    try:
        oscr_api.call(ctx, "POST", "/token/revoke", body={}, token=old, ok=(401,), host=c.host)
    except CliError:
        ctx.io.warn(f"The previous token could not be revoked now: revoke it on {ctx.config.base_url()}/settings/tokens/.")
    ctx.io.say(f"{ctx.config.site_name}: a new token for {got['user']}; the previous one is revoked.")
