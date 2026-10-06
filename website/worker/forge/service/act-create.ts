// Creating a repository in the person's own GitHub account (D00-2), as one authorized action
// (E1): empty or with its first files (a README, a .gitignore template, a licence, the first
// branch's name), or from a template; then its row, its papers and a `link` job for the Mac (at
// most 6 rows with one paper: repos 2, the paper 1, the job 1, the action 1; budget W1). 10
// creations per account a day (gate.ts, CAP_OF). Visibility: public only (D00-14).
//
//   create    {name, description?, homepage?, readme?, gitignore?, license?, defaultBranch?,
//              template?, features?: {issues?, wiki?}, papers?: DOI[]}
//   generate  {template: {owner, name}, owner, name, description?, includeAllBranches?, papers?}
//
// Everything is checked before any request (the names with ../paths.ts, the templates and licences
// against src/lib/forge-templates.ts's lists); GitHub's answer must be the named repository, public,
// in the expected account (`check`), or nothing is recorded. A first branch GitHub could not rename
// is said in the answer, and the repository is recorded all the same (it exists on GitHub).

import { DEFAULT_BRANCH, isGitignoreTemplate, isLicenceKey, licenceOf } from "../../../src/lib/forge-templates.ts";
import { GitBackendError } from "../errors.ts";
import { isRefName, SEGMENT } from "../paths.ts";
import type { RepoFeatures, RepoInfo } from "../types.ts";
import { communityRepoKey, paperStatuses, readPapers } from "./papers.ts";
import { insertJob, insertRepo, linkPapers } from "./store.ts";
import { ForgeProblem, isProblem, type ActionContext, type ActionResult, type ActionSpec, type ActionTarget, type AnyActionSpec, type PaperStatus, type Write } from "./types.ts";

/** GitHub's own limits on a repository's description and website. */
export const DESCRIPTION_CHARS = 350;
export const HOMEPAGE_CHARS = 255;

export interface CreatePayload {
  name: string;
  description: string;
  homepage: string;
  readme: boolean;
  gitignore: string | null;
  license: string | null;
  defaultBranch: string | null;
  template: boolean;
  features: Partial<Pick<RepoFeatures, "issues" | "wiki">>;
  papers: string[];
}

export interface GeneratePayload {
  template: { owner: string; name: string };
  owner: string;
  name: string;
  description: string;
  includeAllBranches: boolean;
  papers: string[];
}

/** What the page gets back: the repository, its page on the site, and its papers' statuses. */
export interface Created {
  id: string;
  owner: string;
  name: string;
  visibility: string;
  template: boolean;
  defaultBranch: string | null;
  /** The repository's page on the site: /r/<owner>/<name>/ (its quick setup when empty). */
  page: string;
  papers: { doi: string; status: PaperStatus }[];
  /** What did not go as asked, in words (a first branch GitHub kept under its own name). */
  notes: string[];
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A repository name as GitHub takes it: letters, digits, ".", "-", "_", at most 100, not ".git". */
export const isNewRepoName = (v: unknown): v is string => typeof v === "string" && SEGMENT.test(v) && !/\.git$/i.test(v);

function text(v: unknown, what: string, most: number): string | ForgeProblem {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return bad(`The ${what} is not text.`);
  const s = v.trim();
  if ([...s].length > most) return bad(`The ${what} is longer than GitHub allows (${most} characters).`);
  if (/[\u0000-\u001f\u007f]/.test(s)) return bad(`The ${what} holds a control character.`);
  return s;
}

function homepage(v: unknown): string | ForgeProblem {
  const s = text(v, "website", HOMEPAGE_CHARS);
  if (isProblem(s) || s === "") return s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password) return bad("The website must be an https address.");
  } catch {
    return bad("The website is not an address.");
  }
  return s;
}

const flag = (v: unknown, what: string, fallback: boolean): boolean | ForgeProblem =>
  v === undefined || v === null ? fallback : typeof v === "boolean" ? v : bad(`“${what}” is not true or false.`);

/** Create and generate name no repository at start: the one they make comes from GitHub's answer. */
function noTarget(target: ActionTarget): ForgeProblem | null {
  if (target.repo !== null || target.branch !== null || target.expectedHead !== null) {
    return new ForgeProblem(400, "bad_request", "This action makes a new repository: it names no existing one.");
  }
  return null;
}

