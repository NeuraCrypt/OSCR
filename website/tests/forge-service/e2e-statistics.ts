// Phase 12 (repository statistics) end to end, on this machine (night phase 12; docs/STATISTICS.md).
// Against the Worker started with FORGE_OPEN=true and a FAKE Cloudflare analytics source, and the
// statistics the shell stage seeded (repo_stats, repo_dependents, repo_marks for the fixture repo):
//   - GET /api/forge/stats returns the "Used by" counts (a paper counts) and a research mark, and the
//     insights time-series chart drawn from them carries that mark;
//   - a maintainer (Ada) sees aggregate traffic (views and visits, referrers, pages), with no
//     unique-visitor figure; a non-maintainer (Bob) is refused (403);
//   - the community checklist reflects a research-ready and a bare repository.
// Nothing is remote.
//
//   SITE=… MOCK=… FAKE=… REPO_ID=… node --experimental-strip-types tests/forge-service/e2e-statistics.ts

import { timeSeriesChart } from "../../src/lib/stats-view.ts";
import { communityChecklist, checklistScore } from "../../src/lib/community-view.ts";
import type { El } from "../../src/lib/repo-view.ts";

const SITE = process.env.SITE ?? "http://localhost:8791";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9491";
const FAKE = process.env.FAKE ?? "http://127.0.0.1:9490";
const REPO_ID = process.env.REPO_ID ?? "";
const ORIGIN = new URL(SITE).origin;

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

class Client {
  jar = new Map<string, string>();
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (url.startsWith(SITE) && this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (url.startsWith(SITE)) for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  }
  async navigate(url: string): Promise<URL> {
    let current = url;
    for (let hops = 0; hops < 10; hops++) {
      const res = await this.request(current);
      const loc = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).toString(); continue; }
      return new URL(current);
    }
    throw new Error("too many redirects");
  }
  async get(path: string): Promise<{ status: number; data: Json }> {
    const res = await this.request(`${SITE}${path}`, { headers: { Accept: "application/json" } });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }
}

const seed = (await (await fetch(`${FAKE}/control/seed`)).json()) as { ada: { id: string }; bob: { id: string } };
async function signIn(who: "ada" | "bob"): Promise<Client> {
  const person = who === "ada" ? { id: Number(seed.ada.id), login: "ada-fixture", name: "Ada Fixture" } : { id: Number(seed.bob.id), login: "bob-fixture", name: "Bob Fixture" };
  await fetch(`${MOCK}/control`, { method: "POST", body: JSON.stringify({ who: { github: person } }) });
  const c = new Client();
  const landed = await c.navigate(`${SITE}/api/auth/github/start?return=/account/`);
  check(`${who} signed in`, landed.pathname === "/account/", landed.toString());
  return c;
}

function find(node: string | El, tag: string): El[] {
  if (typeof node === "string") return [];
  const out: El[] = node.tag === tag ? [node] : [];
  for (const c of node.children) out.push(...find(c, tag));
  return out;
}

const ada = await signIn("ada");

// 1. "Used by" and the research marks.
const stats = await ada.get(`/api/forge/stats?id=github:${REPO_ID}`);
check("stats read", stats.status === 200, stats.status);
check("Used by counts a paper", stats.data.usedBy?.papers >= 1, stats.data.usedBy);
check("a paper dependant is listed", (stats.data.usedBy?.dependents ?? []).some((d: Json) => d.kind === "paper"), stats.data.usedBy?.dependents);
check("a research mark is present", (stats.data.marks ?? []).length >= 1, stats.data.marks);

// 2. The insights chart drawn from those facts carries the research mark.
const chart = timeSeriesChart({
  title: "Commits per week", series: [{ label: "Commits", points: [{ t: 1700000000, v: 3 }, { t: 1700604800, v: 5 }], area: true }],
  marks: (stats.data.marks ?? []).map((m: Json) => ({ t: m.t, kind: m.kind, label: m.label })),
});
const markLines = find(chart, "line").filter((l) => (l.attrs.class ?? "").includes("mark") && !(l.attrs.class ?? "").includes("axis"));
check("the chart shows the research mark", markLines.length >= 1 && find(chart, "svg").length === 1, markLines.length);

// 3. Traffic: a maintainer sees aggregates, a non-maintainer is refused.
const traffic = await ada.get(`/api/forge/traffic?id=github:${REPO_ID}`);
check("maintainer sees traffic", traffic.status === 200 && traffic.data.configured === true, traffic.status);
check("traffic has views and visits per day", (traffic.data.days ?? []).length >= 1 && typeof traffic.data.days?.[0]?.visits === "number", traffic.data.days);
check("traffic names referrers and pages", (traffic.data.referrers ?? []).length >= 1 && (traffic.data.pages ?? []).length >= 1, "");
check("traffic carries no unique-visitor figure", !JSON.stringify(traffic.data).toLowerCase().includes("unique"), "");

const bob = await signIn("bob");
const refused = await bob.get(`/api/forge/traffic?id=github:${REPO_ID}`);
check("a non-maintainer is refused traffic (403)", refused.status === 403, refused.status);

// 4. The community checklist.
const ready = checklistScore(communityChecklist({
  hasReadme: true, hasDescription: true, licence: { spdx: "MIT", redistributable: true },
  citation: { present: true, doi: true }, hasCodeOfConduct: true, hasContributing: true, hasSecurity: true, papers: 1, maps: 1,
}));
check("a research-ready repository passes every check", ready.done === ready.total, ready);
const bare = checklistScore(communityChecklist({
  hasReadme: false, hasDescription: false, licence: null, citation: { present: false, doi: false },
  hasCodeOfConduct: false, hasContributing: false, hasSecurity: false, papers: 0, maps: 0,
}));
check("a bare repository passes none", bare.done === 0, bare);

console.log(failures ? `\n${failures} check(s) failed` : "\nall statistics checks passed");
if (failures) process.exit(1);
