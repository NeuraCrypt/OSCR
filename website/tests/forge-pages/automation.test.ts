// The settings pages of phase 10 (E5; src/lib/automation.ts): tokens listed without their value, made
// with their scopes in words, shown once; webhooks listed with their state in words, their subjects
// read from what a person types, their deliveries with Redeliver where it can be.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deliveriesTable, eventWords, hookForm, hooksList, madeSecret, madeToken, readHookSubject, subjectWords, tokenForm, tokensTable } from "../../src/lib/automation.ts";
import { textOf, type El } from "../../src/lib/repo-view.ts";

/** Every element of a tree, depth first. */
function all(node: El | string | null | undefined): El[] {
  if (!node || typeof node === "string") return [];
  return [node, ...node.children.flatMap((c) => all(c as El))];
}

describe("tokens", () => {
  test("the list: name, scopes, dates, last use; a Revoke button each; never a token", () => {
    const el = tokensTable([{ id: "abcdefghijklmnop", name: "Lab CI", scopes: ["repos:read", "statuses:write"], created_at: "2026-09-29T10:00:00Z", expires_at: "2026-10-29T10:00:00Z", expired: false, last_used: null }]);
    const text = textOf(el);
    assert.match(text, /Lab CI/);
    assert.match(text, /repos:read, statuses:write/);
    assert.match(text, /never/);
    assert.ok(all(el).some((n) => n.tag === "button" && n.attrs["data-revoke"] === "abcdefghijklmnop"));
    assert.match(textOf(tokensTable([])), /no token/);
  });

  test("the form: each scope with its words; the life; a token shown once, with what to do", () => {
    const form = tokenForm([{ id: "repos:read", words: "read the layer" }]);
    assert.ok(all(form).some((n) => n.tag === "input" && n.attrs.type === "checkbox" && n.attrs.value === "repos:read"));
    assert.equal(all(form).filter((n) => n.tag === "option").length, 6);
    const made = textOf(madeToken(`oscr_pat_${"x".repeat(43)}`, "Lab CI", "2026-10-29T10:00:00Z"));
    assert.match(made, /never show it again/);
    assert.match(made, /until 2026-10-29/);
  });
});

describe("webhooks", () => {
  test("what a person types: a DOI in any form, owner/name or its GitHub address, the API's own subject", () => {
    assert.deepEqual(readHookSubject("https://doi.org/10.1234/EEG.2026"), { kind: "paper", subject: "paper:doi:10.1234/eeg.2026" });
    assert.deepEqual(readHookSubject("10.1234/eeg.2026"), { kind: "paper", subject: "paper:doi:10.1234/eeg.2026" });
    assert.deepEqual(readHookSubject("ada-fixture/eeg"), { kind: "repo", path: "ada-fixture/eeg" });
    assert.deepEqual(readHookSubject("https://github.com/ada-fixture/eeg.git"), { kind: "repo", path: "ada-fixture/eeg" });
    assert.deepEqual(readHookSubject("repo:github:123"), { kind: "subject", subject: "repo:github:123" });
    for (const bad of ["", "just words", "a/b/c", "../x"]) assert.equal(readHookSubject(bad), null, bad);
    assert.equal(subjectWords("paper:doi:10.1/x"), "the paper 10.1/x");
    assert.equal(subjectWords("repo:github:5"), "the repository github:5");
    assert.equal(subjectWords("repo:github:5", "ada/eeg"), "the repository ada/eeg");
    assert.equal(eventWords("research_opened"), "research opened");
  });

  test("the list: the address, the subject, the events, its state in words; its buttons", () => {
    const el = hooksList([{ id: "h".repeat(16), subject: "paper:doi:10.1/x", url: "https://hooks.lab.example/in", events: ["research_opened"], active: false, created_at: "", updated_at: "" }]);
    const text = textOf(el);
    assert.match(text, /hooks\.lab\.example\/in, the paper 10\.1\/x, research opened\./);
    assert.match(text, /Paused: it receives nothing until a ping is answered/);
    const ops = all(el).filter((n) => n.tag === "button").map((n) => n.attrs["data-op"]);
    assert.deepEqual(ops, ["ping", "deliveries", "rotate", "delete"]);
  });

  test("the form: the paper's events shown first, the repository's hidden; a secret shown once", () => {
    const form = hookForm({ repository: ["issue_opened"], paper: ["research_opened"] }, "10.1/x");
    const groups = all(form).filter((n) => n.attrs["data-kind"]);
    assert.deepEqual(groups.map((g) => [g.attrs["data-kind"], g.attrs.hidden ?? null]), [["paper", null], ["repository", "hidden"]]);
    assert.ok(all(form).some((n) => n.tag === "input" && n.attrs.id === "hook-subject" && n.attrs.value === "10.1/x"));
    assert.match(textOf(madeSecret("whsec_x", { ok: false, words: "the receiver answered 404" })), /The ping failed \(the receiver answered 404\)/);
  });

  test("deliveries: when, the event, the answer, the attempts; Redeliver for an event only", () => {
    const d = (event: string, ok: boolean, redeliverable: boolean) => ({ guid: `${event}-0000-0000-0000-000000000000`.slice(0, 36), event, at: "2026-09-29T10:00:00Z", status: ok ? 200 : 500, ok, attempts: ok ? 1 : 3, ms: 120, words: ok ? "delivered" : "the receiver answered 500", redelivery: false, redeliverable });
    const el = deliveriesTable([d("ping", true, false), d("research_closed", false, true)]);
    assert.match(textOf(el), /2026-09-29 10:00 UTC/);
    assert.equal(all(el).filter((n) => n.tag === "button").length, 1);
    assert.match(textOf(deliveriesTable([])), /No delivery/);
  });
});
