"""The dependency graph from environment files (night phase 11, E1; docs/SECURITY_QUALITY.md).

What it does: it reads the files that say what a repository's code needs to run, as **text**, and
turns them into a flat list of dependencies. Each dependency keeps its ecosystem (PyPI, npm, CRAN,
Julia, conda, Actions), its name, the exact version when a lock file pins one, the declared range
(the "constraint"), its scope (runtime, dev, build, optional), whether it is *direct* (named in a
manifest the authors wrote) or only pulled in by a lock file, whether it is *pinned*, and every file
it appears in (so the view can "show paths").

What it never does: it never runs a manifest, never resolves anything, never installs, never opens a
network connection. It parses strings. A file it cannot parse yields nothing; it never raises for a
malformed input (D00-11: no user code ever runs, here or anywhere).

Source precedence: a lock file's exact version wins over a range from a manifest; a manifest marks a
dependency as direct. The merge keeps the strongest scope (runtime over build over optional over dev)
and lists the manifests before the lock files.

YAML (conda environments, GitHub Actions workflows, pnpm lock files) is parsed by hand, line by line,
as the rest of the harvester does (oscr/repofeatures.py ``_conda``): the package declares no YAML
dependency, and these shapes are simple. tomllib (standard library, Python 3.11+) reads the TOML.
"""
from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import PurePosixPath

# The ecosystems the inventory lists, named as SPDX and the package databases name them.
ECOSYSTEMS = ("PyPI", "npm", "CRAN", "Julia", "conda", "Actions")
SCOPES = ("runtime", "build", "optional", "dev", "actions")
_SCOPE_RANK = {s: i for i, s in enumerate(SCOPES)}  # the lower the rank, the stronger


@dataclass(frozen=True)
class Dependency:
    """One line read from one file."""
    ecosystem: str
    name: str
    version: str = ""        # an exact version, when a lock file (or a `==` pin) gives one
    constraint: str = ""     # the range as written: ">=1.0,<2", "^4.17.1", "1.6.*"
    scope: str = "runtime"   # runtime | build | optional | dev | actions
    direct: bool = True      # named in a manifest (vs only resolved by a lock file)
    pinned: bool = False     # an exact version is known
    source: str = ""         # the file it came from


@dataclass
class Node:
    """One dependency after merging every file that mentions it."""
    ecosystem: str
    name: str
    version: str = ""
    constraint: str = ""
    scope: str = "runtime"
    direct: bool = False
    pinned: bool = False
    sources: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "ecosystem": self.ecosystem, "name": self.name, "version": self.version,
            "constraint": self.constraint, "scope": self.scope, "direct": self.direct,
            "pinned": self.pinned, "sources": list(self.sources),
        }


# ---------------------------------------------------------------------------
# Name normalisation (for grouping; the display name keeps the first spelling seen).

def _pypi_key(name: str) -> str:
    """PEP 503: lower case, runs of - _ . become one -."""
    return re.sub(r"[-_.]+", "-", name.strip().lower())


def normalise(ecosystem: str, name: str) -> str:
    name = name.strip()
    if ecosystem in ("PyPI", "conda"):
        return _pypi_key(name)
    if ecosystem == "npm":
        return name.lower()
    return name  # CRAN, Julia and Actions are case-sensitive by their own rules


# ---------------------------------------------------------------------------
# PyPI: requirements, pyproject, Pipfile, setup.cfg, and the lock files.

_REQ_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$")


def _split_requirement(spec: str) -> tuple[str, str, str]:
    """`mne[hdf5]>=1.0; python_version>"3.8"` -> ("mne", ">=1.0", version or "").

    Returns (name, constraint, exact-version). A `==x` pin yields the exact version too."""
    spec = re.split(r"\s;", spec, maxsplit=1)[0].strip()
    spec = re.split(r"\s@\s|\s--", spec, maxsplit=1)[0].strip()
    m = _REQ_NAME.match(spec)
    if not m:
        return "", "", ""
    name, _extras, rest = m.group(1), m.group(2), m.group(3).strip()
    constraint = rest
    exact = ""
    pin = re.match(r"^==\s*([^\s,;]+)$", rest)
    if pin and "*" not in pin.group(1):
        exact = pin.group(1)
    return name, constraint, exact


