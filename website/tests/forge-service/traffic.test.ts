// The privacy-respecting traffic read (night phase 12, E4: worker/forge/service/traffic.ts):
// - a maintainer sees aggregate figures (views and visits per day, referrers, pages), read from a
//   FAKE Cloudflare analytics source; a non-maintainer is refused (403);
// - the answer carries no unique-visitor or per-person figure;
// - with no token set up, the answer says traffic is not enabled.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";
import type { ForgeDeps, ForgeServiceEnv } from "../../worker/forge/service/types.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const HEAD = "a".repeat(40);

/** A fake Cloudflare GraphQL analytics source: it records the request (to check no `uniques` is
 *  asked), and answers one account's day, week, referrer and page groups. */
function fakeAnalytics(seen: { body: string[] }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    seen.body.push(String(init?.body ?? ""));
    const day = (n: number) => new Date((T0 - n * 86400) * 1000).toISOString().slice(0, 10);
    const payload = {
      data: { viewer: { accounts: [{
        days: [
          { dimensions: { date: day(1) }, count: 10, sum: { visits: 4 } },
          { dimensions: { date: day(0) }, count: 20, sum: { visits: 9 } },
        ],
        weeks: [{ dimensions: { date: day(7) }, count: 50, sum: { visits: 22 } }],
        referrers: [
          { dimensions: { refererHost: "scholar.example.org" }, count: 12 },
          { dimensions: { refererHost: "" }, count: 7 },
        ],
        pages: [{ dimensions: { requestPath: "/r/ada/toolkit/" }, count: 30 }],
      }] } },
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

const TOKEN_ENV: Partial<ForgeServiceEnv> = {
  ACCOUNT_DEV_METRICS: "1",
  CLOUDFLARE_ANALYTICS_TOKEN: "read-only-test-token",
  CLOUDFLARE_ACCOUNT_ID: "acc123",
  CLOUDFLARE_ANALYTICS_SITE_TAG: "sitetag123",
  CLOUDFLARE_ANALYTICS_URL: "http://127.0.0.1:9999/graphql",
};

let w: ForgeWorld;
afterEach(() => w.restore());

describe("GET /api/forge/traffic", () => {
  test("a maintainer sees aggregate views and visits, referrers and pages (no per-person figure)", async () => {
    const seen = { body: [] as string[] };
    w = forgeWorld({ env: TOKEN_ENV, deps: { analyticsFetch: fakeAnalytics(seen) } as Partial<ForgeDeps> });
    const b = w.browser();
    await b.signIn("github");
    const subject = String(w.mock.who.github.id);
    const uid = (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string }).user_id;
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "toolkit", mode: "public", head: HEAD, linkedBy: uid }, T0 - 86_400);
    const res = await b.fetch("/api/forge/traffic?id=memory:101");
    assert.equal(res.status, 200);
    const j = (await res.json()) as Json;
    assert.equal(j.configured, true);
    assert.equal(j.days.length, 2);
    assert.equal(j.days[1].views, 20);
    assert.equal(j.days[1].visits, 9);
    assert.equal(j.weeks.length, 1);
    assert.equal(j.referrers[0].label, "scholar.example.org");
    assert.equal(j.referrers.find((r: Json) => r.label === "(direct)").value, 7);
    assert.equal(j.pages[0].label, "/r/ada/toolkit/");
    // Aggregate only: nowhere a unique-visitor or per-person figure, and the query never asks for one.
    assert.ok(!JSON.stringify(j).includes("unique"));
    assert.ok(!seen.body.join("").includes("uniques"));
    // The query is scoped to this repository's pages.
    assert.ok(seen.body.join("").includes("/r/ada/toolkit/"));
  });

  test("a non-maintainer is refused (403), so traffic never leaks", async () => {
    w = forgeWorld({ env: TOKEN_ENV, deps: { analyticsFetch: fakeAnalytics({ body: [] }) } as Partial<ForgeDeps> });
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "toolkit", mode: "public", head: HEAD, ownerId: "1", linkedBy: "someone-else" }, T0 - 86_400);
    const b = w.browser();
    await b.signIn("github");
    const res = await b.fetch("/api/forge/traffic?id=memory:101");
    assert.equal(res.status, 403);
  });

  test("with no analytics token set up, it says traffic is not enabled", async () => {
    w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
    const b = w.browser();
    await b.signIn("github");
    const subject = String(w.mock.who.github.id);
    const uid = (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string }).user_id;
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "toolkit", mode: "public", head: HEAD, linkedBy: uid }, T0 - 86_400);
    const res = await b.fetch("/api/forge/traffic?id=memory:101");
    assert.equal(res.status, 200);
    const j = (await res.json()) as Json;
    assert.equal(j.configured, false);
    assert.ok((j.note as string).toLowerCase().includes("not enabled"));
  });
});
