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
import { type SignedIn } from "../../account/guard.ts";
import { json, problem, problemAnswer } from "./http.ts";
import { readCapped } from "./flow.ts";
import { hiddenOne } from "./hidden.ts";
import { actionRow, all, alertByRef, alertsOf, depsOf, first, newNonce, repoByKey, repoByPath, triageOf, triageWrite } from "./store.ts";
import { NOT_FOUND, parseTarget, serviceForge } from "./read.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { managersOf } from "./blocks.ts";
import { linkedGithub } from "./identity.ts";
import { ForgeProblem, type ForgeRequest, type RepoRow } from "./types.ts";

const TRIAGE_BODY_BYTES = 8 * 1024;
const REASONS = new Set(["", "fixed", "no_bandwidth", "tolerable", "false_positive", "used_in_tests", "wont_fix", "revoked"]);
const ALERT_KINDS = new Set(["osv", "secret", "sarif"]);

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
  state: "open" | "dismissed";
  reason: string;
  assignee: string;
  labels: string[];
  auto: boolean; // dismissed by an auto-triage rule (not a person)
}

interface TriageRow {
  kind: "osv" | "secret" | "sarif";
  ref: string;
  state: "open" | "dismissed";
  reason: string;
  assignee: string;
  note: string;
  labels: string;
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
  mayTriage: boolean;
}

function alertView(row: AlertRow, triage: Map<string, TriageRow>): AlertView {
  let detail: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
  } catch {
    detail = {};
  }
  const t = triage.get(`${row.kind}\n${row.ref}`);
  const autoDismiss = typeof detail.auto_dismiss === "string" && detail.auto_dismiss !== "";
  let labels: string[] = [];
  if (t) {
    try {
      const parsed = JSON.parse(t.labels);
      if (Array.isArray(parsed)) labels = parsed.filter((x): x is string => typeof x === "string");
    } catch { labels = []; }
  }
  if (row.dev_scope === 1 && !labels.includes("development-scope")) labels = ["development-scope", ...labels];
  // The human decision wins; otherwise an auto-triage rule may have dismissed it.
  const state: "open" | "dismissed" = t ? t.state : (autoDismiss ? "dismissed" : "open");
  return {
    kind: row.kind, ref: row.ref, severity: row.severity, summary: row.summary, detail,
    ecosystem: row.ecosystem, package: row.package, version: row.version, advisory: row.advisory,
    path: row.path, line: row.line, devScope: row.dev_scope === 1, commit: row.commit_sha, source: row.source,
    state, reason: t ? t.reason : (autoDismiss ? String(detail.auto_dismiss) : ""),
    assignee: t ? t.assignee : "", labels, auto: !t && autoDismiss,
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
  const [depRows, alertRows, triageRows] = await Promise.all([
    all<DepRow>(depsOf(r.db, row.forge, row.repo_id)),
    all<AlertRow>(alertsOf(r.db, row.forge, row.repo_id)),
    all<TriageRow>(triageOf(r.db, row.forge, row.repo_id)),
  ]);
  const triage = new Map(triageRows.map((t) => [`${t.kind}\n${t.ref}`, t]));
  const deps = depRows.map(view);
  const def = deps.filter((d) => d.snapshot === "default");
  const cited = deps.filter((d) => d.snapshot === "cited");
  const alerts: SecurityAnswer["alerts"] = { osv: [], secret: [], sarif: [] };
  for (const a of alertRows.map((row) => alertView(row, triage))) alerts[a.kind].push(a);
  for (const list of Object.values(alerts)) list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.ref.localeCompare(b.ref));
  const mayTriage = mayWrite(r.env, await linkedGithub(s.db, s.user.id)) && (await managersOf(s.db, row)).has(s.user.id);
  const answer: SecurityAnswer = {
    repo: { forge: row.forge, id: row.repo_id, owner: row.owner_login, name: row.name },
    dependencies: { default: def, cited, summary: summarise(def.length ? def : cited) },
    alerts, mayTriage,
  };
  return json(answer);
}

// ─── POST /api/forge/security/triage ─────────────────────────────────────────
// A person who manages the repository dismisses, reopens, assigns or labels an alert. Gated by
// FORGE_OPEN (owner only until the GitHub side opens). The Mac's facts are never touched: the
// decision is a row of its own (alert_triage).

