"""The accounts signed in: their public facts in ``hosts.json`` (config.py), their secrets in the
keychain (keyring.py), and the token a command uses (D14-3).

Which token a command uses:

- the registry: ``OSCR_TOKEN`` when set (a CI job's), else the active account's on the host;
- GitHub: ``OSCR_GITHUB_TOKEN`` or ``GH_TOKEN`` when set, else the active account's, renewed first when
  it expired and its refresh token is still good. ``GITHUB_TOKEN`` is not read: on the registry's own
  Mac it is the harvester's.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from . import keyring
from .errors import AuthError

OSCR = "oscr"
GITHUB = "github"
SERVICE_WORDS = {OSCR: "the registry", GITHUB: "GitHub"}


@dataclass
class Credential:
    service: str
    host: str
    user: str
    token: str
    secret: dict[str, Any]
    facts: dict[str, Any]
    source: str  # "keychain" or the environment variable's name

    @property
    def expired(self) -> bool:
        exp = self.facts.get("expires_at")
        return isinstance(exp, (int, float)) and exp <= time.time() + 60


def store(ctx: Any) -> keyring.Keyring:
    if ctx.keyring is None:
        ctx.keyring = keyring.choose(ctx.config, ctx.env, insecure=bool(getattr(ctx.args, "insecure_storage", False)))
    return ctx.keyring


def store_of(ctx: Any, service: str, host: str, user: str) -> keyring.Keyring:
    """Where this account's credential is: the plain file when it was kept there as asked, else the
    keychain."""
    if ctx.hosts.users(service, host).get(user, {}).get("store") == "file":
        return keyring.FileStore(ctx.config.dir / "credentials.json")
    return store(ctx)


def save(ctx: Any, service: str, host: str, user: str, secret: dict[str, Any], facts: dict[str, Any]) -> None:
    ks = store(ctx)
    label = f"oscr-cli: {SERVICE_WORDS[service]} ({user}) on {host}"
    ks.set(keyring.item(service, host, user), secret, label)
    if isinstance(ks, keyring.FileStore):
        facts = {**facts, "store": "file"}
        ctx.io.warn(f"The credential was written to {ks.path} (a plain file, mode 0600), as you asked, not to your system's keychain.")
    ctx.hosts.add(service, host, user, facts)


def forget(ctx: Any, service: str, host: str, user: str) -> bool:
    had = store_of(ctx, service, host, user).delete(keyring.item(service, host, user))
    ctx.hosts.remove(service, host, user)
    return had


def github_host(ctx: Any) -> str:
    return ctx.config.github_host


def pick_user(ctx: Any, service: str, host: str, user: str | None) -> str:
    users = ctx.hosts.users(service, host)
    if user:
        if user not in users:
            raise AuthError(f"No account “{user}” is signed in to {SERVICE_WORDS[service]} on {host}.", hint="oscr auth status lists them.")
        return user
    active = ctx.hosts.active(service, host)
    if not active:
        raise AuthError(f"You are not signed in to {SERVICE_WORDS[service]} on {host}.", hint="Run `oscr auth login` first.")
    return active


def credential(ctx: Any, service: str, *, host: str | None = None, user: str | None = None, env_first: bool = True) -> Credential:
    """The token a command uses (the environment's first, unless ``env_first`` is false)."""
    h = host or (ctx.config.host if service == OSCR else github_host(ctx))
    if env_first:
        names = ("OSCR_TOKEN",) if service == OSCR else ("OSCR_GITHUB_TOKEN", "GH_TOKEN")
        for name in names:
            v = ctx.env.get(name, "").strip()
            if v:
                return Credential(service, h, "", v, {"token": v}, {}, name)
    u = pick_user(ctx, service, h, user)
    ks = store_of(ctx, service, h, u)
    secret = ks.get(keyring.item(service, h, u))
    if not secret or not secret.get("token"):
        raise AuthError(f"The credential of {u} on {h} is not in {ks.name} any more.", hint="Run `oscr auth login` again.")
    return Credential(service, h, u, str(secret["token"]), secret, ctx.hosts.users(service, h).get(u, {}), "keychain")


def github_token(ctx: Any) -> str:
    """GitHub's token for a command, renewed when it expired and can be."""
    c = credential(ctx, GITHUB)
    if c.source == "keychain" and c.expired:
        from . import ghauth

        c = ghauth.refresh(ctx, c, quiet=True)
    return c.token


def oscr_token(ctx: Any) -> str:
    c = credential(ctx, OSCR)
    if c.source == "keychain" and c.expired:
        raise AuthError(f"Your registry token on {c.host} expired.", hint="Run `oscr auth refresh --oscr` (or `oscr auth login --oscr`).")
    return c.token
