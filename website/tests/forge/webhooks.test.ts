// GitHub's webhook deliveries (worker/forge/github/webhooks.ts): the signature over the raw body,
// the size cap before any hashing, and the neutral events. The payloads are shaped like GitHub's
// and carry email addresses (the pusher's, the commit authors', the owner's): none survives.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { GitBackendError } from "../../worker/forge/errors.ts";
import { githubWebhooks, WEBHOOK_MAX_BYTES } from "../../worker/forge/github/webhooks.ts";
import { utf8 } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { EMAIL, emailKeys, ghUser, SHA } from "./github-mock.ts";

const SECRET = "webhook-secret-for-tests";
const codec = githubWebhooks();

function delivery(event: string, payload: unknown, secret = SECRET): { headers: Headers; body: Uint8Array } {
  const body = utf8(JSON.stringify(payload));
  const headers = new Headers({
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "Content-Type": "application/json",
  });
  return { headers, body };
}

const repository = (o: { private?: boolean; name?: string } = {}) => ({
  id: 5001,
  node_id: "R_5001",
  name: o.name ?? "compendium",
  full_name: `ada/${o.name ?? "compendium"}`,
  private: o.private ?? false,
  owner: { name: "ada", email: EMAIL, login: "ada", id: 101, type: "User" },
  default_branch: "main",
  pushed_at: 1_790_596_800,
  html_url: "https://github.com/ada/compendium",
});
const installation = { id: 777, account: { login: "ada-lab", id: 909, type: "Organization", email: EMAIL }, repository_selection: "selected", suspended_at: null, app_id: 1 };
const sender = ghUser();

const parse = (event: string, payload: unknown): T.ForgeEvent => {
  const d = delivery(event, payload);
  const e = codec.parse(d.headers, d.body);
  assert.deepEqual(emailKeys(e), [], `${event}: no email field`);
  assert.ok(!JSON.stringify(e).includes(EMAIL), `${event}: no email address`);
  return e;
};

