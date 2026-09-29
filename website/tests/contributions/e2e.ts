// The contributions end to end (Phase 6, docs/CONTRIBUTIONS.md), on this machine: the Worker in
// `wrangler dev --env local` with its local D1 (the accounts' run, tests/account/e2e.ts, went first:
// Ada and Ben have accounts), the mock providers, doi.org and the forges under /checks/, and the
// Zenodo sandbox under /zenodo/ (tests/account/mock-server.ts). Real HTTP, real cookies, and D1's own
// count of the rows each request writes (ACCOUNT_DEV_METRICS=1). In three steps, with the Mac's job
// runner between them (tests/account/e2e.sh):
//
//   node --experimental-strip-types tests/contributions/e2e.ts ask       the requests, from the site
//   (oscr jobs poll --local; oscr claims accept …; oscr reports reject …)
//   node --experimental-strip-types tests/contributions/e2e.ts answers   what the site shows then; publish
//   (oscr jobs poll --local; oscr submissions accept …)
//   node --experimental-strip-types tests/contributions/e2e.ts published
//
// The browsers' cookies are kept between the steps in $JARS. Exits 1 on a failure.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const SITE = process.env.SITE ?? "http://localhost:8788";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9480";
const JARS = process.env.JARS ?? "/tmp/oscr-e2e-jars.json";
const FIXTURE = process.env.FIXTURE ?? new URL("../../../tests/fixtures/public-catalog/", import.meta.url).pathname;
const step = process.argv[2] ?? "ask";

const ADA = "0000-0000-0000-001X";
const P1 = "doi:10.5555/oscr.fixture.1";
const P2 = "doi:10.5555/oscr.fixture.2";
const P3 = "doi:10.5555/oscr.fixture.3";
const NEW_DOI = "10.5555/oscr.fixture.7";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

async function control(settings: unknown): Promise<void> {
  const res = await fetch(`${MOCK}/control`, { method: "POST", body: JSON.stringify(settings) });
  if (!res.ok) throw new Error(`mock control answered ${res.status}`);
}

type Cost = { written: number; read: number; queries: number };
const costs: [string, Cost][] = [];
const cost = (): Cost => ({ written: 0, read: 0, queries: 0 });
const jars: Record<string, Record<string, string>> = existsSync(JARS) ? JSON.parse(readFileSync(JARS, "utf8")) : {};

class Client {
  name: string;
  jar: Map<string, string>;
  constructor(name: string) {
    this.name = name;
    this.jar = new Map(Object.entries(jars[name] ?? {}));
  }

  save(): void {
    jars[this.name] = Object.fromEntries(this.jar);
    writeFileSync(JARS, JSON.stringify(jars));
  }

