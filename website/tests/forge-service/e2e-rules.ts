// Night phase 16's end-to-end checks (docs/MODERATION.md "Local end-to-end run"), after e2e.ts, on the
// same Worker and databases, in three stages that e2e.sh runs with three Worker environments:
//
//   closed  FORGE_OPEN unset, Turnstile's always-passing test secret: a report without an account
//           (refused without the widget's token, taken with it), the owner's queue (the owner's only),
//           the comment hidden from it and hidden for others (its author and the owner still read it),
//           Bob's research issue refused (forge_closed)
//   open    FORGE_OPEN=true: Bob's research issue taken (a non-owner's write, under the caps), his comment
//           behind the check (refused without the token); Ada blocks Bob from his comment: his comment
//           and his reaction refused; unblocked; an interaction limit set, checked, lifted
//   fail    Turnstile's always-failing test secret: every check fails (a report, a research issue)
//
//   SITE=… MOCK=… FAKE=… REPO_ID=… node --experimental-strip-types tests/forge-service/e2e-rules.ts <stage>
//
// Not a unit test: it needs the servers of e2e.sh. Prints each check; exits 1 on a failure.
import { createHash } from "node:crypto";

const SITE = process.env.SITE ?? "http://localhost:8791";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9491";
const FAKE = process.env.FAKE ?? "http://127.0.0.1:9490";
const REPO_ID = process.env.REPO_ID ?? "";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const stage = process.argv[2] ?? "";

type Json = Record<string, any>; // deno-lint-ignore no-explicit-any

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

