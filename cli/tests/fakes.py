"""A fake GitHub and a fake registry, on 127.0.0.1, for the tool's unit tests (the end-to-end run uses the
website's own fake GitHub and a local `wrangler dev`). Their answers have GitHub's and the registry's
shapes; they hold test values only."""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
import urllib.parse
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

CLIENT_ID = "Iv23liTESTCLIENT"
Handler = Callable[["Req"], tuple[int, Any] | tuple[int, Any, dict[str, str]]]


class Req:
    def __init__(self, method: str, path: str, query: dict[str, list[str]], headers: dict[str, str], body: bytes, match: re.Match[str]):
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.raw = body
        self.m = match

    @property
    def json(self) -> Any:
        try:
            return json.loads(self.raw or b"{}")
        except ValueError:
            return None

    @property
    def form(self) -> dict[str, str]:
        return {k: v[0] for k, v in urllib.parse.parse_qs(self.raw.decode()).items()}

    def q(self, name: str, default: str | None = None) -> str | None:
        return self.query.get(name, [default])[0]

    @property
    def token(self) -> str | None:
        a = self.headers.get("authorization", "")
        m = re.match(r"^(?:Bearer|token)\s+(\S+)$", a)
        return m.group(1) if m else None


class FakeServer:
    def __init__(self) -> None:
        self.routes: list[tuple[str, re.Pattern[str], Handler]] = []
        self.log: list[dict[str, Any]] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def _any(self) -> None:
                u = urllib.parse.urlsplit(self.path)
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                headers = {k.lower(): v for k, v in self.headers.items()}
                outer.log.append({"method": self.command, "path": u.path, "query": u.query, "auth": headers.get("authorization"), "body": body})
                for method, pattern, handler in outer.routes:
                    m = pattern.match(u.path)
                    if method == self.command and m:
                        out = handler(Req(self.command, u.path, urllib.parse.parse_qs(u.query), headers, body, m))
                        status, payload = out[0], out[1]
                        extra = out[2] if len(out) > 2 else {}
                        break
                else:
                    status, payload, extra = 404, {"message": f"Not Found: {self.command} {u.path}"}, {}
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                ctype = "application/octet-stream" if isinstance(payload, bytes) else "application/json; charset=utf-8"
                self.send_header("Content-Type", extra.pop("Content-Type", ctype))
                for k, v in extra.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def on(self, method: str, pattern: str, handler: Handler) -> None:
        self.routes.append((method, re.compile(f"^{pattern}$"), handler))

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class FakeGitHub(FakeServer):
    """github.com under /web, api.github.com under /api."""

    def __init__(self) -> None:
        super().__init__()
        self.users: dict[str, dict[str, Any]] = {}      # token → user
        self.refresh: dict[str, str] = {}               # refresh token → login
        self.devices: dict[str, dict[str, Any]] = {}    # device_code → state
        self.refresh_refused = False
        self.device_disabled = False
        self.verification_host: str | None = None
        self.add_user("ada-fixture", 1001)
        self.add_user("bob-fixture", 1002)
        self.on("POST", "/web/login/device/code", self._device_code)
        self.on("POST", "/web/login/oauth/access_token", self._access_token)
        self.on("GET", "/api/user", self._user)

    @property
    def web(self) -> str:
        return f"{self.base}/web"

    @property
    def api(self) -> str:
        return f"{self.base}/api"

    def add_user(self, login: str, uid: int) -> str:
        token = f"ghu_{login.replace('-', '')}{secrets.token_hex(8)}"
        self.users[token] = {"login": login, "id": uid}
        return token

    def token_of(self, login: str) -> str:
        return next(t for t, u in self.users.items() if u["login"] == login)

    def _device_code(self, r: Req) -> tuple[int, Any]:
        if r.form.get("client_id") != CLIENT_ID:
            return 401, {"error": "incorrect_client_credentials"}
        if self.device_disabled:
            return 400, {"error": "device_flow_disabled"}
        code = secrets.token_hex(20)
        user_code = f"{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
        self.devices[code] = {"user_code": user_code, "state": "pending", "login": None, "polls": 0}
        host = self.verification_host or self.web
        return 200, {"device_code": code, "user_code": user_code, "verification_uri": f"{host}/login/device", "expires_in": 900, "interval": 5}

    def approve(self, login: str = "ada-fixture") -> None:
        for d in self.devices.values():
            if d["state"] == "pending":
                d["state"], d["login"] = "approved", login

    def deny(self) -> None:
        for d in self.devices.values():
            if d["state"] == "pending":
                d["state"] = "denied"

    def expire(self) -> None:
        for d in self.devices.values():
            if d["state"] == "pending":
                d["state"] = "expired"

    def _mint(self, login: str) -> dict[str, Any]:
        uid = next(u["id"] for u in self.users.values() if u["login"] == login)
        token = f"ghu_{secrets.token_hex(18)}"
        rt = f"ghr_{secrets.token_hex(30)}"
        self.users[token] = {"login": login, "id": uid}
        self.refresh[rt] = login
        return {"access_token": token, "expires_in": 28800, "refresh_token": rt, "refresh_token_expires_in": 15811200, "token_type": "bearer", "scope": ""}

    def _access_token(self, r: Req) -> tuple[int, Any]:
        f = r.form
        if f.get("client_id") != CLIENT_ID:
            return 200, {"error": "incorrect_client_credentials"}
        if f.get("grant_type") == "refresh_token":
            login = self.refresh.pop(f.get("refresh_token", ""), None)
            if self.refresh_refused or not login:
                return 200, {"error": "bad_refresh_token", "error_description": "The refresh token passed is incorrect or expired."}
            return 200, self._mint(login)
        if f.get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code":
            return 200, {"error": "unsupported_grant_type"}
        d = self.devices.get(f.get("device_code", ""))
        if not d:
            return 200, {"error": "incorrect_device_code"}
        d["polls"] += 1
        if d["state"] == "pending":
            return 200, {"error": "authorization_pending"}
        if d["state"] == "denied":
            return 200, {"error": "access_denied"}
        if d["state"] == "expired":
            return 200, {"error": "expired_token"}
        if d["state"] == "used":
            return 200, {"error": "incorrect_device_code"}
        d["state"] = "used"
        return 200, self._mint(d["login"])

    def _user(self, r: Req) -> tuple[int, Any]:
        u = self.users.get(r.token or "")
        if not u:
            return 401, {"message": "Bad credentials"}
        return 200, {"login": u["login"], "id": u["id"], "type": "User", "email": None}


