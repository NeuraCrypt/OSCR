// The mirror mode (D00-2): linking an existing public repository the person administers or
// maintains, and adding or removing its paper links, as authorized actions (E1). 20 links per
// account a day (gate.ts, CAP_OF).
//
//   link    target: the repository by path (owner/name, as the page names it);
//           payload {repository: "owner/name" (the sentence's, equal to the target), papers?: DOI[]}
//           → mode `installed` when one of the person's installations of the App covers it
//           (webhooks, write-back), `public` otherwise (read only, the Mac reads it every night).
//           A private repository is refused, and its name is stored nowhere (D00-14). Rows: repos 2,
//           1 per paper, the installation 1 when new, the job `link` 1, the action 1 (5 with one
//           paper and a known installation).
//   papers  target: a repository the registry knows; payload {repository, add?: DOI[], remove?: DOI[]}
//           → 1 row per paper, the action 1. No write on GitHub: the authorization proves the
//           person's permission on it (admin or maintain), asked of GitHub as the person.
//
// Every refusal is thrown as a ForgeProblem from `perform` (act.ts answers it in words, records
// nothing, and revokes the token). The papers' statuses come from the person's roles (papers.ts).

import { GitBackendError } from "../errors.ts";
import { SEGMENT } from "../paths.ts";
import type { Installation, Permission, RepoInfo, RepoRef } from "../types.ts";
import { communityRepoKey, paperStatuses, readPapers } from "./papers.ts";
import { all, first, installationById, insertJob, insertRepo, linkPapers, repoByKey, unlinkPaper, updateRepo, upsertInstallation } from "./store.ts";
import {
  ForgeProblem,
  isProblem,
  type ActionContext,
  type ActionSpec,
  type ActionTarget,
  type AnyActionSpec,
  type InstallationRow,
  type PaperStatus,
  type RepoRow,
  type Write,
} from "./types.ts";

/** Installations read, and pages of an installation's repositories, before giving up (100 each). */
export const INSTALLATION_PAGES = 5;
/** The other repositories of the installation offered to link next. */
export const OTHERS_MAX = 20;

const MAY_LINK: readonly Permission[] = ["admin", "maintain"];

export interface LinkPayload {
  repository: string;
  papers: string[];
}

export interface PapersPayload {
  repository: string;
  add: string[];
  remove: string[];
}

export interface Linked {
  id: string;
  owner: string;
  name: string;
  mode: "installed" | "public";
  installation: string | null;
  /** The repository's page on the site. */
  page: string;
  papers: { doi: string; status: PaperStatus }[];
  /** Other public repositories of the same installation the person may link next (owner/name). */
  others: { owner: string; name: string }[];
}

export interface PapersChanged {
  id: string;
  added: { doi: string; status: PaperStatus }[];
  removed: string[];
  page: string;
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** "owner/name", or null. */
function repository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
  return m && SEGMENT.test(m[1]) && SEGMENT.test(m[2]) && !/\.git$/i.test(m[2]) ? `${m[1]}/${m[2]}` : null;
}

export function validateLink(payload: unknown): LinkPayload | ForgeProblem {
  if (!isObject(payload)) return bad("The repository to link is not named.");
  const repo = repository(payload.repository);
  if (!repo) return bad("The repository is not named as owner/name.");
  const papers = readPapers(payload.papers);
  if (isProblem(papers)) return papers;
  return { repository: repo, papers };
}

export function validatePapers(payload: unknown): PapersPayload | ForgeProblem {
  if (!isObject(payload)) return bad("The papers to add or remove are not named.");
  const repo = repository(payload.repository);
  if (!repo) return bad("The repository is not named as owner/name.");
  const add = readPapers(payload.add, "papers to add");
  if (isProblem(add)) return add;
  const remove = readPapers(payload.remove, "papers to remove");
  if (isProblem(remove)) return remove;
  if (!add.length && !remove.length) return bad("No paper to add or remove.");
  if (add.some((p) => remove.includes(p))) return bad("A paper cannot be added and removed at once.");
  return { repository: repo, add, remove };
}

const papersPhrase = (n: number) => (n === 0 ? "" : `, attached to ${n === 1 ? "one paper" : `${n} papers`}`);

export const describeLink = (p: LinkPayload): string => `Link your public repository ${p.repository} to the registry${papersPhrase(p.papers.length)}`;

export function describePapers(p: PapersPayload): string {
  const parts: string[] = [];
  if (p.add.length) parts.push(`attach ${p.add.length === 1 ? "one paper" : `${p.add.length} papers`} to`);
  if (p.remove.length) parts.push(`detach ${p.remove.length === 1 ? "one paper" : `${p.remove.length} papers`} from`);
  const said = parts.join(" and ");
  return `${said.charAt(0).toUpperCase()}${said.slice(1)} ${p.repository}`;
}

