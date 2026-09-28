// The /r/ shell (night phase 01, E7): what it shows of a repository, in plain words.
// - src/lib/repo-view.ts: the status line for every mode and state, the heading line, the papers,
//   "no longer at the source", the GitHub Pages site, the README excerpt (emails masked), the
//   degraded states in words, the layer's parsing, and the reading itself (loadRepository) against
//   the fake GitHub (tests/forge/fake-github.ts) through the real GitHub adapter, on an anonymous
//   session: a repository, an empty repository, a renamed one, a rate limit, an offline device.
// - src/scripts/repo-code-panel.ts: the Code button's panel and the quick setup, whose every git
//   address and link is GitHub's (D00-3), never one of the registry's.
// - src/pages/r/index.astro: one static shell, its script a file (no inline script).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { GitBackendError } from "../../worker/forge/errors.ts";
import { githubBackend } from "../../worker/forge/github/index.ts";
import type { GitSession } from "../../worker/forge/gitbackend.ts";
import { utf8 } from "../../worker/forge/objects.ts";
import { layerShard, layerUrl, type ShellLayer } from "../../src/lib/forge.ts";
import {
  dateOf,
  degradedBlock,
  type El,
  githubEndpoints,
  goneBlock,
  h,
  latestCommit,
  link,
  loadRepository,
  pagesBlock,
  pagesSite,
  papersBlock,
  parseLayer,
  readLayer,
  readmeExcerpt,
  renamedPath,
  repoHead,
  repoTabs,
  safeHref,
  shellRepo,
  shellTarget,
  statusLine,
  swhUrl,
  textOf,
  walk,
} from "../../src/lib/repo-view.ts";
import { codePanel, commandBranch, quickSetup, remoteCommands, useTemplate } from "../../src/scripts/repo-code-panel.ts";
import { FakeGitHub } from "../forge/fake-github.ts";
import { MemoryBackend } from "../forge/memory.ts";

const EEG = { owner: "oscr-fixture", name: "eeg-analysis" };
const SITE = "OSCR";
const DAY = 1_790_000_000; // 21 September 2026
const EMAIL = "private.person@example.org";

const layer = (o: Partial<ShellLayer> = {}): ShellLayer => ({
  forge: "github",
  id: "501",
  mode: "installed",
  state: "active",
  headAt: null,
  lastSeen: null,
  papers: [],
  maps: 0,
  paths: null,
  deleteAfter: null,
  roles: [],
  ...o,
});

const hrefs = (node: El): string[] => [...walk(node)].map((e) => e.attrs.href).filter((x): x is string => typeof x === "string");

/** Plain words: no pill, no badge, no uppercase styling, no style attribute; the only classes are
 *  the sentence's own and the warning colour. */
function plainWords(line: El): void {
  assert.equal(line.tag, "p");
  assert.match(line.attrs.class, /^status-line( warning)?$/);
  for (const e of walk(line)) {
    assert.equal(e.attrs.style, undefined);
    assert.doesNotMatch(e.attrs.class ?? "", /pill|badge|label|tag|upper/);
  }
  const words = textOf(line).replaceAll(SITE, "").replaceAll("App", "");
  assert.doesNotMatch(words, /\b[A-Z]{2,}\b/, `no word in capitals: ${textOf(line)}`);
  assert.match(textOf(line), /\.$/, "a sentence");
}

