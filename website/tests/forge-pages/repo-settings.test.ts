// The repository's Settings and Branches pages (night phase 01, E8; src/lib/repo-settings-view.ts,
// src/scripts/repo-settings.ts, repo-branches.ts): who may act, the typed-name check (exact), what a
// deletion and a transfer change, GitHub's branch views, the default branch never offered for
// deletion, each action declared as the Worker checks it and started with the payload's digest, and
// the pages' classes all science.css's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { payloadText, type ShellLayer, type ShellRepo } from "../../src/lib/forge.ts";
import {
  access,
  ago,
  branchView,
  declare,
  deletable,
  deleteConsequences,
  STALE_SECONDS,
  SUGGESTED_AUTOLINKS,
  transferText,
  typedNameMatches,
  type BranchRow,
} from "../../src/lib/repo-settings-view.ts";
import { TRANSFER_EFFECTS } from "../../worker/forge/service/act-settings.ts";
import { ACTIONS } from "../../worker/forge/service/actions.ts";
import { checkAutolink } from "../../worker/forge/paths.ts";
import { isProblem } from "../../worker/forge/service/types.ts";

const NOW = 1_790_596_800;
const layer = (o: Partial<ShellLayer> = {}): ShellLayer => ({
  forge: "github",
  id: "101",
  mode: "created",
  state: "active",
  headAt: null,
  lastSeen: null,
  papers: [],
  maps: 0,
  paths: null,
  deleteAfter: null,
  roles: ["owner"],
  ...o,
});
const shell = (o: Partial<ShellRepo> = {}): ShellRepo => ({
  forge: "github",
  owner: "Ada-Fixture",
  name: "EEG",
  view: "settings",
  id: "101",
  defaultBranch: "main",
  empty: false,
  archived: false,
  isTemplate: false,
  description: "",
  homepage: "",
  topics: [],
  permission: null,
  web: "https://github.com/Ada-Fixture/EEG",
  layer: layer(),
  signedIn: true,
  ...o,
});

describe("who may act here", () => {
  test("signed in, on a repository the registry follows, as its owner, maintainer or linker", () => {
    assert.equal(access(shell(), "the registry").act, true);
    for (const roles of [["maintainer"], ["linked_by"]]) assert.equal(access(shell({ layer: layer({ roles }) }), "x").act, true);
    const reader = access(shell({ layer: layer({ roles: ["verified_author"] }) }), "the registry");
    assert.deepEqual([reader.act, /settings on GitHub show what you may change/.test(reader.why)], [false, true]);
    assert.match(access(shell({ signedIn: false }), "the registry").why, /Sign in with GitHub/);
    assert.match(access(shell({ layer: null }), "the registry").why, /link it first/);
    assert.equal(access(shell({ layer: layer({ state: "hidden" }) }), "x").act, false);
  });
});

describe("deletion and transfer", () => {
  test("the typed name is exact: letter case and owner", () => {
    const repo = { owner: "Ada-Fixture", name: "EEG" };
    assert.equal(typedNameMatches("Ada-Fixture/EEG", repo), true);
    for (const typed of ["ada-fixture/eeg", "EEG", "Ada-Fixture/EEG ", "other/EEG", "Ada-Fixture/EEG2", ""]) assert.equal(typedNameMatches(typed, repo), false, typed);
  });

  test("the deletion says the maps and paths that point to it, the grace period, and GitHub's own", () => {
    const said = deleteConsequences(shell({ layer: layer({ maps: 3, paths: 12 }) }), "the registry").join(" ");
    assert.match(said, /3 tracing maps point to it, through 12 traced paths/);
    assert.match(said, /30 days/);
    assert.match(said, /your own act/);
    assert.match(said, /90 days/);
    assert.match(said, /GitHub Pages site/);
    assert.match(deleteConsequences(shell(), "x")[0], /No tracing map points to it/);
    assert.match(deleteConsequences(shell({ layer: layer({ maps: 1, paths: 1 }) }), "x")[0], /1 tracing map points to it, through 1 traced path:/);
  });

  test("the transfer lists every side effect GitHub documents, and the acceptance", () => {
    const text = transferText("new-lab");
    for (const effect of TRANSFER_EFFECTS) assert.ok(text.includes(effect), effect);
    assert.match(text[0], /new-lab must accept it on GitHub within a day/);
  });
});

