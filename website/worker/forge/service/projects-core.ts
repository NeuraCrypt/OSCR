// Projects: OSCR's own planning boards (night phase 06, E3; docs/DISCUSSIONS.md; D00-6, D06-*). This
// is their pure core (the fields and their data types, the items and their kinds, what a new
// project, a field and an item say, the rows as statements, the views the pages read. No request, no
// database here.
//
// A project is owned by a person ("user:<id>") or an organization ("org:<handle>"). Its items are
// GitHub's issues and pull requests, free-text drafts, and OSCR's own research objects: a paper (a
// DOI), a tracing map, a reproduction report. Its fields are built-in (Title, Status), custom (text,
// number, date, a single choice, an iteration) and RESEARCH (a paper, a map's state, a reproduction's
// outcome). The row budget (§15.6): a field's value lives in the item row as JSON, so a change of one
// field is one row; items are capped at 5,000, fields at 50.

import type { SignedIn } from "../../account/guard.ts";
import { clean, personOf, type Person } from "./research-core.ts";
import { paperId } from "./papers.ts";
import { ForgeProblem, type D1Database, type Write } from "./types.ts";

export { clean, personOf, type Person };

// ─── the words ───────────────────────────────────────────────────────────────

export type FieldType = "text" | "number" | "date" | "single_select" | "iteration" | "paper" | "map_state" | "repro_outcome";
export const FIELD_TYPES: readonly FieldType[] = ["text", "number", "date", "single_select", "iteration", "paper", "map_state", "repro_outcome"];
/** The research field types, which carry a scientific meaning the other boards have no word for. */
export const RESEARCH_FIELDS: readonly FieldType[] = ["paper", "map_state", "repro_outcome"];

export type ItemKind = "issue" | "pull" | "draft" | "paper" | "map" | "report";
export const ITEM_KINDS: readonly ItemKind[] = ["issue", "pull", "draft", "paper", "map", "report"];

export type Layout = "table" | "board" | "roadmap";
export const LAYOUTS: readonly Layout[] = ["table", "board", "roadmap"];

/** A map's state, as a research field offers it (the tracing map's review). */
export const MAP_STATES = ["draft", "proposed", "validated", "deposited"] as const;
/** A reproduction's outcome, as a research field offers it. */
export const REPRO_OUTCOMES = ["reproduced", "partially", "failed", "pending"] as const;

export const PROJECTS_PER_OWNER = 100;
export const FIELDS_MAX = 50;
export const ITEMS_MAX = 5_000;
export const VIEWS_MAX = 12;
export const TITLE_MAX = 256;
export const DRAFT_TITLE_MAX = 1_024;
export const DRAFT_BODY_MAX = 65_536;
export const README_MAX = 65_536;

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;
const SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;
export const isSlug = (v: unknown): v is string => typeof v === "string" && SLUG.test(v);

function readLine(v: unknown, what: string, max: number): string | ForgeProblem {
  if (typeof v !== "string" || !v.trim()) return bad(`${what} is empty.`);
  const t = clean(v.trim());
  if (/\n/.test(t) || t.length > max) return bad(`${what} is one line of at most ${max} characters.`);
  return t;
}

function readText(v: unknown, what: string, max: number): string | ForgeProblem {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return bad(`${what} is not text.`);
  if (v.length > max) return bad(`${what} is at most ${max.toLocaleString("en-GB")} characters.`);
  return clean(v);
}

// ─── the owner ─────────────────────────────────────────────────────────────────

export interface Owner {
  key: string;
  kind: "user" | "org";
  /** The organization's handle (lower case), for an org owner. */
  handle: string;
}

const HANDLE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** The owner a payload names: the signed-in person ("me"/"user:<id>" of their own), or an
 *  organization ("org:<handle>"). The route checks the person may own there. */
