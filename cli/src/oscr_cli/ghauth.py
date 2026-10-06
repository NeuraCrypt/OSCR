"""GitHub's device flow, for a GitHub App user token (D00-3, D14-4; ``oscr help auth``).

The tool asks GitHub directly (``github.com/login/device/code``, then
``github.com/login/oauth/access_token``) with the registry's GitHub App's **public client id** only:
no client secret is in the tool, and the token goes from GitHub to the person's keychain without ever
reaching the registry. The person approves on GitHub's own page, where GitHub shows the App's name and
what it may do.

- The client id comes from the setting ``github_client_id``, ``OSCR_GITHUB_CLIENT_ID``, or the registry's
  ``GET /api/forge/v1/cli`` (a public value: it is in every authorization address the site sends to browsers).
- Polling follows GitHub's interval (5 s), adds 5 s on ``slow_down``, and stops when the code expires
  (15 minutes) or the person refuses.
- The token lives 8 hours; its refresh token 6 months. ``oscr auth refresh`` (and any command, when the
  token expired) renews it with the refresh token and the public client id; if GitHub asks for more,
  the device flow runs again.
- The only address the tool opens is GitHub's own device page on the configured GitHub host: an address
  in an answer that points elsewhere is refused.
"""
from __future__ import annotations

import time
import urllib.parse
from typing import Any

from . import accounts, oscr_api
from .errors import AuthError, CliError, UsageError
from .http import HttpError
from .sanitize import clean_line

GRANT_DEVICE = "urn:ietf:params:oauth:grant-type:device_code"
MAX_WAIT = 15 * 60

#: How the tool waits between polls (the tests replace it).
sleep = time.sleep
now = time.time


def client_id(ctx: Any) -> str:
    cid = ctx.config.get("github_client_id").strip()
    if not cid:
        try:
            meta = oscr_api.cli_meta(ctx)
        except CliError as e:
            raise CliError(f"The GitHub App's client id is not set, and {ctx.config.host} could not say it ({e.message}).",
                           hint="Set it with `oscr config set github_client_id <id>` (the registry's documentation gives it).") from e
        cid = str((meta.get("github") or {}).get("client_id") or "").strip()
    if not cid or not all(c.isalnum() or c in "._-" for c in cid) or len(cid) > 64:
        raise CliError("The registry did not give a usable GitHub App client id.", hint="Set it with `oscr config set github_client_id <id>`.")
    return cid


def _oauth(ctx: Any, form: dict[str, str]) -> dict[str, Any]:
    res = ctx.http.request("POST", f"{ctx.config.github_web}/login/oauth/access_token", form=form, ok=(400, 401, 422))
    body = res.body if isinstance(res.body, dict) else {}
    if res.status >= 400 and not body.get("error"):
        raise CliError(f"GitHub answered {res.status} to the token request.")
    return body


def _check_verification(ctx: Any, uri: str) -> str:
    """GitHub's device page, only on GitHub's own host."""
    u = urllib.parse.urlsplit(uri)
    web = urllib.parse.urlsplit(ctx.config.github_web)
    if (u.scheme, u.netloc.lower()) != (web.scheme, web.netloc.lower()):
        raise CliError("GitHub's answer named a page on another host: the tool does not open it.")
    return uri


def device_login(ctx: Any, *, open_browser: bool = True) -> dict[str, Any]:
    """The device flow, from the code to the token and the account's public facts."""
    cid = client_id(ctx)
    try:
        res = ctx.http.request("POST", f"{ctx.config.github_web}/login/device/code", form={"client_id": cid})
    except HttpError as e:
        raise CliError(f"GitHub refused to start the sign-in ({e.message}).",
                       hint="If it says the device flow is disabled, the registry's GitHub App must enable it (its settings, “Enable Device Flow”).") from e
    d = res.body if isinstance(res.body, dict) else {}
    if d.get("error") == "device_flow_disabled":
        raise CliError("The registry's GitHub App does not allow the device flow yet.", hint="Its owner enables “Device Flow” in the App's settings on GitHub.")
    code, device, uri = d.get("user_code"), d.get("device_code"), d.get("verification_uri")
    if not (isinstance(code, str) and isinstance(device, str) and isinstance(uri, str)):
        raise CliError("GitHub's answer to the sign-in is not readable.")
    uri = _check_verification(ctx, uri)
    interval = max(1, int(d.get("interval") or 5))
    deadline = now() + min(int(d.get("expires_in") or 900), MAX_WAIT)
    ctx.io.say(f"GitHub: open {clean_line(uri)} and enter the code {clean_line(code)}")
    if open_browser and ctx.io.out_tty and ctx.config.get("browser") != "none":
        ctx.browse(uri)
    with ctx.io.waiting("Waiting for your approval on GitHub…"):
        while True:
            if now() >= deadline:
                raise AuthError("The code expired before it was approved (15 minutes).", hint="Run `oscr auth login` again.")
            sleep(interval)
            t = _oauth(ctx, {"client_id": cid, "device_code": device, "grant_type": GRANT_DEVICE})
            err = t.get("error")
            if err == "authorization_pending":
                continue
            if err == "slow_down":
                interval = int(t.get("interval") or interval + 5)
                continue
            if err == "expired_token":
                raise AuthError("The code expired before it was approved.", hint="Run `oscr auth login` again.")
            if err == "access_denied":
                raise AuthError("The sign-in was refused on GitHub.")
            if err:
                raise AuthError(f"GitHub refused the sign-in: {clean_line(t.get('error_description') or err)}")
            if not t.get("access_token"):
                raise AuthError("GitHub's answer holds no token.")
            return _account(ctx, t)


