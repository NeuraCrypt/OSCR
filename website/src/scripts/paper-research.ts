// The paper's research issues on its page (night phase 05, E6): Discussion (code errors, code–paper
// mismatches) and Reproductions (reproduction failures). Signed out, from the nightly layer shards of
// the paper's GitHub repositories (/forge/layer/NN.json, "as of last night": 0 Worker requests);
// signed in, live (GET /api/forge/research?paper=…, 1 request), code hosted elsewhere included.
// Pinned research issues come first, as "known issues". Text nodes only; it never names the platform.

import type { IssueSummary } from "../../worker/forge/service/research-core.ts";
import { layerShard } from "../lib/forge.ts";
import { issueRow, parseSummaries } from "../lib/issue-view.ts";
import { fromResearch, sortIssues } from "../lib/issues.ts";
import { h } from "../lib/repo-view.ts";
import { show } from "./dom.ts";

const HINT = "__Host-oscr_signed_in=1";

async function nightly(paper: string, repos: string[]): Promise<IssueSummary[]> {
  const out = new Map<number, IssueSummary>();
  for (const path of repos.slice(0, 5)) {
    const [owner, name] = path.split("/");
    if (!owner || !name) continue;
    try {
      const res = await fetch(`/forge/layer/${await layerShard(owner, name)}.json`, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const shard = (await res.json()) as Record<string, { research?: unknown }>;
      for (const s of parseSummaries(shard[path.toLowerCase()]?.research)) if (s.paper === paper) out.set(s.id, s);
    } catch {
      // a shard missing: nothing from it
    }
  }
  return [...out.values()];
}

async function live(paper: string): Promise<IssueSummary[] | null> {
  try {
    const res = await fetch(`/api/forge/research?paper=${encodeURIComponent(paper)}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return parseSummaries(((await res.json()) as { issues?: unknown }).issues);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const section = document.getElementById("discussion");
  const doi = section?.dataset.doi;
  if (!section || !doi) return;
  const paper = `doi:${doi.toLowerCase()}`;
  const repos = (section.dataset.repos ?? "").split(",").filter(Boolean);
  const signedIn = document.cookie.split(/;\s*/).includes(HINT);
  let items = signedIn ? await live(paper) : null;
  const asOfLastNight = items === null;
  if (items === null) items = await nightly(paper, repos);
  const plan = { sort: "created" as const, direction: "desc" as const, reaction: null };
  const placeholder = { owner: "x", name: "x" };
  for (const kind of ["discussion", "reproductions"] as const) {
    const slot = document.querySelector<HTMLElement>(`.research-list[data-kind="${kind}"]`);
    if (!slot) continue;
    const mine = sortIssues(items.filter((s) => (kind === "reproductions" ? s.type === "reproduction" : s.type !== "reproduction")).map(fromResearch), plan);
    if (!mine.length) {
      show(slot, h("p", { class: "line" }, asOfLastNight ? "None as of last night." : "None yet."));
      continue;
    }
    const known = mine.filter((i) => i.pinned && i.state === "open").length;
    show(
      slot,
      known ? h("p", { class: "line" }, `${known === 1 ? "One known issue" : `${known} known issues`}, pinned by the paper's authors or the code's maintainers, first.`) : null,
      h("ul", { class: "issue-list" }, ...mine.slice(0, 30).map((i) => issueRow(placeholder, i, { asOfLastNight }))),
      mine.length > 30 ? h("p", { class: "line" }, h("a", { href: `/research/?paper=${encodeURIComponent(paper)}` }, `All ${mine.length}`)) : null,
    );
  }
}

if (typeof document !== "undefined") void main();