def _requirements(text: str, source: str) -> list[Dependency]:
    out: list[Dependency] = []
    for raw in text.splitlines():
        line = re.split(r"\s#", raw, maxsplit=1)[0].strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("-e ", "--editable")):
            line = line.split(None, 1)[1] if " " in line else ""
        elif line.startswith("-"):  # -r, -c, --hash, index urls: not a package
            continue
        if "://" in line or line.startswith("git+"):
            name = _url_project(line)
            if name:
                out.append(Dependency("PyPI", name, constraint="(from a URL)", source=source))
            continue
        name, constraint, exact = _split_requirement(line)
        if name:
            out.append(Dependency("PyPI", name, version=exact, constraint=constraint,
                                  pinned=bool(exact), source=source))
    return out


def _url_project(spec: str) -> str:
    egg = re.search(r"[#&]egg=([A-Za-z0-9._-]+)", spec)
    if egg:
        return egg.group(1)
    path = spec.split("://", 1)[-1].split("#")[0].split("@")[0].rstrip("/")
    return re.sub(r"\.git$", "", path.rsplit("/", 1)[-1]) if path else ""


def _toml(text: str) -> dict:
    try:
        data = tomllib.loads(text)
    except (tomllib.TOMLDecodeError, ValueError, AttributeError):
        return {}
    return data if isinstance(data, dict) else {}


def _as_list(value: object) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def _pyproject(text: str, source: str) -> list[Dependency]:
    data = _toml(text)
    out: list[Dependency] = []

    def add(specs: list[str], scope: str) -> None:
        for spec in specs:
            name, constraint, exact = _split_requirement(spec)
            if name:
                out.append(Dependency("PyPI", name, version=exact, constraint=constraint,
                                      scope=scope, pinned=bool(exact), source=source))

    project = data.get("project") or {}
    add(_as_list(project.get("dependencies")), "runtime")
    for group in (project.get("optional-dependencies") or {}).values():
        add(_as_list(group), "optional")
    for group in (data.get("dependency-groups") or {}).values():
        add(_as_list(group), "dev")
    add(_as_list((data.get("build-system") or {}).get("requires")), "build")
    # Poetry's tables: {name: constraint}.
    poetry = (data.get("tool") or {}).get("poetry") or {}
    for key, scope in (("dependencies", "runtime"), ("dev-dependencies", "dev")):
        table = poetry.get(key)
        if isinstance(table, dict):
            add_poetry(table, scope, out, source)
    for group in (poetry.get("group") or {}).values():
        if isinstance(group, dict) and isinstance(group.get("dependencies"), dict):
            add_poetry(group["dependencies"], "dev", out, source)
    return out


def add_poetry(table: dict, scope: str, out: list[Dependency], source: str) -> None:
    for name, spec in table.items():
        if name.lower() == "python":
            continue
        constraint = spec if isinstance(spec, str) else (spec.get("version", "") if isinstance(spec, dict) else "")
        exact = constraint if re.match(r"^\d[\w.+-]*$", str(constraint)) else ""
        out.append(Dependency("PyPI", name, version=exact, constraint=str(constraint),
                              scope=scope, pinned=bool(exact), source=source))


def _pipfile(text: str, source: str) -> list[Dependency]:
    data = _toml(text)
    out: list[Dependency] = []
    for section, scope in (("packages", "runtime"), ("dev-packages", "dev")):
        table = data.get(section)
        if isinstance(table, dict):
            add_poetry(table, scope, out, source)
    return out


def _setup_cfg(text: str, source: str) -> list[Dependency]:
    out: list[Dependency] = []
    block = re.search(r"(?ms)^\s*install_requires\s*=(.*?)(?=^\S|\Z)", text)
    extras = re.findall(r"(?ms)^\[options\.extras_require\](.*?)(?=^\[|\Z)", text)
    chunks = [(block.group(1) if block else "", "runtime")] + [(e, "optional") for e in extras]
    for chunk, scope in chunks:
        for spec in re.split(r"[\n;]", chunk):
            spec = spec.strip()
            if not spec or "=" in spec.split()[0:1] and "==" not in spec and ">" not in spec and "<" not in spec:
                # a key = value header line inside extras ("test ="); skip the bare key
                if re.match(r"^[A-Za-z0-9_.-]+\s*=\s*$", spec):
                    continue
            name, constraint, exact = _split_requirement(spec)
            if name and name not in ("install_requires",):
                out.append(Dependency("PyPI", name, version=exact, constraint=constraint,
                                      scope=scope, pinned=bool(exact), source=source))
    return out


