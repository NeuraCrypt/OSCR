// GitHub's releases, tags and release assets as authorized actions, and the registry's own layer over
// them (night phase 07, E1; docs/RELEASES.md; D00-4, D00-6, D00-9, D00-15, D07-*).
//
// Releases and tags are GitHub's objects (D00-6): the registry's release pages (src/scripts/
// repo-releases.ts) read them in the reader's browser, on the reader's own quota; every write is ONE
// authorized action, made by GitHub as the person, the token used once and revoked:
//
//   release_create   {tag, target, name?, body?, draft?, prerelease?, latest?, generateNotes?, paper?,
//                    map?, archive?, deposit?}: a draft (GitHub makes no tag) or a published release
//                    (GitHub makes the tag at `target`, the commit the page showed: the tracing map's
//                    lines are at a commit, never at a moving branch). `latest`: "true", "false" or
//                    "legacy" (GitHub's rule: the highest version, then the date). `generateNotes`:
//                    GitHub writes its notes after the person's text.
//   release_edit     {id, tag?, target?, name?, body?, draft?, prerelease?, latest?}: the text and the
//                    flags; a draft's tag and target; publishing a draft (draft: false). A published
//                    release keeps its tag and target (a paper may cite it), and one a paper version is
//                    tied to stays published (untie it first).
//   release_delete   {id, confirm: its tag as typed}: the release goes, its tag stays (GitHub's rule;
//                    GitHub never lets a release use the tag of a deleted immutable one again). One a
//                    paper version is tied to is not deleted (untie first).
//   release_drafts   {}: the drafts, read as the person (only people who may push see them); nothing is
//                    written on GitHub. The answer carries them (masked) for the releases page.
//   release_research {tag, paper?: {doi, version, label?}, untie?: doi, map?, archive?, deposit?: doi}:
//                    the registry's research extension, after the fact: tie the release to a version of
//                    a paper or untie it; ask Software Heritage to archive it (D00-15); ask for the
//                    Zenodo deposit of its validated tracing map (CLAUDE.md: a DOI only for a map an
//                    author validated, never the code; the Mac's sandbox until the owner switches).
//   tag_create       {name, target, message?}: a tag at a commit, annotated when there is a message.
//   tag_delete       {name, confirm}: not a tag a published release or a paper tie uses.
//   asset_upload     {release, name, label?, size, sha256, contentType}: the file itself comes as the
//                    body of POST /api/forge/asset (asset.ts, E5), streamed to GitHub without parsing;
//                    GitHub's digest of what arrived must be the one the page computed, or the asset is
//                    removed again.
//   asset_delete     {release, id, confirm: its name as typed}.
//
// The target is the repository the page declared (by GitHub's id). GitHub decides who may do what
// (writers publish; an immutable release's tag and assets are locked); its refusals are said in words.
// No title, note or asset reaches D1 or a log (D00-6). The registry's own rows:
// - `release_papers` (the tie of a release to a paper's version: 1 row; the commit its tag named, the
//   digest of the tracing map the person saw, `linked` or `proposed` by the roles of D01-22);
// - the Mac's jobs (1 row each): `release` when a tied release is published (the map versioned with
//   it), `archive` (Software Heritage, the tag in `ref`), `deposit` (Zenodo).
// A tie needs the repository to be known as that paper's code (repo_papers, or the Mac's paper_repo
// fact); a deposit needs a verified author of the paper (their role, not a maintainer's) with an ORCID
// iD linked, as Phase 6's validation does.

import { GitBackendError } from "../errors.ts";
import { BODY_CHARS, MESSAGE_BYTES } from "../limits.ts";
import { maskEmails } from "../mask.ts";
import { isRefName, OBJECT_ID } from "../paths.ts";
import type { Release, ReleaseAsset, RepoInfo, RepoRef, Tag } from "../types.ts";
import { declaredRepo, onDeclaredRepo } from "./act-pulls.ts";
import { ASSET_UPLOAD_BYTES } from "./caps.ts";
import { PAPER_VERSIONS, VERSION_WORDS, type PaperVersion } from "./paper-versions.ts";
import { communityRepoKey, paperId, paperStatuses } from "./papers.ts";
import { all, deleteReleasePaper, first, insertJob, releasePapersOf, repoByKey, upsertReleasePaper, type ReleasePaperRow } from "./store.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec, type PaperStatus, type RepoRow, type Write } from "./types.ts";

// ─── shared ──────────────────────────────────────────────────────────────────

export { PAPER_VERSIONS, VERSION_WORDS, type PaperVersion };
/** GitHub's `make_latest`: "legacy" lets GitHub choose (the highest version, then the date). */
export const LATEST = ["true", "false", "legacy"] as const;
export type Latest = (typeof LATEST)[number];
/** A release's title, as GitHub caps it. */
export const RELEASE_NAME_CHARS = 256;
/** A version's own label ("bioRxiv v2"). */
export const LABEL_CHARS = 80;
/** Drafts one answer carries. */
export const DRAFTS_SHOWN = 30;
/** Releases read to find the drafts (GitHub lists drafts first to people who may push). */
const DRAFT_PAGES = 3;

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,20}$/.test(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const HEX64 = /^[0-9a-f]{64}$/;
const short = (sha: string): string => sha.slice(0, 7);
const encoder = new TextEncoder();

/** A tag's name: git's rules (paths.ts isRefName), not "HEAD", not a full ref. */
export function isTagName(v: unknown): v is string {
  return isRefName(v) && v !== "HEAD" && !v.startsWith("refs/") && !v.startsWith("-");
}

/** An asset's file name as GitHub takes it (it renames what it does not like: the answer says so). */
export function isAssetName(v: unknown): v is string {
  return typeof v === "string" && v.trim() === v && v.length >= 1 && v.length <= 255 && !/[\u0000-\u001f\u007f/\\]/.test(v) && v !== "." && v !== "..";
}

/** The page of a repository's releases, of one release, of its tags: GitHub's shapes after /r/. */
const base = (ref: RepoRef): string => `/r/${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}/`;
const tagPath = (tag: string): string => tag.split("/").map(encodeURIComponent).join("/");
export const releasesPage = (ref: RepoRef): string => `${base(ref)}releases/`;
export const releasePage = (ref: RepoRef, tag: string): string => `${base(ref)}releases/tag/${tagPath(tag)}`;
export const tagsPage = (ref: RepoRef): string => `${base(ref)}tags/`;

/** GitHub's refusal, in words. */
function said(e: unknown, what: string): never {
  if (e instanceof GitBackendError) {
    if (e.code === "not_found") throw new ForgeProblem(404, "not_found", `GitHub does not know ${what} (deleted, or never there): nothing was done.`);
    if (e.code === "forbidden") throw new ForgeProblem(403, "forbidden", `GitHub says your account may not do this on ${what}: nothing was done.`);
    if (e.code === "invalid" && /immutable/i.test(e.message)) {
      throw new ForgeProblem(409, "immutable", `GitHub keeps ${what} as it is: an immutable release's tag and files are locked, and it stays published. Nothing was done.`);
    }
  }
  throw e;
}

// ─── the research extension: a paper's version, the map, the Mac's jobs ──────

export interface PaperTie {
  paperId: string;
  version: PaperVersion;
  label: string;
}

/** A paper's version as a payload names it: {doi, version, label?}. */
export function readTie(v: unknown): PaperTie | ForgeProblem {
  if (!isObject(v)) return bad("Name the paper by its DOI, and which version of it the release accompanies.");
  const id = paperId(v.doi);
  if (!id) return bad("The paper is named by its DOI (10.…).");
  if (!(PAPER_VERSIONS as readonly unknown[]).includes(v.version)) return bad("Say which version of the paper it accompanies: the preprint, the submitted or accepted manuscript, the version of record, or a correction.");
  let label = "";
  if (v.label !== undefined && v.label !== null) {
    if (typeof v.label !== "string" || v.label.length > LABEL_CHARS || /[\u0000-\u001f@]/.test(v.label)) return bad(`The version's label is ${LABEL_CHARS} characters at most, without an at sign.`);
    label = v.label.trim();
  }
  return { paperId: id, version: v.version as PaperVersion, label };
}

const tieWords = (t: PaperTie): string => `${VERSION_WORDS[t.version]}${t.label ? ` (${t.label})` : ""} of ${t.paperId}`;

/** A map's digest: 64 hex (oscr/zenodo.py map_digest). */
function readDigest(v: unknown): string | null | ForgeProblem {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !HEX64.test(v)) return bad("The tracing map's digest could not be read: reload the page, then try again.");
  return v;
}

