// The routes of the registry's social layer (night phase 08, E1): stars, star lists, follows and watch
// levels, profiles. What they are and their rows: social-core.ts; the contract: docs/SOCIAL.md.
//
//   GET  /api/forge/social?s=…            signed in  the reader's star, lists and follow of ≤ 20 subjects or targets
//   GET  /api/forge/social/mine           signed in  the reader's stars, lists, follows and profile
//   GET  /api/forge/social/person         signed in  a person's public profile (?github=<id> or ?orcid=<iD>)
//   POST /api/forge/social/star           signed in  star or unstar (2 rows; unstar also its list entries)
//   POST /api/forge/social/follow         signed in  follow, watch at a level, or stop (2 rows)
//   POST /api/forge/social/list           signed in  a star list: create, edit, delete, add, remove, propose
//   POST /api/forge/social/profile        signed in  the reader's profile (2 rows)
//
// Every write: signed in, the Origin and the CSRF token checked (account/guard.ts `signedIn`), then
// FORGE_OPEN (gate.ts: until phase 16, only the owner writes), the account's `social` cap (300 a day,
// out of the 100 authorized actions), the day's rows (5,000), then ONE batch with its action row (kind
// `star`, `star_list`, `follow`, `profile`; its `subject` says what). A write that changes nothing
// writes nothing. No answer names an account's id; a private profile's stars, lists and follows are
// the person's own.

import type { SignedIn } from "../../account/guard.ts";
import { who } from "./who.ts";
import { identityOwner, userById } from "../../account/store.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { readCapped } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { accountHidden, hiddenAmong, hiddenOne, moderationView } from "./hidden.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import {
  FOLLOWS_MAX,
  followCount,
  followsAmong,
  followsOf,
  followWrite,
  freeListId,
  itemsAmong,
  itemsOf,
  LIST_ITEMS_MAX,
  listDeleteWrites,
  listInsert,
  listItemWrite,
  listsOf,
  listUpdate,
  listView,
  profileOf,
  profileView,
  profileWrite,
  readSubject,
  readTarget,
  SOCIAL_BODY_BYTES,
  STARS_MAX,
  starCount,
  starsAmong,
  starsOf,
  starWrite,
  STATE_SUBJECTS,
  subjectKind,
  unfollowWrite,
  unstarWrites,
  validateFollow,
  validateList,
  validateProfile,
  validateStar,
  type FollowRow,
  type ItemRow,
  type ListRow,
  type ProfileRow,
  type StarRow,
} from "./social-core.ts";
import { actionRow, all, first, newNonce, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type ForgeRequest, type SocialKind, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

async function readPost(r: ForgeRequest): Promise<unknown | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return bad("The request is not JSON.");
  const text = await readCapped(r.request, SOCIAL_BODY_BYTES);
  if (text === null) return new ForgeProblem(413, "too_large", "This request is larger than the registry reads (16 KiB).");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return bad("The request is not readable.");
  }
}

/** Who may write (FORGE_OPEN), the account's cap for this kind, the day's rows: the problem, or the
 *  linked GitHub account's id ("" without one) for the action row. */
export async function maySocial(r: ForgeRequest, s: SignedIn, kind: SocialKind, rows: number): Promise<ForgeProblem | { github: string }> {
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  const caps = await dailyCaps(r.db, s.user.id, kind, r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, Math.min(rows, FORGE_ROWS_PER_DAY))) ?? { github: github ?? "" };
}

/** The writes and their action row, in ONE batch. The action row names the subject, and a
 *  repository's forge and id when the subject is one (a person's activity reads it). */
export async function socialCommit(r: ForgeRequest, s: SignedIn, kind: SocialKind, github: string, writes: Write[], subject: string) {
  const repo = /^repo:(github|memory):([0-9]+)$/.exec(subject);
  const action = actionRow(r.db, {
    userId: s.user.id,
    t: r.t,
    nonce: newNonce(),
    kind,
    forge: repo?.[1] ?? "",
    repoId: repo?.[2] ?? "",
    githubUser: github,
    outcome: "done",
    rows: 1 + rowsOf(writes),
    subject,
  });
  await r.db.batch([...statements(writes), action.stmt]);
  return 1 + rowsOf(writes);
}

