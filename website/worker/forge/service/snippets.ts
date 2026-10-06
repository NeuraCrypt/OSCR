// The native routes of snippets (night phase 13; snippets-core.ts, docs/SNIPPETS.md). A snippet's
// FILES and revisions are authorized commits (act-snippet.ts: snippet_create, snippet_revise,
// snippet_fork, through /api/forge/start and /api/forge/act). These routes are the record's own
// native writes, the discussions/research model: read a snippet, discover and list, edit the record,
// comment, star. Each write is logged in `actions` so the caps count it (gate.ts, caps.ts `snippets`);
// nothing here is written on GitHub.
//
//   GET  /api/forge/snippets          ?id=<n> | ?owner=<login>&folder=<slug> | ?owner=<login> | discover
//   POST /api/forge/snippets/edit     title, description, make public, comments on/off, paper passage, hide
//   POST /api/forge/snippets/comment  a comment; its edit (with history), deletion or hiding
//   POST /api/forge/snippets/star     star or unstar
//
// Unlisted snippets are reachable by id or handle (a direct link) but never in discover, search, feeds,
// the public API or the sitemap (D13-*). Public free text: Turnstile on a new comment, the per-account
// caps, the blocks and interaction limits (mayInteract), email masking (the core's clean), triagers'
// hide/delete through the rows' own columns. Like every browser-facing route, it never names the platform.

import type { SignedIn } from "../../account/guard.ts";
import { who as whoAsks } from "./who.ts";
import { isOwner } from "./moderation.ts";
import { mayInteract } from "./blocks.ts";
import { requireHuman } from "./turnstile.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { readCapped } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { LOGIN } from "../paths.ts";
import {
  SNIPPET_BODY_BYTES,
  SNIPPET_COMMENTS,
  bumpStars,
  clean,
  commentViewOf,
  deleteStar,
  insertSnippetComment,
  insertStar,
  passageOf,
  personOf,
  publicSnippets,
  pushHistory,
  snippetById,
  snippetByHandle,
  snippetCommentsOf,
  snippetsOfOwner,
  starRow,
  stargazersOf,
  updateSnippet,
  updateSnippetComment,
  validateComment,
  validateEdit,
  viewOf,
  type EditParsed,
  type SnippetCommentRow,
  type SnippetRow,
} from "./snippets-core.ts";
import { actionRow, all, first, newNonce, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type ForgeRequest, type SnippetRowKind, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;
const LIST_MAX = 100;

async function readPost(r: ForgeRequest): Promise<Record<string, unknown> | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return bad("The request is not JSON.");
  const text = await readCapped(r.request, SNIPPET_BODY_BYTES);
  if (text === null) return new ForgeProblem(413, "too_large", "This is larger than a snippet's comment may be.");
  try {
    const v = JSON.parse(text) as unknown;
    return isObject(v) ? v : bad("The request is not readable.");
  } catch {
    return bad("The request is not readable.");
  }
}

/** Who may write (FORGE_OPEN), the caps, the day's rows: the problem, or the linked GitHub id. */
async function mayWriteSnippet(r: ForgeRequest, s: SignedIn, kind: SnippetRowKind, rows: number): Promise<ForgeProblem | { github: string }> {
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  const caps = await dailyCaps(r.db, s.user.id, kind, r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, Math.min(rows, FORGE_ROWS_PER_DAY))) ?? { github: github ?? "" };
}

/** The writes and their action row, in ONE batch. */
async function commit(r: ForgeRequest, s: SignedIn, kind: SnippetRowKind, github: string, writes: Write[], repo: { forge: string; repoId: string } | null, subject = "") {
  const action = actionRow(r.db, {
    userId: s.user.id, t: r.t, nonce: newNonce(), kind, forge: repo?.forge ?? "", repoId: repo?.repoId ?? "", githubUser: github, outcome: "done", rows: 1 + rowsOf(writes), subject,
  });
  return r.db.batch([...statements(writes), action.stmt]);
}