describe("the status line, in words", () => {
  test("each mode, with and without the dates", () => {
    const cases: [Partial<ShellLayer>, string][] = [
      [{ mode: "installed", headAt: DAY }, "Linked to OSCR with the App installed: OSCR receives its pushes; last push seen 21 September 2026."],
      [{ mode: "installed" }, "Linked to OSCR with the App installed: OSCR receives its pushes; no push seen yet."],
      [{ mode: "created", headAt: DAY }, "Created with OSCR, with the App installed: OSCR receives its pushes; last push seen 21 September 2026."],
      [{ mode: "public", lastSeen: DAY }, "Public, without the App: read only, OSCR checks it every night; last seen 21 September 2026."],
      [{ mode: "public" }, "Public, without the App: read only, OSCR checks it every night; not checked yet."],
      [{ mode: "catalogue", lastSeen: DAY }, "Not linked to OSCR. Last seen 21 September 2026."],
      [{ mode: "catalogue" }, "Not linked to OSCR. Not checked yet."],
    ];
    for (const [o, said] of cases) {
      const line = statusLine(layer(o), SITE);
      assert.equal(textOf(line), said);
      plainWords(line);
    }
    // The last push falls back on the last check, and the reverse.
    assert.match(textOf(statusLine(layer({ mode: "installed", lastSeen: DAY }), SITE)), /last push seen 21 September 2026/);
    assert.match(textOf(statusLine(layer({ mode: "public", headAt: DAY }), SITE)), /last seen 21 September 2026/);
  });

  test("not linked at all, and not known just now", () => {
    assert.equal(textOf(statusLine(null, SITE)), "Not linked to OSCR.");
    assert.equal(textOf(statusLine(null, SITE, true)), "Whether it is linked to OSCR could not be read just now.");
    plainWords(statusLine(null, SITE));
    // Without a name handed in, the sentences say "the registry"; a name with an at sign is refused.
    assert.equal(textOf(statusLine(null)), "Not linked to the registry.");
    assert.equal(textOf(statusLine(null, "a@b.org")), "Not linked to the registry.");
  });

  test("a catalogue repository says whose code it is", () => {
    const one = statusLine(layer({ mode: "catalogue", lastSeen: DAY, papers: [{ doi: "10.1234/eeg", slug: "eeg-2026", title: "Resting-state recordings", status: null }] }), SITE);
    assert.equal(textOf(one), "Not linked to OSCR; the catalogue lists it as the code of Resting-state recordings. Last seen 21 September 2026.");
    assert.deepEqual(hrefs(one), ["/paper/eeg-2026/"]);
    const two = statusLine(
      layer({
        mode: "catalogue",
        papers: [
          { doi: "10.1234/eeg", slug: null, title: null, status: null },
          { doi: "10.1234/meg", slug: null, title: null, status: null },
        ],
      }),
      SITE,
    );
    assert.equal(textOf(two), "Not linked to OSCR; the catalogue lists it as the code of 10.1234/eeg and of 1 other paper. Not checked yet.");
    assert.deepEqual(hrefs(two), ["https://doi.org/10.1234/eeg"]);
    plainWords(one);
    plainWords(two);
  });

  test("each state, in words, the warning colour for the ones that matter", () => {
    const base = { mode: "installed" as const, headAt: DAY };
    const archived = statusLine(layer({ ...base, state: "archived" }), SITE);
    assert.match(textOf(archived), / Archived: read only\.$/);
    assert.equal(archived.attrs.class, "status-line");
    const pending = statusLine(layer({ ...base, state: "pending_deletion", deleteAfter: DAY + 30 * 86400 }), SITE);
    assert.match(textOf(pending), / Waiting for deletion: hidden from OSCR after 21 October 2026, unless its owner restores it\.$/);
    assert.equal(pending.attrs.class, "status-line warning");
    assert.match(textOf(statusLine(layer({ ...base, state: "pending_deletion" }), SITE)), / Waiting for deletion\.$/);
    for (const state of ["hidden", "deleted"] as const) assert.match(textOf(statusLine(layer({ ...base, state }), SITE)), / Hidden from OSCR\.$/);
    const gone = statusLine(layer({ ...base, state: "gone" }), SITE);
    assert.match(textOf(gone), / No longer at the source: GitHub does not serve it any more\.$/);
    assert.equal(gone.attrs.class, "status-line warning");
    for (const e of [archived, pending, gone]) plainWords(e);
  });

  test("science.css styles the sentence without uppercase or pills", () => {
    const css = readFileSync(new URL("../../src/styles/science.css", import.meta.url), "utf8");
    const rule = /p\.status-line\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, "p.status-line has a rule");
    assert.doesNotMatch(rule[1], /text-transform|border-radius|letter-spacing/);
  });

  test("dates", () => {
    assert.equal(dateOf(DAY), "21 September 2026");
    for (const v of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(dateOf(v as number), null);
  });
});

