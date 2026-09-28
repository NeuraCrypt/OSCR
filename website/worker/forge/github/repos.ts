// Repositories on GitHub (phase 01): the REST endpoints of
// https://docs.github.com/en/rest/repos/repos.
//
//   get / getById      GET /repos/{o}/{r}; GET /repositories/{id} (undocumented but stable)
//   create             POST /user/repos (user tokens only: "Administration" and repository creation)
//   generate           POST /repos/{t_owner}/{t_repo}/generate
//   fork               POST /repos/{o}/{r}/forks (202: `ready` false, GitHub copies in the background)
//   update             PATCH /repos/{o}/{r}
//   setTopics          PUT /repos/{o}/{r}/topics {names}
//   transfer           POST /repos/{o}/{r}/transfer {new_owner, new_name} (202). GitHub's answer does
//                      not say whether the new owner must accept: "done" when it already names the
//                      new owner, "pending" otherwise (a user has one day to accept).
//   delete             DELETE /repos/{o}/{r}
//   permission         GET /repos/{o}/{r}/collaborators/{login}/permission (signed-in sessions only:
//                      GitHub answers it to collaborators, so an anonymous call is refused locally)
//   languages, license GET …/languages, …/license (404 → null)
//   readme             GET …/readme/{dir}?ref= (404 → null)
//   importRepository   none since GitHub retired its Source Imports API: `unsupported`, with the
//                      importer page as fallbackUrl; imports run on the researcher's machine (D00-8)
//   autolinks          GET /repos/{o}/{r}/autolinks; POST …/autolinks {key_prefix, url_template,
//                      is_alphanumeric}; DELETE …/autolinks/{id} (admin; GitHub answers a prefix
//                      already there with 422 "already_exists": conflict)

import { GitBackendError, invalid } from "../errors.ts";
import type { RepoOps } from "../gitbackend.ts";
import { fileContent, fromBase64 } from "../objects.ts";
import { checkAutolink, checkId, checkLogin, checkOwner, checkPath, checkRefName, checkRepoName, checkRev } from "../paths.ts";
import type * as T from "../types.ts";
import { type Ctx, need, R, scope } from "./ctx.ts";
import { MEDIA, readJson, readLimited } from "./http.ts";
import { escapePath } from "./links.ts";
import * as map from "./map.ts";

const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;

function text(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > max || /[\u0000-\u001f]/.test(v)) throw invalid(`not a ${what}`);
  return v;
}

function autolink(v: unknown): T.Autolink {
  const a = map.obj(v, "autolink");
  return { id: map.id(a), keyPrefix: map.str(a, "key_prefix"), urlTemplate: map.str(a, "url_template"), isAlphanumeric: map.bool(a, "is_alphanumeric", true) };
}

function features(f: Partial<T.RepoFeatures> | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!f) return out;
  if (f.issues !== undefined) out.has_issues = f.issues === true;
  if (f.wiki !== undefined) out.has_wiki = f.wiki === true;
  if (f.autoMerge !== undefined) out.allow_auto_merge = f.autoMerge === true;
  if (f.deleteBranchOnMerge !== undefined) out.delete_branch_on_merge = f.deleteBranchOnMerge === true;
  return out;
}