/** Whoever triages a snippet: its owner (the person whose `snippets` repository it is), or a
 *  moderator of the registry. */
async function triages(r: ForgeRequest, s: SignedIn, row: SnippetRow): Promise<boolean> {
  return row.owner_id === s.user.id || (await isOwner(r, s));
}

// ─── read ──────────────────────────────────────────────────────────────────────

export async function handleSnippetsRead(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const q = r.url.searchParams;
  const write = mayWrite(r.env, await linkedGithub(s.db, s.user.id));

  // One snippet, by id or by its handle (owner/folder): a direct link reaches an unlisted one too.
  if (q.has("id") || (q.has("owner") && q.has("folder"))) {
    let row: SnippetRow | null;
    if (q.has("id")) {
      const id = Number(q.get("id"));
      if (!isId(id)) return problemAnswer(bad("A snippet is named by its number."));
      row = await first<SnippetRow>(snippetById(r.db, id));
    } else {
      const owner = (q.get("owner") ?? "").toLowerCase();
      const folder = (q.get("folder") ?? "").toLowerCase();
      if (!LOGIN.test(owner) || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(folder)) return problemAnswer(bad("The snippet is named by its owner and folder."));
      row = await first<SnippetRow>(snippetByHandle(r.db, owner, folder));
    }
    if (!row) return problemAnswer(new ForgeProblem(404, "not_found", "The registry has no snippet of this name."));
    const owner = await isOwner(r, s);
    const mine = row.owner_id === s.user.id;
    if (row.hidden && !owner && !mine) {
      return problemAnswer(new ForgeProblem(410, "moderated", `This snippet is hidden (${row.hidden}).`, { moderation: { reason: row.hidden } }));
    }
    const [rows, starred, gazers] = await Promise.all([
      all<SnippetCommentRow>(snippetCommentsOf(r.db, row.id)),
      first(starRow(r.db, row.id, s.user.id)),
      all<{ starrer: string; starrer_via: string; at: number }>(stargazersOf(r.db, row.id, 100)),
    ]);
    const comments = rows.map((c) => {
      const view = { ...commentViewOf(c), mine: c.author_id === s.user.id };
      if (!c.hidden) return view;
      // A hidden comment keeps its text only for its author and the triagers.
      return owner || view.mine ? view : { ...view, body: "" };
    });
    const triage = await triages(r, s, row);
    return json({
      snippet: { ...viewOf(row), mine },
      comments,
      stargazers: gazers,
      starred: !!starred,
      can: {
        write,
        comment: write && row.comments_off !== 1 && !row.hidden,
        edit: write && mine,
        star: write && !row.hidden,
        fork: write && !row.hidden && !mine,
        triage: write && triage,
      },
    });
  }

  // A person's snippets (their page): public ones, and the reader's own unlisted ones too.
  if (q.has("owner")) {
    const owner = (q.get("owner") ?? "").toLowerCase();
    if (!LOGIN.test(owner)) return problemAnswer(bad("The owner is a GitHub login."));
    const mineLogin = (s.user.github_login ?? "").toLowerCase();
    const rows = await all<SnippetRow>(snippetsOfOwner(r.db, owner, LIST_MAX));
    const list = rows
      .filter((row) => !row.hidden && (row.visibility === "public" || owner === mineLogin))
      .map((row) => summaryOf(row))
      .sort((a, b) => b.updated_at - a.updated_at);
    return json({ owner, snippets: list, can: { write } });
  }

  // Discover: public snippets, newest first (unlisted never here; hidden dropped). A cursor by id.
  const before = Number(q.get("before") ?? "") || 2 ** 31;
  if (!Number.isInteger(before) || before < 1) return problemAnswer(bad("The cursor is a number."));
  const rows = await all<SnippetRow>(publicSnippets(r.db, before, LIST_MAX));
  const shown = rows.filter((row) => !row.hidden).map((row) => summaryOf(row));
  const next = rows.length === LIST_MAX ? rows[rows.length - 1].id : null;
  return json({ snippets: shown, next, can: { write } });
}

