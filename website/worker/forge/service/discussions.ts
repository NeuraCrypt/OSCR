// The routes of discussions (night phase 06, E2; docs/DISCUSSIONS.md): what discussions-core.ts
// describes, read and written for a signed-in reader. OSCR's own objects (D00-6): nothing is written
// on GitHub. The model is the research issues' (research.ts).
//
//   GET  /api/forge/discussions?id=N                 one discussion, its comments, the reader's votes
//   GET  /api/forge/discussions?space=paper:10.…      a space: its categories and its discussions
//   POST /api/forge/discussions/open                  a new discussion (3 rows; 4 when the space is new)
//   POST /api/forge/discussions/comment               a comment (3 rows); its edit, deletion, hiding (2)
//   POST /api/forge/discussions/vote                  an upvote, a poll vote, or either taken back (3)
//   POST /api/forge/discussions/edit                  title, body, category, answered, labels, lock,
//                                                     pin, close, reopen, transfer (2)
//
// Signed in: the reads need a session (a signed-out reader reads the nightly static shards, to come);
// the writes the session, its CSRF token and the site's Origin, FORGE_OPEN (the owner only until
// phase 16), the human check on a new discussion or comment (Turnstile), the blocks and interaction
// limits of a repository space (mayInteract), the per-account caps, and the day's rows. Every text is
// masked for addresses before it is stored (discussions-core `clean`).
//
// Who may do what: anyone signed in opens a discussion (an announcement category only a maintainer),
// comments (a locked discussion takes comments from maintainers only), votes; the author edits its
// title, body and category, closes and reopens it; the space's MAINTAINERS (a paper's verified
// authors, a repository's maintainers, an organization's owners and moderators, the registry's
// moderators) do that too, and mark the answer, label, lock, pin, transfer, hide and delete.

