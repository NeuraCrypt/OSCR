// GitHub's releases, tags and assets as authorized actions, and the registry's release ↔ paper link
// (night phase 07, E1; act-releases.ts): through start, the double's GitHub and act, with the real
// registry. Each action is ONE act made by GitHub as the person; the registry writes the action row,
// the tie of a release to a paper's version, and the Mac's jobs, nothing else.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { ACTIONS, REGISTERED_IN } from "../../worker/forge/service/actions.ts";
import {
  assetDeleteSpec,
  assetUploadSpec,
  describeReleaseCreate,
  describeReleaseResearch,
  isTagName,
  RELEASE_ACTIONS,
  releasePage,
  validateAssetUpload,
  validateReleaseCreate,
  validateReleaseEdit,
  validateReleaseResearch,
  type CreateParsed,
  type ResearchParsed,
  type UploadParsed,
} from "../../worker/forge/service/act-releases.ts";
import { ASSET_UPLOAD_BYTES } from "../../worker/forge/service/caps.ts";
import { ACTION_KINDS, ForgeProblem, isProblem, type ActionContext } from "../../worker/forge/service/types.ts";
import { authorize, signIn, watchAuth } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true" } });
});
afterEach(() => w.restore());

const PAPER = "doi:10.1234/eeg.2026";
const ORCID = "0000-0002-1825-0097";
const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });
const anon = () => w.backend.session({ kind: "anonymous" });

/** Ada's public repository on the double; `linked`: known to the registry as the paper's code. */
async function repository(opts: { linked?: boolean } = {}): Promise<{ id: string; head: string }> {
  const id = (await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true })).key.id;
  if (opts.linked !== false) {
    await seed.repo(w.forge, { repoId: id, ownerLogin: ADA_LOGIN, name: "eeg", defaultBranch: "main" }, T0 - 86_400, { papers: [{ paperId: PAPER, status: "linked" }] });
  }
  return { id, head: await ada().git.resolve(REF, "main") };
}

function userIdOf(login = ADA_LOGIN): string {
  const account = [...w.backend.accounts.values()].find((a) => a.login === login);
  return (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(String(account?.id)) as { user_id: string }).user_id;
}

function role(uid: string, r: string, kind: string, id: string): void {
  w.db.sqlite.prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, ?, ?, ?, 'system', ?)").run(uid, r, kind, id, T0);
}

function orcid(uid: string): void {
  w.db.sqlite.prepare("INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('orcid', ?, ?, ?)").run(ORCID, uid, T0);
}

/** Ada as the paper's verified author, with her ORCID iD linked. */
function adaAuthor(): void {
  const uid = userIdOf();
  role(uid, "verified_author", "paper", PAPER);
  orcid(uid);
}

const on = (kind: string, id: string, payload: Record<string, unknown>): StartInput => ({
  kind: kind as StartInput["kind"],
  repo: { forge: "memory", id },
  branch: null,
  expectedHead: null,
  payload,
  back: "/r/ada-fixture/eeg/releases/",
});

const MAP = "a".repeat(64);
const memRepo = (id: string) => w.backend.repos.get(id)!;