/** Whether the registry knows this repository as this paper's code: attached in oscr_forge
 *  (repo_papers), or the Mac's fact in oscr_community (paper_repo). Both by key. */
async function knownCode(ctx: ActionContext<unknown>, info: RepoInfo, paper: string): Promise<boolean> {
  const row = await first<RepoRow>(repoByKey(ctx.db, info.key.forge, info.key.id));
  if (row && row.state !== "hidden") {
    const linked = await first(ctx.db.prepare("SELECT 1 AS x FROM repo_papers WHERE forge = ? AND repo_id = ? AND paper_id = ?").bind(info.key.forge, info.key.id, paper));
    if (linked) return true;
  }
  const fact = await first(ctx.community.prepare("SELECT 1 AS x FROM paper_repo WHERE repo = ? AND paper_id = ?").bind(communityRepoKey(info.key.forge, info.ref.owner, info.ref.name), paper));
  return fact !== null;
}

function notTheCode(info: RepoInfo, paper: string): ForgeProblem {
  return new ForgeProblem(
    409,
    "not_the_papers_code",
    `The registry does not know ${info.ref.owner}/${info.ref.name} as the code of ${paper}: attach the repository to the paper first (its Settings, Papers), then tie the release. Nothing was done.`,
  );
}

/** Whether the person holds a verified author's role for the paper (oscr_community roles, by key;
 *  account/store.ts hasRole, read here so that the pages' bundles stay free of the accounts' code). */
async function isAuthor(ctx: ActionContext<unknown>, paper: string): Promise<boolean> {
  const row = await first(
    ctx.community.prepare("SELECT 1 AS x FROM roles WHERE user_id = ? AND role = 'verified_author' AND scope_kind = 'paper' AND scope_id = ?").bind(ctx.user.id, paper),
  );
  return row !== null;
}

/** Which ORCID signs the registry's readers in (contributions/index.ts orcidProof): orcid.org, or its
 *  sandbox, whose iDs are tests (a deposit from it goes to Zenodo's sandbox only, never exported). */
export const orcidProof = (env: { ORCID_ISSUER?: string }): "orcid" | "orcid-sandbox" =>
  (env.ORCID_ISSUER ?? "").trim().replace(/\/+$/, "") === "https://orcid.org" ? "orcid" : "orcid-sandbox";

/** The deposit's rule (CLAUDE.md; Phase 6's validation): a verified author of the paper, with the
 *  ORCID iD the map is validated with. A maintainer of the code is not enough. */
async function mayDeposit(ctx: ActionContext<unknown>, paper: string): Promise<ForgeProblem | null> {
  if (!(await isAuthor(ctx, paper))) {
    return new ForgeProblem(403, "not_author", `Only a verified author of ${paper} asks for the Zenodo deposit of its tracing map: nothing was done.`);
  }
  const orcid = await first(ctx.community.prepare("SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = 'orcid'").bind(ctx.user.id));
  if (!orcid) return new ForgeProblem(409, "no_orcid", "Link your ORCID iD to your account first: the map is validated with it. Nothing was done.");
  return null;
}

/** Whether the person may push to the repository (GitHub says, as the person). */
async function mayPush(ctx: ActionContext<unknown>, info: RepoInfo): Promise<boolean> {
  const p = await ctx.session.repos.permission(info.ref, ctx.github.login);
  return p === "admin" || p === "maintain" || p === "write";
}

/** The commit a tag names on GitHub, or null when there is no such tag. */
async function tagCommit(ctx: ActionContext<unknown>, ref: RepoRef, tag: string): Promise<string | null> {
  try {
    return await ctx.session.git.resolve(ref, `refs/tags/${tag}`);
  } catch (e) {
    if (e instanceof GitBackendError && e.code === "not_found") return null;
    throw e;
  }
}

const ties = (ctx: ActionContext<unknown>, info: RepoInfo, tag: string) => all<ReleasePaperRow>(releasePapersOf(ctx.db, info.key.forge, info.key.id, tag));

/** A release's research answer, for the page. */
export interface TieDone {
  paperId: string;
  status: PaperStatus;
  version: PaperVersion;
}

/** The jobs asked, in words. */
const JOB_WORDS = {
  release: "the tracing map versioned with the release",
  archive: "Software Heritage's archive",
  deposit: "the Zenodo deposit of the validated tracing map",
} as const;
type AskedJob = keyof typeof JOB_WORDS;

// ─── releases ────────────────────────────────────────────────────────────────