describe("the heading line and the tabs", () => {
  const info = { visibility: "public" as const, archived: false, disabled: false, isTemplate: false, parent: null };
  test("owner / name, the owner as GitHub's login, then the facts in words", () => {
    const head = repoHead({ ...EEG, info });
    assert.equal(head.attrs.class, "repo-head");
    assert.equal(textOf(head.children[0] as El), "oscr-fixture / eeg-analysis");
    assert.equal(textOf(head.children[1] as El), "public");
    assert.deepEqual(hrefs(head), ["https://github.com/oscr-fixture"]);
    const all = repoHead({
      ...EEG,
      info: { ...info, isTemplate: true, archived: true, parent: { forge: "github", owner: "lab", name: "base" } },
    });
    const facts = all.children[1] as El;
    assert.equal(facts.attrs.class, "facts");
    assert.deepEqual(facts.children.map((c) => textOf(c)), ["public", "a template", "archived on GitHub: read only", "a fork of lab/base"]);
    assert.ok(hrefs(all).includes("/r/lab/base/"));
    // GitHub has not answered: nothing is claimed.
    const unknown = repoHead({ ...EEG, info: null });
    assert.equal(unknown.children.length, 1);
  });

  test("the tabs are nav.tabs, the current one marked", () => {
    const tabs = repoTabs(EEG, "branches");
    assert.equal(tabs.tag, "nav");
    assert.equal(tabs.attrs.class, "tabs");
    assert.deepEqual(hrefs(tabs), ["/r/oscr-fixture/eeg-analysis/", "/r/oscr-fixture/eeg-analysis/branches/", "/r/oscr-fixture/eeg-analysis/settings/"]);
    const current = [...walk(tabs)].filter((e) => e.attrs["aria-current"] === "page");
    assert.deepEqual(current.map((e) => textOf(e)), ["Branches"]);
  });
});

