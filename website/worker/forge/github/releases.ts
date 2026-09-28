// Releases on GitHub (phase 07): https://docs.github.com/en/rest/releases.
//
//   list / get / byTag / latest   GET …/releases, …/releases/{id}, …/releases/tags/{tag},
//                                 …/releases/latest (404 → null)
//   create / update / delete      POST …/releases; PATCH / DELETE …/releases/{id} (the tag stays)
//   generateNotes                 POST …/releases/generate-notes (creates nothing: not a write)
//   assets / deleteAsset          GET …/releases/{id}/assets; DELETE …/releases/assets/{id}
//   uploadAsset                   POST {uploads}/repos/{o}/{r}/releases/{id}/assets?name=&label=,
//                                 the raw bytes with Content-Type and Content-Length. A stream is
//                                 passed through (duplex "half"), never buffered; in workerd the
//                                 caller gives a FixedLengthStream's readable, so the length is
//                                 sent. 422 "already_exists" → conflict. OSCR never downloads
//                                 assets itself: `downloadUrl` is a link.

import { GitBackendError, invalid } from "../errors.ts";
import type { ReleaseOps } from "../gitbackend.ts";
import { checkBody, checkId, checkRefName, checkRev, checkTitle } from "../paths.ts";
import type * as T from "../types.ts";
import { type Ctx, need, paged, R, scope } from "./ctx.ts";
import { nextPage, readJson, restPage } from "./http.ts";
import { escapePath } from "./links.ts";
import * as map from "./map.ts";

function checkAssetName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\u0000-\u001f/\\]/.test(name)) throw invalid("not an asset name");
  return name;
}

function checkContentType(t: unknown): string {
  if (typeof t !== "string" || !/^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(t)) throw invalid("not a content type");
  return t;
}

function releaseBody(p: T.ReleasePatch & { generateNotes?: boolean }): Record<string, unknown> {
  if (p.tagName !== undefined) checkRefName(p.tagName, "tag");
  if (p.target !== undefined) checkRev(p.target);
  if (p.name !== undefined && (typeof p.name !== "string" || p.name.length > 256)) throw invalid("not a release name");
  return {
    tag_name: p.tagName,
    target_commitish: p.target,
    name: p.name,
    body: p.body === undefined ? undefined : checkBody(p.body),
    draft: p.draft,
    prerelease: p.prerelease,
    make_latest: p.makeLatest === undefined ? undefined : p.makeLatest ? "true" : "false",
    generate_release_notes: p.generateNotes,
  };
}

export function releaseOps(ctx: Ctx): ReleaseOps {
  const { http, links, limits } = ctx;
  const releasesPage = (repo: T.RepoRef) => `${links.repo(repo)}/releases`;

  const one = async (repo: T.RepoRef, sub: string): Promise<T.Release> => {
    need(ctx, "read");
    return map.release(await http.json({ path: `${R(repo)}/releases/${sub}`, scope: scope(repo, "read"), view: releasesPage(repo) }));
  };

  return {
    async list(repo, page) {
      need(ctx, "read");
      const path = `${R(repo)}/releases`;
      const p = restPage(page);
      const res = await http.send({ path, query: { per_page: p.perPage, page: p.page }, scope: scope(repo, "read"), view: releasesPage(repo) });
      return paged(await readJson(res), map.release, nextPage(res, p.page));
    },

    get: (repo, id) => one(repo, checkId(id, "release id")),
    byTag: (repo, tag) => one(repo, `tags/${escapePath(checkRefName(tag, "tag"))}`),

    async latest(repo) {
      need(ctx, "read");
      const res = await http.send({ path: `${R(repo)}/releases/latest`, scope: scope(repo, "read"), view: releasesPage(repo), ok: [404] });
      return res.status === 404 ? null : map.release(await readJson(res));
    },

    async create(repo, input) {
      need(ctx, "write");
      const path = `${R(repo)}/releases`;
      checkRefName(input?.tagName, "tag");
      return map.release(await http.json({ method: "POST", path, json: releaseBody(input) }));
    },

    async update(repo, id, patch) {
      need(ctx, "write");
      const path = `${R(repo)}/releases/${checkId(id, "release id")}`;
      return map.release(await http.json({ method: "PATCH", path, json: releaseBody(patch ?? {}) }));
    },

    async delete(repo, id) {
      need(ctx, "write");
      await http.send({ method: "DELETE", path: `${R(repo)}/releases/${checkId(id, "release id")}` });
    },

    async generateNotes(repo, input) {
      need(ctx, "write");
      const path = `${R(repo)}/releases/generate-notes`;
      checkRefName(input?.tagName, "tag");
      if (input.target !== undefined) checkRev(input.target);
      if (input.previousTagName !== undefined) checkRefName(input.previousTagName, "tag");
      const answer = map.obj(
        await http.json({
          method: "POST",
          path,
          json: { tag_name: input.tagName, target_commitish: input.target, previous_tag_name: input.previousTagName },
          write: false,
        }),
        "notes",
      );
      return { name: map.str(answer, "name"), body: map.str(answer, "body") };
    },

    async assets(repo, releaseId, page) {
      need(ctx, "read");
      const path = `${R(repo)}/releases/${checkId(releaseId, "release id")}/assets`;
      const p = restPage(page);
      const res = await http.send({ path, query: { per_page: p.perPage, page: p.page }, scope: scope(repo, "read"), view: releasesPage(repo) });
      return paged(await readJson(res), map.asset, nextPage(res, p.page));
    },

    async uploadAsset(repo, releaseId, upload) {
      need(ctx, "write", "releaseAssets", links.newRelease(repo));
      const path = `${R(repo)}/releases/${checkId(releaseId, "release id")}/assets`;
      const name = checkAssetName(upload?.name);
      const label = upload.label === undefined ? undefined : checkTitle(upload.label);
      const contentType = checkContentType(upload.contentType);
      if (!Number.isInteger(upload.size) || upload.size < 1) throw invalid("an asset's size is known in advance");
      if (upload.size > limits.releaseAssetBytes) throw new GitBackendError("too_large", "the asset is larger than the forge takes", { fallbackUrl: links.newRelease(repo) });
      if (upload.body instanceof Uint8Array && upload.body.length !== upload.size) throw invalid("the asset's size is not its length");
      return map.asset(
        await http.json({
          method: "POST",
          base: "uploads",
          path,
          query: { name, label },
          body: upload.body,
          contentType,
          contentLength: upload.size,
        }),
      );
    },

    async deleteAsset(repo, assetId) {
      need(ctx, "write");
      await http.send({ method: "DELETE", path: `${R(repo)}/releases/assets/${checkId(assetId, "asset id")}` });
    },
  };
}