export function readOwner(value: unknown, selfId: string): Owner | null {
  if (value === undefined || value === null || value === "me" || value === `user:${selfId}`) return { key: `user:${selfId}`, kind: "user", handle: "" };
  if (typeof value !== "string") return null;
  const m = /^org:([a-z0-9][a-z0-9-]{0,38})$/.exec(value.toLowerCase());
  return m && HANDLE.test(m[1]) ? { key: `org:${m[1]}`, kind: "org", handle: m[1] } : null;
}

// ─── fields ──────────────────────────────────────────────────────────────────

export interface FieldSpec {
  fieldId: string;
  name: string;
  dataType: FieldType;
  options: { id: string; name: string }[];
  builtin: boolean;
}

/** The built-in fields every project is made with: Title and Status (a single choice). */
export const BUILTIN_FIELDS: readonly FieldSpec[] = [
  { fieldId: "title", name: "Title", dataType: "text", options: [], builtin: true },
  {
    fieldId: "status",
    name: "Status",
    dataType: "single_select",
    options: [{ id: "todo", name: "Todo" }, { id: "in-progress", name: "In progress" }, { id: "done", name: "Done" }],
    builtin: true,
  },
];

function readOptions(v: unknown): { id: string; name: string }[] | ForgeProblem {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > FIELDS_MAX) return bad(`A field has at most ${FIELDS_MAX} options.`);
  const out: { id: string; name: string }[] = [];
  for (const o of v) {
    const name = typeof o === "string" ? o : isObject(o) ? o.name : null;
    const line = readLine(name, "An option", 100);
    if (line instanceof ForgeProblem) return line;
    const id = line.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || `o${out.length + 1}`;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, name: line });
  }
  return out;
}

export interface FieldParsed {
  projectId: number;
  /** null to create. */
  fieldId: string | null;
  name: string | null;
  dataType: FieldType | null;
  options: { id: string; name: string }[] | null;
  delete: boolean;
}

export function validateField(payload: unknown): FieldParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The field is not readable.");
  if (!isId(payload.project)) return bad("Name the project by its number.");
  const projectId = payload.project;
  if (payload.delete !== undefined) {
    if (payload.delete !== true || !isSlug(payload.field)) return bad("Deleting names the field by its id.");
    return { projectId, fieldId: payload.field, name: null, dataType: null, options: null, delete: true };
  }
  const creating = payload.field === undefined || payload.field === null;
  if (!creating && !isSlug(payload.field)) return bad("A field is named by its id (a lower-case slug).");
  const name = payload.name === undefined ? null : readLine(payload.name, "The field's name", 100);
  if (name instanceof ForgeProblem) return name;
  let dataType: FieldType | null = null;
  if (payload.dataType !== undefined) {
    if (!FIELD_TYPES.includes(payload.dataType as FieldType)) return bad("A field's type is text, number, date, single_select, iteration, paper, map_state or repro_outcome.");
    dataType = payload.dataType as FieldType;
  }
  if (creating && (!name || !dataType)) return bad("A new field needs a name and a type.");
  const options = payload.options === undefined ? null : readOptions(payload.options);
  if (options instanceof ForgeProblem) return options;
  return { projectId, fieldId: creating ? null : (payload.field as string), name, dataType, options, delete: false };
}