describe("the Code button and the quick setup: GitHub's addresses only", () => {
  // No address of the registry: its workers.dev host, a domain of its own, a local server.
  const OSCR_HOST = /workers\.dev|\boscr\.[a-z]{2,}\b|localhost|127\.0\.0\.1/;

  test("clone over HTTPS, partial and shallow clones, all to github.com", () => {
    const panel = codePanel(EEG, { defaultBranch: "main", site: SITE });
    assert.equal(panel.tag, "details");
    assert.equal(panel.attrs.class, "panel");
    const text = textOf(panel);
    assert.ok(text.includes("git clone https://github.com/oscr-fixture/eeg-analysis.git"));
    assert.ok(text.includes("git clone --filter=blob:none https://github.com/oscr-fixture/eeg-analysis.git"));
    assert.ok(text.includes("git clone --depth 1 https://github.com/oscr-fixture/eeg-analysis.git"));
    assert.doesNotMatch(text, OSCR_HOST);
    for (const m of text.matchAll(/https?:\/\/[^\s"]+/g)) assert.ok(m[0].startsWith("https://github.com/"), m[0]);
    // Why git needs GitHub's credentials, not the registry's.
    assert.match(text, /GitHub token, never the sign-in of OSCR/);
    assert.match(text, /never sees your code, your password or your token/);
  });

  test("every link of the panel is GitHub's: ZIP, Desktop, Codespaces, the token template", () => {
    const panel = codePanel(EEG, { defaultBranch: "main", site: SITE });
    const links = hrefs(panel);
    assert.ok(links.length >= 5);
    for (const href of links) {
      assert.ok(
        href.startsWith("https://github.com/") || href.startsWith("https://codespaces.new/") || href.startsWith("x-github-client://openRepo/https://github.com/"),
        href,
      );
    }
    assert.ok(links.includes("https://github.com/oscr-fixture/eeg-analysis/archive/refs/heads/main.zip"));
    assert.ok(links.includes("x-github-client://openRepo/https://github.com/oscr-fixture/eeg-analysis"));
    assert.ok(links.includes("https://codespaces.new/oscr-fixture/eeg-analysis"));
    const token = links.find((x) => x.startsWith("https://github.com/settings/personal-access-tokens/new?"));
    assert.ok(token, "the token template link");
    assert.equal(new URL(token).searchParams.get("contents"), "write");
    // Without a default branch, the ZIP is HEAD's.
    assert.ok(hrefs(codePanel(EEG)).includes("https://github.com/oscr-fixture/eeg-analysis/archive/HEAD.zip"));
    // Each block of commands has its Copy button, a plain button.
    const els = [...walk(panel)];
    assert.equal(els.filter((e) => e.tag === "pre").length, els.filter((e) => e.tag === "button").length);
    for (const b of els.filter((e) => e.tag === "button")) assert.deepEqual(b.attrs, { class: "copy", type: "button" });
  });

  test("the remotes: upstream, a changed address, a clone after a rename", () => {
    const fork = remoteCommands(EEG, { parent: { owner: "lab", name: "base" }, defaultBranch: "develop" });
    assert.deepEqual(fork.upstream, ["git remote add upstream https://github.com/lab/base.git", "git fetch upstream", "git merge upstream/develop"]);
    assert.deepEqual(fork.setUrl, ["git remote set-url origin https://github.com/oscr-fixture/eeg-analysis.git", "git remote -v"]);
    assert.equal(fork.afterRename[0], "git remote set-url origin https://github.com/oscr-fixture/eeg-analysis.git");
    assert.ok(fork.afterRename.includes("git branch -u origin/develop develop"));
    assert.ok(textOf(codePanel(EEG, { site: SITE })).includes("git remote add upstream https://github.com/oscr-fixture/eeg-analysis.git"));
  });

  test("a branch name a shell would read never reaches a command", () => {
    assert.equal(commandBranch("main"), "main");
    assert.equal(commandBranch("release/2.0"), "release/2.0");
    for (const bad of ["a;rm -rf ~", "$(id)", "`id`", "a|b", "-x", "a..b", "a/", "a.", "", null, undefined, "x".repeat(101)]) {
      assert.equal(commandBranch(bad), "main", String(bad));
    }
    assert.ok(!remoteCommands(EEG, { defaultBranch: "x;id" }).afterRename.join("\n").includes(";id"));
  });

  test("the quick setup of an empty repository: github.com's https address, GitHub's four ways", () => {
    const setup = quickSetup(EEG, { site: SITE });
    assert.equal(setup.tag, "section");
    assert.equal(setup.attrs.class, "setup");
    const text = textOf(setup);
    assert.ok(text.includes("https://github.com/oscr-fixture/eeg-analysis.git"));
    for (const heading of [
      "Create a new repository on the command line",
      "Push an existing repository from the command line",
      "Add code that is not in git yet",
      "Import code from another repository",
    ]) {
      assert.ok(text.includes(heading), heading);
    }
    for (const line of [
      "git init -b main",
      "git remote add origin https://github.com/oscr-fixture/eeg-analysis.git",
      "git push -u origin main",
      "git branch -M main",
      "git add .",
    ]) {
      assert.ok(text.includes(line), line);
    }
    // Every git address is github.com's, never one of the registry's (D00-3).
    for (const m of text.matchAll(/(?:https?|git|ssh):\/\/[^\s"]+/g)) assert.ok(m[0].startsWith("https://github.com/"), m[0]);
    assert.doesNotMatch(text, OSCR_HOST);
    assert.ok(hrefs(setup).includes("/new/import/"));
    for (const href of hrefs(setup)) assert.ok(href.startsWith("/") && !href.startsWith("//"), href);
    // Another default branch is carried into the commands.
    assert.ok(textOf(quickSetup(EEG, { defaultBranch: "trunk" })).includes("git push -u origin trunk"));
  });

  test("Use this template goes to the creation page, pre-filled", () => {
    assert.deepEqual(hrefs(useTemplate(EEG)), ["/new/?template=oscr-fixture/eeg-analysis"]);
    assert.match(textOf(useTemplate(EEG)), /^Use this template: /);
  });
});

describe("what the shell shows beside: papers, Pages site, archive, a gone repository", () => {
  test("the papers it is attached to, and the maps' promise", () => {
    const l = layer({
      papers: [
        { doi: "10.1234/eeg", slug: "eeg-2026", title: "EEG at rest", status: "linked" },
        { doi: "10.1234/meg", slug: null, title: null, status: "proposed" },
      ],
      maps: 2,
    });
    const block = papersBlock(l, SITE);
    const text = block.map(textOf).join("\n");
    assert.match(text, /EEG at rest/);
    assert.match(text, /10\.1234\/meg \(proposed, not confirmed yet\)/);
    assert.match(text, /2 tracing maps point to its commits\. If the source rewrites its history or disappears, OSCR keeps showing the cited commits/);
    assert.deepEqual(block.flatMap(hrefs), ["/paper/eeg-2026/", "https://doi.org/10.1234/meg"]);
    assert.match(papersBlock(null, SITE).map(textOf).join(""), /Not attached to any paper yet/);
  });

  test("the GitHub Pages site: linked when on github.io, never rebuilt", () => {
    assert.equal(pagesSite("ada", "eeg", "https://ada.github.io/eeg/"), "https://ada.github.io/eeg/");
    assert.equal(pagesSite("Ada", "ada.github.io", ""), "https://ada.github.io/");
    assert.equal(pagesSite("ada", "eeg", "https://example.org/"), null);
    assert.equal(pagesSite("ada", "eeg", "http://ada.github.io/"), null);
    assert.equal(pagesSite("ada", "eeg", "https://evil.github.io.example.org/"), null);
    assert.equal(pagesSite("ada", "eeg", null), null);
    const block = pagesBlock("https://ada.github.io/eeg/", SITE);
    assert.deepEqual(block.flatMap(hrefs), ["https://ada.github.io/eeg/"]);
    assert.match(block.map(textOf).join(""), /never rebuilds it/);
    assert.deepEqual(pagesBlock(null), []);
  });

  test("no longer at the source: the licensed copies and the Software Heritage archive", () => {
    const parsed = parseLayer({
      forge: "github",
      id: 501,
      mode: "public",
      state: "gone",
      papers: [{ doi: "10.1234/eeg", slug: "eeg-2026", title: "EEG at rest" }],
      maps: 1,
      swh: `swh:1:ori:${"a".repeat(40)}`,
    });
    assert.ok(parsed);
    const block = goneBlock(EEG, parsed, SITE);
    const text = textOf(block);
    assert.match(text, /^No longer at the source/);
    assert.match(text, /GitHub does not serve it any more/);
    assert.match(text, /the script copies OSCR keeps \(openly licensed files only\)/);
    assert.match(text, /marked "no longer at the source"/);
    assert.deepEqual(hrefs(block), ["/paper/eeg-2026/#code", `https://archive.softwareheritage.org/swh:1:ori:${"a".repeat(40)}`]);
    assert.match(textOf(goneBlock(EEG, null, SITE)), /OSCR kept no copy of its files\./);
    assert.equal(swhUrl("https://example.org/x"), null);
    assert.equal(swhUrl("swh:1:ori:xyz"), null);
  });
});

describe("masking and links", () => {
  test("a README excerpt: the first real paragraph, emails masked", () => {
    const readme = [
      "# EEG analysis",
      "[![build](https://img.shields.io/x.svg)](https://ci)",
      "",
      `Scripts for the resting-state EEG study. Questions: ${EMAIL}, or see the [paper](https://doi.org/10.1234/eeg).`,
      "",
      "```",
      `git config user.email ${EMAIL}`,
      "```",
    ].join("\n");
    const excerpt = readmeExcerpt(readme);
    assert.ok(!excerpt.includes(EMAIL));
    assert.ok(!excerpt.includes("@"));
    assert.match(excerpt, /^Scripts for the resting-state EEG study\. Questions: .+, or see the paper\.$/);
    // A cut never leaves part of an address.
    const long = `${"word ".repeat(90)}${EMAIL} ${"more ".repeat(40)}`;
    const cut = readmeExcerpt(long, 470);
    assert.ok(!cut.includes("@") && !cut.includes("example.org"), cut);
    assert.ok(cut.endsWith("…"));
    assert.equal(readmeExcerpt(""), "");
  });

  test("every text of a view is masked, and only safe links are kept", () => {
    const el = h("p", { class: "x", style: "color:red", onclick: "x()" } as Record<string, string>, `Write to ${EMAIL}`);
    assert.deepEqual(el.attrs, { class: "x" });
    assert.ok(!textOf(el).includes(EMAIL));
    for (const bad of ["javascript:alert(1)", "//evil.org/", "http://github.com/x", "https://user:pw@github.com/", `mailto:${EMAIL}`, "data:text/html,x", "x-github-client://openRepo/https://evil.org/"]) {
      assert.equal(safeHref(bad), null, bad);
      assert.equal(typeof link(bad, "text"), "string");
    }
    for (const good of ["/r/a/b/", "https://github.com/a/b", "x-github-client://openRepo/https://github.com/a/b"]) assert.equal(safeHref(good), good);
  });

  test("the layer: shard and API shapes, checked field by field, emails dropped", () => {
    const shard = parseLayer({ forge: "github", id: 501, mode: "public", state: "active", head_at: DAY, last_seen: DAY + 1, papers: [{ doi: "10.1234/eeg", slug: "eeg", title: `By ${EMAIL}` }, { doi: "not a doi" }], maps: 3 });
    assert.ok(shard);
    assert.equal(shard.id, "501");
    assert.equal(shard.headAt, DAY);
    assert.equal(shard.lastSeen, DAY + 1);
    assert.equal(shard.papers.length, 1);
    assert.ok(!shard.papers[0].title?.includes(EMAIL));
    const api = parseLayer({ forge: "github", id: "501", mode: "installed", state: "pending_deletion", headAt: DAY, lastSeen: DAY, deleteAfter: DAY + 9, papers: [], roles: ["owner", "Bad Role"], maps: 0 });
    assert.equal(api?.deleteAfter, DAY + 9);
    assert.deepEqual(api?.roles, ["owner"]);
    for (const bad of [null, [], "x", { mode: "mirror" }, { forge: "gitlab", mode: "public" }]) assert.equal(parseLayer(bad), null);
    assert.equal(parseLayer({ mode: "public", state: "weird" })?.state, "active");
  });

  test("GitHub's addresses: GitHub's own, or a mock on this machine only", () => {
    assert.deepEqual(githubEndpoints(), { api: "https://api.github.com", raw: "https://raw.githubusercontent.com", web: "https://github.com" });
    assert.deepEqual(githubEndpoints({ api: "http://localhost:8790/api/", raw: "http://127.0.0.1:8790/raw", web: "https://evil.org" }), {
      api: "http://localhost:8790/api",
      raw: "http://127.0.0.1:8790/raw",
      web: "https://github.com",
    });
    assert.equal(githubEndpoints({ api: "http://evil.org/api" }).api, "https://api.github.com");
  });
});

describe("the shell's paths", () => {
  test("parsing: the three views, and invalid owners or names refused (paths.ts rules)", () => {
    assert.deepEqual(shellTarget("/r/oscr-fixture/eeg-analysis/"), { ...EEG, view: "home" });
    assert.deepEqual(shellTarget("/r/oscr-fixture/eeg-analysis/settings/"), { ...EEG, view: "settings" });
    assert.deepEqual(shellTarget("/r/oscr-fixture/eeg-analysis/branches"), { ...EEG, view: "branches" });
    for (const path of [
      "/r/", "/r/ada/", "/r/ada/eeg.git/", "/r/../eeg/", "/r/ada/../", "/r/a%2Fb/eeg/", "/r/ada/e%20g/",
      "/r/ada/eeg/issues/", "/r/ada/eeg/tree/main/", `/r/${"a".repeat(101)}/eeg/`, "/r/ada/e<script>/",
      "/r/ada@example.org/eeg/", "/r/ada/%E0%A4%A/", "/paper/x/",
    ]) {
      assert.equal(shellTarget(path), null, path);
    }
  });

  test("the page is one static shell whose script is a file, and it names no host of the registry for git", () => {
    const page = readFileSync(new URL("../../src/pages/r/index.astro", import.meta.url), "utf8");
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotMatch(scripts[0][1], /is:inline|define:vars/);
    assert.equal(scripts[0][2].trim(), 'import "../../scripts/repo-shell";');
    assert.doesNotMatch(page, /\bstyle=|<style/);
    assert.match(page, /data-site=\{SITE_NAME\}/);
    const redirects = readFileSync(new URL("../../public/_redirects", import.meta.url), "utf8");
    assert.match(redirects, /^\/r\/\* \/r\/ 200$/m);
  });
});

// ─── reading, against the fake GitHub through the real adapter ───────────────

interface World {
  double: MemoryBackend;
  session: GitSession;
  owner: string;
  /** Requests made to this site (the static shards, the API). */
  site: string[];
  shards: Map<string, Record<string, unknown>>;
  siteFetch: (path: string) => Promise<Response>;
}

async function world(): Promise<World> {
  const double = new MemoryBackend();
  const fake = new FakeGitHub(double, { id: "Iv23liFAKECLIENT", secret: "fake-client-secret" });
  const backend = githubBackend({}, { fetch: fake.fetch, now: () => double.now(), tokenCache: new Map() });
  const owner = "oscr-fixture";
  const token = double.addUser(owner).token();
  // Seeded in the double itself (the adapter's user sessions need the App's settings); read below
  // through the adapter, anonymously, as the reader's browser does.
  const as = double.session({ kind: "user", token });
  const eeg = await as.repos.create({ name: "eeg-analysis", visibility: "public", autoInit: true, description: `EEG scripts; ${EMAIL}`, homepage: "https://oscr-fixture.github.io/eeg-analysis/" });
  const head = await as.git.resolve(eeg.ref, "main");
  await as.git.createCommit(eeg.ref, {
    branch: "main",
    expectedHead: head,
    changes: [{ op: "put", path: "README.md", content: utf8(`# EEG\n\nScripts for the resting-state EEG study, by ${EMAIL}, with the figures of the paper.\n`) }],
    message: `Add the README (${EMAIL})`,
  });
  await as.repos.create({ name: "empty-study", visibility: "public", autoInit: false });
  const shards = new Map<string, Record<string, unknown>>();
  const site: string[] = [];
  const w: World = {
    double,
    session: backend.session({ kind: "anonymous" }),
    owner,
    site,
    shards,
    async siteFetch(path: string) {
      site.push(path);
      const body = shards.get(path);
      return body ? new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }) : new Response("Not found", { status: 404 });
    },
  };
  return w;
}

async function putLayer(w: World, owner: string, name: string, entry: Record<string, unknown>): Promise<void> {
  const url = layerUrl(await layerShard(owner, name));
  w.shards.set(url, { ...(w.shards.get(url) ?? {}), [`${owner}/${name}`.toLowerCase()]: entry });
}

describe("reading a repository in the reader's browser (fake GitHub, anonymous)", () => {
  test("a repository: GitHub's facts, its latest commit, its README excerpt (masked), the static layer", async () => {
    const w = await world();
    const info = await w.session.repos.get({ forge: "github", owner: w.owner, name: "eeg-analysis" });
    await putLayer(w, w.owner, "eeg-analysis", { forge: "github", id: info.key.id, mode: "public", state: "active", last_seen: DAY, papers: [{ doi: "10.1234/eeg", slug: "eeg-2026", title: "EEG at rest" }], maps: 1 });
    const loaded = await loadRepository({ owner: w.owner, name: "eeg-analysis", view: "home" }, { session: w.session, site: w.siteFetch, signedIn: false });
    assert.equal(loaded.error, null);
    assert.equal(loaded.empty, false);
    assert.equal(loaded.info?.defaultBranch, "main");
    assert.equal(loaded.latest?.message.split("\n")[0].includes("Add the README"), true);
    assert.ok(loaded.readme);
    assert.match(loaded.readme.excerpt, /^Scripts for the resting-state EEG study, by /);
    assert.ok(!loaded.readme.excerpt.includes("@"));
    assert.equal(loaded.layer?.mode, "public");
    assert.equal(textOf(statusLine(loaded.layer, SITE)), "Public, without the App: read only, OSCR checks it every night; last seen 21 September 2026.");
    // Signed out: one static file of this site, and no API route.
    assert.deepEqual(w.site, [layerUrl(await layerShard(w.owner, "eeg-analysis"))]);
    const repo = shellRepo(loaded, false);
    assert.equal(repo.defaultBranch, "main");
    assert.ok(!repo.description.includes(EMAIL));
    assert.equal(repo.web, "https://github.com/oscr-fixture/eeg-analysis");
    assert.equal(pagesSite(repo.owner, repo.name, repo.homepage), "https://oscr-fixture.github.io/eeg-analysis/");
    // The latest commit's message is masked too.
    assert.ok(loaded.latest);
    assert.ok(!textOf(latestCommit(loaded.repo, loaded.latest)).includes(EMAIL));
  });

  test("an empty repository: no commit read, the quick setup's facts", async () => {
    const w = await world();
    const loaded = await loadRepository({ owner: w.owner, name: "empty-study", view: "home" }, { session: w.session, site: w.siteFetch, signedIn: false });
    assert.equal(loaded.error, null);
    assert.equal(loaded.empty, true);
    assert.equal(loaded.latest, null);
    assert.equal(loaded.readme, null);
    assert.equal(loaded.layer, null);
    assert.equal(textOf(statusLine(loaded.layer, SITE)), "Not linked to OSCR.");
    assert.match(textOf(quickSetup(loaded.repo, { site: SITE })), /git remote add origin https:\/\/github\.com\/oscr-fixture\/empty-study\.git/);
  });

  test("a renamed repository: GitHub's redirect followed, the page moves to the new name", async () => {
    const w = await world();
    const account = w.double.accountByLogin(w.owner);
    assert.ok(account);
    const owner = w.double.session({ kind: "user", token: w.double.issueToken(account.id) });
    await owner.repos.update({ forge: "memory", owner: w.owner, name: "eeg-analysis" }, { name: "eeg-rest" });
    const loaded = await loadRepository({ owner: w.owner, name: "eeg-analysis", view: "branches" }, { session: w.session, site: w.siteFetch, signedIn: false });
    assert.equal(loaded.error, null);
    assert.equal(loaded.renamed, true);
    assert.deepEqual(loaded.repo, { owner: w.owner, name: "eeg-rest" });
    assert.equal(renamedPath(loaded), "/r/oscr-fixture/eeg-rest/branches/");
    // Not at home: no commit and no README read.
    assert.equal(loaded.latest, null);
  });

  test("GitHub's anonymous limit reached: said in words, with the link to GitHub", async () => {
    const w = await world();
    w.double.limit("anonymous", 0, w.double.now() + 600);
    const loaded = await loadRepository({ owner: w.owner, name: "eeg-analysis", view: "home" }, { session: w.session, site: w.siteFetch, signedIn: false });
    assert.equal(loaded.info, null);
    assert.equal(loaded.error?.code, "rate_limited");
    const said = degradedBlock(loaded.repo, loaded.error);
    assert.equal(said.attrs.class, "warning");
    assert.match(textOf(said), /GitHub's limit for reading without signing in is reached from your connection .*resets in about 10 minutes\./);
    assert.deepEqual(hrefs(said), ["https://github.com/oscr-fixture/eeg-analysis"]);
  });

  test("offline: GitHub and this site unreachable, the page still says what it can", async () => {
    const offline = githubBackend({}, {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      tokenCache: new Map(),
    }).session({ kind: "anonymous" });
    const loaded = await loadRepository(
      { ...EEG, view: "home" },
      {
        session: offline,
        signedIn: true,
        site: async () => {
          throw new TypeError("Failed to fetch");
        },
      },
    );
    assert.equal(loaded.info, null);
    assert.ok(loaded.error instanceof GitBackendError);
    assert.equal(loaded.layerUnknown, true);
    assert.equal(textOf(statusLine(loaded.layer, SITE, loaded.layerUnknown)), "Whether it is linked to OSCR could not be read just now.");
    const said = degradedBlock(loaded.repo, loaded.error);
    assert.match(textOf(said), /GitHub did not answer: it may be down, or this device offline\. Try again in a moment\. The repository is on GitHub: oscr-fixture\/eeg-analysis\./);
    // The clone commands need no request: they stay.
    assert.match(textOf(codePanel(loaded.repo)), /git clone https:\/\/github\.com\/oscr-fixture\/eeg-analysis\.git/);
  });

  test("a repository GitHub no longer serves, known to the layer: no longer at the source", async () => {
    const w = await world();
    await putLayer(w, w.owner, "vanished", { forge: "github", id: "999", mode: "public", state: "gone", papers: [{ doi: "10.1234/old", slug: "old-2020", title: "Old" }], maps: 2 });
    const loaded = await loadRepository({ owner: w.owner, name: "vanished", view: "home" }, { session: w.session, site: w.siteFetch, signedIn: false });
    assert.equal(loaded.error?.code, "not_found");
    assert.equal(loaded.layer?.state, "gone");
    assert.match(textOf(goneBlock(loaded.repo, loaded.layer, SITE)), /The code of Old: the script copies OSCR keeps/);
    assert.match(textOf(degradedBlock(loaded.repo, loaded.error)), /GitHub shows no public repository at this address/);
  });

  test("signed in: the live layer from GET /api/forge/repo, the shard when the API fails", async () => {
    const asked: string[] = [];
    const answer = { forge: "github", id: "501", owner: "oscr-fixture", name: "eeg-analysis", mode: "installed", state: "active", headAt: DAY, lastSeen: DAY, papers: [], roles: ["owner"], maps: 0, paths: 0 };
    const live = await readLayer(EEG, {
      signedIn: true,
      site: async (path) => {
        asked.push(path);
        return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } });
      },
    });
    assert.deepEqual(asked, ["/api/forge/repo?path=oscr-fixture%2Feeg-analysis"]);
    assert.ok(live && live !== "unknown");
    assert.equal(live.mode, "installed");
    assert.deepEqual(live.roles, ["owner"]);
    // Not linked (404): null, no further request.
    asked.length = 0;
    assert.equal(await readLayer(EEG, { signedIn: true, site: async (p) => (asked.push(p), new Response("{}", { status: 404 })) }), null);
    assert.equal(asked.length, 1);
    // D1's quota (503): the static shard says what it knows.
    asked.length = 0;
    const shardUrl = layerUrl(await layerShard(EEG.owner, EEG.name));
    const fallback = await readLayer(EEG, {
      signedIn: true,
      site: async (p) => {
        asked.push(p);
        if (p.startsWith("/api/")) return new Response("{}", { status: 503 });
        return new Response(JSON.stringify({ "oscr-fixture/eeg-analysis": { forge: "github", id: 501, mode: "catalogue", state: "active" } }));
      },
    });
    assert.deepEqual(asked, ["/api/forge/repo?path=oscr-fixture%2Feeg-analysis", shardUrl]);
    assert.ok(fallback && fallback !== "unknown");
    assert.equal(fallback.mode, "catalogue");
  });

  test("the layer names another repository at this address: it is not shown", async () => {
    const w = await world();
    await putLayer(w, w.owner, "eeg-analysis", { forge: "github", id: "123456", mode: "installed", state: "active" });
    const loaded = await loadRepository({ owner: w.owner, name: "eeg-analysis", view: "home" }, { session: w.session, site: w.siteFetch, signedIn: false });
    assert.equal(loaded.otherRepository, true);
    assert.equal(loaded.layer, null);
  });
});
