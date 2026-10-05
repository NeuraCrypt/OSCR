// The Security (and quality) view (night phase 11, E1; src/lib/security-view.ts): the dependency graph
// filtered in the browser (search, ecosystem, scope, direct or transitive), the summary in words, the
// "show paths" disclosure, both snapshots.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { textOf } from "../../src/lib/repo-view.ts";
import {
  dependenciesSection, depEntry, EMPTY_FILTER, filterDeps, secretSection, securityView, summariseView, summaryWords,
  type AlertView, type DepView, type SecurityAnswer,
} from "../../src/lib/security-view.ts";

function dep(o: Partial<DepView> & { name: string }): DepView {
  return {
    snapshot: "default", ecosystem: "PyPI", name: o.name, version: o.version ?? "", req: o.req ?? "",
    scope: o.scope ?? "runtime", direct: o.direct ?? true, pinned: o.pinned ?? false,
    sources: o.sources ?? [], commit: o.commit ?? "", ...o,
  } as DepView;
}

const DEPS: DepView[] = [
  dep({ name: "numpy", version: "1.26.0", pinned: true, sources: ["requirements.txt"] }),
  dep({ name: "scipy", req: ">=1.10", direct: false }),
  dep({ name: "d3", ecosystem: "npm", scope: "dev", sources: ["package.json"] }),
];

describe("security-view filters", () => {
  test("search matches a name or a source path", () => {
    assert.deepEqual(filterDeps(DEPS, { ...EMPTY_FILTER, query: "num" }).map((d) => d.name), ["numpy"]);
    assert.deepEqual(filterDeps(DEPS, { ...EMPTY_FILTER, query: "package.json" }).map((d) => d.name), ["d3"]);
  });

  test("ecosystem, scope and kind filters", () => {
    assert.deepEqual(filterDeps(DEPS, { ...EMPTY_FILTER, ecosystem: "npm" }).map((d) => d.name), ["d3"]);
    assert.deepEqual(filterDeps(DEPS, { ...EMPTY_FILTER, scope: "dev" }).map((d) => d.name), ["d3"]);
    assert.deepEqual(filterDeps(DEPS, { ...EMPTY_FILTER, kind: "transitive" }).map((d) => d.name), ["scipy"]);
    assert.deepEqual(filterDeps(DEPS, { ...EMPTY_FILTER, kind: "direct" }).map((d) => d.name).sort(), ["d3", "numpy"]);
  });
});

describe("security-view rendering", () => {
  test("the summary names counts and ecosystems", () => {
    const s = summariseView(DEPS);
    const words = summaryWords(s);
    assert.match(words, /3 dependencies/);
    assert.match(words, /2 direct/);
    assert.match(words, /1 pinned/);
    assert.match(words, /2 PyPI, 1 npm/);
  });

  test("a dependency entry shows direct and pinned, and its paths under a disclosure", () => {
    const el = depEntry(DEPS[0]);
    const t = textOf(el);
    assert.match(t, /direct/);
    assert.match(t, /pinned/);
    assert.match(t, /show path/);
    assert.match(t, /requirements\.txt/);
  });

  test("a transitive, unpinned dependency says so", () => {
    const t = textOf(depEntry(DEPS[1]));
    assert.match(t, /transitive/);
    assert.match(t, /not pinned/);
  });

  test("the whole view has a default section and, when present, a cited one", () => {
    const answer: SecurityAnswer = {
      repo: { forge: "memory", id: "101", owner: "ada", name: "eeg" },
      dependencies: { default: DEPS, cited: [dep({ name: "numpy", version: "1.25.0", pinned: true, commit: "b".repeat(40) })], summary: summariseView(DEPS) },
      alerts: { osv: [], secret: [], sarif: [] },
    };
    const t = textOf(securityView(answer));
    assert.match(t, /Dependencies at the default branch/);
    assert.match(t, /Dependencies at the commit the papers cite/);
    assert.match(t, /never runs them/);
  });

  test("the secret section says it reports and never blocks, and shows the fix", () => {
    const alert: AlertView = {
      kind: "secret", ref: "config.py:12:a-github-token", severity: "high",
      summary: "a GitHub token on line 12 of config.py (ghp_ab…)", detail: { hint: "ghp_ab…", paired: false, remediation: "Revoke it with the provider." },
      ecosystem: "", package: "", version: "", advisory: "", path: "config.py", line: 12, devScope: false, commit: "", source: "mac",
    };
    const t = textOf(secretSection([alert]));
    assert.match(t, /never blocks a push/);
    assert.match(t, /a GitHub token on line 12/);
    assert.match(t, /Revoke it with the provider/);
  });

  test("the secret section, empty, says none was found", () => {
    assert.match(textOf(secretSection([])), /No secret was found/);
  });

  test("no dependencies: a plain sentence, no form", () => {
    const answer: SecurityAnswer = {
      repo: { forge: "memory", id: "101", owner: "ada", name: "eeg" },
      dependencies: { default: [], cited: [], summary: summariseView([]) },
      alerts: { osv: [], secret: [], sarif: [] },
    };
    const t = textOf(dependenciesSection(answer, "default"));
    assert.match(t, /No dependency was read/);
  });
});
