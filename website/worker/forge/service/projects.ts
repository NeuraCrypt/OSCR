// The routes of projects (night phase 06, E3; docs/DISCUSSIONS.md): OSCR's own planning boards,
// read and written for a signed-in reader. OSCR's own objects (D00-6): nothing is written on GitHub.
//
//   GET  /api/forge/projects?id=N          one project: its fields, its items, its views (grouped)
//   GET  /api/forge/projects?owner=…        an owner's projects (its own, or org:<handle>)
//   POST /api/forge/projects/create         a new project with its built-in fields and views
//   POST /api/forge/projects/edit           the title, description, state or views
//   POST /api/forge/projects/field          a field created, changed or deleted
//   POST /api/forge/projects/item           an item added, changed, archived or removed
//
// Signed in; FORGE_OPEN (the owner only until phase 16); the human check on a new project and a draft
// item (their free text); the per-account caps (projects created, project edits — projects are the
// heaviest writer, §15.6); the day's rows. Who may write: the project's author, an org owner or
// moderator for an org-owned project, the registry's owner. Every text is masked for addresses.

import type { SignedIn } from "../../account/guard.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { readCapped } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { isOwner } from "./moderation.ts";
import { memberOf, orgByHandle } from "./org-core.ts";
import { requireHuman } from "./turnstile.ts";
import { who as whoAsks } from "./who.ts";
import {
  BUILTIN_FIELDS,
  checkValue,
  DEFAULT_VIEWS,
  deleteField,
  deleteItem,
  FIELDS_MAX,
  fieldIdOf,
  fieldsOf,
  fieldViewOf,
  groupItems,
  insertField,
  insertItem,
  insertProject,
  ITEMS_MAX,
  itemsOf,
  itemViewOf,
  nextNumberOf,
  personOf,
  projectById,
  projectsOfOwner,
  projectViewOf,
  README_MAX,
  RESEARCH_FIELDS,
  updateField,
  updateItem,
  updateProject,
  validateCreate,
  validateField,
  validateItem,
  validateProjectEdit,
  type FieldRow,
  type FieldSpec,
  type ItemRow,
  type Owner,
  type ProjectRow,
} from "./projects-core.ts";
import { actionRow, all, first, newNonce, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type ProjectRowKind, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;

async function readPost(r: ForgeRequest): Promise<Record<string, unknown> | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return bad("The request is not JSON.");
  const text = await readCapped(r.request, README_MAX + 8192);
  if (text === null) return new ForgeProblem(413, "too_large", "This request is too large.");
  try {
    const v = JSON.parse(text) as unknown;
    return isObject(v) ? v : bad("The request is not readable.");
  } catch {
    return bad("The request is not readable.");
  }
}

async function mayProject(r: ForgeRequest, s: SignedIn, kind: ProjectRowKind, rows: number): Promise<ForgeProblem | { github: string }> {
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  const caps = await dailyCaps(r.db, s.user.id, kind, r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, Math.min(rows, FORGE_ROWS_PER_DAY))) ?? { github: github ?? "" };
}

/** Whether the reader may own a project under this owner: their own account always; an organization
 *  when they are its owner or moderator. */
async function mayOwn(r: ForgeRequest, s: SignedIn, owner: Owner): Promise<boolean> {
  if (owner.kind === "user") return owner.key === `user:${s.user.id}`;
  const org = await first<{ id: string }>(orgByHandle(r.db, owner.handle));
  if (!org) return false;
  const m = await first<{ role: string }>(memberOf(r.db, org.id, s.user.id));
  return m?.role === "owner" || m?.role === "moderator";
}

/** Whether the reader manages a project: its author, an org owner/moderator for an org project, the
 *  registry's owner. */
async function mayManage(r: ForgeRequest, s: SignedIn, p: ProjectRow): Promise<boolean> {
  if (p.author_id === s.user.id) return true;
  if (await isOwner(r, s)) return true;
  if (p.owner.startsWith("org:")) {
    const org = await first<{ id: string }>(orgByHandle(r.db, p.owner.slice(4)));
    if (org) {
      const m = await first<{ role: string }>(memberOf(r.db, org.id, s.user.id));
      return m?.role === "owner" || m?.role === "moderator";
    }
  }
  return false;
}

async function commit(r: ForgeRequest, s: SignedIn, kind: ProjectRowKind, github: string, writes: Write[], nonce = newNonce()) {
  const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce, kind, githubUser: github, outcome: "done", rows: 1 + rowsOf(writes) });
  return r.db.batch([...statements(writes), action.stmt]);
}

// ─── reads ─────────────────────────────────────────────────────────────────────