def _poetry_lock(text: str, source: str) -> list[Dependency]:
    data = _toml(text)
    out: list[Dependency] = []
    for pkg in data.get("package") or []:
        if not isinstance(pkg, dict):
            continue
        name, version = str(pkg.get("name", "")), str(pkg.get("version", ""))
        category = str(pkg.get("category", "") or "")
        scope = "dev" if category == "dev" else ("optional" if pkg.get("optional") else "runtime")
        if name:
            out.append(Dependency("PyPI", name, version=version, scope=scope,
                                  direct=False, pinned=bool(version), source=source))
    return out


def _uv_lock(text: str, source: str) -> list[Dependency]:
    data = _toml(text)
    out: list[Dependency] = []
    for pkg in data.get("package") or []:
        if isinstance(pkg, dict) and pkg.get("name"):
            version = str(pkg.get("version", ""))
            out.append(Dependency("PyPI", str(pkg["name"]), version=version,
                                  direct=False, pinned=bool(version), source=source))
    return out


def _pipfile_lock(text: str, source: str) -> list[Dependency]:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    out: list[Dependency] = []
    for section, scope in (("default", "runtime"), ("develop", "dev")):
        table = data.get(section) if isinstance(data, dict) else None
        if not isinstance(table, dict):
            continue
        for name, spec in table.items():
            version = ""
            if isinstance(spec, dict):
                version = str(spec.get("version", "")).lstrip("=")
            out.append(Dependency("PyPI", name, version=version, scope=scope,
                                  direct=False, pinned=bool(version), source=source))
    return out


# ---------------------------------------------------------------------------
# conda.

def _conda(text: str, source: str) -> list[Dependency]:
    out: list[Dependency] = []
    section = ""
    in_pip = False
    for raw in text.splitlines():
        if re.match(r"^[A-Za-z_][\w-]*\s*:", raw):
            section = raw.split(":", 1)[0].strip().lower()
            in_pip = False
            continue
        m = re.match(r"^(\s*)-\s*([^\s#].*?)\s*$", raw)
        if not m:
            continue
        indent, item = len(m.group(1)), m.group(2).strip()
        if item.rstrip(":") == "pip" and item.endswith(":"):
            in_pip = True
            continue
        if section != "dependencies":
            continue
        if in_pip and indent >= 4:
            name, constraint, exact = _split_requirement(item.strip("\"'"))
            if name:
                out.append(Dependency("PyPI", name, version=exact, constraint=constraint,
                                      pinned=bool(exact), source=source))
            continue
        in_pip = False
        token = item.strip("\"'").split("::")[-1]
        name = re.split(r"[=<>!~ ]", token, maxsplit=1)[0]
        rest = token[len(name):].strip()
        exact = ""
        pin = re.match(r"^=+\s*([0-9][\w.*+]*)", rest)
        if pin and "*" not in pin.group(1):
            exact = pin.group(1)
        if name:
            out.append(Dependency("conda", name, version=exact, constraint=rest,
                                  pinned=bool(exact), source=source))
    return out


# ---------------------------------------------------------------------------
# R.

def _description(text: str, source: str) -> list[Dependency]:
    out: list[Dependency] = []
    scopes = {"Depends": "runtime", "Imports": "runtime", "LinkingTo": "build",
              "Suggests": "optional", "Enhances": "optional"}
    for m in re.finditer(r"(?ms)^(Depends|Imports|Suggests|LinkingTo|Enhances)\s*:(.*?)(?=^\S|\Z)", text):
        scope = scopes[m.group(1)]
        for item in m.group(2).split(","):
            item = item.strip()
            if not item:
                continue
            name = re.split(r"[\s(]", item, maxsplit=1)[0].strip()
            ver = re.search(r"\(([^)]*)\)", item)
            if name and name != "R":
                out.append(Dependency("CRAN", name, constraint=(ver.group(1).strip() if ver else ""),
                                      scope=scope, source=source))
    return out


def _renv_lock(text: str, source: str) -> list[Dependency]:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    packages = (data.get("Packages") or {}) if isinstance(data, dict) else {}
    out: list[Dependency] = []
    for name, spec in packages.items():
        version = str(spec.get("Version", "")) if isinstance(spec, dict) else ""
        out.append(Dependency("CRAN", name, version=version, direct=False,
                              pinned=bool(version), source=source))
    return out


