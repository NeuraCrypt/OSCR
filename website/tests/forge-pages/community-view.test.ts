// The community profile and its checklist (night phase 12, E5; src/lib/community-view.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { textOf } from "../../src/lib/repo-view.ts";
import {
  checklistScore, communityChecklist, communityView, isRedistributable,
  type CommunityInput,
} from "../../src/lib/community-view.ts";

const FULL: CommunityInput = {
  hasReadme: true, hasDescription: true,
  licence: { spdx: "MIT", redistributable: true },
  citation: { present: true, doi: true },
  hasCodeOfConduct: true, hasContributing: true, hasSecurity: true,
  papers: 2, maps: 1,
};

describe("isRedistributable", () => {
  test("a recognised open licence is reusable, case-insensitively; unknown or empty is not", () => {
    assert.ok(isRedistributable("MIT"));
    assert.ok(isRedistributable("apache-2.0"));
    assert.ok(!isRedistributable("LicenseRef-Proprietary"));
    assert.ok(!isRedistributable(""));
  });
});

describe("communityChecklist", () => {
  test("a complete repository meets every check", () => {
    const score = checklistScore(communityChecklist(FULL));
    assert.equal(score.done, score.total);
  });

  test("no licence and no citation and no paper are marked not done, with a research note", () => {
    const bare: CommunityInput = { ...FULL, licence: null, citation: { present: false, doi: false }, papers: 0, maps: 0 };
    const items = communityChecklist(bare);
    const licence = items.find((i) => i.label.startsWith("Licence"))!;
    assert.equal(licence.done, false);
    assert.ok(licence.note.toLowerCase().includes("no one may reuse"));
    const cite = items.find((i) => i.label.startsWith("Citation"))!;
    assert.equal(cite.done, false);
    const paper = items.find((i) => i.label.includes("paper"))!;
    assert.equal(paper.done, false);
    assert.ok(paper.note.toLowerCase().includes("no paper"));
  });

  test("a licence that is not redistributable is not a pass", () => {
    const items = communityChecklist({ ...FULL, licence: { spdx: "LicenseRef-X", redistributable: false } });
    assert.equal(items.find((i) => i.label.startsWith("Licence"))!.done, false);
  });

  test("a citation without a DOI still passes, and the note invites a DOI", () => {
    const items = communityChecklist({ ...FULL, citation: { present: true, doi: false } });
    const cite = items.find((i) => i.label.startsWith("Citation"))!;
    assert.equal(cite.done, true);
    assert.ok(cite.note.toLowerCase().includes("doi"));
  });
});

describe("communityView", () => {
  test("is a checklist with a score and a class per item", () => {
    const view = communityView({ ...FULL, hasReadme: false });
    assert.ok(textOf(view).includes("of 8"));
    const text = JSON.stringify(view);
    assert.ok(text.includes("checklist"));
    assert.ok(text.includes("todo"));
    assert.ok(text.includes("done"));
  });
});