/** A release, as the answers carry it: GitHub's fields, the notes masked. */
export interface ReleaseView {
  id: string;
  tag: string;
  target: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  createdAt: string;
  publishedAt: string | null;
  assets: { id: string; name: string; label: string; size: number; contentType: string; digest: string | null; downloads: number; createdAt: string }[];
}

export function releaseView(r: Release): ReleaseView {
  return {
    id: r.id,
    tag: r.tagName,
    target: r.target,
    name: maskEmails(r.name),
    body: maskEmails(r.body),
    draft: r.draft,
    prerelease: r.prerelease,
    immutable: r.immutable,
    createdAt: r.createdAt,
    publishedAt: r.publishedAt,
    assets: r.assets.map((a) => ({ id: a.id, name: maskEmails(a.name), label: maskEmails(a.label), size: a.size, contentType: a.contentType, digest: a.digest, downloads: a.downloads, createdAt: a.createdAt })),
  };
}

export interface ReleaseDone {
  id: string;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
  release: ReleaseView;
  papers?: TieDone[];
  jobs?: AskedJob[];
}

export interface CreateParsed {
  tag: string;
  target: string;
  name?: string;
  body?: string;
  draft: boolean;
  prerelease: boolean;
  latest?: Latest;
  generateNotes: boolean;
  paper: PaperTie | null;
  map: string | null;
  archive: boolean;
  deposit: boolean;
}

function readName(v: unknown): string | undefined | ForgeProblem {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > RELEASE_NAME_CHARS || /[\u0000-\u001f]/.test(v)) return bad(`A release's title is ${RELEASE_NAME_CHARS} characters at most, on one line.`);
  return v;
}

function readBody(v: unknown): string | undefined | ForgeProblem {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > BODY_CHARS) return bad(`A release's notes are ${BODY_CHARS} characters at most.`);
  return v;
}

function readLatest(v: unknown): Latest | undefined | ForgeProblem {
  if (v === undefined) return undefined;
  if (!(LATEST as readonly unknown[]).includes(v)) return bad("“Latest” is yes, no, or GitHub's own choice.");
  return v as Latest;
}

export function validateReleaseCreate(payload: unknown): CreateParsed | ForgeProblem {
  if (!isObject(payload)) return bad("Say the release's tag and the commit it names.");
  const p = payload;
  if (!isTagName(p.tag)) return bad("A tag name follows git's rules: letters, digits, “.”, “-”, “_” and “/”, no space, no “..”, at most 255 bytes.");
  if (typeof p.target !== "string" || !OBJECT_ID.test(p.target)) return bad("The release names the commit the page showed (its full id): reload the page, then try again.");
  const name = readName(p.name);
  if (name instanceof ForgeProblem) return name;
  const body = readBody(p.body);
  if (body instanceof ForgeProblem) return body;
  for (const k of ["draft", "prerelease", "generateNotes", "archive", "deposit"]) {
    if (p[k] !== undefined && !isBool(p[k])) return bad(`“${k}” is yes or no.`);
  }
  const latest = readLatest(p.latest);
  if (latest instanceof ForgeProblem) return latest;
  const draft = p.draft === true;
  const prerelease = p.prerelease === true;
  if (latest === "true" && (draft || prerelease)) return bad("A draft or a pre-release is never the latest release.");
  const paper = p.paper === undefined || p.paper === null ? null : readTie(p.paper);
  if (paper instanceof ForgeProblem) return paper;
  const map = readDigest(p.map);
  if (map instanceof ForgeProblem) return map;
  if (map && !paper) return bad("A tracing map goes with the paper it traces.");
  const archive = p.archive === true;
  const deposit = p.deposit === true;
  if ((archive || deposit) && draft) return bad("Software Heritage and Zenodo keep a published release: ask for them when you publish it.");
  if (deposit && (!paper || !map)) return bad("The Zenodo deposit is of the paper's tracing map: tie the release to the paper, with its map.");
  return { tag: p.tag, target: p.target.toLowerCase(), name, body, draft, prerelease, latest, generateNotes: p.generateNotes === true, paper, map, archive, deposit };
}

const LATEST_WORDS: Readonly<Record<Latest, string>> = { true: "set as the latest", false: "not the latest", legacy: "the latest as GitHub chooses it" };

export function describeReleaseCreate(p: CreateParsed): string {
  const flags = [p.prerelease ? "a pre-release" : "", p.latest ? LATEST_WORDS[p.latest] : "", p.generateNotes ? "GitHub's generated notes added" : ""].filter(Boolean);
  const research = [
    p.paper ? `tie it to ${tieWords(p.paper)}${p.map ? `, with the tracing map ${p.map.slice(0, 12)}` : ""}` : "",
    p.archive ? "ask Software Heritage to archive it" : "",
    p.deposit ? "ask for the Zenodo deposit of its tracing map, validated by you" : "",
  ].filter(Boolean);
  const what = p.draft ? `Save the draft release ${p.tag}` : `Publish the release ${p.tag}`;
  return `${what}${p.name ? ` “${p.name}”` : ""} at commit ${short(p.target)}${flags.length ? ` (${flags.join("; ")})` : ""}${research.length ? `; ${research.join("; ")}` : ""}`;
}

/** The rows and checks of the research part of a release, before GitHub is asked. */
async function researchPlan(
  ctx: ActionContext<unknown>,
  info: RepoInfo,
  ask: { paper: PaperTie | null; deposit: boolean },
): Promise<{ status: PaperStatus | null }> {
  if (!ask.paper) return { status: null };
  if (!(await knownCode(ctx, info, ask.paper.paperId))) throw notTheCode(info, ask.paper.paperId);
  if (ask.deposit) {
    const refused = await mayDeposit(ctx, ask.paper.paperId);
    if (refused) throw refused;
  }
  const [s] = await paperStatuses(ctx.community, ctx.user.id, [ask.paper.paperId], communityRepoKey(info.key.forge, info.ref.owner, info.ref.name));
  return { status: s.status };
}

