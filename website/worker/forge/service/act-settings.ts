// A repository's settings as authorized actions (E1), on a repository the registry knows, as the
// person on GitHub (GitHub itself requires the admin role, or maintain where it allows it: a
// person with write only is refused by GitHub, in words). Budget W3: at most 2 rows plus the
// action row.
//
//   rename          {name}                                 repos 2 (the path moves; the id stays)
//   edit            {description?, homepage?}              the action row only
//   topics          {topics: string[]}                     the action row only
//   features        {issues?, wiki?, autoMerge?, deleteBranchOnMerge?}   the action row only
//   template        {template: boolean}                    repos 1
//   default_branch  {branch}                               repos 1
//   archive         {}                                     repos 1 (state archived)
//   unarchive       {}                                     repos 1 (state active)
//   transfer        {newOwner, newName?}                   pending: 0; done: repos 2
//
// Each action first asks GitHub for the repository by its durable id (GitHub follows renames and
// transfers; the registry keys repositories by id), then acts on the path GitHub gives. `check`
// compares GitHub's answer with what was authorized: the same repository id, and the change asked.

import { isRefName, SEGMENT } from "../paths.ts";
import type { RepoFeatures, RepoInfo, RepoRef } from "../types.ts";
import { DESCRIPTION_CHARS, HOMEPAGE_CHARS, isNewRepoName } from "./act-create.ts";
import { updateRepo } from "./store.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type ActionTarget, type AnyActionSpec, type RepoRow, type Write } from "./types.ts";

/** What a settings action answers: the repository as GitHub now has it. */
export interface Settled {
  id: string;
  owner: string;
  name: string;
  /** Its page on the site. */
  page: string;
  description: string;
  homepage: string;
  topics: string[];
  features: RepoFeatures;
  template: boolean;
  defaultBranch: string | null;
  archived: boolean;
  /** What the page says besides (GitHub's redirects, a transfer's side effects…). */
  notes: string[];
}