interface TriageInput {
  op: "dismiss" | "reopen" | "assign" | "label";
  kind: "osv" | "secret" | "sarif";
  ref: string;
  reason: string;
  assignee: string;
  note: string;
  labels: string[];
}

function validateTriage(body: unknown): TriageInput | ForgeProblem {
  const bad = (m: string) => new ForgeProblem(400, "invalid", m);
  if (!body || typeof body !== "object") return bad("The request is not readable.");
  const b = body as Record<string, unknown>;
  const op = b.op;
  if (op !== "dismiss" && op !== "reopen" && op !== "assign" && op !== "label") return bad("The action is dismiss, reopen, assign or label.");
  if (typeof b.kind !== "string" || !ALERT_KINDS.has(b.kind)) return bad("The alert kind is osv, secret or sarif.");
  if (typeof b.ref !== "string" || b.ref.length < 1 || b.ref.length > 300) return bad("Name one alert by its ref.");
  const reason = typeof b.reason === "string" ? b.reason : "";
  if (op === "dismiss" && !REASONS.has(reason)) return bad("The dismissal reason is one the registry knows.");
  const assignee = typeof b.assignee === "string" ? b.assignee.slice(0, 100) : "";
  if (assignee.includes("@")) return bad("An assignee is a handle, never an email address.");
  const note = typeof b.note === "string" ? b.note.slice(0, 2000) : "";
  const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === "string" && x.length <= 40).slice(0, 10) : [];
  return { op, kind: b.kind as TriageInput["kind"], ref: b.ref, reason: op === "dismiss" ? reason : "", assignee, note, labels };
}

/** Who may triage: a person who manages the repository in the registry, with the GitHub side open to
 *  them (FORGE_OPEN), under the day's caps. */
async function maySecurity(r: ForgeRequest, s: SignedIn, repo: RepoRow, rows: number): Promise<ForgeProblem | { github: string }> {
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  if (!(await managersOf(s.db, repo)).has(s.user.id)) {
    return new ForgeProblem(403, "forbidden", "Only the people who manage a repository in the registry triage its alerts.");
  }
  const caps = await dailyCaps(r.db, s.user.id, "security_alert", r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, Math.min(rows, FORGE_ROWS_PER_DAY))) ?? { github: github ?? "" };
}

export async function handleTriage(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const target = parseTarget(r.url, serviceForge(r));
  if (!target) return say(new ForgeProblem(400, "invalid", "Name one repository: ?id=<forge>:<id> or ?path=<owner>/<name>."));
  const text = await readCapped(r.request, TRIAGE_BODY_BYTES);
  if (text === null) return say(new ForgeProblem(413, "too_large", "This request is larger than the registry reads."));
  let body: unknown;
  try { body = JSON.parse(text); } catch { return say(new ForgeProblem(400, "invalid", "The request is not readable.")); }
  const p = validateTriage(body);
  if (p instanceof ForgeProblem) return say(p);
  const row =
    "id" in target
      ? await first<RepoRow>(repoByKey(r.db, target.forge, target.id))
      : await first<RepoRow>(repoByPath(r.db, target.forge, target.owner, target.name));
  if (!row || row.state === "hidden") return say(new ForgeProblem(404, "not_found", NOT_FOUND));
  // The alert must exist (a person triages a real finding, never an invented one).
  if (!(await first(alertByRef(r.db, row.forge, row.repo_id, p.kind, p.ref)))) {
    return say(new ForgeProblem(404, "not_found", "The registry does not know this alert."));
  }
  const gate = await maySecurity(r, s, row, 2);
  if (gate instanceof ForgeProblem) return say(gate);
  const state = p.op === "dismiss" ? "dismissed" : "open";
  const write = triageWrite(r.db, {
    forge: row.forge, repoId: row.repo_id, kind: p.kind, ref: p.ref, state,
    reason: p.reason, assignee: p.assignee, note: p.note, labels: p.labels, byUser: s.user.id, at: r.t,
  });
  const action = actionRow(r.db, {
    userId: s.user.id, t: r.t, nonce: newNonce(), kind: "security_alert",
    forge: row.forge, repoId: row.repo_id, githubUser: gate.github, outcome: "done", rows: 2,
    subject: `${p.kind}:${row.forge}:${row.repo_id}`,
  });
  await r.db.batch([write.stmt, action.stmt]);
  return json({ ok: true, state, written: 2 }, 200, s.cookies);
}