export async function handleProjectsRead(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const writes = mayWrite(r.env, await linkedGithub(s.db, s.user.id));
  const q = r.url.searchParams;
  if (q.has("id")) {
    const id = Number(q.get("id"));
    if (!isId(id)) return problemAnswer(bad("A project is named by its number."));
    const p = await first<ProjectRow>(projectById(r.db, id));
    if (!p) return problemAnswer(new ForgeProblem(404, "not_found", "The registry has no project of this number."));
    const [fields, items] = await Promise.all([all<FieldRow>(fieldsOf(r.db, id)), all<ItemRow>(itemsOf(r.db, id))]);
    const view = projectViewOf(p);
    const itemViews = items.map(itemViewOf);
    const boards = view.views.filter((v) => v.layout === "board").map((v) => ({ view: v.id, groupBy: v.groupBy, groups: groupItems(itemViews, v.groupBy || "status") }));
    return json({
      project: { ...view, mine: p.author_id === s.user.id },
      fields: fields.map(fieldViewOf),
      items: itemViews,
      boards,
      can: { write: writes, manage: writes && (await mayManage(r, s, p)) },
    });
  }
  const ownerParam = q.get("owner");
  let owner: string | null;
  if (ownerParam === null || ownerParam === "me" || ownerParam === `user:${s.user.id}`) owner = `user:${s.user.id}`;
  else if (/^org:[a-z0-9][a-z0-9-]{0,38}$/.test(ownerParam.toLowerCase())) owner = ownerParam.toLowerCase();
  else owner = null; // a project's items are not public yet; another person's user owner is not listed here
  if (!owner) return problemAnswer(bad("Name an owner: yours, or org:<handle>."));
  const list = await all<Record<string, unknown>>(projectsOfOwner(r.db, owner));
  return json({ owner, projects: list, can: { write: writes } });
}

// ─── create, edit ────────────────────────────────────────────────────────────

export async function handleProjectCreate(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const parsed = validateCreate(body, s.user.id);
  if (parsed instanceof ForgeProblem) return say(parsed);
  const human = await requireHuman(r, body.turnstile);
  if (human) return say(human);
  if (!(await mayOwn(r, s, parsed.owner))) return say(new ForgeProblem(403, "forbidden", "You cannot create a project for this owner: an organization's project is for its owners and moderators."));
  const fields: FieldSpec[] = [...BUILTIN_FIELDS];
  if (parsed.research) {
    fields.push(
      { fieldId: "paper", name: "Paper", dataType: "paper", options: [], builtin: false },
      { fieldId: "map-state", name: "Map state", dataType: "map_state", options: [], builtin: false },
      { fieldId: "repro-outcome", name: "Reproduction", dataType: "repro_outcome", options: [], builtin: false },
    );
  }
  const num = Number((await first<{ n: number }>(nextNumberOf(r.db, parsed.owner.key)))?.n ?? 1);
  const project = insertProject(r.db, { owner: parsed.owner.key, number: num, title: parsed.title, readme: parsed.readme, views: [...DEFAULT_VIEWS], fieldsCount: fields.length }, personOf(s.user), r.t);
  const gate = await mayProject(r, s, "project_create", 2 + fields.length);
  if (gate instanceof ForgeProblem) return say(gate);
  // The project's id is its insert's rowid, so its fields go in a second batch. The project's row
  // carries the final field count already, so the fields are inserted without the counter bump
  // (insertField(...)[0] is the field row only).
  const results = await commit(r, s, "project_create", gate.github, [project]);
  const id = Number(results[0]?.meta?.last_row_id ?? 0);
  if (id) await r.db.batch(fields.map((f, i) => insertField(r.db, id, f, i, r.t)[0].stmt));
  return json({ id, page: `/projects/${id}`, sentence: `Create the project “${parsed.title}”` }, 201, s.cookies);
}

export async function handleProjectEdit(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateProjectEdit(body);
  if (p instanceof ForgeProblem) return say(p);
  const project = await first<ProjectRow>(projectById(r.db, p.id));
  if (!project) return say(new ForgeProblem(404, "not_found", "The registry has no project of this number."));
  if (!(await mayManage(r, s, project))) return say(new ForgeProblem(403, "forbidden", "Only the project's owners manage it."));
  const set: Record<string, string | number | null> = {};
  if (p.title !== null) set.title = p.title;
  if (p.readme !== null) set.readme = p.readme;
  if (p.state !== null) set.state = p.state;
  if (p.views !== null) set.views = JSON.stringify(p.views);
  const gate = await mayProject(r, s, "project_edit", 2);
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "project_edit", gate.github, [updateProject(r.db, p.id, set, r.t)]);
  return json({ id: p.id, page: `/projects/${p.id}` }, 200, s.cookies);
}

// ─── fields ─────────────────────────────────────────────────────────────────