  private keep(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attributes] = c.split(";");
      const i = pair.indexOf("=");
      const maxAge = attributes.map((a) => a.trim()).find((a) => /^Max-Age=/i.test(a));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.jar.delete(pair.slice(0, i).trim());
      else this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(url: string, init: RequestInit = {}, c?: Cost): Promise<Response> {
    const headers = new Headers(init.headers);
    const ours = url.startsWith(SITE);
    if (ours && this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (ours) {
      this.keep(res);
      if (c) {
        c.written += Number(res.headers.get("X-D1-Rows-Written") ?? 0);
        c.read += Number(res.headers.get("X-D1-Rows-Read") ?? 0);
        c.queries += Number(res.headers.get("X-D1-Queries") ?? 0);
      }
    }
    return res;
  }

  async navigate(url: string, c: Cost = cost()): Promise<URL> {
    let current = url;
    for (let hops = 0; hops < 10; hops++) {
      const res = await this.request(current, {}, c);
      const location = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return new URL(current);
    }
    throw new Error(`too many redirects from ${url}`);
  }

  // deno-lint-ignore no-explicit-any
  async get(path: string, c?: Cost): Promise<Record<string, any>> {
    return (await this.request(`${SITE}${path}`, { headers: { Accept: "application/json" } }, c)).json();
  }

  // deno-lint-ignore no-explicit-any
  async post(path: string, body: unknown, c: Cost = cost()): Promise<{ status: number; data: Record<string, any> }> {
    const csrf = (await this.get("/api/account/me")).csrf as string;
    const res = await this.request(
      `${SITE}${path}`,
      { method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(SITE).origin, "X-CSRF-Token": csrf }, body: body === undefined ? undefined : JSON.stringify(body) },
      c,
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
}

/** The map's digest as paper 1's page carries it (the fixture's export, oscr/paperpage.py). */
function digestOf(paper: string): string {
  // Every lot the export wrote (oscr/catalog.py N_LOTS, 256 since 2026-09-29).
  const folder = `${FIXTURE}papers/`;
  for (const name of existsSync(folder) ? readdirSync(folder).filter((f) => /^\d+\.json$/.test(f)) : []) {
    const path = `${folder}${name}`;
    const lot = JSON.parse(readFileSync(path, "utf8")) as Record<string, { map?: { digest?: string } }>;
    if (lot[paper]) return lot[paper].map?.digest ?? "";
  }
  return "";
}

const ada = new Client("ada");
const ben = new Client("ben");

async function signIn(who: Client, provider: string, identity: unknown, back: string): Promise<URL> {
  await control({ who: identity });
  return who.navigate(`${SITE}/api/auth/${provider}/start?return=${back}`);
}

if (step === "ask") {
  await control({
    places: { dois: [NEW_DOI], pages: { "https://github.com/oscr-fixture/new-code": 200, "https://zenodo.org/records/1234567": 200 } },
  });
  // Ada, back with ORCID from a paper's page: its Contribute section asks the Worker once.
  let landed = await signIn(ada, "orcid", { orcid: { sub: ADA, name: "Ada Fixture" } }, "/paper/doi_10.5555_oscr.fixture.1/");
  check("sign-in from a paper's page comes back to it", landed.pathname === "/paper/doi_10.5555_oscr.fixture.1/" && landed.searchParams.get("signed_in") === "orcid", landed.toString());
  check("the hint cookie is set with the session", ada.jar.get("__Host-oscr_signed_in") === "1");
  let c = cost();
  const state = await ada.get(`/api/contributions/paper?id=${encodeURIComponent(P1)}`, c);
  costs.push(["a paper's page, signed in (GET /api/contributions/paper)", c]);
  check("the paper's page: a verified author, maintainer of its code", state.author === true && state.maintains?.includes("github.com/oscr-fixture/eeg-analysis"), state);

  c = cost();
  let r = await ada.post("/api/submissions", { doi: `https://doi.org/${NEW_DOI}`, code_urls: ["https://github.com/oscr-fixture/new-code"], note: "Our code." }, c);
  costs.push(["submission (checked: the DOI, one link)", c]);
  check("submission: queued after the checks", r.status === 201 && r.data.submission?.checks?.doi === "ok" && r.data.submission?.checks?.links?.[0]?.outcome === "ok", r.data);
  c = cost();
  r = await ada.post("/api/submissions", { doi: NEW_DOI, code_urls: ["https://github.com/oscr-fixture/new-code"] }, c);
  costs.push(["submission refused (already submitted)", c]);
  check("the same DOI again: 409", r.status === 409 && r.data.error?.code === "already_submitted");
  r = await ada.post("/api/submissions", { doi: "10.5555/not.registered", code_urls: ["https://github.com/oscr-fixture/new-code"] });
  check("an unregistered DOI: 422", r.status === 422 && r.data.error?.code === "unknown_doi", r.data);

  // A correction of paper 3 (paper 1's map is validated below: a correction of paper 1 first would
  // change its map, and the Mac would then refuse to deposit the map the page showed).
  c = cost();
  r = await ada.post(
    "/api/edits",
    { paper_id: P3, changes: [{ op: "add", url: "https://zenodo.org/records/1234567", role: "code" }], note: "The code, archived." },
    c,
  );
  costs.push(["correction (checked: one link added)", c]);
  check("correction: queued", r.status === 202 && r.data.edit?.as_role === "verified_author", r.data);

  const digest = digestOf(P1);
  c = cost();
  r = await ada.post("/api/validations", { paper_id: P1, map_digest: digest }, c);
  costs.push(["validation of the map", c]);
  check("validation: queued, with Ada's ORCID iD, a test while ORCID is the sandbox", r.status === 202 && r.data.validation?.orcid === ADA && r.data.validation?.proof === "orcid-sandbox", r.data);
  ada.save();

  // Ben, with GitHub: an author the metadata does not name claims paper 2; he asks to remove paper 3.
  landed = await signIn(ben, "github", { github: { id: 5150001, login: "ben-example", name: "Ben Example" } }, "/paper/doi_10.5555_oscr.fixture.2/");
  check("Ben signed in with GitHub", landed.searchParams.get("signed_in") === "github", landed.toString());
  c = cost();
  r = await ben.post("/api/claims", { paper_id: P2, statement: "I am the paper's first author; my ORCID iD is missing from its metadata.", link: "https://lab.example/ben" }, c);
  costs.push(["manual author claim (new)", c]);
  check("manual claim: pending", r.status === 202 && r.data.status === "pending", r.data);
  c = cost();
  r = await ben.post("/api/claims", { paper_id: P2, statement: "First author, see the lab's page." }, c);
  costs.push(["manual author claim (asked again)", c]);
  c = cost();
  const removal = {
    paper_id: P3, role: "other", scope: "record", reason: "incorrect", details: "The record's links are not this paper's.",
    evidence_url: "", confirm_accurate: true, confirm_review: true,
  };
  r = await ben.post("/api/reports", removal, c);
  costs.push(["removal request (new)", c]);
  check("removal request: open", r.status === 202 && r.data.status === "open", r.data);
  c = cost();
  r = await ben.post("/api/reports", { ...removal, details: "The record's links are not this paper's (all of them)." }, c);
  costs.push(["removal request (asked again)", c]);
  check("asked again: updated", r.status === 200 && r.data.updated === true, r.data);
  r = await ben.post("/api/edits", { paper_id: P1, changes: [{ op: "remove", repo: "github.com/oscr-fixture/eeg-analysis" }] });
  check("a correction by someone who is not an author: 403", r.status === 403, r.data);
  ben.save();

  c = cost();
  const mine = await ada.get("/api/contributions", c);
  costs.push(["the account page's lists (GET /api/contributions)", c]);
  check("the account page lists them", mine.submissions?.length === 1 && mine.edits?.length === 1 && mine.validations?.length === 1, [mine.submissions?.length, mine.edits?.length, mine.validations?.length]);
  check("nothing of it holds an at sign", !JSON.stringify(mine).includes("@"));
  const log = await (await fetch(`${MOCK}/control/log`)).json() as { checks: { method: string; url: string }[] };
  check(
    "the checks asked only doi.org and the known places",
    log.checks.every((x) => /^https:\/\/(doi\.org\/api\/handles\/|github\.com\/|zenodo\.org\/records\/)/.test(x.url)),
    log.checks.map((x) => `${x.method} ${x.url}`),
  );
} else if (step === "answers") {
  const mine = await ada.get("/api/contributions");
  const sub = mine.submissions?.[0];
  check("the Mac's draft is back", sub?.status === "draft" && sub?.draft?.paper?.doi === NEW_DOI, sub);
  check("the draft lists the submitted link", sub?.draft?.links?.some((l: { key: string; source: string }) => l.key === "github.com/oscr-fixture/new-code" && l.source === "you"), sub?.draft);
  const edit = mine.edits?.[0];
  check("the correction was applied as a new version", edit?.status === "applied" && typeof edit?.version === "number", edit);
  const v = mine.validations?.[0];
  check("the map was deposited on the (mock) Zenodo sandbox", v?.status === "deposited" && v?.instance === "sandbox" && /^10\.5072\/zenodo\.\d+$/.test(v?.doi ?? ""), v);
  const deposits = (await (await fetch(`${MOCK}/control/zenodo`)).json()) as { metadata: { creators: { person_or_org: { identifiers?: { identifier: string }[] } }[] } }[];
  check(
    "the deposit's creators carry Ada's ORCID iD",
    deposits.some((d) => d.metadata.creators.some((c) => c.person_or_org.identifiers?.some((i) => i.identifier === ADA))),
    deposits.map((d) => d.metadata.creators),
  );
  const benState = await ben.get(`/api/contributions/paper?id=${encodeURIComponent(P2)}`);
  check("the owner accepted Ben's claim: a verified author of paper 2", benState.author === true && benState.claim?.status === "verified", benState);
  const report = (await ben.get(`/api/contributions/paper?id=${encodeURIComponent(P3)}`)).report;
  check("the owner refused the removal, in words", report?.status === "rejected" && report?.message === "The record is correct.", report);
  // Ben, now a verified author, corrects his paper's record.
  let r = await ben.post("/api/edits", { paper_id: P2, changes: [{ op: "role", repo: "github.com/oscr-fixture/unlicensed", role: "code" }] });
  check("a verified author by the owner's decision corrects the record", r.status === 202, r.data);
  // Ada publishes her draft: the offline harvest found no author list, so a moderator looks at it.
  const c = cost();
  r = await ada.post(`/api/submissions/${sub?.id}/publish`, undefined, c);
  costs.push(["publication of a draft", c]);
  check("published: waits for the owner (the paper's authors were not read offline)", r.status === 200 && r.data.status === "moderation", r.data);
  ada.save();
  ben.save();
} else {
  const sub = (await ada.get("/api/contributions")).submissions?.[0];
  check("the owner published the submission", sub?.status === "published", sub);
  const edits = (await ben.get("/api/contributions")).edits ?? [];
  check("Ben's correction answered", edits[0]?.status === "applied" || edits[0]?.status === "refused", edits[0]);
}

if (costs.length) {
  console.log("\nD1, as it counts (rows written / rows read / queries):");
  for (const [what, k] of costs) console.log(`  ${String(k.written).padStart(3)} / ${String(k.read).padStart(3)} / ${String(k.queries).padStart(2)}  ${what}`);
}
console.log(failures ? `\n${failures} check(s) failed` : `\nstep ${step}: every check passed`);
process.exit(failures ? 1 : 0);
