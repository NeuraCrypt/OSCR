"""The OSV client (night phase 11, E2; oscr/osv.py). Tested against a fake OSV, never the real one:
no request leaves the machine (the owner's real runs happen later). OSV is queried without a key."""
from __future__ import annotations

import json

from oscr import osv


class FakeResponse:
    def __init__(self, status: int, data: object) -> None:
        self.status = status
        self._data = data
        self.text = json.dumps(data)

    def json(self) -> object:
        return self._data


# A tiny fake OSV: a batch endpoint and a details endpoint, from a fixed table.
VULNS = {
    "GHSA-numpy-1": {"id": "GHSA-numpy-1", "summary": "A flaw in numpy", "aliases": ["CVE-2021-0001"],
                     "severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}]},
    "MAL-2024-9": {"id": "MAL-2024-9", "summary": "Malicious package colourama (typosquat)"},
    "GHSA-old-1": {"id": "GHSA-old-1", "summary": "Withdrawn", "withdrawn": "2020-01-01T00:00:00Z"},
}
AFFECTS = {
    ("PyPI", "numpy", "1.0.0"): ["GHSA-numpy-1"],
    ("PyPI", "colourama", "0.1.0"): ["MAL-2024-9"],
    ("PyPI", "left-pad", "1.0.0"): ["GHSA-old-1"],
}


def fake_post(url: str, body: object):
    assert url.endswith(osv.BATCH_PATH)
    results = []
    for q in body["queries"]:
        key = (q["package"]["ecosystem"], q["package"]["name"], q["version"])
        # The fake uses OSV's own ecosystem names; our map turns PyPI->PyPI, Actions->GitHub Actions.
        key = ({"PyPI": "PyPI", "npm": "npm", "CRAN": "CRAN", "GitHub Actions": "Actions"}[key[0]], key[1], key[2])
        ids = AFFECTS.get(key, [])
        results.append({"vulns": [{"id": i} for i in ids]})
    return FakeResponse(200, {"results": results})


def fake_get(url: str):
    vuln_id = url.rsplit("/", 1)[-1]
    return FakeResponse(200, VULNS[vuln_id]) if vuln_id in VULNS else FakeResponse(404, {})


def test_severity_bands():
    assert osv.severity_from_score(9.5) == "critical"
    assert osv.severity_from_score(7.0) == "high"
    assert osv.severity_from_score(5.0) == "moderate"
    assert osv.severity_from_score(1.0) == "low"
    assert osv.severity_from_score(0.0) == "unknown"


def test_parse_advisory_cvss_and_malware():
    adv = osv.parse_advisory(VULNS["GHSA-numpy-1"])
    assert adv.severity == "critical" and adv.cve == "CVE-2021-0001" and not adv.malware
    mal = osv.parse_advisory(VULNS["MAL-2024-9"])
    assert mal.malware and mal.severity == "critical"


def test_query_batch_only_covered_ecosystems():
    queries = [
        osv.Query("PyPI", "numpy", "1.0.0"),
        osv.Query("Julia", "DataFrames", "1.6.0"),   # not covered: skipped, never guessed
        osv.Query("PyPI", "safe", "2.0.0"),          # no advisory
    ]
    ids = osv.query_batch(fake_post, queries, base="http://fake")
    assert ids == {"PyPI\nnumpy\n1.0.0": ["GHSA-numpy-1"]}


def test_fetch_and_join_with_auto_triage():
    queries = [osv.Query("PyPI", "numpy", "1.0.0"), osv.Query("PyPI", "colourama", "0.1.0"),
               osv.Query("PyPI", "left-pad", "1.0.0", dev_scope=True)]
    ids = osv.query_batch(fake_post, queries, base="http://fake")
    advisories = {}
    for lst in ids.values():
        for vid in lst:
            advisories[vid] = osv.fetch_advisory(fake_post, vid, base="http://fake", get=fake_get)
    dev = {"PyPI\nleft-pad\n1.0.0": True}
    alerts = osv.alerts_from(ids, advisories, dev)
    by_pkg = {a.package: a for a in alerts}
    assert by_pkg["numpy"].advisory.severity == "critical" and by_pkg["numpy"].auto_dismiss == ""
    assert by_pkg["colourama"].advisory.malware
    # The withdrawn advisory is auto-dismissed as a false positive; the dev-scope label is kept.
    assert by_pkg["left-pad"].auto_dismiss == "false_positive" and by_pkg["left-pad"].dev_scope


def test_batch_failure_is_not_fatal():
    def failing(url, body):
        return FakeResponse(500, {})
    assert osv.query_batch(failing, [osv.Query("PyPI", "numpy", "1.0.0")], base="http://fake") == {}
