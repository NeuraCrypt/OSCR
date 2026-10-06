// checks/<ref>: the checks of a commit, in the registry (night phase 10, E5; docs/AUTOMATION.md). The
// pull requests' check run links here (its details page), and so do the papers' cited commits:
// "checks at the paper's commit".
//
// Read in the reader's browser, on the reader's own quota: the ref (0–1 request), the tree (1), the
// licence, CITATION.cff, the README and the workflow files raw (not counted), the researcher's CI as
// GitHub reports it (check runs and the combined status: 2 requests); the papers' maps from the static
// shard (a file of this site). Signed in, the statuses outside services posted to the registry (GET
// /api/forge/statuses: 1 Worker request). The registry's checks (worker/forge/checks-core.ts) read
// files as text and never run the code; the logs of the researcher's CI stay with GitHub, which asks a
// sign-in to download them: the only link to it, said so. Like every browser script, it never names
// the platform.

import { runChecks, checkFiles, CHECK_TEXT_BYTES } from "../../worker/forge/checks-core.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { citedCommits, ciView, findingsView, postedView, readWorkflow, workflowPaths, workflowsView, type PostedStatus, type Workflow } from "../lib/checks-view.ts";
import { githubLinks, refSegments } from "../lib/code-nav.ts";
import { repoPath } from "../lib/forge.ts";
import { h, link } from "../lib/repo-view.ts";
import { show } from "./dom.ts";
import { signedInHint } from "./pull-common.ts";
import { codeViews, failed, repoRef, resolveRef, type CodeEnv } from "./repo-code.ts";
import { mapsOf } from "./repo-traced.ts";

/** A file read raw as text, or null (missing, binary, too large, an LFS pointer). */
async function textAt(env: CodeEnv, commit: string, path: string): Promise<string | null> {
  try {
    const f = await env.session.git.readFile(repoRef(env), commit, path, { maxBytes: CHECK_TEXT_BYTES });
    return f.binary || f.lfs ? null : utf8Text(f.bytes);
  } catch {
    return null;
  }
}

async function posted(env: CodeEnv, commit: string): Promise<{ state: string | null; statuses: PostedStatus[] } | null> {
  const id = env.layer?.id ?? env.info.key.id;
  try {
    const r = await fetch(`/api/forge/statuses?id=${encodeURIComponent(`${env.info.key.forge}:${id}`)}&sha=${commit}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (r.status === 404) return { state: null, statuses: [] };
    if (!r.ok) return null;
    return (await r.json()) as { state: string | null; statuses: PostedStatus[] };
  } catch {
    return null;
  }
}

codeViews.checks = async (slot, env) => {
  const segments = env.target.rest?.length ? env.target.rest : env.info.defaultBranch ? refSegments(env.info.defaultBranch) : [];
  if (!segments.length) {
    show(slot, h("h2", null, "Checks"), h("p", null, "The repository is empty: nothing to check yet."));
    return;
  }
  let commit: string;
  let label: string;
  try {
    const r = await resolveRef(env, segments);
    commit = r.commit;
    label = r.ref.ref === commit ? commit.slice(0, 7) : `${r.ref.ref} (${commit.slice(0, 7)})`;
  } catch (e) {
    failed(slot, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}`, "files");
    return;
  }
  const maps = await mapsOf(env);
  const cited = citedCommits(maps);
  show(
    slot,
    h("div", { class: "code-head" }, h("h2", null, `Checks at ${label}`), h("p", { class: "file-actions" }, link(repoPath(env.repo, "commit", [commit]), "The commit"), " · ", link(repoPath(env.repo, "environment", [commit]), "Its environment"))),
    cited.length
      ? h(
          "p",
          null,
          "At the commits the papers cite: ",
          ...cited.flatMap((c, i) => [i ? "; " : "", link(repoPath(env.repo, "checks", [c.commit]), `${c.title} (${c.commit.slice(0, 7)})`)]),
          ".",
        )
      : null,
    h("div", { id: "checks-report", "aria-live": "polite" }, h("p", null, "Reading the files…")),
    h("div", { id: "checks-ci", "aria-live": "polite" }, h("p", null, "Reading the repository's tests…")),
    h("div", { id: "checks-posted", "aria-live": "polite" }),
    h("div", { id: "checks-env", "aria-live": "polite" }),
  );
  const ref = repoRef(env);
  const report = slot.querySelector<HTMLElement>("#checks-report");
  const ci = slot.querySelector<HTMLElement>("#checks-ci");
  const post = slot.querySelector<HTMLElement>("#checks-posted");
  const envBox = slot.querySelector<HTMLElement>("#checks-env");

  // The registry's checks, and the environments the workflows test: the tree, then raw files.
  let tree: T.Tree | null = null;
  try {
    tree = await env.session.git.tree(ref, commit, { recursive: true });
  } catch (e) {
    if (report) failed(report, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/tree/${commit}`, "files");
  }
  if (tree && report) {
    const entries = tree.entries.map((e) => ({ path: e.path, type: e.type, size: e.size }));
    const paths = entries.filter((e) => e.type === "blob").map((e) => e.path);
    const texts: Record<string, string | null> = {};
    for (const p of Object.values(checkFiles(paths))) if (p) texts[p] = await textAt(env, commit, p);
    const papers = (env.layer?.papers ?? []).map((p) => p.doi);
    const traced = maps.flatMap((m) => m.pairs.map((p) => ({ path: p.path, paper: m.doi, commit: m.commit })));
    show(report, findingsView(runChecks({ entries, truncated: tree.truncated, texts, papers, traced })));
    const workflows: Workflow[] = [];
    for (const p of workflowPaths(paths)) {
      const text = await textAt(env, commit, p);
      const w = text ? readWorkflow(p, text) : null;
      if (w) workflows.push(w);
    }
    if (envBox) show(envBox, workflowsView(workflows));
  }

  // The researcher's own CI, as GitHub reports it.
  if (ci) {
    try {
      const [runs, status] = await Promise.all([env.session.checks.runs(ref, commit, { perPage: 100 }), env.session.checks.status(ref, commit).catch(() => null)]);
      const source = `${githubLinks(env.endpoints.web).commit(ref, commit)}/checks`;
      show(ci, ciView(runs.items, status, source));
    } catch (e) {
      failed(ci, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/commit/${commit}/checks`, "checks");
    }
  }

  // The statuses posted to the registry: signed in only (a signed-out page asks the Worker nothing).
  if (post) {
    const signed = signedInHint();
    show(post, postedView(signed ? await posted(env, commit) : null, signed));
  }
};