export const releaseCreateSpec: ActionSpec<CreateParsed, ReleaseDone> = {
  kind: "release_create",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateReleaseCreate,
  describe: describeReleaseCreate,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    // The tag, when it exists, must name the commit the page showed.
    const existing = await tagCommit(ctx as ActionContext<unknown>, info.ref, p.tag);
    if (existing && existing !== p.target) {
      throw new ForgeProblem(409, "tag_moved", `The tag ${p.tag} names commit ${short(existing)}, not ${short(p.target)} as the page showed: reload the page. Nothing was done.`);
    }
    const plan = await researchPlan(ctx as ActionContext<unknown>, info, p);
    let made: Release;
    try {
      made = await ctx.session.releases.create(info.ref, {
        tagName: p.tag,
        target: p.target,
        name: p.name,
        body: p.body,
        draft: p.draft,
        prerelease: p.prerelease,
        makeLatest: p.latest === undefined || p.latest === "legacy" ? undefined : p.latest === "true",
        generateNotes: p.generateNotes || undefined,
      });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") {
        throw new ForgeProblem(409, "tag_taken", `A release already uses the tag ${p.tag}: edit that release, or choose another tag. Nothing was done.`);
      }
      if (e instanceof GitBackendError && e.code === "invalid" && /immutable/i.test(e.message)) {
        throw new ForgeProblem(409, "tag_burned", `GitHub never lets a release use the tag ${p.tag} again (an immutable release had it): choose another tag. Nothing was done.`);
      }
      said(e, `${info.ref.owner}/${info.ref.name}`);
    }
    const writes: Write[] = [];
    const jobs: AskedJob[] = [];
    const common = { forge: info.key.forge, repoId: info.key.id, ref: made.tagName, userId: ctx.user.id };
    const papers: TieDone[] = [];
    if (p.paper && plan.status) {
      writes.push(
        upsertReleasePaper(ctx.db, {
          forge: info.key.forge,
          repoId: info.key.id,
          tag: made.tagName,
          paperId: p.paper.paperId,
          releaseId: made.id,
          repoPath: `${info.ref.owner}/${info.ref.name}`,
          version: p.paper.version,
          label: p.paper.label,
          commit: p.target,
          mapDigest: p.map ?? "",
          status: plan.status,
          userId: ctx.user.id,
        }, ctx.t),
      );
      papers.push({ paperId: p.paper.paperId, status: plan.status, version: p.paper.version });
      if (!made.draft) {
        writes.push(insertJob(ctx.db, { ...common, kind: "release", paperId: p.paper.paperId }, ctx.t));
        jobs.push("release");
      }
    }
    if (p.archive && !made.draft) {
      writes.push(insertJob(ctx.db, { ...common, kind: "archive" }, ctx.t));
      jobs.push("archive");
    }
    if (p.deposit && p.paper && !made.draft) {
      writes.push(insertJob(ctx.db, { ...common, kind: "deposit", paperId: p.paper.paperId, proof: orcidProof(ctx.env) }, ctx.t));
      jobs.push("deposit");
    }
    const notes: string[] = [];
    if (made.draft) notes.push("A draft is seen only by the people who may push: GitHub makes its tag when it is published.");
    if (papers.some((x) => x.status === "proposed")) notes.push("The paper's tie is proposed: its authors confirm it (you are not a verified author of the paper, nor a maintainer of the code).");
    if (jobs.length) notes.push(`Asked of the registry's Mac: ${jobs.map((j) => JOB_WORDS[j]).join(", ")}. The release's page says when each is done.`);
    const page = made.draft ? releasesPage(info.ref) : releasePage(info.ref, made.tagName);
    return {
      result: {
        id: made.id,
        tag: made.tagName,
        draft: made.draft,
        prerelease: made.prerelease,
        immutable: made.immutable,
        page,
        links: [{ href: page, text: made.draft ? "The releases (your draft is listed for you)" : `The release ${made.tagName}` }],
        notes,
        release: releaseView(made),
        papers,
        jobs,
      },
      writes,
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) => r.tag === p.tag && r.draft === p.draft,
};

// ─── release_edit ────────────────────────────────────────────────────────────

export interface EditParsed {
  id: string;
  tag?: string;
  target?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  latest?: Latest;
}

export function validateReleaseEdit(payload: unknown): EditParsed | ForgeProblem {
  if (!isObject(payload) || !isId(payload.id)) return bad("Name the release by its id.");
  const p = payload;
  const out: EditParsed = { id: p.id as string };
  if (p.tag !== undefined) {
    if (!isTagName(p.tag)) return bad("A tag name follows git's rules: letters, digits, “.”, “-”, “_” and “/”, no space, no “..”.");
    out.tag = p.tag;
  }
  if (p.target !== undefined) {
    if (typeof p.target !== "string" || !OBJECT_ID.test(p.target)) return bad("The target is the commit the page showed (its full id).");
    out.target = p.target.toLowerCase();
  }
  const name = readName(p.name);
  if (name instanceof ForgeProblem) return name;
  if (name !== undefined) out.name = name;
  const body = readBody(p.body);
  if (body instanceof ForgeProblem) return body;
  if (body !== undefined) out.body = body;
  for (const k of ["draft", "prerelease"] as const) {
    if (p[k] !== undefined) {
      if (!isBool(p[k])) return bad(`“${k}” is yes or no.`);
      out[k] = p[k] as boolean;
    }
  }
  const latest = readLatest(p.latest);
  if (latest instanceof ForgeProblem) return latest;
  if (latest !== undefined) out.latest = latest;
  if (latest === "true" && (out.draft === true || out.prerelease === true)) return bad("A draft or a pre-release is never the latest release.");
  if (Object.keys(out).length === 1) return bad("Nothing to change.");
  return out;
}

export function describeReleaseEdit(p: EditParsed): string {
  const parts: string[] = [];
  if (p.tag !== undefined) parts.push(`its tag to ${p.tag}`);
  if (p.target !== undefined) parts.push(`its commit to ${short(p.target)}`);
  if (p.name !== undefined) parts.push(p.name ? `its title to “${p.name}”` : "no title");
  if (p.body !== undefined) parts.push("its notes");
  if (p.prerelease !== undefined) parts.push(p.prerelease ? "a pre-release" : "not a pre-release");
  if (p.latest !== undefined) parts.push(LATEST_WORDS[p.latest]);
  const changes = parts.length ? `: ${parts.join("; ")}` : "";
  if (p.draft === false) return `Publish the draft release${changes}`;
  if (p.draft === true) return `Turn the release back into a draft${changes}`;
  return `Edit the release${changes}`;
}