import type { SignedIn } from "../../account/guard.ts";
import { mayInteract } from "./blocks.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import {
  bumpCommentUpvotes,
  bumpUpvotes,
  clean,
  commentsOf,
  commentViewOf,
  DEFAULT_CATEGORIES,
  deleteVote,
  DISCUSSION_BODY_BYTES,
  DISCUSSION_COMMENTS,
  discussionById,
  discussionsOfSpace,
  insertComment,
  insertDiscussion,
  insertVote,
  parseCategories,
  personOf,
  POLL_OPTIONS_MAX,
  readSpace,
  setPoll,
  spaceByKey,
  summaryOf,
  updateComment,
  updateDiscussion,
  upsertSpace,
  validateComment,
  validateEdit,
  validateOpen,
  validateVote,
  viewOf,
  voteRef,
  voteRow,
  type Category,
  type CommentRow,
  type DiscussionRow,
  type Format,
  type Poll,
  type Space,
  type TimelineEvent,
} from "./discussions-core.ts";
import { readCapped } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { accountHidden, hiddenActors } from "./hidden.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { isOwner } from "./moderation.ts";
import { memberOf, orgByHandle } from "./org-core.ts";
import { communityRepoKey } from "./papers.ts";
import { who as whoAsks } from "./who.ts";
import { requireHuman } from "./turnstile.ts";
import { actionRow, all, first, newNonce, repoByKey, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type D1Database, type DiscussionRowKind, type ForgeRequest, type RepoRow, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;

interface Roles {
  papers: Set<string>;
  repos: Set<string>;
  moderator: boolean;
}

/** The reader's roles (oscr_community, by the roles' key prefix: the person's few rows). */
async function rolesOf(community: D1Database, userId: string): Promise<Roles> {
  const rows = await all<{ role: string; scope_kind: string; scope_id: string }>(
    community.prepare("SELECT role, scope_kind, scope_id FROM roles WHERE user_id = ?").bind(userId),
  );
  return {
    papers: new Set(rows.filter((r) => r.role === "verified_author" && r.scope_kind === "paper").map((r) => r.scope_id.toLowerCase())),
    repos: new Set(rows.filter((r) => r.role === "maintainer" && r.scope_kind === "repo").map((r) => r.scope_id.toLowerCase())),
    moderator: rows.some((r) => r.role === "moderator" || r.role === "admin"),
  };
}

/** The repository row of a repo space (null for another kind, or a hidden/gone one). */
async function repoOf(db: D1Database, space: Space): Promise<RepoRow | null> {
  if (space.kind !== "repo" || !space.repoId) return null;
  const row = await first<RepoRow>(repoByKey(db, space.forge || "github", space.repoId));
  return row && row.name && (row.state === "active" || row.state === "archived") ? row : null;
}

/** Whether the reader holds the maintain role on a space: a paper's verified author, a repository's
 *  maintainer or its registry manager, an organization's owner or moderator, the registry's
 *  moderators. The author's role word for a write ("verified_author"/"maintainer"/""). */
async function maintainerOf(
  r: ForgeRequest,
  s: SignedIn,
  space: Space,
  roles: Roles,
  repoRow: RepoRow | null,
): Promise<{ maintain: boolean; role: DiscussionRow["author_role"] }> {
  if (roles.moderator) return { maintain: true, role: "" };
  if (space.kind === "paper") {
    const author = roles.papers.has(space.paperId);
    return { maintain: author, role: author ? "verified_author" : "" };
  }
  if (space.kind === "repo") {
    const key = repoRow && repoRow.name ? communityRepoKey(space.forge || "github", repoRow.owner_login, repoRow.name) : "";
    const maintainer = !!key && roles.repos.has(key);
    const manages = !!repoRow && (repoRow.linked_by === s.user.id || (!!s.user.github_login && repoRow.owner_login === s.user.github_login.toLowerCase()));
    return { maintain: maintainer || manages, role: maintainer ? "maintainer" : "" };
  }
  // org: the owners and moderators maintain; any member writes as none.
  const org = await first<{ id: string }>(orgByHandle(r.db, space.handle));
  if (!org) return { maintain: false, role: "" };
  const m = await first<{ role: string }>(memberOf(r.db, org.id, s.user.id));
  return { maintain: m?.role === "owner" || m?.role === "moderator", role: "" };
}

/** A space's categories: the stored row's, or the kind's defaults (a space is made on its first
 *  discussion). */
async function categoriesOf(db: D1Database, space: Space): Promise<{ categories: Category[]; exists: boolean }> {
  const row = await first<{ categories: string }>(spaceByKey(db, space.key));
  if (row) return { categories: parseCategories(row.categories), exists: true };
  return { categories: [...DEFAULT_CATEGORIES[space.kind]], exists: false };
}

/** Whether the registry knows this space: a paper (any DOI), a repository it knows, an organization
 *  it has. */
async function knownSpace(r: ForgeRequest, space: Space, repoRow: RepoRow | null): Promise<ForgeProblem | null> {
  if (space.kind === "paper") return null;
  if (space.kind === "repo") {
    return repoRow ? null : new ForgeProblem(404, "unknown_repo", "The registry does not know this repository: link it first, or discuss its paper instead.");
  }
  const org = await first(orgByHandle(r.db, space.handle));
  return org ? null : new ForgeProblem(404, "unknown_org", "The registry has no organization of this handle.");
}

async function readPost(r: ForgeRequest): Promise<Record<string, unknown> | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return bad("The request is not JSON.");
  const text = await readCapped(r.request, DISCUSSION_BODY_BYTES);
  if (text === null) return new ForgeProblem(413, "too_large", "This is larger than a discussion may be (256 KiB of text).");
  try {
    const v = JSON.parse(text) as unknown;
    return isObject(v) ? v : bad("The request is not readable.");
  } catch {
    return bad("The request is not readable.");
  }
}

/** FORGE_OPEN, the caps, the day's rows: the problem, or the linked GitHub account's id for the row. */
async function mayDiscuss(r: ForgeRequest, s: SignedIn, kind: DiscussionRowKind, rows: number): Promise<ForgeProblem | { github: string }> {
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  const caps = await dailyCaps(r.db, s.user.id, kind, r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, Math.min(rows, FORGE_ROWS_PER_DAY))) ?? { github: github ?? "" };
}

