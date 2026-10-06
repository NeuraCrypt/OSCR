"""The secrets scan (night phase 11, E3; oscr/secretscan.py). It reports, never blocks (D00-11), and
never keeps a value. Pure, no I/O."""
from __future__ import annotations

import json
from pathlib import Path

from oscr import secretscan

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "secret_patterns.json"


def kinds(findings):
    return sorted(f.kind for f in findings)


def test_structured_token_found_value_hidden():
    found = secretscan.scan_text("config.py", 'TOKEN = "ghp_' + "a" * 36 + '"\n')
    assert len(found) == 1
    f = found[0]
    assert f.kind == "a GitHub token" and f.line == 1
    # The value is never kept whole: the hint ends with an ellipsis and is short.
    assert f.hint.endswith("…") and "a" * 36 not in f.hint


def test_private_key_block_and_remediation():
    found = secretscan.scan_text("key.pem", "-----BEGIN RSA PRIVATE KEY-----\nMII...\n")
    assert kinds(found) == ["a private key"]
    assert "Revoke and rotate" in found[0].remediation()


def test_paired_secret_is_a_guess():
    found = secretscan.scan_text("s.py", 'password = "h7Gk29ZqLpXy"\n')
    assert any(f.paired and f.kind == "a secret in an assignment" for f in found)


def test_placeholders_and_weak_values_are_not_secrets():
    assert secretscan.scan_text("a", 'token = "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"\n') == []
    assert secretscan.scan_text("a", 'password = "your-password-here"\n') == []
    assert secretscan.scan_text("a", 'api_key = "true"\n') == []
    assert secretscan.scan_text("a", 'path = "/usr/local/bin"\n') == []


def test_custom_pattern_and_dry_run():
    custom = [("an internal id", r"\bINT-[0-9]{8}\b")]
    found = secretscan.scan_text("a.py", "id = INT-12345678\n", custom=custom)
    assert kinds(found) == ["an internal id"]
    dry = secretscan.dry_run("an internal id", r"\bINT-[0-9]{8}\b", "see INT-00000001 and INT-99999999")
    assert dry["ok"] and dry["count"] == 2
    bad = secretscan.dry_run("broken", r"[unclosed", "x")
    assert not bad["ok"] and "error" in bad


def test_path_exclusions():
    assert secretscan.excluded("tests/fixtures/data.json", ["tests/fixtures/*"])
    assert secretscan.excluded("vendor/lib.min.js", ["*.min.js"])
    assert not secretscan.excluded("src/app.py", ["tests/*"])


def test_in_words():
    found = secretscan.scan_text("c.py", 'AKIA' + 'A' * 16 + '\n')
    words = secretscan.in_words(found)
    assert words and words[0].startswith("Line 1 of c.py: an AWS access key")


def test_load_config(tmp_path):
    cfg = tmp_path / "secrets.json"
    cfg.write_text(json.dumps({"exclude": ["vendor/*"], "custom": [{"name": "x", "regex": "A+"}]}))
    exclusions, custom = secretscan.load_config({"OSCR_SECRETS_CONFIG": str(cfg)})
    assert exclusions == ["vendor/*"] and custom == [("x", "A+")]
    assert secretscan.load_config({"OSCR_SECRETS_CONFIG": str(tmp_path / "none.json")}) == ([], [])


def test_the_kinds_match_the_shared_fixture():
    fixture = json.loads(FIXTURE.read_text())["kinds"]
    assert [k for k, _ in secretscan.STRUCTURED] == fixture