export function validateCreate(payload: unknown): CreatePayload | ForgeProblem {
  if (!isObject(payload)) return bad("The new repository is not described.");
  if (!isNewRepoName(payload.name)) {
    return bad("The name may hold letters, digits, “.”, “-” and “_” only, at most 100, and may not end in .git.");
  }
  const description = text(payload.description, "description", DESCRIPTION_CHARS);
  if (isProblem(description)) return description;
  const site = homepage(payload.homepage);
  if (isProblem(site)) return site;
  const readme = flag(payload.readme, "readme", false);
  if (isProblem(readme)) return readme;
  const template = flag(payload.template, "template", false);
  if (isProblem(template)) return template;
  let gitignore: string | null = null;
  if (payload.gitignore !== undefined && payload.gitignore !== null && payload.gitignore !== "") {
    if (!isGitignoreTemplate(payload.gitignore)) return bad("This is not one of GitHub's .gitignore templates the page offers.");
    gitignore = payload.gitignore;
  }
  let license: string | null = null;
  if (payload.license !== undefined && payload.license !== null && payload.license !== "") {
    if (!isLicenceKey(payload.license)) return bad("This is not one of GitHub's licences the page offers.");
    license = payload.license;
  }
  let defaultBranch: string | null = null;
  if (payload.defaultBranch !== undefined && payload.defaultBranch !== null && payload.defaultBranch !== "") {
    if (!isRefName(payload.defaultBranch) || String(payload.defaultBranch).includes("/")) return bad("This is not a branch name.");
    defaultBranch = String(payload.defaultBranch);
    if (!readme && !gitignore && !license) {
      return bad("An empty repository has no branch yet: its first push names it. Add a README, a .gitignore or a licence to name it here.");
    }
  }
  const features: CreatePayload["features"] = {};
  if (payload.features !== undefined && payload.features !== null) {
    if (!isObject(payload.features)) return bad("The features are not a list of choices.");
    for (const [k, v] of Object.entries(payload.features)) {
      if (k !== "issues" && k !== "wiki") return bad(`“${k.slice(0, 40)}” is not a feature this page sets.`);
      if (typeof v !== "boolean") return bad(`“${k}” is not true or false.`);
      features[k] = v;
    }
  }
  const papers = readPapers(payload.papers);
  if (isProblem(papers)) return papers;
  return { name: payload.name, description, homepage: site, readme, gitignore, license, defaultBranch, template, features, papers };
}

export function validateGenerate(payload: unknown): GeneratePayload | ForgeProblem {
  if (!isObject(payload)) return bad("The new repository is not described.");
  const t = payload.template;
  if (!isObject(t) || typeof t.owner !== "string" || !SEGMENT.test(t.owner) || !isNewRepoName(t.name)) {
    return bad("The template is not named as owner/name.");
  }
  if (typeof payload.owner !== "string" || !SEGMENT.test(payload.owner)) return bad("The account that receives the repository is not named.");
  if (!isNewRepoName(payload.name)) {
    return bad("The name may hold letters, digits, “.”, “-” and “_” only, at most 100, and may not end in .git.");
  }
  const description = text(payload.description, "description", DESCRIPTION_CHARS);
  if (isProblem(description)) return description;
  const includeAllBranches = flag(payload.includeAllBranches, "includeAllBranches", false);
  if (isProblem(includeAllBranches)) return includeAllBranches;
  const papers = readPapers(payload.papers);
  if (isProblem(papers)) return papers;
  return { template: { owner: t.owner, name: t.name }, owner: payload.owner, name: payload.name, description, includeAllBranches, papers };
}

const papersPhrase = (n: number) => (n === 0 ? "" : `, attached to ${n === 1 ? "one paper" : `${n} papers`}`);

export function describeCreate(p: CreatePayload): string {
  const files: string[] = [];
  if (p.readme || p.gitignore || p.license) files.push("a README");
  if (p.gitignore) files.push(`a ${p.gitignore} .gitignore`);
  if (p.license) files.push(`the ${licenceOf(p.license)?.name ?? p.license}`);
  const first = files.length ? `, with ${files.length > 1 ? `${files.slice(0, -1).join(", ")} and ${files.at(-1)}` : files[0]}` : ", empty";
  const branch = p.defaultBranch && files.length ? `, its first branch named ${p.defaultBranch}` : "";
  const template = p.template ? ", marked as a template" : "";
  return `Create the public repository ${p.name} in your GitHub account${first}${branch}${template}${papersPhrase(p.papers.length)}`;
}

