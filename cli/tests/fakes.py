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

    def on(self, method: str, pattern: str, handler: Handler, *, first: bool = False) -> None:
        route = (method, re.compile(f"^{pattern}$"), handler)
        if first:
            self.routes.insert(0, route)
        else:
            self.routes.append(route)

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
        self._model()

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
    """The registry's public API (/api/forge/v1) and its static files."""

    SCOPES = ("repos:read", "research:read", "research:write", "social:read", "social:write", "notifications:read",
              "notifications:write", "hooks:read", "hooks:write", "statuses:write")

    def __init__(self, client_id: str = CLIENT_ID) -> None:
        super().__init__()
        self.client_id = client_id
        self.tokens: dict[str, dict[str, Any]] = {}
        self.devices: dict[str, dict[str, Any]] = {}
        self.page_host: str | None = None
        self.on("GET", "/api/forge/v1/cli", lambda r: (200, {"github": {"client_id": self.client_id}, "device": {"code": "/api/forge/v1/device/code", "token": "/api/forge/v1/device/token", "verification": "/device/"}, "scopes": list(self.SCOPES)}))
        self.on("POST", "/api/forge/v1/device/code", self._code)
        self.on("POST", "/api/forge/v1/device/token", self._token)
        self.on("GET", "/api/forge/v1/user", self._user)
        self.on("POST", "/api/forge/v1/token/revoke", self._revoke)
        # Static files (the site's /forge/*.json shards) and the registry's layer over repositories.
        self.files: dict[str, Any] = {}
        self.repos: dict[str, dict[str, Any]] = {}
        self.on("GET", "/forge/.+", lambda r: (200, self.files[r.path]) if r.path in self.files else (404, b"Not Found"))
        self.on("GET", "/api/forge/v1/repos", self._repo)
        self.research: list[dict[str, Any]] = []
        self.search_results: list[dict[str, Any]] = [{"doi": "10.5555/oscr.fixture.1", "title": "A synthetic EEG study", "page": "/paper/x/"}]
        self.on("GET", "/api/search", lambda r: (200, {"results": self.search_results, "total": len(self.search_results)}))
        self.on("GET", "/api/forge/v1/search", lambda r: (200, {"results": self.search_results, "total": len(self.search_results)}) if self.tokens.get(r.token or "") else (401, {"error": {"code": "requires_authentication", "message": "token"}}))
        self.on("POST", "/api/forge/v1/research/open", self._research)

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

    def _repo(self, r: Req) -> tuple[int, Any]:
        if not self.tokens.get(r.token or ""):
            return 401, {"error": {"code": "requires_authentication", "message": "This route needs a token."}}
        repo = self.repos.get((r.q("path") or "").lower())
        if not repo:
            return 404, {"error": {"code": "not_found", "message": "The registry does not know this repository."}}
        return 200, repo

    def _research(self, r: Req) -> tuple[int, Any]:
        t = self.tokens.get(r.token or "")
        if not t:
            return 401, {"error": {"code": "requires_authentication", "message": "This route needs a token."}}
        if "research:write" not in t["scopes"]:
            return 403, {"error": {"code": "insufficient_scope", "message": "This token may not do this: it needs the scope research:write."}}
        b = r.json or {}
        self.research.append(b)
        n = len(self.research)
        return 201, {"id": n, "page": f"/research/{n}"}

    def _revoke(self, r: Req) -> tuple[int, Any]:
        t = self.tokens.pop(r.token or "", None)
        if not t:
            return 401, {"error": {"code": "bad_credentials", "message": "This token is not valid."}}
        return 200, {"ok": True, "revoked": t["id"]}


