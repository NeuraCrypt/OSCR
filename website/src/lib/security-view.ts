// The Security (and quality) view, pure (night phase 11, E1; docs/SECURITY_QUALITY.md). It turns the
// registry's security layer (GET /api/forge/security) into the page's elements and filters the
// dependency graph in the browser. No DOM, no network: tested in Node (tests/forge-pages/
// security-view.test.ts). The DOM wiring (the form's events) is src/scripts/repo-security.ts.
//
// Like every browser view, it never names the platform.

import { h, link, type El } from "./repo-view.ts";

export interface DepView {
  snapshot: "default" | "cited";
  ecosystem: string;
  name: string;
  version: string;
  req: string;
  scope: string;
  direct: boolean;
  pinned: boolean;
  sources: string[];
  commit: string;
}

export interface DepSummary {
  total: number;
  direct: number;
  transitive: number;
  pinned: number;
  ecosystems: Record<string, number>;
}

export interface AlertView {
  kind: "osv" | "secret" | "sarif";
  ref: string;
  severity: "critical" | "high" | "moderate" | "low" | "unknown";
  summary: string;
  detail: Record<string, unknown>;
  ecosystem: string;
  package: string;
  version: string;
  advisory: string;
  path: string;
  line: number | null;
  devScope: boolean;
  commit: string;
  source: "mac" | "ci";
}

export interface SecurityAnswer {
  repo: { forge: string; id: string; owner: string; name: string };
  dependencies: { default: DepView[]; cited: DepView[]; summary: DepSummary };
  alerts: { osv: AlertView[]; secret: AlertView[]; sarif: AlertView[] };
  mayTriage: boolean;
}

const severityWord: Record<AlertView["severity"], string> = {
  critical: "critical", high: "high", moderate: "moderate", low: "low", unknown: "severity not known",
};

/** The severity in a .ok/.warning tone (never a pill). */
function severityEl(s: AlertView["severity"]): El {
  const tone = s === "low" || s === "unknown" ? "muted" : "warning";
  return h("span", { class: tone }, severityWord[s]);
}

/** A secret alert: its kind and place, the hidden hint, and how to fix it. Reports, never blocks. */
export function secretAlertEntry(a: AlertView): El {
  const remediation = typeof a.detail.remediation === "string" ? a.detail.remediation : "";
  const guess = a.detail.paired === true;
  return h("li", { class: "alert alert-secret" },
    h("p", { class: "alert-head" }, severityEl(a.severity), " ", h("span", null, a.summary), guess ? h("span", { class: "muted" }, " (a guess)") : null),
    remediation ? h("p", { class: "fix" }, remediation) : null,
  );
}

/** Triage buttons for an alert (shown only to a manager); the script wires their clicks. */
function triageButtons(a: AlertView): El {
  const data = { "data-kind": a.kind, "data-ref": a.ref };
  if (a.state === "dismissed") {
    return h("p", { class: "alert-actions" }, h("button", { ...data, "data-op": "reopen", type: "button" }, "Reopen"));
  }
  return h("p", { class: "alert-actions" },
    h("button", { ...data, "data-op": "dismiss", "data-reason": "tolerable", type: "button" }, "Dismiss as tolerable"),
    " ",
    h("button", { ...data, "data-op": "dismiss", "data-reason": "fixed", type: "button" }, "Dismiss as fixed"),
  );
}

/** One vulnerability or malware alert: severity, the package and version, the advisory id (and CVE),
 *  the summary, the labels, the state, and (for a manager) the triage buttons. */
export function osvAlertEntry(a: AlertView, mayTriage: boolean): El {
  const malware = a.detail.malware === true;
  const dismissed = a.state === "dismissed";
  const head = h("p", { class: "alert-head" },
    severityEl(a.severity),
    " ",
    h("span", null, malware ? "malicious package" : "vulnerability"),
    " in ",
    h("code", null, `${a.package}${a.version ? `@${a.version}` : ""}`),
    a.advisory ? h("span", { class: "muted" }, ` (${a.advisory}${typeof a.detail.cve === "string" && a.detail.cve ? `, ${a.detail.cve}` : ""})`) : null,
  );
  const labels: (El | string)[] = [];
  if (a.devScope || a.labels.includes("development-scope")) labels.push(h("span", { class: "muted" }, "development scope"));
  if (dismissed) labels.push(h("span", { class: "muted" }, a.auto ? `dismissed automatically (${a.reason})` : `dismissed (${a.reason})`));
  return h("li", { class: `alert alert-osv${dismissed ? " is-dismissed" : ""}`, "data-kind": "osv", "data-ref": a.ref },
    head,
    a.summary ? h("p", null, a.summary) : null,
    labels.length ? h("p", { class: "alert-meta" }, ...labels.flatMap((l, i) => (i ? [" · ", l] : [l]))) : null,
    mayTriage ? triageButtons(a) : null,
  );
}

