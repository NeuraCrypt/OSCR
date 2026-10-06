"""``oscr auth``: sign in to GitHub and to the registry, see who is signed in, switch, sign out; git's
credential helper for GitHub's host only (D14-3, D14-4; ``oscr help auth``)."""
from __future__ import annotations

import argparse
import shlex
import sys
import time
import urllib.parse
from typing import Any

from .. import accounts, ghauth
from ..errors import AuthError, UsageError
from ..output import add_format_flags, ago, emit
from ..parsing import command, group
from ..sanitize import clean_line

NAME = "auth"
GROUP = "account"

STATUS_FIELDS = ["service", "host", "user", "active", "source", "expires_at", "scopes", "valid"]


def _services(args: argparse.Namespace) -> list[str]:
    g, o = getattr(args, "github", False), getattr(args, "oscr", False)
    if g and not o:
        return [accounts.GITHUB]
    if o and not g:
        return [accounts.OSCR]
    return [accounts.GITHUB, accounts.OSCR]


def _oscr_host(ctx: Any, args: argparse.Namespace) -> str:
    from ..config import normal_host

    return normal_host(args.hostname) if getattr(args, "hostname", None) else ctx.config.host


# ── login ──


def _login(ctx: Any, args: argparse.Namespace) -> int:
    services = _services(args)
    if args.hostname:
        ctx.config.host_override = _oscr_host(ctx, args)
    if args.with_token:
        if len(services) != 1:
            raise UsageError("--with-token reads one token: add --github or --oscr.")
        token = ctx.io.inp.read()
        if services[0] == accounts.GITHUB:
            user = ghauth.with_token(ctx, token)
            ctx.io.say(f"GitHub: signed in as {user}.")
        else:
            from .. import oscrauth

            user = oscrauth.with_token(ctx, token)
            ctx.io.say(f"{ctx.config.site_name}: signed in as {user}.")
        return 0
    for s in services:
        if s == accounts.GITHUB:
            user = ghauth.login(ctx, open_browser=not args.no_browser)
            ctx.io.say(f"GitHub: signed in as {user}. The token is in {accounts.store(ctx).name}; the registry never sees it.")
        else:
            from .. import oscrauth

            user = oscrauth.login(ctx, scopes=args.scopes, days=args.days, open_browser=not args.no_browser)
            ctx.io.say(f"{ctx.config.site_name}: signed in as {user}. The token is in {accounts.store(ctx).name}.")
    if accounts.GITHUB in services and not args.skip_git_hint:
        ctx.io.say(f"To let git use your GitHub token (for {ctx.config.github_host} only, never another host): oscr auth setup-git")
    return 0


# ── status ──


def _status_rows(ctx: Any, args: argparse.Namespace) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for s in _services(args):
        for host in ctx.hosts.hosts(s):
            active = ctx.hosts.active(s, host)
            for user, facts in ctx.hosts.users(s, host).items():
                row: dict[str, Any] = {
                    "service": s,
                    "host": host,
                    "user": user,
                    "active": user == active,
                    "source": "keychain",
                    "expires_at": facts.get("expires_at"),
                    "scopes": facts.get("scopes") or [],
                    "valid": None,
                }
                try:
                    c = accounts.credential(ctx, s, host=host, user=user, env_first=False)
                except AuthError:
                    row["valid"] = False
                    row["problem"] = "not in the keychain any more"
                    rows.append(row)
                    continue
                if not args.offline:
                    row["valid"] = _valid(ctx, s, host, c.token)
                rows.append(row)
        env_name = next((n for n in (("OSCR_TOKEN",) if s == accounts.OSCR else ("OSCR_GITHUB_TOKEN", "GH_TOKEN")) if ctx.env.get(n)), None)
        if env_name:
            rows.append({"service": s, "host": ctx.config.host if s == accounts.OSCR else ctx.config.github_host, "user": "", "active": True,
                         "source": env_name, "expires_at": None, "scopes": [], "valid": None})
    return rows


def _valid(ctx: Any, service: str, host: str, token: str) -> bool:
    if service == accounts.GITHUB:
        return ghauth.check(ctx, token) is not None
    from .. import oscrauth

    return oscrauth.check(ctx, host, token) is not None


def _status(ctx: Any, args: argparse.Namespace) -> int:
    rows = _status_rows(ctx, args)

    def human() -> None:
        if not rows:
            ctx.io.say("You are not signed in. Run `oscr auth login`.")
            return
        for r in rows:
            name = "GitHub" if r["service"] == accounts.GITHUB else ctx.config.site_name
            head = f"{name} on {r['host']}: " + (f"{r['user']}" if r["user"] else f"the token in {r['source']}")
            bits = []
            if r["active"]:
                bits.append("active")
            if r["source"] == "keychain":
                bits.append(f"kept in {accounts.store_of(ctx, r['service'], r['host'], r['user']).name}")
            exp = r.get("expires_at")
            if isinstance(exp, (int, float)):
                iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp))
                bits.append(("expired " if exp <= time.time() else "expires ") + ago(iso))
            if r["scopes"]:
                bits.append("may: " + ", ".join(r["scopes"]))
            state = {True: ctx.io.style("valid", "ok"), False: ctx.io.style("refused", "failure"), None: "not checked"}[r["valid"]]
            if r.get("problem"):
                state = ctx.io.style(r["problem"], "failure")
            ctx.io.print(f"{clean_line(head)} — {state}" + (f" ({'; '.join(bits)})" if bits else ""))

    emit(ctx.io, args, rows, human)
    return 0 if all(r["valid"] is not False for r in rows) else 1