/** A new field's id from its name (a slug), kept distinct from the ones a project already has. */
export function fieldIdOf(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 46) || "field";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`.slice(0, 50);
  return id;
}

// ─── items ─────────────────────────────────────────────────────────────────────

export interface ItemParsed {
  projectId: number;
  /** null to add. */
  itemId: number | null;
  kind: ItemKind | null;
  ref: string;
  title: string;
  body: string;
  /** Field values to set ({fieldId: value}); the route checks each against its field. */
  values: Record<string, unknown> | null;
  archived: boolean | null;
  delete: boolean;
}

const ISSUE_REF = /^(github|memory):[0-9]{1,20}#[1-9][0-9]{0,9}$/;
const RESEARCH_REF = /^research#[1-9][0-9]{0,9}$/;

/** A reference as the item kind requires it: an issue/pull id, a paper or map DOI, a report's id; a
 *  draft has none. */
export function readRef(kind: ItemKind, value: unknown): string | ForgeProblem {
  if (kind === "draft") return "";
  if (kind === "issue" || kind === "pull") {
    return typeof value === "string" && ISSUE_REF.test(value) ? value : bad("An issue or pull request is named by “<forge>:<id>#<number>”.");
  }
  if (kind === "paper" || kind === "map") {
    const id = paperId(value);
    return id ? id : bad("A paper or a tracing map is named by its DOI.");
  }
  // report
  return typeof value === "string" && RESEARCH_REF.test(value) ? value : bad("A reproduction report is named by “research#<id>”.");
}

export function validateItem(payload: unknown): ItemParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The item is not readable.");
  if (!isId(payload.project)) return bad("Name the project by its number.");
  const projectId = payload.project;
  if (payload.item !== undefined && payload.item !== null && !isId(payload.item)) return bad("An item is named by its number.");
  const itemId = (payload.item as number | undefined) ?? null;
  if (payload.delete !== undefined) {
    if (payload.delete !== true || itemId === null) return bad("Deleting names the item, and only that.");
    return { projectId, itemId, kind: null, ref: "", title: "", body: "", values: null, archived: null, delete: true };
  }
  let kind: ItemKind | null = null;
  let ref = "";
  let title = "";
  let body = "";
  if (itemId === null) {
    if (!ITEM_KINDS.includes(payload.kind as ItemKind)) return bad("An item is an issue, a pull request, a draft, a paper, a map or a reproduction report.");
    kind = payload.kind as ItemKind;
    const r = readRef(kind, payload.ref);
    if (r instanceof ForgeProblem) return r;
    ref = r;
    const t = kind === "draft" ? readLine(payload.title, "The draft's title", DRAFT_TITLE_MAX) : readText(payload.title, "The title", DRAFT_TITLE_MAX);
    if (t instanceof ForgeProblem) return t;
    title = t;
    if (kind === "draft") {
      const b = readText(payload.body, "The draft's text", DRAFT_BODY_MAX);
      if (b instanceof ForgeProblem) return b;
      body = b;
    }
  } else {
    // An edit: a new title/body for a draft, field values, archive.
    if (payload.title !== undefined) {
      const t = readText(payload.title, "The title", DRAFT_TITLE_MAX);
      if (t instanceof ForgeProblem) return t;
      title = t;
    }
    if (payload.body !== undefined) {
      const b = readText(payload.body, "The text", DRAFT_BODY_MAX);
      if (b instanceof ForgeProblem) return b;
      body = b;
    }
  }
  let values: Record<string, unknown> | null = null;
  if (payload.values !== undefined) {
    if (!isObject(payload.values) || Object.keys(payload.values).length > FIELDS_MAX) return bad("The field values are not readable.");
    values = payload.values;
  }
  let archived: boolean | null = null;
  if (payload.archived !== undefined) {
    if (typeof payload.archived !== "boolean") return bad("An item is archived or restored.");
    archived = payload.archived;
  }
  if (itemId !== null && payload.title === undefined && payload.body === undefined && values === null && archived === null) return bad("Nothing to change on the item.");
  return { projectId, itemId, kind, ref, title, body, values, archived, delete: false };
}

/** One field value checked against its field's type; the stored value, or a problem. */
export function checkValue(field: FieldSpec, value: unknown): string | number | null | ForgeProblem {
  if (value === null || value === "") return null;
  switch (field.dataType) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : bad(`“${field.name}” takes a number.`);
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : bad(`“${field.name}” takes a date (2026-12-01).`);
    case "single_select":
    case "iteration":
      return typeof value === "string" && field.options.some((o) => o.id === value) ? value : bad(`“${field.name}” takes one of its options.`);
    case "paper":
      return paperId(value) ?? bad(`“${field.name}” takes a paper's DOI.`);
    case "map_state":
      return typeof value === "string" && (MAP_STATES as readonly string[]).includes(value) ? value : bad(`“${field.name}” is draft, proposed, validated or deposited.`);
    case "repro_outcome":
      return typeof value === "string" && (REPRO_OUTCOMES as readonly string[]).includes(value) ? value : bad(`“${field.name}” is reproduced, partially, failed or pending.`);
    default: {
      const t = readText(value, field.name, 2000);
      return t instanceof ForgeProblem ? t : t;
    }
  }
}