export function repoOps(ctx: Ctx): RepoOps {
  const { http, links } = ctx;

  const get = async (repo: T.RepoRef): Promise<T.RepoInfo> => {
    need(ctx, "read");
    return map.repo(await http.json({ path: R(repo), scope: scope(repo, "read"), view: links.repo(repo) }));
  };

  return {
    get,

    async getById(key) {
      need(ctx, "read");
      if (!key || key.forge !== "github" || typeof key.id !== "string" || !/^\d{1,20}$/.test(key.id)) throw invalid("not a GitHub repository id");
      return map.repo(await http.json({ path: `/repositories/${key.id}`, scope: { act: "read" } }));
    },

    async create(input) {
      need(ctx, "write", "createRepository");
      checkRepoName(input?.name);
      if (input.visibility !== "public") throw invalid("only public repositories for now");
      const body = {
        name: input.name,
        description: text(input.description, "description", 350),
        homepage: text(input.homepage, "homepage", 255),
        private: false,
        auto_init: input.autoInit === true,
        gitignore_template: text(input.gitignoreTemplate, "gitignore template", 100),
        license_template: text(input.licenseTemplate, "license template", 100),
        is_template: input.isTemplate === undefined ? undefined : input.isTemplate === true,
        ...features(input.features),
      };
      return map.repo(await http.json({ method: "POST", path: "/user/repos", json: body }));
    },

    async generate(template, input) {
      need(ctx, "write", "createRepository");
      checkOwner(input?.owner);
      checkRepoName(input.name);
      if (input.visibility !== "public") throw invalid("only public repositories for now");
      const body = {
        owner: input.owner,
        name: input.name,
        description: text(input.description, "description", 350),
        include_all_branches: input.includeAllBranches === true,
        private: false,
      };
      return map.repo(await http.json({ method: "POST", path: `${R(template)}/generate`, json: body }));
    },

    async fork(repo, input = {}) {
      need(ctx, "write");
      const path = `${R(repo)}/forks`;
      if (input.organization !== undefined) checkOwner(input.organization);
      if (input.name !== undefined) checkRepoName(input.name);
      const res = await http.send({
        method: "POST",
        path,
        json: { organization: input.organization, name: input.name, default_branch_only: input.defaultBranchOnly === true },
      });
      return { repo: map.repo(await readJson(res)), ready: res.status !== 202 };
    },

    async update(repo, patch) {
      need(ctx, "write");
      const path = R(repo);
      if (!patch || typeof patch !== "object") throw invalid("no change");
      if (patch.name !== undefined) checkRepoName(patch.name);
      if (patch.defaultBranch !== undefined) checkRefName(patch.defaultBranch, "branch");
      if (patch.archived !== undefined && typeof patch.archived !== "boolean") throw invalid("archived is true or false");
      const body = {
        name: patch.name,
        description: text(patch.description, "description", 350),
        homepage: text(patch.homepage, "homepage", 255),
        archived: patch.archived,
        default_branch: patch.defaultBranch,
        is_template: patch.isTemplate === undefined ? undefined : patch.isTemplate === true,
        ...features(patch.features),
      };
      return map.repo(await http.json({ method: "PATCH", path, json: body }));
    },

    async setTopics(repo, topics) {
      need(ctx, "write");
      const path = `${R(repo)}/topics`;
      if (!Array.isArray(topics) || topics.length > 20 || !topics.every((t) => typeof t === "string" && TOPIC.test(t))) {
        throw invalid("topics are up to 20 lower-case words of letters, digits and hyphens");
      }
      const answer = map.obj(await http.json({ method: "PUT", path, json: { names: topics } }), "topics");
      return map.list(answer.names, "names").map((n) => (typeof n === "string" ? n : ""));
    },

    async transfer(repo, input) {
      need(ctx, "write", "transfer");
      const path = `${R(repo)}/transfer`;
      checkOwner(input?.newOwner);
      if (input.newName !== undefined) checkRepoName(input.newName);
      const moved = map.repo(await http.json({ method: "POST", path, json: { new_owner: input.newOwner, new_name: input.newName } }));
      return { status: moved.ref.owner.toLowerCase() === input.newOwner.toLowerCase() ? "done" : "pending", repo: moved };
    },

    async delete(repo) {
      need(ctx, "write");
      await http.send({ method: "DELETE", path: R(repo) });
    },

    async permission(repo, login) {
      need(ctx, "read");
      const path = `${R(repo)}/collaborators/${encodeURIComponent(checkLogin(login))}/permission`;
      if (ctx.kind === "anonymous") throw new GitBackendError("unauthorized", "a person's permission is read in a signed-in session");
      const p = map.obj(await http.json({ path, scope: scope(repo, "read") }), "permission");
      const role = map.optStr(p, "role_name");
      if (role === "maintain" || role === "triage" || role === "admin") return role;
      const level = map.str(p, "permission");
      return level === "admin" || level === "write" || level === "read" ? level : "none";
    },

    async languages(repo) {
      need(ctx, "read");
      const answer = map.obj(await http.json({ path: `${R(repo)}/languages`, scope: scope(repo, "read"), view: links.repo(repo) }), "languages");
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(answer)) if (typeof v === "number") out[k] = v;
      return out;
    },

    async license(repo) {
      need(ctx, "read");
      const res = await http.send({ path: `${R(repo)}/license`, scope: scope(repo, "read"), view: links.repo(repo), ok: [404] });
      if (res.status === 404) return null;
      const answer = map.obj(await readJson(res), "license");
      const license = answer.license ? map.obj(answer.license, "license") : null;
      const spdx = license ? map.optStr(license, "spdx_id") : null;
      return { spdx: spdx && spdx !== "NOASSERTION" ? spdx : null, path: map.str(answer, "path") };
    },

    async readme(repo, rev, dir) {
      need(ctx, "read");
      const base = R(repo);
      if (rev !== undefined) checkRev(rev);
      const d = dir === undefined || dir === "" ? "" : checkPath(dir);
      const res = await http.send({
        path: `${base}/readme${d ? `/${escapePath(d)}` : ""}`,
        query: { ref: rev },
        scope: scope(repo, "read"),
        view: links.repo(repo),
        ok: [404],
      });
      if (res.status === 404) return null;
      const answer = map.obj(await readJson(res), "readme");
      const path = map.str(answer, "path");
      const sha = map.sha(answer);
      const content = map.optStr(answer, "content") ?? "";
      if (answer.encoding === "base64" && (content || map.num(answer, "size") === 0)) return fileContent(path, fromBase64(content), sha);
      // Over 1 MB GitHub leaves `content` empty: read it raw.
      const raw = await http.send({ path: `${base}/contents/${escapePath(path)}`, query: { ref: rev }, accept: MEDIA.raw, scope: scope(repo, "read") });
      const bytes = await readLimited(raw, 10 * 10 ** 6);
      if (!bytes) throw new GitBackendError("too_large", "the README is larger than 10 MB");
      return fileContent(path, bytes, sha);
    },

    async importRepository() {
      need(ctx, "write", "serverImport", links.importer());
      throw new GitBackendError("unsupported", "GitHub has no import API", { fallbackUrl: links.importer() });
    },

    async autolinks(repo) {
      need(ctx, "read");
      const answer = await http.json({ path: `${R(repo)}/autolinks`, scope: scope(repo, "read") });
      return map.list(answer, "autolinks").map(autolink);
    },

    async createAutolink(repo, input) {
      need(ctx, "write");
      const path = `${R(repo)}/autolinks`;
      const a = checkAutolink(input);
      const body = { key_prefix: a.keyPrefix, url_template: a.urlTemplate, is_alphanumeric: a.isAlphanumeric };
      return autolink(await http.json({ method: "POST", path, json: body }));
    },

    async deleteAutolink(repo, id) {
      need(ctx, "write");
      const path = `${R(repo)}/autolinks/${encodeURIComponent(checkId(id, "autolink id"))}`;
      await http.send({ method: "DELETE", path });
    },
  };
}
