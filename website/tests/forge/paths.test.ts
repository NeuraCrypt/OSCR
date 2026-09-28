// Names, refs and paths (worker/forge/paths.ts), the rule of who may do what (rules.ts), git's
// bytes (objects.ts) and the errors (errors.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitBackendError, isGitError, problemBody, STATUS } from "../../worker/forge/errors.ts";
import { GITHUB_CAPABILITIES } from "../../worker/forge/limits.ts";
import { base64, blobId, fromBase64, isBinary, lfsPointer, utf8 } from "../../worker/forge/objects.ts";
import { checkChanges, checkCommitInput, checkPath, checkRepo, checkRev, isRefName } from "../../worker/forge/paths.ts";
import { guard } from "../../worker/forge/rules.ts";

const invalid = (f: () => unknown) => assert.throws(f, (e: unknown) => isGitError(e, "invalid"));

test("accepts repository names as GitHub does, and refuses the rest", () => {
  for (const name of ["compendium", "my.study-2026_v2", "A"]) checkRepo({ forge: "github", owner: "ada-lab", name });
  for (const name of ["", ".", "..", "a b", "x.git", "a/b", "é", "x".repeat(101)]) invalid(() => checkRepo({ forge: "github", owner: "ada", name }));
  invalid(() => checkRepo({ forge: "github", owner: "bad owner", name: "x" }));
});

test("accepts branch and tag names that git accepts, within OSCR's subset", () => {
  for (const ok of ["main", "feature/tracing-map", "v1.0.0", "refs/heads/main", "release-2026.09", "wiki"]) assert.ok(isRefName(ok), ok);
  for (const bad of ["", "@", "a..b", "a/", "/a", ".hidden", "a/.b", "x.lock", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "a@{1}", "a\u0001", "end.", "a//b"]) {
    assert.ok(!isRefName(bad), JSON.stringify(bad));
  }
  assert.ok(!isRefName("x".repeat(256)));
  assert.equal(checkRev("0123456789abcdef0123456789abcdef01234567"), "0123456789abcdef0123456789abcdef01234567");
  assert.equal(checkRev("a".repeat(64)), "a".repeat(64));
});

test("accepts relative paths only, NFC-normalized, never into .git", () => {
  assert.equal(checkPath("src/model.py"), "src/model.py");
  assert.equal(checkPath("café.txt"), "café.txt");
  assert.equal(checkPath("", true), "");
  for (const bad of ["", "/abs", "a//b", "a/", "../x", "a/../b", "./a", ".git", "src/.GIT/config", "a\u0000b", "x".repeat(4097)]) invalid(() => checkPath(bad));
});

test("refuses a path twice in one commit, and heads that make no sense", () => {
  const put = (path: string) => ({ op: "put" as const, path, content: utf8("x") });
  invalid(() => checkChanges([put("a"), put("a")]));
  invalid(() => checkChanges([put("a"), { op: "move", from: "b", to: "a" }]));
  invalid(() => checkChanges([{ op: "move", from: "a", to: "a" }]));
  const head = "0".repeat(40);
  invalid(() => checkCommitInput({ branch: "main", expectedHead: null, changes: [put("a")], message: "m" }));
  invalid(() => checkCommitInput({ branch: "main", expectedHead: head, changes: [put("a")], message: "" }));
  invalid(() => checkCommitInput({ branch: "main", expectedHead: head, parents: [head, head, head], changes: [], message: "m" }));
  invalid(() => checkCommitInput({ branch: "main", expectedHead: "1".repeat(40), createFrom: head, changes: [], message: "m" }));
  assert.equal(checkCommitInput({ branch: "wiki", expectedHead: null, parents: [], changes: [put("Home.md")], message: "m" }).branch, "wiki");
});

test("puts the rule of the sessions in one place", () => {
  const caps = GITHUB_CAPABILITIES;
  assert.throws(() => guard("anonymous", caps.anonymous, "write"), (e: unknown) => isGitError(e, "unauthorized"));
  assert.throws(() => guard("installation", caps.installation, "write"), (e: unknown) => isGitError(e, "forbidden") && /only post check runs/.test((e as Error).message));
  assert.throws(() => guard("user", caps.user, "check"), (e: unknown) => isGitError(e, "forbidden"));
  guard("installation", caps.installation, "check", "checkRuns");
  guard("user", caps.user, "write", "createRepository");
  assert.throws(
    () => guard("anonymous", caps.anonymous, "read", "blame", "https://github.com/o/r/blame/main/x"),
    (e: unknown) => isGitError(e, "unsupported") && (e as GitBackendError).fallbackUrl === "https://github.com/o/r/blame/main/x",
  );
  assert.ok(!caps.user.has("serverImport") && !caps.installation.has("createRepository"));
});

test("reads bytes as git does: blob ids, the binary rule, LFS pointers", async () => {
  assert.equal(await blobId(utf8("hello world\n")), "3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  assert.equal(isBinary(Uint8Array.of(65, 0, 66)), true);
  const late = new Uint8Array(9000).fill(65);
  late[8500] = 0;
  assert.equal(isBinary(late), false, "a NUL after the first 8,000 bytes does not count");
  const oid = "a".repeat(64);
  assert.deepEqual(lfsPointer(utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 42\n`)), { oid, size: 42 });
  assert.equal(lfsPointer(utf8("version 2\n")), null);
});

test("writes and reads base64 as the platform does, at any length", () => {
  for (let n = 0; n < 70; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n) % 256);
    const b64 = base64(bytes);
    assert.equal(b64, Buffer.from(bytes).toString("base64"), `length ${n}`);
    assert.deepEqual(fromBase64(b64), bytes);
  }
  const big = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 131) % 256);
  assert.equal(base64(big), Buffer.from(big).toString("base64"));
  assert.deepEqual(fromBase64("aGVs\nbG8=\n"), utf8("hello"));
});

test("maps each code to the Worker's status and problem body", () => {
  const e = new GitBackendError("rate_limited", "the forge's hourly quota is spent", { retryAfter: 30, fallbackUrl: "https://github.com/o/r" });
  assert.equal(STATUS[e.code], 429);
  assert.deepEqual(problemBody(e), { error: { code: "rate_limited", message: "the forge's hourly quota is spent", retryAfter: 30, fallbackUrl: "https://github.com/o/r" } });
  assert.equal(STATUS.not_mergeable, 409);
  assert.equal(STATUS.unsupported, 501);
});