describe("release_create", () => {
  test("publishes at the commit the page showed, tied to the accepted manuscript, with Software Heritage and Zenodo asked: 5 rows (7 with phase 08's events), one batch", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    adaAuthor();
    const seen = watchAuth(w);
    w.forge.reset();
    const run = await authorize(
      w,
      b,
      on("release_create", id, {
        tag: "v1.0.0",
        target: head,
        name: "Code of the accepted manuscript",
        body: "Figures 2–4. Questions: ada@example.org",
        prerelease: false,
        latest: "true",
        paper: { doi: "https://doi.org/10.1234/EEG.2026", version: "accepted", label: "revision 2" },
        map: MAP,
        archive: true,
        deposit: true,
      }),
    );
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    assert.equal(r.tag, "v1.0.0");
    assert.equal(r.draft, false);
    assert.equal(r.page, "/r/ada-fixture/eeg/releases/tag/v1.0.0");
    assert.deepEqual(r.papers, [{ paperId: PAPER, status: "linked", version: "accepted" }]);
    assert.deepEqual(r.jobs, ["release", "archive", "deposit"]);
    // The notes are GitHub's; the answer masks the address, the registry keeps none of them.
    assert.match(r.release.body, /\[email hidden\]/);
    const made = await anon().releases.byTag(REF, "v1.0.0");
    assert.equal(made.name, "Code of the accepted manuscript");
    assert.equal(await ada().git.resolve(REF, "refs/tags/v1.0.0"), head);
    assert.equal((await anon().releases.latest(REF))?.id, made.id);
    assert.equal(run.actBody!.sentence, "Publish the release v1.0.0 “Code of the accepted manuscript” at commit " + head.slice(0, 7) + " (set as the latest); tie it to the accepted manuscript (revision 2) of doi:10.1234/eeg.2026, with the tracing map aaaaaaaaaaaa; ask Software Heritage to archive it; ask for the Zenodo deposit of its tracing map, validated by you");
    // One batch: the action row (5), the tie, three jobs; phase 08: the release's event (no App on the
    // repository: no webhook will bring it) and the tie's event on the paper (7).
    assert.deepEqual(forgeRows(w.forge, "events").map((e) => [e.subject, e.kind]).sort(), [[`paper:${PAPER}`, "release_tied"], [`repo:memory:${id}`, "release_published"]]);
    assert.equal(w.forge.totals.written, 7);
    const [tie] = forgeRows(w.forge, "release_papers");
    assert.equal(tie.tag, "v1.0.0");
    assert.equal(tie.paper_id, PAPER);
    assert.equal(tie.version, "accepted");
    assert.equal(tie.label, "revision 2");
    assert.equal(tie.commit_sha, head);
    assert.equal(tie.map_digest, MAP);
    assert.equal(tie.status, "linked");
    assert.equal(tie.release_id, made.id);
    assert.equal(tie.repo_path, "ada-fixture/eeg");
    const jobs = forgeRows(w.forge, "jobs");
    assert.deepEqual(jobs.map((j) => [j.kind, j.ref, j.paper_id]), [["release", "v1.0.0", PAPER], ["archive", "v1.0.0", ""], ["deposit", "v1.0.0", PAPER]]);
    // Sign-in through ORCID's sandbox (the default while the platform is built): the deposit is a test.
    assert.deepEqual(jobs.map((j) => j.proof), ["", "", "orcid-sandbox"]);
    const [action] = forgeRows(w.forge, "actions");
    assert.equal(action.kind, "release_create");
    assert.equal(action.rows, 7);
    assert.equal(action.repo_id, id);
    assert.ok(!JSON.stringify(forgeRows(w.forge, "release_papers")).includes("Figures"));
    assert.deepEqual(seen.revoked, seen.issued);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a draft: no tag on GitHub, the tie kept for its publication, no job; drafts ask for no archive", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const run = await authorize(w, b, on("release_create", id, { tag: "v0.9.0", target: head, draft: true, paper: { doi: "10.1234/eeg.2026", version: "preprint" } }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(run.actBody!.result.draft, true);
    assert.equal(run.actBody!.result.page, "/r/ada-fixture/eeg/releases/");
    await assert.rejects(ada().git.resolve(REF, "refs/tags/v0.9.0"));
    assert.equal(forgeRows(w.forge, "jobs").length, 0);
    // Ada holds no role: the tie is proposed to the paper's authors.
    assert.equal(forgeRows(w.forge, "release_papers")[0].status, "proposed");
    assert.ok(run.actBody!.result.notes.some((n: string) => /proposed/.test(n)));
    const archive = validateReleaseCreate({ tag: "v1", target: head, draft: true, archive: true });
    assert.ok(isProblem(archive));
  });

  test("refused before GitHub: a tag at another commit, code the registry does not know as the paper's, a deposit without ORCID or by a maintainer only", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    await ada().git.createTag(REF, { name: "v0.1", sha: head });
    const other = (await ada().git.createCommit(REF, { branch: "main", message: "more", changes: [{ op: "put", path: "b.txt", content: new TextEncoder().encode("b\n") }], expectedHead: head })).sha;
    w.forge.reset();
    const moved = await authorize(w, b, on("release_create", id, { tag: "v0.1", target: other }));
    assert.equal(moved.act?.status, 409);
    assert.equal(moved.actBody!.error.code, "tag_moved");
    const stranger = await authorize(w, b, on("release_create", id, { tag: "v1", target: other, paper: { doi: "10.9999/other", version: "published" } }));
    assert.equal(stranger.act?.status, 409);
    assert.equal(stranger.actBody!.error.code, "not_the_papers_code");
    const noOrcid = await authorize(w, b, on("release_create", id, { tag: "v1", target: other, paper: { doi: "10.1234/eeg.2026", version: "published" }, map: MAP, deposit: true }));
    assert.equal(noOrcid.act?.status, 403);
    assert.equal(noOrcid.actBody!.error.code, "not_author");
    role(userIdOf(), "maintainer", "repo", "github.com/ada-fixture/eeg");
    const maintainer = await authorize(w, b, on("release_create", id, { tag: "v1", target: other, paper: { doi: "10.1234/eeg.2026", version: "published" }, map: MAP, deposit: true }));
    assert.equal(maintainer.actBody!.error.code, "not_author");
    role(userIdOf(), "verified_author", "paper", PAPER);
    const withoutOrcid = await authorize(w, b, on("release_create", id, { tag: "v1", target: other, paper: { doi: "10.1234/eeg.2026", version: "published" }, map: MAP, deposit: true }));
    assert.equal(withoutOrcid.act?.status, 409);
    assert.equal(withoutOrcid.actBody!.error.code, "no_orcid");
    assert.equal((await anon().releases.list(REF)).items.length, 0);
    assert.equal(forgeRows(w.forge, "actions").length, 0);
    assert.equal(forgeRows(w.forge, "release_papers").length, 0);
  });

  test("a tag another release uses, and the tag of a deleted immutable release: said, nothing recorded", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    memRepo(id).immutableReleases = true;
    const first = await authorize(w, b, on("release_create", id, { tag: "v1", target: head }));
    assert.equal(first.act?.status, 200, JSON.stringify(first.actBody));
    assert.equal(first.actBody!.result.immutable, true);
    const again = await authorize(w, b, on("release_create", id, { tag: "v1", target: head }));
    assert.equal(again.act?.status, 409);
    assert.equal(again.actBody!.error.code, "tag_taken");
    const del = await authorize(w, b, on("release_delete", id, { id: first.actBody!.result.id, confirm: "v1" }));
    assert.equal(del.act?.status, 200, JSON.stringify(del.actBody));
    assert.ok(del.actBody!.result.notes.some((n: string) => /never lets a release use the tag v1 again/.test(n)));
    const burned = await authorize(w, b, on("release_create", id, { tag: "v1", target: head }));
    assert.equal(burned.act?.status, 409);
    assert.equal(burned.actBody!.error.code, "tag_burned");
    assert.deepEqual(forgeRows(w.forge, "actions").map((a) => String(a.kind)).sort(), ["release_create", "release_delete"]);
  });

  test("GitHub's generated notes follow the person's text; the answer links the release in the registry", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const run = await authorize(w, b, on("release_create", id, { tag: "v2.0.0", target: head, body: "Intro.", generateNotes: true, latest: "legacy" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const made = await anon().releases.byTag(REF, "v2.0.0");
    assert.match(made.body, /^Intro\.\n\n## What's Changed/);
    assert.deepEqual(run.actBody!.result.links, [{ href: "/r/ada-fixture/eeg/releases/tag/v2.0.0", text: "The release v2.0.0" }]);
  });
});

describe("release_edit, release_delete, release_drafts", () => {
  async function draft(b: ForgeBrowser, id: string, head: string, extra: Record<string, unknown> = {}): Promise<string> {
    const run = await authorize(w, b, on("release_create", id, { tag: "v1.1.0", target: head, draft: true, body: "Draft notes, ada@example.org", ...extra }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    return run.actBody!.result.id;
  }

  test("the drafts, read as the person: masked, drafts only; nothing written but the action row", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    await draft(b, id, head);
    await ada().releases.create(REF, { tagName: "v1.0.0", target: head });
    w.forge.reset();
    const run = await authorize(w, b, on("release_drafts", id, {}));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    assert.equal(r.repo, "ada-fixture/eeg");
    assert.deepEqual(r.drafts.map((d: { tag: string }) => d.tag), ["v1.1.0"]);
    assert.match(r.drafts[0].body, /\[email hidden\]/);
    assert.equal(w.forge.totals.written, 1);
  });

  test("publishing a tied draft makes its tag and asks for its map's version; a published tag stays; a tied release stays published and is not deleted", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    adaAuthor();
    const rid = await draft(b, id, head, { paper: { doi: "10.1234/eeg.2026", version: "submitted" }, map: MAP });
    w.forge.reset();
    const pub = await authorize(w, b, on("release_edit", id, { id: rid, draft: false, name: "Submitted" }));
    assert.equal(pub.act?.status, 200, JSON.stringify(pub.actBody));
    assert.equal(pub.actBody!.sentence, "Publish the draft release: its title to “Submitted”");
    assert.equal(await ada().git.resolve(REF, "refs/tags/v1.1.0"), head);
    assert.deepEqual(forgeRows(w.forge, "jobs").map((j) => [j.kind, j.paper_id]), [["release", PAPER]]);
    // The action row and the job; phase 08: the release's event (published now, no App on the repository).
    assert.deepEqual(forgeRows(w.forge, "events").map((e) => e.kind).sort(), ["release_published", "release_tied"]);
    assert.equal(forgeRows(w.forge, "actions")[0].rows, 3);
    const retag = await authorize(w, b, on("release_edit", id, { id: rid, tag: "v1.1.1" }));
    assert.equal(retag.act?.status, 409);
    assert.equal(retag.actBody!.error.code, "published_tag");
    const unpublish = await authorize(w, b, on("release_edit", id, { id: rid, draft: true }));
    assert.equal(unpublish.actBody!.error.code, "tied");
    const typo = await authorize(w, b, on("release_delete", id, { id: rid, confirm: "v1.1" }));
    assert.equal(typo.actBody!.error.code, "confirm_name");
    const tied = await authorize(w, b, on("release_delete", id, { id: rid, confirm: "v1.1.0" }));
    assert.equal(tied.actBody!.error.code, "tied");
    assert.equal((await anon().releases.byTag(REF, "v1.1.0")).draft, false);
  });

  test("a draft's tag and commit may change; an untied release is deleted, its tag kept; an immutable one stays published", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const rid = await draft(b, id, head);
    const retag = await authorize(w, b, on("release_edit", id, { id: rid, tag: "v1.2.0", body: "Better notes", prerelease: true }));
    assert.equal(retag.act?.status, 200, JSON.stringify(retag.actBody));
    assert.equal(retag.actBody!.result.tag, "v1.2.0");
    assert.equal(retag.actBody!.result.prerelease, true);
    assert.ok(isProblem(validateReleaseEdit({ id: rid, latest: "true", prerelease: true })));
    const pub = await authorize(w, b, on("release_edit", id, { id: rid, draft: false }));
    assert.equal(pub.act?.status, 200);
    const del = await authorize(w, b, on("release_delete", id, { id: rid, confirm: "v1.2.0" }));
    assert.equal(del.act?.status, 200, JSON.stringify(del.actBody));
    assert.equal(await ada().git.resolve(REF, "refs/tags/v1.2.0"), head);
    await assert.rejects(anon().releases.byTag(REF, "v1.2.0"));
    memRepo(id).immutableReleases = true;
    const locked = (await ada().releases.create(REF, { tagName: "v3", target: head })).id;
    const back = await authorize(w, b, on("release_edit", id, { id: locked, draft: true }));
    assert.equal(back.act?.status, 409);
    assert.equal(back.actBody!.error.code, "immutable");
    const text = await authorize(w, b, on("release_edit", id, { id: locked, body: "Corrected notes" }));
    assert.equal(text.act?.status, 200, "an immutable release's text stays editable");
  });
});

