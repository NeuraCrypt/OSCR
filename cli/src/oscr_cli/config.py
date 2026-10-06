"""The tool's settings and its list of accounts (``oscr config``; docs/CLI.md "Configuration").

Where: ``$OSCR_CONFIG_DIR``, else ``$XDG_CONFIG_HOME/oscr-cli``, else ``~/.config/oscr-cli`` — never the
harvester's ``~/.config/oscr/settings`` (D14-1). Two files, both JSON, both mode 0600:

- ``config.json``: the settings below and the aliases;
- ``hosts.json``: the accounts signed in, by service and host, with their public handles and the
  scopes and expiries of their credentials. **No credential is ever written here**: tokens live in the
  system's keychain (keyring.py). No email address either: none is ever asked for, read or kept.

Environment variables win over the file for one run (``oscr help environment``).
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import site
from .errors import UsageError

#: Each setting: its default, and what it does (``oscr config list`` says it).
SETTINGS: dict[str, tuple[Any, str]] = {
    "host": (site.DEFAULT_HOST, f"the {site.SITE_NAME} host the tool talks to"),
    "site_name": ("", "the platform's name to show (empty: the tool's own)"),
    "github_web": (site.DEFAULT_GITHUB_WEB, "GitHub's web address (the device flow, git)"),
    "github_api": (site.DEFAULT_GITHUB_API, "GitHub's API address"),
    "github_client_id": ("", "the GitHub App's public client id for the device flow (empty: asked of the site)"),
    "git_protocol": ("https", "https or ssh: how `repo clone` and `pr checkout` reach GitHub"),
    "git_url": ("", "the address git clones from (empty: github_web; a mirror, or a test's local folder)"),
    "color": ("auto", "auto, always or never"),
    "accessible_colors": ("false", "true: colours that never rely on red against green, words always"),
    "spinner": ("true", "false: no animation while waiting (a line says what it waits for)"),
    "prompt": ("enabled", "enabled or disabled: interactive questions in a terminal"),
    "browser": ("", "the command that opens a page (empty: the system's; `none`: print the address)"),
    "editor": ("", "the editor for bodies (empty: $VISUAL, $EDITOR, then vi)"),
    "pager": ("", "the pager for long output (empty: $PAGER; `cat`: none)"),
    "credential_store": ("keychain", "keychain, or file (a 0600 file: asked for explicitly, with a warning)"),
}

#: The environment variables that stand for a setting.
ENV_OF: dict[str, str] = {
    "host": "OSCR_HOST",
    "site_name": "OSCR_SITE_NAME",
    "github_web": "OSCR_GITHUB_WEB",
    "github_api": "OSCR_GITHUB_API",
    "github_client_id": "OSCR_GITHUB_CLIENT_ID",
    "git_url": "OSCR_GIT_URL",
    "browser": "OSCR_BROWSER",
    "editor": "OSCR_EDITOR",
    "pager": "OSCR_PAGER",
    "prompt": "OSCR_PROMPT",
}

BOOLEANS = {"accessible_colors", "spinner"}
CHOICES = {
    "color": ("auto", "always", "never"),
    "prompt": ("enabled", "disabled"),
    "git_protocol": ("https", "ssh"),
    "credential_store": ("keychain", "file"),
}


def config_dir(env: Mapping[str, str]) -> Path:
    if env.get("OSCR_CONFIG_DIR"):
        return Path(env["OSCR_CONFIG_DIR"]).expanduser()
    base = env.get("XDG_CONFIG_HOME") or str(Path(env.get("HOME") or Path.home()) / ".config")
    return Path(base).expanduser() / "oscr-cli"


def _read(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise UsageError(f"{path} is not readable JSON ({e}): fix it or remove it.") from e
    return data if isinstance(data, dict) else {}


def _write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


@dataclass
class Config:
    """The settings, read from the file and the environment."""

    dir: Path
    env: Mapping[str, str]
    data: dict[str, Any]
    #: A host for this run only (--hostname), over the setting and OSCR_HOST.
    host_override: str | None = None

    @classmethod
    def load(cls, env: Mapping[str, str]) -> Config:
        d = config_dir(env)
        return cls(dir=d, env=env, data=_read(d / "config.json"))

    # ── settings ──
    def get(self, key: str) -> str:
        if key not in SETTINGS:
            raise UsageError(f"There is no setting “{key}”: `oscr config list` shows them.")
        env_name = ENV_OF.get(key)
        if env_name and self.env.get(env_name):
            return str(self.env[env_name])
        value = self.data.get(key)
        return str(SETTINGS[key][0]) if value is None or value == "" else str(value)

    def flag(self, key: str) -> bool:
        return self.get(key).strip().lower() in ("1", "true", "yes", "on")

    def set(self, key: str, value: str) -> None:
        if key not in SETTINGS:
            raise UsageError(f"There is no setting “{key}”: `oscr config list` shows them.")
        value = value.strip()
        if key in BOOLEANS and value.lower() not in ("true", "false"):
            raise UsageError(f"{key} is true or false.")
        if key in CHOICES and value not in CHOICES[key]:
            raise UsageError(f"{key} is one of: {', '.join(CHOICES[key])}.")
        if key in ("host",):
            value = normal_host(value)
        if key in ("github_web", "github_api") and not value.startswith(("https://", "http://127.0.0.1", "http://localhost")):
            raise UsageError(f"{key} is an https address.")
        if key in BOOLEANS:
            value = value.lower()
        self.data[key] = value
        self.save()

    def unset(self, key: str) -> None:
        self.data.pop(key, None)
        self.save()

    def save(self) -> None:
        _write(self.dir / "config.json", self.data)

    # ── aliases ──
    def aliases(self) -> dict[str, str]:
        a = self.data.get("aliases")
        return {str(k): str(v) for k, v in a.items()} if isinstance(a, dict) else {}

    def set_alias(self, name: str, expansion: str) -> None:
        a = self.aliases()
        a[name] = expansion
        self.data["aliases"] = a
        self.save()

    def delete_alias(self, name: str) -> bool:
        a = self.aliases()
        if name not in a:
            return False
        del a[name]
        self.data["aliases"] = a
        self.save()
        return True

    # ── the host ──
    @property
    def host(self) -> str:
        return normal_host(self.host_override or self.get("host"))

    @property
    def site_name(self) -> str:
        return self.get("site_name") or site.SITE_NAME

    def base_url(self, host: str | None = None) -> str:
        """The registry's address: https, except on this machine (a local `wrangler dev`)."""
        h = host or self.host
        local = h.split(":")[0] in ("localhost", "127.0.0.1")
        return f"{'http' if local else 'https'}://{h}"

    @property
    def github_web(self) -> str:
        return self.get("github_web").rstrip("/")

    @property
    def github_api(self) -> str:
        return self.get("github_api").rstrip("/")

    @property
    def github_host(self) -> str:
        """The host git reaches GitHub at (github.com; the fake GitHub's in tests)."""
        from urllib.parse import urlsplit

        return urlsplit(self.github_web).netloc.lower()


