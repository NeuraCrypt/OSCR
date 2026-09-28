// Refs, trees, files and commits on GitHub (phases 01–03, 06).
//
//   listBranches / getBranch   GET …/branches, …/branches/{b}
//   createBranch               POST …/git/refs {ref: "refs/heads/…", sha}
//   renameBranch               POST …/branches/{b}/rename {new_name}
//   deleteBranch               GET …/repos/{o}/{r} (the default branch is refused locally), then
//                              DELETE …/git/refs/heads/{b}
//   listTags                   GET …/tags (annotations are not read: one more request each)
//   createTag                  lightweight: POST …/git/refs; annotated: POST …/git/tags, then POST …/git/refs
//   deleteTag                  DELETE …/git/refs/tags/{t}
//   resolve                    GET …/commits/{rev}, Accept: application/vnd.github.sha (text)
//   tree                       the root: GET …/git/trees/{rev}[?recursive=1]. Under a path: GET
//                              …/contents/{parent}?ref= gives the directory's tree id, then GET
//                              …/git/trees/{id}[?recursive=1]: two requests at any depth, with
//                              the entries' modes (the contents listing alone has neither the
//                              modes nor the directory's own id)
//   readFile                   anonymous: GET {raw}/{o}/{r}/{rev}/{path}, no header, not counted
//                              (the reader's own quota), the blob id computed locally. Otherwise
//                              GET …/contents/{path}?ref=, Accept raw (≤ 100 MB). Over maxBytes:
//                              too_large, and the body is not read to its end
//   rawUrl                     {raw}/{o}/{r}/{sha}/{path}, no request
//   commits                    GET …/commits?sha=&path=&since=&until=&author= (409 "Git
//                              Repository is empty": an empty page)
//   commit                     GET …/commits/{sha}?page=&per_page= (the files are paged)
//   compare                    GET …/compare/{base}...{head}: up to 250 commits and 300 files,
//                              which GitHub lists on the first page only; the files are paged
//                              here, from that answer
//   diff                       the same, Accept: application/vnd.github.diff, read up to maxBytes
//   blame                      GraphQL `blame` (user and installation sessions)
//   search                     GET /search/code?q={query} repo:{o}/{r} (authenticated only; 10 a
//                              minute), with text matches for the fragments
//   createCommit               see below
//   merge                      (GET …/branches/{base} when expectedBaseHead is given: GitHub's
//                              merge has no compare-and-swap), then POST …/merges: 201 merged,
//                              204 up to date, 409 conflict
//
// createCommit: the ordinary case (one parent, the branch's head; puts and deletes; no executable
// bit) is ONE GraphQL call, createCommitOnBranch:
// - `expectedHeadOid` is required, which gives the compare-and-swap;
// - one content-creating request whatever the number of files;
// - GitHub signs the commit and marks it verified;
// - the author is the credential's owner: the person, never the App.
// A new branch (`createFrom`) first gets its ref (POST …/git/refs). After the call, the answer's
// branch and repository must be the ones asked for, or the result is `unavailable`.
// The other cases (moves without re-sending content, executable bits, two parents or none) use
// the Git data API: GET …/git/commits/{parent} (the base tree); for moves GET
// …/git/trees/{base_tree}?recursive=1; POST …/git/blobs for each binary put (a UTF-8 text goes
// inline); POST …/git/trees {base_tree, tree}; POST …/git/commits; then PATCH
// …/git/refs/heads/{branch} {sha, force: false} (422 "not a fast forward" is `conflict`), or POST
// …/git/refs for a new branch or an orphan. Documented edge case: a branch reset backwards to an
// ancestor of expectedHead makes the update a fast-forward, which succeeds.
// A commit whose changes leave the tree as it was is refused by the test double; GitHub records
// it, so the adapter refuses only a commit with no change at all (`changes: []`).

