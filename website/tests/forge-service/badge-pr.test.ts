// The badge's one pull request (D00-4 amended, 2026-11-04; badge-pr.ts, webhook.ts): an installation
// that adds a public repository the registry links to a paper gets ONE pull request adding the badge to
// its README, behind FORGE_OPEN and FORGE_BADGE_PR; never twice; never with the flag off; nothing when
// the README carries the badge; and an installation session writes nothing else.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ORIGIN } from "../account/browser.ts";
import { GitBackendError } from "../../worker/forge/errors.ts";
import { utf8 } from "../../worker/forge/objects.ts";
import { BADGE_BRANCH, badgePrBody } from "../../worker/forge/service/badge-pr.ts";
import { handleForge } from "../../worker/forge/service/index.ts";
import { upsertInstallation } from "../../worker/forge/service/store.ts";
import type { ForgeEvent, RepoStub } from "../../worker/forge/types.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

const SECRET = "whsec-test-0123456789";
const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const ON = { GITHUB_APP_WEBHOOK_SECRET: SECRET, FORGE_OPEN: "true", FORGE_BADGE_PR: "1", SITE_NAME: "Registry" };

let w: ForgeWorld;
let installation = "";
let repoId = "";
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });

async function setUp(env: Record<string, string>, readme = "# EEG\n\nThe analysis.\n"): Promise<void> {
  w = forgeWorld({ env });
  const info = await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true });
  repoId = info.key.id;
  const head = await ada().git.resolve(REF, "main");
  await ada().git.createCommit(REF, { branch: "main", expectedHead: head, message: "README", changes: [{ op: "put", path: "README.md", content: utf8(readme) }] });
  installation = w.backend.install(ADA_LOGIN, [REF]);
  await w.forge.batch([upsertInstallation(w.forge, { forge: "memory", id: installation, accountId: w.ada.user.id, accountLogin: ADA_LOGIN, accountType: "user", selection: "selected", suspended: false }, T0).stmt]);
  await seed.repo(w.forge, { repoId, ownerId: w.ada.user.id, ownerLogin: ADA_LOGIN, name: "eeg", mode: "public", defaultBranch: "main" }, T0 - 86_400, { papers: [{ paperId: "doi:10.1234/eeg.2026", status: "linked" }] });
  w.forge.reset();
}
afterEach(() => w.restore());

let n = 0;
async function added(): Promise<number> {
  const stub: RepoStub = { key: { forge: "memory", id: repoId }, ref: REF, visibility: "public", defaultBranch: "main" };
  const actor = { name: ADA_LOGIN, login: ADA_LOGIN, id: w.ada.user.id };
  const event: ForgeEvent = {
    kind: "installation_repositories", delivery: `b-${++n}`, action: "added",
    installation: { id: installation, account: { id: w.ada.user.id, login: ADA_LOGIN, type: "user" }, selection: "selected", suspended: false },
    added: [stub], removed: [], sender: actor,
  };
  const d = await w.backend.deliver(event, SECRET);
  const res = (await handleForge(new Request(new URL("/api/forge/webhook", ORIGIN), { method: "POST", headers: d.headers, body: d.body as Uint8Array<ArrayBuffer> }), w.env, w.ctx, w.deps)) as Response;
  await Promise.all(w.ctx.waited);
  w.ctx.waited.length = 0;
  return res.status;
}
const pulls = async () => (await ada().pulls.list(REF, { state: "all" })).items;
const offers = () => (w.forge.sqlite.prepare("SELECT outcome, pr_number FROM badge_offers").all() as { outcome: string; pr_number: number | null }[]).map((r) => ({ ...r }));

describe("the badge's one pull request", () => {
  beforeEach(() => setUp(ON));

  test("an installation adds a linked repository: ONE pull request, the README with the badge under its title", async () => {
    assert.equal(await added(), 200);
    const [pr, ...more] = await pulls();
    assert.equal(more.length, 0);
    assert.equal(pr.title, "Add the Registry badge");
    assert.match(pr.body ?? "", /offered once, and never again/);
    const f = await ada().git.readFile(REF, BADGE_BRANCH, "README.md");
    const text = new TextDecoder().decode(f.bytes);
    assert.match(text, /^# EEG\n\n<!-- oscr-badge:start -->\n\[!\[Registry\]\(https?:\/\/[^)]+\/badge\/doi\/10\.1234\/eeg\.2026\.svg\)\]/);
    assert.match(text, /<!-- oscr-badge:end -->\n\nThe analysis\.\n$/);
    assert.deepEqual(offers(), [{ outcome: "opened", pr_number: pr.number }]);
  });

  test("never twice, even once the pull request is closed", async () => {
    await added();
    const [pr] = await pulls();
    await ada().pulls.update(REF, pr.number, { state: "closed" });
    await added();
    assert.equal((await pulls()).length, 1);
    assert.equal(offers().length, 1);
  });

  test("an installation session made for anything else still writes nothing", async () => {
    const s = w.backend.session({ kind: "installation", installationId: installation });
    await assert.rejects(s.pulls.create(REF, { title: "x", head: "main", base: "main" }), (e: unknown) => e instanceof GitBackendError && e.code === "forbidden");
  });
});

describe("when it is not offered", () => {
  test("the flag off: nothing, no row", async () => {
    await setUp({ ...ON, FORGE_BADGE_PR: "" });
    await added();
    assert.equal((await pulls()).length, 0);
    assert.equal(offers().length, 0);
  });

  test("FORGE_OPEN unset: nothing", async () => {
    await setUp({ ...ON, FORGE_OPEN: "" });
    await added();
    assert.equal((await pulls()).length, 0);
  });

  test("a README that already carries the badge: no pull request, one row so it is not read again", async () => {
    await setUp(ON, "# EEG\n\n<!-- oscr-badge:start -->\nx\n<!-- oscr-badge:end -->\n");
    await added();
    assert.equal((await pulls()).length, 0);
    assert.deepEqual(offers(), [{ outcome: "has_badge", pr_number: null }]);
  });

  test("the body names no address and says how to decline", () => {
    const body = badgePrBody("Registry", "https://example.org", { kind: "doi", doi: "10.1234/x" });
    assert.match(body, /Close it to decline/);
    assert.doesNotMatch(body, /@/);
  });
});
