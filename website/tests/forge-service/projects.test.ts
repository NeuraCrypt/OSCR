// Projects, OSCR's own planning boards (night phase 06, E3; projects-core.ts, projects.ts): a
// project owned by a person, its built-in fields (title, status) and research fields (paper, map
// state, reproduction outcome), items that are issues, pull requests, drafts, papers, maps and
// reproduction reports, field values in the item row (one row a change), the caps (5,000 items, 50
// fields), the table and board views. FORGE_OPEN gates the writes; the texts lose their addresses.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { forgeWorld, type ForgeBrowser, type ForgeWorld } from "./world.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { checkValue, groupItems, validateCreate, validateField, validateItem, type FieldSpec } from "../../worker/forge/service/projects-core.ts";
import { isProblem } from "../../worker/forge/service/types.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true", ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

describe("the pure core", () => {
  test("create: an owner, a title; a draft item needs a kind; a field value is checked against its type", () => {
    assert.ok(!isProblem(validateCreate({ title: "Campaign", research: true }, "u1")));
    assert.ok(isProblem(validateCreate({}, "u1")));
    assert.ok(!isProblem(validateItem({ project: 1, kind: "paper", ref: "10.1234/x" })));
    assert.ok(isProblem(validateItem({ project: 1, kind: "issue", ref: "not-a-ref" })));
    assert.ok(!isProblem(validateItem({ project: 1, kind: "report", ref: "research#3" })));
    assert.ok(!isProblem(validateField({ project: 1, name: "Priority", dataType: "single_select", options: ["High", "Low"] })));
    const select: FieldSpec = { fieldId: "p", name: "Priority", dataType: "single_select", options: [{ id: "high", name: "High" }], builtin: false };
    assert.equal(checkValue(select, "high"), "high");
    assert.ok(isProblem(checkValue(select, "mid")));
    const repro: FieldSpec = { fieldId: "r", name: "Repro", dataType: "repro_outcome", options: [], builtin: false };
    assert.equal(checkValue(repro, "failed"), "failed");
    assert.ok(isProblem(checkValue(repro, "nope")));
  });

  test("groupItems puts items in buckets by a field's value", () => {
    const items = [
      { item_id: 1, kind: "draft" as const, ref: "", title: "a", body: "", values: { status: "todo" }, archived: false, position: 1 },
      { item_id: 2, kind: "draft" as const, ref: "", title: "b", body: "", values: { status: "done" }, archived: false, position: 2 },
      { item_id: 3, kind: "draft" as const, ref: "", title: "c", body: "", values: {}, archived: false, position: 3 },
    ];
    const groups = groupItems(items, "status");
    assert.deepEqual(groups.map((g) => [g.key, g.items.length]).sort(), [["", 1], ["done", 1], ["todo", 1]]);
  });
});

describe("a project through the routes", () => {
  async function create(b: ForgeBrowser, p: Record<string, unknown> = {}): Promise<number> {
    const res = await b.post("/api/forge/projects/create", { title: "Reproduction campaign", research: true, ...p });
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
    return (await body(res)).id as number;
  }

  test("create makes the project, its built-in and research fields, and default views", async () => {
    const b = await signIn(w);
    const id = await create(b);
    const [p] = forgeRows(w.forge, "projects");
    assert.equal(p.title, "Reproduction campaign");
    assert.equal(p.owner, `user:${p.author_id}`);
    // title + status + paper + map-state + repro-outcome
    assert.equal(forgeRows(w.forge, "project_fields").length, 5);
    assert.equal(p.fields_count, 5);
    const view = await body(await b.fetch(`/api/forge/projects?id=${id}`));
    assert.equal(view.project.title, "Reproduction campaign");
    assert.equal(view.fields.length, 5);
    assert.ok(view.boards.length >= 1); // the default board view
    assert.deepEqual(w.forge.scans, []);
  });

  test("items: a paper and a draft added; a field value set in one row; archived; removed", async () => {
    const b = await signIn(w);
    const id = await create(b);
    // A paper item.
    assert.equal((await b.post("/api/forge/projects/item", { project: id, kind: "paper", ref: "10.1234/eeg.2026", values: { status: "todo" } })).status, 201);
    // A draft item (free text, with an address that is masked).
    assert.equal((await b.post("/api/forge/projects/item", { project: id, kind: "draft", title: "Chase ada@example.org", body: "note" })).status, 201);
    const items = forgeRows(w.forge, "project_items");
    assert.equal(items.length, 2);
    assert.equal((forgeRows(w.forge, "projects")[0] as { items_count: number }).items_count, 2);
    assert.match(String(items[1].title), /\[email hidden\]/);
    // Set a field value on the paper item: one row rewritten.
    w.forge.reset();
    const set = await b.post("/api/forge/projects/item", { project: id, item: 1, values: { "repro-outcome": "failed" } });
    assert.equal(set.status, 200, JSON.stringify(await body(set)));
    assert.equal(w.forge.totals.written, 2); // the item row + the action row
    assert.equal(JSON.parse(String((forgeRows(w.forge, "project_items")[0] as { field_values: string }).field_values))["repro-outcome"], "failed");
    // A bad value is refused.
    assert.equal((await b.post("/api/forge/projects/item", { project: id, item: 1, values: { "repro-outcome": "nope" } })).status, 400);
    // Archive, then remove.
    assert.equal((await b.post("/api/forge/projects/item", { project: id, item: 2, archived: true })).status, 200);
    assert.equal((await b.post("/api/forge/projects/item", { project: id, item: 2, delete: true })).status, 200);
    assert.equal((forgeRows(w.forge, "projects")[0] as { items_count: number }).items_count, 1);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a custom field added and used; a built-in field cannot be deleted", async () => {
    const b = await signIn(w);
    const id = await create(b, { research: false });
    const made = await b.post("/api/forge/projects/field", { project: id, name: "Priority", dataType: "single_select", options: ["High", "Low"] });
    assert.equal(made.status, 201);
    assert.equal((forgeRows(w.forge, "projects")[0] as { fields_count: number }).fields_count, 3);
    const field = forgeRows(w.forge, "project_fields").find((f) => f.field_id === "priority");
    assert.ok(field);
    // Delete the custom field, then refuse deleting a built-in one.
    assert.equal((await b.post("/api/forge/projects/field", { project: id, field: "priority", delete: true })).status, 200);
    assert.equal((await b.post("/api/forge/projects/field", { project: id, field: "title", delete: true })).status, 409);
  });

  test("only an owner manages the project; a non-owner is refused", async () => {
    const ada = await signIn(w);
    const id = await create(ada);
    const bob = await signIn(w, "bob");
    assert.equal((await bob.post("/api/forge/projects/edit", { id, title: "Hijack" })).status, 403);
    assert.equal((await bob.post("/api/forge/projects/item", { project: id, kind: "draft", title: "x" })).status, 403);
  });
});

describe("the gate", () => {
  test("FORGE_OPEN unset: a non-owner cannot create a project", async () => {
    const closed = forgeWorld({ env: { FORGE_OPEN: undefined } });
    const bob = await signIn(closed, "bob");
    const res = await bob.post("/api/forge/projects/create", { title: "x" });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "forge_closed");
    closed.restore();
  });
});