// ─── create and edit a project ───────────────────────────────────────────────

export interface CreateParsed {
  owner: Owner;
  title: string;
  readme: string;
  /** Add the research fields (paper, map state, reproduction outcome) at creation. */
  research: boolean;
}

export function validateCreate(payload: unknown, selfId: string): CreateParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The project is not readable.");
  const owner = readOwner(payload.owner, selfId);
  if (!owner) return bad("A project is owned by you or an organization (org:<handle>).");
  const title = readLine(payload.title, "The project's title", TITLE_MAX);
  if (title instanceof ForgeProblem) return title;
  const readme = readText(payload.readme, "The project's description", README_MAX);
  if (readme instanceof ForgeProblem) return readme;
  return { owner, title, readme, research: payload.research === true };
}

export interface ProjectEditParsed {
  id: number;
  title: string | null;
  readme: string | null;
  state: "open" | "closed" | null;
  views: View[] | null;
}

export interface View {
  id: string;
  name: string;
  layout: Layout;
  groupBy: string;
  sortBy: string;
  filter: string;
}

function readViews(v: unknown): View[] | ForgeProblem {
  if (!Array.isArray(v) || v.length > VIEWS_MAX) return bad(`A project has at most ${VIEWS_MAX} views.`);
  const out: View[] = [];
  for (const x of v) {
    if (!isObject(x)) return bad("A view is not readable.");
    const name = readLine(x.name, "A view's name", 100);
    if (name instanceof ForgeProblem) return name;
    if (!LAYOUTS.includes(x.layout as Layout)) return bad("A view's layout is table, board or roadmap.");
    const field = (k: unknown) => (k === undefined || k === null ? "" : isSlug(k) ? (k as string) : null);
    const groupBy = field(x.groupBy);
    const sortBy = field(x.sortBy);
    if (groupBy === null || sortBy === null) return bad("A view groups and sorts by a field's id.");
    const filter = typeof x.filter === "string" ? clean(x.filter).slice(0, 500) : "";
    out.push({ id: isSlug(x.id) ? (x.id as string) : `v${out.length + 1}`, name, layout: x.layout as Layout, groupBy, sortBy, filter });
  }
  return out;
}

export function validateProjectEdit(payload: unknown): ProjectEditParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The change is not readable.");
  if (!isId(payload.id)) return bad("Name the project by its number.");
  const out: ProjectEditParsed = { id: payload.id, title: null, readme: null, state: null, views: null };
  if (payload.title !== undefined) {
    const t = readLine(payload.title, "The project's title", TITLE_MAX);
    if (t instanceof ForgeProblem) return t;
    out.title = t;
  }
  if (payload.readme !== undefined) {
    const r = readText(payload.readme, "The project's description", README_MAX);
    if (r instanceof ForgeProblem) return r;
    out.readme = r;
  }
  if (payload.state !== undefined) {
    if (payload.state !== "open" && payload.state !== "closed") return bad("A project is open or closed.");
    out.state = payload.state;
  }
  if (payload.views !== undefined) {
    const v = readViews(payload.views);
    if (v instanceof ForgeProblem) return v;
    out.views = v;
  }
  if (out.title === null && out.readme === null && out.state === null && out.views === null) return bad("Nothing to change.");
  return out;
}

/** The default views a project is made with: a table of everything, and a board grouped by status. */
export const DEFAULT_VIEWS: readonly View[] = [
  { id: "table", name: "Table", layout: "table", groupBy: "", sortBy: "", filter: "" },
  { id: "board", name: "Board", layout: "board", groupBy: "status", sortBy: "", filter: "" },
];