# ---------------------------------------------------------------------------
# Julia.

def _julia_project(text: str, source: str) -> list[Dependency]:
    data = _toml(text)
    out: list[Dependency] = []
    compat = data.get("compat") if isinstance(data.get("compat"), dict) else {}
    for name in (data.get("deps") or {}):
        out.append(Dependency("Julia", name, constraint=str(compat.get(name, "") or ""), source=source))
    return out


def _julia_manifest(text: str, source: str) -> list[Dependency]:
    data = _toml(text)
    deps = data.get("deps")
    table = deps if isinstance(deps, dict) else data  # Manifest v2 nests under [deps]
    out: list[Dependency] = []
    for name, entries in (table or {}).items():
        if name in ("julia_version", "manifest_format", "project_hash"):
            continue
        version = ""
        if isinstance(entries, list) and entries and isinstance(entries[0], dict):
            version = str(entries[0].get("version", ""))
        if name:
            out.append(Dependency("Julia", name, version=version, direct=False,
                                  pinned=bool(version), source=source))
    return out


# ---------------------------------------------------------------------------
# JavaScript / npm.

def _package_json(text: str, source: str) -> list[Dependency]:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, dict):
        return []
    out: list[Dependency] = []
    fields = {"dependencies": "runtime", "devDependencies": "dev",
              "optionalDependencies": "optional", "peerDependencies": "runtime"}
    for key, scope in fields.items():
        table = data.get(key)
        if not isinstance(table, dict):
            continue
        for name, constraint in table.items():
            constraint = str(constraint)
            exact = constraint if re.match(r"^\d[\w.+-]*$", constraint) else ""
            out.append(Dependency("npm", name, version=exact, constraint=constraint,
                                  scope=scope, pinned=bool(exact), source=source))
    return out


def _package_lock(text: str, source: str) -> list[Dependency]:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, dict):
        return []
    out: list[Dependency] = []
    seen: set[tuple[str, str]] = set()
    packages = data.get("packages")
    if isinstance(packages, dict):  # lockfile v2/v3
        for path, spec in packages.items():
            if not path or not isinstance(spec, dict):
                continue
            name = path.split("node_modules/")[-1]
            version = str(spec.get("version", ""))
            key = (name, version)
            if name and key not in seen:
                seen.add(key)
                out.append(Dependency("npm", name, version=version, direct=False,
                                      pinned=bool(version), source=source))
    deps = data.get("dependencies")
    if isinstance(deps, dict) and not out:  # lockfile v1
        for name, spec in deps.items():
            version = str(spec.get("version", "")) if isinstance(spec, dict) else ""
            out.append(Dependency("npm", name, version=version, direct=False,
                                  pinned=bool(version), source=source))
    return out


def _yarn_lock(text: str, source: str) -> list[Dependency]:
    out: list[Dependency] = []
    name = ""
    for raw in text.splitlines():
        header = re.match(r'^"?((?:@[^@"/]+/)?[^@"\s/][^@"\s]*)@', raw)
        if header and not raw.startswith(" "):
            name = header.group(1)
            continue
        ver = re.match(r'^\s+version:?\s+"?([^"\s]+)"?\s*$', raw)
        if ver and name:
            out.append(Dependency("npm", name, version=ver.group(1), direct=False,
                                  pinned=True, source=source))
            name = ""
    return out


def _pnpm_lock(text: str, source: str) -> list[Dependency]:
    out: list[Dependency] = []
    in_packages = False
    for raw in text.splitlines():
        if re.match(r"^packages:\s*$", raw):
            in_packages = True
            continue
        if re.match(r"^\S", raw):
            in_packages = False
        if not in_packages:
            continue
        m = re.match(r"^\s{2}'?/?((?:@[^@/]+/)?[^@/'\s]+)@([0-9][^':\s()]*)'?:", raw)
        if m:
            out.append(Dependency("npm", m.group(1), version=m.group(2), direct=False,
                                  pinned=True, source=source))
    return out


# ---------------------------------------------------------------------------
# GitHub Actions.

def _actions(text: str, source: str) -> list[Dependency]:
    out: list[Dependency] = []
    for m in re.finditer(r"(?m)^\s*-?\s*uses\s*:\s*['\"]?([^'\"\s#]+)", text):
        ref = m.group(1)
        if ref.startswith(("./", "../")) or ref.startswith("docker://"):
            continue
        name, _, version = ref.partition("@")
        name = "/".join(name.split("/")[:2])  # owner/repo, dropping a subpath
        if name:
            out.append(Dependency("Actions", name, version=version, constraint=version,
                                  scope="actions", pinned=bool(re.match(r"^[0-9a-f]{40}$|^v?\d", version)),
                                  source=source))
    return out