/** The writes and their action row, in ONE batch; the batch's results. */
async function commit(r: ForgeRequest, s: SignedIn, kind: DiscussionRowKind, github: string, writes: Write[], repo: { forge: string; repoId: string } | null, nonce = newNonce(), subject = "") {
  const action = actionRow(r.db, {
    userId: s.user.id,
    t: r.t,
    nonce,
    kind,
    forge: repo?.forge ?? "",
    repoId: repo?.repoId ?? "",
    githubUser: github,
    outcome: "done",
    rows: 1 + rowsOf(writes),
    subject,
  });
  return r.db.batch([...statements(writes), action.stmt]);
}

const repoRef = (space: Space): { forge: string; repoId: string } | null => (space.kind === "repo" && space.repoId ? { forge: space.forge || "github", repoId: space.repoId } : null);
const spaceOf = (row: Pick<DiscussionRow, "space" | "space_kind" | "paper_id" | "forge" | "repo_id">): Space => ({
  key: row.space,
  kind: row.space_kind,
  paperId: row.paper_id,
  forge: (row.forge as Space["forge"]) || "",
  repoId: row.repo_id,
  handle: row.space.startsWith("org:") ? row.space.slice(4) : "",
});

// ─── the routes ──────────────────────────────────────────────────────────────

export async function handleDiscussionsRead(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const q = r.url.searchParams;
  const writes = mayWrite(r.env, await linkedGithub(s.db, s.user.id));
  const roles = await rolesOf(s.db, s.user.id);
  const owner = await isOwner(r, s);

  if (q.has("id")) {
    const id = Number(q.get("id"));
    if (!isId(id)) return problemAnswer(bad("A discussion is named by its number."));
    const row = await first<DiscussionRow>(discussionById(r.db, id));
    if (!row) return problemAnswer(new ForgeProblem(404, "not_found", "The registry has no discussion of this number."));
    const space = spaceOf(row);
    const repoRow = await repoOf(r.db, space);
    const { maintain } = await maintainerOf(r, s, space, roles, repoRow);
    const authorSuspended = await accountHidden(r.db, row.author_id);
    const hiddenForMe = (row.hidden !== "" || authorSuspended) && !owner && !maintain && row.author_id !== s.user.id;
    if (hiddenForMe) {
      return problemAnswer(new ForgeProblem(410, "moderated", `This discussion is hidden${row.hidden ? ` (${row.hidden})` : " (its author's account is suspended)"}.`));
    }
    const rows = await all<CommentRow>(commentsOf(r.db, id));
    const comments = rows.map((c) => {
      const view = { ...commentViewOf(c), mine: c.author_id === s.user.id };
      if (!c.hidden) return view;
      return owner || maintain || view.mine ? view : { ...view, body: "", moderated: c.hidden };
    });
    // The reader's own votes (one read of discussion_votes by the key range of this discussion).
    const myVotes = await all<{ ref: string; choice: number }>(
      r.db.prepare("SELECT ref, choice FROM discussion_votes WHERE user_id = ? AND (ref = ? OR ref = ? OR (ref > ? AND ref < ?))")
        .bind(s.user.id, String(id), `${id}poll`, `${id}#`, `${id}#:`),
    );
    return json({
      discussion: { ...viewOf(row), mine: row.author_id === s.user.id, ...(row.hidden ? { moderated: row.hidden } : {}) },
      comments,
      myVotes,
      can: { write: writes, comment: writes && (!row.locked || maintain), edit: writes && (maintain || row.author_id === s.user.id), maintain: writes && maintain, vote: writes },
    });
  }

  const spaceStr = q.get("space");
  const space = spaceStr === null ? null : readSpace(spaceStr);
  if (!space) return problemAnswer(bad("Name a space: a paper (paper:10.…), a repository (repo:github:…) or an organization (org:…)."));
  const repoRow = await repoOf(r.db, space);
  const { categories } = await categoriesOf(r.db, space);
  const { maintain } = await maintainerOf(r, s, space, roles, repoRow);
  const list = await all<Parameters<typeof summaryOf>[0] & { author_id: string; hidden: DiscussionRow["hidden"] }>(discussionsOfSpace(r.db, space.key));
  // A hidden discussion, or one of a suspended account, leaves the list (the owner, a maintainer and
  // the author still see their own). The suspended accounts among the authors in one read by key.
  const suspended = owner || maintain ? new Set<string>() : (await hiddenActors(r.db, list.map((x) => ({ user: x.author_id })))).users;
  const discussions = [];
  for (const row of list) {
    if ((row.hidden || suspended.has(row.author_id)) && !owner && !maintain && row.author_id !== s.user.id) continue;
    discussions.push(summaryOf(row));
  }
  // Pinned first, then newest.
  discussions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id);
  return json({ space: space.key, space_kind: space.kind, categories, discussions, can: { write: writes, maintain: writes && maintain } });
}