describe("GitHub's webhook deliveries", () => {
  it("verifies the signature over the raw body, in constant time, and nothing else", async () => {
    const d = delivery("ping", { zen: "Keep it logically awesome.", hook_id: 1 });
    assert.equal(await codec.verify(d.headers, d.body, SECRET), true);
    assert.equal(await codec.verify(d.headers, d.body, "another-secret"), false);
    const tampered = d.body.slice();
    tampered[3] ^= 1;
    assert.equal(await codec.verify(d.headers, tampered, SECRET), false);
    for (const header of [null, "", "sha1=abc", `sha256=${"0".repeat(63)}`, "sha256=zz"]) {
      const h = new Headers(d.headers);
      if (header === null) h.delete("X-Hub-Signature-256");
      else h.set("X-Hub-Signature-256", header);
      assert.equal(await codec.verify(h, d.body, SECRET), false, String(header));
    }
    assert.equal(await codec.verify(d.headers, d.body, ""), false, "no secret, no delivery");
  });

  it("refuses a delivery over the cap before hashing it", async () => {
    assert.equal(codec.maxBytes, WEBHOOK_MAX_BYTES);
    const big = new Uint8Array(WEBHOOK_MAX_BYTES + 1);
    const headers = new Headers({ "X-GitHub-Event": "push", "X-GitHub-Delivery": "d-1", "X-Hub-Signature-256": `sha256=${createHmac("sha256", SECRET).update(big).digest("hex")}` });
    assert.equal(await codec.verify(headers, big, SECRET), false);
    assert.throws(() => codec.parse(headers, big), (e: unknown) => e instanceof GitBackendError && e.code === "too_large");
  });

  it("reads ping, installation and installation_repositories", () => {
    assert.deepEqual(parse("ping", { zen: "Design for failure.", hook_id: 1 }), { kind: "ping", delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958" });
    const created = parse("installation", { action: "created", installation, repositories: [repository()], sender });
    assert.deepEqual(created, {
      kind: "installation",
      delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      action: "created",
      installation: { id: "777", account: { id: "909", login: "ada-lab", type: "organization" }, selection: "selected", suspended: false },
      sender: { name: "ada", login: "ada", id: "101" },
    });
    const added = parse("installation_repositories", {
      action: "added",
      installation,
      repository_selection: "selected",
      repositories_added: [{ id: 5001, node_id: "R_5001", name: "compendium", full_name: "ada-lab/compendium", private: false }, { id: 5009, node_id: "R_5009", name: "secret-data", full_name: "ada-lab/secret-data", private: true }],
      repositories_removed: [],
      sender,
    });
    assert.equal(added.kind, "installation_repositories");
    if (added.kind === "installation_repositories") {
      assert.deepEqual(added.added.map((r) => [r.ref.owner, r.ref.name, r.visibility, r.key.id]), [["ada-lab", "compendium", "public", "5001"], ["ada-lab", "secret-data", "private", "5009"]]);
      assert.deepEqual(added.removed, []);
    }
    assert.equal(parse("installation", { action: "something_new", installation, sender }).kind, "other");
  });

  it("reads a push without any email address", () => {
    const e = parse("push", {
      ref: "refs/heads/main",
      before: SHA("aa"),
      after: SHA("bb"),
      created: false,
      deleted: false,
      forced: true,
      repository: repository(),
      pusher: { name: "ada", email: EMAIL },
      sender,
      installation: { id: 777, node_id: "MDIz" },
      commits: [{ id: SHA("bb"), message: "Fix b\n\nSigned-off-by: Ada <ada@example.org>", author: { name: "Ada", email: EMAIL, username: "ada" }, committer: { name: "Ada", email: EMAIL }, added: ["new.py"], removed: [], modified: ["m.py"] }],
      head_commit: { id: SHA("bb"), author: { name: "Ada", email: EMAIL } },
    });
    assert.deepEqual(e, {
      kind: "push",
      delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      installation: "777",
      repo: { key: { forge: "github", id: "5001" }, ref: { forge: "github", owner: "ada", name: "compendium" }, visibility: "public", defaultBranch: "main" },
      ref: "refs/heads/main",
      before: SHA("aa"),
      after: SHA("bb"),
      created: false,
      deleted: false,
      forced: true,
      pushedAt: 1_790_596_800,
      commits: [{ sha: SHA("bb"), added: ["new.py"], removed: [], modified: ["m.py"] }],
      pusher: { name: "ada", login: "ada", id: "101" },
    });
    const byKey = parse("push", { ref: "refs/heads/main", before: SHA("aa"), after: SHA("cc"), repository: repository({ private: true }), pusher: { name: "deploy-key", email: null }, sender, commits: [] });
    assert.ok(byKey.kind === "push" && byKey.pusher.login === null && byKey.repo.visibility === "private" && byKey.installation === null);
  });

  it("reads repository events, with what a rename or a transfer changed", () => {
    const renamed = parse("repository", { action: "renamed", changes: { repository: { name: { from: "old-name" } } }, repository: repository(), sender, installation: { id: 777 } });
    assert.ok(renamed.kind === "repository");
    if (renamed.kind === "repository") {
      assert.equal(renamed.action, "renamed");
      assert.deepEqual(renamed.previous, { owner: null, name: "old-name" });
      assert.equal(renamed.installation, "777");
    }
    const moved = parse("repository", { action: "transferred", changes: { owner: { from: { user: { login: "ada", id: 101, email: EMAIL } } } }, repository: repository(), sender });
    assert.ok(moved.kind === "repository" && moved.previous?.owner === "ada");
    const archived = parse("repository", { action: "archived", repository: repository(), sender });
    assert.ok(archived.kind === "repository" && archived.previous === null);
    assert.equal(parse("repository", { action: "unknown_action", repository: repository(), sender }).kind, "other");
  });

  it("reads create and delete as ref events; a repository's creation is not one", () => {
    const tag = parse("create", { ref: "v1.0.0", ref_type: "tag", master_branch: "main", repository: repository(), sender });
    assert.deepEqual(tag.kind === "ref" && [tag.action, tag.refType, tag.ref], ["created", "tag", "v1.0.0"]);
    const gone = parse("delete", { ref: "feature/x", ref_type: "branch", repository: repository(), sender });
    assert.deepEqual(gone.kind === "ref" && [gone.action, gone.refType, gone.ref], ["deleted", "branch", "feature/x"]);
    assert.equal(parse("create", { ref: "x", ref_type: "repository", repository: repository(), sender }).kind, "other");
  });

  it("reads pull_request and release, and turns anything else into other", () => {
    const pr = parse("pull_request", {
      action: "closed",
      number: 7,
      pull_request: { number: 7, merged: true, head: { ref: "sensitivity", sha: SHA("11"), user: { email: EMAIL } }, base: { ref: "main", sha: SHA("22") }, user: ghUser("bo", 303) },
      repository: repository(),
      sender,
      installation: { id: 777 },
    });
    assert.deepEqual(pr, {
      kind: "pull_request",
      delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      installation: "777",
      action: "closed",
      number: 7,
      repo: { key: { forge: "github", id: "5001" }, ref: { forge: "github", owner: "ada", name: "compendium" }, visibility: "public", defaultBranch: "main" },
      head: { ref: "sensitivity", sha: SHA("11") },
      base: { ref: "main" },
      merged: true,
      sender: { name: "ada", login: "ada", id: "101" },
    });
    const release = parse("release", { action: "published", release: { id: 60001, tag_name: "v1.0.0", author: ghUser() }, repository: repository(), sender });
    assert.deepEqual(release.kind === "release" && [release.action, release.releaseId, release.tagName], ["published", "60001", "v1.0.0"]);
    assert.deepEqual(parse("star", { action: "created", repository: repository(), sender }), { kind: "other", delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958", event: "star" });
  });

  it("refuses what is not a well-formed delivery", () => {
    const refused = (headers: Headers, body: Uint8Array) => assert.throws(() => codec.parse(headers, body), (e: unknown) => e instanceof GitBackendError && e.code === "invalid");
    const d = delivery("push", { ref: "refs/heads/main" });
    refused(d.headers, d.body);
    refused(d.headers, utf8("not json"));
    refused(d.headers, utf8("[1, 2]"));
    const noEvent = new Headers(d.headers);
    noEvent.delete("X-GitHub-Event");
    refused(noEvent, d.body);
    const badDelivery = new Headers(d.headers);
    badDelivery.set("X-GitHub-Delivery", "not a delivery id!");
    refused(badDelivery, d.body);
  });
});
