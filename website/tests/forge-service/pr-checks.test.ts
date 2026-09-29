// The registry's checks on pull requests (night phase 10, E4; pr-checks.ts, webhook.ts): the App's
// pull_request delivery, then in waitUntil the installation reads the head (a tree, three files, the
// changed files: nothing run) and posts ONE check run; 0 D1 rows of its own; skip-checks honoured; a
// private repository or an installation that does not cover it gets nothing.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ORIGIN } from "../account/browser.ts";
import { utf8 } from "../../worker/forge/objects.ts";
import { handleForge } from "../../worker/forge/service/index.ts";
import { checkRunName } from "../../worker/forge/service/pr-checks.ts";
import { upsertInstallation } from "../../worker/forge/service/store.ts";
import type { FileChange, ForgeEvent, RepoStub } from "../../worker/forge/types.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

const SECRET = "whsec-test-0123456789";
const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";
const CFF = "cff-version: 1.2.0\nmessage: Cite it\ntitle: EEG\nauthors:\n  - family-names: Fixture\n    given-names: Ada\ndoi: 10.1234/eeg.2026\n";

let w: ForgeWorld;
let installation = "";
let repoId = "";
const put = (path: string, content: string): FileChange => ({ op: "put", path, content: utf8(content) });
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });

beforeEach(async () => {
  w = forgeWorld({ env: { GITHUB_APP_WEBHOOK_SECRET: SECRET, ACCOUNT_DEV_METRICS: "1" } });
  const info = await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true });
  repoId = info.key.id;
  const head = await ada().git.resolve(REF, "main");
  await ada().git.createCommit(REF, {
    branch: "main",
    expectedHead: head,
    message: "The analysis",
    changes: [put("LICENSE", MIT), put("CITATION.cff", CFF), put("README.md", "# EEG\n\n## Installation\n\npip install -r requirements.txt\n"), put("requirements.txt", "numpy==2.1.0\n"), put("src/filter.py", "def f():\n    return 4\n")],
  });
  installation = w.backend.install(ADA_LOGIN);
  await w.forge.batch([upsertInstallation(w.forge, { forge: "memory", id: installation, accountId: w.ada.user.id, accountLogin: ADA_LOGIN, accountType: "user", selection: "all", suspended: false }, T0).stmt]);
  await seed.repo(w.forge, { repoId, ownerId: w.ada.user.id, ownerLogin: ADA_LOGIN, name: "eeg", mode: "installed", installationId: installation, defaultBranch: "main" }, T0 - 86_400, { papers: [{ paperId: "doi:10.1234/eeg.2026", status: "linked" }] });
  w.forge.sqlite.prepare("INSERT INTO traced_paths (forge, repo_id, path, paper_id, commit_sha, ranges) VALUES ('memory', ?, 'src/filter.py', 'doi:10.1234/eeg.2026', ?, 2)").run(repoId, "b".repeat(40));
  w.forge.reset();
});
afterEach(() => w.restore());

let n = 0;
async function pullRequest(changes: FileChange[], message = "Work"): Promise<{ number: number; head: string }> {
  const base = await ada().git.resolve(REF, "main");
  const branch = `work-${++n}`;
  const head = (await ada().git.createCommit(REF, { branch, expectedHead: null, createFrom: base, changes, message })).sha;
  const pr = await ada().pulls.create(REF, { title: "A change", head: branch, base: "main" });
  return { number: pr.number, head };
}

async function deliver(pr: { number: number; head: string }, o: { action?: string; visibility?: RepoStub["visibility"]; installation?: string } = {}): Promise<number> {
  const stub: RepoStub = { key: { forge: "memory", id: repoId }, ref: REF, visibility: o.visibility ?? "public", defaultBranch: "main" };
  const actor = { name: ADA_LOGIN, login: ADA_LOGIN, id: w.ada.user.id };
  const event: ForgeEvent = { kind: "pull_request", delivery: `d-${++n}`, installation: o.installation ?? installation, action: o.action ?? "opened", number: pr.number, repo: stub, head: { ref: "w", sha: pr.head }, base: { ref: "main" }, merged: false, sender: actor, title: "A change", author: actor, mentions: [] };
  const d = await w.backend.deliver(event, SECRET);
  const res = (await handleForge(new Request(new URL("/api/forge/webhook", ORIGIN), { method: "POST", headers: d.headers, body: d.body as Uint8Array<ArrayBuffer> }), w.env, w.ctx, w.deps)) as Response;
  await Promise.all(w.ctx.waited);
  w.ctx.waited.length = 0;
  return res.status;
}

const runs = async (sha: string) => (await w.backend.session({ kind: "installation", installationId: installation }).checks.runs(REF, sha)).items;

describe("a check run on every pull request", () => {
  test("a change that deletes a traced file: ONE check run, failure, the paper named; 0 rows of its own", async () => {
    const pr = await pullRequest([{ op: "delete", path: "src/filter.py" }]);
    assert.equal(await deliver(pr), 200);
    const [run, ...more] = await runs(pr.head);
    assert.equal(more.length, 0);
    assert.equal(run.name, "Research code checks");
    assert.equal(run.conclusion, "failure");
    assert.match(run.output.title, /tracing maps/);
    assert.match(run.output.summary, /src\/filter\.py \(10\.1234\/eeg\.2026\) is deleted/);
    assert.match(run.output.summary, /never run its code/);
    assert.equal(run.detailsUrl, `${ORIGIN}/r/${ADA_LOGIN}/eeg/checks/${pr.head}`);
    // The delivery's own rows (its event and its row), nothing for the checks.
    assert.equal(w.forge.totals.written, 2);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a push to it (synchronize): checked again; a change that edits a traced file: success, with its annotation", async () => {
    const pr = await pullRequest([put("src/filter.py", "def f():\n    return 5\n")]);
    assert.equal(await deliver(pr, { action: "synchronize" }), 200);
    const [run] = await runs(pr.head);
    assert.equal(run.conclusion, "success");
    assert.equal(run.output.annotations, 1);
    assert.equal(w.forge.totals.written, 0, "a synchronize is no inbox event");
  });

  test("skip-checks: true; a private repository; an installation that does not cover it; a closed pull request: no check run", async () => {
    const skipped = await pullRequest([put("NEWS.md", "x\n")], "Docs\n\nskip-checks: true");
    await deliver(skipped);
    assert.equal((await runs(skipped.head)).length, 0);
    const other = await pullRequest([put("NEWS.md", "y\n")]);
    await deliver(other, { visibility: "private" });
    await deliver(other, { installation: "999999" });
    await deliver(other, { action: "closed" });
    assert.equal((await runs(other.head)).length, 0);
  });

  test("the run's name comes from SITE_NAME, never hard-coded", () => {
    assert.equal(checkRunName({}), "Research code checks");
    assert.equal(checkRunName({ SITE_NAME: "Lab registry" }), "Lab registry: research checks");
  });
});
