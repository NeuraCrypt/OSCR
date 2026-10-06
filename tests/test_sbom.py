"""SBOM (SPDX) and licence compatibility (night phase 11, E6; oscr/sbom.py). Pure, no I/O."""
from __future__ import annotations

import json

from oscr import depgraph, sbom


def test_normalise_licence():
    assert sbom.normalise_licence("MIT") == "MIT"
    assert sbom.normalise_licence("apache 2.0") == "Apache-2.0"
    assert sbom.normalise_licence("GPLv3") == "GPL-3.0-only"
    assert sbom.normalise_licence("") == ""
    assert sbom.normalise_licence("NOASSERTION") == "NOASSERTION"
    assert sbom.normalise_licence("Some-Odd-Licence") == "Some-Odd-Licence"


def test_compatible_rules():
    # Permissive dependency goes anywhere.
    assert sbom.compatible("MIT", "MIT") is True
    assert sbom.compatible("GPL-3.0-only", "Apache-2.0") is True
    # GPL dependency needs a GPL repository.
    assert sbom.compatible("MIT", "GPL-3.0-only") is False
    assert sbom.compatible("GPL-3.0-only", "GPL-3.0-only") is True
    # GPL-2 code does not fit a GPL-3 only repository under the coarse rule.
    assert sbom.compatible("GPL-3.0-only", "GPL-2.0-only") is False
    # Unknown either side: no verdict.
    assert sbom.compatible("", "MIT") is None
    assert sbom.compatible("MIT", "NOASSERTION") is None
    assert sbom.compatible("MIT", "Weird") is None


def test_policy():
    p = sbom.Policy(deny=frozenset({"AGPL-3.0-only"}))
    assert p.verdict("AGPL-3.0-only") == "denied"
    assert p.verdict("MIT") == "allowed"
    allow = sbom.Policy(allow=frozenset({"MIT", "Apache-2.0"}))
    assert allow.verdict("MIT") == "allowed"
    assert allow.verdict("GPL-3.0-only") == "not_allowed"


def test_licence_summary():
    deps = [("a", "MIT"), ("b", "GPL-3.0-only"), ("c", ""), ("d", "AGPL-3.0-only")]
    s = sbom.licence_summary("MIT", deps, sbom.Policy(deny=frozenset({"AGPL-3.0-only"})))
    assert s["repo_licence"] == "MIT"
    assert s["compatible"] == 1 and s["incompatible"] == 1 and s["denied"] == 1 and s["unknown"] == 1
    whys = {c["name"]: c["why"] for c in s["clashes"]}
    assert whys == {"b": "incompatible", "d": "denied"}


def test_spdx_document_and_json():
    nodes = depgraph.graph({"requirements.txt": "numpy==1.26.0\nscipy\n",
                            "package.json": '{"dependencies": {"d3": "^7"}}'})
    doc = sbom.spdx_document("eeg", "https://example.test/eeg", nodes, repo_licence="MIT")
    assert doc["spdxVersion"] == "SPDX-2.3" and doc["dataLicense"] == "CC0-1.0"
    root = doc["packages"][0]
    assert root["name"] == "eeg" and root["licenseDeclared"] == "MIT"
    names = {p["name"] for p in doc["packages"]}
    assert {"numpy", "scipy", "d3"} <= names
    numpy = next(p for p in doc["packages"] if p["name"] == "numpy")
    assert numpy["versionInfo"] == "1.26.0"
    assert numpy["externalRefs"][0]["referenceLocator"] == "pkg:pypi/numpy@1.26.0"
    assert numpy["licenseConcluded"] == "NOASSERTION"  # never invented
    # DESCRIBES the root, DEPENDS_ON each package.
    assert any(r["relationshipType"] == "DESCRIBES" for r in doc["relationships"])
    assert sum(1 for r in doc["relationships"] if r["relationshipType"] == "DEPENDS_ON") == len(nodes)
    # Valid JSON.
    assert json.loads(sbom.to_json(doc))["name"] == "eeg"


def test_spdx_tag_value():
    nodes = depgraph.graph({"requirements.txt": "numpy==1.26.0\n"})
    text = sbom.spdx_tag_value(sbom.spdx_document("eeg", "ns", nodes, repo_licence="MIT"))
    assert "SPDXVersion: SPDX-2.3" in text
    assert "PackageName: numpy" in text
    assert "PackageVersion: 1.26.0" in text
    assert "ExternalRef: PACKAGE-MANAGER purl pkg:pypi/numpy@1.26.0" in text
    assert "Relationship:" in text