interface SnippetSummary {
  id: number;
  owner: string;
  folder: string;
  title: string;
  visibility: SnippetRow["visibility"];
  files: number;
  languages: string[];
  stars: number;
  comments: number;
  forks: number;
  paper: boolean;
  author: string;
  author_via: SnippetRow["author_via"];
  author_role: SnippetRow["author_role"];
  updated_at: number;
}

function summaryOf(row: SnippetRow): SnippetSummary {
  const v = viewOf(row);
  return {
    id: v.id, owner: v.owner, folder: v.folder, title: v.title, visibility: v.visibility, files: v.files.length,
    languages: [...new Set(v.files.map((f) => f.language).filter(Boolean))].slice(0, 6),
    stars: v.stars, comments: v.comments, forks: v.forks, paper: !!v.passage, author: v.author, author_via: v.author_via,
    author_role: v.author_role, updated_at: v.updated_at,
  };
}

// ─── edit the record ─────────────────────────────────────────────────────────────

export async function handleSnippetEdit(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateEdit(body);
  if (p instanceof ForgeProblem) return say(p);
  const row = await first<SnippetRow>(snippetById(r.db, p.id));
  if (!row) return say(new ForgeProblem(404, "not_found", "The registry has no snippet of this number."));
  const mine = row.owner_id === s.user.id;
  const triage = await triages(r, s, row);
  // Hiding is a triager's; everything else is the owner's.
  if (p.hide !== null && !triage) return say(new ForgeProblem(403, "forbidden", "Hiding a snippet is for its owner and the registry's moderators."));
  if (p.hide === null && !mine) return say(new ForgeProblem(403, "forbidden", "Only the snippet's owner changes it."));
  const set = editSet(p, row);
  if (!Object.keys(set).length) return json({ id: p.id, unchanged: true }, 200, s.cookies);
  const gate = await mayWriteSnippet(r, s, "snippet_edit", 2);
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "snippet_edit", gate.github, [updateSnippet(r.db, p.id, set, r.t)], { forge: row.forge, repoId: row.repo_id });
  return json({ id: p.id, page: `/snippet/${row.owner_login}/${row.folder}/` }, 200, s.cookies);
}

function editSet(p: EditParsed, row: SnippetRow): Record<string, string | number | null> {
  const set: Record<string, string | number | null> = {};
  if (p.title !== null && p.title !== row.title) set.title = p.title;
  if (p.description !== null && p.description !== row.description) set.description = p.description;
  // Unlisted to public, never back (D13-*): validateEdit already refused "unlisted".
  if (p.makePublic && row.visibility === "unlisted") set.visibility = "public";
  if (p.commentsOff !== null && (p.commentsOff ? 1 : 0) !== row.comments_off) set.comments_off = p.commentsOff ? 1 : 0;
  if (p.passage !== null) {
    Object.assign(set, { paper_id: p.passage.paperId, section: p.passage.section, paragraph: p.passage.paragraph, start_line: p.passage.startLine, end_line: p.passage.endLine });
  }
  if (p.hide !== null && p.hide !== row.hidden) set.hidden = p.hide;
  return set;
}

// ─── comment ─────────────────────────────────────────────────────────────────────