describe("release_research", () => {
  test("tie a published release later, then ask for its archive and its deposit; untie", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    await ada().releases.create(REF, { tagName: "v1.0.0", target: head });
    adaAuthor();
    w.forge.reset();
    const tie = await authorize(w, b, on("release_research", id, { tag: "v1.0.0", paper: { doi: "10.1234/eeg.2026", version: "published" }, map: MAP }));
    assert.equal(tie.act?.status, 200, JSON.stringify(tie.actBody));
    assert.equal(tie.actBody!.result.page, releasePage(REF, "v1.0.0"));
    assert.deepEqual(tie.actBody!.result.jobs, ["release"]);
    assert.equal(forgeRows(w.forge, "release_papers")[0].commit_sha, head);
    const ask = await authorize(w, b, on("release_research", id, { tag: "v1.0.0", archive: true, deposit: "10.1234/eeg.2026" }));
    assert.equal(ask.act?.status, 200, JSON.stringify(ask.actBody));
    assert.deepEqual(ask.actBody!.result.jobs, ["archive", "deposit"]);
    const deposit = forgeRows(w.forge, "jobs").find((j) => j.kind === "deposit")!;
    assert.equal(deposit.paper_id, PAPER);
    const newer = "b".repeat(64);
    const again = await authorize(w, b, on("release_research", id, { tag: "v1.0.0", deposit: "10.1234/eeg.2026", map: newer }));
    assert.equal(again.act?.status, 200, JSON.stringify(again.actBody));
    assert.equal(forgeRows(w.forge, "release_papers")[0].map_digest, newer, "the map validated now is the tie's");
    const untie = await authorize(w, b, on("release_research", id, { tag: "v1.0.0", untie: "10.1234/eeg.2026" }));
    assert.equal(untie.act?.status, 200, JSON.stringify(untie.actBody));
    assert.equal(forgeRows(w.forge, "release_papers").length, 0);
    const nothing = await authorize(w, b, on("release_research", id, { tag: "v1.0.0", untie: "10.1234/eeg.2026" }));
    assert.equal(nothing.actBody!.error.code, "not_tied");
    assert.deepEqual(w.forge.scans, []);
  });

  test("who may: Bob, who may not push, asks for no archive and ties nothing; a draft is not archived", async () => {
    const { id, head } = await repository();
    await ada().releases.create(REF, { tagName: "v1.0.0", target: head });
    await ada().releases.create(REF, { tagName: "v2.0.0-rc", target: head, draft: true });
    const bob = await signIn(w, "bob");
    const archive = await authorize(w, bob, on("release_research", id, { tag: "v1.0.0", archive: true }), { login: "bob" });
    assert.equal(archive.act?.status, 403, JSON.stringify(archive.actBody));
    assert.equal(archive.actBody!.error.code, "not_maintainer");
    const tie = await authorize(w, bob, on("release_research", id, { tag: "v1.0.0", paper: { doi: "10.1234/eeg.2026", version: "preprint" } }), { login: "bob" });
    assert.equal(tie.actBody!.error.code, "forbidden");
    const b = await signIn(w);
    const onDraft = await authorize(w, b, on("release_research", id, { tag: "v2.0.0-rc", archive: true }));
    assert.equal(onDraft.act?.status, 409);
    assert.equal(onDraft.actBody!.error.code, "draft");
    const tieDraft = await authorize(w, b, on("release_research", id, { tag: "v2.0.0-rc", paper: { doi: "10.1234/eeg.2026", version: "preprint" } }));
    assert.equal(tieDraft.act?.status, 200, JSON.stringify(tieDraft.actBody));
    assert.deepEqual(tieDraft.actBody!.result.jobs, [], "a draft's map is versioned when it is published");
  });

  test("validation and the sentence", () => {
    assert.ok(isProblem(validateReleaseResearch({ tag: "v1" })));
    assert.ok(isProblem(validateReleaseResearch({ tag: "v1", paper: { doi: "10.1234/x", version: "published" }, untie: "10.1234/x" })));
    assert.ok(isProblem(validateReleaseResearch({ tag: "v1", paper: { doi: "10.1234/x", version: "draft" } })));
    assert.ok(isProblem(validateReleaseResearch({ tag: "v1", deposit: "10.1234/x", paper: { doi: "10.1234/y", version: "published" } })));
    assert.ok(isProblem(validateReleaseResearch({ tag: "v1", paper: { doi: "10.1234/x", version: "published", label: "write to a@b.org" } })));
    const p = validateReleaseResearch({ tag: "v1", paper: { doi: "10.1234/X", version: "correction", label: "erratum" }, archive: true }) as ResearchParsed;
    assert.equal(describeReleaseResearch(p), "For the release v1: tie it to a correction (erratum) of doi:10.1234/x; ask Software Heritage to archive it");
  });
});