// ─── the rows ────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: number;
  owner: string;
  number: number;
  title: string;
  readme: string;
  state: "open" | "closed";
  views: string;
  fields_count: number;
  items_count: number;
  author_id: string;
  author: string;
  author_via: Person["via"];
  created_at: number;
  updated_at: number;
}

export interface FieldRow {
  project_id: number;
  field_id: string;
  name: string;
  data_type: FieldType;
  options: string;
  builtin: number;
  position: number;
  created_at: number;
}

export interface ItemRow {
  project_id: number;
  item_id: number;
  kind: ItemKind;
  ref: string;
  title: string;
  body: string;
  field_values: string;
  archived: number;
  position: number;
  added_by: string;
  created_at: number;
  updated_at: number;
}

export const projectById = (db: D1Database, id: number) => db.prepare("SELECT * FROM projects WHERE id = ?").bind(id);
export const fieldsOf = (db: D1Database, id: number) => db.prepare("SELECT * FROM project_fields WHERE project_id = ? ORDER BY position, field_id").bind(id);
export const itemsOf = (db: D1Database, id: number) => db.prepare("SELECT * FROM project_items WHERE project_id = ? ORDER BY position, item_id LIMIT 5000").bind(id);
export const projectsOfOwner = (db: D1Database, owner: string, limit = PROJECTS_PER_OWNER) =>
  db.prepare("SELECT id, owner, number, title, state, fields_count, items_count, author, author_via, created_at, updated_at FROM projects WHERE owner = ? ORDER BY id DESC LIMIT ?").bind(owner, limit);
export const nextNumberOf = (db: D1Database, owner: string) => db.prepare("SELECT coalesce(max(number), 0) + 1 AS n FROM projects WHERE owner = ?").bind(owner);

/** A new project (1 row). */
export function insertProject(db: D1Database, p: { owner: string; number: number; title: string; readme: string; views: View[]; fieldsCount: number }, who: Person, t: number): Write {
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT INTO projects (owner, number, title, readme, views, fields_count, author_id, author, author_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(p.owner, p.number, p.title, p.readme, JSON.stringify(p.views), p.fieldsCount, who.id, who.author, who.via, Math.floor(t), Math.floor(t)),
  };
}