# ---------------------------------------------------------------------------
# Dispatch by file name.

_EXACT = {
    "requirements.txt": _requirements, "requirements.in": _requirements,
    "pyproject.toml": _pyproject, "pipfile": _pipfile, "pipfile.lock": _pipfile_lock,
    "poetry.lock": _poetry_lock, "uv.lock": _uv_lock, "setup.cfg": _setup_cfg,
    "description": _description, "renv.lock": _renv_lock,
    "project.toml": _julia_project, "juliaproject.toml": _julia_project,
    "manifest.toml": _julia_manifest, "juliamanifest.toml": _julia_manifest,
    "package.json": _package_json, "package-lock.json": _package_lock,
    "npm-shrinkwrap.json": _package_lock, "yarn.lock": _yarn_lock,
    "pnpm-lock.yaml": _pnpm_lock, "conda-lock.yml": _conda,
}


def parser_for(path: str):
    """The parser for a file path, or None. Case-insensitive on the base name."""
    name = PurePosixPath(path).name.lower()
    if name in _EXACT:
        return _EXACT[name]
    if re.match(r"^requirements[\w.-]*\.(txt|in)$", name):
        return _requirements
    if re.match(r"^environment[\w.-]*\.ya?ml$", name) or name in ("meta.yaml",):
        return _conda
    parent = PurePosixPath(path).parent.as_posix().lower()
    if (".github/workflows" in parent) and name.endswith((".yml", ".yaml")):
        return _actions
    return None


def is_manifest(path: str) -> bool:
    """Whether the registry knows how to read this file as a dependency source."""
    return parser_for(path) is not None


def parse_file(path: str, text: str) -> list[Dependency]:
    fn = parser_for(path)
    return fn(text, path) if fn else []


# ---------------------------------------------------------------------------
# The merged graph.

def _stronger(a: str, b: str) -> str:
    return a if _SCOPE_RANK.get(a, 99) <= _SCOPE_RANK.get(b, 99) else b


def merge(deps: list[Dependency]) -> list[Node]:
    """Group raw dependencies into nodes, applying the source precedence.

    One node per (ecosystem, normalised name). The exact version comes from a lock file (a record
    with no constraint and ``direct=False`` is a lock entry); the constraint from a manifest. Sources
    list the manifests first, then the lock files, each once."""
    nodes: dict[tuple[str, str], Node] = {}
    for d in deps:
        if not d.name:
            continue
        key = (d.ecosystem, normalise(d.ecosystem, d.name))
        node = nodes.get(key)
        if node is None:
            node = nodes[key] = Node(ecosystem=d.ecosystem, name=d.name, scope=d.scope)
        if d.version and (not node.version or d.direct is False):
            node.version = d.version
        if d.pinned:
            node.pinned = True
        if d.constraint and not node.constraint:
            node.constraint = d.constraint
        if d.direct:
            node.direct = True
            node.scope = _stronger(node.scope, d.scope)
        if d.source and d.source not in node.sources:
            # manifests (direct) before lock files
            if d.direct:
                node.sources.insert(0, d.source)
            else:
                node.sources.append(d.source)
    return sorted(nodes.values(), key=lambda n: (n.ecosystem, normalise(n.ecosystem, n.name)))


def graph(files: dict[str, str]) -> list[Node]:
    """The merged dependency graph of a set of files {path: text}."""
    raw: list[Dependency] = []
    for path, text in files.items():
        if isinstance(text, str):
            raw.extend(parse_file(path, text))
    return merge(raw)


def summary(nodes: list[Node]) -> dict[str, object]:
    """Counts for the facts and the view: by ecosystem, direct, pinned."""
    by_eco: dict[str, int] = {}
    direct = pinned = 0
    for n in nodes:
        by_eco[n.ecosystem] = by_eco.get(n.ecosystem, 0) + 1
        direct += 1 if n.direct else 0
        pinned += 1 if n.pinned else 0
    return {"total": len(nodes), "direct": direct, "transitive": len(nodes) - direct,
            "pinned": pinned, "ecosystems": by_eco}