export interface Transferred extends Settled {
  status: "pending" | "done";
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The target of every settings action: a repository the registry knows, no branch. */
export function onRepository(target: ActionTarget): ForgeProblem | null {
  if (!target.repo || target.branch !== null || target.expectedHead !== null) {
    return new ForgeProblem(400, "bad_request", "This action works on a repository the registry knows, as a whole.");
  }
  return null;
}

/** A repository the registry follows (active or archived): the states the settings apply to. */
export function followed(row: RepoRow | null, states: RepoRow["state"][] = ["active", "archived"]): RepoRow {
  if (!row || !states.includes(row.state)) {
    throw new ForgeProblem(409, "not_followed", "The registry does not follow this repository any more: nothing was done.");
  }
  return row;
}

/** GitHub's answer for the repository, by its durable id, as the person: the path to act on. */
export async function current(ctx: ActionContext<unknown>, row: RepoRow): Promise<RepoInfo> {
  const info = await ctx.session.repos.getById({ forge: row.forge, id: row.repo_id });
  if (info.key.id !== row.repo_id) throw new ForgeProblem(502, "mismatch", "GitHub answered for another repository: nothing was done.");
  return info;
}

export const pageOf = (ref: RepoRef): string => `/r/${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}/`;

export function settled(info: RepoInfo, notes: string[] = []): Settled {
  return {
    id: info.key.id,
    owner: info.ref.owner,
    name: info.ref.name,
    page: pageOf(info.ref),
    description: info.description,
    homepage: info.homepage,
    topics: [...info.topics],
    features: { ...info.features },
    template: info.isTemplate,
    defaultBranch: info.defaultBranch,
    archived: info.archived,
    notes,
  };
}

const sameRepo = (result: { id: string }, ctx: ActionContext<unknown>) => result.id === ctx.repo?.repo_id;

/** A spec of this file: needsRepo, the target's check, and `check` always comparing the id. */
function spec<P, R extends { id: string }>(s: Omit<ActionSpec<P, R>, "needsRepo" | "checkTarget" | "check"> & { same(result: R, parsed: P): boolean }): ActionSpec<P, R> {
  return {
    ...s,
    needsRepo: true,
    checkTarget: onRepository,
    check: (result, parsed, ctx) => sameRepo(result, ctx as ActionContext<unknown>) && s.same(result, parsed),
  };
}

// ─── rename ──────────────────────────────────────────────────────────────────

export const renameSpec = spec<{ name: string }, Settled>({
  kind: "rename",
  validate(payload) {
    if (!isObject(payload) || !isNewRepoName(payload.name)) {
      return bad("The new name may hold letters, digits, “.”, “-” and “_” only, at most 100, and may not end in .git.");
    }
    return { name: payload.name };
  },
  describe: (p) => `Rename the repository to ${p.name}`,
  async perform(ctx) {
    const row = followed(ctx.repo);
    const info = await current(ctx as ActionContext<unknown>, row);
    const renamed = await ctx.session.repos.update(info.ref, { name: ctx.parsed.name });
    const writes: Write[] = [updateRepo(ctx.db, row.forge, row.repo_id, { ownerLogin: renamed.ref.owner, name: renamed.ref.name }, ctx.t, { differs: true })];
    const notes = [
      `GitHub sends the old address, ${info.ref.owner}/${info.ref.name}, to the new one, for git and for the web, until another repository takes that name.`,
      "Update your clones' remote when you like: git remote set-url origin with the new address.",
    ];
    return { result: settled(renamed, notes), writes, repo: { forge: row.forge, repoId: row.repo_id } };
  },
  same: (r, p) => same(r.name, p.name),
});

// ─── description and homepage ────────────────────────────────────────────────

export const editSpec = spec<{ description?: string; homepage?: string }, Settled>({
  kind: "edit",
  validate(payload) {
    if (!isObject(payload)) return bad("Nothing to change.");
    const out: { description?: string; homepage?: string } = {};
    if (payload.description !== undefined) {
      if (typeof payload.description !== "string" || [...payload.description].length > DESCRIPTION_CHARS || /[\u0000-\u001f\u007f]/.test(payload.description)) {
        return bad(`The description is text of at most ${DESCRIPTION_CHARS} characters.`);
      }
      out.description = payload.description.trim();
    }
    if (payload.homepage !== undefined) {
      const h = typeof payload.homepage === "string" ? payload.homepage.trim() : null;
      if (h === null || h.length > HOMEPAGE_CHARS) return bad("The website is not an address.");
      if (h) {
        try {
          const u = new URL(h);
          if (u.protocol !== "https:" || u.username || u.password) return bad("The website must be an https address.");
        } catch {
          return bad("The website is not an address.");
        }
      }
      out.homepage = h;
    }
    if (out.description === undefined && out.homepage === undefined) return bad("Nothing to change.");
    return out;
  },
  describe: (p) =>
    `Change the repository's ${[p.description !== undefined ? "description" : "", p.homepage !== undefined ? "website" : ""].filter(Boolean).join(" and ")}`,
  async perform(ctx) {
    const row = followed(ctx.repo);
    const info = await current(ctx as ActionContext<unknown>, row);
    const out = await ctx.session.repos.update(info.ref, ctx.parsed);
    return { result: settled(out), writes: [], repo: { forge: row.forge, repoId: row.repo_id } };
  },
  same: (r, p) => (p.description === undefined || r.description === p.description) && (p.homepage === undefined || r.homepage === p.homepage),
});

// ─── topics ──────────────────────────────────────────────────────────────────

const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;

export const topicsSpec = spec<{ topics: string[] }, Settled>({
  kind: "topics",
  validate(payload) {
    if (!isObject(payload) || !Array.isArray(payload.topics)) return bad("The topics are not a list.");
    const topics = [...new Set(payload.topics.map((t) => (typeof t === "string" ? t.trim().toLowerCase() : "")))];
    if (topics.length > 20) return bad("At most 20 topics.");
    if (topics.some((t) => !TOPIC.test(t))) return bad("A topic is a lower-case word of letters, digits and hyphens, at most 50 characters.");
    return { topics };
  },
  describe: (p) => (p.topics.length ? `Set the repository's topics: ${p.topics.join(", ")}` : "Remove the repository's topics"),
  async perform(ctx) {
    const row = followed(ctx.repo);
    const info = await current(ctx as ActionContext<unknown>, row);
    const topics = await ctx.session.repos.setTopics(info.ref, ctx.parsed.topics);
    return { result: { ...settled(info), topics }, writes: [], repo: { forge: row.forge, repoId: row.repo_id } };
  },
  same: (r, p) => r.topics.length === p.topics.length && p.topics.every((t) => r.topics.includes(t)),
});

// ─── features ────────────────────────────────────────────────────────────────

const FEATURES: readonly (keyof RepoFeatures)[] = ["issues", "wiki", "autoMerge", "deleteBranchOnMerge"];
const FEATURE_WORDS: Record<keyof RepoFeatures, string> = {
  issues: "issues",
  wiki: "the wiki",
  autoMerge: "auto-merge",
  deleteBranchOnMerge: "deleting a branch once merged",
};

export const featuresSpec = spec<Partial<RepoFeatures>, Settled>({
  kind: "features",
  validate(payload) {
    if (!isObject(payload)) return bad("No feature to change.");
    const out: Partial<RepoFeatures> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (!(FEATURES as readonly string[]).includes(k)) return bad(`“${k.slice(0, 40)}” is not a feature this page sets.`);
      if (typeof v !== "boolean") return bad(`“${k}” is not true or false.`);
      out[k as keyof RepoFeatures] = v;
    }
    if (!Object.keys(out).length) return bad("No feature to change.");
    return out;
  },
  describe(p) {
    const on = FEATURES.filter((k) => p[k] === true).map((k) => FEATURE_WORDS[k]);
    const off = FEATURES.filter((k) => p[k] === false).map((k) => FEATURE_WORDS[k]);
    return [on.length ? `Turn on ${on.join(", ")}` : "", off.length ? `turn off ${off.join(", ")}` : ""].filter(Boolean).join(", and ").replace(/^t/, "T");
  },
  async perform(ctx) {
    const row = followed(ctx.repo);
    const info = await current(ctx as ActionContext<unknown>, row);
    const out = await ctx.session.repos.update(info.ref, { features: ctx.parsed });
    return { result: settled(out), writes: [], repo: { forge: row.forge, repoId: row.repo_id } };
  },
  same: (r, p) => FEATURES.every((k) => p[k] === undefined || r.features[k] === p[k]),
});

