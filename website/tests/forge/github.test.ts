// The GitHub adapter (worker/forge/github/) with a mocked fetch: for every method, the exact
// request (method, path, query, body, media type), the mapping of GitHub's answer, and the cost;
// then the headers, pagination, the error table, the email guard, secrets, and createCommit's
// two paths. No network: every answer is a fixture shaped like GitHub's documented ones.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { GitBackendError, type GitErrorCode } from "../../worker/forge/errors.ts";
import type { GitSession } from "../../worker/forge/gitbackend.ts";
import { githubBackend, githubConfigFromEnv } from "../../worker/forge/github/index.ts";
import { base64, text, utf8 } from "../../worker/forge/objects.ts";
import { INSTALLATION_RULE } from "../../worker/forge/rules.ts";
import type * as T from "../../worker/forge/types.ts";
import {
  emailKeys, ghAsset, ghCheckRun, ghCommit, ghFile, ghIssue, ghPull, ghRelease, ghRepo, ghUser, json, MockFetch, raw, type Recorded, SHA,
} from "./github-mock.ts";

const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
}).privateKey;

const NOW = 1_790_596_800;
const TOKEN = "ghu_TESTtokenThatMustNeverLeak0123456789";
const INSTALLATION_TOKEN = "ghs_TESTinstallationTokenNeverLogged0123";
const CONFIG = { clientId: "Iv23liTESTCLIENT", clientSecret: "test-secret-not-real", appSlug: "code-registry", appId: "123456", privateKey: PRIVATE_KEY };
const REPO: T.RepoRef = { forge: "github", owner: "ada", name: "compendium" };
const HEAD = SHA("11");
const BASE = SHA("22");

type Kind = T.CredentialKind;

function setup(kind: Kind = "user", o: { cache?: Map<string, { token: string; exp: number }>; now?: () => number } = {}) {
  const mock = new MockFetch();
  mock.on("POST", /^\/app\/installations\/\d+\/access_tokens/, () => json({ token: INSTALLATION_TOKEN, expires_at: new Date((NOW + 3600) * 1000).toISOString() }, 201));
  const backend = githubBackend(CONFIG, { fetch: mock.fetch, now: o.now ?? (() => NOW), tokenCache: o.cache ?? new Map() });
  const credential: T.Credential = kind === "user" ? { kind, token: TOKEN } : kind === "installation" ? { kind, installationId: "777" } : { kind };
  return { mock, backend, s: backend.session(credential) };
}

/** The requests to the API, without the token mints. */
const apiCalls = (mock: MockFetch): Recorded[] => mock.calls.filter((c) => !/\/access_tokens$/.test(c.url.pathname));