export const releaseEditSpec: ActionSpec<EditParsed, ReleaseDone> = {
  kind: "release_edit",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateReleaseEdit,
  describe: describeReleaseEdit,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let current: Release;
    try {
      current = await ctx.session.releases.get(info.ref, p.id);
    } catch (e) {
      said(e, "this release");
    }
    const moving = (p.tag !== undefined && p.tag !== current.tagName) || (p.target !== undefined && p.target !== current.target);
    if (moving && !current.draft) {
      throw new ForgeProblem(409, "published_tag", `A published release keeps its tag and its commit (a paper may cite ${current.tagName}): make a new release instead. Nothing was done.`);
    }
    const tied = await ties(ctx as ActionContext<unknown>, info, current.tagName);
    if (moving && tied.length) {
      throw new ForgeProblem(409, "tied", `A paper's version is tied to ${current.tagName}: untie it first, then change the tag. Nothing was done.`);
    }
    if (p.draft === true && !current.draft && tied.length) {
      throw new ForgeProblem(409, "tied", `A paper's version is tied to ${current.tagName}, so it stays published: untie it first. Nothing was done.`);
    }
    if (p.draft === false && current.draft) {
      const tag = p.tag ?? current.tagName;
      const target = p.target ?? current.target;
      const existing = await tagCommit(ctx as ActionContext<unknown>, info.ref, tag);
      if (existing && OBJECT_ID.test(target) && existing !== target) {
        throw new ForgeProblem(409, "tag_moved", `The tag ${tag} names commit ${short(existing)}, not the draft's ${short(target)}: set the draft's commit again. Nothing was done.`);
      }
    }
    let made: Release;
    try {
      made = await ctx.session.releases.update(info.ref, p.id, {
        tagName: p.tag,
        target: p.target,
        name: p.name,
        body: p.body,
        draft: p.draft,
        prerelease: p.prerelease,
        makeLatest: p.latest === undefined || p.latest === "legacy" ? undefined : p.latest === "true",
      });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") throw new ForgeProblem(409, "tag_taken", `A release already uses the tag ${p.tag}: nothing was done.`);
      said(e, `the release ${current.tagName}`);
    }
    const writes: Write[] = [];
    const jobs: AskedJob[] = [];
    const publishing = current.draft && !made.draft;
    if (publishing) {
      for (const t of tied) {
        writes.push(insertJob(ctx.db, { kind: "release", forge: info.key.forge, repoId: info.key.id, ref: made.tagName, userId: ctx.user.id, paperId: t.paper_id }, ctx.t));
        if (!jobs.includes("release")) jobs.push("release");
      }
    }
    const notes: string[] = [];
    if (jobs.length) notes.push(`Asked of the registry's Mac: ${JOB_WORDS.release}. The release's page says when it is done.`);
    if (publishing) notes.push("GitHub made its tag, at the draft's commit.");
    const page = made.draft ? releasesPage(info.ref) : releasePage(info.ref, made.tagName);
    return {
      result: {
        id: made.id,
        tag: made.tagName,
        draft: made.draft,
        prerelease: made.prerelease,
        immutable: made.immutable,
        page,
        links: [{ href: page, text: made.draft ? "The releases" : `The release ${made.tagName}` }],
        notes,
        release: releaseView(made),
        jobs,
      },
      writes,
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) =>
    r.id === p.id &&
    (p.tag === undefined || r.tag === p.tag) &&
    (p.draft === undefined || r.draft === p.draft) &&
    (p.prerelease === undefined || r.prerelease === p.prerelease),
};

// ─── release_delete ──────────────────────────────────────────────────────────

export interface DeleteParsed {
  id: string;
  confirm: string;
}

export interface DeleteDone {
  id: string;
  tag: string;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
}

export const releaseDeleteSpec: ActionSpec<DeleteParsed, DeleteDone> = {
  kind: "release_delete",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload) || !isId(payload.id)) return bad("Name the release by its id.");
    if (typeof payload.confirm !== "string" || !payload.confirm.trim() || payload.confirm.length > 255) return bad("Type the release's tag to confirm.");
    return { id: payload.id as string, confirm: payload.confirm.trim() };
  },
  describe: (p) => `Delete the release ${p.confirm} (its tag stays)`,
  async perform(ctx) {
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let current: Release;
    try {
      current = await ctx.session.releases.get(info.ref, ctx.parsed.id);
    } catch (e) {
      said(e, "this release");
    }
    if (ctx.parsed.confirm !== current.tagName) throw new ForgeProblem(400, "confirm_name", `What you typed is not ${current.tagName}: nothing was done.`);
    if ((await ties(ctx as ActionContext<unknown>, info, current.tagName)).length) {
      throw new ForgeProblem(409, "tied", `A paper's version is tied to ${current.tagName}: a release a paper cites stays. Untie it first. Nothing was done.`);
    }
    try {
      await ctx.session.releases.delete(info.ref, current.id);
    } catch (e) {
      said(e, `the release ${current.tagName}`);
    }
    const notes = [`The tag ${current.tagName} stays on GitHub; the Tags page deletes it if you mean to.`];
    if (current.immutable) notes.push(`GitHub never lets a release use the tag ${current.tagName} again: it was an immutable release.`);
    return {
      result: { id: current.id, tag: current.tagName, page: releasesPage(info.ref), links: [{ href: releasesPage(info.ref), text: "The releases" }], notes },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) => r.id === p.id && r.tag === p.confirm,
};

// ─── release_drafts ──────────────────────────────────────────────────────────

export interface DraftsDone {
  repo: string;
  drafts: ReleaseView[];
  more: boolean;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
}