export async function handleDiscussionOpen(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const parsed = validateOpen(body);
  if (parsed instanceof ForgeProblem) return say(parsed);
  const human = await requireHuman(r, body.turnstile);
  if (human) return say(human);
  const space = parsed.space;
  const repoRow = await repoOf(r.db, space);
  const unknown = await knownSpace(r, space, repoRow);
  if (unknown) return say(unknown);
  const { categories, exists } = await categoriesOf(r.db, space);
  const category = categories.find((c) => c.slug === parsed.category);
  if (!category) return say(bad(`This space has no category “${parsed.category}”.`));
  const format: Format = category.format;
  const roles = await rolesOf(s.db, s.user.id);
  const { maintain, role } = await maintainerOf(r, s, space, roles, repoRow);
  if (format === "announcement" && !maintain) {
    return say(new ForgeProblem(403, "forbidden", "Only the space's maintainers post an announcement: the paper's verified authors, the code's maintainers, the organization's owners."));
  }
  let poll: Poll | null = null;
  if (format === "poll") {
    if (parsed.pollOptions.length < 2) return say(bad(`A poll has 2 to ${POLL_OPTIONS_MAX} options.`));
    poll = { options: parsed.pollOptions.map((text) => ({ text, votes: 0 })), closes_at: parsed.closesInDays ? Math.floor(r.t) + parsed.closesInDays * 86_400 : null, voters: 0 };
  } else if (parsed.pollOptions.length) {
    return say(bad("Only a poll category takes options."));
  }
  // The repository space's managers' blocks and interaction limits.
  if (repoRow) {
    const refused = await mayInteract(r, s, { repo: repoRow });
    if (refused) return say(refused);
  }
  const writes: Write[] = [];
  if (!exists) writes.push(upsertSpace(r.db, space, categories, s.user.id, r.t));
  writes.push(insertDiscussion(r.db, parsed, format, poll, personOf(s.user), role, r.t));
  const gate = await mayDiscuss(r, s, "discussion_open", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  const results = await commit(r, s, "discussion_open", gate.github, writes, repoRef(space), newNonce(), space.key.startsWith("paper:") ? `paper:${space.paperId}` : "");
  const id = Number(results[results.length - 2]?.meta?.last_row_id ?? results[0]?.meta?.last_row_id ?? 0);
  return json({ id, page: `/discussions/${id}`, sentence: `Open the discussion “${parsed.title}”` }, 201, s.cookies);
}

export async function handleDiscussionComment(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateComment(body);
  if (p instanceof ForgeProblem) return say(p);
  if (p.n === null) {
    const human = await requireHuman(r, body.turnstile);
    if (human) return say(human);
  }
  const d = await first<DiscussionRow>(discussionById(r.db, p.id));
  if (!d) return say(new ForgeProblem(404, "not_found", "The registry has no discussion of this number."));
  const space = spaceOf(d);
  const repoRow = await repoOf(r.db, space);
  const roles = await rolesOf(s.db, s.user.id);
  const { maintain } = await maintainerOf(r, s, space, roles, repoRow);
  const owner = await isOwner(r, s);
  if (d.hidden && !owner && !maintain && d.author_id !== s.user.id) return say(new ForgeProblem(410, "moderated", "This discussion is hidden."));
  let writes: Write[];
  let created = false;
  if (p.n === null) {
    if (d.locked && !maintain) return say(new ForgeProblem(403, "locked", "The conversation is locked: only the space's maintainers comment now."));
    const refused = await mayInteract(r, s, { repo: repoRow, also: [d.author_id] });
    if (refused) return say(refused);
    if (d.comments >= DISCUSSION_COMMENTS) return say(new ForgeProblem(409, "full", `The discussion holds ${DISCUSSION_COMMENTS.toLocaleString("en-GB")} comments, the most one may.`));
    if (p.replyTo && p.replyTo > d.comments) return say(bad("The comment you reply to is not there."));
    writes = insertComment(r.db, p.id, p.body ?? "", p.replyTo, personOf(s.user), (await maintainerOf(r, s, space, roles, repoRow)).role, r.t);
    created = true;
  } else {
    const c = await first<CommentRow>(r.db.prepare("SELECT * FROM discussion_comments WHERE discussion_id = ? AND n = ?").bind(p.id, p.n));
    if (!c || c.deleted) return say(new ForgeProblem(404, "not_found", "This comment is not there (deleted, or never written)."));
    const mine = c.author_id === s.user.id;
    if (p.hide !== null) {
      if (!maintain) return say(new ForgeProblem(403, "forbidden", "Hiding a comment is for the space's maintainers."));
      writes = [updateComment(r.db, p.id, p.n, { hidden: p.hide })];
    } else if (p.delete) {
      if (!mine && !maintain) return say(new ForgeProblem(403, "forbidden", "Only its author and the space's maintainers delete a comment."));
      writes = [updateComment(r.db, p.id, p.n, { body: "", deleted: 1, edited_at: Math.floor(r.t) })];
    } else {
      if (!mine) return say(new ForgeProblem(403, "forbidden", "Only its author edits a comment."));
      writes = [updateComment(r.db, p.id, p.n, { body: p.body ?? "", edited_at: Math.floor(r.t) })];
    }
  }
  const gate = await mayDiscuss(r, s, "discussion_comment", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "discussion_comment", gate.github, writes, repoRef(space), newNonce(), created && space.kind === "paper" ? `paper:${space.paperId}` : "");
  return json({ id: p.id, page: `/discussions/${p.id}` }, created ? 201 : 200, s.cookies);
}

export async function handleDiscussionVote(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateVote(body);
  if (p instanceof ForgeProblem) return say(p);
  const d = await first<DiscussionRow>(discussionById(r.db, p.id));
  if (!d) return say(new ForgeProblem(404, "not_found", "The registry has no discussion of this number."));
  const space = spaceOf(d);
  const repoRow = await repoOf(r.db, space);
  const owner = await isOwner(r, s);
  const roles = await rolesOf(s.db, s.user.id);
  const { maintain } = await maintainerOf(r, s, space, roles, repoRow);
  if (d.hidden && !owner && !maintain) return say(new ForgeProblem(410, "moderated", "This discussion is hidden."));
  const refused = await mayInteract(r, s, { repo: repoRow, also: [d.author_id] });
  if (refused) return say(refused);

  const poll = p.option !== null;
  if (poll) {
    if (d.format !== "poll") return say(bad("This discussion is not a poll."));
    const current: Poll | null = viewOf(d).poll;
    if (!current || p.option! >= current.options.length) return say(bad("The poll has no such option."));
    if (current.closes_at && Math.floor(r.t) > current.closes_at) return say(new ForgeProblem(409, "closed", "This poll is closed."));
  }
  if (p.n !== null) {
    const c = await first<CommentRow>(r.db.prepare("SELECT discussion_id, n, deleted FROM discussion_comments WHERE discussion_id = ? AND n = ?").bind(p.id, p.n));
    if (!c || c.deleted) return say(new ForgeProblem(404, "not_found", "This comment is not there."));
  }
  const ref = voteRef(p.id, p.n, poll);
  const existing = await first<{ choice: number }>(voteRow(r.db, ref, s.user.id));
  const writes: Write[] = [];
  if (p.remove) {
    if (!existing) return json({ id: p.id, page: `/discussions/${p.id}`, unchanged: true }, 200, s.cookies);
    writes.push(deleteVote(r.db, ref, s.user.id));
    if (poll) {
      const pl = viewOf(d).poll!;
      pl.options[existing.choice] && (pl.options[existing.choice].votes = Math.max(0, pl.options[existing.choice].votes - 1));
      pl.voters = Math.max(0, pl.voters - 1);
      writes.push(setPoll(r.db, p.id, pl, r.t));
    } else if (p.n === null) writes.push(bumpUpvotes(r.db, p.id, -1, r.t));
    else writes.push(bumpCommentUpvotes(r.db, p.id, p.n, -1));
  } else {
    if (existing && (!poll || existing.choice === p.option)) return json({ id: p.id, page: `/discussions/${p.id}`, unchanged: true }, 200, s.cookies);
    if (existing && poll) {
      // Change of poll choice: move the vote.
      writes.push(updateVoteChoice(r.db, ref, s.user.id, p.option!, r.t));
      const pl = viewOf(d).poll!;
      pl.options[existing.choice] && (pl.options[existing.choice].votes = Math.max(0, pl.options[existing.choice].votes - 1));
      if (pl.options[p.option!]) pl.options[p.option!].votes += 1;
      writes.push(setPoll(r.db, p.id, pl, r.t));
    } else {
      writes.push(insertVote(r.db, ref, s.user.id, poll ? p.option! : 0, r.t));
      if (poll) {
        const pl = viewOf(d).poll!;
        if (pl.options[p.option!]) pl.options[p.option!].votes += 1;
        pl.voters += 1;
        writes.push(setPoll(r.db, p.id, pl, r.t));
      } else if (p.n === null) writes.push(bumpUpvotes(r.db, p.id, 1, r.t));
      else writes.push(bumpCommentUpvotes(r.db, p.id, p.n, 1));
    }
  }
  const gate = await mayDiscuss(r, s, "discussion_vote", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "discussion_vote", gate.github, writes, repoRef(space));
  return json({ id: p.id, page: `/discussions/${p.id}` }, 200, s.cookies);
}

function updateVoteChoice(db: D1Database, ref: string, userId: string, choice: number, t: number): Write {
  return { rows: 1, stmt: db.prepare("UPDATE discussion_votes SET choice = ?, at = ? WHERE ref = ? AND user_id = ?").bind(choice, Math.floor(t), ref, userId) };
}

export async function handleDiscussionEdit(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateEdit(body);
  if (p instanceof ForgeProblem) return say(p);
  const d = await first<DiscussionRow>(discussionById(r.db, p.id));
  if (!d) return say(new ForgeProblem(404, "not_found", "The registry has no discussion of this number."));
  const space = spaceOf(d);
  const repoRow = await repoOf(r.db, space);
  const roles = await rolesOf(s.db, s.user.id);
  const { maintain } = await maintainerOf(r, s, space, roles, repoRow);
  const owner = await isOwner(r, s);
  if (d.hidden && !owner && !maintain) return say(new ForgeProblem(410, "moderated", "This discussion is hidden."));
  const mine = d.author_id === s.user.id;
  if (!maintain && !mine) return say(new ForgeProblem(403, "forbidden", "Only the discussion's author and the space's maintainers change it."));
  if (!maintain && (p.labels || p.locked !== null || p.pinned !== null || p.answered !== null || p.transferTo || p.category)) {
    return say(new ForgeProblem(403, "forbidden", "The category, the answer, labels, locks, pins and transfers are for the space's maintainers."));
  }
  const by = personOf(s.user).author;
  const at = Math.floor(r.t);
  const set: Record<string, string | number | null> = {};
  const events: TimelineEvent[] = [];
  if (p.title !== null && p.title !== d.title) {
    set.title = p.title;
    events.push({ k: "renamed", by, at, s: d.title });
  }
  if (p.body !== null && p.body !== d.body) {
    set.body = clean(p.body);
    events.push({ k: "edited", by, at });
  }
  if (p.category !== null && p.category !== d.category) {
    const { categories } = await categoriesOf(r.db, space);
    const cat = categories.find((c) => c.slug === p.category);
    if (!cat) return say(bad(`This space has no category “${p.category}”.`));
    if (cat.format !== d.format) return say(bad("A discussion moves only between categories of the same format."));
    set.category = p.category;
    events.push({ k: "recategorized", by, at, s: p.category });
  }
  if (p.answered !== null) {
    if (d.format !== "qa") return say(bad("Only a question has an answer to mark."));
    if (p.answered !== 0) {
      const c = await first<{ deleted: number }>(r.db.prepare("SELECT deleted FROM discussion_comments WHERE discussion_id = ? AND n = ?").bind(p.id, p.answered));
      if (!c || c.deleted) return say(bad("The comment you mark as the answer is not there."));
    }
    set.answered = p.answered === 0 ? null : p.answered;
    events.push({ k: p.answered === 0 ? "unanswered" : "answered", by, at, s: p.answered === 0 ? undefined : `#${p.answered}` });
  }
  if (p.state === "closed") {
    Object.assign(set, { state: "closed", close_reason: p.reason ?? "resolved", closed_at: at });
    events.push({ k: "closed", by, at, s: p.reason ?? "resolved" });
  } else if (p.state === "open" && d.state === "closed") {
    Object.assign(set, { state: "open", close_reason: "", closed_at: null });
    events.push({ k: "reopened", by, at });
  }
  if (p.labels) {
    const have = parseList(d.labels);
    const drop = new Set(p.labels.remove.map((x) => x.toLowerCase()));
    const next = have.filter((x) => !drop.has(x.toLowerCase()));
    for (const a of p.labels.add) if (!next.some((x) => x.toLowerCase() === a.toLowerCase())) next.push(a);
    set.labels = JSON.stringify(next);
    for (const a of next.filter((x) => !have.includes(x))) events.push({ k: "labeled", by, at, s: a });
    for (const x of have.filter((x) => !next.includes(x))) events.push({ k: "unlabeled", by, at, s: x });
  }
  if (p.locked !== null && p.locked !== (d.locked === 1)) {
    Object.assign(set, { locked: p.locked ? 1 : 0, lock_reason: p.locked ? p.lockReason : "" });
    events.push({ k: p.locked ? "locked" : "unlocked", by, at, s: p.locked ? p.lockReason || undefined : undefined });
  }
  if (p.pinned !== null && p.pinned !== (d.pinned === 1)) {
    set.pinned = p.pinned ? 1 : 0;
    events.push({ k: p.pinned ? "pinned" : "unpinned", by, at });
  }
  let transferRepo: { forge: string; repoId: string } | null = repoRef(space);
  if (p.transferTo && p.transferTo.key !== d.space) {
    const toRepo = await repoOf(r.db, p.transferTo);
    const unknown = await knownSpace(r, p.transferTo, toRepo);
    if (unknown) return say(unknown);
    const toMaintain = (await maintainerOf(r, s, p.transferTo, roles, toRepo)).maintain;
    if (!toMaintain) return say(new ForgeProblem(403, "forbidden", "You maintain neither space: a transfer needs the maintain role on both."));
    const { categories, exists } = await categoriesOf(r.db, p.transferTo);
    if (!categories.some((c) => c.slug === "general" && c.format === d.format)) {
      return say(bad("The other space has no “general” category of this discussion's format."));
    }
    if (!exists) await r.db.batch([upsertSpace(r.db, p.transferTo, categories, s.user.id, r.t).stmt]);
    Object.assign(set, { space: p.transferTo.key, space_kind: p.transferTo.kind, paper_id: p.transferTo.paperId, forge: p.transferTo.forge, repo_id: p.transferTo.repoId, category: "general" });
    events.push({ k: "transferred", by, at, s: p.transferTo.key });
    transferRepo = repoRef(p.transferTo);
  }
  if (!Object.keys(set).length) return json({ id: p.id, page: `/discussions/${p.id}`, unchanged: true }, 200, s.cookies);
  const writes = [updateDiscussion(r.db, p.id, set, events, r.t)];
  const gate = await mayDiscuss(r, s, "discussion_edit", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "discussion_edit", gate.github, writes, transferRepo);
  return json({ id: p.id, page: `/discussions/${p.id}` }, 200, s.cookies);
}

const parseList = (text: unknown): string[] => {
  try {
    const v = JSON.parse(String(text));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
