// The browser SBOM (SPDX 2.3) built from the dependency graph (night phase 11, E6; src/lib/sbom.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spdxDocument } from "../../src/lib/sbom.ts";
import type { DepView } from "../../src/lib/security-view.ts";

function dep(o: Partial<DepView> & { name: string; ecosystem: string }): DepView {
  return { snapshot: "default", name: o.name, ecosystem: o.ecosystem, version: o.version ?? "", req: "", scope: "runtime", direct: true, pinned: false, sources: [], commit: "" } as DepView;
}

describe("spdxDocument", () => {
  test("the root package and one package per dependency, with a purl", () => {
    const deps = [dep({ name: "numpy", ecosystem: "PyPI", version: "1.26.0" }), dep({ name: "d3", ecosystem: "npm" })];
    const doc = spdxDocument("ada/eeg", "https://spdx.org/x", deps, { repoLicence: "MIT", created: "2026-10-05T00:00:00Z" });
    assert.equal(doc.spdxVersion, "SPDX-2.3");
    assert.equal(doc.dataLicense, "CC0-1.0");
    assert.equal(doc.packages[0].name, "ada/eeg");
    assert.equal(doc.packages[0].licenseDeclared, "MIT");
    const numpy = doc.packages.find((p) => p.name === "numpy")!;
    assert.equal(numpy.versionInfo, "1.26.0");
    assert.equal(numpy.licenseConcluded, "NOASSERTION");
    assert.equal((numpy.externalRefs as { referenceLocator: string }[])[0].referenceLocator, "pkg:pypi/numpy@1.26.0");
    assert.equal(doc.relationships.filter((r) => r.relationshipType === "DEPENDS_ON").length, 2);
    assert.ok(doc.relationships.some((r) => r.relationshipType === "DESCRIBES"));
  });

  test("no repo licence: NOASSERTION, never invented", () => {
    const doc = spdxDocument("x", "ns", []);
    assert.equal(doc.packages[0].licenseDeclared, "NOASSERTION");
  });
});