def normal_host(value: str) -> str:
    """A host as the tool keeps it: no scheme, no path, lower case (``localhost:8791`` keeps its port)."""
    v = value.strip().lower()
    for prefix in ("https://", "http://"):
        if v.startswith(prefix):
            v = v[len(prefix):]
    v = v.split("/")[0]
    if not v or any(c in v for c in " @?#\\"):
        raise UsageError(f"“{value}” is not a host name.")
    return v


# ── the accounts (no credential here) ──


class Hosts:
    """``hosts.json``: for each service (``oscr``, ``github``) and host, the accounts signed in and the
    active one. What an account keeps: its public handle and what its credential may do and until when.
    """

    def __init__(self, directory: Path):
        self.path = directory / "hosts.json"
        self.data = _read(self.path)

    def _host(self, service: str, host: str) -> dict[str, Any]:
        return self.data.setdefault(service, {}).setdefault(host, {"active": None, "users": {}})

    def users(self, service: str, host: str) -> dict[str, dict[str, Any]]:
        return dict(self.data.get(service, {}).get(host, {}).get("users", {}))

    def active(self, service: str, host: str) -> str | None:
        h = self.data.get(service, {}).get(host, {})
        user = h.get("active")
        return user if user in h.get("users", {}) else None

    def add(self, service: str, host: str, user: str, facts: dict[str, Any]) -> None:
        h = self._host(service, host)
        h["users"][user] = facts
        h["active"] = user
        self.save()

    def switch(self, service: str, host: str, user: str) -> None:
        h = self._host(service, host)
        if user not in h["users"]:
            raise UsageError(f"No account “{user}” is signed in on {host}.")
        h["active"] = user
        self.save()

    def remove(self, service: str, host: str, user: str) -> None:
        h = self._host(service, host)
        h["users"].pop(user, None)
        if h.get("active") == user:
            h["active"] = next(iter(h["users"]), None)
        if not h["users"]:
            self.data.get(service, {}).pop(host, None)
        self.save()

    def hosts(self, service: str) -> list[str]:
        return sorted(self.data.get(service, {}))

    def save(self) -> None:
        _write(self.path, self.data)
