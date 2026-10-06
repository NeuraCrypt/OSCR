// The approval page of the command line's sign-in (night phase 14; src/lib/device.ts): the request read
// from the address, what the token may do in words, the warning, a form that asks the terminal's code
// and never shows it, the states in words, the sign-in links coming back to the request.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decisionForm, noRequest, requestOf, requestView, signInLinks, stateView, type DeviceRead } from "../../src/lib/device.ts";
import { textOf, type El } from "../../src/lib/repo-view.ts";

function all(node: El | string | null | undefined): El[] {
  if (!node || typeof node === "string") return [];
  return [node, ...node.children.flatMap((c) => all(c as El))];
}

const SEALED = `${"eyJ2IjoxLCJuIjoiQUFB"}.${"a".repeat(43)}`;
const READ: DeviceRead = {
  name: "Command line",
  scopes: [{ id: "repos:read", words: "read the registry's layer over repositories" }, { id: "research:write", words: "open research issues, as you" }],
  days: 90,
  requested_at: "2026-09-29T10:00:00.000Z",
  expires_at: "2026-09-29T10:15:00.000Z",
  expired: false,
  state: "pending",
  account: { github: "ada-fixture", orcid: "0000-0002-1825-0097" },
  can: { approve: true },
};

describe("the approval page", () => {
  test("the request from the address, only when it is one", () => {
    assert.equal(requestOf(`?r=${SEALED}`), SEALED);
    for (const bad of ["", "?r=", "?r=abc", `?r=${SEALED}<script>`, "?x=1"]) assert.equal(requestOf(bad), null, bad);
  });

  test("what is asked, as whom, for how long, and the warning", () => {
    const text = textOf(requestView(READ, Date.parse("2026-09-29T10:05:00Z")));
    assert.match(text, /Command line/);
    assert.match(text, /GitHub ada-fixture, ORCID 0000-0002-1825-0097/);
    assert.match(text, /repos:read: read the registry's layer/);
    assert.match(text, /90 days/);
    assert.match(text, /ends in 10 minutes/);
    assert.match(text, /Approve only if you started this sign-in yourself/);
    assert.ok(!/@/.test(text));
    const decided = textOf(requestView({ ...READ, state: "approved" }, Date.parse("2026-09-29T10:05:00Z")));
    assert.ok(!/ends in/.test(decided) && !/Approve only if/.test(decided), "once decided, neither the countdown nor the warning");
  });

  test("the form asks the code and never shows it; approve and refuse", () => {
    const form = decisionForm();
    const input = all(form).find((n) => n.tag === "input");
    assert.equal(input?.attrs.name, "code");
    assert.equal(input?.attrs.autocomplete, "off");
    assert.equal(input?.attrs.value, undefined);
    const buttons = all(form).filter((n) => n.tag === "button").map((b) => b.attrs["data-decision"]);
    assert.deepEqual(buttons, ["approve", "deny"]);
  });

  test("the states in words", () => {
    assert.equal(stateView(READ), null);
    assert.match(textOf(stateView({ ...READ, state: "approved" })), /Go back to your terminal/);
    assert.match(textOf(stateView({ ...READ, state: "collected" })), /personal tokens/);
    assert.match(textOf(stateView({ ...READ, state: "denied" })), /Refused/);
    assert.match(textOf(stateView({ ...READ, state: "decided" })), /another account/);
    assert.match(textOf(stateView({ ...READ, expired: true })), /expired/);
    assert.match(textOf(stateView({ ...READ, can: { approve: false } })), /only its owner/);
    assert.match(textOf(noRequest()), /oscr auth login/);
  });

  test("signing in comes back to this very request", () => {
    const links = all(signInLinks(SEALED)).filter((n) => n.tag === "a").map((a) => a.attrs.href ?? "");
    assert.equal(links.length, 3);
    for (const href of links) {
      const back = new URL(href, "https://registry.example").searchParams.get("return");
      assert.equal(back, `/device/?r=${SEALED}`);
    }
  });
});
