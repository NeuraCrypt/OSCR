// Code scanning: SARIF uploaded by the researcher's CI (night phase 11, E4; docs/SECURITY_QUALITY.md).
//
// POST /api/forge/v1/security/sarif (a personal token, scope security:write)
//   The researcher's CI runs its own analyser and uploads the result as SARIF 2.1.0; the registry
//   parses it and shows the alerts (rule, message, severity, the file and line, the data-flow steps,
//   the commit and branch, the state). OSCR runs NO analyser on users' code (D00-11): it stores what
//   the CI reported, nothing more. The upload replaces the repository's code-scanning alerts.
//
// Gated by FORGE_OPEN like every write (the researcher's own token; until the GitHub side opens, the
// owner's). No code of the repository is stored: only the facts the SARIF carries (paths, lines,
// rule ids, messages), each text masked for an address.

import { who } from "./who.ts";
import { type SignedIn } from "../../account/guard.ts";
import { json, problemAnswer } from "./http.ts";
import { readCapped } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { actionRow, first, newNonce, repoByKey, repoByPath, type Write } from "./store.ts";
import { serviceForge } from "./read.ts";
import { maskEmails } from "../mask.ts";
import { ForgeProblem, type ForgeName, type ForgeRequest, type RepoRow } from "./types.ts";

/** SARIF files are large; larger than this: 413, and the CI can narrow its upload. */
export const SARIF_BODY_BYTES = 2 * 1024 * 1024;
/** Results kept per upload (bounds the day's rows). */
export const MAX_RESULTS = 200;

export interface SarifAlert {
  ruleId: string;
  ruleName: string;
  severity: "critical" | "high" | "moderate" | "low" | "unknown";
  message: string;
  path: string;
  line: number | null;
  flow: { path: string; line: number | null }[];
  help: string;
}

const LEVEL_SEVERITY: Record<string, SarifAlert["severity"]> = {
  error: "high", warning: "moderate", note: "low", none: "unknown",
};

function band(score: number): SarifAlert["severity"] {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  if (score > 0) return "low";
  return "unknown";
}

function physical(loc: unknown): { path: string; line: number | null } {
  const p = (loc as { physicalLocation?: { artifactLocation?: { uri?: unknown }; region?: { startLine?: unknown } } })?.physicalLocation;
  const path = typeof p?.artifactLocation?.uri === "string" ? p.artifactLocation.uri : "";
  const line = typeof p?.region?.startLine === "number" ? p.region.startLine : null;
  return { path: path.slice(0, 4096), line };
}

/** Parse a SARIF 2.1.0 document into alerts. Tolerant: an unreadable part yields fewer alerts, never
 *  an error (nothing of the registry runs; this reads a report). */
export function parseSarif(doc: unknown): SarifAlert[] {
  const out: SarifAlert[] = [];
  const runs = (doc as { runs?: unknown[] })?.runs;
  if (!Array.isArray(runs)) return out;
  for (const run of runs) {
    const rules = new Map<string, { name: string; level?: string; score?: number; help: string }>();
    const driver = (run as { tool?: { driver?: { rules?: unknown[] } } })?.tool?.driver;
    for (const rule of driver?.rules ?? []) {
      const rr = rule as { id?: unknown; name?: unknown; defaultConfiguration?: { level?: unknown }; properties?: { "security-severity"?: unknown }; helpUri?: unknown };
      if (typeof rr.id !== "string") continue;
      const score = Number(rr.properties?.["security-severity"]);
      rules.set(rr.id, {
        name: typeof rr.name === "string" ? rr.name : rr.id,
        level: typeof rr.defaultConfiguration?.level === "string" ? rr.defaultConfiguration.level : undefined,
        score: Number.isFinite(score) ? score : undefined,
        help: typeof rr.helpUri === "string" ? rr.helpUri : "",
      });
    }
    const results = (run as { results?: unknown[] })?.results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      const rs = result as { ruleId?: unknown; level?: unknown; message?: { text?: unknown }; locations?: unknown[]; codeFlows?: unknown[] };
      const ruleId = typeof rs.ruleId === "string" ? rs.ruleId : "";
      const rule = rules.get(ruleId);
      const level = typeof rs.level === "string" ? rs.level : rule?.level ?? "warning";
      const severity = rule?.score !== undefined ? band(rule.score) : (LEVEL_SEVERITY[level] ?? "moderate");
      const at = Array.isArray(rs.locations) && rs.locations.length ? physical(rs.locations[0]) : { path: "", line: null };
      const flow: { path: string; line: number | null }[] = [];
      const first = Array.isArray(rs.codeFlows) ? rs.codeFlows[0] : undefined;
      const thread = (first as { threadFlows?: unknown[] })?.threadFlows?.[0] as { locations?: unknown[] } | undefined;
      for (const step of thread?.locations ?? []) {
        const s = (step as { location?: unknown }).location;
        if (s) flow.push(physical(s));
        if (flow.length >= 20) break;
      }
      out.push({
        ruleId: ruleId.slice(0, 200),
        ruleName: (rule?.name ?? ruleId).slice(0, 200),
        severity,
        message: maskEmails(typeof rs.message?.text === "string" ? rs.message.text : "").slice(0, 2000),
        path: at.path,
        line: at.line,
        flow: flow.map((f) => ({ path: maskEmails(f.path), line: f.line })),
        help: rule?.help ?? "",
      });
      if (out.length >= MAX_RESULTS) return out;
    }
  }
  return out;
}

