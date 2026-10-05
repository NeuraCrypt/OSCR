// The Security (and quality) read for a signed-in reader (night phase 11, E1; docs/SECURITY_QUALITY.md):
//
// GET /api/forge/security?id=<forge>:<repo_id> or ?path=<owner>/<name>
//   OSCR's security layer for one repository: the dependency graph the Mac computed from the
//   repository's environment files (repo_deps), at the default branch and at each commit a paper's
//   tracing map pins. Later elements of phase 11 add the vulnerability and secret alerts, the code
//   scanning results and the licence compatibility to the same answer.
//
// It reads only (the session is not touched), by the key's prefix (forge, repo_id): a key range,
// never a scan (tests/forge-service/security.test.ts checks the query plan). The analysis itself runs
// on the Mac (0 Worker requests, D00-11): the Worker never reads a manifest, never runs an analyser.
// A signed-out reader sees a sentence and signs in (the /r/ shell): this read is signed in (budget
// §15.6: about 500 signed-in Security views a day).

import { who } from "./who.ts";
import { json, problem } from "./http.ts";
import { hiddenOne } from "./hidden.ts";
import { all, alertsOf, depsOf, first, repoByKey, repoByPath } from "./store.ts";
import { NOT_FOUND, parseTarget, serviceForge } from "./read.ts";
import type { ForgeRequest, RepoRow } from "./types.ts";

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

interface DepRow {
  snapshot: "default" | "cited";
  ecosystem: string;
  name: string;
  version: string;
  req: string;
  scope: string;
  direct: number;
  pinned: number;
  sources: string;
  commit_sha: string;
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

interface AlertRow {
  kind: "osv" | "secret" | "sarif";
  ref: string;
  severity: AlertView["severity"];
  summary: string;
  detail: string;
  ecosystem: string;
  package: string;
  version: string;
  advisory: string;
  path: string;
  line: number | null;
  dev_scope: number;
  commit_sha: string;
  source: "mac" | "ci";
}

const SEVERITY_ORDER: Record<AlertView["severity"], number> = { critical: 0, high: 1, moderate: 2, low: 3, unknown: 4 };

export interface SecurityAnswer {
  repo: { forge: string; id: string; owner: string; name: string };
  dependencies: {
    default: DepView[];
    cited: DepView[];
    summary: { total: number; direct: number; transitive: number; pinned: number; ecosystems: Record<string, number> };
  };
  alerts: { osv: AlertView[]; secret: AlertView[]; sarif: AlertView[] };
}

function alertView(row: AlertRow): AlertView {
  let detail: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
  } catch {
    detail = {};
  }
  return {
    kind: row.kind, ref: row.ref, severity: row.severity, summary: row.summary, detail,
    ecosystem: row.ecosystem, package: row.package, version: row.version, advisory: row.advisory,
    path: row.path, line: row.line, devScope: row.dev_scope === 1, commit: row.commit_sha, source: row.source,
  };
}

function view(row: DepRow): DepView {
  let sources: string[] = [];
  try {
    const parsed = JSON.parse(row.sources);
    if (Array.isArray(parsed)) sources = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    sources = [];
  }
  return {
    snapshot: row.snapshot, ecosystem: row.ecosystem, name: row.name, version: row.version,
    req: row.req, scope: row.scope, direct: row.direct === 1, pinned: row.pinned === 1,
    sources, commit: row.commit_sha,
  };
}

function summarise(deps: DepView[]): SecurityAnswer["dependencies"]["summary"] {
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

export async function handleSecurity(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const target = parseTarget(r.url, serviceForge(r));
  if (!target) return problem(400, "invalid", "Name one repository: ?id=<forge>:<id> or ?path=<owner>/<name>.");
  const row =
    "id" in target
      ? await first<RepoRow>(repoByKey(r.db, target.forge, target.id))
      : await first<RepoRow>(repoByPath(r.db, target.forge, target.owner, target.name));
  if (!row || row.state === "hidden") return problem(404, "not_found", NOT_FOUND);
  // A repository hidden by moderation shows nothing of its security layer here.
  if (await hiddenOne(r.db, "repo", `${row.forge}:${row.repo_id}`)) {
    return problem(410, "moderated", "This repository is hidden from the registry's pages.");
  }
  const [depRows, alertRows] = await Promise.all([
    all<DepRow>(depsOf(r.db, row.forge, row.repo_id)),
    all<AlertRow>(alertsOf(r.db, row.forge, row.repo_id)),
  ]);
  const deps = depRows.map(view);
  const def = deps.filter((d) => d.snapshot === "default");
  const cited = deps.filter((d) => d.snapshot === "cited");
  const alerts: SecurityAnswer["alerts"] = { osv: [], secret: [], sarif: [] };
  for (const a of alertRows.map(alertView)) alerts[a.kind].push(a);
  for (const list of Object.values(alerts)) list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.ref.localeCompare(b.ref));
  const answer: SecurityAnswer = {
    repo: { forge: row.forge, id: row.repo_id, owner: row.owner_login, name: row.name },
    dependencies: { default: def, cited, summary: summarise(def.length ? def : cited) },
    alerts,
  };
  return json(answer);
}