// ─── template flag ───────────────────────────────────────────────────────────

export const templateSpec = spec<{ template: boolean }, Settled>({
  kind: "template",
  validate: (payload) => (isObject(payload) && typeof payload.template === "boolean" ? { template: payload.template } : bad("Say whether it is a template: true or false.")),
  describe: (p) => (p.template ? "Mark the repository as a template" : "Stop offering the repository as a template"),
  async perform(ctx) {
    const row = followed(ctx.repo);
    const info = await current(ctx as ActionContext<unknown>, row);
    const out = await ctx.session.repos.update(info.ref, { isTemplate: ctx.parsed.template });
    return {
      result: settled(out),
      writes: [updateRepo(ctx.db, row.forge, row.repo_id, { template: out.isTemplate }, ctx.t, { differs: true })],
      repo: { forge: row.forge, repoId: row.repo_id },
    };
  },
  same: (r, p) => r.template === p.template,
});

// ─── default branch ──────────────────────────────────────────────────────────

export const defaultBranchSpec = spec<{ branch: string }, Settled>({
  kind: "default_branch",
  validate(payload) {
    if (!isObject(payload) || !isRefName(payload.branch)) return bad("This is not a branch name.");
    return { branch: payload.branch };
  },
  describe: (p) => `Make ${p.branch} the repository's default branch`,
  async perform(ctx) {
    const row = followed(ctx.repo, ["active"]);
    const info = await current(ctx as ActionContext<unknown>, row);
    const out = await ctx.session.repos.update(info.ref, { defaultBranch: ctx.parsed.branch });
    return {
      result: settled(out, ["New clones check this branch out; pull requests keep their base until retargeted."]),
      writes: [updateRepo(ctx.db, row.forge, row.repo_id, { defaultBranch: out.defaultBranch }, ctx.t, { differs: true })],
      repo: { forge: row.forge, repoId: row.repo_id, branch: out.defaultBranch },
    };
  },
  same: (r, p) => r.defaultBranch === p.branch,
});