describe("tags", () => {
  test("an annotated tag at a commit; a tag a published release or a tie uses is not deleted; an unused one is", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const made = await authorize(w, b, on("tag_create", id, { name: "paper-v1", target: head, message: "The code of the submitted paper" }));
    assert.equal(made.act?.status, 200, JSON.stringify(made.actBody));
    assert.equal(made.actBody!.result.annotated, true);
    assert.equal(made.actBody!.sentence, `Create the annotated tag paper-v1 at commit ${head.slice(0, 7)}`);
    assert.equal(await ada().git.resolve(REF, "refs/tags/paper-v1"), head);
    const twice = await authorize(w, b, on("tag_create", id, { name: "paper-v1", target: head }));
    assert.equal(twice.actBody!.error.code, "tag_taken");
    await ada().releases.create(REF, { tagName: "v1", target: head });
    const released = await authorize(w, b, on("tag_delete", id, { name: "v1", confirm: "v1" }));
    assert.equal(released.act?.status, 409);
    assert.equal(released.actBody!.error.code, "released");
    await w.forge.batch([
      w.forge.prepare("INSERT INTO release_papers (forge, repo_id, tag, paper_id, version, status, by_user, at) VALUES ('memory', ?, 'paper-v1', ?, 'published', 'linked', 'u', ?)").bind(id, PAPER, T0),
    ]);
    const tied = await authorize(w, b, on("tag_delete", id, { name: "paper-v1", confirm: "paper-v1" }));
    assert.equal(tied.actBody!.error.code, "tied");
    await ada().git.createTag(REF, { name: "scratch", sha: head });
    const gone = await authorize(w, b, on("tag_delete", id, { name: "scratch", confirm: "scratch" }));
    assert.equal(gone.act?.status, 200, JSON.stringify(gone.actBody));
    await assert.rejects(ada().git.resolve(REF, "refs/tags/scratch"));
    assert.ok(isProblem(ACTIONS.get("tag_delete")!.validate({ name: "scratch", confirm: "scrach" })));
  });
});

