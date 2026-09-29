"""tools/bind_d1.py, the helper of tools/setup_cloudflare.sh: the D1 databases bound at the top
of wrangler.toml in place of the commented template, again and again the same; the settings. And
the setup script itself: valid sh, and no secret ever shown or written (night phase 01 added the
fourth database, oscr_forge, and the GitHub App's values)."""
import importlib.util
import json
import re
import subprocess
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bind_d1", ROOT / "tools" / "bind_d1.py")
bind_d1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bind_d1)

LISTING = json.dumps([{"uuid": "11111111-aaaa-4aaa-8aaa-000000000001", "name": "oscr_catalog"},
                      {"uuid": "11111111-aaaa-4aaa-8aaa-000000000002", "name": "oscr_search"},
                      {"uuid": "11111111-aaaa-4aaa-8aaa-000000000003", "name": "oscr_community"},
                      {"uuid": "11111111-aaaa-4aaa-8aaa-000000000004", "name": "oscr_forge"},
                      {"uuid": "99999999-aaaa-4aaa-8aaa-000000000009", "name": "someone_else"}])
SETUP = ROOT / "tools" / "setup_cloudflare.sh"


def test_the_databases_are_bound_once_whatever_the_runs(tmp_path):
    config = tmp_path / "wrangler.toml"
    config.write_text((ROOT / "website" / "wrangler.toml").read_text()
                      + '\n[[d1_databases]]\nbinding = "oscr_catalog"\ndatabase_name = "oscr_catalog"\n'
                        'database_id = "11111111-aaaa-4aaa-8aaa-000000000001"\n')     # wrangler's own addition
    ids = bind_d1.ids_from_listing(LISTING)
    bind_d1.bind(config, ids)
    first = config.read_text()
    bind_d1.bind(config, ids)
    assert config.read_text() == first
    parsed = tomllib.loads(first)
    assert {d["binding"]: d["database_id"][-1] for d in parsed["d1_databases"]} == {
        "CATALOG": "1", "SEARCH": "2", "COMMUNITY": "3", "FORGE": "4"}
    assert [d["database_id"][-4:] for d in parsed["env"]["local"]["d1_databases"]] == ["ca7a", "5ea7", "c0de", "f09e"]
    assert {d["binding"]: d["migrations_dir"] for d in parsed["d1_databases"]}["FORGE"] == "../migrations/d1-forge"
    assert (ROOT / "website" / "../migrations/d1-forge").resolve().is_dir()
    assert "The search's databases are bound once the owner has created them" not in first
    assert parsed["assets"]["run_worker_first"] == ["/api/*"] and parsed["main"] == "worker/index.ts"


def test_a_setting_is_set_once(tmp_path):
    path = tmp_path / "settings"
    path.write_text("# comment\nOSCR_CLOUDFLARE_PROJECT=oscr\nOSCR_D1_PUSH=local\n")
    bind_d1.set_setting("OSCR_D1_PUSH=remote", path)
    bind_d1.set_setting("OSCR_D1_PUSH=remote", path)
    assert path.read_text() == "# comment\nOSCR_CLOUDFLARE_PROJECT=oscr\nOSCR_D1_PUSH=remote\n"


def test_the_four_databases_or_nothing(tmp_path):
    """Stricter with the fourth: a listing without oscr_forge binds nothing, and a wrangler.toml
    whose local section lacks FORGE is refused."""
    config = tmp_path / "wrangler.toml"
    original = (ROOT / "website" / "wrangler.toml").read_text()
    config.write_text(original)
    without_forge = json.dumps([d for d in json.loads(LISTING) if d["name"] != "oscr_forge"])
    with pytest.raises(SystemExit, match="oscr_forge"):
        bind_d1.bind(config, bind_d1.ids_from_listing(without_forge))
    assert config.read_text() == original
    local_forge = re.search(r'\n\[\[env\.local\.d1_databases\]\]\nbinding = "FORGE"\n(?:.+\n?)*', original)
    assert local_forge
    config.write_text(original.replace(local_forge.group(0), "\n"))
    with pytest.raises(AssertionError):
        bind_d1.bind(config, bind_d1.ids_from_listing(LISTING))
    # The production block of FORGE is the setup script's to write: not in the repository's file yet.
    parsed = tomllib.loads(original)
    assert "FORGE" not in {d["binding"] for d in parsed.get("d1_databases", [])}
    assert {d["binding"] for d in parsed["env"]["local"]["d1_databases"]} == {"CATALOG", "SEARCH", "COMMUNITY", "FORGE"}
    assert "FORGE_OPEN" not in original.replace("Its switch FORGE_OPEN is never set here", "")


def test_the_setup_script_is_valid_sh_and_never_shows_a_secret():
    subprocess.run(["sh", "-n", str(SETUP)], check=True)
    text = SETUP.read_text()
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]
    assert "set -x" not in text and "set -o xtrace" not in text
    # A secret is read with the terminal's echo off, and its value only ever goes into wrangler.
    reads = [i for i, line in enumerate(lines) if re.search(r"\bread\b.*\bvalue\b", line)]
    assert reads, "the values are read"
    for i in reads:
        assert lines[i - 1].startswith("stty -echo"), lines[i]
    for line in lines:
        if "$value" not in line:
            continue
        allowed = (line.startswith("value=$(printf '%s' \"$value\" | tr -d") or
                   line.endswith("| npx wrangler secret put \"$name\" >/dev/null") or
                   line.startswith('if [ -z "$value" ]') or
                   "| grep -q '[^0-9]'" in line)
        assert allowed, f"a secret could be shown: {line}"
    # The private key goes from its file to wrangler, and is never printed.
    for line in lines:
        if "$pem" in line and "cat" in line.split():
            pytest.fail(f"the private key file is printed: {line}")
    assert 'npx wrangler secret put GITHUB_APP_PRIVATE_KEY <"$pem" >/dev/null' in lines
    assert not re.search(r">\s*[^/&\s][^\s]*\.(pem|key|txt|env|vars)\b", text), "a secret written to a file"
    # Every value the forge needs is asked; FORGE_OPEN is never set.
    for name in ["GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_WEBHOOK_SECRET",
                 "GITHUB_APP_SLUG", "FORGE_OWNER_GITHUB_ID", "GITHUB_APP_PRIVATE_KEY",
                 "ORCID_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET", "TURNSTILE_SECRET_KEY"]:
        assert name in text, name
    assert not re.search(r"secret put\s+\"?FORGE_OPEN", text)
    assert "ask_secret FORGE_OPEN" not in text
    for name in ["oscr_catalog", "oscr_search", "oscr_community", "oscr_forge"]:
        assert text.count(name) >= 2, name       # created, and migrated