export const releaseDraftsSpec: ActionSpec<Record<string, never>, DraftsDone> = {
  kind: "release_drafts",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: (payload) => (isObject(payload) && Object.keys(payload).length === 0 ? {} : bad("This action takes no content.")),
  describe: () => "Show me the repository's draft releases (GitHub shows them only to the people who may push)",
  async perform(ctx) {
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    const drafts: Release[] = [];
    let cursor: string | null = null;
    let more = false;
    for (let i = 0; i < DRAFT_PAGES; i++) {
      const page = await ctx.session.releases.list(info.ref, { perPage: 100, cursor });
      for (const r of page.items) if (r.draft) drafts.push(r);
      cursor = page.next;
      if (!cursor) break;
      if (i === DRAFT_PAGES - 1) more = true;
    }
    const shown = drafts.slice(0, DRAFTS_SHOWN).map(releaseView);
    const notes = [
      shown.length
        ? `${shown.length} ${shown.length === 1 ? "draft" : "drafts"}${drafts.length > DRAFTS_SHOWN || more ? " (the most recent)" : ""}: the releases page shows them in this tab only.`
        : "No draft: GitHub shows none to your account.",
    ];
    return {
      result: { repo: `${info.ref.owner}/${info.ref.name}`, drafts: shown, more: more || drafts.length > DRAFTS_SHOWN, page: releasesPage(info.ref), links: [{ href: releasesPage(info.ref), text: "The releases, with your drafts" }], notes },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r) => Array.isArray(r.drafts) && r.drafts.every((d) => d.draft),
};

// ─── release_research ────────────────────────────────────────────────────────

export interface ResearchParsed {
  tag: string;
  paper: PaperTie | null;
  untie: string | null;
  map: string | null;
  archive: boolean;
  deposit: string | null;
}

export interface ResearchDone {
  tag: string;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
  papers: TieDone[];
  untied: string | null;
  jobs: AskedJob[];
}

export function validateReleaseResearch(payload: unknown): ResearchParsed | ForgeProblem {
  if (!isObject(payload) || !isTagName(payload.tag)) return bad("Name the release by its tag.");
  const p = payload;
  const paper = p.paper === undefined || p.paper === null ? null : readTie(p.paper);
  if (paper instanceof ForgeProblem) return paper;
  const untie = p.untie === undefined || p.untie === null ? null : paperId(p.untie);
  if (p.untie !== undefined && p.untie !== null && !untie) return bad("The paper to untie is named by its DOI.");
  const map = readDigest(p.map);
  if (map instanceof ForgeProblem) return map;
  if (p.archive !== undefined && !isBool(p.archive)) return bad("“archive” is yes or no.");
  const deposit = p.deposit === undefined || p.deposit === null ? null : paperId(p.deposit);
  if (p.deposit !== undefined && p.deposit !== null && !deposit) return bad("The paper whose map is deposited is named by its DOI.");
  if (!paper && !untie && p.archive !== true && !deposit) return bad("Nothing asked.");
  if (paper && untie) return bad("Tie or untie, one at a time.");
  if (deposit && untie === deposit) return bad("A map is deposited for a paper the release stays tied to.");
  if (deposit && paper && paper.paperId !== deposit) return bad("The deposit is of the tied paper's map.");
  if (map && !paper && !deposit) return bad("A tracing map goes with the paper it traces.");
  return { tag: p.tag as string, paper, untie, map, archive: p.archive === true, deposit };
}

export function describeReleaseResearch(p: ResearchParsed): string {
  const parts = [
    p.paper ? `tie it to ${tieWords(p.paper)}${p.map ? `, with the tracing map ${p.map.slice(0, 12)}` : ""}` : "",
    p.untie ? `untie it from ${p.untie}` : "",
    p.archive ? "ask Software Heritage to archive it" : "",
    p.deposit ? `ask for the Zenodo deposit of the tracing map of ${p.deposit}${!p.paper && p.map ? ` (${p.map.slice(0, 12)})` : ""}, validated by you` : "",
  ].filter(Boolean);
  return `For the release ${p.tag}: ${parts.join("; ")}`;
}

/** The release of a tag as the person sees it: a published one, or one of their drafts. */
async function releaseOfTag(ctx: ActionContext<unknown>, ref: RepoRef, tag: string): Promise<Release | null> {
  try {
    return await ctx.session.releases.byTag(ref, tag);
  } catch (e) {
    if (!(e instanceof GitBackendError && e.code === "not_found")) throw e;
  }
  let cursor: string | null = null;
  for (let i = 0; i < DRAFT_PAGES; i++) {
    const page = await ctx.session.releases.list(ref, { perPage: 100, cursor });
    const found = page.items.find((r) => r.draft && r.tagName === tag);
    if (found) return found;
    cursor = page.next;
    if (!cursor) break;
  }
  return null;
}

export const releaseResearchSpec: ActionSpec<ResearchParsed, ResearchDone> = {
  kind: "release_research",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateReleaseResearch,
  describe: describeReleaseResearch,
  async perform(ctx) {
    const p = ctx.parsed;
    const c = ctx as ActionContext<unknown>;
    const info = await declaredRepo(c);
    const release = await releaseOfTag(c, info.ref, p.tag);
    if (!release) throw new ForgeProblem(404, "not_found", `GitHub shows no release ${p.tag} to your account: nothing was done.`);
    if ((p.archive || p.deposit) && release.draft) throw new ForgeProblem(409, "draft", "Software Heritage and Zenodo keep a published release: publish it first. Nothing was done.");
    const current = await ties(c, info, release.tagName);
    const writer = await mayPush(c, info);
    // Who may: a person who may push, for everything but the deposit; a verified author of the paper
    // tied or untied, for their own paper; the deposit, a verified author with an ORCID iD only.
    const authorOf = (paper: string) => isAuthor(c, paper);
    if (p.archive && !writer) {
      throw new ForgeProblem(403, "not_maintainer", "Only a person who may push to this repository asks for its archive here; anyone can on Software Heritage's own site. Nothing was done.");
    }
    if (p.paper && !writer && !(await authorOf(p.paper.paperId))) {
      throw new ForgeProblem(403, "forbidden", `Only a person who may push to this repository, or a verified author of ${p.paper.paperId}, ties a release to it. Nothing was done.`);
    }
    if (p.untie && !writer && !(await authorOf(p.untie))) {
      throw new ForgeProblem(403, "forbidden", `Only a person who may push to this repository, or a verified author of ${p.untie}, unties it. Nothing was done.`);
    }
    if (p.untie && !current.some((t) => t.paper_id === p.untie)) throw new ForgeProblem(409, "not_tied", `The release ${release.tagName} is not tied to ${p.untie}: nothing was done.`);
    if (p.paper && !(await knownCode(c, info, p.paper.paperId))) throw notTheCode(info, p.paper.paperId);
    let depositDigest = "";
    if (p.deposit) {
      const refused = await mayDeposit(c, p.deposit);
      if (refused) throw refused;
      const tie = current.find((t) => t.paper_id === p.deposit);
      if (!p.paper && !tie) throw new ForgeProblem(409, "not_tied", `Tie the release to ${p.deposit} first: its map is deposited with the release. Nothing was done.`);
      depositDigest = p.map ?? tie?.map_digest ?? "";
      if (!depositDigest) throw new ForgeProblem(409, "no_map", "The page showed no tracing map to validate: reload it. Nothing was done.");
    }
    const commit = release.draft ? (OBJECT_ID.test(release.target) ? release.target : "") : ((await tagCommit(c, info.ref, release.tagName)) ?? "");
    const writes: Write[] = [];
    const jobs: AskedJob[] = [];
    const papers: TieDone[] = [];
    const common = { forge: info.key.forge, repoId: info.key.id, ref: release.tagName, userId: ctx.user.id };
    if (p.paper) {
      const [s] = await paperStatuses(ctx.community, ctx.user.id, [p.paper.paperId], communityRepoKey(info.key.forge, info.ref.owner, info.ref.name));
      writes.push(
        upsertReleasePaper(ctx.db, {
          forge: info.key.forge,
          repoId: info.key.id,
          tag: release.tagName,
          paperId: p.paper.paperId,
          releaseId: release.id,
          repoPath: `${info.ref.owner}/${info.ref.name}`,
          version: p.paper.version,
          label: p.paper.label,
          commit,
          mapDigest: p.map ?? "",
          status: s.status,
          userId: ctx.user.id,
        }, ctx.t),
      );
      papers.push({ paperId: p.paper.paperId, status: s.status, version: p.paper.version });
      if (!release.draft) {
        writes.push(insertJob(ctx.db, { ...common, kind: "release", paperId: p.paper.paperId }, ctx.t));
        jobs.push("release");
      }
    } else if (p.deposit && p.map) {
      // The map the author validates now becomes the tie's map (the row is its key: 1 row).
      const tie = current.find((t) => t.paper_id === p.deposit) as ReleasePaperRow;
      writes.push(
        upsertReleasePaper(ctx.db, {
          forge: tie.forge,
          repoId: tie.repo_id,
          tag: tie.tag,
          paperId: tie.paper_id,
          releaseId: tie.release_id || release.id,
          repoPath: tie.repo_path,
          version: tie.version,
          label: tie.label,
          commit: tie.commit_sha || commit,
          mapDigest: p.map,
          status: tie.status,
          userId: tie.by_user,
        }, tie.at),
      );
    }
    if (p.untie) writes.push(deleteReleasePaper(ctx.db, info.key.forge, info.key.id, release.tagName, p.untie));
    if (p.archive) {
      writes.push(insertJob(ctx.db, { ...common, kind: "archive" }, ctx.t));
      jobs.push("archive");
    }
    if (p.deposit) {
      writes.push(insertJob(ctx.db, { ...common, kind: "deposit", paperId: p.deposit, proof: orcidProof(ctx.env) }, ctx.t));
      jobs.push("deposit");
    }
    const notes: string[] = [];
    if (papers.some((x) => x.status === "proposed")) notes.push("The paper's tie is proposed: its authors confirm it (you are not a verified author of the paper, nor a maintainer of the code).");
    if (jobs.length) notes.push(`Asked of the registry's Mac: ${jobs.map((j) => JOB_WORDS[j]).join(", ")}. The release's page says when each is done.`);
    if (p.untie) notes.push(`The release ${release.tagName} is no longer tied to ${p.untie}.`);
    const page = release.draft ? releasesPage(info.ref) : releasePage(info.ref, release.tagName);
    return {
      result: { tag: release.tagName, page, links: [{ href: page, text: release.draft ? "The releases" : `The release ${release.tagName}` }], notes, papers, untied: p.untie, jobs },
      writes,
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) => r.tag === p.tag,
};

// ─── tags ────────────────────────────────────────────────────────────────────

export interface TagCreateParsed {
  name: string;
  target: string;
  message?: string;
}

export interface TagDone {
  tag: string;
  sha: string;
  annotated: boolean;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
}

export const tagCreateSpec: ActionSpec<TagCreateParsed, TagDone> = {
  kind: "tag_create",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload) || !isTagName(payload.name)) return bad("A tag name follows git's rules: letters, digits, “.”, “-”, “_” and “/”, no space, no “..”.");
    if (typeof payload.target !== "string" || !OBJECT_ID.test(payload.target)) return bad("A tag names a commit: its full id, as the page showed it.");
    const out: TagCreateParsed = { name: payload.name, target: payload.target.toLowerCase() };
    if (payload.message !== undefined) {
      if (typeof payload.message !== "string" || !payload.message.trim() || encoder.encode(payload.message).byteLength > MESSAGE_BYTES) return bad("An annotated tag's message is not empty, and 64 KiB at most.");
      out.message = payload.message;
    }
    return out;
  },
  describe: (p) => `Create the ${p.message ? "annotated " : ""}tag ${p.name} at commit ${short(p.target)}`,
  async perform(ctx) {
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let made: Tag;
    try {
      made = await ctx.session.git.createTag(info.ref, { name: ctx.parsed.name, sha: ctx.parsed.target, message: ctx.parsed.message });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") throw new ForgeProblem(409, "tag_taken", `The tag ${ctx.parsed.name} exists already: a tag never moves here. Nothing was done.`);
      if (e instanceof GitBackendError && e.code === "invalid") throw new ForgeProblem(400, "bad_target", `GitHub does not know the commit ${short(ctx.parsed.target)} in this repository: nothing was done.`);
      said(e, `${info.ref.owner}/${info.ref.name}`);
    }
    return {
      result: {
        tag: made.name,
        sha: made.sha,
        annotated: made.annotation !== null,
        page: tagsPage(info.ref),
        links: [{ href: tagsPage(info.ref), text: "The tags" }],
        notes: [],
      },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) => r.tag === p.name && r.sha === p.target,
};