describe("assets", () => {
  /** An ActionContext for Ada, as act.ts builds it, with the file streamed in. */
  async function ctxFor<P>(parsed: P, repoId: string, upload?: { bytes: Uint8Array }): Promise<ActionContext<P>> {
    const b = await signIn(w);
    void b;
    const user = w.db.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userIdOf()) as never;
    return {
      env: w.env,
      db: w.forge,
      community: w.db,
      backend: w.backend,
      session: ada(),
      github: { id: w.ada.user.id, login: ADA_LOGIN },
      user,
      parsed,
      target: { kind: "asset_upload", repo: { forge: "memory", id: repoId }, branch: null, expectedHead: null },
      repo: null,
      t: T0,
      nonce: "n0nce-test",
      installations: { list: async () => ({ items: [], next: null }), repositories: async () => ({ items: [], next: null }) },
      upload: upload
        ? {
            size: upload.bytes.length,
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(upload.bytes.slice(0, 3));
                c.enqueue(upload.bytes.slice(3));
                c.close();
              },
            }),
          }
        : undefined,
    } as ActionContext<P>;
  }

  /** A payload the spec accepts (a refusal fails the test). */
  const upload = (payload: Record<string, unknown>): UploadParsed => {
    const p = validateAssetUpload(payload);
    if (isProblem(p)) throw new Error(p.message);
    return p;
  };

  const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");

  test("a file streamed to GitHub, its digest GitHub's; a wrong digest removes it again; an immutable release's files are locked", async () => {
    const { id, head } = await repository();
    const rel = await ada().releases.create(REF, { tagName: "v1", target: head, draft: true });
    const bytes = new TextEncoder().encode("time,value\n0,1\n");
    const parsed = upload({ release: rel.id, name: "figure-2.csv", label: "Source data of Figure 2", size: bytes.length, sha256: await sha(bytes), contentType: "text/csv" });
    const ctx = await ctxFor(parsed, id, { bytes });
    const done = await assetUploadSpec.perform(ctx);
    assert.equal(done.result.digest, await sha(bytes));
    assert.ok(assetUploadSpec.check(done.result, parsed, ctx));
    assert.deepEqual(done.writes, []);
    assert.equal(assetUploadSpec.describe(parsed), `Attach the file figure-2.csv (15 bytes, SHA-256 ${(await sha(bytes)).slice(0, 12)}…), labelled “Source data of Figure 2”, to the release`);
    // Declared with another digest: what reached GitHub is removed again.
    const wrong = upload({ release: rel.id, name: "other.csv", size: bytes.length, sha256: "0".repeat(64), contentType: "text/csv" });
    await assert.rejects(assetUploadSpec.perform(await ctxFor(wrong, id, { bytes })), (e: unknown) => e instanceof ForgeProblem && e.code === "digest_mismatch");
    assert.deepEqual((await ada().releases.get(REF, rel.id)).assets.map((a) => a.name), ["figure-2.csv"]);
    // No file with the action (act's own route): refused.
    await assert.rejects(assetUploadSpec.perform(await ctxFor(parsed, id)), (e: unknown) => e instanceof ForgeProblem && e.code === "no_file");
    // Deleted with its name typed.
    const asset = (await ada().releases.get(REF, rel.id)).assets[0];
    const del = { release: rel.id, id: asset.id, confirm: "figure-2.csv" };
    const gone = await assetDeleteSpec.perform(await ctxFor(del, id));
    assert.equal(gone.result.name, "figure-2.csv");
    assert.deepEqual((await ada().releases.get(REF, rel.id)).assets, []);
    // An immutable release's files are locked.
    memRepo(id).immutableReleases = true;
    const locked = await ada().releases.create(REF, { tagName: "v2", target: head });
    const p2 = upload({ release: locked.id, name: "late.csv", size: bytes.length, sha256: await sha(bytes), contentType: "text/csv" });
    await assert.rejects(assetUploadSpec.perform(await ctxFor(p2, id, { bytes })), (e: unknown) => e instanceof ForgeProblem && e.code === "immutable");
  });

  test("through act, without the file: refused, nothing written; the size cap and the names", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const rel = await ada().releases.create(REF, { tagName: "v1", target: head, draft: true });
    const run = await authorize(w, b, on("asset_upload", id, { release: rel.id, name: "a.csv", size: 3, sha256: "c".repeat(64), contentType: "text/csv" }));
    assert.equal(run.act?.status, 400);
    assert.equal(run.actBody!.error.code, "no_file");
    assert.equal(forgeRows(w.forge, "actions").length, 0);
    const big = validateAssetUpload({ release: "1", name: "weights.bin", size: ASSET_UPLOAD_BYTES + 1, sha256: "c".repeat(64), contentType: "application/octet-stream" });
    assert.ok(isProblem(big) && big.status === 413 && /GitHub's own release page/.test(big.message));
    for (const name of ["", "a/b.csv", "..", "a\u0000", " lead"]) assert.ok(isProblem(validateAssetUpload({ release: "1", name, size: 1, sha256: "c".repeat(64), contentType: "text/csv" })), name);
  });
});