async function refused(p: Promise<unknown>, code: GitErrorCode): Promise<GitBackendError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitBackendError, String(e));
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected ${code}`);
}

interface Expect {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  accept?: string;
  host?: string;
}

interface Case {
  name: string;
  kind?: Kind;
  replies: [string, string | RegExp, Response | (() => Response)][];
  call: (s: GitSession) => Promise<unknown> | unknown;
  expect: Expect[];
  check?: (result: any) => void;
  cost?: Partial<T.Cost>;
}

const b64 = (s: string) => base64(utf8(s));
const listing = (items: unknown[], next = false) => json(items, 200, next ? { Link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"' } : {});

const CASES: Case[] = [
  // ─── repositories ───
  {
    name: "repos.get",
    replies: [["GET", "/repos/ada/compendium", json(ghRepo({ permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } }))]],
    call: (s) => s.repos.get(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium" }],
    check: (r: T.RepoInfo) => {
      assert.deepEqual(r.key, { forge: "github", id: "5001" });
      assert.deepEqual(r.ref, REPO);
      assert.equal(r.nodeId, "R_5001");
      assert.equal(r.licenseSpdx, "MIT");
      assert.equal(r.permission, "write");
      assert.deepEqual(r.features, { issues: true, wiki: false, autoMerge: false, deleteBranchOnMerge: true });
      assert.equal(r.cloneUrl, "https://github.com/ada/compendium.git");
    },
    cost: { requests: 1, writes: 0 },
  },
  {
    name: "repos.getById",
    kind: "anonymous",
    replies: [["GET", "/repositories/5001", json(ghRepo({ name: "renamed" }))]],
    call: (s) => s.repos.getById({ forge: "github", id: "5001" }),
    expect: [{ method: "GET", path: "/repositories/5001" }],
    check: (r: T.RepoInfo) => assert.equal(r.ref.name, "renamed"),
  },
  {
    name: "repos.create",
    replies: [["POST", "/user/repos", json(ghRepo(), 201)]],
    call: (s) => s.repos.create({ name: "compendium", visibility: "public", autoInit: true, description: "Code of the paper", licenseTemplate: "mit", features: { issues: true } }),
    expect: [{ method: "POST", path: "/user/repos", body: { name: "compendium", description: "Code of the paper", private: false, auto_init: true, license_template: "mit", has_issues: true } }],
    cost: { requests: 1, writes: 1 },
  },
  {
    name: "repos.generate",
    replies: [["POST", "/repos/ada/template/generate", json(ghRepo({ owner: "bo", name: "study" }), 201)]],
    call: (s) => s.repos.generate({ ...REPO, name: "template" }, { owner: "bo", name: "study", visibility: "public" }),
    expect: [{ method: "POST", path: "/repos/ada/template/generate", body: { owner: "bo", name: "study", include_all_branches: false, private: false } }],
    check: (r: T.RepoInfo) => assert.equal(r.ref.owner, "bo"),
  },
  {
    name: "repos.fork (202: not ready yet)",
    replies: [["POST", "/repos/ada/compendium/forks", json(ghRepo({ owner: "bo", parent: ghRepo() }), 202)]],
    call: (s) => s.repos.fork(REPO, { defaultBranchOnly: true }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/forks", body: { default_branch_only: true } }],
    check: (r: { repo: T.RepoInfo; ready: boolean }) => {
      assert.equal(r.ready, false);
      assert.deepEqual(r.repo.parent, REPO);
    },
  },
  {
    name: "repos.update",
    replies: [["PATCH", "/repos/ada/compendium", json(ghRepo({ name: "renamed", archived: true }))]],
    call: (s) => s.repos.update(REPO, { name: "renamed", archived: true, defaultBranch: "trunk", isTemplate: true, features: { autoMerge: true } }),
    expect: [{ method: "PATCH", path: "/repos/ada/compendium", body: { name: "renamed", archived: true, default_branch: "trunk", is_template: true, allow_auto_merge: true } }],
    check: (r: T.RepoInfo) => assert.equal(r.archived, true),
  },
  {
    name: "repos.autolinks",
    replies: [["GET", "/repos/ada/compendium/autolinks", json([{ id: 7, key_prefix: "RRID:", url_template: "https://scicrunch.org/resolver/RRID:<num>", is_alphanumeric: true }])]],
    call: (s) => s.repos.autolinks(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/autolinks" }],
    check: (r: T.Autolink[]) => assert.deepEqual(r, [{ id: "7", keyPrefix: "RRID:", urlTemplate: "https://scicrunch.org/resolver/RRID:<num>", isAlphanumeric: true }]),
  },
  {
    name: "repos.createAutolink",
    replies: [["POST", "/repos/ada/compendium/autolinks", json({ id: 8, key_prefix: "PROTO-", url_template: "https://protocols.example.org/p/<num>", is_alphanumeric: false }, 201)]],
    call: (s) => s.repos.createAutolink(REPO, { keyPrefix: "PROTO-", urlTemplate: "https://protocols.example.org/p/<num>", isAlphanumeric: false }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/autolinks", body: { key_prefix: "PROTO-", url_template: "https://protocols.example.org/p/<num>", is_alphanumeric: false } }],
    check: (r: T.Autolink) => assert.deepEqual(r, { id: "8", keyPrefix: "PROTO-", urlTemplate: "https://protocols.example.org/p/<num>", isAlphanumeric: false }),
  },
  {
    name: "repos.deleteAutolink",
    replies: [["DELETE", "/repos/ada/compendium/autolinks/8", json(null, 204)]],
    call: (s) => s.repos.deleteAutolink(REPO, "8"),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/autolinks/8" }],
  },
  {
    name: "repos.setTopics",
    replies: [["PUT", "/repos/ada/compendium/topics", json({ names: ["eeg", "neuroscience"] })]],
    call: (s) => s.repos.setTopics(REPO, ["eeg", "neuroscience"]),
    expect: [{ method: "PUT", path: "/repos/ada/compendium/topics", body: { names: ["eeg", "neuroscience"] } }],
    check: (r: string[]) => assert.deepEqual(r, ["eeg", "neuroscience"]),
  },
  {
    name: "repos.transfer (to an organization: done)",
    replies: [["POST", "/repos/ada/compendium/transfer", json(ghRepo({ owner: "ada-lab", ownerType: "Organization" }), 202)]],
    call: (s) => s.repos.transfer(REPO, { newOwner: "ada-lab" }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/transfer", body: { new_owner: "ada-lab" } }],
    check: (r: { status: string; repo: T.RepoInfo }) => {
      assert.equal(r.status, "done");
      assert.equal(r.repo.owner.type, "organization");
    },
  },
  {
    name: "repos.transfer (to a person: pending)",
    replies: [["POST", "/repos/ada/compendium/transfer", json(ghRepo(), 202)]],
    call: (s) => s.repos.transfer(REPO, { newOwner: "bo", newName: "their-copy" }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/transfer", body: { new_owner: "bo", new_name: "their-copy" } }],
    check: (r: { status: string }) => assert.equal(r.status, "pending"),
  },
  {
    name: "repos.delete",
    replies: [["DELETE", "/repos/ada/compendium", json(null, 204)]],
    call: (s) => s.repos.delete(REPO),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium" }],
    cost: { requests: 1, writes: 1 },
  },
  {
    name: "repos.permission",
    replies: [["GET", "/repos/ada/compendium/collaborators/bo/permission", json({ permission: "write", role_name: "maintain", user: ghUser("bo", 303) })]],
    call: (s) => s.repos.permission(REPO, "bo"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/collaborators/bo/permission" }],
    check: (r: string) => assert.equal(r, "maintain"),
  },
  {
    name: "repos.languages",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/languages", json({ Python: 1200, R: 300 })]],
    call: (s) => s.repos.languages(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/languages" }],
    check: (r: Record<string, number>) => assert.deepEqual(r, { Python: 1200, R: 300 }),
  },
  {
    name: "repos.license",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/license", json({ path: "LICENSE", license: { key: "cc-by-4.0", spdx_id: "CC-BY-4.0" } })]],
    call: (s) => s.repos.license(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/license" }],
    check: (r: unknown) => assert.deepEqual(r, { spdx: "CC-BY-4.0", path: "LICENSE" }),
  },
  {
    name: "repos.license (none: null)",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/license", json({ message: "Not Found" }, 404)]],
    call: (s) => s.repos.license(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/license" }],
    check: (r: unknown) => assert.equal(r, null),
  },
  {
    name: "repos.readme",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/readme/docs", json({ path: "docs/README.md", sha: SHA("ead"), size: 8, content: b64("# Docs\n\n"), encoding: "base64" })]],
    call: (s) => s.repos.readme(REPO, "v1", "docs"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/readme/docs", query: { ref: "v1" } }],
    check: (r: T.FileContent) => {
      assert.equal(r.path, "docs/README.md");
      assert.equal(text(r.bytes), "# Docs\n\n");
      assert.equal(r.sha, SHA("ead"));
    },
  },
  // ─── refs ───
  {
    name: "git.listBranches (a page, and a next one)",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/branches", listing([{ name: "main", commit: { sha: HEAD }, protected: true }], true)]],
    call: (s) => s.git.listBranches(REPO, { cursor: "2", perPage: 10 }),
    expect: [{ method: "GET", path: "/repos/ada/compendium/branches", query: { per_page: "10", page: "2" } }],
    check: (r: T.Page<T.Branch>) => {
      assert.deepEqual(r.items, [{ name: "main", sha: HEAD, protected: true }]);
      assert.equal(r.next, "3");
    },
  },
  {
    name: "git.getBranch",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/branches/feature/x", json({ name: "feature/x", commit: { sha: HEAD, commit: { author: { email: "x@example.org" } } }, protected: false })]],
    call: (s) => s.git.getBranch(REPO, "feature/x"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/branches/feature/x" }],
    check: (r: T.Branch) => assert.deepEqual(r, { name: "feature/x", sha: HEAD, protected: false }),
  },
  {
    name: "git.createBranch",
    replies: [["POST", "/repos/ada/compendium/git/refs", json({ ref: "refs/heads/feature", object: { sha: HEAD, type: "commit" } }, 201)]],
    call: (s) => s.git.createBranch(REPO, "feature", HEAD),
    expect: [{ method: "POST", path: "/repos/ada/compendium/git/refs", body: { ref: "refs/heads/feature", sha: HEAD } }],
    check: (r: T.Branch) => assert.deepEqual(r, { name: "feature", sha: HEAD, protected: false }),
    cost: { requests: 1, writes: 1 },
  },
  {
    name: "git.renameBranch",
    replies: [["POST", "/repos/ada/compendium/branches/main/rename", json({ name: "trunk", commit: { sha: HEAD }, protected: false }, 201)]],
    call: (s) => s.git.renameBranch(REPO, "main", "trunk"),
    expect: [{ method: "POST", path: "/repos/ada/compendium/branches/main/rename", body: { new_name: "trunk" } }],
  },
  {
    name: "git.deleteBranch",
    replies: [
      ["GET", "/repos/ada/compendium", json(ghRepo())],
      ["DELETE", "/repos/ada/compendium/git/refs/heads/feature/x", json(null, 204)],
    ],
    call: (s) => s.git.deleteBranch(REPO, "feature/x"),
    expect: [
      { method: "GET", path: "/repos/ada/compendium" },
      { method: "DELETE", path: "/repos/ada/compendium/git/refs/heads/feature/x" },
    ],
    cost: { requests: 2, writes: 1 },
  },
  {
    name: "git.listTags",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/tags", listing([{ name: "v1.0.0", commit: { sha: HEAD }, zipball_url: "x" }])]],
    call: (s) => s.git.listTags(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/tags", query: { per_page: "30", page: "1" } }],
    check: (r: T.Page<T.Tag>) => assert.deepEqual(r, { items: [{ name: "v1.0.0", sha: HEAD, annotation: null }], next: null }),
  },
  {
    name: "git.createTag (lightweight)",
    replies: [["POST", "/repos/ada/compendium/git/refs", json({ ref: "refs/tags/v1", object: { sha: HEAD } }, 201)]],
    call: (s) => s.git.createTag(REPO, { name: "v1", sha: HEAD }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/git/refs", body: { ref: "refs/tags/v1", sha: HEAD } }],
    check: (r: T.Tag) => assert.deepEqual(r, { name: "v1", sha: HEAD, annotation: null }),
  },
  {
    name: "git.createTag (annotated: the tag object, then its ref)",
    replies: [
      ["POST", "/repos/ada/compendium/git/tags", json({ sha: SHA("7a9"), tag: "v2", message: "The version of the paper", tagger: { name: "Ada", email: "ada@example.org", date: "2026-09-01T00:00:00Z" }, object: { sha: HEAD, type: "commit" } }, 201)],
      ["POST", "/repos/ada/compendium/git/refs", json({ ref: "refs/tags/v2", object: { sha: SHA("7a9") } }, 201)],
    ],
    call: (s) => s.git.createTag(REPO, { name: "v2", sha: HEAD, message: "The version of the paper" }),
    expect: [
      { method: "POST", path: "/repos/ada/compendium/git/tags", body: { tag: "v2", message: "The version of the paper", object: HEAD, type: "commit" } },
      { method: "POST", path: "/repos/ada/compendium/git/refs", body: { ref: "refs/tags/v2", sha: SHA("7a9") } },
    ],
    check: (r: T.Tag) => assert.deepEqual(r, { name: "v2", sha: HEAD, annotation: { sha: SHA("7a9"), message: "The version of the paper", tagger: { name: "Ada", login: null, id: null } } }),
    cost: { requests: 2, writes: 2 },
  },
  {
    name: "git.deleteTag",
    replies: [["DELETE", "/repos/ada/compendium/git/refs/tags/v1", json(null, 204)]],
    call: (s) => s.git.deleteTag(REPO, "v1"),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/git/refs/tags/v1" }],
  },
  {
    name: "git.resolve",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/commits/main", raw(HEAD)]],
    call: (s) => s.git.resolve(REPO, "main"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/commits/main", accept: "application/vnd.github.sha" }],
    check: (r: string) => assert.equal(r, HEAD),
  },
  {
    name: "git.tree (the root, recursive)",
    kind: "anonymous",
    replies: [
      [
        "GET",
        "/repos/ada/compendium/git/trees/main",
        json({
          sha: SHA("7ee"),
          truncated: false,
          tree: [
            { path: "src", mode: "040000", type: "tree", sha: SHA("5c") },
            { path: "src/run.sh", mode: "100755", type: "blob", sha: SHA("51"), size: 20 },
            { path: "vendor/lib", mode: "160000", type: "commit", sha: SHA("50") },
          ],
        }),
      ],
    ],
    call: (s) => s.git.tree(REPO, "main", { recursive: true }),
    expect: [{ method: "GET", path: "/repos/ada/compendium/git/trees/main", query: { recursive: "1" } }],
    check: (r: T.Tree) => {
      assert.equal(r.sha, SHA("7ee"));
      assert.deepEqual(r.entries.map((e) => [e.path, e.mode, e.type, e.size]), [["src", "040000", "tree", null], ["src/run.sh", "100755", "blob", 20], ["vendor/lib", "160000", "commit", null]]);
    },
  },
  {
    name: "git.tree (under a path: the parent's listing, then the tree)",
    kind: "anonymous",
    replies: [
      ["GET", "/repos/ada/compendium/contents/src", json([{ name: "lib", path: "src/lib", sha: SHA("11b"), type: "dir", size: 0 }, { name: "a.py", path: "src/a.py", sha: SHA("a1"), type: "file", size: 3 }])],
      ["GET", `/repos/ada/compendium/git/trees/${SHA("11b")}`, json({ sha: SHA("11b"), truncated: false, tree: [{ path: "b.py", mode: "100644", type: "blob", sha: SHA("b1"), size: 6 }] })],
    ],
    call: (s) => s.git.tree(REPO, "main", { path: "src/lib" }),
    expect: [
      { method: "GET", path: "/repos/ada/compendium/contents/src", query: { ref: "main" } },
      { method: "GET", path: `/repos/ada/compendium/git/trees/${SHA("11b")}` },
    ],
    check: (r: T.Tree) => {
      assert.equal(r.sha, SHA("11b"));
      assert.deepEqual(r.entries.map((e) => e.path), ["src/lib/b.py"]);
    },
    cost: { requests: 2 },
  },
  {
    name: "git.readFile (a signed-in session: the contents API, raw)",
    replies: [["GET", "/repos/ada/compendium/contents/src/a.py", raw("hello world\n")]],
    call: (s) => s.git.readFile(REPO, "main", "src/a.py"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/contents/src/a.py", query: { ref: "main" }, accept: "application/vnd.github.raw" }],
    check: (r: T.FileContent) => {
      assert.equal(text(r.bytes), "hello world\n");
      assert.equal(r.sha, "3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
      assert.equal(r.binary, false);
    },
    cost: { requests: 1 },
  },
  {
    name: "git.readFile (anonymous: the raw CDN, not counted)",
    kind: "anonymous",
    replies: [["GET", "/ada/compendium/main/src/a%20b.py", raw("x = 1\n")]],
    call: (s) => s.git.readFile(REPO, "main", "src/a b.py"),
    expect: [{ method: "GET", path: "/ada/compendium/main/src/a%20b.py", host: "raw.githubusercontent.com" }],
    check: (r: T.FileContent) => assert.equal(text(r.bytes), "x = 1\n"),
    cost: { requests: 0, writes: 0 },
  },
  {
    name: "git.commits (filtered)",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/commits", listing([ghCommit(HEAD)])]],
    call: (s) => s.git.commits(REPO, { rev: "dev", path: "src/a.py", since: "2026-01-01T00:00:00Z", authorLogin: "ada" }, { perPage: 5 }),
    expect: [{ method: "GET", path: "/repos/ada/compendium/commits", query: { sha: "dev", path: "src/a.py", since: "2026-01-01T00:00:00Z", author: "ada", per_page: "5", page: "1" } }],
    check: (r: T.Page<T.CommitSummary>) => {
      const c = r.items[0];
      assert.equal(c.sha, HEAD);
      assert.deepEqual(c.author, { name: "Ada Lovelace", login: "ada", id: "101" });
      assert.deepEqual(c.committer, { name: "GitHub", login: "web-flow", id: "19864447" });
      assert.equal(c.authoredAt, "2026-09-01T10:00:00Z");
      assert.equal(c.verified, true);
      assert.deepEqual(c.parents, [SHA("aaa1")]);
    },
  },
  {
    name: "git.commits (an empty repository: an empty page)",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/commits", json({ message: "Git Repository is empty.", status: "409" }, 409)]],
    call: (s) => s.git.commits(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/commits" }],
    check: (r: T.Page<T.CommitSummary>) => assert.deepEqual(r, { items: [], next: null }),
  },
  {
    name: "git.commit",
    kind: "anonymous",
    replies: [["GET", `/repos/ada/compendium/commits/${HEAD}`, json({ ...ghCommit(HEAD, { login: null }), stats: { additions: 2, deletions: 1, total: 3 }, files: [ghFile("a.py"), ghFile("gone.py", "removed"), ghFile("new.py", "renamed", { previous_filename: "old.py" })] })]],
    call: (s) => s.git.commit(REPO, HEAD),
    expect: [{ method: "GET", path: `/repos/ada/compendium/commits/${HEAD}`, query: { per_page: "30", page: "1" } }],
    check: (r: T.CommitDetail) => {
      assert.deepEqual(r.author, { name: "Ada Lovelace", login: null, id: null });
      assert.deepEqual(r.stats, { additions: 2, deletions: 1, total: 3 });
      assert.deepEqual(r.files.items.map((f) => [f.path, f.status, f.previousPath, f.blob === null]), [["a.py", "modified", null, false], ["gone.py", "removed", null, true], ["new.py", "renamed", "old.py", false]]);
    },
  },
  {
    name: "git.compare (three dots; the files paged here)",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/compare/main...feature/x", json({ status: "diverged", ahead_by: 1, behind_by: 2, merge_base_commit: ghCommit(BASE), commits: [ghCommit(HEAD)], files: [ghFile("a.py"), ghFile("b.py", "added")] })]],
    call: (s) => s.git.compare(REPO, "main", "feature/x", { perPage: 1 }),
    expect: [{ method: "GET", path: "/repos/ada/compendium/compare/main...feature/x" }],
    check: (r: T.Comparison) => {
      assert.equal(r.status, "diverged");
      assert.equal(r.mergeBase, BASE);
      assert.deepEqual(r.files, { items: [{ path: "a.py", previousPath: null, status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b", blob: SHA("b10b") }], next: "2" });
    },
  },
  {
    name: "git.diff",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/compare/main...dev", raw("diff --git a/a b/a\n-x\n+y\n")]],
    call: (s) => s.git.diff(REPO, "main", "dev"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/compare/main...dev", accept: "application/vnd.github.diff" }],
    check: (r: string) => assert.match(r, /\+y/),
  },
  {
    name: "git.blame (GraphQL; names and accounts, never an email)",
    replies: [["POST", "/graphql", json({ data: { repository: { object: { blame: { ranges: [
      { startingLine: 1, endingLine: 2, commit: { oid: BASE, committedDate: "2026-09-01T00:00:00Z", authoredDate: "2026-08-31T00:00:00Z", message: "First", parents: { nodes: [] }, tree: { oid: SHA("7e") }, author: { name: "Ada", email: "ada@example.org", user: { login: "ada", databaseId: 101 } }, committer: { name: "GitHub", email: "noreply@github.com", user: null }, signature: { isValid: true } } },
      { startingLine: 3, endingLine: 3, commit: { oid: HEAD, committedDate: "2026-09-02T00:00:00Z", authoredDate: "2026-09-02T00:00:00Z", message: "Second", parents: { nodes: [{ oid: BASE }] }, tree: { oid: SHA("7f") }, author: { name: "Bo", user: null }, committer: { name: "Bo", user: null }, signature: null } },
    ] } } } } })]],
    call: (s) => s.git.blame(REPO, "main", "m.py"),
    expect: [{ method: "POST", path: "/graphql" }],
    check: (r: T.BlameRange[]) => {
      assert.deepEqual(r.map((x) => [x.startLine, x.endLine, x.commit.sha]), [[1, 2, BASE], [3, 3, HEAD]]);
      assert.deepEqual(r[0].commit.author, { name: "Ada", login: "ada", id: "101" });
      assert.deepEqual(r[0].commit.committer, { name: "GitHub", login: null, id: null });
      assert.equal(r[0].commit.verified, true);
      assert.equal(r[1].commit.verified, null);
      assert.deepEqual(r[1].commit.parents, [BASE]);
    },
    cost: { requests: 1, writes: 0, graphql: 1 },
  },
  {
    name: "git.search (code search, with its fragments)",
    replies: [["GET", "/search/code", json({ total_count: 1, items: [{ name: "a.py", path: "src/a.py", sha: SHA("a1"), text_matches: [{ fragment: "def fit_model(x):" }] }] })]],
    call: (s) => s.git.search(REPO, "fit_model"),
    expect: [{ method: "GET", path: "/search/code", query: { q: "fit_model repo:ada/compendium", per_page: "30", page: "1" }, accept: "application/vnd.github.text-match+json" }],
    check: (r: T.Page<T.CodeHit>) => assert.deepEqual(r.items, [{ path: "src/a.py", sha: SHA("a1"), fragments: ["def fit_model(x):"] }]),
  },
  {
    name: "git.merge (checks the base first; 201: merged)",
    replies: [
      ["GET", "/repos/ada/compendium/branches/main", json({ name: "main", commit: { sha: BASE }, protected: false })],
      ["POST", "/repos/ada/compendium/merges", json(ghCommit(SHA("3e")), 201)],
    ],
    call: (s) => s.git.merge(REPO, { base: "main", head: "feature", message: "Merge feature", expectedBaseHead: BASE }),
    expect: [
      { method: "GET", path: "/repos/ada/compendium/branches/main" },
      { method: "POST", path: "/repos/ada/compendium/merges", body: { base: "main", head: "feature", commit_message: "Merge feature" } },
    ],
    check: (r: T.MergeResult) => assert.deepEqual(r, { status: "merged", sha: SHA("3e") }),
  },
  {
    name: "git.merge (204: up to date)",
    replies: [["POST", "/repos/ada/compendium/merges", json(null, 204)]],
    call: (s) => s.git.merge(REPO, { base: "main", head: HEAD }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/merges", body: { base: "main", head: HEAD } }],
    check: (r: T.MergeResult) => assert.deepEqual(r, { status: "up_to_date" }),
  },
  // ─── pull requests ───
  {
    name: "pulls.list",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/pulls", listing([ghPull()])]],
    call: (s) => s.pulls.list(REPO, { state: "all", head: "bo:sensitivity", base: "main", sort: "updated", direction: "asc" }),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls", query: { state: "all", head: "bo:sensitivity", base: "main", sort: "updated", direction: "asc" } }],
  },
  {
    name: "pulls.get",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/pulls/7", json(ghPull())]],
    call: (s) => s.pulls.get(REPO, 7),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls/7" }],
    check: (p: T.PullRequest) => {
      assert.equal(p.number, 7);
      assert.equal(p.nodeId, "PR_kwDO7");
      assert.deepEqual(p.head, { repo: { forge: "github", owner: "bo", name: "compendium" }, ref: "sensitivity", sha: HEAD });
      assert.deepEqual(p.base, { repo: REPO, ref: "main", sha: BASE });
      assert.equal(p.mergeState, "clean");
      assert.deepEqual(p.requestedReviewers, ["cy"]);
      assert.deepEqual(p.labels, ["analysis"]);
      assert.equal(p.milestone, 2);
      assert.equal(p.mergeCommit, null, "no merge commit before a merge");
      assert.deepEqual(p.counts, { commits: 2, additions: 10, deletions: 3, changedFiles: 2, comments: 3 });
    },
  },
  {
    name: "pulls.files",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/pulls/7/files", listing([ghFile("a.py")])]],
    call: (s) => s.pulls.files(REPO, 7),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls/7/files" }],
  },
  {
    name: "pulls.commits",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/pulls/7/commits", listing([ghCommit(HEAD)])]],
    call: (s) => s.pulls.commits(REPO, 7),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls/7/commits" }],
  },
  {
    name: "pulls.create",
    replies: [["POST", "/repos/ada/compendium/pulls", json(ghPull(), 201)]],
    call: (s) => s.pulls.create(REPO, { title: "Add the sensitivity analysis", head: "bo:sensitivity", base: "main", body: "Fixes #3", draft: true }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/pulls", body: { title: "Add the sensitivity analysis", body: "Fixes #3", head: "bo:sensitivity", base: "main", draft: true } }],
  },
  {
    name: "pulls.update",
    replies: [["PATCH", "/repos/ada/compendium/pulls/7", json(ghPull(7, { state: "closed" }))]],
    call: (s) => s.pulls.update(REPO, 7, { state: "closed" }),
    expect: [{ method: "PATCH", path: "/repos/ada/compendium/pulls/7", body: { state: "closed" } }],
    check: (p: T.PullRequest) => assert.equal(p.state, "closed"),
  },
  {
    name: "pulls.setDraft (its node id, then GraphQL)",
    replies: [
      ["GET", "/repos/ada/compendium/pulls/7", json(ghPull())],
      ["POST", "/graphql", json({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } })],
    ],
    call: (s) => s.pulls.setDraft(REPO, 7, true),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls/7" }, { method: "POST", path: "/graphql" }],
    check: (p: T.PullRequest) => assert.equal(p.draft, true),
    cost: { requests: 2, writes: 1, graphql: 1 },
  },
  {
    name: "pulls.requestReviewers",
    replies: [["POST", "/repos/ada/compendium/pulls/7/requested_reviewers", json(ghPull(), 201)]],
    call: (s) => s.pulls.requestReviewers(REPO, 7, ["cy"]),
    expect: [{ method: "POST", path: "/repos/ada/compendium/pulls/7/requested_reviewers", body: { reviewers: ["cy"] } }],
  },
  {
    name: "pulls.removeReviewers",
    replies: [["DELETE", "/repos/ada/compendium/pulls/7/requested_reviewers", json(ghPull(7, { requested_reviewers: [] }))]],
    call: (s) => s.pulls.removeReviewers(REPO, 7, ["cy"]),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/pulls/7/requested_reviewers", body: { reviewers: ["cy"] } }],
    check: (p: T.PullRequest) => assert.deepEqual(p.requestedReviewers, []),
  },
  {
    name: "pulls.reviews",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/pulls/7/reviews", listing([{ id: 31, user: ghUser("cy", 404), state: "APPROVED", body: "Fine", commit_id: HEAD, submitted_at: "2026-09-05T00:00:00Z" }])]],
    call: (s) => s.pulls.reviews(REPO, 7),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls/7/reviews" }],
    check: (r: T.Page<T.Review>) => assert.deepEqual(r.items[0], { id: "31", author: { name: "cy", login: "cy", id: "404" }, state: "APPROVED", body: "Fine", commit: HEAD, submittedAt: "2026-09-05T00:00:00Z" }),
  },
  {
    name: "pulls.review (with line comments)",
    replies: [["POST", "/repos/ada/compendium/pulls/7/reviews", json({ id: 32, user: ghUser("cy", 404), state: "CHANGES_REQUESTED", body: "See 2.3", commit_id: HEAD, submitted_at: "2026-09-05T00:00:00Z" })]],
    call: (s) => s.pulls.review(REPO, 7, { event: "REQUEST_CHANGES", body: "See 2.3", commit: HEAD, comments: [{ path: "m.py", line: 12, startLine: 10, body: "```suggestion\nb = 2\n```" }] }),
    expect: [{
      method: "POST",
      path: "/repos/ada/compendium/pulls/7/reviews",
      body: { event: "REQUEST_CHANGES", body: "See 2.3", commit_id: HEAD, comments: [{ path: "m.py", line: 12, side: "RIGHT", body: "```suggestion\nb = 2\n```", start_line: 10, start_side: "RIGHT" }] },
    }],
  },
  {
    name: "pulls.comments",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/pulls/7/comments", listing([{ id: 55, pull_request_review_id: 32, user: ghUser("cy", 404), path: "m.py", line: 12, start_line: null, side: "RIGHT", commit_id: HEAD, original_commit_id: BASE, body: "b = 2", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" }])]],
    call: (s) => s.pulls.comments(REPO, 7),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls/7/comments" }],
    check: (r: T.Page<T.ReviewComment>) => {
      assert.equal(r.items[0].reviewId, "32");
      assert.equal(r.items[0].inReplyTo, null);
      assert.equal(r.items[0].originalCommit, BASE);
    },
  },
  {
    name: "pulls.reply",
    replies: [["POST", "/repos/ada/compendium/pulls/7/comments/55/replies", json({ id: 56, pull_request_review_id: 33, in_reply_to_id: 55, user: ghUser(), path: "m.py", line: 12, side: "RIGHT", commit_id: HEAD, original_commit_id: HEAD, body: "Done", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" }, 201)]],
    call: (s) => s.pulls.reply(REPO, 7, "55", "Done"),
    expect: [{ method: "POST", path: "/repos/ada/compendium/pulls/7/comments/55/replies", body: { body: "Done" } }],
    check: (c: T.ReviewComment) => assert.equal(c.inReplyTo, "55"),
  },
  {
    name: "pulls.threads (GraphQL)",
    replies: [["POST", "/graphql", json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "PRRT_1", isResolved: false, isOutdated: false, path: "m.py", line: 12, comments: { nodes: [{ databaseId: 55, path: "m.py", line: 12, startLine: null, diffSide: "RIGHT", body: "b = 2", createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z", author: { login: "cy", databaseId: 404 }, commit: { oid: HEAD }, originalCommit: { oid: BASE }, pullRequestReview: { databaseId: 32 }, replyTo: null }] } }], pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjE=" } } } } } })]],
    call: (s) => s.pulls.threads(REPO, 7, { perPage: 10 }),
    expect: [{ method: "POST", path: "/graphql" }],
    check: (r: T.Page<T.ReviewThread>) => {
      assert.equal(r.next, "Y3Vyc29yOjE=");
      assert.equal(r.items[0].id, "PRRT_1");
      assert.deepEqual(r.items[0].comments[0].author, { name: "cy", login: "cy", id: "404" });
      assert.equal(r.items[0].comments[0].reviewId, "32");
    },
    cost: { requests: 1, writes: 0, graphql: 1 },
  },
  {
    name: "pulls.resolveThread (GraphQL)",
    replies: [["POST", "/graphql", json({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true, isOutdated: false, path: "m.py", line: 12, comments: { nodes: [] } } } } })]],
    call: (s) => s.pulls.resolveThread(REPO, "PRRT_1", true),
    expect: [{ method: "POST", path: "/graphql" }],
    check: (t: T.ReviewThread) => assert.equal(t.resolved, true),
    cost: { requests: 1, writes: 1, graphql: 1 },
  },
  {
    name: "pulls.merge",
    replies: [["PUT", "/repos/ada/compendium/pulls/7/merge", json({ sha: SHA("3e"), merged: true, message: "Pull Request successfully merged" })]],
    call: (s) => s.pulls.merge(REPO, 7, { method: "squash", expectedHead: HEAD, title: "Add the analysis (#7)" }),
    expect: [{ method: "PUT", path: "/repos/ada/compendium/pulls/7/merge", body: { merge_method: "squash", sha: HEAD, commit_title: "Add the analysis (#7)" } }],
    check: (r: { sha: string }) => assert.equal(r.sha, SHA("3e")),
  },
  {
    name: "pulls.updateBranch",
    replies: [["PUT", "/repos/ada/compendium/pulls/7/update-branch", json({ message: "Updating pull request branch." }, 202)]],
    call: (s) => s.pulls.updateBranch(REPO, 7, HEAD),
    expect: [{ method: "PUT", path: "/repos/ada/compendium/pulls/7/update-branch", body: { expected_head_sha: HEAD } }],
  },
  {
    name: "pulls.autoMerge (with the head it was approved at)",
    replies: [
      ["GET", "/repos/ada/compendium/pulls/7", json(ghPull())],
      ["POST", "/graphql", json({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { mergeMethod: "REBASE" } } } } })],
    ],
    call: (s) => s.pulls.autoMerge(REPO, 7, "rebase"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls/7" }, { method: "POST", path: "/graphql" }],
    check: (p: T.PullRequest) => assert.equal(p.autoMerge, "rebase"),
  },
  {
    name: "pulls.revert (GraphQL, then the new pull request)",
    replies: [
      ["GET", "/repos/ada/compendium/pulls/7", json(ghPull(7, { merged: true, merged_at: "2026-09-06T00:00:00Z", state: "closed" }))],
      ["POST", "/graphql", json({ data: { revertPullRequest: { revertPullRequest: { number: 9 } } } })],
      ["GET", "/repos/ada/compendium/pulls/9", json(ghPull(9, { title: 'Revert "Add the sensitivity analysis"' }))],
    ],
    call: (s) => s.pulls.revert(REPO, 7),
    expect: [{ method: "GET", path: "/repos/ada/compendium/pulls/7" }, { method: "POST", path: "/graphql" }, { method: "GET", path: "/repos/ada/compendium/pulls/9" }],
    check: (p: T.PullRequest) => assert.equal(p.number, 9),
    cost: { requests: 3, writes: 1, graphql: 1 },
  },
  // ─── issues ───
  {
    name: "issues.list (the pull requests dropped)",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/issues", listing([ghIssue(3), ghIssue(7, { pull_request: { url: "x" } })])]],
    call: (s) => s.issues.list(REPO, { state: "all", labels: ["bug", "reproduction"], milestone: "any", assignee: "none", sort: "comments" }),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues", query: { state: "all", labels: "bug,reproduction", milestone: "*", assignee: "none", sort: "comments" } }],
    check: (r: T.Page<T.Issue>) => {
      assert.deepEqual(r.items.map((i) => i.number), [3]);
      assert.deepEqual(r.items[0].reactions, { "+1": 2, heart: 1 });
      assert.deepEqual(r.items[0].subIssues, { total: 2, completed: 1 });
    },
  },
  {
    name: "issues.get",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/issues/3", json(ghIssue(3, { state: "closed", state_reason: "not_planned", closed_at: "2026-09-05T00:00:00Z" }))]],
    call: (s) => s.issues.get(REPO, 3),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/3" }],
    check: (i: T.Issue) => {
      assert.equal(i.stateReason, "not_planned");
      assert.equal(i.pinned, null);
      assert.deepEqual(i.author, { name: "cy", login: "cy", id: "404" });
    },
  },
  {
    name: "issues.create",
    replies: [["POST", "/repos/ada/compendium/issues", json(ghIssue(), 201)]],
    call: (s) => s.issues.create(REPO, { title: "Figure 2 does not reproduce", body: "Seed 42", labels: ["reproduction"], assignees: ["ada"], milestone: 2 }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/issues", body: { title: "Figure 2 does not reproduce", body: "Seed 42", labels: ["reproduction"], assignees: ["ada"], milestone: 2 } }],
  },
  {
    name: "issues.update (closed, with a reason)",
    replies: [["PATCH", "/repos/ada/compendium/issues/3", json(ghIssue(3, { state: "closed", state_reason: "completed" }))]],
    call: (s) => s.issues.update(REPO, 3, { state: "closed", stateReason: "completed", milestone: null }),
    expect: [{ method: "PATCH", path: "/repos/ada/compendium/issues/3", body: { state: "closed", state_reason: "completed", milestone: null } }],
  },
  {
    name: "issues.lock",
    replies: [["PUT", "/repos/ada/compendium/issues/3/lock", json(null, 204)]],
    call: (s) => s.issues.lock(REPO, 3, "too heated"),
    expect: [{ method: "PUT", path: "/repos/ada/compendium/issues/3/lock", body: { lock_reason: "too heated" } }],
  },
  {
    name: "issues.unlock",
    replies: [["DELETE", "/repos/ada/compendium/issues/3/lock", json(null, 204)]],
    call: (s) => s.issues.unlock(REPO, 3),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/issues/3/lock" }],
  },
  {
    name: "issues.comments",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/issues/3/comments", listing([{ id: 9, user: ghUser("cy", 404), body: "Which data?", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z", reactions: { "+1": 1 } }])]],
    call: (s) => s.issues.comments(REPO, 3),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/3/comments" }],
    check: (r: T.Page<T.IssueComment>) => assert.deepEqual(r.items[0].reactions, { "+1": 1 }),
  },
  {
    name: "issues.comment",
    replies: [["POST", "/repos/ada/compendium/issues/3/comments", json({ id: 10, user: ghUser(), body: "Version 2", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" }, 201)]],
    call: (s) => s.issues.comment(REPO, 3, "Version 2"),
    expect: [{ method: "POST", path: "/repos/ada/compendium/issues/3/comments", body: { body: "Version 2" } }],
  },
  {
    name: "issues.editComment",
    replies: [["PATCH", "/repos/ada/compendium/issues/comments/10", json({ id: 10, user: ghUser(), body: "Version 2.1", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:01:00Z" })]],
    call: (s) => s.issues.editComment(REPO, "10", "Version 2.1"),
    expect: [{ method: "PATCH", path: "/repos/ada/compendium/issues/comments/10", body: { body: "Version 2.1" } }],
  },
  {
    name: "issues.deleteComment",
    replies: [["DELETE", "/repos/ada/compendium/issues/comments/10", json(null, 204)]],
    call: (s) => s.issues.deleteComment(REPO, "10"),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/issues/comments/10" }],
  },
  {
    name: "issues.react (an issue)",
    replies: [["POST", "/repos/ada/compendium/issues/3/reactions", json({ id: 1, content: "heart", user: ghUser() }, 201)]],
    call: (s) => s.issues.react(REPO, { issue: 3 }, "heart"),
    expect: [{ method: "POST", path: "/repos/ada/compendium/issues/3/reactions", body: { content: "heart" } }],
  },
  {
    name: "issues.react (a comment)",
    replies: [["POST", "/repos/ada/compendium/issues/comments/9/reactions", json({ id: 2, content: "+1", user: ghUser() }, 201)]],
    call: (s) => s.issues.react(REPO, { comment: "9" }, "+1"),
    expect: [{ method: "POST", path: "/repos/ada/compendium/issues/comments/9/reactions", body: { content: "+1" } }],
  },
  {
    name: "issues.unreact (who I am, my reaction, its deletion)",
    replies: [
      ["GET", "/user", json(ghUser())],
      ["GET", "/repos/ada/compendium/issues/3/reactions", listing([{ id: 1, content: "heart", user: ghUser("cy", 404) }, { id: 2, content: "heart", user: ghUser() }])],
      ["DELETE", "/repos/ada/compendium/issues/3/reactions/2", json(null, 204)],
    ],
    call: (s) => s.issues.unreact(REPO, { issue: 3 }, "heart"),
    expect: [
      { method: "GET", path: "/user" },
      { method: "GET", path: "/repos/ada/compendium/issues/3/reactions", query: { content: "heart", per_page: "100", page: "1" } },
      { method: "DELETE", path: "/repos/ada/compendium/issues/3/reactions/2" },
    ],
    cost: { requests: 3, writes: 1 },
  },
  {
    name: "issues.labels",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/labels", listing([{ id: 1, name: "bug", color: "d73a4a", description: "Something is wrong" }])]],
    call: (s) => s.issues.labels(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/labels" }],
    check: (r: T.Page<T.Label>) => assert.deepEqual(r.items, [{ name: "bug", color: "d73a4a", description: "Something is wrong" }]),
  },
  {
    name: "issues.createLabel",
    replies: [["POST", "/repos/ada/compendium/labels", json({ id: 2, name: "reproduction", color: "0e8a16", description: "" }, 201)]],
    call: (s) => s.issues.createLabel(REPO, { name: "reproduction", color: "0E8A16", description: "" }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/labels", body: { name: "reproduction", color: "0e8a16", description: "" } }],
  },
  {
    name: "issues.updateLabel",
    replies: [["PATCH", "/repos/ada/compendium/labels/good%20first%20issue", json({ id: 3, name: "starter", color: "ffffff", description: "" })]],
    call: (s) => s.issues.updateLabel(REPO, "good first issue", { name: "starter", color: "FFFFFF" }),
    expect: [{ method: "PATCH", path: "/repos/ada/compendium/labels/good%20first%20issue", body: { new_name: "starter", color: "ffffff" } }],
  },
  {
    name: "issues.deleteLabel",
    replies: [["DELETE", "/repos/ada/compendium/labels/bug", json(null, 204)]],
    call: (s) => s.issues.deleteLabel(REPO, "bug"),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/labels/bug" }],
  },
  {
    name: "issues.milestones",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/milestones", listing([{ number: 2, title: "Revision 1", description: null, state: "closed", due_on: "2026-12-01T08:00:00Z", open_issues: 0, closed_issues: 4 }])]],
    call: (s) => s.issues.milestones(REPO, "closed"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/milestones", query: { state: "closed" } }],
    check: (r: T.Page<T.Milestone>) => assert.deepEqual(r.items[0], { number: 2, title: "Revision 1", description: "", state: "closed", dueOn: "2026-12-01T08:00:00Z", openIssues: 0, closedIssues: 4 }),
  },
  {
    name: "issues.createMilestone",
    replies: [["POST", "/repos/ada/compendium/milestones", json({ number: 3, title: "Revision 2", state: "open", open_issues: 0, closed_issues: 0 }, 201)]],
    call: (s) => s.issues.createMilestone(REPO, { title: "Revision 2", dueOn: "2027-01-01T00:00:00Z" }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/milestones", body: { title: "Revision 2", due_on: "2027-01-01T00:00:00Z" } }],
  },
  {
    name: "issues.updateMilestone",
    replies: [["PATCH", "/repos/ada/compendium/milestones/3", json({ number: 3, title: "Revision 2", state: "closed" })]],
    call: (s) => s.issues.updateMilestone(REPO, 3, { state: "closed", dueOn: null }),
    expect: [{ method: "PATCH", path: "/repos/ada/compendium/milestones/3", body: { state: "closed", due_on: null } }],
  },
  {
    name: "issues.deleteMilestone",
    replies: [["DELETE", "/repos/ada/compendium/milestones/3", json(null, 204)]],
    call: (s) => s.issues.deleteMilestone(REPO, 3),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/milestones/3" }],
  },
  {
    name: "issues.subIssues",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/issues/3/sub_issues", listing([ghIssue(5)])]],
    call: (s) => s.issues.subIssues(REPO, 3),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/3/sub_issues" }],
  },
  {
    name: "issues.addSubIssue (the child's id first)",
    replies: [
      ["GET", "/repos/ada/compendium/issues/5", json(ghIssue(5, { id: 80005 }))],
      ["POST", "/repos/ada/compendium/issues/3/sub_issues", json(ghIssue(3), 201)],
    ],
    call: (s) => s.issues.addSubIssue(REPO, 3, 5),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/5" }, { method: "POST", path: "/repos/ada/compendium/issues/3/sub_issues", body: { sub_issue_id: 80005 } }],
  },
  {
    name: "issues.removeSubIssue",
    replies: [
      ["GET", "/repos/ada/compendium/issues/5", json(ghIssue(5, { id: 80005 }))],
      ["DELETE", "/repos/ada/compendium/issues/3/sub_issue", json(ghIssue(3))],
    ],
    call: (s) => s.issues.removeSubIssue(REPO, 3, 5),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/5" }, { method: "DELETE", path: "/repos/ada/compendium/issues/3/sub_issue", body: { sub_issue_id: 80005 } }],
  },
  {
    name: "issues.blockedBy",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/issues/3/dependencies/blocked_by", listing([ghIssue(5)])]],
    call: (s) => s.issues.blockedBy(REPO, 3),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/3/dependencies/blocked_by" }],
  },
  {
    name: "issues.addBlockedBy",
    replies: [
      ["GET", "/repos/ada/compendium/issues/5", json(ghIssue(5, { id: 80005 }))],
      ["POST", "/repos/ada/compendium/issues/3/dependencies/blocked_by", json(ghIssue(3), 201)],
    ],
    call: (s) => s.issues.addBlockedBy(REPO, 3, 5),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/5" }, { method: "POST", path: "/repos/ada/compendium/issues/3/dependencies/blocked_by", body: { issue_id: 80005 } }],
  },
  {
    name: "issues.removeBlockedBy",
    replies: [
      ["GET", "/repos/ada/compendium/issues/5", json(ghIssue(5, { id: 80005 }))],
      ["DELETE", "/repos/ada/compendium/issues/3/dependencies/blocked_by/80005", json(ghIssue(3))],
    ],
    call: (s) => s.issues.removeBlockedBy(REPO, 3, 5),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/5" }, { method: "DELETE", path: "/repos/ada/compendium/issues/3/dependencies/blocked_by/80005" }],
  },
  {
    name: "issues.transfer (both node ids, GraphQL, then the issue where it went)",
    replies: [
      ["GET", "/repos/ada/compendium/issues/3", json(ghIssue(3))],
      ["GET", "/repos/ada/methods", json(ghRepo({ name: "methods", id: 5003 }))],
      ["POST", "/graphql", json({ data: { transferIssue: { issue: { number: 12 } } } })],
      ["GET", "/repos/ada/methods/issues/12", json(ghIssue(12))],
    ],
    call: (s) => s.issues.transfer(REPO, 3, { ...REPO, name: "methods" }),
    expect: [
      { method: "GET", path: "/repos/ada/compendium/issues/3" },
      { method: "GET", path: "/repos/ada/methods" },
      { method: "POST", path: "/graphql" },
      { method: "GET", path: "/repos/ada/methods/issues/12" },
    ],
    check: (i: T.Issue) => assert.equal(i.number, 12),
    cost: { requests: 4, writes: 1, graphql: 1 },
  },
  {
    name: "issues.pin",
    replies: [
      ["GET", "/repos/ada/compendium/issues/3", json(ghIssue(3))],
      ["POST", "/graphql", json({ data: { pinIssue: { issue: { isPinned: true } } } })],
    ],
    call: (s) => s.issues.pin(REPO, 3, true),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/3" }, { method: "POST", path: "/graphql" }],
  },
  {
    name: "issues.timeline",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/issues/3/timeline", listing([
      { event: "cross-referenced", actor: ghUser("bo", 303), created_at: "2026-09-05T00:00:00Z", source: { type: "issue", issue: { number: 8, repository: { full_name: "ada/compendium" } } } },
      { event: "labeled", actor: ghUser(), created_at: "2026-09-05T00:00:01Z", label: { name: "reproduction", color: "ff0000" } },
      { event: "commented", user: ghUser("cy", 404), created_at: "2026-09-05T00:00:02Z", body: "text" },
      { event: "head_ref_force_pushed", actor: ghUser(), created_at: "2026-09-05T00:00:03Z" },
    ])]],
    call: (s) => s.issues.timeline(REPO, 3),
    expect: [{ method: "GET", path: "/repos/ada/compendium/issues/3/timeline" }],
    check: (r: T.Page<T.TimelineEvent>) => assert.deepEqual(r.items.map((e) => [e.kind, e.subject, e.actor?.login]), [["cross-referenced", "ada/compendium#8", "bo"], ["labeled", "reproduction", "ada"], ["commented", null, "cy"], ["other", null, "ada"]]),
  },
  {
    name: "issues.search",
    kind: "anonymous",
    replies: [["GET", "/search/issues", json({ total_count: 1, items: [ghIssue(3)] })]],
    call: (s) => s.issues.search(REPO, "is:open figure"),
    expect: [{ method: "GET", path: "/search/issues", query: { q: "repo:ada/compendium is:open figure" } }],
  },
  // ─── releases ───
  {
    name: "releases.list",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/releases", listing([ghRelease()])]],
    call: (s) => s.releases.list(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/releases" }],
    check: (r: T.Page<T.Release>) => {
      const rel = r.items[0];
      assert.equal(rel.id, "60001");
      assert.equal(rel.assets[0].downloads, 5);
      assert.equal(rel.assets[0].downloadUrl, "https://github.com/ada/compendium/releases/download/v1.0.0/results.csv");
    },
  },
  {
    name: "releases.get",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/releases/60001", json(ghRelease())]],
    call: (s) => s.releases.get(REPO, "60001"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/releases/60001" }],
  },
  {
    name: "releases.byTag",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/releases/tags/v1.0.0", json(ghRelease())]],
    call: (s) => s.releases.byTag(REPO, "v1.0.0"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/releases/tags/v1.0.0" }],
  },
  {
    name: "releases.latest (none: null)",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/releases/latest", json({ message: "Not Found" }, 404)]],
    call: (s) => s.releases.latest(REPO),
    expect: [{ method: "GET", path: "/repos/ada/compendium/releases/latest" }],
    check: (r: unknown) => assert.equal(r, null),
  },
  {
    name: "releases.create",
    replies: [["POST", "/repos/ada/compendium/releases", json(ghRelease(), 201)]],
    call: (s) => s.releases.create(REPO, { tagName: "v1.0.0", target: "main", name: "Version of the paper", makeLatest: true, generateNotes: true }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/releases", body: { tag_name: "v1.0.0", target_commitish: "main", name: "Version of the paper", make_latest: "true", generate_release_notes: true } }],
  },
  {
    name: "releases.update",
    replies: [["PATCH", "/repos/ada/compendium/releases/60001", json(ghRelease(60001, { draft: false }))]],
    call: (s) => s.releases.update(REPO, "60001", { draft: false, body: "As published" }),
    expect: [{ method: "PATCH", path: "/repos/ada/compendium/releases/60001", body: { draft: false, body: "As published" } }],
  },
  {
    name: "releases.delete",
    replies: [["DELETE", "/repos/ada/compendium/releases/60001", json(null, 204)]],
    call: (s) => s.releases.delete(REPO, "60001"),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/releases/60001" }],
  },
  {
    name: "releases.generateNotes (creates nothing: no write)",
    replies: [["POST", "/repos/ada/compendium/releases/generate-notes", json({ name: "v2", body: "## What's Changed\n* Add the analysis by @bo in https://github.com/ada/compendium/pull/7" })]],
    call: (s) => s.releases.generateNotes(REPO, { tagName: "v2", target: "main", previousTagName: "v1.0.0" }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/releases/generate-notes", body: { tag_name: "v2", target_commitish: "main", previous_tag_name: "v1.0.0" } }],
    check: (r: { body: string }) => assert.match(r.body, /pull\/7/),
    cost: { requests: 1, writes: 0 },
  },
  {
    name: "releases.assets",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/releases/60001/assets", listing([ghAsset()])]],
    call: (s) => s.releases.assets(REPO, "60001"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/releases/60001/assets" }],
  },
  {
    name: "releases.uploadAsset (the raw bytes to the uploads host)",
    replies: [["POST", "/repos/ada/compendium/releases/60001/assets", json(ghAsset(), 201)]],
    call: (s) => s.releases.uploadAsset(REPO, "60001", { name: "results.csv", label: "Results", contentType: "text/csv", size: 12, body: utf8("x,y\n1,2\n3,4\n") }),
    expect: [{ method: "POST", path: "/repos/ada/compendium/releases/60001/assets", host: "uploads.github.com", query: { name: "results.csv", label: "Results" } }],
    cost: { requests: 1, writes: 1 },
  },
  {
    name: "releases.deleteAsset",
    replies: [["DELETE", "/repos/ada/compendium/releases/assets/70001", json(null, 204)]],
    call: (s) => s.releases.deleteAsset(REPO, "70001"),
    expect: [{ method: "DELETE", path: "/repos/ada/compendium/releases/assets/70001" }],
  },
  // ─── checks ───
  {
    name: "checks.runs",
    kind: "anonymous",
    replies: [["GET", `/repos/ada/compendium/commits/${HEAD}/check-runs`, json({ total_count: 1, check_runs: [ghCheckRun()] })]],
    call: (s) => s.checks.runs(REPO, HEAD),
    expect: [{ method: "GET", path: `/repos/ada/compendium/commits/${HEAD}/check-runs` }],
    check: (r: T.Page<T.CheckRun>) => assert.deepEqual(r.items[0].output, { title: "2 traced lines changed", summary: "…", annotations: 1 }),
  },
  {
    name: "checks.status",
    kind: "anonymous",
    replies: [["GET", "/repos/ada/compendium/commits/main/status", json({ state: "failure", statuses: [{ context: "ci/tests", state: "failure", description: "2 failed", target_url: "https://ci.example/1" }] })]],
    call: (s) => s.checks.status(REPO, "main"),
    expect: [{ method: "GET", path: "/repos/ada/compendium/commits/main/status" }],
    check: (r: T.CombinedStatus) => assert.deepEqual(r, { state: "failure", statuses: [{ context: "ci/tests", state: "failure", description: "2 failed", targetUrl: "https://ci.example/1" }] }),
  },
  {
    name: "checks.create (an installation: 50 annotations a request)",
    kind: "installation",
    replies: [
      ["POST", "/repos/ada/compendium/check-runs", json(ghCheckRun(), 201)],
      ["PATCH", "/repos/ada/compendium/check-runs/40001", json(ghCheckRun())],
      ["PATCH", "/repos/ada/compendium/check-runs/40001", json(ghCheckRun())],
    ],
    call: (s) =>
      s.checks.create(REPO, {
        name: "Tracing map",
        headSha: HEAD,
        conclusion: "neutral",
        output: { title: "Lines traced", summary: "…", annotations: Array.from({ length: 120 }, (_, i) => ({ path: "m.py", startLine: i + 1, endLine: i + 1, level: "notice" as const, message: `line ${i + 1}` })) },
      }),
    expect: [
      { method: "POST", path: "/repos/ada/compendium/check-runs" },
      { method: "PATCH", path: "/repos/ada/compendium/check-runs/40001" },
      { method: "PATCH", path: "/repos/ada/compendium/check-runs/40001" },
    ],
    cost: { requests: 4, writes: 3, mints: 1 },
  },
  {
    name: "checks.update (an installation)",
    kind: "installation",
    replies: [["PATCH", "/repos/ada/compendium/check-runs/40001", json(ghCheckRun())]],
    call: (s) => s.checks.update(REPO, "40001", { status: "completed", conclusion: "success" }),
    expect: [{ method: "PATCH", path: "/repos/ada/compendium/check-runs/40001", body: { status: "completed", conclusion: "success" } }],
  },
];

describe("the GitHub adapter, method by method", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { mock, s } = setup(c.kind ?? "user");
      for (const [method, path, reply] of c.replies) mock.on(method, path, typeof reply === "function" ? reply : reply, 1);
      const result = await c.call(s);
      const calls = apiCalls(mock);
      assert.equal(calls.length, c.expect.length, calls.map((x) => `${x.method} ${x.url.pathname}`).join(", "));
      c.expect.forEach((e, i) => {
        const call = calls[i];
        assert.equal(call.method, e.method);
        assert.equal(call.url.pathname, e.path);
        assert.equal(call.url.host, e.host ?? "api.github.com");
        for (const [k, v] of Object.entries(e.query ?? {})) assert.equal(call.url.searchParams.get(k), v, `query ${k}`);
        if (e.body !== undefined) assert.deepEqual(JSON.parse(call.body), e.body);
        if (e.accept) assert.equal(call.headers.get("Accept"), e.accept);
      });
      c.check?.(result);
      assert.deepEqual(emailKeys(result), [], "no email field");
      if (c.cost) for (const [k, v] of Object.entries(c.cost)) assert.equal(s.cost()[k as keyof T.Cost], v, `cost.${k}`);
    });
  }
});

describe("custom autolinks on GitHub", () => {
  it("a prefix already there (422 already_exists) is a conflict; a template without <num> is invalid before any request", async () => {
    const { mock, s } = setup("user");
    mock.on(
      "POST",
      "/repos/ada/compendium/autolinks",
      json({ message: "Validation Failed", errors: [{ resource: "KeyPrefix", code: "already_exists", field: "key_prefix" }] }, 422),
      1,
    );
    await refused(s.repos.createAutolink(REPO, { keyPrefix: "RRID:", urlTemplate: "https://scicrunch.org/resolver/RRID:<num>" }), "conflict");
    const before = apiCalls(mock).length;
    await refused(s.repos.createAutolink(REPO, { keyPrefix: "RRID:", urlTemplate: "https://scicrunch.org/resolver/RRID:" }), "invalid");
    await refused(s.repos.createAutolink(REPO, { keyPrefix: "RRID:", urlTemplate: "ftp://example.org/<num>" }), "invalid");
    await refused(s.repos.deleteAutolink(REPO, "../8"), "invalid");
    assert.equal(apiCalls(mock).length, before);
  });

  it("an installation session cannot create one (the installation rule), nor delete one", async () => {
    const { mock, s } = setup("installation");
    const e = await refused(s.repos.createAutolink(REPO, { keyPrefix: "RRID:", urlTemplate: "https://scicrunch.org/resolver/RRID:<num>" }), "forbidden");
    assert.equal(e.message, INSTALLATION_RULE);
    await refused(s.repos.deleteAutolink(REPO, "8"), "forbidden");
    assert.equal(apiCalls(mock).length, 0);
  });
});

describe("the GitHub adapter's requests", () => {
  it("sends the API version, the media type and its user agent; the token only when there is one", async () => {
    for (const kind of ["user", "anonymous", "installation"] as const) {
      const { mock, s } = setup(kind);
      mock.on("GET", "/repos/ada/compendium", json(ghRepo()));
      await s.repos.get(REPO);
      const call = apiCalls(mock)[0];
      assert.equal(call.headers.get("X-GitHub-Api-Version"), "2022-11-28");
      assert.equal(call.headers.get("Accept"), "application/vnd.github+json");
      assert.equal(call.headers.get("User-Agent"), "code-registry-forge");
      assert.ok(call.init.signal instanceof AbortSignal, "a timeout");
      const authorization = call.headers.get("Authorization");
      if (kind === "anonymous") assert.equal(authorization, null);
      if (kind === "user") assert.equal(authorization, `Bearer ${TOKEN}`);
      if (kind === "installation") assert.equal(authorization, `Bearer ${INSTALLATION_TOKEN}`);
    }
  });

  it("reads the raw CDN with no header at all (no CORS preflight in a browser)", async () => {
    const { mock, s } = setup("anonymous");
    mock.on("GET", "/ada/compendium/main/a.txt", raw("a\n"));
    await s.git.readFile(REPO, "main", "a.txt");
    assert.deepEqual([...mock.last().headers.keys()], []);
  });

  it("stops reading a file over maxBytes: from Content-Length, or while streaming", async () => {
    const { mock, s } = setup("user");
    mock.on("GET", "/repos/ada/compendium/contents/big.bin", raw("x", 200, { "Content-Length": "2000000" }), 1);
    await refused(s.git.readFile(REPO, "main", "big.bin", { maxBytes: 1_000_000 }), "too_large");
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new Uint8Array(64 * 1024));
        if (pulled > 1000) ctrl.close();
      },
    });
    mock.on("GET", "/repos/ada/compendium/contents/stream.bin", () => new Response(endless, { headers: { "Content-Type": "application/vnd.github.raw" } }), 1);
    await refused(s.git.readFile(REPO, "main", "stream.bin", { maxBytes: 100_000 }), "too_large");
    assert.ok(pulled < 10, `${pulled} chunks pulled`);
  });

  it("posts a check run's annotations 50 a request", async () => {
    const { mock, s } = setup("installation");
    mock.on("POST", "/repos/ada/compendium/check-runs", json(ghCheckRun(), 201));
    mock.on("PATCH", "/repos/ada/compendium/check-runs/40001", json(ghCheckRun()));
    const annotations = Array.from({ length: 120 }, (_, i) => ({ path: "m.py", startLine: i + 1, endLine: i + 1, level: "warning" as const, message: `line ${i + 1}` }));
    await s.checks.create(REPO, { name: "Tracing map", headSha: HEAD, status: "completed", conclusion: "neutral", output: { title: "Lines", summary: "…", annotations } });
    const bodies = apiCalls(mock).map((c) => JSON.parse(c.body) as { output: { annotations: { start_line: number; annotation_level: string }[] } });
    assert.deepEqual(bodies.map((x) => x.output.annotations.length), [50, 50, 20]);
    assert.deepEqual(bodies.map((x) => x.output.annotations[0].start_line), [1, 51, 101]);
    assert.equal(bodies[0].output.annotations[0].annotation_level, "warning");
    assert.equal((JSON.parse(apiCalls(mock)[0].body) as { name: string }).name, "Tracing map");
  });

  it("refuses a directory read as a file", async () => {
    const { mock, s } = setup("user");
    mock.on("GET", "/repos/ada/compendium/contents/src", json([{ name: "a.py", path: "src/a.py", sha: SHA("a1"), type: "file", size: 3, _links: {} }]));
    await refused(s.git.readFile(REPO, "main", "src"), "invalid");
    const { mock: m2, s: s2 } = setup("user");
    m2.on("GET", "/repos/ada/compendium/contents/data.json", json([1, 2, 3]));
    assert.equal(text((await s2.git.readFile(REPO, "main", "data.json")).bytes), "[1,2,3]");
  });

  it("follows pages with the Link header, and refuses a cursor that is not a page number without any request", async () => {
    const { mock, s } = setup("anonymous");
    mock.on("GET", "/repos/ada/compendium/issues", listing([ghIssue(1)], true), 1);
    mock.on("GET", "/repos/ada/compendium/issues", listing([ghIssue(2)]), 1);
    const first = await s.issues.list(REPO);
    assert.equal(first.next, "2");
    const second = await s.issues.list(REPO, {}, { cursor: first.next });
    assert.equal(mock.last().url.searchParams.get("page"), "2");
    assert.equal(second.next, null);
    for (const cursor of ["https://evil.example/?page=2", "2; rm", "-1", "123456"]) await refused(s.issues.list(REPO, {}, { cursor }), "invalid");
    await refused(s.issues.list(REPO, {}, { perPage: 101 }), "invalid");
    assert.equal(mock.calls.length, 2);
  });

  it("keeps at most 6 requests waiting for headers per session", async () => {
    const { mock, s } = setup("anonymous");
    let open = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    mock.on("GET", /^\/repos\/ada\/compendium\/languages/, async () => {
      open++;
      most = Math.max(most, open);
      await new Promise<void>((r) => waiting.push(r));
      open--;
      return json({ Python: 1 });
    });
    let done = false;
    const all = Promise.all(Array.from({ length: 10 }, () => s.repos.languages(REPO))).finally(() => {
      done = true;
    });
    for (let n = 0; n < 200 && !done; n++) {
      await new Promise((r) => setTimeout(r, 1));
      waiting.splice(0).forEach((w) => w());
    }
    await all;
    assert.ok(most <= 6, `${most} at once`);
    assert.equal(s.cost().requests, 10);
  });

  it("checks names, refs and paths before any request", async () => {
    const { mock, s } = setup("user");
    await refused(s.repos.get({ forge: "github", owner: "../x", name: "y" }), "invalid");
    await refused(s.git.getBranch(REPO, "a..b"), "invalid");
    await refused(s.git.readFile(REPO, "main", ".git/config"), "invalid");
    await refused(s.git.createCommit(REPO, { branch: "main", expectedHead: HEAD, changes: [{ op: "put", path: "../x", content: utf8("x") }], message: "m" }), "invalid");
    await refused(s.issues.createLabel(REPO, { name: "x", color: "red", description: "" }), "invalid");
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(s.cost(), { requests: 0, writes: 0, graphql: 0, mints: 0 });
  });

  it("refuses what the session may not do, before any request", async () => {
    const { mock, s: a } = setup("anonymous");
    await refused(a.repos.create({ name: "x", visibility: "public" }), "unauthorized");
    const blame = await refused(a.git.blame(REPO, "main", "m.py"), "unsupported");
    assert.equal(blame.fallbackUrl, "https://github.com/ada/compendium/blame/main/m.py");
    const search = await refused(a.git.search(REPO, "fit model"), "unsupported");
    assert.equal(search.fallbackUrl, "https://github.com/search?q=repo%3Aada%2Fcompendium+fit+model&type=code");
    await refused(a.pulls.threads(REPO, 7), "unsupported");
    const { s: i } = setup("installation");
    await refused(i.issues.comment(REPO, 3, "from the App"), "forbidden");
    await refused(i.repos.setTopics(REPO, ["x"]), "forbidden");
    const { s: u } = setup("user");
    await refused(u.checks.create(REPO, { name: "Mine", headSha: HEAD }), "forbidden");
    const imported = await refused(u.repos.importRepository({ source: { kind: "zenodo", recordId: "123" }, owner: "ada", name: "x", visibility: "public" }), "unsupported");
    assert.equal(imported.fallbackUrl, "https://github.com/new/import");
    assert.equal(mock.calls.length, 0);
  });
});

describe("GitHub's answers as error codes", () => {
  const rows: { name: string; kind?: Kind; reply: () => Response; code: GitErrorCode; extra?: (e: GitBackendError) => void; call?: (s: GitSession) => Promise<unknown> }[] = [
    { name: "5xx, with Retry-After", reply: () => json({ message: "Server Error" }, 502, { "Retry-After": "30" }), code: "unavailable", extra: (e) => assert.equal(e.retryAfter, 30) },
    { name: "401", reply: () => json({ message: "Bad credentials" }, 401), code: "unauthorized" },
    {
      name: "403, primary quota spent (anonymous: the forge's page)",
      kind: "anonymous",
      reply: () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW + 600) }),
      code: "rate_limited",
      extra: (e) => {
        assert.equal(e.retryAfter, 600);
        assert.equal(e.limit, "primary");
        assert.equal(e.fallbackUrl, "https://github.com/ada/compendium");
      },
    },
    {
      name: "429, primary, for a person (no fallback)",
      reply: () => json({ message: "rate limited" }, 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW - 5) }),
      code: "rate_limited",
      extra: (e) => {
        assert.equal(e.retryAfter, 1);
        assert.equal(e.fallbackUrl, null);
      },
    },
    { name: "403, secondary (retry-after)", reply: () => json({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "45" }), code: "rate_limited", extra: (e) => assert.deepEqual([e.retryAfter, e.limit], [45, "secondary"]) },
    { name: "403, secondary (no header: a minute)", reply: () => json({ message: "You have exceeded a secondary rate limit" }, 403), code: "rate_limited", extra: (e) => assert.equal(e.retryAfter, 60) },
    { name: "403, archived", reply: () => json({ message: "Repository was archived so is read-only." }, 403), code: "archived" },
    { name: "403, other", reply: () => json({ message: "Resource not accessible by integration" }, 403), code: "forbidden" },
    { name: "404", reply: () => json({ message: "Not Found" }, 404), code: "not_found" },
    { name: "409", reply: () => json({ message: "Conflict" }, 409), code: "conflict" },
    { name: "410", reply: () => json({ message: "Issues are disabled for this repo" }, 410), code: "gone" },
    { name: "413", reply: () => json({ message: "Too large" }, 413), code: "too_large" },
    { name: "422, already exists", reply: () => json({ message: "Validation Failed", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] }, 422), code: "conflict" },
    { name: "422, not a fast forward", reply: () => json({ message: "Update is not a fast forward" }, 422), code: "conflict" },
    { name: "422, other", reply: () => json({ message: "Validation Failed", errors: [{ code: "invalid" }] }, 422), code: "invalid" },
    { name: "422, an unknown revision", reply: () => json({ message: "No commit found for SHA: nothing-here" }, 422), code: "not_found", call: (s) => s.git.resolve(REPO, "nothing-here") },
    { name: "451", reply: () => json({ message: "Repository access blocked" }, 451), code: "gone" },
    { name: "a 2xx of the wrong shape", reply: () => json({ unexpected: true }), code: "unavailable" },
    { name: "a 2xx that is not JSON", reply: () => raw("<html>"), code: "unavailable" },
    { name: "405 on a pull request's merge", reply: () => json({ message: "Pull Request is not mergeable" }, 405), code: "not_mergeable", call: (s) => s.pulls.merge(REPO, 7, { method: "merge", expectedHead: HEAD }) },
    { name: "409 on a pull request's merge (the head moved)", reply: () => json({ message: "Head branch was modified. Review and try the merge again." }, 409), code: "conflict", call: (s) => s.pulls.merge(REPO, 7, { method: "merge", expectedHead: HEAD }) },
    { name: "GraphQL NOT_FOUND", reply: () => json({ data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }), code: "not_found", call: (s) => s.git.blame(REPO, "main", "m.py") },
    { name: "GraphQL FORBIDDEN", reply: () => json({ errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }), code: "forbidden", call: (s) => s.git.blame(REPO, "main", "m.py") },
    { name: "GraphQL INSUFFICIENT_SCOPES", reply: () => json({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "…" }] }), code: "forbidden", call: (s) => s.git.blame(REPO, "main", "m.py") },
    { name: "GraphQL RATE_LIMITED", reply: () => json({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW + 90) }), code: "rate_limited", extra: (e) => assert.equal(e.retryAfter, 90), call: (s) => s.git.blame(REPO, "main", "m.py") },
    { name: "GraphQL RATE_LIMITED, without the headers (a minute, the primary quota)", reply: () => json({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), code: "rate_limited", extra: (e) => assert.deepEqual([e.retryAfter, e.limit], [60, "primary"]), call: (s) => s.git.blame(REPO, "main", "m.py") },
    { name: "GraphQL STALE_DATA", reply: () => json({ errors: [{ type: "STALE_DATA", message: "…" }] }), code: "conflict", call: (s) => s.git.createCommit(REPO, { branch: "main", expectedHead: HEAD, changes: [{ op: "put", path: "a", content: utf8("a") }], message: "m" }) },
    {
      name: "GraphQL: createCommitOnBranch's stale head",
      reply: () => json({ errors: [{ type: "UNPROCESSABLE", message: `Expected branch to point to "${BASE}" but it did not. Pull and try again.` }] }),
      code: "conflict",
      call: (s) => s.git.createCommit(REPO, { branch: "main", expectedHead: HEAD, changes: [{ op: "put", path: "a", content: utf8("a") }], message: "m" }),
    },
    {
      name: "GraphQL, a write to an archived repository",
      reply: () => json({ errors: [{ type: "FORBIDDEN", message: "Repository was archived so is read-only." }] }),
      code: "archived",
      call: (s) => s.git.createCommit(REPO, { branch: "main", expectedHead: HEAD, changes: [{ op: "put", path: "a", content: utf8("a") }], message: "m" }),
    },
    { name: "GraphQL, an input error", reply: () => json({ errors: [{ type: "UNPROCESSABLE", message: "Path is invalid" }] }), code: "invalid", call: (s) => s.git.blame(REPO, "main", "m.py") },
    { name: "GraphQL, anything else", reply: () => json({ errors: [{ type: "SERVICE_UNAVAILABLE", message: "Something went wrong" }] }), code: "unavailable", call: (s) => s.git.blame(REPO, "main", "m.py") },
  ];
  for (const row of rows) {
    it(row.name, async () => {
      const { mock, s } = setup(row.kind ?? "user");
      mock.fallback = () => row.reply();
      const e = await refused((row.call ?? ((x: GitSession) => x.repos.get(REPO)))(s), row.code);
      row.extra?.(e);
      assert.ok(!e.message.includes(TOKEN));
    });
  }

  it("a network failure or a timeout is unavailable, and nothing is retried", async () => {
    const { mock, s } = setup("user");
    mock.fallback = () => {
      throw new TypeError("fetch failed");
    };
    await refused(s.repos.get(REPO), "unavailable");
    const { mock: m2, s: s2 } = setup("user");
    m2.fallback = () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW + 60) });
    await refused(s2.repos.get(REPO), "rate_limited");
    assert.equal(m2.calls.length, 1, "no retry while limited");
  });

  it("an error never carries a token or an Authorization header", async () => {
    const { mock, s } = setup("user");
    mock.fallback = (req) => json({ message: `Bad credentials for ${req.headers.get("Authorization")}` }, 401);
    const e = await refused(s.repos.get(REPO), "unauthorized");
    assert.ok(!e.message.includes(TOKEN) && !e.message.includes("Bearer"));
    assert.ok(!JSON.stringify({ ...e, message: e.message, stack: e.stack }).includes(TOKEN));
  });
});

describe("createCommit on GitHub", () => {
  const changes: T.FileChange[] = [
    { op: "put", path: "src/model.py", content: utf8("b = 2\n") },
    { op: "delete", path: "old.py" },
  ];
  const answer = (repo = "ada/compendium", branch = "main") =>
    json({ data: { createCommitOnBranch: { commit: { oid: SHA("c0"), tree: { oid: SHA("7e") }, parents: { nodes: [{ oid: HEAD }] } }, ref: { name: branch, repository: { databaseId: 5001, nameWithOwner: repo } } } } });

  it("is one GraphQL mutation for puts and deletes, whatever their number", async () => {
    const { mock, s } = setup("user");
    mock.on("POST", "/graphql", answer());
    const result = await s.git.createCommit(REPO, { branch: "main", expectedHead: HEAD, changes, message: "Fix b\n\nAs in section 2.3" });
    assert.deepEqual(result, { sha: SHA("c0"), tree: SHA("7e"), branch: "main", parents: [HEAD] });
    const sent = mock.json() as { query: string; variables: { input: Record<string, unknown> } };
    assert.match(sent.query, /createCommitOnBranch/);
    assert.deepEqual(sent.variables.input, {
      branch: { repositoryNameWithOwner: "ada/compendium", branchName: "main" },
      expectedHeadOid: HEAD,
      message: { headline: "Fix b", body: "As in section 2.3" },
      fileChanges: { additions: [{ path: "src/model.py", contents: base64(utf8("b = 2\n")) }], deletions: [{ path: "old.py" }] },
    });
    assert.deepEqual(s.cost(), { requests: 1, writes: 1, graphql: 1, mints: 0 });
  });

  it("creates a new branch's ref first", async () => {
    const { mock, s } = setup("user");
    mock.on("POST", "/repos/ada/compendium/git/refs", json({ ref: "refs/heads/fix", object: { sha: HEAD } }, 201));
    mock.on("POST", "/graphql", answer("ada/compendium", "fix"));
    await s.git.createCommit(REPO, { branch: "fix", expectedHead: null, createFrom: HEAD, changes, message: "Fix" });
    assert.deepEqual(mock.json(0), { ref: "refs/heads/fix", sha: HEAD });
    assert.equal((mock.json(1) as { variables: { input: { expectedHeadOid: string } } }).variables.input.expectedHeadOid, HEAD);
  });

  it("is unavailable when GitHub says it committed elsewhere", async () => {
    const { mock, s } = setup("user");
    mock.on("POST", "/graphql", answer("mallory/other"));
    await refused(s.git.createCommit(REPO, { branch: "main", expectedHead: HEAD, changes, message: "Fix" }), "unavailable");
    const { mock: m2, s: s2 } = setup("user");
    m2.on("POST", "/graphql", answer("ada/compendium", "other-branch"));
    await refused(s2.git.createCommit(REPO, { branch: "main", expectedHead: HEAD, changes, message: "Fix" }), "unavailable");
  });

  it("uses the Git data API for moves, executable files, binaries and merges", async () => {
    const { mock, s } = setup("user");
    mock.on("GET", `/repos/ada/compendium/git/commits/${HEAD}`, json({ sha: HEAD, tree: { sha: SHA("7ee") }, parents: [] }));
    mock.on("GET", `/repos/ada/compendium/git/trees/${SHA("7ee")}`, json({ sha: SHA("7ee"), truncated: false, tree: [{ path: "a.py", mode: "100644", type: "blob", sha: SHA("a1"), size: 3 }] }));
    mock.on("POST", "/repos/ada/compendium/git/blobs", json({ sha: SHA("b1") }, 201));
    mock.on("POST", "/repos/ada/compendium/git/trees", json({ sha: SHA("7e2"), tree: [] }, 201));
    mock.on("POST", "/repos/ada/compendium/git/commits", json({ sha: SHA("c2"), tree: { sha: SHA("7e2") }, parents: [{ sha: HEAD }, { sha: BASE }] }, 201));
    mock.on("PATCH", "/repos/ada/compendium/git/refs/heads/main", json({ ref: "refs/heads/main", object: { sha: SHA("c2") } }));
    const result = await s.git.createCommit(REPO, {
      branch: "main",
      expectedHead: HEAD,
      parents: [HEAD, BASE],
      changes: [
        { op: "move", from: "a.py", to: "src/a.py" },
        { op: "put", path: "run.sh", content: utf8("#!/bin/sh\n"), executable: true },
        { op: "put", path: "fig.png", content: Uint8Array.of(0x89, 0x50, 0, 1) },
        { op: "delete", path: "old.txt" },
      ],
      message: "Merge main, conflicts resolved",
    });
    assert.deepEqual(result, { sha: SHA("c2"), tree: SHA("7e2"), branch: "main", parents: [HEAD, BASE] });
    const paths = mock.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`);
    assert.deepEqual(paths, [
      `GET /repos/ada/compendium/git/commits/${HEAD}`,
      `GET /repos/ada/compendium/git/trees/${SHA("7ee")}?recursive=1`,
      "POST /repos/ada/compendium/git/blobs",
      "POST /repos/ada/compendium/git/trees",
      "POST /repos/ada/compendium/git/commits",
      "PATCH /repos/ada/compendium/git/refs/heads/main",
    ]);
    assert.deepEqual(mock.json(2), { content: base64(Uint8Array.of(0x89, 0x50, 0, 1)), encoding: "base64" });
    assert.deepEqual(mock.json(3), {
      base_tree: SHA("7ee"),
      tree: [
        { path: "a.py", mode: "100644", type: "blob", sha: null },
        { path: "src/a.py", mode: "100644", type: "blob", sha: SHA("a1") },
        { path: "run.sh", mode: "100755", type: "blob", content: "#!/bin/sh\n" },
        { path: "fig.png", mode: "100644", type: "blob", sha: SHA("b1") },
        { path: "old.txt", mode: "100644", type: "blob", sha: null },
      ],
    });
    assert.deepEqual(mock.json(4), { message: "Merge main, conflicts resolved", tree: SHA("7e2"), parents: [HEAD, BASE] });
    assert.deepEqual(mock.json(5), { sha: SHA("c2"), force: false });
  });

  it("makes an orphan branch with a new ref, and turns 'not a fast forward' into a conflict", async () => {
    const { mock, s } = setup("user");
    mock.on("POST", "/repos/ada/compendium/git/trees", json({ sha: SHA("7e3") }, 201));
    mock.on("POST", "/repos/ada/compendium/git/commits", json({ sha: SHA("c3"), tree: { sha: SHA("7e3") }, parents: [] }, 201));
    mock.on("POST", "/repos/ada/compendium/git/refs", json({ ref: "refs/heads/wiki", object: { sha: SHA("c3") } }, 201));
    await s.git.createCommit(REPO, { branch: "wiki", expectedHead: null, parents: [], changes: [{ op: "put", path: "Home.md", content: utf8("# Wiki\n") }], message: "Start the wiki" });
    assert.deepEqual(mock.json(0), { tree: [{ path: "Home.md", mode: "100644", type: "blob", content: "# Wiki\n" }] });
    assert.deepEqual(mock.json(2), { ref: "refs/heads/wiki", sha: SHA("c3") });
    const { mock: m2, s: s2 } = setup("user");
    m2.on("GET", `/repos/ada/compendium/git/commits/${HEAD}`, json({ sha: HEAD, tree: { sha: SHA("7ee") } }));
    m2.on("POST", "/repos/ada/compendium/git/trees", json({ sha: SHA("7e4") }, 201));
    m2.on("POST", "/repos/ada/compendium/git/commits", json({ sha: SHA("c4"), tree: { sha: SHA("7e4") }, parents: [{ sha: HEAD }] }, 201));
    m2.on("PATCH", "/repos/ada/compendium/git/refs/heads/main", json({ message: "Update is not a fast forward" }, 422));
    await refused(s2.git.createCommit(REPO, { branch: "main", expectedHead: HEAD, changes: [{ op: "put", path: "run.sh", content: utf8("x"), executable: true }], message: "m" }), "conflict");
  });
});

