// The test double's repositories (memory.ts): create, generate from a template, fork, update,
// rename, archive, transfer, delete, and what a repository's home shows.

import { GitBackendError, invalid } from "../../worker/forge/errors.ts";
import type { RepoOps } from "../../worker/forge/gitbackend.ts";
import type * as T from "../../worker/forge/types.ts";
import { fileContent } from "../../worker/forge/objects.ts";
import { checkAutolink, checkId, checkLogin, checkOwner, checkPath, checkRefName, checkRepo, checkRepoName, checkRev } from "../../worker/forge/paths.ts";
import type { Flat } from "./gitobjects.ts";
import type { Account, Call, MemRepo } from "./memory.ts";
import {
  bytesOf, gitignoreText, info, languagesOf, licenseOf, licenseText, makeCommit, newRepo, notFound, resolveRev, setBranch, taken,
} from "./memory-core.ts";

const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;

function text(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > max || /[\u0000-\u001f]/.test(v)) throw invalid(`not a ${what}`);
  return v;
}

export function repoOps(c: Call): RepoOps {
  const b = c.b;

  const files = async (list: Record<string, string>): Promise<Flat> => {
    const flat: Flat = new Map();
    for (const [path, content] of Object.entries(list)) flat.set(path, { mode: "100644", sha: await b.store.putBlob(bytesOf(content)) });
    return flat;
  };

  const repositoryEvent = (r: MemRepo, action: "created" | "deleted" | "archived" | "unarchived" | "renamed" | "transferred" | "edited", previous: { owner: string | null; name: string | null } | null = null) =>
    b.record({ kind: "repository", delivery: "", installation: b.installationFor(r), action, repo: b.stub(r), previous, sender: c.actor() });

  /** An account the session may create repositories in: its own, or an organization it belongs to. */
  const creatableIn = (login: string): Account => {
    const me = c.me();
    const owner = b.accountByLogin(login);
    if (!owner) throw invalid("no such account");
    if (owner.id !== me.id && !(owner.type === "organization" && owner.members.has(me.id))) throw new GitBackendError("forbidden", "not an account of this person");
    return owner;
  };

  return {
    async get(ref) {
      checkRepo(ref);
      c.enter("repos.get", { act: "read", view: b.links.repo(ref) });
      return info(c, c.repo(ref, "read"));
    },

    async getById(key) {
      if (!key || key.forge !== "memory" || typeof key.id !== "string" || !/^\d{1,20}$/.test(key.id)) throw invalid("not a repository id of this forge");
      c.enter("repos.getById", { act: "read" });
      const r = b.repos.get(key.id);
      if (!r || r.deleted || c.permission(r) === "none") throw notFound("no such repository");
      return info(c, r);
    },

    async create(input) {
      checkRepoName(input?.name);
      if (input.visibility !== "public") throw invalid("only public repositories for now");
      const description = text(input.description, "description", 350) ?? "";
      const homepage = text(input.homepage, "homepage", 255) ?? "";
      text(input.gitignoreTemplate, "gitignore template", 100);
      text(input.licenseTemplate, "license template", 100);
      c.enter("repos.create", { act: "write", need: "createRepository" });
      const me = c.me();
      if (taken(b, me.login, input.name)) throw new GitBackendError("conflict", "name already exists on this account");
      const r = newRepo(b, me.id, input.name, {
        description,
        homepage,
        isTemplate: input.isTemplate === true,
        features: { issues: true, wiki: true, autoMerge: false, deleteBranchOnMerge: false, ...input.features },
      });
      repositoryEvent(r, "created");
      if (input.autoInit) {
        const list: Record<string, string> = { "README.md": `# ${input.name}\n${description ? `\n${description}\n` : ""}` };
        if (input.licenseTemplate) list.LICENSE = licenseText(input.licenseTemplate, me.login);
        if (input.gitignoreTemplate) list[".gitignore"] = gitignoreText(input.gitignoreTemplate);
        const { sha } = await makeCommit(c, { flat: await files(list), parents: [], message: "Initial commit" });
        setBranch(c, r, "main", sha);
      }
      return info(c, r);
    },

    async generate(template, input) {
      checkRepo(template);
      checkOwner(input?.owner);
      checkRepoName(input.name);
      if (input.visibility !== "public") throw invalid("only public repositories for now");
      const description = text(input.description, "description", 350) ?? "";
      c.enter("repos.generate", { act: "write", need: "createRepository" });
      const t = c.repo(template, "read");
      if (!t.isTemplate) throw invalid("not a template repository");
      const owner = creatableIn(input.owner);
      if (taken(b, owner.login, input.name)) throw new GitBackendError("conflict", "name already exists on this account");
      const r = newRepo(b, owner.id, input.name, { templateId: t.id, description, features: { ...t.features } });
      repositoryEvent(r, "created");
      const names = input.includeAllBranches ? [...t.branches.keys()] : t.defaultBranch ? [t.defaultBranch] : [];
      if (t.defaultBranch) {
        names.sort((x, y) => (x === t.defaultBranch ? -1 : y === t.defaultBranch ? 1 : x.localeCompare(y)));
      }
      for (const name of names) {
        const head = t.branches.get(name) as string;
        const { sha } = await makeCommit(c, { flat: b.flat(head), parents: [], message: "Initial commit" });
        setBranch(c, r, name, sha);
      }
      return info(c, r);
    },

    async fork(ref, input = {}) {
      checkRepo(ref);
      if (input.organization !== undefined) checkOwner(input.organization);
      if (input.name !== undefined) checkRepoName(input.name);
      c.enter("repos.fork", { act: "write" });
      const src = c.repo(ref, "read");
      const owner = creatableIn(input.organization ?? c.me().login);
      const name = input.name ?? src.name;
      const existing = b.find({ forge: "memory", owner: owner.login, name });
      if (existing && existing.parentId === src.id) return { repo: info(c, existing), ready: true };
      if (existing) throw new GitBackendError("conflict", "name already exists on this account");
      const r = newRepo(b, owner.id, name, { parentId: src.id, description: src.description, homepage: src.homepage, features: { ...src.features } });
      for (const [branch, sha] of src.branches) if (!input.defaultBranchOnly || branch === src.defaultBranch) r.branches.set(branch, sha);
      if (!input.defaultBranchOnly) for (const [tag, sha] of src.tags) r.tags.set(tag, sha);
      r.defaultBranch = src.defaultBranch;
      r.pushedAt = src.pushedAt;
      repositoryEvent(r, "created");
      return { repo: info(c, r), ready: false };
    },

    async update(ref, patch) {
      checkRepo(ref);
      if (!patch || typeof patch !== "object") throw invalid("no change");
      if (patch.name !== undefined) checkRepoName(patch.name);
      if (patch.defaultBranch !== undefined) checkRefName(patch.defaultBranch, "branch");
      if (patch.archived !== undefined && typeof patch.archived !== "boolean") throw invalid("archived is true or false");
      const description = text(patch.description, "description", 350);
      const homepage = text(patch.homepage, "homepage", 255);
      c.enter("repos.update", { act: "write" });
      const keys = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => k);
      const onlyArchiving = keys.length === 1 && keys[0] === "archived";
      const r = c.repo(ref, "admin", { archivedOk: onlyArchiving });
      if (patch.defaultBranch !== undefined && !r.branches.has(patch.defaultBranch)) throw invalid("no such branch");
      if (patch.name !== undefined && patch.name !== r.name) {
        const owner = b.ownerLogin(r);
        if (patch.name.toLowerCase() !== r.name.toLowerCase() && taken(b, owner, patch.name)) throw new GitBackendError("conflict", "name already exists on this account");
        const old = r.name;
        b.move(r, r.ownerId, patch.name);
        repositoryEvent(r, "renamed", { owner: null, name: old });
      }
      let edited = false;
      if (description !== undefined && description !== r.description) {
        r.description = description;
        edited = true;
      }
      if (homepage !== undefined && homepage !== r.homepage) {
        r.homepage = homepage;
        edited = true;
      }
      if (patch.defaultBranch !== undefined && patch.defaultBranch !== r.defaultBranch) {
        r.defaultBranch = patch.defaultBranch;
        edited = true;
      }
      if (patch.isTemplate !== undefined) r.isTemplate = patch.isTemplate === true;
      if (patch.features) r.features = { ...r.features, ...patch.features };
      if (edited) repositoryEvent(r, "edited");
      if (patch.archived !== undefined && patch.archived !== r.archived) {
        r.archived = patch.archived;
        repositoryEvent(r, r.archived ? "archived" : "unarchived");
      }
      return info(c, r);
    },

    async setTopics(ref, topics) {
      checkRepo(ref);
      if (!Array.isArray(topics) || topics.length > 20 || !topics.every((t) => typeof t === "string" && TOPIC.test(t))) {
        throw invalid("topics are up to 20 lower-case words of letters, digits and hyphens");
      }
      c.enter("repos.setTopics", { act: "write" });
      const r = c.repo(ref, "admin");
      r.topics = [...new Set(topics)];
      return [...r.topics];
    },

    async transfer(ref, input) {
      checkRepo(ref);
      checkOwner(input?.newOwner);
      if (input.newName !== undefined) checkRepoName(input.newName);
      c.enter("repos.transfer", { act: "write", need: "transfer" });
      const r = c.repo(ref, "admin");
      const target = b.accountByLogin(input.newOwner);
      if (!target) throw invalid("no such account");
      if (target.id === r.ownerId) throw invalid("the repository is already there");
      const name = input.newName ?? r.name;
      if (taken(b, target.login, name)) throw new GitBackendError("conflict", "name already exists on the new owner's account");
      const me = c.me();
      if (target.type === "organization" && target.admins.has(me.id)) {
        const previous = { owner: b.ownerLogin(r), name: r.name };
        b.move(r, target.id, name);
        repositoryEvent(r, "transferred", { owner: previous.owner, name: previous.name === name ? null : previous.name });
        return { status: "done", repo: info(c, r) };
      }
      r.pendingTransfer = { ownerId: target.id, name };
      return { status: "pending", repo: info(c, r) };
    },

    async delete(ref) {
      checkRepo(ref);
      c.enter("repos.delete", { act: "write" });
      const r = c.repo(ref, "admin", { archivedOk: true });
      repositoryEvent(r, "deleted");
      r.deleted = true;
      b.paths.delete(`${b.ownerLogin(r)}/${r.name}`.toLowerCase());
      for (const [path, id] of b.redirects) if (id === r.id) b.redirects.delete(path);
    },

    async permission(ref, login) {
      checkRepo(ref);
      checkLogin(login);
      if (c.kind === "anonymous") throw new GitBackendError("unauthorized", "a person's permission is read in a signed-in session");
      c.enter("repos.permission", { act: "read" });
      const r = c.repo(ref, "read");
      const who = b.accountByLogin(login);
      if (!who || who.type !== "user") throw notFound("no such person");
      return b.permissionOf(r, who.id);
    },

    async languages(ref) {
      checkRepo(ref);
      c.enter("repos.languages", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      return languagesOf(b, r.defaultBranch ? r.branches.get(r.defaultBranch) : undefined);
    },

    async license(ref) {
      checkRepo(ref);
      c.enter("repos.license", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      return licenseOf(b, r.defaultBranch ? r.branches.get(r.defaultBranch) : undefined);
    },

    async readme(ref, rev, dir) {
      checkRepo(ref);
      if (rev !== undefined) checkRev(rev);
      const d = dir === undefined || dir === "" ? "" : checkPath(dir);
      c.enter("repos.readme", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      if (rev === undefined && !r.defaultBranch) return null;
      const commit = resolveRev(b, r, rev ?? (r.defaultBranch as string));
      const tree = (b.store.commit(commit) as { tree: string }).tree;
      const at = b.store.at(tree, d);
      if (!at || at.mode !== "040000") return null;
      const found = (b.store.tree(at.sha)?.entries ?? [])
        .filter((e) => e.mode !== "040000" && e.mode !== "160000" && /^readme(?:\.[A-Za-z0-9]+)?$/i.test(e.name))
        .sort((x, y) => (x.name === "README.md" ? -1 : y.name === "README.md" ? 1 : x.name.localeCompare(y.name)))[0];
      if (!found) return null;
      const bytes = b.store.blob(found.sha)?.bytes ?? new Uint8Array();
      return fileContent(d ? `${d}/${found.name}` : found.name, bytes, found.sha);
    },

    async importRepository() {
      c.enter("repos.importRepository", { act: "write", need: "serverImport", fallback: b.links.importer() });
      throw new GitBackendError("unsupported", "this forge has no import", { fallbackUrl: b.links.importer() });
    },

    // Custom autolinks, with GitHub's rules: the admin's; a prefix unique in the repository
    // (letter case aside); "<num>" in an http(s) template, checked before anything else.
    async autolinks(ref) {
      checkRepo(ref);
      c.enter("repos.autolinks", { act: "read" });
      const r = c.repo(ref, "admin");
      return [...r.autolinks.values()].map((a) => ({ ...a }));
    },

    async createAutolink(ref, input) {
      checkRepo(ref);
      const a = checkAutolink(input);
      c.enter("repos.createAutolink", { act: "write" });
      const r = c.repo(ref, "admin");
      if ([...r.autolinks.values()].some((x) => x.keyPrefix.toLowerCase() === a.keyPrefix.toLowerCase())) {
        throw new GitBackendError("conflict", "an autolink with this prefix already exists");
      }
      const made: T.Autolink = { id: b.nextId(), ...a };
      r.autolinks.set(made.id, made);
      return { ...made };
    },

    async deleteAutolink(ref, id) {
      checkRepo(ref);
      checkId(id, "autolink id");
      c.enter("repos.deleteAutolink", { act: "write" });
      const r = c.repo(ref, "admin");
      if (!r.autolinks.delete(id)) throw notFound("no such autolink");
    },
  };
}