// ─── archive and unarchive ───────────────────────────────────────────────────

function archiving(kind: "archive" | "unarchive"): ActionSpec<Record<string, never>, Settled> {
  const archived = kind === "archive";
  return spec<Record<string, never>, Settled>({
    kind,
    validate: (payload) => (isObject(payload) && Object.keys(payload).length === 0 ? {} : bad("This action takes no content.")),
    describe: () => (archived ? "Archive the repository on GitHub: read only, for everyone" : "Unarchive the repository on GitHub"),
    async perform(ctx) {
      const row = followed(ctx.repo, [archived ? "active" : "archived"]);
      const info = await current(ctx as ActionContext<unknown>, row);
      const out = await ctx.session.repos.update(info.ref, { archived });
      return {
        result: settled(out, archived ? ["Nobody can push to it, open issues or pull requests until it is unarchived; it stays public and citable."] : []),
        writes: [updateRepo(ctx.db, row.forge, row.repo_id, { state: archived ? "archived" : "active" }, ctx.t, { states: [archived ? "active" : "archived"] })],
        repo: { forge: row.forge, repoId: row.repo_id },
      };
    },
    same: (r) => r.archived === archived,
  });
}

export const archiveSpec = archiving("archive");
export const unarchiveSpec = archiving("unarchive");

// ─── transfer ────────────────────────────────────────────────────────────────

/** What a transfer changes, as GitHub documents it: the page shows it before the person confirms. */
export const TRANSFER_EFFECTS: readonly string[] = [
  "GitHub sends the old address to the new one, for git and for the web.",
  "Issues, pull requests, the wiki, stars and watchers move with it.",
  "Collaborators and team access may change: the new owner's own rules apply.",
  "A GitHub Pages site moves to the new owner's address; webhooks and the App's installation follow the new owner's.",
  "The registry follows it by its id: its papers, tracing maps and page stay attached.",
];

export const transferSpec: ActionSpec<{ newOwner: string; newName?: string }, Transferred> = {
  kind: "transfer",
  needsRepo: true,
  checkTarget: onRepository,
  validate(payload) {
    if (!isObject(payload) || typeof payload.newOwner !== "string" || !SEGMENT.test(payload.newOwner)) return bad("Name the account that receives it.");
    if (payload.newName !== undefined && !isNewRepoName(payload.newName)) return bad("The new name is not a repository name.");
    return payload.newName === undefined ? { newOwner: payload.newOwner } : { newOwner: payload.newOwner, newName: payload.newName };
  },
  describe: (p) => `Transfer the repository to ${p.newOwner}${p.newName ? `, as ${p.newName}` : ""}`,
  async perform(ctx) {
    const row = followed(ctx.repo);
    const info = await current(ctx as ActionContext<unknown>, row);
    const out = await ctx.session.repos.transfer(info.ref, ctx.parsed);
    const writes: Write[] = [];
    const notes = [...TRANSFER_EFFECTS];
    if (out.status === "done") {
      writes.push(
        updateRepo(ctx.db, row.forge, row.repo_id, { ownerId: out.repo.owner.id, ownerLogin: out.repo.ref.owner, name: out.repo.ref.name }, ctx.t, { differs: true }),
      );
    } else {
      notes.unshift(`${ctx.parsed.newOwner} must accept the transfer on GitHub within a day; until then the repository stays where it is.`);
    }
    return {
      result: { ...settled(out.repo, notes), status: out.status },
      writes,
      repo: { forge: row.forge, repoId: row.repo_id },
      outcome: out.status === "pending" ? "pending" : "done",
    };
  },
  check: (result, p, ctx) =>
    result.id === ctx.repo?.repo_id && (result.status === "pending" || (same(result.owner, p.newOwner) && (!p.newName || same(result.name, p.newName)))),
};

export const SETTINGS_ACTIONS: readonly AnyActionSpec[] = [
  renameSpec,
  editSpec,
  topicsSpec,
  featuresSpec,
  templateSpec,
  defaultBranchSpec,
  archiveSpec,
  unarchiveSpec,
  transferSpec,
];