export function describeGenerate(p: GeneratePayload): string {
  const branches = p.includeAllBranches ? "all its branches" : "its default branch";
  return `Create the public repository ${p.owner}/${p.name} from the template ${p.template.owner}/${p.template.name} (${branches})${papersPhrase(p.papers.length)}`;
}

/** The rows of a new repository: its row and index entry, its papers, the Mac's `link` job. */
async function record(
  ctx: ActionContext<unknown>,
  info: RepoInfo,
  defaultBranch: string | null,
  papers: string[],
  notes: string[],
): Promise<ActionResult<Created>> {
  const forge = info.key.forge;
  const repoId = info.key.id;
  const statuses = await paperStatuses(ctx.community, ctx.user.id, papers, communityRepoKey(forge, info.ref.owner, info.ref.name));
  const writes: Write[] = [
    insertRepo(
      ctx.db,
      {
        forge,
        repoId,
        ownerId: info.owner.id,
        ownerLogin: info.ref.owner,
        name: info.ref.name,
        mode: "created",
        defaultBranch,
        template: info.isTemplate,
        linkedBy: ctx.user.id,
      },
      ctx.t,
    ),
    ...linkPapers(ctx.db, forge, repoId, statuses, ctx.user.id, ctx.t),
    insertJob(ctx.db, { kind: "link", forge, repoId, userId: ctx.user.id }, ctx.t),
  ];
  const owner = info.ref.owner.toLowerCase();
  const name = info.ref.name.toLowerCase();
  return {
    result: {
      id: repoId,
      owner: info.ref.owner,
      name: info.ref.name,
      visibility: info.visibility,
      template: info.isTemplate,
      defaultBranch,
      page: `/r/${owner}/${name}/`,
      papers: statuses.map((s) => ({ doi: s.paperId.slice(4), status: s.status })),
      notes,
    },
    writes,
    repo: { forge, repoId },
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const createSpec: ActionSpec<CreatePayload, Created> = {
  kind: "create",
  needsRepo: false,
  checkTarget: noTarget,
  validate: validateCreate,
  describe: describeCreate,
  async perform(ctx) {
    const p = ctx.parsed;
    const autoInit = p.readme || p.gitignore !== null || p.license !== null;
    const info = await ctx.session.repos.create({
      name: p.name,
      description: p.description || undefined,
      homepage: p.homepage || undefined,
      visibility: "public",
      autoInit,
      gitignoreTemplate: p.gitignore ?? undefined,
      licenseTemplate: p.license ?? undefined,
      isTemplate: p.template,
      features: p.features,
    });
    const notes: string[] = [];
    let branch = info.defaultBranch ?? (autoInit ? DEFAULT_BRANCH : null);
    if (p.defaultBranch && info.defaultBranch && p.defaultBranch !== info.defaultBranch) {
      try {
        branch = (await ctx.session.git.renameBranch(info.ref, info.defaultBranch, p.defaultBranch)).name;
      } catch (err) {
        if (!(err instanceof GitBackendError)) throw err;
        notes.push(`GitHub kept the first branch's name, ${info.defaultBranch}: rename it from the repository's Branches page.`);
      }
    }
    return record(ctx as ActionContext<unknown>, info, branch, p.papers, notes);
  },
  check(result, p, ctx) {
    return (
      same(result.name, p.name) && same(result.owner, ctx.github.login) && result.visibility === "public" && result.template === p.template
    );
  },
};

export const generateSpec: ActionSpec<GeneratePayload, Created> = {
  kind: "generate",
  needsRepo: false,
  checkTarget: noTarget,
  validate: validateGenerate,
  describe: describeGenerate,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await ctx.session.repos.generate(
      { forge: ctx.backend.forge, owner: p.template.owner, name: p.template.name },
      { owner: p.owner, name: p.name, description: p.description || undefined, visibility: "public", includeAllBranches: p.includeAllBranches },
    );
    return record(ctx as ActionContext<unknown>, info, info.defaultBranch, p.papers, []);
  },
  check(result, p) {
    return same(result.name, p.name) && same(result.owner, p.owner) && result.visibility === "public";
  },
};

export const CREATE_ACTIONS: readonly AnyActionSpec[] = [createSpec, generateSpec];