/** The Vulnerability and malware alerts section (E2). */
export function osvSection(alerts: readonly AlertView[], mayTriage: boolean): El {
  const live = alerts.filter((a) => a.state === "open");
  return h("section", { class: "security-alerts" },
    h("h3", null, "Vulnerability and malware alerts"),
    h("p", { class: "muted" }, "From OSV (osv.dev), a free public database, matched against the dependency graph away from the site. Security and version-update pull requests are GitHub's Dependabot, which the researcher switches on; the registry shows alerts and never opens a pull request."),
    alerts.length
      ? h("ul", { class: "alerts" }, ...alerts.map((a) => osvAlertEntry(a, mayTriage)))
      : h("p", { class: "ok" }, "No known vulnerability or malicious package in the dependencies read."),
    alerts.length ? h("p", { class: "muted" }, `${live.length} open, ${alerts.length - live.length} dismissed.`) : null,
  );
}

/** One code-scanning (SARIF) alert: severity, rule, the file and line, the data-flow steps. */
export function sarifAlertEntry(a: AlertView, mayTriage: boolean): El {
  const ruleName = typeof a.detail.ruleName === "string" ? a.detail.ruleName : "";
  const flow = Array.isArray(a.detail.flow) ? (a.detail.flow as { path: string; line: number | null }[]) : [];
  const dismissed = a.state === "dismissed";
  return h("li", { class: `alert alert-sarif${dismissed ? " is-dismissed" : ""}`, "data-kind": "sarif", "data-ref": a.ref },
    h("p", { class: "alert-head" }, severityEl(a.severity), " ", h("span", null, a.summary || ruleName)),
    a.path ? h("p", { class: "alert-meta" }, "In ", h("code", null, `${a.path}${a.line ? `:${a.line}` : ""}`), dismissed ? h("span", { class: "muted" }, ` · dismissed (${a.reason})`) : null) : null,
    flow.length
      ? h("details", { class: "dep-paths" }, h("summary", null, `data flow (${flow.length} steps)`), h("ol", { class: "lines" }, ...flow.map((f) => h("li", null, h("code", null, `${f.path}${f.line ? `:${f.line}` : ""}`)))))
      : null,
    mayTriage ? triageButtons(a) : null,
  );
}

/** The Code scanning section (E4). OSCR runs no analyser: it shows the CI's own SARIF. */
export function sarifSection(alerts: readonly AlertView[], mayTriage: boolean): El {
  return h("section", { class: "security-scanning" },
    h("h3", null, "Code scanning"),
    h("p", { class: "muted" }, "Results your continuous integration uploaded as SARIF. The registry runs no analyser on your code; it shows what your CI reported."),
    alerts.length
      ? h("ul", { class: "alerts" }, ...alerts.map((a) => sarifAlertEntry(a, mayTriage)))
      : h("p", { class: "ok" }, "No code-scanning result was uploaded for this repository."),
  );
}

/** The Secret alerts section (E3). Says, in words, that it reports and never blocks a push. */
export function secretSection(alerts: readonly AlertView[]): El {
  return h("section", { class: "security-secrets" },
    h("h3", null, "Secret alerts"),
    h("p", { class: "muted" }, "Found in the files already read, after the push. The registry reports them and never blocks a push (pushes do not pass through it); a leaked token reaches its provider through GitHub's own partner programme, not through the registry. No value is kept: only a short hidden hint."),
    alerts.length
      ? h("ul", { class: "alerts" }, ...alerts.map(secretAlertEntry))
      : h("p", { class: "ok" }, "No secret was found in the files read."),
  );
}

export interface DepFilter {
  query: string;
  ecosystem: string; // "" = every ecosystem
  scope: string; // "" = every scope
  kind: "all" | "direct" | "transitive";
}

export const EMPTY_FILTER: DepFilter = { query: "", ecosystem: "", scope: "", kind: "all" };

/** Which dependencies a filter keeps (the view's search, filters and "show direct only"). */
export function filterDeps(deps: readonly DepView[], f: DepFilter): DepView[] {
  const q = f.query.trim().toLowerCase();
  return deps.filter((d) => {
    if (f.ecosystem && d.ecosystem !== f.ecosystem) return false;
    if (f.scope && d.scope !== f.scope) return false;
    if (f.kind === "direct" && !d.direct) return false;
    if (f.kind === "transitive" && d.direct) return false;
    if (q && !d.name.toLowerCase().includes(q) && !d.sources.some((s) => s.toLowerCase().includes(q))) return false;
    return true;
  });
}

/** The one-sentence summary of a snapshot. */
export function summaryWords(s: DepSummary): string {
  if (!s.total) return "No dependency was read from this repository's environment files.";
  const by = Object.entries(s.ecosystems).sort().map(([e, n]) => `${n} ${e}`).join(", ");
  return `${s.total} ${s.total === 1 ? "dependency" : "dependencies"} (${s.direct} direct, ${s.transitive} pulled in by a lock file; ${s.pinned} pinned to an exact version). By ecosystem: ${by}.`;
}

/** The scope in plain words. */
function scopeWords(scope: string): string {
  return { runtime: "runtime", build: "build", optional: "optional", dev: "development", actions: "GitHub Actions" }[scope] ?? scope;
}

/** One dependency as a definition-list entry: its name and version, where it is declared, its scope,
 *  and a "show paths" expander listing every file it appears in. */