interface SarifUpload {
  repo: string;
  commit: string;
  ref: string;
  alerts: SarifAlert[];
}

function validate(body: unknown): SarifUpload | ForgeProblem {
  const bad = (m: string) => new ForgeProblem(400, "invalid", m);
  if (!body || typeof body !== "object") return bad("The request is not readable.");
  const b = body as Record<string, unknown>;
  if (typeof b.repo !== "string" || !b.repo) return bad("Name the repository: owner/name or <forge>:<id>.");
  const commit = typeof b.commit === "string" ? b.commit : "";
  if (commit && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) return bad("The commit is a full hex sha, or absent.");
  const ref = typeof b.ref === "string" ? b.ref.slice(0, 200) : "";
  if (!b.sarif || typeof b.sarif !== "object") return bad("A sarif field with the SARIF document is required.");
  const alerts = parseSarif(b.sarif);
  return { repo: b.repo, commit, ref, alerts };
}

async function resolveRepo(r: ForgeRequest, spec: string): Promise<RepoRow | null> {
  const forge = serviceForge(r);
  const byId = /^(github|memory):([0-9]+)$/.exec(spec);
  if (byId) return first<RepoRow>(repoByKey(r.db, byId[1] as ForgeName, byId[2]));
  const parts = spec.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  return first<RepoRow>(repoByPath(r.db, forge, parts[0], parts[1]));
}

function sarifWrites(r: ForgeRequest, repo: RepoRow, u: SarifUpload): Write[] {
  const writes: Write[] = [
    { rows: 1, stmt: r.db.prepare("DELETE FROM security_alerts WHERE forge = ? AND repo_id = ? AND kind = 'sarif'").bind(repo.forge, repo.repo_id) },
  ];
  const t = Math.floor(r.t);
  u.alerts.forEach((a, i) => {
    const ref = `${a.ruleId}:${a.path}:${a.line ?? 0}:${i}`.slice(0, 300);
    const detail = JSON.stringify({ ruleName: a.ruleName, flow: a.flow.slice(0, 20), help: a.help, ref: u.ref });
    writes.push({
      rows: 1,
      stmt: r.db
        .prepare("INSERT INTO security_alerts (forge, repo_id, kind, ref, severity, summary, detail, path, line, commit_sha, source, found_at, updated_at) "
          + "VALUES (?, ?, 'sarif', ?, ?, ?, ?, ?, ?, ?, 'ci', ?, ?) "
          + "ON CONFLICT (forge, repo_id, kind, ref) DO UPDATE SET severity = excluded.severity, summary = excluded.summary, detail = excluded.detail, path = excluded.path, line = excluded.line, commit_sha = excluded.commit_sha, updated_at = excluded.updated_at")
        .bind(repo.forge, repo.repo_id, ref, a.severity, `${a.ruleName}: ${a.message}`.slice(0, 2000), detail.slice(0, 16384), a.path, a.line, u.commit, t, t),
    });
  });
  return writes;
}

export async function handleSarifUpload(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const text = await readCapped(r.request, SARIF_BODY_BYTES);
  if (text === null) return say(new ForgeProblem(413, "too_large", "This SARIF upload is larger than the registry reads (2 MiB)."));
  let body: unknown;
  try { body = JSON.parse(text); } catch { return say(new ForgeProblem(400, "invalid", "The request is not readable.")); }
  const u = validate(body);
  if (u instanceof ForgeProblem) return say(u);
  const repo = await resolveRepo(r, u.repo);
  if (!repo || repo.state === "hidden") return say(new ForgeProblem(404, "not_found", "The registry does not know this repository: code scanning is shown for the repositories it follows."));
  const github = await (await import("./identity.ts")).linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return say(closed());
  const caps = await dailyCaps(r.db, s.user.id, "sarif", r.t);
  if (caps.exceeded) return say(overCap(caps.exceeded));
  const writes = sarifWrites(r, repo, u);
  const reserve = Math.min(1 + writes.length, FORGE_ROWS_PER_DAY);
  const over = await globalCap(r.db, r.t, reserve);
  if (over) return say(over);
  const action = actionRow(r.db, {
    userId: s.user.id, t: r.t, nonce: newNonce(), kind: "sarif",
    forge: repo.forge, repoId: repo.repo_id, githubUser: github ?? "", outcome: "done",
    rows: 1 + writes.reduce((n, w) => n + w.rows, 0), subject: `sarif:${repo.forge}:${repo.repo_id}`,
  });
  await r.db.batch([...writes.map((w) => w.stmt), action.stmt]);
  return json({ ok: true, alerts: u.alerts.length, written: 1 + writes.length }, 201, s.cookies);
}