/** A browser over real HTTP: a cookie jar, redirects followed by hand. */
class Client {
  jar = new Map<string, string>();

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (url.startsWith(SITE) && this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (url.startsWith(SITE)) {
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attributes] = c.split(";");
        const i = pair.indexOf("=");
        const maxAge = attributes.map((a) => a.trim()).find((a) => /^Max-Age=/i.test(a));
        if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.jar.delete(pair.slice(0, i).trim());
        else this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    }
    return res;
  }

  async navigate(url: string): Promise<URL> {
    let current = url;
    for (let hops = 0; hops < 10; hops++) {
      const res = await this.request(current);
      const location = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return new URL(current);
    }
    throw new Error(`too many redirects from ${url}`);
  }

  async get(path: string): Promise<{ status: number; data: Json }> {
    const res = await this.request(`${SITE}${path}`, { headers: { Accept: "application/json" } });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }

  /** A POST as the site's pages send it: the Origin, the session's CSRF token when signed in. */
  async post(path: string, body: unknown): Promise<{ status: number; data: Json }> {
    const me = (await this.get("/api/account/me")).data;
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: new URL(SITE).origin };
    if (typeof me.csrf === "string") headers["X-CSRF-Token"] = me.csrf;
    const res = await this.request(`${SITE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }

  /** The first half of an authorized action: start (refused before GitHub, or its location). */
  start(kind: string, payload: unknown): Promise<{ status: number; data: Json }> {
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return this.post("/api/forge/start", { kind, repo: { forge: "github", id: REPO_ID }, branch: null, expectedHead: null, digest, back: "/r/oscr-fixture/eeg-analysis/" });
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

const bobsIssue = { paper: "10.5555/oscr.fixture.1", repo: { forge: "github", id: REPO_ID, path: "oscr-fixture/eeg-analysis" }, type: "code_error", title: "The notch filter is at 60 Hz, the recording is European (e2e)", body: "Line 12 of analysis.py." };

if (stage === "closed") {
  const ada = await signIn("ada");
  const issue = (await ada.get("/api/forge/research?id=1")).data;
  const n = Number(issue.comments?.[0]?.n ?? 0);
  check("the research issue #1 has Ada's comment to report", n >= 1, issue.comments?.length);
  const anon = new Client();
  const noToken = await anon.post("/api/forge/report", { target: `research:1#${n}`, reason: "abuse", details: "Insulting; see x@example.org", turnstile: "" });
  check("a report without an account and without the widget's token: 403 human_check", noToken.status === 403 && noToken.data.error?.code === "human_check", noToken);
  const reported = await anon.post("/api/forge/report", { target: `research:1#${n}`, reason: "abuse", details: "Insulting; see x@example.org", turnstile: TOKEN });
  check("a report without an account, Turnstile passed with Cloudflare's test key: 201", reported.status === 201, reported);
  const bob = await signIn("bob");
  const notHis = await bob.get("/api/forge/moderation");
  check("the queue is the owner's: Bob gets 403 owner_only", notHis.status === 403 && notHis.data.error?.code === "owner_only", notHis);
  const queue = (await ada.get("/api/forge/moderation")).data;
  const mine = ((queue.reports ?? []) as Json[]).find((r) => r.target === `research:1#${n}`);
  check("the owner's queue: the report, its words without the address, no reporter named", !!mine && mine.signedIn === false && /\[email hidden\]/.test(mine.details) && !/u_[A-Za-z0-9_-]{10,}/.test(JSON.stringify(queue)), mine);
  const hidden = await ada.post("/api/forge/moderation/decide", { op: "hide", target: `research:1#${n}`, reason: "abuse", report: mine?.id, message: "Please keep it about the code." });
  check("the owner hides the comment from the queue", hidden.status === 200, hidden);
  const seenByBob = (await bob.get("/api/forge/research?id=1")).data;
  const c = ((seenByBob.comments ?? []) as Json[]).find((x) => x.n === n);
  check("hidden for others: Bob reads no word of it, only why", !!c && c.body === "" && c.moderated?.reason === "abuse", c);
  const seenByAda = ((await ada.get("/api/forge/research?id=1")).data.comments as Json[]).find((x) => x.n === n);
  check("its author (and the owner) still read it, with the notice", !!seenByAda && seenByAda.body !== "" && seenByAda.moderated?.reason === "abuse", seenByAda);
  const after = (await ada.get("/api/forge/moderation")).data;
  check("the report left the queue (actioned)", !((after.reports ?? []) as Json[]).some((r) => r.target === `research:1#${n}`), after.reports);
  const closed = await bob.post("/api/forge/research/open", { ...bobsIssue, turnstile: TOKEN });
  check("FORGE_OPEN unset: Bob's research issue is refused (403 forge_closed)", closed.status === 403 && closed.data.error?.code === "forge_closed", closed);
} else if (stage === "open") {
  const bob = await signIn("bob");
  const opened = await bob.post("/api/forge/research/open", { ...bobsIssue, turnstile: TOKEN });
  check("FORGE_OPEN=true: Bob's research issue is taken (a non-owner's write, under the caps)", opened.status === 201, opened);
  const withoutCheck = await bob.post("/api/forge/research/comment", { id: 1, body: "Is the notch at 50 Hz?", turnstile: "" });
  check("his comment without the widget's token: 403 human_check", withoutCheck.status === 403 && withoutCheck.data.error?.code === "human_check", withoutCheck);
  const commented = await bob.post("/api/forge/research/comment", { id: 1, body: "Is the notch at 50 Hz?", turnstile: TOKEN });
  check("his comment with it: taken", commented.status === 200, commented);
  const bobsN = Math.max(...((((await bob.get("/api/forge/research?id=1")).data.comments ?? []) as Json[]).filter((x) => x.mine).map((x) => Number(x.n))));
  const ada = await signIn("ada");
  const blocked = await ada.post("/api/forge/blocks/write", { target: `research:1#${bobsN}`, on: true, note: "e2e" });
  check("Ada blocks Bob from his comment", blocked.status === 200, blocked);
  const list = (await ada.get("/api/forge/blocks")).data;
  check("her blocked list names him by his handle, with her note", list.blocks?.[0]?.label === "bob-fixture" && list.blocks?.[0]?.note === "e2e", list);
  const refused = await bob.post("/api/forge/research/comment", { id: 1, body: "Hello?", turnstile: TOKEN });
  check("blocked: Bob's comment is refused (403 blocked), and the refusal names no one", refused.status === 403 && refused.data.error?.code === "blocked" && !/ada/i.test(String(refused.data.error?.message)), refused);
  const reaction = await bob.start("issue_react", { number: 1, content: "+1" });
  check("blocked: Bob's reaction on Ada's repository is refused at start (403 blocked), before GitHub", reaction.status === 403 && reaction.data.error?.code === "blocked", reaction);
  const unblocked = await ada.post("/api/forge/blocks/write", { ref: list.blocks?.[0]?.ref, on: false });
  check("Ada unblocks him", unblocked.status === 200, unblocked);
  const limited = await ada.post("/api/forge/limits/write", { scope: `repo:github:${REPO_ID}`, level: "managers", duration: "1w" });
  check("Ada limits her repository to its managers for a week", limited.status === 200 && typeof limited.data.until === "number", limited);
  const inForce = (await bob.get(`/api/forge/limits?repo=github:${REPO_ID}`)).data;
  check("the limit in force, as Bob reads it", inForce.inForce?.level === "managers" && inForce.can?.manage === false, inForce);
  const kept = await bob.post("/api/forge/research/open", { ...bobsIssue, title: "Another (e2e)", turnstile: TOKEN });
  check("limited: Bob's research issue on it is refused (403 limited)", kept.status === 403 && kept.data.error?.code === "limited", kept);
  const lifted = await ada.post("/api/forge/limits/write", { scope: `repo:github:${REPO_ID}`, level: null });
  check("lifted", lifted.status === 200, lifted);
  const again = await bob.post("/api/forge/research/open", { ...bobsIssue, title: "Another (e2e)", turnstile: TOKEN });
  check("lifted: Bob's research issue is taken", again.status === 201, again);
} else if (stage === "fail") {
  const anon = new Client();
  const report = await anon.post("/api/forge/report", { target: "research:1", reason: "spam", turnstile: TOKEN });
  check("Turnstile's always-failing test secret: a report is refused (403 human_check)", report.status === 403 && report.data.error?.code === "human_check", report);
  const bob = await signIn("bob");
  const opened = await bob.post("/api/forge/research/open", { ...bobsIssue, title: "Refused (e2e)", turnstile: TOKEN });
  check("and so is Bob's research issue (403 human_check)", opened.status === 403 && opened.data.error?.code === "human_check", opened);
} else {
  console.log("stage: closed, open or fail");
  process.exit(2);
}

console.log(failures ? `${failures} check(s) failed` : "every check passed");
process.exit(failures ? 1 : 0);