describe("the registry and FORGE_OPEN", () => {
  test("every release kind is registered from act-releases.ts", () => {
    for (const spec of RELEASE_ACTIONS) {
      assert.equal(REGISTERED_IN[spec.kind], "act-releases.ts");
      assert.equal(ACTIONS.get(spec.kind), spec);
      assert.ok((ACTION_KINDS as readonly string[]).includes(spec.kind));
      assert.equal(spec.needsRepo, false);
    }
    assert.equal(RELEASE_ACTIONS.length, 9);
  });

  test("closed to everyone but the owner while FORGE_OPEN is unset", async () => {
    w.restore();
    w = forgeWorld();
    const { id, head } = await repository();
    const bob = await signIn(w, "bob");
    const run = await authorize(w, bob, on("release_create", id, { tag: "v1", target: head }), { login: "bob" });
    assert.equal(run.start.status, 403);
    assert.equal(run.startBody.error.code, "forge_closed");
    const ada2 = await signIn(w);
    const owner = await authorize(w, ada2, on("release_create", id, { tag: "v1", target: head }));
    assert.equal(owner.act?.status, 200, JSON.stringify(owner.actBody));
  });

  test("validation: tags, targets, latest, the research part, the sentence of a draft", () => {
    for (const tag of ["v1.0.0", "paper/v2", "2026.09", "v1.0.0-rc.1+build.5"]) assert.ok(isTagName(tag), tag);
    for (const tag of ["", "HEAD", "refs/tags/v1", "-v1", "v 1", "a..b", "v1.lock", "v1@{0}"]) assert.ok(!isTagName(tag), tag);
    const head = "d".repeat(40);
    assert.ok(isProblem(validateReleaseCreate({ tag: "v1", target: "main" })), "a branch is not the commit the page showed");
    assert.ok(isProblem(validateReleaseCreate({ tag: "v1", target: head, draft: true, latest: "true" })));
    assert.ok(isProblem(validateReleaseCreate({ tag: "v1", target: head, prerelease: true, latest: "true" })));
    assert.ok(isProblem(validateReleaseCreate({ tag: "v1", target: head, map: MAP })));
    assert.ok(isProblem(validateReleaseCreate({ tag: "v1", target: head, deposit: true, paper: { doi: "10.1234/x", version: "published" } })));
    assert.ok(isProblem(validateReleaseCreate({ tag: "v1", target: head, name: "x".repeat(257) })));
    const p = validateReleaseCreate({ tag: "v0.1.0", target: head.toUpperCase().replace(/D/g, "d"), draft: true, name: "First", prerelease: true }) as CreateParsed;
    assert.equal(describeReleaseCreate(p), "Save the draft release v0.1.0 “First” at commit ddddddd (a pre-release)");
  });
});

