"""Where credentials are kept: the system's keychain, and nowhere else unless the person asks (D14-3;
``oscr help auth``).

- **macOS**: the login keychain, through Apple's ``security`` command, as the harvester reads its own
  tokens. A secret is written with ``security -i`` reading its command from standard input, so the
  secret never appears on a command line (``ps`` shows the arguments of every process); it is read back
  with ``find-generic-password -w``, whose output the tool captures.
- **Linux**: the Secret Service (GNOME Keyring, KWallet), through ``secret-tool``, which reads the secret
  from standard input.
- **A plain file**, ``credentials.json`` in the tool's folder, mode 0600, only when the person asks for it
  (``--insecure-storage`` or ``credential_store = file``), and said with a warning each time it is
  written.

Every item's service is ``oscr-cli`` and its account ``<service>:<host>:<user>`` (``github:github.com:ada``,
``oscr:<host>:ada``): never the harvester's ``org.oscr.*`` entries, which this tool never reads or writes.
The secret is a small JSON object (the token, and GitHub's refresh token), stored as base64url so that it
is one word of safe characters.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from .errors import CliError

SERVICE = "oscr-cli"


def item(service: str, host: str, user: str) -> str:
    return f"{service}:{host}:{user}"


def encode(secret: Mapping[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(dict(secret), separators=(",", ":")).encode()).decode().rstrip("=")


def decode(text: str) -> dict[str, Any]:
    t = text.strip()
    try:
        data = json.loads(base64.urlsafe_b64decode(t + "=" * (-len(t) % 4)))
    except (ValueError, TypeError) as e:
        raise CliError("A credential in the keychain is not readable: sign in again (oscr auth login).") from e
    return data if isinstance(data, dict) else {}


class Keyring(Protocol):
    name: str

    def get(self, account: str) -> dict[str, Any] | None: ...

    def set(self, account: str, secret: Mapping[str, Any], label: str) -> None: ...

    def delete(self, account: str) -> bool: ...


class MacKeychain:
    """The macOS keychain (the login keychain, or a keychain file given for tests)."""

    name = "the macOS keychain"

    def __init__(self, keychain: str | None = None):
        self.keychain = keychain

    def _where(self) -> list[str]:
        return [self.keychain] if self.keychain else []

    def get(self, account: str) -> dict[str, Any] | None:
        p = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w", *self._where()],
                           capture_output=True, text=True, check=False)
        if p.returncode != 0 or not p.stdout.strip():
            return None
        return decode(p.stdout)

    def set(self, account: str, secret: Mapping[str, Any], label: str) -> None:
        value = encode(secret)
        where = f' "{self.keychain}"' if self.keychain else ""
        safe_label = label.replace('"', "'").replace("\\", "/")
        # One command, read by `security -i` from standard input: the secret is on no command line.
        command = f'add-generic-password -U -s "{SERVICE}" -a "{account}" -l "{safe_label}" -w "{value}"{where}\n'
        p = subprocess.run(["security", "-i"], input=command, capture_output=True, text=True, check=False)
        if p.returncode != 0 or "error" in p.stderr.lower():
            raise CliError("The macOS keychain refused to keep the credential (is it locked?): unlock it, then sign in again.")

    def delete(self, account: str) -> bool:
        p = subprocess.run(["security", "delete-generic-password", "-s", SERVICE, "-a", account, *self._where()],
                           capture_output=True, text=True, check=False)
        return p.returncode == 0


class SecretService:
    """The Secret Service on Linux, through secret-tool (libsecret)."""

    name = "the Secret Service (secret-tool)"

    def __init__(self, program: str = "secret-tool"):
        self.program = program

    def get(self, account: str) -> dict[str, Any] | None:
        p = subprocess.run([self.program, "lookup", "service", SERVICE, "account", account], capture_output=True, text=True, check=False)
        if p.returncode != 0 or not p.stdout.strip():
            return None
        return decode(p.stdout)

    def set(self, account: str, secret: Mapping[str, Any], label: str) -> None:
        p = subprocess.run([self.program, "store", f"--label={label}", "service", SERVICE, "account", account],
                           input=encode(secret), capture_output=True, text=True, check=False)
        if p.returncode != 0:
            raise CliError("The Secret Service refused to keep the credential (is a keyring unlocked?).")

    def delete(self, account: str) -> bool:
        p = subprocess.run([self.program, "clear", "service", SERVICE, "account", account], capture_output=True, text=True, check=False)
        return p.returncode == 0


class FileStore:
    """A plain JSON file, mode 0600: only when the person asked for it."""

    name = "a plain file (asked for: not the keychain)"

    def __init__(self, path: Path):
        self.path = path

    def _all(self) -> dict[str, str]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self, data: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.chmod(self.path, 0o600)

    def get(self, account: str) -> dict[str, Any] | None:
        v = self._all().get(account)
        return decode(v) if v else None

    def set(self, account: str, secret: Mapping[str, Any], label: str) -> None:
        data = self._all()
        data[account] = encode(secret)
        self._save(data)

    def delete(self, account: str) -> bool:
        data = self._all()
        if account not in data:
            return False
        del data[account]
        self._save(data)
        return True


class MemoryKeyring:
    """In memory (the tests' fake keychain)."""

    name = "memory"

    def __init__(self) -> None:
        self.items: dict[str, str] = {}
        self.labels: dict[str, str] = {}

    def get(self, account: str) -> dict[str, Any] | None:
        v = self.items.get(account)
        return decode(v) if v else None

    def set(self, account: str, secret: Mapping[str, Any], label: str) -> None:
        self.items[account] = encode(secret)
        self.labels[account] = label

    def delete(self, account: str) -> bool:
        return self.items.pop(account, None) is not None


def choose(config: Any, env: Mapping[str, str], *, insecure: bool = False) -> Keyring:
    """The keychain of this system, or the plain file when the person asked for it."""
    if insecure or config.get("credential_store") == "file":
        return FileStore(config.dir / "credentials.json")
    if env.get("OSCR_KEYCHAIN"):
        # A keychain file of the person's (or a test's) own choosing, on macOS.
        return MacKeychain(env["OSCR_KEYCHAIN"])
    if sys.platform == "darwin" and shutil.which("security"):
        return MacKeychain()
    if shutil.which("secret-tool"):
        return SecretService()
    raise CliError(
        "No system keychain was found to keep your credentials.",
        hint="On Linux, install secret-tool (Debian and Ubuntu: libsecret-tools) with a keyring running; or sign in with "
        "--insecure-storage to keep them in a plain file readable by your account only (mode 0600).",
    )
