// The accounts end to end, on this machine (docs/ACCOUNTS.md, "Local end-to-end run"): the Worker in
// `wrangler dev --env local` with its local D1, the facts pushed there by
// `oscr community push --local` from the fixture's database, and the mock providers
// (mock-server.ts). Real HTTP, real redirects and cookies, and D1's own count of the rows each step
// writes (ACCOUNT_DEV_METRICS=1). Prints each check and the writes; exits 1 on a failure.
//
//   node --experimental-strip-types tests/account/e2e.ts
//
// Not a unit test (no .test.ts): it needs the two servers running.

const SITE = process.env.SITE ?? "http://localhost:8787";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9471";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? `, ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

async function control(settings: unknown): Promise<void> {
  const res = await fetch(`${MOCK}/control`, { method: "POST", body: JSON.stringify(settings) });
  if (!res.ok) throw new Error(`mock control answered ${res.status}`);
}

type Cost = { written: number; read: number; queries: number };
const costs: [string, Cost][] = [];

/** A browser over real HTTP: a cookie jar for the site, redirects followed by hand. */
class Client {
  jar = new Map<string, string>();

  private keep(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attributes] = c.split(";");
      const i = pair.indexOf("=");
      const maxAge = attributes.map((a) => a.trim()).find((a) => /^Max-Age=/i.test(a));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.jar.delete(pair.slice(0, i).trim());
      else this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(url: string, init: RequestInit = {}, cost?: Cost): Promise<Response> {
    const headers = new Headers(init.headers);
    const ours = url.startsWith(SITE);
    if (ours && this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (ours) {
      this.keep(res);
      if (cost) {
        cost.written += Number(res.headers.get("X-D1-Rows-Written") ?? 0);
        cost.read += Number(res.headers.get("X-D1-Rows-Read") ?? 0);
        cost.queries += Number(res.headers.get("X-D1-Queries") ?? 0);
      }
    }
    return res;
  }

  /** A navigation, redirects included, across the site and the providers. */
  async navigate(url: string, cost: Cost = { written: 0, read: 0, queries: 0 }): Promise<URL> {
    let current = url;
    for (let hops = 0; hops < 10; hops++) {
      const res = await this.request(current, {}, cost);
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
  async me(cost?: Cost): Promise<Record<string, any>> {
    return (await this.request(`${SITE}/api/account/me`, { headers: { Accept: "application/json" } }, cost)).json();
  }

  async post(path: string, body: unknown, cost: Cost): Promise<{ status: number; data: Record<string, unknown> }> {
    const csrf = (await this.me()).csrf as string;
    const res = await this.request(
      `${SITE}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: new URL(SITE).origin, "X-CSRF-Token": csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      cost,
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
}

const cost = (): Cost => ({ written: 0, read: 0, queries: 0 });
const ADA = "0000-0000-0000-001X";

// 0. Signed out.
const ada = new Client();
let me = await ada.me();
check("signed out, /me lists the three providers", me.signed_in === false && me.providers?.length === 3, me.providers?.map((p: { name: string }) => p.name));

// 1. A first sign-in, with ORCID: Ada, an author of two fixture papers with a page.
await control({ who: { orcid: { sub: ADA, name: "Ada Fixture" }, github: { id: 4242001, login: "ada-fixture", name: "Ada Fixture" } } });
let c = cost();
let landed = await ada.navigate(`${SITE}/api/auth/orcid/start?return=/account/`, c);
costs.push(["first sign-in, ORCID (new account, 2 papers verified)", c]);
check("ORCID: back on /account/?signed_in=orcid", landed.pathname + landed.search === "/account/?signed_in=orcid", landed.toString());
check("the session cookie is set", /^[A-Za-z0-9_-]{43}$/.test(ada.jar.get("__Host-oscr_session") ?? ""));
check("the flow cookie is gone", !ada.jar.has("__Host-oscr_flow"));
c = cost();
me = await ada.me(c);
costs.push(["GET /api/account/me", c]);
check("/me: the name, the ORCID iD, member", me.user?.display_name === "Ada Fixture" && me.handles?.orcid === ADA && me.roles?.[0]?.role === "member");
check(
  "/me: verified author of the fixture's papers 1 and 3, with their pages",
  JSON.stringify(me.papers?.map((p: { url: string }) => p.url).sort()) ===
    JSON.stringify(["/paper/doi_10.5555_oscr.fixture.1/", "/paper/doi_10.5555_oscr.fixture.3/"]),
  me.papers,
);
check("/me carries no email address", !JSON.stringify(me).includes("@"));

// 2. Link GitHub, signed in.
c = cost();
landed = await ada.navigate(`${SITE}/api/auth/github/start?return=/account/`, c);
costs.push(["link GitHub to the account", c]);
check("GitHub linked", landed.search === "?linked=github", landed.toString());
me = await ada.me();
check("/me: both identities", JSON.stringify(me.identities?.map((i: { provider: string }) => i.provider)) === '["orcid","github"]');

// 3. Maintainer: a contributor of the fixture's repository, then a claim without evidence.
await control({ github: { contributors: { "oscr-fixture/eeg-analysis": ["ada-fixture"], "oscr-fixture/unlicensed": ["someone-else"] } } });
c = cost();
let post = await ada.post("/api/account/maintainer", { repo: "https://github.com/oscr-fixture/eeg-analysis" }, c);
check("maintainer: a GitHub check to make", post.status === 200 && post.data.status === "redirect", post.data);
landed = await ada.navigate(String(post.data.url), c);
costs.push(["maintainer claim, verified (contributor)", c]);
check("maintainer: verified", landed.search === "?maintainer=verified&repo=github.com%2Foscr-fixture%2Feeg-analysis", landed.toString());
c = cost();
post = await ada.post("/api/account/maintainer", { repo: "github.com/oscr-fixture/unlicensed" }, c);
landed = await ada.navigate(String(post.data.url), c);
costs.push(["maintainer claim, pending", c]);
check("maintainer: pending without evidence", landed.searchParams.get("maintainer") === "pending", landed.toString());
me = await ada.me();
check("/me: the maintainer role", JSON.stringify(me.repositories) === JSON.stringify([{ repo: "github.com/oscr-fixture/eeg-analysis", url: "https://github.com/oscr-fixture/eeg-analysis" }]));
check("/me: two claims, verified and pending", JSON.stringify(me.claims?.map((x: { status: string }) => x.status).sort()) === '["pending","verified"]');

// 4. The author verification, on request: nothing new.
c = cost();
post = await ada.post("/api/account/authorship", undefined, c);
costs.push(["author verification on request (no change)", c]);
check("authorship: up to date", post.status === 200 && post.data.granted === 0 && post.data.revoked === 0, post.data);

// 5. Without a CSRF token, nothing.
const forged = await ada.request(`${SITE}/api/account/signout`, { method: "POST", headers: { Origin: new URL(SITE).origin } });
check("a POST without the CSRF token is refused", forged.status === 403);
const foreign = await ada.request(`${SITE}/api/account/signout`, {
  method: "POST",
  headers: { Origin: "https://evil.example", "X-CSRF-Token": (await ada.me()).csrf },
});
check("a POST from another origin is refused", foreign.status === 403);

// 6. Sign out, then back in: the returning sign-in.
c = cost();
post = await ada.post("/api/account/signout", undefined, c);
costs.push(["sign-out", c]);
check("signed out", post.status === 200 && !ada.jar.has("__Host-oscr_session"));
check("/me: signed out", (await ada.me()).signed_in === false);
c = cost();
landed = await ada.navigate(`${SITE}/api/auth/github/start?return=/account/`, c);
costs.push(["returning sign-in, GitHub (ORCID papers re-checked)", c]);
check("back in with GitHub, the same account", landed.search === "?signed_in=github" && (await ada.me()).handles?.orcid === ADA);

// 7. New accounts with GitHub and with Google.
await control({ who: { github: { id: 5150001, login: "ben-example", name: "Ben Example" }, google: { sub: "109876543210987654321" } } });
const ben = new Client();
c = cost();
landed = await ben.navigate(`${SITE}/api/auth/github/start`, c);
costs.push(["first sign-in, GitHub (new account)", c]);
check("a new GitHub account", landed.search === "?signed_in=github" && (await ben.me()).user?.display_name === "Ben Example");
const eve = new Client();
c = cost();
landed = await eve.navigate(`${SITE}/api/auth/google/start`, c);
costs.push(["first sign-in, Google (new account)", c]);
me = await eve.me();
check("a new Google account, without a name", landed.search === "?signed_in=google" && me.user?.display_name === "" && me.identities?.[0]?.provider === "google");

console.log("\nD1, as it counts (rows written / rows read / queries):");
for (const [what, k] of costs) console.log(`  ${String(k.written).padStart(3)} / ${String(k.read).padStart(3)} / ${String(k.queries).padStart(2)}  ${what}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nevery check passed");
process.exit(failures ? 1 : 0);