export async function handleSnippetComment(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateComment(body);
  if (p instanceof ForgeProblem) return say(p);
  // A new comment passes the human check (an edit, a deletion, a hide need not).
  if (p.n === null) {
    const human = await requireHuman(r, body.turnstile);
    if (human) return say(human);
  }
  const row = await first<SnippetRow>(snippetById(r.db, p.id));
  if (!row) return say(new ForgeProblem(404, "not_found", "The registry has no snippet of this number."));
  if (row.hidden && !(await isOwner(r, s))) return say(new ForgeProblem(410, "moderated", `This snippet is hidden (${row.hidden}).`));
  const triage = await triages(r, s, row);
  const who = personOf(s.user);
  let writes: Write[];
  let created = false;
  if (p.n === null) {
    if (row.comments_off === 1 && !triage) return say(new ForgeProblem(403, "comments_off", "Comments are turned off on this snippet."));
    // The snippet owner's blocks and interaction limits.
    const refused = await mayInteract(r, s, { repo: null, also: [row.owner_id] });
    if (refused) return say(refused);
    if (row.comments >= SNIPPET_COMMENTS) return say(new ForgeProblem(409, "full", `The snippet holds ${SNIPPET_COMMENTS.toLocaleString("en-GB")} comments, the most one may.`));
    writes = insertSnippetComment(r.db, p.id, p.body ?? "", p.replyTo, who, triage && row.owner_id === s.user.id ? row.author_role : "", r.t);
    created = true;
  } else {
    const c = await first<SnippetCommentRow>(r.db.prepare("SELECT * FROM snippet_comments WHERE snippet_id = ? AND n = ?").bind(p.id, p.n));
    if (!c || c.deleted) return say(new ForgeProblem(404, "not_found", "This comment is not there (deleted, or never written)."));
    const own = c.author_id === s.user.id;
    if (p.hide !== null) {
      if (!triage) return say(new ForgeProblem(403, "forbidden", "Hiding a comment is for the snippet's owner and the registry's moderators."));
      writes = [updateSnippetComment(r.db, p.id, p.n, { hidden: p.hide })];
    } else if (p.delete) {
      if (!own && !triage) return say(new ForgeProblem(403, "forbidden", "Only its author, the snippet's owner and the registry's moderators delete a comment."));
      writes = [updateSnippetComment(r.db, p.id, p.n, { body: "", deleted: 1, edited_at: Math.floor(r.t) })];
    } else {
      if (!own) return say(new ForgeProblem(403, "forbidden", "Only its author edits a comment."));
      writes = [updateSnippetComment(r.db, p.id, p.n, { body: p.body ?? "", history: pushHistory(c.history, c.body, r.t), edited_at: Math.floor(r.t) })];
    }
  }
  const gate = await mayWriteSnippet(r, s, "snippet_comment", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "snippet_comment", gate.github, writes, { forge: row.forge, repoId: row.repo_id });
  return json({ id: p.id, created, page: `/snippet/${row.owner_login}/${row.folder}/` }, created ? 201 : 200, s.cookies);
}

// ─── star ──────────────────────────────────────────────────────────────────────

export async function handleSnippetStar(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  if (!isId(body.id)) return say(bad("Name the snippet by its number."));
  const on = body.on !== false;
  const row = await first<SnippetRow>(snippetById(r.db, body.id));
  if (!row) return say(new ForgeProblem(404, "not_found", "The registry has no snippet of this number."));
  if (row.hidden) return say(new ForgeProblem(410, "moderated", `This snippet is hidden (${row.hidden}).`));
  const already = await first(starRow(r.db, row.id, s.user.id));
  if (on === !!already) return json({ id: row.id, starred: on, stars: row.stars }, 200, s.cookies);
  const who = personOf(s.user);
  const writes: Write[] = on ? [insertStar(r.db, row.id, who, r.t), bumpStars(r.db, row.id, 1, r.t)] : [deleteStar(r.db, row.id, s.user.id), bumpStars(r.db, row.id, -1, r.t)];
  const gate = await mayWriteSnippet(r, s, "snippet_star", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "snippet_star", gate.github, writes, { forge: row.forge, repoId: row.repo_id }, `snippet:${row.id}`);
  return json({ id: row.id, starred: on, stars: Math.max(0, row.stars + (on ? 1 : -1)) }, 200, s.cookies);
}

export { passageOf };
