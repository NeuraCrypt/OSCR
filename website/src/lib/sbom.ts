// SBOM (SPDX 2.3) built in the reader's browser from the dependency graph the Security tab already
// fetched (night phase 11, E6; docs/SECURITY_QUALITY.md). No server storage: the page offers the
// document as a download. Pure, tested in Node (tests/forge-pages/sbom.test.ts). It mirrors the
// Mac's oscr/sbom.py for the same packages; a dependency's own licence is not fetched, so it is
// NOASSERTION (never invented). Like every browser helper, it never names the platform.

import type { DepView } from "./security-view.ts";

const PURL_TYPE: Record<string, string> = { PyPI: "pypi", npm: "npm", CRAN: "cran", Julia: "julia", conda: "conda", Actions: "github" };

const spdxId = (prefix: string, name: string): string => `SPDXRef-${prefix}-${name.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "")}`;

export interface SpdxDoc {
  spdxVersion: string;
  dataLicense: string;
  SPDXID: string;
  name: string;
  documentNamespace: string;
  creationInfo: { created: string; creators: string[] };
  packages: Record<string, unknown>[];
  relationships: Record<string, string>[];
}

/** An SPDX 2.3 document for a repository and its dependency graph. `created` is passed in (the page
 *  uses the current time) so the function stays pure for the tests. */
export function spdxDocument(name: string, namespace: string, deps: readonly DepView[], opts: { repoLicence?: string; created?: string } = {}): SpdxDoc {
  const created = opts.created ?? "1970-01-01T00:00:00Z";
  const rootId = spdxId("Package", name || "repository");
  const packages: Record<string, unknown>[] = [{
    SPDXID: rootId, name: name || "repository", downloadLocation: "NOASSERTION",
    licenseConcluded: opts.repoLicence || "NOASSERTION", licenseDeclared: opts.repoLicence || "NOASSERTION", copyrightText: "NOASSERTION",
  }];
  const relationships: Record<string, string>[] = [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: rootId }];
  const seen = new Set<string>();
  for (const d of deps) {
    const sid = spdxId("Package", `${d.ecosystem}-${d.name}-${d.version || "x"}`);
    if (seen.has(sid)) continue;
    seen.add(sid);
    const pkg: Record<string, unknown> = {
      SPDXID: sid, name: d.name, versionInfo: d.version || "NOASSERTION", downloadLocation: "NOASSERTION",
      licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION",
    };
    const purl = PURL_TYPE[d.ecosystem];
    if (purl) pkg.externalRefs = [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:${purl}/${d.name}${d.version ? `@${d.version}` : ""}` }];
    packages.push(pkg);
    relationships.push({ spdxElementId: rootId, relationshipType: "DEPENDS_ON", relatedSpdxElement: sid });
  }
  return {
    spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: name || "repository",
    documentNamespace: namespace, creationInfo: { created, creators: ["Tool: oscr-security"] }, packages, relationships,
  };
}