/** The target of link: a repository by its path, and nothing else. */
function byPath(target: ActionTarget): ForgeProblem | null {
  if (!target.repo || !("owner" in target.repo) || target.branch !== null || target.expectedHead !== null) {
    return new ForgeProblem(400, "bad_request", "Linking names the repository by its owner and name.");
  }
  return null;
}

function known(target: ActionTarget): ForgeProblem | null {
  if (!target.repo || target.branch !== null || target.expectedHead !== null) return new ForgeProblem(400, "bad_request", "This action works on a repository the registry knows.");
  return null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const pageOf = (owner: string, name: string) => `/r/${owner.toLowerCase()}/${name.toLowerCase()}/`;

/** GitHub's answer for the repository, as the person: public, and theirs to administer or
 *  maintain. A private repository is refused without its name in the answer. */
async function mayLink(ctx: ActionContext<unknown>, ref: RepoRef): Promise<RepoInfo> {
  let info: RepoInfo;
  try {
    info = await ctx.session.repos.get(ref);
  } catch (err) {
    if (err instanceof GitBackendError && err.code === "not_found") {
      throw new ForgeProblem(404, "not_found", "GitHub shows no public repository at this address to your account.");
    }
    throw err;
  }
  if (info.visibility !== "public") {
    throw new ForgeProblem(403, "not_public", "This repository is not public: the registry links public repositories only, and keeps nothing of this one.");
  }
  const permission = await ctx.session.repos.permission(info.ref, ctx.github.login);
  if (!MAY_LINK.includes(permission)) {
    throw new ForgeProblem(
      403,
      "not_maintainer",
      "Your GitHub account may not administer or maintain this repository: its administrators can link it, or give you the maintain role on GitHub.",
    );
  }
  return info;
}

/** The person's installation of the App that covers this repository, if any, and the other public
 *  repositories of that installation they may link. */
async function coveringInstallation(
  ctx: ActionContext<unknown>,
  info: RepoInfo,
): Promise<{ installation: Installation; others: { id: string; ref: RepoRef }[] } | null> {
  let cursor: string | null = null;
  for (let i = 0; i < INSTALLATION_PAGES; i++) {
    const page = await ctx.installations.list({ cursor, perPage: 100 });
    for (const inst of page.items) {
      if (inst.suspended || (inst.account.id !== info.owner.id && !same(inst.account.login, info.ref.owner))) continue;
      let repos: { ref: RepoRef; key: { id: string }; visibility: string; permission: Permission }[] = [];
      let covered = inst.selection === "all";
      let next: string | null = null;
      for (let j = 0; j < INSTALLATION_PAGES; j++) {
        const list = await ctx.installations.repositories(inst.id, { cursor: next, perPage: 100 });
        repos = repos.concat(list.items);
        if (list.items.some((r) => r.key.id === info.key.id)) covered = true;
        next = list.next;
        if (!next || (covered && repos.length >= OTHERS_MAX + 1)) break;
      }
      if (covered) {
        const others = repos
          .filter((r) => r.key.id !== info.key.id && r.visibility === "public" && MAY_LINK.includes(r.permission))
          .map((r) => ({ id: r.key.id, ref: r.ref }));
        return { installation: inst, others };
      }
    }
    cursor = page.next;
    if (!cursor) break;
  }
  return null;
}

export const linkSpec: ActionSpec<LinkPayload, Linked> = {
  kind: "link",
  needsRepo: false,
  checkTarget: byPath,
  validate: validateLink,
  describe: describeLink,
  async perform(ctx) {
    const target = ctx.target.repo as { forge: string; owner: string; name: string };
    if (!same(ctx.parsed.repository, `${target.owner}/${target.name}`)) {
      throw new ForgeProblem(400, "bad_payload", "The repository confirmed is not the one the page named.");
    }
    const c = ctx as ActionContext<unknown>;
    const forge = ctx.backend.forge;
    const info = await mayLink(c, { forge, owner: target.owner, name: target.name });
    const repoId = info.key.id;
    const existing = await first<RepoRow>(repoByKey(ctx.db, forge, repoId));
    if (existing && (existing.state === "active" || existing.state === "archived" || existing.state === "pending_deletion")) {
      throw new ForgeProblem(409, "already_linked", "This repository is already linked to the registry: change its papers from its page.");
    }
    const found = await coveringInstallation(c, info);
    const mode = found ? "installed" : "public";
    const installationId = found?.installation.id ?? null;
    const writes: Write[] = [];
    if (existing) {
      // Linked again after it was hidden, deleted or gone: the same row, up to date.
      writes.push(
        updateRepo(
          ctx.db,
          forge,
          repoId,
          {
            ownerId: info.owner.id,
            ownerLogin: info.ref.owner,
            name: info.ref.name,
            mode,
            installationId,
            defaultBranch: info.defaultBranch,
            template: info.isTemplate,
            state: info.archived ? "archived" : "active",
            deleteAfter: null,
          },
          ctx.t,
        ),
      );
    } else {
      writes.push(
        insertRepo(
          ctx.db,
          {
            forge,
            repoId,
            ownerId: info.owner.id,
            ownerLogin: info.ref.owner,
            name: info.ref.name,
            mode,
            installationId,
            defaultBranch: info.defaultBranch,
            template: info.isTemplate,
            linkedBy: ctx.user.id,
          },
          ctx.t,
        ),
      );
      if (info.archived) writes.push(updateRepo(ctx.db, forge, repoId, { state: "archived" }, ctx.t));
    }
    if (found) {
      const inst = found.installation;
      const had = await first<InstallationRow>(installationById(ctx.db, forge, inst.id));
      if (!had) {
        writes.push(
          upsertInstallation(
            ctx.db,
            {
              forge,
              id: inst.id,
              accountId: inst.account.id,
              accountLogin: inst.account.login,
              accountType: inst.account.type,
              selection: inst.selection,
              suspended: inst.suspended,
            },
            ctx.t,
          ),
        );
      }
    }
    const statuses = await paperStatuses(ctx.community, ctx.user.id, ctx.parsed.papers, communityRepoKey(forge, info.ref.owner, info.ref.name));
    writes.push(...linkPapers(ctx.db, forge, repoId, statuses, ctx.user.id, ctx.t));
    writes.push(insertJob(ctx.db, { kind: "link", forge, repoId, userId: ctx.user.id }, ctx.t));
    // The others the page may offer next: the installation's public repositories not linked yet.
    let others: { owner: string; name: string }[] = [];
    if (found?.others.length) {
      const candidates = found.others.slice(0, 100);
      const linked = new Set(
        (
          await all<{ repo_id: string }>(
            ctx.db.prepare(`SELECT repo_id FROM repos WHERE forge = ? AND repo_id IN (${candidates.map(() => "?").join(", ")})`).bind(forge, ...candidates.map((r) => r.id)),
          )
        ).map((r) => r.repo_id),
      );
      others = candidates
        .filter((r) => !linked.has(r.id))
        .slice(0, OTHERS_MAX)
        .map((r) => ({ owner: r.ref.owner, name: r.ref.name }));
    }
    return {
      result: {
        id: repoId,
        owner: info.ref.owner,
        name: info.ref.name,
        mode,
        installation: installationId,
        page: pageOf(info.ref.owner, info.ref.name),
        papers: statuses.map((s) => ({ doi: s.paperId.slice(4), status: s.status })),
        others,
      },
      writes,
      repo: { forge, repoId },
    };
  },
  check(result, p, ctx) {
    const target = ctx.target.repo as { owner: string; name: string };
    return same(`${result.owner}/${result.name}`, p.repository) || same(`${target.owner}/${target.name}`, p.repository);
  },
};

export const papersSpec: ActionSpec<PapersPayload, PapersChanged> = {
  kind: "papers",
  needsRepo: true,
  checkTarget: known,
  validate: validatePapers,
  describe: describePapers,
  async perform(ctx) {
    const row = ctx.repo as RepoRow;
    if (!same(ctx.parsed.repository, `${row.owner_login}/${row.name}`)) {
      throw new ForgeProblem(400, "bad_payload", "The repository confirmed is not the one the page named.");
    }
    const forge = row.forge;
    // By its id: GitHub follows renames and transfers; then the person's permission on it.
    const info = await ctx.session.repos.getById({ forge, id: row.repo_id });
    const permission = await ctx.session.repos.permission(info.ref, ctx.github.login);
    if (!MAY_LINK.includes(permission)) {
      throw new ForgeProblem(403, "not_maintainer", "Your GitHub account may not administer or maintain this repository: its administrators can change its papers.");
    }
    const statuses = await paperStatuses(ctx.community, ctx.user.id, ctx.parsed.add, communityRepoKey(forge, info.ref.owner, info.ref.name));
    const writes: Write[] = [
      ...linkPapers(ctx.db, forge, row.repo_id, statuses, ctx.user.id, ctx.t),
      ...ctx.parsed.remove.map((p) => unlinkPaper(ctx.db, forge, row.repo_id, p)),
    ];
    return {
      result: {
        id: info.key.id,
        added: statuses.map((s) => ({ doi: s.paperId.slice(4), status: s.status })),
        removed: ctx.parsed.remove.map((p) => p.slice(4)),
        page: pageOf(row.owner_login, row.name),
      },
      writes,
      repo: { forge, repoId: row.repo_id },
    };
  },
  check(result, _p, ctx) {
    return result.id === ctx.repo?.repo_id;
  },
};

export const LINK_ACTIONS: readonly AnyActionSpec[] = [linkSpec, papersSpec];