import { GitBackendError, invalid } from "../errors.ts";
import type { GitOps } from "../gitbackend.ts";
import { DEFAULT_DIFF_BYTES, DEFAULT_READ_BYTES } from "../limits.ts";
import { base64, fileContent, isBinary, isUtf8, text } from "../objects.ts";
import { checkCommitInput, checkMessage, checkObjectId, checkPath, checkRefName, checkRepo, checkRev, isObjectId } from "../paths.ts";
import type * as T from "../types.ts";
import { type Ctx, need, paged, R, scope } from "./ctx.ts";
import { BLAME, CREATE_COMMIT, dig } from "./graphql.ts";
import { MEDIA, nextPage, readJson, readLimited, readSome, restPage } from "./http.ts";
import { escapePath } from "./links.ts";
import * as map from "./map.ts";

function checkMax(v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1) throw invalid("maxBytes is a positive integer");
  return v;
}

function checkQuery(q: unknown): string {
  if (typeof q !== "string" || !q.trim() || q.length > 256 || /[\u0000-\u001f]/.test(q)) throw invalid("not a search");
  return q.trim();
}

/** "headline" and "body" of a commit message, as GitHub's GraphQL wants them. */
function splitMessage(message: string): { headline: string; body?: string } {
  const i = message.indexOf("\n");
  if (i < 0) return { headline: message };
  const body = message.slice(i + 1).replace(/^\n+/, "");
  return body ? { headline: message.slice(0, i), body } : { headline: message.slice(0, i) };
}