export const tagDeleteSpec: ActionSpec<{ name: string; confirm: string }, TagDone> = {
  kind: "tag_delete",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload) || !isTagName(payload.name)) return bad("Name the tag.");
    if (typeof payload.confirm !== "string" || payload.confirm.trim() !== payload.name) return bad("Type the tag's name to confirm.");
    return { name: payload.name, confirm: payload.confirm.trim() };
  },
  describe: (p) => `Delete the tag ${p.name}`,
  async perform(ctx) {
    const c = ctx as ActionContext<unknown>;
    const info = await declaredRepo(c);
    const name = ctx.parsed.name;
    if ((await ties(c, info, name)).length) {
      throw new ForgeProblem(409, "tied", `A paper's version is tied to the release ${name}: its tag stays, so a citation of it keeps meaning the same code. Nothing was done.`);
    }
    let release: Release | null = null;
    try {
      release = await ctx.session.releases.byTag(info.ref, name);
    } catch (e) {
      if (!(e instanceof GitBackendError && e.code === "not_found")) throw e;
    }
    if (release && !release.draft) {
      throw new ForgeProblem(409, "released", `The published release ${name} uses this tag: a published release keeps its tag. Delete the release first if you mean to. Nothing was done.`);
    }
    const sha = await tagCommit(c, info.ref, name);
    if (!sha) throw new ForgeProblem(404, "not_found", `GitHub has no tag ${name}: nothing was done.`);
    try {
      await ctx.session.git.deleteTag(info.ref, name);
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "forbidden") {
        throw new ForgeProblem(403, "forbidden", `GitHub keeps the tag ${name} (an immutable release's tag is locked, or your account may not delete tags here): nothing was done.`);
      }
      said(e, `the tag ${name}`);
    }
    return {
      result: { tag: name, sha, annotated: false, page: tagsPage(info.ref), links: [{ href: tagsPage(info.ref), text: "The tags" }], notes: [`The tag ${name} named commit ${short(sha)}; the commit stays in the history.`] },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) => r.tag === p.name,
};

