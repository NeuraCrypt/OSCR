// The keyboard shortcuts (src/lib/shortcuts.ts): the token a keystroke becomes, the matcher over a
// buffer (single keys, sequences, partials), the off switch, and the help view (night phase 15).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { El } from "../../src/lib/repo-view.ts";
import {
  ALL_SHORTCUTS,
  SHORTCUT_GROUPS,
  helpView,
  resolve,
  tokenOf,
} from "../../src/lib/shortcuts.ts";

const flat = (el: El | string, out: El[] = []): El[] => {
  if (typeof el === "string") return out;
  out.push(el);
  for (const c of el.children) flat(c, out);
  return out;
};
const tags = (el: El, tag: string): El[] => flat(el).filter((e) => e.tag === tag);
const text = (el: El | string): string => (typeof el === "string" ? el : el.children.map(text).join(""));

describe("tokenOf", () => {
  test("a plain key is its lowercase self", () => {
    assert.equal(tokenOf({ key: "g" }), "g");
    assert.equal(tokenOf({ key: "j" }), "j");
    assert.equal(tokenOf({ key: "?" }), "?");
    assert.equal(tokenOf({ key: "/" }), "/");
  });

  test("a letter with Shift becomes shift+<letter>, a symbol stays itself", () => {
    assert.equal(tokenOf({ key: "U", shiftKey: true }), "shift+u");
    assert.equal(tokenOf({ key: "I", shiftKey: true }), "shift+i");
    assert.equal(tokenOf({ key: "?", shiftKey: true }), "?");
  });

  test("Ctrl, Cmd or Alt means it is not a shortcut here (the palette owns Cmd/Ctrl+K)", () => {
    assert.equal(tokenOf({ key: "k", metaKey: true }), null);
    assert.equal(tokenOf({ key: "k", ctrlKey: true }), null);
    assert.equal(tokenOf({ key: "s", altKey: true }), null);
  });

  test("a non-character key (a modifier, an arrow) is not a token", () => {
    assert.equal(tokenOf({ key: "Shift" }), null);
    assert.equal(tokenOf({ key: "ArrowDown" }), null);
    assert.equal(tokenOf({ key: "Enter" }), null);
  });
});

describe("resolve", () => {
  test("a single-key shortcut fires at once and clears the buffer", () => {
    const r = resolve([], "?");
    assert.equal(r.fired.length, 1);
    assert.equal(r.fired[0].action, "help");
    assert.deepEqual(r.buffer, []);
    assert.equal(r.partial, false);
  });

  test("a sequence: the first key waits (partial), the second fires", () => {
    const first = resolve([], "g");
    assert.equal(first.fired.length, 0);
    assert.equal(first.partial, true);
    assert.deepEqual(first.buffer, ["g"]);
    const second = resolve(first.buffer, "s");
    assert.equal(second.fired.length, 1);
    assert.equal(second.fired[0].action, "/search/");
    assert.deepEqual(second.buffer, []);
  });

  test("a key that starts no sequence and matches nothing clears the buffer", () => {
    const r = resolve(["g"], "z");
    assert.equal(r.fired.length, 0);
    assert.equal(r.partial, false);
    assert.deepEqual(r.buffer, []);
  });

  test("a key after a dead buffer can still start its own shortcut", () => {
    const r = resolve(["g"], "j"); // g then j is no sequence, but j alone is a list shortcut
    assert.equal(r.fired.length, 1);
    assert.equal(r.fired[0].action, "list.next");
  });

  test("a key shared by two contexts fires both (the script sorts global from context)", () => {
    const r = resolve([], "e");
    const actions = r.fired.map((s) => s.action).sort();
    assert.deepEqual(actions, ["code.edit", "notifications.done"]);
  });

  test("with single-key shortcuts off, only the always-on help fires", () => {
    assert.equal(resolve([], "j", false).fired.length, 0);
    assert.equal(resolve([], "g", false).partial, false);
    const help = resolve([], "?", false);
    assert.equal(help.fired.length, 1);
    assert.equal(help.fired[0].action, "help");
  });
});

describe("the catalogue of shortcuts", () => {
  test("only the help is always on; the navigation shortcuts are global", () => {
    const alwaysOn = ALL_SHORTCUTS.filter((s) => s.alwaysOn);
    assert.deepEqual(alwaysOn.map((s) => s.action), ["help"]);
    const globals = ALL_SHORTCUTS.filter((s) => s.global).map((s) => s.action);
    assert.ok(globals.includes("/search/") && globals.includes("search") && globals.includes("help"));
  });

  test("the plan's code shortcuts are present (t l w y b e)", () => {
    const code = SHORTCUT_GROUPS.find((g) => g.title === "Reading code")!;
    assert.deepEqual(code.shortcuts.map((s) => s.keys), ["t", "l", "w", "y", "b", "e"]);
  });

  test("the plan's list and notification shortcuts are present (j k e Shift+U I M)", () => {
    const keys = SHORTCUT_GROUPS.find((g) => g.title.startsWith("Lists"))!.shortcuts.map((s) => s.keys);
    for (const k of ["j", "k", "e", "Shift U", "I", "M"]) assert.ok(keys.includes(k), k);
  });

  test("every global path action is a path of this site", () => {
    for (const s of ALL_SHORTCUTS.filter((s) => s.global && s.action.startsWith("/"))) {
      assert.match(s.action, /^\/([a-z]+\/)*$/);
    }
  });

  test("no description names the platform or uses an em dash", () => {
    for (const s of ALL_SHORTCUTS) {
      assert.doesNotMatch(s.describe, /\bOSCR\b|Open Scientific Code Registry/);
      assert.doesNotMatch(s.describe, /—/);
    }
  });
});

describe("helpView", () => {
  test("a section with a table per group, keys shown as kbd", () => {
    const view = helpView();
    assert.equal(tags(view, "section").length, SHORTCUT_GROUPS.length);
    assert.equal(tags(view, "table").length, SHORTCUT_GROUPS.length);
    assert.ok(tags(view, "kbd").length >= ALL_SHORTCUTS.length);
  });

  test("the disabled note shows only when the single-key shortcuts are off", () => {
    const off = helpView({ charKeysOn: false, disabledNote: "shortcuts are off" });
    assert.ok(flat(off).some((e) => e.tag === "p" && text(e).includes("off")));
    const on = helpView({ charKeysOn: true, disabledNote: "shortcuts are off" });
    assert.ok(!flat(on).some((e) => e.tag === "p" && text(e).includes("off")));
  });
});