export function depEntry(d: DepView): El {
  const facts: (El | string)[] = [
    h("span", { class: d.direct ? "ok" : "muted" }, d.direct ? "direct" : "transitive"),
    " · ",
    scopeWords(d.scope),
    " · ",
    d.pinned ? h("span", { class: "ok" }, "pinned") : h("span", { class: "warning" }, "not pinned"),
  ];
  const paths = d.sources.length
    ? h("details", { class: "dep-paths" }, h("summary", null, `show ${d.sources.length === 1 ? "path" : "paths"}`), h("ul", null, ...d.sources.map((s) => h("li", null, h("code", null, s)))))
    : null;
  return h("dd", { class: "dep", "data-eco": d.ecosystem, "data-scope": d.scope, "data-direct": d.direct ? "1" : "0", "data-name": d.name.toLowerCase() },
    h("div", { class: "dep-facts" }, ...facts), paths);
}

/** The dependency list of a snapshot (the label pairs with the entries, a definition list). */
export function depsList(deps: readonly DepView[]): El {
  if (!deps.length) return h("p", { class: "muted" }, "No dependency matches.");
  const items: El[] = [];
  for (const d of deps) {
    const label = h("dt", null,
      h("span", { class: "dep-name" }, d.name),
      " ",
      h("span", { class: "dep-eco" }, d.ecosystem),
      " ",
      d.version ? h("span", { class: "dep-version" }, d.version) : (d.req ? h("span", { class: "dep-req" }, d.req) : h("span", { class: "warning" }, "no version")),
    );
    items.push(label, depEntry(d));
  }
  return h("dl", { class: "deps listing" }, ...items);
}

/** The filter form (science.css fieldset.choices; the script wires its events). */
export function depFilterForm(summary: DepSummary): El {
  const ecoOptions = ["", ...Object.keys(summary.ecosystems).sort()].map((e) =>
    h("option", { value: e }, e || "every ecosystem"));
  const scopeOptions = ["", "runtime", "build", "optional", "dev", "actions"].map((s) =>
    h("option", { value: s }, s ? scopeWords(s) : "every scope"));
  const kindOptions = (["all", "direct", "transitive"] as const).map((k) =>
    h("option", { value: k }, k === "all" ? "direct and transitive" : k));
  return h("form", { class: "dep-filter", role: "search" },
    h("label", null, "Search ", h("input", { type: "search", name: "q", placeholder: "a package or a file" })),
    h("label", null, "Ecosystem ", h("select", { name: "ecosystem" }, ...ecoOptions)),
    h("label", null, "Scope ", h("select", { name: "scope" }, ...scopeOptions)),
    h("label", null, "Kind ", h("select", { name: "kind" }, ...kindOptions)),
  );
}

/** The whole Dependencies section for a snapshot. */
export function dependenciesSection(answer: SecurityAnswer, snapshot: "default" | "cited"): El {
  const deps = snapshot === "cited" ? answer.dependencies.cited : answer.dependencies.default;
  const summary = snapshot === "cited" ? summariseView(answer.dependencies.cited) : answer.dependencies.summary;
  const header = snapshot === "cited"
    ? "Dependencies at the commit the papers cite"
    : "Dependencies at the default branch";
  return h("section", { class: "security-deps", "data-snapshot": snapshot },
    h("h3", null, header),
    h("p", { class: "dep-summary" }, summaryWords(summary)),
    deps.length ? depFilterForm(summary) : null,
    h("div", { class: "dep-list" }, depsList(deps)),
  );
}

/** Recompute a summary (the cited snapshot's; the default's comes from the Worker). */
export function summariseView(deps: readonly DepView[]): DepSummary {
  const ecosystems: Record<string, number> = {};
  let direct = 0;
  let pinned = 0;
  for (const d of deps) {
    ecosystems[d.ecosystem] = (ecosystems[d.ecosystem] ?? 0) + 1;
    if (d.direct) direct += 1;
    if (d.pinned) pinned += 1;
  }
  return { total: deps.length, direct, transitive: deps.length - direct, pinned, ecosystems };
}

/** The Security tab's whole content for a repository. Later elements add their sections here. */
export function securityView(answer: SecurityAnswer): El {
  const hasCited = answer.dependencies.cited.length > 0;
  return h("div", { class: "security" },
    h("h2", null, "Security and quality"),
    h("p", { class: "muted" }, "The registry reads this repository's environment files and stored code as text and never runs them. The analysis is computed away from the site; nothing of the code is executed here."),
    osvSection(answer.alerts.osv, answer.mayTriage),
    sarifSection(answer.alerts.sarif, answer.mayTriage),
    secretSection(answer.alerts.secret),
    dependenciesSection(answer, "default"),
    hasCited ? dependenciesSection(answer, "cited") : null,
  );
}

/** The link to the source forge, a last resort (D00-3), said why. */
export function sourceNote(web: string, owner: string, name: string): El | string {
  return h("p", { class: "muted" }, "Prefer the registry's own view above. The same repository is at ",
    link(`${web}/${owner}/${name}/network/dependencies`, "GitHub's dependency graph"),
    ", which needs a GitHub account to see in full.");
}