// ─── assets ──────────────────────────────────────────────────────────────────

export interface UploadParsed {
  release: string;
  name: string;
  label?: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface AssetDone {
  id: string;
  name: string;
  size: number;
  digest: string | null;
  release: string;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
}

const CONTENT_TYPE = /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/;

export function validateAssetUpload(payload: unknown): UploadParsed | ForgeProblem {
  if (!isObject(payload) || !isId(payload.release)) return bad("Name the release the file goes to.");
  const p = payload;
  if (!isAssetName(p.name)) return bad("A file's name is 1 to 255 characters, without “/”, “\\” or control characters.");
  if (typeof p.size !== "number" || !Number.isInteger(p.size) || p.size < 1) return bad("The file is empty.");
  if (p.size > ASSET_UPLOAD_BYTES) {
    return new ForgeProblem(413, "too_large", `A file passes through the registry up to ${ASSET_UPLOAD_BYTES / 2 ** 20} MiB: a larger one goes on GitHub's own release page (up to 2 GiB), or to Zenodo or Hugging Face.`);
  }
  if (typeof p.sha256 !== "string" || !HEX64.test(p.sha256)) return bad("The file's SHA-256 could not be read: choose the file again.");
  if (typeof p.contentType !== "string" || !CONTENT_TYPE.test(p.contentType)) return bad("The file's type is not one GitHub takes.");
  const out: UploadParsed = { release: p.release as string, name: p.name, size: p.size, sha256: p.sha256, contentType: p.contentType };
  if (p.label !== undefined && p.label !== "") {
    if (typeof p.label !== "string" || p.label.length > 255 || /[\u0000-\u001f]/.test(p.label)) return bad("A file's label is one line of 255 characters at most.");
    out.label = p.label;
  }
  return out;
}

const sizeWords = (n: number): string => (n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} bytes`);

export const assetUploadSpec: ActionSpec<UploadParsed, AssetDone> = {
  kind: "asset_upload",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateAssetUpload,
  describe: (p) => `Attach the file ${p.name} (${sizeWords(p.size)}, SHA-256 ${p.sha256.slice(0, 12)}…)${p.label ? `, labelled “${p.label}”,` : ""} to the release`,
  async perform(ctx) {
    const p = ctx.parsed;
    const upload = ctx.upload;
    if (!upload) throw new ForgeProblem(400, "no_file", "A file is attached from the release's page, with the file itself: nothing was done.");
    if (upload.size !== p.size) throw new ForgeProblem(400, "bad_size", "The file that arrived is not the size you confirmed: nothing was done.");
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let release: Release;
    try {
      release = await ctx.session.releases.get(info.ref, p.release);
    } catch (e) {
      said(e, "this release");
    }
    if (release.immutable) throw new ForgeProblem(409, "immutable", `GitHub locks the files of the immutable release ${release.tagName}: nothing was done.`);
    let made: ReleaseAsset;
    try {
      made = await ctx.session.releases.uploadAsset(info.ref, release.id, { name: p.name, label: p.label, contentType: p.contentType, size: p.size, body: upload.body });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") throw new ForgeProblem(409, "asset_taken", `The release already has a file named ${p.name}: delete it first, or rename yours. Nothing was done.`);
      said(e, `the release ${release.tagName}`);
    }
    if (made.digest !== null && made.digest !== p.sha256) {
      // What reached GitHub is not the file the person chose: it goes again, as the person.
      await ctx.session.releases.deleteAsset(info.ref, made.id).catch(() => undefined);
      throw new ForgeProblem(502, "digest_mismatch", "The file that reached GitHub is not the one you chose (its SHA-256 differs): it was removed again. Try once more.");
    }
    const notes: string[] = [];
    if (made.name !== p.name) notes.push(`GitHub named it ${made.name} (it renames characters it does not take).`);
    if (made.digest === null) notes.push("GitHub gave no SHA-256 for it: the release's page shows the one your browser computed.");
    const page = release.draft ? releasesPage(info.ref) : releasePage(info.ref, release.tagName);
    return {
      result: { id: made.id, name: made.name, size: made.size, digest: made.digest, release: release.id, page, links: [{ href: page, text: release.draft ? "The releases" : `The release ${release.tagName}` }], notes },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) => r.size === p.size && r.release === p.release && (r.digest === null || r.digest === p.sha256),
};

export const assetDeleteSpec: ActionSpec<{ release: string; id: string; confirm: string }, AssetDone> = {
  kind: "asset_delete",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload) || !isId(payload.release) || !isId(payload.id)) return bad("Name the release and its file.");
    if (typeof payload.confirm !== "string" || !payload.confirm.trim() || payload.confirm.length > 255) return bad("Type the file's name to confirm.");
    return { release: payload.release as string, id: payload.id as string, confirm: payload.confirm.trim() };
  },
  describe: (p) => `Delete the file ${p.confirm} from the release`,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let release: Release;
    try {
      release = await ctx.session.releases.get(info.ref, p.release);
    } catch (e) {
      said(e, "this release");
    }
    const asset = release.assets.find((a) => a.id === p.id);
    if (!asset) throw new ForgeProblem(404, "not_found", "The release has no such file (deleted already?): nothing was done.");
    if (asset.name !== p.confirm) throw new ForgeProblem(400, "confirm_name", `What you typed is not ${asset.name}: nothing was done.`);
    if (release.immutable) throw new ForgeProblem(409, "immutable", `GitHub locks the files of the immutable release ${release.tagName}: nothing was done.`);
    try {
      await ctx.session.releases.deleteAsset(info.ref, asset.id);
    } catch (e) {
      said(e, `the file ${asset.name}`);
    }
    const page = release.draft ? releasesPage(info.ref) : releasePage(info.ref, release.tagName);
    return {
      result: { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest, release: release.id, page, links: [{ href: page, text: release.draft ? "The releases" : `The release ${release.tagName}` }], notes: [] },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) => r.id === p.id && r.name === p.confirm,
};

export const RELEASE_ACTIONS: readonly AnyActionSpec[] = [
  releaseCreateSpec,
  releaseEditSpec,
  releaseDeleteSpec,
  releaseDraftsSpec,
  releaseResearchSpec,
  tagCreateSpec,
  tagDeleteSpec,
  assetUploadSpec,
  assetDeleteSpec,
];
