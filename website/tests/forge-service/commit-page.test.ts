// A web commit from the page's side (night phase 03, E3): the commit declared by the page
// (src/lib/commit-view.ts, the Worker's own sentence), started with the editor's draft named
// (forge-client.ts `startAction(…, {drafts})`), approved on the double's GitHub, and carried out by
// the callback page (forge-authorized.ts `arrive`): the answer's links are the registry's own
// viewer (never another site), and the draft is dropped on success only — a refused commit (the
// branch moved) keeps it for the editor.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ORIGIN } from "../account/browser.ts";
import { declareCommit } from "../../src/lib/commit-view.ts";
import { draftKey } from "../../src/lib/editor.ts";
import { ACT_PATH } from "../../src/lib/forge.ts";
import { text, utf8 } from "../../worker/forge/objects.ts";
import { signIn } from "./authorize.ts";
import { ADA_LOGIN, forgeWorld, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });

function store(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}

function pageFetch(b: ForgeBrowser, log: string[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if ((init.method ?? "GET") === "POST") headers.Origin = ORIGIN;
    log.push(String(input));
    return b.fetch(String(input), { method: init.method, headers, body: typeof init.body === "string" ? init.body : undefined });
  }) as typeof fetch;
}

async function repository(): Promise<{ id: string; head: string }> {
  const info = await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true });
  return { id: info.key.id, head: await ada().git.resolve(REF, "main") };
}

describe("a commit from the page", () => {
  test("declared, started with its draft, approved, carried out: the viewer's links, the draft dropped", async () => {
    const { startAction } = await import("../../src/scripts/forge-client.ts");
    const { arrive } = await import("../../src/scripts/forge-authorized.ts");
    const b = await signIn(w);
    const { id, head } = await repository();
    const local = store();
    const key = draftKey(REF, "main", "edit:README.md");
    local.setItem(key, "{}");
    local.setItem("unrelated", "kept");
    const d = declareCommit({ ...REF, id, forge: "memory" }, { branch: "main", base: head, message: "Say what the code does", changes: [{ op: "put", path: "README.md", text: "# eeg\n\nBand power.\n" }] }, "/r/ada-fixture/eeg/edit/main/README.md");
    assert.ok("input" in d);
    const tab = store();
    const log: string[] = [];
    const assigned: string[] = [];
    const deps = { fetch: pageFetch(b, log), storage: tab, local, assign: (u: string) => void assigned.push(u), now: () => T0 };
    const started = await startAction(d.input, d.sentence, deps, { drafts: [key, "not-a-draft"] });
    assert.equal(started.ok, true, JSON.stringify(started));
    const { code, state } = w.backend.authorize(assigned[0], ADA_LOGIN);
    const said = await arrive(`?code=${code}&state=${state}`, deps);
    assert.equal(said[0].tone, "ok", JSON.stringify(said));
    assert.equal(said[0].text[0], "Done, as you, on GitHub: Commit “Say what the code does” to the branch main (1 file written).");
    const sha = await ada().git.resolve(REF, "main");
    assert.deepEqual(said[0].links, [
      { href: "/r/ada-fixture/eeg/blob/main/README.md", text: "The file, as committed" },
      { href: `/r/ada-fixture/eeg/commit/${sha}/`, text: "The commit" },
      { href: "/r/ada-fixture/eeg/edit/main/README.md", text: "Back to the page you came from" },
    ]);
    assert.match(text((await ada().git.readFile(REF, "main", "README.md")).bytes), /Band power/);
    assert.equal(local.map.has(key), false);
    assert.equal(local.map.get("unrelated"), "kept");
    assert.equal(log.filter((p) => p === ACT_PATH).length, 1);
  });

  test("the branch moved before GitHub came back: refused, the draft kept, the new branch offered", async () => {
    const { startAction } = await import("../../src/scripts/forge-client.ts");
    const { arrive } = await import("../../src/scripts/forge-authorized.ts");
    const b = await signIn(w);
    const { id, head } = await repository();
    const local = store();
    const key = draftKey(REF, "main", "edit:README.md");
    local.setItem(key, "{}");
    const d = declareCommit({ ...REF, id, forge: "memory" }, { branch: "main", base: head, message: "Mine", changes: [{ op: "put", path: "README.md", text: "mine\n" }] }, "/r/ada-fixture/eeg/edit/main/README.md");
    assert.ok("input" in d);
    const assigned: string[] = [];
    const deps = { fetch: pageFetch(b, []), storage: store(), local, assign: (u: string) => void assigned.push(u), now: () => T0 };
    assert.equal((await startAction(d.input, d.sentence, deps, { drafts: [key] })).ok, true);
    await ada().git.createCommit(REF, { branch: "main", expectedHead: head, message: "Theirs", changes: [{ op: "put", path: "other.txt", content: utf8("x\n") }] });
    const { code, state } = w.backend.authorize(assigned[0], ADA_LOGIN);
    const said = await arrive(`?code=${code}&state=${state}`, deps);
    assert.equal(said[0].tone, "warning");
    assert.match(said[0].text.join(" "), /offers to put your change on a new branch/);
    assert.deepEqual(said[0].links, [{ href: "/r/ada-fixture/eeg/edit/main/README.md", text: "Back to the page you came from" }]);
    assert.equal(local.map.has(key), true);
  });

  test("an answer's links are the registry's viewer only: another site, a script or a dot segment is dropped", async () => {
    const { viewerLinks } = await import("../../src/scripts/forge-client.ts");
    assert.deepEqual(
      viewerLinks([
        { href: "/r/ada/eeg/commit/abc/", text: "The commit" },
        { href: "/r/ada/eeg/compare/main...bob:bob-patch-1/", text: "The comparison" },
        { href: "https://evil.test/r/ada/eeg/", text: "x" },
        { href: "//evil.test/r/a/b/", text: "x" },
        { href: "/r/ada/eeg/../../account/", text: "x" },
        { href: "/r//evil.test/x/", text: "x" },
        { href: "javascript:alert(1)", text: "x" },
        { href: "/api/forge/act", text: "x" },
        { href: "/r/ada/eeg/", text: "" },
      ]),
      [
        { href: "/r/ada/eeg/commit/abc/", text: "The commit" },
        { href: "/r/ada/eeg/compare/main...bob:bob-patch-1/", text: "The comparison" },
      ],
    );
    assert.deepEqual(viewerLinks("nope"), []);
  });
});
