// The checks of a commit, in the repository's pages (night phase 10, E5; docs/AUTOMATION.md): the
// registry's own checks (worker/forge/checks-core.ts, computed in the reader's browser: they read
// files as text and never run code), the researcher's own CI as GitHub reports it (check runs and
// commit statuses, read on the reader's quota), the statuses outside services posted to the registry,
// and the environments the workflows test, read from their files as text. Pure: view trees, no DOM,
// testable in Node (tests/forge-pages/checks-view.test.ts). Like every browser script, it never names
// the platform.

import { CHECK_WORDS, type Finding, type Report } from "../../worker/forge/checks-core.ts";
import type * as T from "../../worker/forge/types.ts";
import { parseYaml, type Yaml } from "./citation.ts";
import { checkWords, statusWords } from "./pull-page.ts";
import { checksSummary } from "./pulls.ts";
import { type Child, type El, h, link } from "./repo-view.ts";

// ─── the workflows, read as text ─────────────────────────────────────────────

export interface WorkflowJob {
  id: string;
  name: string;
  /** The runners asked for (a matrix expression kept as written). */
  runsOn: string[];
  container: string | null;
  /** The matrix's axes and their values (includes and excludes left out). */
  matrix: { key: string; values: string[] }[];
  /** The actions the steps use ("actions/setup-python@v5"). */
  uses: string[];
}

export interface Workflow {
  path: string;
  name: string;
  /** What starts it: push, pull_request, schedule, workflow_dispatch… */
  triggers: string[];
  jobs: WorkflowJob[];
}

/** The workflow files of a tree (.github/workflows/*.yml|yaml), at most `max`. */
export function workflowPaths(paths: readonly string[], max = 10): string[] {
  return paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort().slice(0, max);
}

const obj = (v: Yaml | undefined): Record<string, Yaml> => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v: Yaml | undefined): string => (typeof v === "string" ? v.trim() : "");
const list = (v: Yaml | undefined): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : str(v) ? [str(v)] : []);

/** A workflow file as data: its name, what starts it, each job's runners, container, matrix and the
 *  actions it uses. Nothing is run; an unreadable file is null. */
export function readWorkflow(path: string, text: string): Workflow | null {
  let doc: Yaml;
  try {
    doc = parseYaml(text.slice(0, 200_000));
  } catch {
    return null;
  }
  const root = obj(doc);
  if (!Object.keys(root).length) return null;
  const on = root.on ?? root.true;
  const triggers = Array.isArray(on) ? list(on) : typeof on === "string" ? [on.trim()] : Object.keys(obj(on));
  const jobs: WorkflowJob[] = [];
  for (const [id, raw] of Object.entries(obj(root.jobs)).slice(0, 50)) {
    const j = obj(raw);
    const strategy = obj(j.strategy);
    const matrix = obj(strategy.matrix);
    const axes = Object.entries(matrix)
      .filter(([k]) => k !== "include" && k !== "exclude")
      .map(([key, v]) => ({ key, values: list(v) }))
      .filter((a) => a.values.length);
    const container = str(j.container) || str(obj(j.container).image) || null;
    const uses = (Array.isArray(j.steps) ? j.steps : []).map((s) => str(obj(s).uses)).filter(Boolean);
    jobs.push({ id, name: str(j.name) || id, runsOn: list(j["runs-on"]), container, matrix: axes, uses: [...new Set(uses)].slice(0, 20) });
  }
  return { path, name: str(root.name) || path.split("/").pop() || path, triggers, jobs };
}

const LANGUAGE = /^(python|python-version|py|r|r-version|julia|julia-version|node|node-version|java|go|ruby|matlab|octave|rust|toolchain)$/i;
const SYSTEM = /^(os|platform|runner|runs-on)$/i;

/** The environments the workflows test, in words: the systems, the languages' versions, the
 *  containers. */
export function testedEnvironments(workflows: readonly Workflow[]): string[] {
  const systems = new Set<string>();
  const containers = new Set<string>();
  const versions = new Map<string, Set<string>>();
  for (const w of workflows) {
    for (const j of w.jobs) {
      for (const r of j.runsOn) if (!r.includes("${{")) systems.add(r);
      if (j.container) containers.add(j.container);
      for (const a of j.matrix) {
        if (SYSTEM.test(a.key)) a.values.forEach((v) => systems.add(v));
        else if (LANGUAGE.test(a.key)) {
          const key = a.key.replace(/-version$/i, "").toLowerCase();
          const set = versions.get(key) ?? new Set<string>();
          a.values.forEach((v) => set.add(v));
          versions.set(key, set);
        }
      }
    }
  }
  const out: string[] = [];
  if (systems.size) out.push(`Systems: ${[...systems].join(", ")}.`);
  for (const [k, vs] of versions) out.push(`${k.charAt(0).toUpperCase()}${k.slice(1)}: ${[...vs].join(", ")}.`);
  if (containers.size) out.push(`Containers: ${[...containers].join(", ")}.`);
  return out;
}

// ─── the views ───────────────────────────────────────────────────────────────

const LEVEL_WORDS: Readonly<Record<Finding["level"], string>> = { failure: "failed", warning: "to look at", notice: "a note", ok: "passed" };
const toneOf = (l: Finding["level"]) => (l === "ok" ? "ok" : l === "failure" || l === "warning" ? "warning" : "");

/** The registry's checks at a commit, one line each: the check, its level, what was found, the way
 *  out. */