const unchanged = (s: SignedIn, extra: Record<string, unknown> = {}) => json({ ok: true, unchanged: true, written: 0, ...extra }, 200, s.cookies);
const done = (s: SignedIn, written: number, extra: Record<string, unknown> = {}) => json({ ok: true, written, ...extra }, 200, s.cookies);

// ─── reads ───────────────────────────────────────────────────────────────────

/** GET /api/forge/social?s=<subject or target>&s=…: what the reader's buttons show. */
export async function handleSocialState(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const asked = [...new Set(r.url.searchParams.getAll("s"))];
  if (asked.length > STATE_SUBJECTS) return problemAnswer(bad(`A page asks about ${STATE_SUBJECTS} subjects at most.`));
  const subjects: string[] = [];
  const targets: string[] = [];
  for (const a of asked) {
    const subject = readSubject(a);
    const target = readTarget(a);
    if (!subject && !target) return problemAnswer(bad(`“${a.slice(0, 80)}” is neither a subject nor a target.`));
    if (subject) subjects.push(subject);
    if (target && !targets.includes(target)) targets.push(target);
  }
  const [stars, items, follows, lists] = await Promise.all([
    subjects.length ? all<StarRow>(starsAmong(r.db, s.user.id, subjects)) : Promise.resolve([]),
    subjects.length ? all<ItemRow>(itemsAmong(r.db, s.user.id, subjects)) : Promise.resolve([]),
    targets.length ? all<FollowRow>(followsAmong(r.db, s.user.id, targets)) : Promise.resolve([]),
    all<ListRow>(listsOf(r.db, s.user.id)),
  ]);
  const out: Record<string, unknown> = {};
  for (const a of asked) {
    const subject = readSubject(a);
    const target = readTarget(a);
    const f = target ? follows.find((x) => x.target === target) : undefined;
    out[a] = {
      starred: subject ? stars.some((x) => x.subject === subject) : false,
      lists: subject ? items.filter((i) => i.subject === subject).map((i) => i.list_id) : [],
      follow: f ? { level: f.level, events: f.events ? f.events.split(" ") : [], auto: f.auto === 1 } : null,
    };
  }
  const writes = mayWrite(r.env, await linkedGithub(s.db, s.user.id));
  return json({ subjects: out, lists: lists.map((l) => ({ id: l.list_id, name: l.name, public: l.public === 1 })), can: { write: writes } });
}

/** GET /api/forge/social/mine: the reader's own stars, lists (private ones included), follows,
 *  profile, and what the day's caps leave. */
export async function handleSocialMine(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const [stars, lists, items, follows, profile, caps] = await Promise.all([
    all<StarRow>(starsOf(r.db, s.user.id)),
    all<ListRow>(listsOf(r.db, s.user.id)),
    all<ItemRow>(itemsOf(r.db, s.user.id)),
    all<FollowRow>(followsOf(r.db, s.user.id)),
    first<ProfileRow>(profileOf(r.db, s.user.id)),
    dailyCaps(r.db, s.user.id, "star", r.t),
  ]);
  const writes = mayWrite(r.env, await linkedGithub(s.db, s.user.id));
  return json({
    stars: stars.sort((a, b) => b.at - a.at).map((x) => ({ subject: x.subject, kind: subjectKind(x.subject), label: x.label, at: x.at })),
    lists: lists.sort((a, b) => a.list_id - b.list_id).map((l) => listView(l, items)),
    follows: follows.sort((a, b) => b.at - a.at).map((f) => ({ target: f.target, level: f.level, events: f.events ? f.events.split(" ") : [], label: f.label, auto: f.auto === 1, at: f.at })),
    profile: profileView(profile, r.t),
    handles: { github: s.user.github_login ?? null, orcid: s.user.orcid ?? null },
    caps: { social: { used: caps.used.social, limit: caps.limits.social }, stars: STARS_MAX, follows: FOLLOWS_MAX, listItems: LIST_ITEMS_MAX },
    can: { write: writes },
  });
}

