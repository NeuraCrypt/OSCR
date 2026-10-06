// Issue templates and forms (night phase 05, E3; src/lib/issue-forms.ts): where GitHub finds them,
// what a form says and GitHub's checks of it, config.yml, the answers as GitHub writes them, and the
// registry's three research forms turned into a research issue's payload.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  answersToBody,
  checkAnswers,
  findIssueTemplates,
  parseConfig,
  parseForm,
  parseMarkdownTemplate,
  prefillAnswers,
  readLines,
  RESEARCH_FORMS,
  researchForm,
  researchPayload,
  type IssueTemplate,
} from "../../src/lib/issue-forms.ts";
import { validateOpen } from "../../worker/forge/service/research-core.ts";
import { isProblem } from "../../worker/forge/service/types.ts";

const BUG_FORM = `name: Bug report
description: File a bug report.
title: "[Bug]: "
labels: ["bug", "triage"]
assignees:
  - ada-fixture
type: Bug
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to fill out this bug report!
  - type: input
    id: version
    attributes:
      label: Version
      description: Which version?
      placeholder: "1.2.0"
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Relevant log output
      render: shell
  - type: dropdown
    id: os
    attributes:
      label: System
      multiple: true
      options:
        - Linux
        - macOS
        - Windows
      default: 0
  - type: checkboxes
    id: terms
    attributes:
      label: Code of Conduct
      options:
        - label: I agree to follow this project's Code of Conduct
          required: true
        - label: I searched the issues
`;

describe("where the templates are", () => {
  test("the folder's forms and templates in GitHub's order, config.yml, the legacy file", () => {
    const found = findIssueTemplates([".github/ISSUE_TEMPLATE/2-feature.md", ".github/issue_template/1-bug.yml", ".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/sub/x.md", "docs/ISSUE_TEMPLATE.md", "README.md"]);
    assert.deepEqual(found.templates, [".github/issue_template/1-bug.yml", ".github/ISSUE_TEMPLATE/2-feature.md"]);
    assert.equal(found.config, ".github/ISSUE_TEMPLATE/config.yml");
    assert.equal(found.legacy, "docs/ISSUE_TEMPLATE.md");
  });
});