export function findingsView(report: Report): El {
  return h(
    "section",
    { class: "checks-report" },
    h("h3", null, "What the registry's checks found"),
    h("p", { class: report.conclusion === "success" ? "ok" : "warning" }, `${report.title}.`),
    h(
      "ul",
      { class: "findings" },
      report.findings.map((f) =>
        h("li", { class: toneOf(f.level) }, h("strong", null, `${CHECK_WORDS[f.id]}: ${LEVEL_WORDS[f.level]}.`), ` ${f.words}`, f.fix ? h("span", { class: "fix" }, ` ${f.fix}`) : null),
      ),
    ),
    h("p", { class: "explain" }, "These checks read the repository's files as text: the licence, the environment files, CITATION.cff, the README, the tree's listing. They never run its code."),
  );
}

/** The researcher's own CI at a commit, as GitHub reports it: check runs and commit statuses. */
export function ciView(runs: readonly T.CheckRun[], status: T.CombinedStatus | null, sourceCommit: string): El {
  const sum = checksSummary(runs, status);
  const items: El[] = [
    ...runs.map((r) => {
      const w = checkWords(r);
      return h("li", { class: w.tone }, w.text, r.output.title ? ` — ${r.output.title}` : "", r.output.annotations ? ` (${r.output.annotations} ${r.output.annotations === 1 ? "annotation" : "annotations"})` : "");
    }),
    ...(status?.statuses ?? []).map((s) => {
      const w = statusWords(s);
      return h("li", { class: w.tone }, w.text);
    }),
  ];
  return h(
    "section",
    { class: "checks-ci" },
    h("h3", null, "The repository's own tests"),
    h("p", { class: sum.failed ? "warning" : sum.total && !sum.running ? "ok" : "" }, sum.total ? `${sum.passed} passed, ${sum.failed} failed, ${sum.running} running, ${sum.skipped} skipped or neutral.` : "No test reported at this commit: the repository runs none, or they have not run on it."),
    items.length ? h("ul", { class: "checks" }, items) : null,
    h(
      "p",
      { class: "explain" },
      "The repository's tests run on its own GitHub Actions (free on public repositories); the registry shows what they report and never runs code. The logs stay with GitHub, which asks for a sign-in to download them: ",
      link(sourceCommit, "this commit's checks, at the source"),
      ".",
    ),
  );
}

export interface PostedStatus {
  context: string;
  state: "error" | "failure" | "pending" | "success";
  description: string;
  target_url: string | null;
  by: string;
  via: "token" | "oidc";
  at: string;
}

/** The statuses outside services posted to the registry on a commit. */
export function postedView(answer: { state: string | null; statuses: PostedStatus[] } | null, signedIn: boolean): El {
  const out: Child[] = [h("h3", null, "Statuses posted to the registry")];
  if (!signedIn) out.push(h("p", null, "Sign in to see the statuses outside services (a lab's CI, a reproduction service) posted on this commit."));
  else if (!answer) out.push(h("p", null, "The registry could not be asked: try again later."));
  else if (!answer.statuses.length) out.push(h("p", null, "None: no outside service posted a status on this commit. ", link("/developers/#statuses", "How to post one"), "."));
  else {
    out.push(
      h(
        "ul",
        { class: "checks" },
        answer.statuses.map((s) => {
          const w = statusWords({ context: s.context, state: s.state, description: s.description, targetUrl: s.target_url });
          return h("li", { class: w.tone }, w.text, ` — posted by ${s.by || "a service"}${s.via === "oidc" ? " (GitHub Actions, its own token)" : ""}, ${s.at.slice(0, 10)}`, s.target_url ? [" · ", link(s.target_url, "its page")] : null);
        }),
      ),
    );
  }
  return h("section", { class: "checks-posted" }, out);
}

/** The environments the workflows test, and each workflow in a line. */
export function workflowsView(workflows: readonly Workflow[]): El {
  if (!workflows.length) {
    return h("section", { class: "checks-env" }, h("h3", null, "Tested environments"), h("p", null, "No GitHub Actions workflow in this commit: the repository's tests, if any, run elsewhere."));
  }
  return h(
    "section",
    { class: "checks-env" },
    h("h3", null, "Tested environments"),
    ...testedEnvironments(workflows).map((line) => h("p", null, line)),
    h(
      "ul",
      null,
      workflows.map((w) =>
        h("li", null, h("strong", null, w.name), ` (${w.path}): started by ${w.triggers.join(", ") || "nothing it says"}; ${w.jobs.length} ${w.jobs.length === 1 ? "job" : "jobs"}${w.jobs.length ? ` — ${w.jobs.map((j) => j.name).join(", ")}` : ""}.`),
      ),
    ),
    h("p", { class: "explain" }, "Read from the workflow files as text: what they ask to run on, never run here."),
  );
}

/** The commits the papers' tracing maps cite, for "checks at the paper's commit". */
export function citedCommits(maps: readonly { paper: string; title: string; doi: string; commit: string }[]): { paper: string; title: string; commit: string }[] {
  const seen = new Set<string>();
  const out: { paper: string; title: string; commit: string }[] = [];
  for (const m of maps) {
    if (!/^[0-9a-f]{40}$/.test(m.commit) || seen.has(`${m.doi}\n${m.commit}`)) continue;
    seen.add(`${m.doi}\n${m.commit}`);
    out.push({ paper: m.paper, title: m.title || m.doi, commit: m.commit });
  }
  return out;
}
