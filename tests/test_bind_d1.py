"""tools/bind_d1.py, the helper of tools/setup_cloudflare.sh: the D1 databases bound at the top
of wrangler.toml in place of the commented template, again and again the same; the settings."""
import importlib.util
import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bind_d1", ROOT / "tools" / "bind_d1.py")
bind_d1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bind_d1)

LISTING = json.dumps([{"uuid": "11111111-aaaa-4aaa-8aaa-000000000001", "name": "oscr_catalog"},
                      {"uuid": "11111111-aaaa-4aaa-8aaa-000000000002", "name": "oscr_search"},
                      {"uuid": "11111111-aaaa-4aaa-8aaa-000000000003", "name": "oscr_community"},
                      {"uuid": "99999999-aaaa-4aaa-8aaa-000000000009", "name": "someone_else"}])


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
        "CATALOG": "1", "SEARCH": "2", "COMMUNITY": "3"}
    assert [d["database_id"][-4:] for d in parsed["env"]["local"]["d1_databases"]] == ["ca7a", "5ea7", "c0de"]
    assert "The search's databases are bound once the owner has created them" not in first
    assert parsed["assets"]["run_worker_first"] == ["/api/*"] and parsed["main"] == "worker/index.ts"


def test_a_setting_is_set_once(tmp_path):
    path = tmp_path / "settings"
    path.write_text("# comment\nOSCR_CLOUDFLARE_PROJECT=oscr\nOSCR_D1_PUSH=local\n")
    bind_d1.set_setting("OSCR_D1_PUSH=remote", path)
    bind_d1.set_setting("OSCR_D1_PUSH=remote", path)
    assert path.read_text() == "# comment\nOSCR_CLOUDFLARE_PROJECT=oscr\nOSCR_D1_PUSH=remote\n"