def _account(ctx: Any, t: dict[str, Any]) -> dict[str, Any]:
    token = str(t["access_token"])
    me = ctx.http.request("GET", f"{ctx.config.github_api}/user", token=token, headers={"X-GitHub-Api-Version": "2022-11-28"}).body or {}
    login = str(me.get("login") or "")
    if not login or not all(c.isalnum() or c == "-" for c in login):
        raise AuthError("GitHub did not say whose token this is.")
    at = now()
    facts: dict[str, Any] = {"login": login, "id": me.get("id"), "signed_in_at": int(at)}
    if t.get("expires_in"):
        facts["expires_at"] = int(at + int(t["expires_in"]))
    if t.get("refresh_token_expires_in"):
        facts["refresh_expires_at"] = int(at + int(t["refresh_token_expires_in"]))
    secret = {"token": token}
    if t.get("refresh_token"):
        secret["refresh_token"] = str(t["refresh_token"])
    return {"user": login, "facts": facts, "secret": secret}


def login(ctx: Any, *, open_browser: bool = True) -> str:
    got = device_login(ctx, open_browser=open_browser)
    accounts.save(ctx, accounts.GITHUB, ctx.config.github_host, got["user"], got["secret"], got["facts"])
    return got["user"]


def with_token(ctx: Any, token: str) -> str:
    """A GitHub token the person pastes on standard input (never on the command line)."""
    token = token.strip()
    if not token or any(c.isspace() for c in token):
        raise UsageError("Paste one token on standard input: `oscr auth login --github --with-token < file`.")
    got = _account(ctx, {"access_token": token})
    accounts.save(ctx, accounts.GITHUB, ctx.config.github_host, got["user"], got["secret"], got["facts"])
    return got["user"]


def refresh(ctx: Any, c: accounts.Credential, *, quiet: bool = False) -> accounts.Credential:
    """A new token from the refresh token (the public client id only); else the device flow again."""
    rt = c.secret.get("refresh_token")
    rexp = c.facts.get("refresh_expires_at")
    if rt and not (isinstance(rexp, (int, float)) and rexp <= now()):
        t = _oauth(ctx, {"client_id": client_id(ctx), "grant_type": "refresh_token", "refresh_token": str(rt)})
        if t.get("access_token"):
            got = _account(ctx, t)
            accounts.save(ctx, accounts.GITHUB, c.host, got["user"], got["secret"], got["facts"])
            if not quiet:
                ctx.io.say(f"GitHub: {got['user']}'s token renewed.")
            return accounts.credential(ctx, accounts.GITHUB, host=c.host, user=got["user"], env_first=False)
        if not quiet:
            ctx.io.say(f"GitHub did not renew the token ({clean_line(t.get('error_description') or t.get('error') or 'no reason given')}): signing in again.")
    elif quiet:
        raise AuthError(f"Your GitHub token on {c.host} expired.", hint="Run `oscr auth refresh --github`.")
    user = login(ctx)
    return accounts.credential(ctx, accounts.GITHUB, host=c.host, user=user, env_first=False)


def check(ctx: Any, token: str) -> dict[str, Any] | None:
    """Whose token this is, or None when GitHub refuses it."""
    try:
        return ctx.http.request("GET", f"{ctx.config.github_api}/user", token=token, headers={"X-GitHub-Api-Version": "2022-11-28"}).body
    except HttpError:
        return None
