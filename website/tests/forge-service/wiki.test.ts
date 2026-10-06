// The wiki as authorized commits on a `wiki` branch (night phase 06, E4; act-wiki.ts): the first
// page makes the branch (createFrom the repository's head), later pages commit onto it (expectedHead
// the wiki head the page saw), as the person, in ONE commit each; the action row is the only row
// written; a page name that is a path or a reserved "_" page is refused; a page is deleted; history
// is the wiki branch's commits (read from GitHub). D00-6: OSCR never writes to GitHub itself.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { describeWiki, validateWiki, WIKI_ACTIONS, wikiFile, wikiSpec, type WikiParsed } from "../../worker/forge/service/act-wiki.ts";
import { ACTIONS, REGISTERED_IN } from "../../worker/forge/service/actions.ts";
import { ACTION_KINDS, isProblem } from "../../worker/forge/service/types.ts";
import { text, utf8 } from "../../worker/forge/objects.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });

async function repository(): Promise<{ id: string; head: string }> {
  const info = await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true });
  return { id: info.key.id, head: await ada().git.resolve(REF, "main") };
}

const wikiStart = (id: string, expectedHead: string, payload: Record<string, unknown>): StartInput => ({
  kind: "wiki_edit",
  repo: { forge: "memory", id },
  branch: "wiki",
  expectedHead,
  payload: { message: "Edit the wiki", ...payload },
  back: "/r/ada-fixture/eeg/wiki/Home",
});

describe("the pure core", () => {
  test("registered in act-wiki.ts, and wiki_edit is an action kind", () => {
    assert.equal(ACTIONS.get("wiki_edit"), wikiSpec);
    assert.equal(REGISTERED_IN.wiki_edit, "act-wiki.ts");
    assert.ok((ACTION_KINDS as readonly string[]).includes("wiki_edit"));
    assert.equal(WIKI_ACTIONS.length, 1);
  });

  test("a page name is a title, not a path or a reserved _ page; the file is the slug with .md", () => {
    const ok = validateWiki({ base: "a".repeat(40), message: "m", pages: [{ slug: "Getting started", content: "# Hi" }] });
    assert.ok(!isProblem(ok));
    assert.equal(wikiFile("Getting started"), "Getting-started.md");
    assert.ok(isProblem(validateWiki({ base: "a".repeat(40), message: "m", pages: [{ slug: "../etc/passwd", content: "x" }] })));
    assert.ok(isProblem(validateWiki({ base: "a".repeat(40), message: "m", pages: [{ slug: "_Sidebar", content: "x" }] })));
    assert.ok(isProblem(validateWiki({ base: "a".repeat(40), message: "two\nlines", pages: [{ slug: "Home", content: "x" }] })));
    // Nothing to change.
    assert.ok(isProblem(validateWiki({ base: "a".repeat(40), message: "m", pages: [] })));
    // Creating the branch needs createFrom, not a base.
    assert.ok(!isProblem(validateWiki({ createFrom: "b".repeat(40), message: "m", pages: [{ slug: "Home", content: "x" }] })));
    assert.match(describeWiki(validateWiki({ createFrom: "b".repeat(40), message: "Start", pages: [{ slug: "Home", content: "x" }], sidebar: "* Home" }) as WikiParsed), /start the repository's wiki branch/);
  });
});

describe("the wiki through start, GitHub and act", () => {
  test("the first page makes the wiki branch; a later page commits onto it; history is the branch's commits", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    w.forge.reset();
    // Create the wiki branch with Home and a sidebar.
    const first = await authorize(w, b, wikiStart(id, head, { base: "", createFrom: head, message: "Start the wiki", pages: [{ slug: "Home", content: "# Home\nWelcome to ada@example.org" }], sidebar: "* [Home](Home)" }));
    assert.equal(first.act?.status, 200, JSON.stringify(first.actBody));
    const r1 = first.actBody!.result;
    assert.equal(r1.newBranch, true);
    assert.equal(r1.branch, "wiki");
    assert.equal(r1.page, "/r/ada-fixture/eeg/wiki/Home");
    // The content is committed to GitHub verbatim (a commit to the person's own repo is their text).
    const home1 = text((await ada().git.readFile(REF, "wiki", "Home.md")).bytes);
    assert.match(home1, /Welcome to ada@example\.org/);
    assert.ok(text((await ada().git.readFile(REF, "wiki", "_Sidebar.md")).bytes).includes("[Home]"));
    // The only row written is the action row.
    assert.equal(w.forge.totals.written, 1);
    assert.equal((forgeRows(w.forge, "actions")[0] as { kind: string }).kind, "wiki_edit");

    // Edit the page: commit onto the wiki branch at its head.
    const wikiHead = await ada().git.resolve(REF, "wiki");
    const second = await authorize(w, b, wikiStart(id, wikiHead, { base: wikiHead, message: "Update Home", pages: [{ slug: "Home", content: "# Home\nUpdated" }] }));
    assert.equal(second.act?.status, 200, JSON.stringify(second.actBody));
    assert.deepEqual(second.actBody!.result.base, { branch: "wiki", sha: wikiHead });
    assert.match(text((await ada().git.readFile(REF, "wiki", "Home.md")).bytes), /Updated/);
    // History: the edit's commit sits on top of the previous wiki head (git-versioned, D00-6).
    const newHead = await ada().git.resolve(REF, "wiki");
    assert.deepEqual((await ada().git.commit(REF, newHead)).parents, [wikiHead]);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a page is deleted; a page name reserved by GitHub (_Footer) is set through its own field", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    await authorize(w, b, wikiStart(id, head, { base: "", createFrom: head, message: "Start", pages: [{ slug: "Home", content: "# Home" }, { slug: "Methods", content: "# Methods" }] }));
    const wikiHead = await ada().git.resolve(REF, "wiki");
    const run = await authorize(w, b, wikiStart(id, wikiHead, { base: wikiHead, message: "Tidy", pages: [{ slug: "Methods", delete: true }], footer: "Made with OSCR" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(await ada().git.readFile(REF, "wiki", "Methods.md").then(() => true, () => false), false);
    assert.ok(text((await ada().git.readFile(REF, "wiki", "_Footer.md")).bytes).includes("Made with OSCR"));
  });
});