/** GET /api/forge/social/person?github=<numeric id> | ?orcid=<iD>: a person's public profile, their
 *  public lists, stars and follows (none when their profile is private and the reader is someone
 *  else), and whether the reader follows them. A catalogue author without an account answers
 *  `account: false`, and can still be followed by ORCID iD. */
export async function handleSocialPerson(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const q = r.url.searchParams;
  const github = q.get("github");
  const orcidTarget = q.has("orcid") ? readTarget(`orcid:${q.get("orcid") ?? ""}`) : null;
  if ((github === null) === !q.has("orcid") || (github !== null && !/^[0-9]{1,20}$/.test(github)) || (q.has("orcid") && !orcidTarget)) {
    return problemAnswer(bad("A person is named by their GitHub account's number (?github=) or their ORCID iD (?orcid=)."));
  }
  const provider = github !== null ? "github" : "orcid";
  const subject = github ?? orcidTarget!.slice(6);
  const userId = await identityOwner(s.db, provider, subject);
  const writes = mayWrite(r.env, await linkedGithub(s.db, s.user.id));
  const user = userId ? await userById(s.db, userId) : null;
  // The targets the reader may follow this person by: their GitHub account, their ORCID iD.
  const githubId = github ?? (user ? await linkedGithub(s.db, user.id) : null);
  const orcid = orcidTarget ? orcidTarget.slice(6) : (user?.orcid ?? null);
  const targets = [githubId ? `github:${githubId}` : null, orcid ? `orcid:${orcid}` : null].filter((x): x is string => !!x);
  const mine = targets.length ? await all<FollowRow>(followsAmong(r.db, s.user.id, targets)) : [];
  const following = { github: mine.find((f) => f.target.startsWith("github:"))?.level ?? null, orcid: mine.find((f) => f.target.startsWith("orcid:"))?.level ?? null };
  if (!user) return json({ account: false, handles: { github: null, githubId, orcid }, following, can: { write: writes } });
  const me = user.id === s.user.id;
  // Night phase 16: a suspended account shows nothing but that it is suspended; a hidden profile's
  // words and hidden lists are withheld from everyone but their person.
  const [suspendedRow, profileHidden] = await Promise.all([accountHidden(r.db, user.id), hiddenOne(r.db, "profile", user.id)]);
  if (suspendedRow && !me) {
    return json({ account: true, me, suspended: true, handles: { github: user.github_login ?? null, githubId, orcid: user.orcid ?? null }, following, can: { write: writes } });
  }
  const [profile, lists, items] = await Promise.all([
    first<ProfileRow>(profileOf(r.db, user.id)),
    all<ListRow>(listsOf(r.db, user.id)),
    all<ItemRow>(itemsOf(r.db, user.id)),
  ]);
  const hiddenLists = me ? new Map() : await hiddenAmong(r.db, "list", lists.map((l) => `${user.id}/${l.list_id}`));
  const view = profileHidden && !me ? { ...profileView(null, r.t), private: profileView(profile, r.t).private, hidden: moderationView(profileHidden).words } : profileView(profile, r.t);
  const open = me || !view.private;
  const stars: StarRow[] = open ? await all<StarRow>(starsOf(r.db, user.id)) : [];
  const follows: FollowRow[] = open ? await all<FollowRow>(followsOf(r.db, user.id)) : [];
  return json({
    account: true,
    me,
    handles: { github: user.github_login ?? null, githubId, orcid: user.orcid ?? null },
    profile: view,
    lists: lists.filter((l) => me || (open && l.public === 1 && !hiddenLists.has(`${user.id}/${l.list_id}`))).sort((a, b) => a.list_id - b.list_id).map((l) => listView(l, items.filter((i) => me || open))),
    stars: stars.sort((a, b) => b.at - a.at).map((x) => ({ subject: x.subject, kind: subjectKind(x.subject), label: x.label, at: x.at })),
    // Whom and what they follow; the threads they follow are their own business.
    follows: follows.filter((f) => !f.target.startsWith("thread:") && f.level !== "ignore").map((f) => ({ target: f.target, level: f.level, label: f.label })),
    following,
    can: { write: writes },
  });
}