# ── token ──


def _token(ctx: Any, args: argparse.Namespace) -> int:
    services = _services(args)
    if len(services) != 1:
        raise UsageError("Which token: --github or --oscr?")
    host = _oscr_host(ctx, args) if services[0] == accounts.OSCR else ctx.config.github_host
    c = accounts.credential(ctx, services[0], host=host, user=args.user, env_first=not args.user)
    if services[0] == accounts.GITHUB and c.source == "keychain" and c.expired:
        c = ghauth.refresh(ctx, c, quiet=True)
    ctx.io.print(c.token)
    return 0


# ── logout ──


def _logout(ctx: Any, args: argparse.Namespace) -> int:
    done = 0
    for s in _services(args):
        host = _oscr_host(ctx, args) if s == accounts.OSCR else ctx.config.github_host
        users = [args.user] if args.user else ([ctx.hosts.active(s, host)] if ctx.hosts.active(s, host) else [])
        for user in users:
            if user not in ctx.hosts.users(s, host):
                raise UsageError(f"No account “{user}” is signed in on {host}.")
            if s == accounts.OSCR:
                from .. import oscrauth

                oscrauth.revoke(ctx, host, user)
            accounts.forget(ctx, s, host, user)
            done += 1
            if s == accounts.GITHUB:
                ctx.io.say(f"GitHub: {user} signed out here; the token is gone from this computer. It stays valid at GitHub until it "
                           f"expires (8 hours at most); to end it now, revoke the App at {ctx.config.github_web}/settings/apps/authorizations.")
            else:
                ctx.io.say(f"{ctx.config.site_name}: {user} signed out; the token was revoked and removed from this computer.")
    if not done:
        ctx.io.say("Nobody is signed in here.")
    return 0


# ── refresh, switch ──


def _refresh(ctx: Any, args: argparse.Namespace) -> int:
    for s in _services(args):
        host = _oscr_host(ctx, args) if s == accounts.OSCR else ctx.config.github_host
        if not ctx.hosts.active(s, host):
            if getattr(args, s, False):
                raise AuthError(f"You are not signed in to {accounts.SERVICE_WORDS[s]} on {host}.", hint="Run `oscr auth login`.")
            continue
        c = accounts.credential(ctx, s, host=host, user=args.user, env_first=False)
        if s == accounts.GITHUB:
            ghauth.refresh(ctx, c)
        else:
            from .. import oscrauth

            oscrauth.refresh(ctx, c, scopes=args.scopes, days=args.days, open_browser=not args.no_browser)
    return 0


def _switch(ctx: Any, args: argparse.Namespace) -> int:
    services = _services(args)
    for s in services:
        host = _oscr_host(ctx, args) if s == accounts.OSCR else ctx.config.github_host
        users = list(ctx.hosts.users(s, host))
        if not users:
            continue
        if args.user:
            if args.user not in users:
                if len(services) == 1:
                    raise UsageError(f"No account “{args.user}” is signed in on {host}.")
                continue
            target = args.user
        elif len(users) == 2:
            target = next(u for u in users if u != ctx.hosts.active(s, host))
        elif len(users) == 1:
            ctx.io.say(f"Only {users[0]} is signed in on {host}.")
            continue
        else:
            raise UsageError(f"Several accounts on {host}: name one with --user ({', '.join(users)}).")
        ctx.hosts.switch(s, host, target)
        ctx.io.say(f"{'GitHub' if s == accounts.GITHUB else ctx.config.site_name} on {host}: {target} is active now.")
    return 0


# ── git ──


def _helper_command() -> str:
    return f"!{shlex.quote(sys.executable)} -m oscr_cli auth git-credential"


def _setup_git(ctx: Any, args: argparse.Namespace) -> int:
    web = ctx.config.github_web
    if urllib.parse.urlsplit(web).netloc.lower() == ctx.config.host:
        raise UsageError("GitHub's address and the registry's are the same host: the helper serves GitHub only.")
    key = f"credential.{web}.helper"
    # Only this host's helpers are replaced: an empty entry first (git's way to drop the helpers set before
    # for this address), then the tool.
    ctx.git.run(["config", "--global", "--replace-all", key, ""], cwd=ctx.cwd)
    ctx.git.run(["config", "--global", "--add", key, _helper_command()], cwd=ctx.cwd)
    ctx.io.say(f"git now asks this tool for {web} only; every other host keeps its own helpers.")
    return 0