describe("a form", () => {
  test("read with its elements, labels, assignees and type", () => {
    const f = parseForm(BUG_FORM, ".github/ISSUE_TEMPLATE/bug.yml") as IssueTemplate;
    assert.equal(f.name, "Bug report");
    assert.equal(f.title, "[Bug]: ");
    assert.deepEqual(f.labels, ["bug", "triage"]);
    assert.deepEqual(f.assignees, ["ada-fixture"]);
    assert.equal(f.type, "Bug");
    assert.deepEqual(f.elements.map((e) => e.type), ["markdown", "input", "textarea", "dropdown", "checkboxes"]);
    assert.equal(f.elements[1].required, true);
    assert.equal(f.elements[2].render, "shell");
    assert.deepEqual(f.elements[3].options.map((o) => o.label), ["Linux", "macOS", "Windows"]);
    assert.equal(f.elements[3].multiple, true);
    assert.equal(f.elements[3].defaultOption, 0);
    assert.deepEqual(f.elements[4].options, [{ label: "I agree to follow this project's Code of Conduct", required: true }, { label: "I searched the issues", required: false }]);
  });

  test("GitHub's checks, said in words", () => {
    const broken = parseForm("name: x\nbody:\n  - type: input\n    id: a b\n    attributes:\n      label: A\n  - type: input\n    id: v\n    attributes:\n      label: A\n  - type: dropdown\n    attributes:\n      label: D\n  - type: video\n", "x.yml");
    assert.ok("problems" in broken);
    const p = (broken as { problems: string[] }).problems.join(" | ");
    assert.match(p, /no description/);
    assert.match(p, /“a b” holds characters/);
    assert.match(p, /label “A” is used twice/);
    assert.match(p, /\(dropdown\) has no options/);
    assert.match(p, /no type GitHub knows/);
    assert.ok("problems" in parseForm("name: x\ndescription: y\nbody:\n  - type: markdown\n    attributes:\n      value: hi\n", "x.yml"));
  });

  test("answers: checked, prefilled by field id, written as GitHub writes them", () => {
    const f = parseForm(BUG_FORM, "bug.yml") as IssueTemplate;
    assert.deepEqual(checkAnswers(f, {}).map((x) => x.message), ["“Version” is required.", "“I agree to follow this project's Code of Conduct” must be ticked."]);
    const pre = prefillAnswers(f, "?version=2.0&os=Windows");
    assert.deepEqual(pre, { version: "2.0", os: ["Windows"] });
    assert.deepEqual(prefillAnswers(f, "?os=BeOS"), { os: ["Linux"] });
    const body = answersToBody(f, { version: "2.0 (ask ada@example.org)", logs: "Traceback", os: ["Linux", "macOS"], terms: ["I agree to follow this project's Code of Conduct"] });
    assert.equal(
      body,
      "### Version\n\n2.0 (ask [email hidden])\n\n### Relevant log output\n\n```shell\nTraceback\n```\n\n### System\n\nLinux, macOS\n\n### Code of Conduct\n\n- [X] I agree to follow this project's Code of Conduct\n- [ ] I searched the issues",
    );
    assert.match(answersToBody(f, {}), /### Version\n\n_No response_/);
  });
});

describe("Markdown templates and config.yml", () => {
  test("front matter; the legacy file without one; a template without one is refused", () => {
    const t = parseMarkdownTemplate("---\nname: Feature request\nabout: Suggest an idea\ntitle: ''\nlabels: enhancement, question\nassignees: ''\n---\n\n**Is your feature request related to a problem?**\n", "feature.md") as IssueTemplate;
    assert.equal(t.name, "Feature request");
    assert.equal(t.about, "Suggest an idea");
    assert.deepEqual(t.labels, ["enhancement", "question"]);
    assert.deepEqual(t.assignees, []);
    assert.match(t.body, /^\n\*\*Is your feature/);
    assert.equal((parseMarkdownTemplate("Describe the bug.", ".github/issue_template.md") as IssueTemplate).body, "Describe the bug.");
    assert.ok("problems" in parseMarkdownTemplate("no front matter", ".github/ISSUE_TEMPLATE/x.md"));
  });

  test("blank issues on by default; contact links https only, never an address", () => {
    assert.deepEqual(parseConfig(null), { blankIssues: true, contactLinks: [] });
    const c = parseConfig("blank_issues_enabled: false\ncontact_links:\n  - name: Forum\n    url: https://forum.example.org\n    about: Questions go here\n  - name: Mail\n    url: mailto:a@b.org\n  - name: Http\n    url: http://x.org\n");
    assert.equal(c.blankIssues, false);
    assert.deepEqual(c.contactLinks, [{ name: "Forum", url: "https://forum.example.org", about: "Questions go here" }]);
  });
});

describe("the research forms", () => {
  test("three, in order, their typed fields named", () => {
    assert.deepEqual(RESEARCH_FORMS.map((f) => [f.research, f.name]), [["mismatch", "Code–paper mismatch"], ["reproduction", "Reproduction failure"], ["code_error", "Code error"]]);
    assert.ok(researchForm("mismatch").elements.some((e) => e.research === "paragraph" && e.required));
    assert.deepEqual(readLines("L12-L18"), { start: 12, end: 18 });
    assert.deepEqual(readLines("7"), { start: 7, end: 7 });
    assert.equal(readLines("18-12"), null);
  });

  test("a mismatch's answers make a payload the Worker accepts", () => {
    const f = researchForm("mismatch");
    const answers = { ...prefillAnswers(f, `?field.paragraph=14&field.path=src/filter.py&field.lines=12-18&field.commit=${"a".repeat(40)}`), says: "Order 2.", does: "Order 4." };
    const { payload, problems } = researchPayload(f, answers, "Order 4, not 2");
    assert.deepEqual(problems, []);
    assert.deepEqual(payload.lines, { start: 12, end: 18 });
    assert.equal(payload.paragraph, 14);
    assert.equal(payload.body, "### What the paper says\n\nOrder 2.\n\n### What the code does\n\nOrder 4.");
    const parsed = validateOpen({ ...payload, paper: "10.1234/eeg.2026", repo: { forge: "github", id: "101", path: "ada-fixture/eeg" } });
    assert.ok(!isProblem(parsed), JSON.stringify(parsed));
  });

  test("a reproduction's answers carry the report; missing fields are said", () => {
    const f = researchForm("reproduction");
    const { payload, problems } = researchPayload(f, { outcome: ["Partly reproduced"], environment: "Python 3.12", observed: "r = 0.12", datasets: "10.1/a\n\n10.1/b" }, "Figure 3");
    assert.deepEqual(problems, []);
    assert.deepEqual(payload.report, { outcome: "partially", environment: "Python 3.12", datasets: ["10.1/a", "10.1/b"], command: "", expected: "", observed: "r = 0.12", figure: "" });
    const empty = researchPayload(f, {}, "");
    assert.deepEqual(empty.problems, ["Give the issue a title.", "“The outcome” is required.", "“The environment” is required.", "“What came out” is required."]);
    assert.ok(researchPayload(researchForm("code_error"), { error: "x", lines: "abc" }, "t").problems.includes("The lines are a line or a range: 12, or 12-18."));
  });
});