describe("the GitHub adapter's configuration", () => {
  it("reads the Worker's env: https, or http on localhost only", () => {
    const c = githubConfigFromEnv({ GITHUB_APP_CLIENT_ID: " Iv23li ", FORGE_GITHUB_API_URL: "http://localhost:9471/github-api/", GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n" });
    assert.equal(c.api, "http://localhost:9471/github-api");
    assert.equal(c.web, "https://github.com");
    assert.equal(c.clientId, "Iv23li");
    assert.equal(c.clientSecret, undefined);
    assert.match(c.privateKey ?? "", /\n/);
    for (const bad of ["http://api.example.org", "ftp://localhost", "https://user:pw@api.example.org", "not a url", "https://api.example.org/?x=1"]) {
      assert.throws(() => githubConfigFromEnv({ FORGE_GITHUB_API_URL: bad }), (e: unknown) => e instanceof GitBackendError && e.code === "invalid", bad);
    }
  });

  it("serves anonymous sessions without the App; user and installation sessions need it", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/repos/ada/compendium", json(ghRepo()));
    const backend = githubBackend({}, { fetch: mock.fetch });
    await backend.session({ kind: "anonymous" }).repos.get(REPO);
    assert.throws(() => backend.session({ kind: "user", token: TOKEN }), (e: unknown) => e instanceof GitBackendError && e.code === "unsupported" && /not set up/.test(e.message));
    assert.throws(() => backend.session({ kind: "installation", installationId: "1" }), (e: unknown) => e instanceof GitBackendError && e.code === "unsupported");
    assert.throws(() => backend.auth?.authorizeUrl({ state: "s".repeat(20), codeChallenge: "c".repeat(43), redirectUri: "https://x.example/cb" }), (e: unknown) => e instanceof GitBackendError && e.code === "unsupported");
    assert.equal(backend.capabilities("anonymous").has("blame"), false);
    assert.equal(backend.links.blob(REPO, HEAD, "src/a b.py", { start: 10, end: 12 }), `https://github.com/ada/compendium/blob/${HEAD}/src/a%20b.py#L10-L12`);
  });

  it("parses GitHub's addresses, and builds its pages", () => {
    const { backend } = setup("anonymous");
    const L = backend.links;
    assert.deepEqual(L.parse(`https://github.com/ada/compendium/blob/${HEAD}/src/m.py#L3-L7`), { repo: REPO, rev: HEAD, path: "src/m.py", lines: { start: 3, end: 7 } });
    assert.deepEqual(L.parse("https://github.com/ada/compendium.git"), { repo: REPO, rev: null, path: null, lines: null });
    assert.deepEqual(L.parse("https://github.com/ada/compendium/tree/main"), { repo: REPO, rev: "main", path: null, lines: null });
    assert.equal(L.parse("https://github.com/orgs/ada/people"), null);
    assert.equal(L.parse("https://gitlab.com/ada/compendium"), null);
    assert.equal(L.parse("not a url"), null);
    assert.equal(L.compare(REPO, "main", "feature/x"), "https://github.com/ada/compendium/compare/main...feature/x");
    assert.equal(L.upload(REPO, "main", "data"), "https://github.com/ada/compendium/upload/main/data");
    assert.equal(L.newRelease(REPO, "v1"), "https://github.com/ada/compendium/releases/new?tag=v1");
    assert.equal(L.install("abc"), "https://github.com/apps/code-registry/installations/new?state=abc");
    assert.equal(L.archive(REPO, "v1", "zip"), "https://github.com/ada/compendium/archive/v1.zip");
    const { s } = setup("anonymous");
    assert.equal(s.git.rawUrl(REPO, HEAD, "src/a b.py"), `https://raw.githubusercontent.com/ada/compendium/${HEAD}/src/a%20b.py`);
  });
});