// ─── writes ──────────────────────────────────────────────────────────────────

export async function handleSocialStar(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateStar(body);
  if (p instanceof ForgeProblem) return say(p);
  const had = (await all<StarRow>(starsAmong(r.db, s.user.id, [p.subject]))).length > 0;
  if (had === p.on) return unchanged(s, { starred: had });
  let writes: Write[];
  if (p.on) {
    const n = Number((await first<{ n: number }>(starCount(r.db, s.user.id)))?.n ?? 0);
    if (n >= STARS_MAX) return say(new ForgeProblem(409, "too_many_stars", `An account holds ${STARS_MAX.toLocaleString("en-GB")} stars at most: unstar some first.`));
    writes = [starWrite(r.db, s.user.id, p, r.t)];
  } else {
    const inLists = (await all<ItemRow>(itemsAmong(r.db, s.user.id, [p.subject]))).length;
    writes = unstarWrites(r.db, s.user.id, p.subject, inLists);
  }
  const gate = await maySocial(r, s, "star", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  const written = await socialCommit(r, s, "star", gate.github, writes, p.subject);
  return done(s, written, { starred: p.on });
}

export async function handleSocialFollow(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateFollow(body);
  if (p instanceof ForgeProblem) return say(p);
  const github = await linkedGithub(s.db, s.user.id);
  if ((github && p.target === `github:${github}`) || (s.user.orcid && p.target === `orcid:${s.user.orcid}`)) {
    return say(bad("One does not follow oneself: your own activity is on your profile."));
  }
  const had = (await all<FollowRow>(followsAmong(r.db, s.user.id, [p.target])))[0] ?? null;
  let writes: Write[];
  if (!p.on) {
    if (!had) return unchanged(s, { follow: null });
    writes = [unfollowWrite(r.db, s.user.id, p.target)];
  } else {
    if (had && had.level === p.level && had.events === p.events.join(" ") && had.auto === 0) return unchanged(s, { follow: { level: had.level } });
    if (!had) {
      const n = Number((await first<{ n: number }>(followCount(r.db, s.user.id)))?.n ?? 0);
      if (n >= FOLLOWS_MAX) return say(new ForgeProblem(409, "too_many_follows", `An account follows ${FOLLOWS_MAX.toLocaleString("en-GB")} people, repositories, papers and threads at most: stop following some first.`));
    }
    writes = [followWrite(r.db, s.user.id, p, r.t)];
  }
  const gate = await maySocial(r, s, "follow", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  const written = await socialCommit(r, s, "follow", gate.github, writes, p.target);
  return done(s, written, { follow: p.on ? { level: p.level, events: p.events } : null });
}

export async function handleSocialList(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateList(body);
  if (p instanceof ForgeProblem) return say(p);
  const lists = await all<ListRow>(listsOf(r.db, s.user.id));
  const list = p.op === "create" ? null : (lists.find((l) => l.list_id === p.id) ?? null);
  if (p.op !== "create" && !list) return say(new ForgeProblem(404, "not_found", "You have no list of this number."));
  const writes: Write[] = [];
  let subject = "";
  let answer: Record<string, unknown> = {};
  switch (p.op) {
    case "create": {
      const id = freeListId(lists);
      if (id === null) return say(new ForgeProblem(409, "too_many_lists", "An account holds 32 lists at most."));
      if (lists.some((l) => l.name.toLowerCase() === p.name.toLowerCase())) return say(new ForgeProblem(409, "name_taken", `You already have a list named “${p.name}”.`));
      writes.push(listInsert(r.db, s.user.id, id, p, r.t));
      subject = `list:${id}`;
      answer = { id };
      break;
    }
    case "edit": {
      const set: Record<string, string | number> = {};
      if (p.name !== null && p.name !== list!.name) {
        if (lists.some((l) => l.list_id !== p.id && l.name.toLowerCase() === p.name!.toLowerCase())) return say(new ForgeProblem(409, "name_taken", `You already have a list named “${p.name}”.`));
        set.name = p.name;
      }
      if (p.description !== null && p.description !== list!.description) set.description = p.description;
      if (p.public !== null && (p.public ? 1 : 0) !== list!.public) {
        set.public = p.public ? 1 : 0;
        // A private list is nobody's collection.
        if (!p.public && list!.collection) set.collection = "";
      }
      if (!Object.keys(set).length) return unchanged(s, { id: p.id });
      writes.push(listUpdate(r.db, s.user.id, p.id, set, r.t));
      subject = `list:${p.id}`;
      answer = { id: p.id };
      break;
    }
    case "delete": {
      const items = (await all<ItemRow>(itemsOf(r.db, s.user.id))).filter((i) => i.list_id === p.id).length;
      writes.push(...listDeleteWrites(r.db, s.user.id, p.id, items));
      subject = `list:${p.id}`;
      break;
    }
    case "add":
    case "remove": {
      const inList = (await all<ItemRow>(itemsAmong(r.db, s.user.id, [p.subject]))).some((i) => i.list_id === p.id);
      if (inList === (p.op === "add")) return unchanged(s, { id: p.id });
      if (p.op === "add") {
        const count = (await all<ItemRow>(itemsOf(r.db, s.user.id))).filter((i) => i.list_id === p.id).length;
        if (count >= LIST_ITEMS_MAX) return say(new ForgeProblem(409, "list_full", `A list holds ${LIST_ITEMS_MAX} entries at most.`));
        // An entry of a list is starred, as on GitHub.
        if (!(await all<StarRow>(starsAmong(r.db, s.user.id, [p.subject]))).length) {
          const n = Number((await first<{ n: number }>(starCount(r.db, s.user.id)))?.n ?? 0);
          if (n >= STARS_MAX) return say(new ForgeProblem(409, "too_many_stars", `An account holds ${STARS_MAX.toLocaleString("en-GB")} stars at most: unstar some first.`));
          writes.push(starWrite(r.db, s.user.id, { subject: p.subject, label: p.label, on: true }, r.t));
        }
      }
      writes.push(listItemWrite(r.db, s.user.id, p.id, p.subject, p.op === "add", r.t));
      subject = p.subject;
      answer = { id: p.id };
      break;
    }
    case "propose": {
      if (p.propose && list!.public !== 1) return say(new ForgeProblem(409, "private_list", "Only a public list is proposed as a collection."));
      const next = p.propose ? (list!.collection === "accepted" ? "accepted" : "proposed") : "";
      if (next === list!.collection) return unchanged(s, { id: p.id });
      writes.push(listUpdate(r.db, s.user.id, p.id, { collection: next }, r.t));
      subject = `list:${p.id}`;
      answer = { id: p.id, collection: next };
      break;
    }
  }
  const gate = await maySocial(r, s, "star_list", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  const written = await socialCommit(r, s, "star_list", gate.github, writes, subject);
  return done(s, written, answer);
}

export async function handleSocialProfile(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateProfile(body, r.t);
  if (p instanceof ForgeProblem) return say(p);
  const writes = [profileWrite(r.db, s.user.id, p, r.t)];
  const gate = await maySocial(r, s, "profile", 2);
  if (gate instanceof ForgeProblem) return say(gate);
  const written = await socialCommit(r, s, "profile", gate.github, writes, "profile");
  return done(s, written);
}