describe("the actions, declared as the Worker checks them", () => {
  test("each kind with the Worker's own sentence and target; a bad payload said before anything is sent", () => {
    const repo = shell();
    const back = "/r/Ada-Fixture/EEG/settings/";
    const cases: [Parameters<typeof declare>[1], Record<string, unknown>, RegExp][] = [
      ["rename", { name: "eeg-study" }, /^Rename the repository to eeg-study\.$/],
      ["topics", { topics: ["eeg"] }, /^Set the repository's topics: eeg\.$/],
      ["template", { template: true }, /^Mark the repository as a template\.$/],
      ["archive", {}, /^Archive the repository on GitHub/],
      ["delete_request", { confirmName: "Ada-Fixture/EEG", maps: 0 }, /^Ask for the deletion of Ada-Fixture\/EEG/],
      ["branch_create", { name: "draft", from: "main" }, /^Create the branch draft from main\.$/],
      ["autolink_create", { ...SUGGESTED_AUTOLINKS[0] }, /^Link every “RRID:SCR_…”/],
    ];
    for (const [kind, payload, sentence] of cases) {
      const d = declare(repo, kind, payload, back);
      assert.ok(!("problem" in d), kind);
      assert.match(d.sentence, sentence);
      assert.deepEqual(d.input.repo, { forge: "github", id: "101" });
      assert.equal(d.input.kind, kind);
      assert.equal(d.input.back, back);
      assert.ok(!isProblem(ACTIONS.get(kind)?.validate(payload)));
    }
    const bad = declare(repo, "rename", { name: "a b" }, back);
    assert.ok("problem" in bad);
    assert.ok("problem" in declare(shell({ id: null, layer: null }), "archive", {}, back));
  });

  test("starting one: the start gets the declaration and the payload's SHA-256, never the payload", async () => {
    const { startAction } = await import("../../src/scripts/forge-client.ts");
    const d = declare(shell(), "rename", { name: "eeg-study" }, "/r/Ada-Fixture/EEG/settings/");
    assert.ok(!("problem" in d));
    const sent: { path: string; body: string }[] = [];
    const fetch = (async (path: string, init: RequestInit = {}) => {
      sent.push({ path: String(path), body: typeof init.body === "string" ? init.body : "" });
      if (String(path) === "/api/account/me") return new Response(JSON.stringify({ signed_in: true, csrf: "c".repeat(43) }));
      return new Response(JSON.stringify({ location: "https://github.com/login/oauth/authorize?state=x" }));
    }) as typeof globalThis.fetch;
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const out = await startAction(d.input, d.sentence, { fetch, storage, assign: () => undefined });
    assert.equal(out.ok, true);
    const start = JSON.parse(sent.find((s) => s.path === "/api/forge/start")?.body ?? "{}");
    assert.equal(start.kind, "rename");
    assert.deepEqual(start.repo, { forge: "github", id: "101" });
    assert.equal(start.digest, createHash("sha256").update(payloadText({ name: "eeg-study" })).digest("hex"));
    assert.ok(!JSON.stringify(start).includes("eeg-study"));
  });

  test("the suggested autolinks are ones GitHub takes", () => {
    for (const s of SUGGESTED_AUTOLINKS) assert.deepEqual(checkAutolink(s), { keyPrefix: s.keyPrefix, urlTemplate: s.urlTemplate, isAlphanumeric: s.isAlphanumeric });
  });
});

describe("branches", () => {
  const day = 86_400;
  const rows: BranchRow[] = [
    { name: "main", sha: "a".repeat(40), protected: true, date: NOW - day, author: "ada-fixture" },
    { name: "feature-eeg", sha: "b".repeat(40), protected: false, date: NOW - 2 * day, author: "ada-fixture" },
    { name: "old-idea", sha: "c".repeat(40), protected: false, date: NOW - STALE_SECONDS - day, author: "ada-fixture" },
    { name: "bobs-fix", sha: "d".repeat(40), protected: false, date: NOW - 3 * day, author: "bob" },
    { name: "Fix-Plots", sha: "e".repeat(40), protected: false, date: NOW - 10 * day, author: null },
    { name: "unread", sha: "f".repeat(40), protected: false, date: null, author: null },
  ];
  const o = { defaultBranch: "main", me: "Ada-Fixture", now: NOW };
  const names = (r: BranchRow[]) => r.map((x) => x.name);

  test("GitHub's views: default, yours, active (under 3 months), stale, all; newest first", () => {
    assert.deepEqual(names(branchView(rows, "default", o)), ["main"]);
    assert.deepEqual(names(branchView(rows, "yours", o)), ["feature-eeg", "old-idea"]);
    assert.deepEqual(names(branchView(rows, "active", o)), ["feature-eeg", "bobs-fix", "Fix-Plots"]);
    assert.deepEqual(names(branchView(rows, "stale", o)), ["old-idea"]);
    assert.deepEqual(names(branchView(rows, "all", o)), ["bobs-fix", "feature-eeg", "Fix-Plots", "main", "old-idea", "unread"]);
    assert.equal(names(branchView(rows, "overview", o))[0], "main");
    assert.deepEqual(names(branchView(rows, "yours", { ...o, me: null })), []);
  });

  test("the search filters by name, letter case aside", () => {
    assert.deepEqual(names(branchView(rows, "all", { ...o, query: "FIX" })), ["bobs-fix", "Fix-Plots"]);
    assert.deepEqual(names(branchView(rows, "active", { ...o, query: "plots" })), ["Fix-Plots"]);
  });

  test("the default branch, and a protected one, are never offered for deletion", () => {
    assert.equal(deletable(rows[0], "main"), false);
    assert.equal(deletable({ ...rows[1], protected: true }, "main"), false);
    assert.equal(deletable(rows[1], "main"), true);
    assert.equal(deletable(rows[1], "feature-eeg"), false);
  });

  test("dates in words", () => {
    assert.equal(ago(null, NOW), "not read");
    assert.equal(ago(NOW - 30, NOW), "just now");
    assert.equal(ago(NOW - 2 * day, NOW), "2 days ago");
    assert.equal(ago(NOW - 95 * day, NOW), "3 months ago");
    assert.equal(ago(NOW - 400 * day, NOW), "1 year ago");
  });
});

describe("the pages' markup", () => {
  test("text nodes only, no inline style or handler, and every class is science.css's", () => {
    const css = readFileSync(new URL("../../src/styles/science.css", import.meta.url), "utf8");
    for (const file of ["repo-settings.ts", "repo-branches.ts"]) {
      const src = readFileSync(new URL(`../../src/scripts/${file}`, import.meta.url), "utf8");
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\b|setAttribute\("style"|setAttribute\("on/.test(src), file);
      const classes = new Set([...src.matchAll(/class: "([a-z -]+)"|className = "([a-z -]+)"/g)].flatMap((m) => (m[1] ?? m[2]).split(" ")));
      for (const c of classes) assert.ok(new RegExp(`\\.${c}\\b`).test(css), `${file}: .${c} is not in science.css`);
    }
    const settings = readFileSync(new URL("../../src/scripts/repo-settings.ts", import.meta.url), "utf8");
    for (const kind of ["rename", "edit", "topics", "features", "template", "default_branch", "autolink_create", "autolink_delete", "papers", "software_heritage", "archive", "unarchive", "transfer", "delete_request", "restore", "delete_final"]) {
      assert.ok(settings.includes(`"${kind}"`), kind);
    }
    const branches = readFileSync(new URL("../../src/scripts/repo-branches.ts", import.meta.url), "utf8");
    for (const kind of ["branch_create", "branch_rename", "branch_delete"]) assert.ok(branches.includes(`"${kind}"`), kind);
  });
});