describe("the signed-in layer (GET /api/forge/repo)", () => {
  test("the live ties and what the Mac answered for the releases, never who asked", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    await w.forge.batch([
      w.forge.prepare("INSERT INTO release_papers (forge, repo_id, tag, paper_id, release_id, repo_path, version, label, commit_sha, map_digest, status, by_user, at) VALUES ('memory', ?, 'v1.0.0', ?, '7', 'ada-fixture/eeg', 'accepted', 'revision 2', ?, ?, 'linked', 'u_secret', ?)").bind(id, PAPER, head, MAP, T0),
      w.forge.prepare("INSERT INTO jobs (kind, forge, repo_id, ref, user_id, created_at, paper_id, proof, done_at, outcome, message) VALUES ('deposit', 'memory', ?, 'v1.0.0', 'u_secret', ?, ?, 'orcid-sandbox', ?, 'done', 'Deposited on Zenodo (sandbox).')").bind(id, T0, PAPER, T0 + 60),
      w.forge.prepare("INSERT INTO jobs (kind, forge, repo_id, ref, user_id, created_at, paper_id) VALUES ('release', 'memory', ?, 'v1.0.0', 'u_secret', ?, ?)").bind(id, T0, PAPER),
    ]);
    const res = await b.fetch(`/api/forge/repo?id=memory:${id}`);
    assert.equal(res.status, 200);
    const layer = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(layer.releaseTies, [{ tag: "v1.0.0", paper: "10.1234/eeg.2026", version: "accepted", label: "revision 2", status: "linked", commit: head, shown: MAP }]);
    assert.deepEqual(layer.answered, [{ kind: "deposit", ref: "v1.0.0", paper: "10.1234/eeg.2026", outcome: "done", message: "Deposited on Zenodo (sandbox).", doneAt: T0 + 60 }]);
    assert.deepEqual((layer.jobs as { kind: string }[]).map((j) => j.kind), ["release"]);
    assert.ok(!JSON.stringify(layer).includes("u_secret"));
    assert.deepEqual(w.forge.scans, []);
  });
});