export function gitOps(ctx: Ctx): GitOps {
  const { http, links, limits } = ctx;
  const endpoints = http.options.endpoints;

  const resolve = async (repo: T.RepoRef, rev: T.Rev): Promise<T.ObjectId> => {
    need(ctx, "read");
    const path = `${R(repo)}/commits/${escapePath(checkRev(rev))}`;
    const res = await http.send({ path, accept: MEDIA.sha, scope: scope(repo, "read"), view: links.tree(repo, rev) });
    const sha = (await readSome(res, 200)).trim();
    if (!isObjectId(sha)) throw new GitBackendError("unavailable", "unexpected answer from the forge (sha)");
    return sha;
  };

  const readTree = async (repo: T.RepoRef, treeish: string, recursive: boolean, prefix: string, view: string): Promise<T.Tree> => {
    const answer = map.obj(
      await http.json({ path: `${R(repo)}/git/trees/${escapePath(treeish)}`, query: { recursive: recursive ? 1 : undefined }, scope: scope(repo, "read"), view }),
      "tree",
    );
    return {
      sha: map.sha(answer),
      entries: map.list(answer.tree, "tree").map((e) => map.treeEntry(e, prefix)),
      truncated: map.bool(answer, "truncated", false),
    };
  };

  /** The GraphQL path of createCommit. */
  const commitOnBranch = async (repo: T.RepoRef, input: T.CommitInput): Promise<T.CommitResult> => {
    const base = R(repo);
    if (input.createFrom !== undefined) {
      await http.send({ method: "POST", path: `${base}/git/refs`, json: { ref: `refs/heads/${input.branch}`, sha: input.createFrom } });
    }
    const additions: { path: string; contents: string }[] = [];
    const deletions: { path: string }[] = [];
    for (const c of input.changes) {
      if (c.op === "put") additions.push({ path: c.path, contents: base64(c.content) });
      else if (c.op === "delete") deletions.push({ path: c.path });
    }
    const data = await http.graphql(
      CREATE_COMMIT,
      {
        input: {
          branch: { repositoryNameWithOwner: `${repo.owner}/${repo.name}`, branchName: input.branch },
          expectedHeadOid: input.expectedHead ?? input.createFrom,
          message: splitMessage(input.message),
          fileChanges: { additions, deletions },
        },
      },
      { mutation: true },
    );
    const answer = map.obj(dig(data, "createCommitOnBranch"), "createCommitOnBranch");
    const commit = map.obj(answer.commit, "commit");
    const ref = map.obj(answer.ref, "ref");
    const where = map.obj(ref.repository, "repository");
    const refName = map.str(ref, "name").replace(/^refs\/heads\//, "");
    const named = map.optStr(where, "nameWithOwner");
    if (refName !== input.branch || (named !== null && named.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase())) {
      throw new GitBackendError("unavailable", "the forge committed elsewhere than asked");
    }
    return {
      sha: map.sha(commit, "oid"),
      tree: map.sha(map.obj(commit.tree, "tree"), "oid"),
      branch: input.branch,
      parents: map.list(map.obj(commit.parents, "parents").nodes, "parents").map((p) => map.sha(map.obj(p, "parent"), "oid")),
    };
  };

  /** The Git data API path of createCommit. */
  const commitWithData = async (repo: T.RepoRef, input: T.CommitInput): Promise<T.CommitResult> => {
    const base = R(repo);
    const parents = input.parents ?? [(input.expectedHead ?? input.createFrom) as string];
    const orphan = parents.length === 0;
    let baseTree: string | null = null;
    if (!orphan) {
      const parent = map.obj(await http.json({ path: `${base}/git/commits/${parents[0]}`, scope: scope(repo, "read") }), "commit");
      baseTree = map.sha(map.obj(parent.tree, "tree"));
    }
    const moves = input.changes.filter((c) => c.op === "move");
    const known = new Map<string, T.TreeEntry>();
    if (moves.length) {
      if (!baseTree) throw invalid("an orphan commit has nothing to move");
      const whole = await readTree(repo, baseTree, true, "", links.repo(repo));
      for (const e of whole.entries) known.set(e.path, e);
      for (const m of moves) {
        if (m.op === "move" && !known.has(m.from)) {
          throw whole.truncated ? new GitBackendError("too_large", "the tree is too large to move files through the API") : new GitBackendError("not_found", "no file to move");
        }
      }
    }
    const entries: Record<string, unknown>[] = [];
    for (const c of input.changes) {
      if (c.op === "put") {
        const mode = c.executable ? "100755" : "100644";
        if (isUtf8(c.content) && !isBinary(c.content)) {
          entries.push({ path: c.path, mode, type: "blob", content: text(c.content) });
        } else {
          const blob = map.obj(await http.json({ method: "POST", path: `${base}/git/blobs`, json: { content: base64(c.content), encoding: "base64" } }), "blob");
          entries.push({ path: c.path, mode, type: "blob", sha: map.sha(blob) });
        }
      } else if (c.op === "delete") {
        entries.push({ path: c.path, mode: "100644", type: "blob", sha: null });
      } else {
        const old = known.get(c.from) as T.TreeEntry;
        if (old.type !== "blob") throw invalid("only files are moved");
        entries.push({ path: c.from, mode: old.mode, type: "blob", sha: null });
        entries.push({ path: c.to, mode: old.mode, type: "blob", sha: old.sha });
      }
    }
    if (orphan && !entries.length) throw invalid("an orphan commit needs files");
    const tree = map.obj(
      await http.json({ method: "POST", path: `${base}/git/trees`, json: baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries } }),
      "tree",
    );
    const treeSha = map.sha(tree);
    const made = map.obj(await http.json({ method: "POST", path: `${base}/git/commits`, json: { message: input.message, tree: treeSha, parents } }), "commit");
    const sha = map.sha(made);
    if (input.createFrom !== undefined || input.expectedHead === null) {
      await http.send({ method: "POST", path: `${base}/git/refs`, json: { ref: `refs/heads/${input.branch}`, sha } });
    } else {
      await http.send({ method: "PATCH", path: `${base}/git/refs/heads/${escapePath(input.branch)}`, json: { sha, force: false } });
    }
    return {
      sha,
      tree: treeSha,
      branch: input.branch,
      parents: map.list(made.parents, "parents").map((p) => map.sha(map.obj(p, "parent"))),
    };
  };

  return {
    async listBranches(repo, page) {
      need(ctx, "read");
      const path = `${R(repo)}/branches`;
      const p = restPage(page);
      const res = await http.send({ path, query: { per_page: p.perPage, page: p.page }, scope: scope(repo, "read"), view: links.repo(repo) });
      return paged(await readJson(res), map.branch, nextPage(res, p.page));
    },

    async getBranch(repo, name) {
      need(ctx, "read");
      const path = `${R(repo)}/branches/${escapePath(checkRefName(name, "branch"))}`;
      return map.branch(await http.json({ path, scope: scope(repo, "read"), view: links.tree(repo, name) }));
    },

    async createBranch(repo, name, from) {
      need(ctx, "write");
      const path = `${R(repo)}/git/refs`;
      checkRefName(name, "branch");
      checkObjectId(from);
      const answer = map.obj(await http.json({ method: "POST", path, json: { ref: `refs/heads/${name}`, sha: from } }), "ref");
      return { name, sha: map.sha(map.obj(answer.object, "object")), protected: false };
    },

    async renameBranch(repo, from, to) {
      need(ctx, "write");
      const path = `${R(repo)}/branches/${escapePath(checkRefName(from, "branch"))}/rename`;
      checkRefName(to, "branch");
      return map.branch(await http.json({ method: "POST", path, json: { new_name: to } }));
    },

    async deleteBranch(repo, name) {
      need(ctx, "write");
      const base = R(repo);
      checkRefName(name, "branch");
      const info = map.repo(await http.json({ path: base, scope: scope(repo, "read") }));
      if (info.defaultBranch === name) throw invalid("the default branch cannot be deleted");
      await http.send({ method: "DELETE", path: `${base}/git/refs/heads/${escapePath(name)}` });
    },

    async listTags(repo, page) {
      need(ctx, "read");
      const path = `${R(repo)}/tags`;
      const p = restPage(page);
      const res = await http.send({ path, query: { per_page: p.perPage, page: p.page }, scope: scope(repo, "read"), view: links.repo(repo) });
      return paged(await readJson(res), map.tag, nextPage(res, p.page));
    },

    async createTag(repo, input) {
      need(ctx, "write");
      const base = R(repo);
      checkRefName(input?.name, "tag");
      checkObjectId(input.sha);
      if (input.message === undefined) {
        await http.send({ method: "POST", path: `${base}/git/refs`, json: { ref: `refs/tags/${input.name}`, sha: input.sha } });
        return { name: input.name, sha: input.sha, annotation: null };
      }
      checkMessage(input.message);
      const tag = map.obj(
        await http.json({ method: "POST", path: `${base}/git/tags`, json: { tag: input.name, message: input.message, object: input.sha, type: "commit" } }),
        "tag",
      );
      const tagSha = map.sha(tag);
      await http.send({ method: "POST", path: `${base}/git/refs`, json: { ref: `refs/tags/${input.name}`, sha: tagSha } });
      const tagger = tag.tagger ? map.obj(tag.tagger, "tagger") : null;
      return {
        name: input.name,
        sha: input.sha,
        annotation: { sha: tagSha, message: map.optStr(tag, "message") ?? input.message, tagger: tagger ? { name: map.optStr(tagger, "name") ?? "", login: null, id: null } : null },
      };
    },

    async deleteTag(repo, name) {
      need(ctx, "write");
      const path = `${R(repo)}/git/refs/tags/${escapePath(checkRefName(name, "tag"))}`;
      await http.send({ method: "DELETE", path });
    },

    resolve,

    async tree(repo, rev, options = {}) {
      need(ctx, "read");
      checkRepo(repo);
      checkRev(rev);
      const path = options.path === undefined ? "" : checkPath(options.path, true);
      const recursive = options.recursive === true;
      const view = links.tree(repo, rev, path || undefined);
      if (!path) return readTree(repo, rev, recursive, "", view);
      const cut = path.lastIndexOf("/");
      const parent = cut < 0 ? "" : path.slice(0, cut);
      const name = path.slice(cut + 1);
      const listing = await http.json({
        path: `${R(repo)}/contents${parent ? `/${escapePath(parent)}` : ""}`,
        query: { ref: rev },
        scope: scope(repo, "read"),
        view,
      });
      if (!Array.isArray(listing)) throw invalid("not a directory");
      const entry = listing.map((e) => map.obj(e, "entry")).find((e) => e.name === name);
      if (!entry) throw new GitBackendError("not_found", "no such directory");
      if (entry.type !== "dir") throw invalid("not a directory");
      return readTree(repo, map.sha(entry), recursive, `${path}/`, view);
    },

    async readFile(repo, rev, path, options = {}) {
      need(ctx, "read");
      checkRepo(repo);
      checkRev(rev);
      const p = checkPath(path);
      const max = checkMax(options.maxBytes, DEFAULT_READ_BYTES);
      const view = links.blob(repo, rev, p);
      let res: Response;
      if (ctx.kind === "anonymous") {
        res = await http.send({
          base: "raw",
          path: `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${escapePath(rev)}/${escapePath(p)}`,
          bare: true,
          authorization: null,
          counted: false,
          view,
        });
      } else {
        res = await http.send({ path: `${R(repo)}/contents/${escapePath(p)}`, query: { ref: rev }, accept: MEDIA.raw, scope: scope(repo, "read"), view });
        if ((res.headers.get("Content-Type") ?? "").startsWith("application/json")) {
          const bytes = await readLimited(res, max);
          if (!bytes) throw new GitBackendError("too_large", "the file is larger than asked");
          let listing: unknown = null;
          try {
            listing = JSON.parse(text(bytes));
          } catch {
            listing = null;
          }
          const isListing = Array.isArray(listing) && listing.every((e) => e && typeof e === "object" && "type" in e && "path" in e && "sha" in e && "_links" in e);
          if (isListing) throw invalid("not a file");
          return fileContent(p, bytes);
        }
      }
      const bytes = await readLimited(res, max);
      if (!bytes) throw new GitBackendError("too_large", "the file is larger than asked", { fallbackUrl: view });
      return fileContent(p, bytes);
    },

    rawUrl(repo, commit, path) {
      checkRepo(repo);
      checkObjectId(commit);
      const p = checkPath(path);
      if (!ctx.caps.has("rawUrls")) return null;
      return `${endpoints.raw}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${commit}/${escapePath(p)}`;
    },

    async commits(repo, filter = {}, page) {
      need(ctx, "read");
      const path = `${R(repo)}/commits`;
      if (filter.rev !== undefined) checkRev(filter.rev);
      const file = filter.path === undefined ? undefined : checkPath(filter.path);
      for (const t of [filter.since, filter.until]) if (t !== undefined && Number.isNaN(Date.parse(t))) throw invalid("not a time");
      if (filter.authorLogin !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(filter.authorLogin)) throw invalid("not a login");
      const p = restPage(page);
      const res = await http.send({
        path,
        query: { sha: filter.rev, path: file, since: filter.since, until: filter.until, author: filter.authorLogin, per_page: p.perPage, page: p.page },
        scope: scope(repo, "read"),
        view: links.repo(repo),
        ok: [409],
      });
      if (res.status === 409) {
        const said = await readSome(res, 4096);
        if (/empty/i.test(said)) return { items: [], next: null };
        throw new GitBackendError("conflict", `the state moved (GET ${path})`, { forgeStatus: 409 });
      }
      return paged(await readJson(res), map.commit, nextPage(res, p.page));
    },

    async commit(repo, sha, filesPage) {
      need(ctx, "read");
      const path = `${R(repo)}/commits/${escapePath(checkRev(sha))}`;
      const p = restPage(filesPage);
      const res = await http.send({ path, query: { per_page: p.perPage, page: p.page }, scope: scope(repo, "read"), view: links.commit(repo, sha) });
      return map.commitDetail(await readJson(res), nextPage(res, p.page));
    },

    async compare(repo, base, head, filesPage) {
      need(ctx, "read");
      const path = `${R(repo)}/compare/${escapePath(checkRev(base))}...${escapePath(checkRev(head))}`;
      const p = restPage(filesPage);
      const answer = map.comparison(await http.json({ path, scope: scope(repo, "read"), view: links.compare(repo, base, head) }), null);
      const all = answer.files.items;
      const from = (p.page - 1) * p.perPage;
      return {
        ...answer,
        commits: answer.commits.slice(0, limits.compareCommits),
        files: { items: all.slice(from, from + p.perPage), next: from + p.perPage < all.length ? String(p.page + 1) : null },
      };
    },

    async diff(repo, base, head, options = {}) {
      need(ctx, "read");
      const path = `${R(repo)}/compare/${escapePath(checkRev(base))}...${escapePath(checkRev(head))}`;
      const max = checkMax(options.maxBytes, DEFAULT_DIFF_BYTES);
      const view = links.compare(repo, base, head);
      const res = await http.send({ path, accept: MEDIA.diff, scope: scope(repo, "read"), view });
      const bytes = await readLimited(res, max);
      if (!bytes) throw new GitBackendError("too_large", "the diff is larger than asked", { fallbackUrl: view });
      return text(bytes);
    },

    async blame(repo, rev, path) {
      checkRepo(repo);
      checkRev(rev);
      const p = checkPath(path);
      need(ctx, "read", "blame", links.blame(repo, rev, p));
      const data = await http.graphql(BLAME, { owner: repo.owner, name: repo.name, rev, path: p }, { mutation: false, scope: scope(repo, "read"), view: links.blame(repo, rev, p) });
      const repository = dig(data, "repository");
      const object = dig(repository, "object");
      const ranges = dig(object, "blame", "ranges");
      if (!repository || !object || ranges === undefined) throw new GitBackendError("not_found", "no such file at this revision");
      return map.list(ranges, "ranges").map((r) => {
        const range = map.obj(r, "range");
        return { startLine: map.num(range, "startingLine"), endLine: map.num(range, "endingLine"), commit: map.graphCommit(range.commit) };
      });
    },

    async search(repo, query, page) {
      checkRepo(repo);
      const q = checkQuery(query);
      need(ctx, "read", "searchCode", links.search(repo, q));
      const p = restPage(page);
      const res = await http.send({
        path: "/search/code",
        query: { q: `${q} repo:${repo.owner}/${repo.name}`, per_page: p.perPage, page: p.page },
        accept: MEDIA.textMatch,
        scope: scope(repo, "read"),
        view: links.search(repo, q),
      });
      const answer = map.obj(await readJson(res), "search");
      return paged(
        answer.items,
        (v) => {
          const hit = map.obj(v, "hit");
          const matches = hit.text_matches === undefined ? [] : map.list(hit.text_matches, "text_matches");
          return {
            path: map.str(hit, "path"),
            sha: map.sha(hit),
            fragments: matches.slice(0, 3).map((m) => map.optStr(map.obj(m, "match"), "fragment") ?? ""),
          };
        },
        nextPage(res, p.page),
      );
    },

    async createCommit(repo, raw) {
      need(ctx, "write");
      checkRepo(repo);
      const input = checkCommitInput(raw);
      if (input.parents?.length === 2) need(ctx, "write", "multiParentCommits");
      if (input.parents?.length === 0) need(ctx, "write", "orphanCommits");
      if (!input.changes.length && !input.allowEmpty) throw invalid("a commit that changes nothing");
      for (const c of input.changes) {
        if (c.op === "put" && c.content.length > limits.blobApiBytes) throw new GitBackendError("too_large", "a file is larger than the forge's API takes");
      }
      const expected = input.expectedHead ?? input.createFrom;
      const ordinary =
        (input.parents === undefined || (input.parents.length === 1 && input.parents[0] === expected)) &&
        input.changes.every((c) => c.op !== "move" && !(c.op === "put" && c.executable));
      return ordinary ? commitOnBranch(repo, input) : commitWithData(repo, input);
    },

    async merge(repo, input) {
      need(ctx, "write");
      const base = R(repo);
      checkRefName(input?.base, "branch");
      checkRev(input.head);
      if (input.message !== undefined) checkMessage(input.message);
      if (input.expectedBaseHead !== undefined) {
        checkObjectId(input.expectedBaseHead);
        const now = map.branch(await http.json({ path: `${base}/branches/${escapePath(input.base)}`, scope: scope(repo, "read") }));
        if (now.sha !== input.expectedBaseHead) throw new GitBackendError("conflict", "the branch moved");
      }
      const res = await http.send({ method: "POST", path: `${base}/merges`, json: { base: input.base, head: input.head, commit_message: input.message } });
      if (res.status === 204) return { status: "up_to_date" };
      return { status: "merged", sha: map.sha(map.obj(await readJson(res), "merge")) };
    },
  };
}