export function updateProject(db: D1Database, id: number, set: Record<string, string | number | null>, t: number): Write {
  const cols = Object.keys(set);
  return { rows: 1, stmt: db.prepare(`UPDATE projects SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...cols.map((c) => set[c]), Math.floor(t), id) };
}

/** A new field and the project's field count (2 rows). */
export function insertField(db: D1Database, id: number, f: FieldSpec, position: number, t: number): Write[] {
  return [
    {
      rows: 1,
      stmt: db
        .prepare("INSERT INTO project_fields (project_id, field_id, name, data_type, options, builtin, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, f.fieldId, f.name, f.dataType, JSON.stringify(f.options), f.builtin ? 1 : 0, position, Math.floor(t)),
    },
    { rows: 1, stmt: db.prepare("UPDATE projects SET fields_count = fields_count + 1, updated_at = ? WHERE id = ? AND fields_count < ?").bind(Math.floor(t), id, FIELDS_MAX) },
  ];
}

export function updateField(db: D1Database, id: number, fieldId: string, set: Record<string, string | number | null>): Write {
  const cols = Object.keys(set);
  return { rows: 1, stmt: db.prepare(`UPDATE project_fields SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE project_id = ? AND field_id = ?`).bind(...cols.map((c) => set[c]), id, fieldId) };
}

/** A field deleted and the count (2 rows). A built-in field is never deleted (checked by the route). */
export function deleteField(db: D1Database, id: number, fieldId: string, t: number): Write[] {
  return [
    { rows: 1, stmt: db.prepare("DELETE FROM project_fields WHERE project_id = ? AND field_id = ? AND builtin = 0").bind(id, fieldId) },
    { rows: 1, stmt: db.prepare("UPDATE projects SET fields_count = max(0, fields_count - 1), updated_at = ? WHERE id = ?").bind(Math.floor(t), id) },
  ];
}

/** A new item (its number is the project's count after it) and the project's item count (2 rows). */
export function insertItem(db: D1Database, id: number, it: { kind: ItemKind; ref: string; title: string; body: string; values: Record<string, unknown> }, userId: string, t: number): Write[] {
  return [
    {
      rows: 1,
      stmt: db
        .prepare(
          "INSERT INTO project_items (project_id, item_id, kind, ref, title, body, field_values, position, added_by, created_at, updated_at) " +
            "SELECT id, items_count + 1, ?, ?, ?, ?, ?, items_count + 1, ?, ?, ? FROM projects WHERE id = ? AND items_count < ?",
        )
        .bind(it.kind, it.ref, it.title, it.body, JSON.stringify(it.values), userId, Math.floor(t), Math.floor(t), id, ITEMS_MAX),
    },
    { rows: 1, stmt: db.prepare("UPDATE projects SET items_count = items_count + 1, updated_at = ? WHERE id = ? AND items_count < ?").bind(Math.floor(t), id, ITEMS_MAX) },
  ];
}

export function updateItem(db: D1Database, id: number, itemId: number, set: Record<string, string | number | null>, t: number): Write {
  const cols = Object.keys(set);
  return { rows: 1, stmt: db.prepare(`UPDATE project_items SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE project_id = ? AND item_id = ?`).bind(...cols.map((c) => set[c]), Math.floor(t), id, itemId) };
}

/** An item deleted and the count (2 rows). */
export function deleteItem(db: D1Database, id: number, itemId: number, t: number): Write[] {
  return [
    { rows: 1, stmt: db.prepare("DELETE FROM project_items WHERE project_id = ? AND item_id = ?").bind(id, itemId) },
    { rows: 1, stmt: db.prepare("UPDATE projects SET items_count = max(0, items_count - 1), updated_at = ? WHERE id = ?").bind(Math.floor(t), id) },
  ];
}

// ─── the views the pages read ─────────────────────────────────────────────────

const parseJson = <T>(text: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
};

export interface ProjectView {
  id: number;
  owner: string;
  number: number;
  title: string;
  readme: string;
  state: "open" | "closed";
  views: View[];
  fields_count: number;
  items_count: number;
  author: string;
  author_via: Person["via"];
  created_at: number;
  updated_at: number;
}

export function projectViewOf(r: ProjectRow): ProjectView {
  return {
    id: r.id,
    owner: r.owner,
    number: r.number,
    title: r.title,
    readme: r.readme,
    state: r.state,
    views: parseJson<View[]>(r.views, []),
    fields_count: r.fields_count,
    items_count: r.items_count,
    author: r.author,
    author_via: r.author_via,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const fieldViewOf = (f: FieldRow): FieldSpec & { position: number } => ({
  fieldId: f.field_id,
  name: f.name,
  dataType: f.data_type,
  options: parseJson<{ id: string; name: string }[]>(f.options, []),
  builtin: f.builtin === 1,
  position: f.position,
});

export interface ItemView {
  item_id: number;
  kind: ItemKind;
  ref: string;
  title: string;
  body: string;
  values: Record<string, unknown>;
  archived: boolean;
  position: number;
}

export const itemViewOf = (i: ItemRow): ItemView => ({
  item_id: i.item_id,
  kind: i.kind,
  ref: i.ref,
  title: i.title,
  body: i.body,
  values: parseJson<Record<string, unknown>>(i.field_values, {}),
  archived: i.archived === 1,
  position: i.position,
});

/** The project's items grouped by a field's value, for a board view (computed in the Worker, no
 *  extra read): each group is an option id (or "" for none). */
export function groupItems(items: ItemView[], fieldId: string): { key: string; items: ItemView[] }[] {
  const groups = new Map<string, ItemView[]>();
  for (const it of items) {
    const key = fieldId === "title" ? it.title : String((it.values as Record<string, unknown>)[fieldId] ?? "");
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
  }
  return [...groups].map(([key, items]) => ({ key, items }));
}