class FakeOscr(FakeServer):
    """The registry's public API (/api/v1) and its static files."""

    SCOPES = ("repos:read", "research:read", "research:write", "social:read", "social:write", "notifications:read",
              "notifications:write", "hooks:read", "hooks:write", "statuses:write")

    def __init__(self, client_id: str = CLIENT_ID) -> None:
        super().__init__()
        self.client_id = client_id
        self.tokens: dict[str, dict[str, Any]] = {}
        self.devices: dict[str, dict[str, Any]] = {}
        self.page_host: str | None = None
        self.on("GET", "/api/v1/cli", lambda r: (200, {"github": {"client_id": self.client_id}, "device": {"code": "/api/v1/device/code", "token": "/api/v1/device/token", "verification": "/device/"}, "scopes": list(self.SCOPES)}))
        self.on("POST", "/api/v1/device/code", self._code)
        self.on("POST", "/api/v1/device/token", self._token)
        self.on("GET", "/api/v1/user", self._user)
        self.on("POST", "/api/v1/token/revoke", self._revoke)

    @property
    def host(self) -> str:
        return self.base.split("://")[1]

    def make_token(self, github: str = "ada-fixture", scopes: tuple[str, ...] = ("repos:read", "research:read"), days: int = 90) -> str:
        token = "oscr_pat_" + secrets.token_urlsafe(32)[:43].ljust(43, "A")
        self.tokens[token] = {"github": github, "orcid": "0000-0002-1825-0097", "id": secrets.token_urlsafe(12)[:16], "scopes": list(scopes),
                              "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + days * 86400))}
        return token

    def _code(self, r: Req) -> tuple[int, Any]:
        b = r.json or {}
        scopes = b.get("scopes") or []
        if not scopes or any(s not in self.SCOPES for s in scopes):
            return 400, {"error": {"code": "bad_payload", "message": "Not a scope of the registry's tokens."}}
        days = b.get("days", 30)
        if not isinstance(days, int) or not 1 <= days <= 366:
            return 400, {"error": {"code": "bad_payload", "message": "1 to 366 days."}}
        device = "oscr_dc_" + secrets.token_urlsafe(30) + "." + secrets.token_urlsafe(32)[:43].ljust(43, "A")
        user_code = "BCDF-GHJK"
        self.devices[device] = {"state": "pending", "scopes": scopes, "days": days, "user": None, "last": 0.0}
        page = self.page_host or self.base
        return 200, {"device_code": device, "user_code": user_code, "verification_uri": f"{page}/device/?r=abc.def", "expires_in": 900, "interval": 5, "scopes": scopes, "days": days}

    def approve(self, github: str = "ada-fixture") -> None:
        for d in self.devices.values():
            if d["state"] == "pending":
                d["state"], d["user"] = "approved", github

    def deny(self) -> None:
        for d in self.devices.values():
            if d["state"] == "pending":
                d["state"] = "denied"

    def _token(self, r: Req) -> tuple[int, Any]:
        d = self.devices.get((r.json or {}).get("device_code", ""))
        err = lambda code, words, status=400, **x: (status, {"error": {"code": code, "message": words, **x}})  # noqa: E731
        if not d:
            return err("expired_token", "This code is not valid.")
        if d["state"] == "pending":
            return err("authorization_pending", "Not approved yet.")
        if d["state"] == "denied":
            return err("access_denied", "Refused.")
        if d["state"] == "collected":
            return err("expired_token", "This code was used already.")
        d["state"] = "collected"
        token = self.make_token(d["user"], tuple(d["scopes"]), d["days"])
        t = self.tokens[token]
        return 200, {"access_token": token, "token_type": "bearer", "scopes": t["scopes"], "expires_at": t["expires_at"], "id": t["id"]}

    def _user(self, r: Req) -> tuple[int, Any]:
        t = self.tokens.get(r.token or "")
        if not t:
            return 401, {"error": {"code": "bad_credentials", "message": "This token is not valid."}}
        return 200, {"github": t["github"], "orcid": t["orcid"], "token": {"id": t["id"], "scopes": t["scopes"], "expires_at": t["expires_at"]}}

    def _revoke(self, r: Req) -> tuple[int, Any]:
        t = self.tokens.pop(r.token or "", None)
        if not t:
            return 401, {"error": {"code": "bad_credentials", "message": "This token is not valid."}}
        return 200, {"ok": True, "revoked": t["id"]}