def _read_request(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            break
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


def _git_credential(ctx: Any, args: argparse.Namespace) -> int:
    """git's credential helper protocol: `get` answers for GitHub's host only; `store` and `erase` do
    nothing (the keychain is the tool's own, changed by `oscr auth` only)."""
    req = _read_request(ctx.io.inp.read())
    if args.operation != "get":
        return 0
    web = urllib.parse.urlsplit(ctx.config.github_web)
    host = req.get("host", "").lower()
    if req.get("protocol") != web.scheme or host != web.netloc.lower() or host == ctx.config.host:
        return 0  # not GitHub's host: say nothing, git asks the next helper
    try:
        c = accounts.credential(ctx, accounts.GITHUB, host=ctx.config.github_host)
        if c.source == "keychain" and c.expired:
            c = ghauth.refresh(ctx, c, quiet=True)
    except AuthError:
        return 0
    user = c.user or "x-access-token"
    ctx.io.write(f"protocol={web.scheme}\nhost={web.netloc}\nusername={user}\npassword={c.token}\n")
    return 0


def register(sub: Any) -> None:
    _, s = group(sub, "auth", help="sign in to GitHub and the registry; who is signed in",
                 examples_=["oscr auth login", "oscr auth status", "oscr auth switch --github", "oscr auth logout --oscr"])

    def which(p: argparse.ArgumentParser) -> None:
        p.add_argument("--github", action="store_true", help="GitHub only")
        p.add_argument("--oscr", action="store_true", help="the registry only")
        p.add_argument("--hostname", default=None, help="the registry's host (else the setting `host`)")

    p = command(s, "login", help="sign in: GitHub's device flow, then the registry's (both approved in your browser)", handler=_login,
                examples_=["oscr auth login", "oscr auth login --oscr --scopes repos:read,research:write --days 90",
                           "oscr auth login --github --no-browser", "oscr auth login --oscr --with-token < token.txt"])
    which(p)
    p.add_argument("--scopes", default=None, help="the registry token's scopes, comma-separated (default: repos:read,research:read,research:write,social:read,notifications:read)")
    p.add_argument("--days", type=int, default=None, help="the registry token's life in days, 1 to 366 (default 90)")
    p.add_argument("--with-token", action="store_true", help="read a token from standard input instead")
    p.add_argument("--no-browser", action="store_true", help="print the address instead of opening it")
    p.add_argument("--insecure-storage", action="store_true", help="keep the credentials in a plain file (mode 0600), not the keychain")
    p.add_argument("--skip-git-hint", action="store_true", help=argparse.SUPPRESS)

    p = command(s, "status", help="who is signed in, where the credentials are kept, whether they still work", handler=_status,
                examples_=["oscr auth status", "oscr auth status --offline", "oscr auth status --json service,user,valid"])
    which(p)
    p.add_argument("--offline", action="store_true", help="do not ask GitHub and the registry whether the tokens still work")
    add_format_flags(p, STATUS_FIELDS)

    p = command(s, "token", help="print the active token (for a script's environment)", handler=_token,
                examples_=["GH_TOKEN=$(oscr auth token --github) some-tool", "oscr auth token --oscr | wc -c"])
    which(p)
    p.add_argument("--user", default=None, help="another signed-in account than the active one")

    p = command(s, "logout", help="sign out: the token removed from the keychain (the registry's revoked)", handler=_logout,
                examples_=["oscr auth logout", "oscr auth logout --github --user ada-lab"])
    which(p)
    p.add_argument("--user", default=None, help="the account (else the active one)")

    p = command(s, "refresh", help="a new token: GitHub's renewed, the registry's approved again", handler=_refresh,
                examples_=["oscr auth refresh --github", "oscr auth refresh --oscr --scopes repos:read,statuses:write"])
    which(p)
    p.add_argument("--user", default=None, help="the account (else the active one)")
    p.add_argument("--scopes", default=None, help="the registry token's new scopes")
    p.add_argument("--days", type=int, default=None, help="the registry token's life in days")
    p.add_argument("--no-browser", action="store_true", help="print the address instead of opening it")

    p = command(s, "switch", help="make another signed-in account the active one", handler=_switch,
                examples_=["oscr auth switch", "oscr auth switch --github --user ada-lab"])
    which(p)
    p.add_argument("--user", default=None, help="the account to make active")

    command(s, "setup-git", help="make the tool git's credential helper for GitHub's host only", handler=_setup_git,
            examples_=["oscr auth setup-git", "git clone https://github.com/lab/eeg-analysis"])

    p = command(s, "git-credential", help="git's credential helper (git runs it; it answers for GitHub only)", handler=_git_credential,
                examples_=["printf 'protocol=https\\nhost=github.com\\n\\n' | oscr auth git-credential get"])
    p.add_argument("operation", choices=("get", "store", "erase"))