export async function handleProjectField(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateField(body);
  if (p instanceof ForgeProblem) return say(p);
  const project = await first<ProjectRow>(projectById(r.db, p.projectId));
  if (!project) return say(new ForgeProblem(404, "not_found", "The registry has no project of this number."));
  if (!(await mayManage(r, s, project))) return say(new ForgeProblem(403, "forbidden", "Only the project's owners change its fields."));
  const fields = await all<FieldRow>(fieldsOf(r.db, p.projectId));
  let writes: Write[];
  if (p.delete) {
    const f = fields.find((x) => x.field_id === p.fieldId);
    if (!f) return say(new ForgeProblem(404, "not_found", "The project has no such field."));
    if (f.builtin) return say(new ForgeProblem(409, "builtin", "A built-in field cannot be deleted."));
    writes = deleteField(r.db, p.projectId, p.fieldId!, r.t);
  } else if (p.fieldId === null) {
    if (project.fields_count >= FIELDS_MAX) return say(new ForgeProblem(409, "full", `A project holds ${FIELDS_MAX} fields at most.`));
    const id = fieldIdOf(p.name!, new Set(fields.map((x) => x.field_id)));
    writes = insertField(r.db, p.projectId, { fieldId: id, name: p.name!, dataType: p.dataType!, options: p.options ?? [], builtin: false }, fields.length, r.t);
  } else {
    const f = fields.find((x) => x.field_id === p.fieldId);
    if (!f) return say(new ForgeProblem(404, "not_found", "The project has no such field."));
    const set: Record<string, string | number | null> = {};
    if (p.name !== null) set.name = p.name;
    if (p.options !== null) set.options = JSON.stringify(p.options);
    if (!Object.keys(set).length) return say(bad("Nothing to change on the field (its type is fixed once set)."));
    writes = [updateField(r.db, p.projectId, p.fieldId, set)];
  }
  const gate = await mayProject(r, s, "project_field", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "project_field", gate.github, writes);
  return json({ id: p.projectId, page: `/projects/${p.projectId}` }, p.fieldId === null && !p.delete ? 201 : 200, s.cookies);
}

// ─── items ─────────────────────────────────────────────────────────────────

export async function handleProjectItem(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateItem(body);
  if (p instanceof ForgeProblem) return say(p);
  // A new draft carries free text: the human check.
  if (p.itemId === null && p.kind === "draft") {
    const human = await requireHuman(r, body.turnstile);
    if (human) return say(human);
  }
  const project = await first<ProjectRow>(projectById(r.db, p.projectId));
  if (!project) return say(new ForgeProblem(404, "not_found", "The registry has no project of this number."));
  if (!(await mayManage(r, s, project))) return say(new ForgeProblem(403, "forbidden", "Only the project's owners change its items."));

  // The field values, each checked against its field.
  const checkedValues = async (): Promise<Record<string, string | number | null> | ForgeProblem> => {
    if (!p.values) return {};
    const fields = await all<FieldRow>(fieldsOf(r.db, p.projectId));
    const by = new Map(fields.map((f) => [f.field_id, fieldViewOf(f)]));
    const out: Record<string, string | number | null> = {};
    for (const [fid, raw] of Object.entries(p.values)) {
      const f = by.get(fid);
      if (!f) return bad(`The project has no field “${fid}”.`);
      const v = checkValue(f, raw);
      if (v instanceof ForgeProblem) return v;
      out[fid] = v;
    }
    return out;
  };

  let writes: Write[];
  let created = false;
  if (p.delete) {
    const it = await first<{ item_id: number }>(r.db.prepare("SELECT item_id FROM project_items WHERE project_id = ? AND item_id = ?").bind(p.projectId, p.itemId));
    if (!it) return say(new ForgeProblem(404, "not_found", "The project has no such item."));
    writes = deleteItem(r.db, p.projectId, p.itemId!, r.t);
  } else if (p.itemId === null) {
    if (project.items_count >= ITEMS_MAX) return say(new ForgeProblem(409, "full", `A project holds ${ITEMS_MAX.toLocaleString("en-GB")} items at most.`));
    const values = await checkedValues();
    if (values instanceof ForgeProblem) return say(values);
    writes = insertItem(r.db, p.projectId, { kind: p.kind!, ref: p.ref, title: p.title, body: p.body, values: values as Record<string, unknown> }, s.user.id, r.t);
    created = true;
  } else {
    const it = await first<ItemRow>(r.db.prepare("SELECT * FROM project_items WHERE project_id = ? AND item_id = ?").bind(p.projectId, p.itemId));
    if (!it) return say(new ForgeProblem(404, "not_found", "The project has no such item."));
    const set: Record<string, string | number | null> = {};
    if (p.title) set.title = p.title;
    if (p.body) set.body = p.body;
    if (p.archived !== null) set.archived = p.archived ? 1 : 0;
    if (p.values) {
      const checked = await checkedValues();
      if (checked instanceof ForgeProblem) return say(checked);
      const merged = { ...itemViewOf(it).values, ...checked };
      // Drop the nulls (a field cleared).
      for (const [k, v] of Object.entries(merged)) if (v === null) delete (merged as Record<string, unknown>)[k];
      set.field_values = JSON.stringify(merged);
    }
    if (!Object.keys(set).length) return say(bad("Nothing to change on the item."));
    writes = [updateItem(r.db, p.projectId, p.itemId, set, r.t)];
  }
  const gate = await mayProject(r, s, "project_item", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "project_item", gate.github, writes);
  return json({ id: p.projectId, page: `/projects/${p.projectId}` }, created ? 201 : 200, s.cookies);
}
