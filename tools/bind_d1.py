"""The helper of tools/setup_cloudflare.sh.

    npx wrangler d1 list --json | python tools/bind_d1.py website/wrangler.toml
        binds the three D1 databases at the top of wrangler.toml, with the ids Cloudflare gave
        them (identifiers, not secrets), in place of the commented template; runs again safely.
    python tools/bind_d1.py --settings KEY=value
        sets one line of the Mac's settings (~/.config/oscr/settings), keeping the others.
"""
from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

#: binding, database name, migrations folder (from website/).
DATABASES = (("CATALOG", "oscr_catalog", "../migrations/d1/catalog"),
             ("SEARCH", "oscr_search", "../migrations/d1/search"),
             ("COMMUNITY", "oscr_community", "../migrations/d1-community"))
SETTINGS = Path.home() / ".config" / "oscr" / "settings"
TEMPLATE_START = "# The search's databases are bound once the owner has created them"
LOCAL_START = "# Local development only"


def ids_from_listing(listing: str) -> dict[str, str]:
    out = {}
    for d in json.loads(listing or "[]"):
        ident = d.get("uuid") or d.get("database_id") or d.get("id") or ""
        if d.get("name") and ident:
            out[d["name"]] = ident
    return out


def blocks(ids: dict[str, str]) -> str:
    lines = ["# The databases of the search (docs/SEARCH.md) and of the accounts (docs/ACCOUNTS.md),",
             "# created by tools/setup_cloudflare.sh. Their ids are identifiers, not secrets.", ""]
    for binding, name, migrations in DATABASES:
        lines += ["[[d1_databases]]", f'binding = "{binding}"', f'database_name = "{name}"',
                  f'database_id = "{ids[name]}"', f'migrations_dir = "{migrations}"', ""]
    return "\n".join(lines) + "\n"


def bind(config: Path, ids: dict[str, str]) -> None:
    missing = [name for _, name, _ in DATABASES if name not in ids]
    if missing:
        raise SystemExit(f"not found at Cloudflare: {', '.join(missing)}")
    text = config.read_text()
    # Any top-level block already there (a previous run, or wrangler's own addition) goes.
    text = re.sub(r"(?m)^\[\[d1_databases\]\]\n(?:[A-Za-z_]+ = .*\n)*\n?", "", text)
    text = re.sub(r"(?m)^# The databases of the search \(docs/SEARCH\.md\).*\n# created by tools/setup_cloudflare\.sh.*\n\n?",
                  "", text)
    start = text.find(TEMPLATE_START)
    local = text.find(LOCAL_START)
    if local < 0:
        raise SystemExit(f"{config}: no '{LOCAL_START}' section; bind the databases by hand (docs/SEARCH.md)")
    cut = start if 0 <= start < local else local                         # the commented template goes
    text = text[:cut].rstrip("\n") + "\n\n" + blocks(ids) + "\n" + text[local:]
    text = re.sub(r"\n{3,}", "\n\n", text).rstrip("\n") + "\n"
    parsed = tomllib.loads(text)
    top = {d["binding"]: d["database_id"] for d in parsed.get("d1_databases", [])}
    local_bindings = {d["binding"] for d in parsed.get("env", {}).get("local", {}).get("d1_databases", [])}
    assert top == {b: ids[n] for b, n, _ in DATABASES}, top
    assert local_bindings == {b for b, _, _ in DATABASES}, local_bindings
    config.write_text(text)
    for binding, name, _ in DATABASES:
        print(f"{name}: bound as {binding}")


def set_setting(assignment: str, path: Path = SETTINGS) -> None:
    key, _, value = assignment.partition("=")
    lines = path.read_text().splitlines() if path.exists() else []
    out, done = [], False
    for line in lines:
        if line.split("=", 1)[0].strip() == key and not line.lstrip().startswith("#"):
            out.append(f"{key}={value}")
            done = True
        else:
            out.append(line)
    if not done:
        out.append(f"{key}={value}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n")
    print(f"settings: {key}={value}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--settings":
        set_setting(sys.argv[2])
    elif len(sys.argv) == 2:
        bind(Path(sys.argv[1]), ids_from_listing(sys.stdin.read()))
    else:
        raise SystemExit(__doc__)