# ── the fake GitHub's repositories, issues, pull requests, releases, runs (GitHub's shapes) ──


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _model(self: FakeGitHub) -> None:
    self.repos: dict[str, dict[str, Any]] = {}
    self.issues: dict[str, list[dict[str, Any]]] = {}
    self.releases: dict[str, list[dict[str, Any]]] = {}
    self.runs: dict[str, list[dict[str, Any]]] = {}
    self.synced: list[str] = []
    R = r"/api/repos/([^/]+)/([^/]+)"

    def who(r: Req) -> dict[str, Any] | None:
        return self.users.get(r.token or "")

    def need(r: Req) -> dict[str, Any] | None:
        return who(r)

    def key(r: Req) -> str:
        return f"{r.m.group(1)}/{r.m.group(2)}".lower()

    def repo_json(k: str) -> dict[str, Any]:
        return self.repos[k]

    def create(r: Req) -> tuple[int, Any]:
        u = need(r)
        if not u:
            return 401, {"message": "Requires authentication"}
        b = r.json or {}
        name = b.get("name", "")
        k = f"{u['login']}/{name}".lower()
        if not re.match(r"^[A-Za-z0-9._-]{1,100}$", name):
            return 422, {"message": "Repository creation failed.", "errors": [{"message": "name is invalid"}]}
        if k in self.repos:
            return 422, {"message": "Repository creation failed.", "errors": [{"message": "name already exists on this account"}]}
        self.repos[k] = {"id": 5000 + len(self.repos), "name": name, "full_name": f"{u['login']}/{name}", "owner": {"login": u["login"], "id": u["id"]},
                         "private": bool(b.get("private")), "visibility": "private" if b.get("private") else "public", "description": b.get("description"),
                         "homepage": b.get("homepage"), "default_branch": "main", "html_url": f"https://github.com/{u['login']}/{name}",
                         "license": {"spdx_id": "MIT"} if b.get("license_template") == "mit" else None, "fork": False, "parent": None,
                         "stargazers_count": 0, "pushed_at": _now(), "updated_at": _now(), "archived": False, "topics": []}
        self.issues[k], self.releases[k], self.runs[k] = [], [], []
        return 201, self.repos[k]

    def one(r: Req) -> tuple[int, Any]:
        k = key(r)
        return (200, self.repos[k]) if k in self.repos else (404, {"message": "Not Found"})

    def mine(r: Req) -> tuple[int, Any]:
        u = need(r)
        if not u:
            return 401, {"message": "Requires authentication"}
        return 200, [x for x in self.repos.values() if x["owner"]["login"] == u["login"] and not x["private"]]

    def theirs(r: Req) -> tuple[int, Any]:
        return 200, [x for x in self.repos.values() if x["owner"]["login"].lower() == r.m.group(1).lower() and not x["private"]]

    def issue_list(r: Req, pulls: bool) -> tuple[int, Any]:
        k = key(r)
        if k not in self.repos:
            return 404, {"message": "Not Found"}
        state = r.q("state", "open")
        items = [i for i in self.issues[k] if ("pull_request" in i) == pulls or (not pulls)]
        if pulls:
            items = [i for i in self.issues[k] if "pull_request" in i]
        items = [i for i in items if state == "all" or i["state"] == state]
        return 200, list(reversed(items))

    def issue_new(r: Req, pull: bool) -> tuple[int, Any]:
        u = need(r)
        k = key(r)
        if not u:
            return 401, {"message": "Requires authentication"}
        if k not in self.repos:
            return 404, {"message": "Not Found"}
        b = r.json or {}
        if not b.get("title"):
            return 422, {"message": "Validation Failed", "errors": [{"field": "title", "code": "missing_field"}]}
        n = len(self.issues[k]) + 1
        item: dict[str, Any] = {"number": n, "title": b["title"], "body": b.get("body") or "", "state": "open", "state_reason": None, "user": {"login": u["login"]},
                                "labels": [{"name": x} for x in b.get("labels") or []], "comments": 0, "created_at": _now(), "updated_at": _now(),
                                "html_url": f"https://github.com/{self.repos[k]['full_name']}/{'pull' if pull else 'issues'}/{n}", "assignees": []}
        if pull:
            item["pull_request"] = {"url": ""}
            item.update({"head": {"ref": b.get("head"), "sha": "0" * 40, "repo": {"full_name": self.repos[k]["full_name"]}}, "base": {"ref": b.get("base")},
                         "draft": bool(b.get("draft")), "merged": False, "mergeable": True})
        self.issues[k].append(item)
        return 201, item

    def issue_one(r: Req, pull: bool) -> tuple[int, Any]:
        k = key(r)
        n = int(r.m.group(3))
        for i in self.issues.get(k, []):
            if i["number"] == n and (("pull_request" in i) or not pull):
                return 200, i
        return 404, {"message": "Not Found"}

    def issue_edit(r: Req) -> tuple[int, Any]:
        if not need(r):
            return 401, {"message": "Requires authentication"}
        code, i = issue_one(r, False)
        if code != 200:
            return code, i
        b = r.json or {}
        for f in ("state", "state_reason", "title", "body"):
            if f in b:
                i[f] = b[f]
        return 200, i

    def comment(r: Req) -> tuple[int, Any]:
        if not need(r):
            return 401, {"message": "Requires authentication"}
        code, i = issue_one(r, False)
        if code != 200:
            return code, i
        i["comments"] += 1
        return 201, {"id": 1, "body": (r.json or {}).get("body", "")}

    def rel_list(r: Req) -> tuple[int, Any]:
        k = key(r)
        return (200, list(reversed(self.releases[k]))) if k in self.releases else (404, {"message": "Not Found"})

    def rel_new(r: Req) -> tuple[int, Any]:
        if not need(r):
            return 401, {"message": "Requires authentication"}
        k = key(r)
        b = r.json or {}
        if any(x["tag_name"] == b.get("tag_name") for x in self.releases[k]):
            return 422, {"message": "Validation Failed", "errors": [{"code": "already_exists", "field": "tag_name"}]}
        rel = {"id": 900 + len(self.releases[k]), "tag_name": b.get("tag_name"), "name": b.get("name") or b.get("tag_name"), "body": b.get("body") or "",
               "draft": bool(b.get("draft")), "prerelease": bool(b.get("prerelease")), "created_at": _now(), "published_at": None if b.get("draft") else _now(),
               "html_url": f"https://github.com/{self.repos[k]['full_name']}/releases/tag/{b.get('tag_name')}", "author": {"login": who(r)["login"]}, "assets": []}
        self.releases[k].append(rel)
        return 201, rel

    def rel_tag(r: Req) -> tuple[int, Any]:
        k = key(r)
        for x in self.releases.get(k, []):
            if x["tag_name"] == urllib.parse.unquote(r.m.group(3)):
                return 200, x
        return 404, {"message": "Not Found"}

    def runs(r: Req) -> tuple[int, Any]:
        k = key(r)
        return (200, {"total_count": len(self.runs.get(k, [])), "workflow_runs": self.runs.get(k, [])}) if k in self.repos else (404, {"message": "Not Found"})

    def run_one(r: Req) -> tuple[int, Any]:
        for x in self.runs.get(key(r), []):
            if x["id"] == int(r.m.group(3)):
                return 200, x
        return 404, {"message": "Not Found"}

    def jobs(r: Req) -> tuple[int, Any]:
        return 200, {"total_count": 1, "jobs": [{"id": 1, "name": "tests", "status": "completed", "conclusion": "failure",
                                                "steps": [{"name": "Run pytest", "status": "completed", "conclusion": "failure", "number": 3}]}]}

    def workflows(r: Req) -> tuple[int, Any]:
        return 200, {"total_count": 1, "workflows": [{"id": 7, "name": "Tests", "path": ".github/workflows/tests.yml", "state": "active"}]}

    def search(r: Req) -> tuple[int, Any]:
        q = (r.q("q") or "").lower()
        items = [x for x in self.repos.values() if q.split()[0] in x["full_name"].lower() and not x["private"]] if q else []
        return 200, {"total_count": len(items), "items": items}

    def sync(r: Req) -> tuple[int, Any]:
        if not need(r):
            return 401, {"message": "Requires authentication"}
        self.synced.append(key(r))
        return 200, {"message": "Successfully fetched and fast-forwarded from upstream", "merge_type": "fast-forward", "base_branch": "upstream:main"}

    self.on("POST", "/api/user/repos", create)
    self.on("GET", "/api/user/repos", mine)
    self.on("GET", r"/api/users/([^/]+)/repos", theirs)
    self.on("GET", R + r"/pulls", lambda r: issue_list(r, True))
    self.on("POST", R + r"/pulls", lambda r: issue_new(r, True))
    self.on("GET", R + r"/pulls/(\d+)", lambda r: issue_one(r, True))
    self.on("GET", R + r"/issues", lambda r: issue_list(r, False))
    self.on("POST", R + r"/issues", lambda r: issue_new(r, False))
    self.on("GET", R + r"/issues/(\d+)", lambda r: issue_one(r, False))
    self.on("PATCH", R + r"/issues/(\d+)", issue_edit)
    self.on("POST", R + r"/issues/(\d+)/comments", comment)
    self.on("GET", R + r"/releases", rel_list)
    self.on("POST", R + r"/releases", rel_new)
    self.on("GET", R + r"/releases/tags/(.+)", rel_tag)
    self.on("GET", R + r"/actions/runs", runs)
    self.on("GET", R + r"/actions/runs/(\d+)", run_one)
    self.on("GET", R + r"/actions/runs/(\d+)/jobs", jobs)
    self.on("GET", R + r"/actions/workflows", workflows)
    self.on("POST", R + r"/merge-upstream", sync)
    self.on("GET", r"/api/search/repositories", search)
    self.on("GET", R, one)


FakeGitHub._model = _model  # type: ignore[attr-defined]
