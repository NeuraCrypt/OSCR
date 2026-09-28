// The /new/ page (night phase 01, E2; src/scripts/new-repo.ts, src/lib/forge-templates.ts): the
// address pre-fills exactly the known fields and drops the rest (no script, no private
// visibility); the name's rules are the Worker's (paths.ts); the form declares the action the
// Worker accepts, with the Worker's own sentence; the licences are open and the page says why; the
// page is a static file with one script of the site and no inline code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DEFAULT_LICENCE, GITIGNORE_TEMPLATES, isGitignoreTemplate, isLicenceKey, LICENCES, licenceOf, whyLicence } from "../../src/lib/forge-templates.ts";
import { declare, EMPTY_FORM, nameProblem, prefill, PREFILL_KEYS, startInput, templateRef, type NewForm } from "../../src/scripts/new-repo.ts";
import { describeCreate, isNewRepoName, validateCreate } from "../../worker/forge/service/act-create.ts";
import { isProblem } from "../../worker/forge/service/types.ts";

const form = (over: Partial<NewForm>): NewForm => ({ ...EMPTY_FORM, papers: [], ...over });

describe("the address pre-fills the form", () => {
  test("the plan's own example", () => {
    const { form: f, dropped } = prefill("?name=eeg-analysis&description=Code%20for%20the%20EEG%20study&paper=10.5555/oscr.fixture.1&gitignore=Python&license=mit");
    assert.deepEqual(dropped, []);
    assert.equal(f.name, "eeg-analysis");
    assert.equal(f.description, "Code for the EEG study");
    assert.deepEqual(f.papers, ["10.5555/oscr.fixture.1"]);
    assert.equal(f.gitignore, "Python");
    assert.equal(f.license, "mit");
    assert.equal(f.from, "empty");
  });

  test("only the known fields, each checked; the rest dropped and named", () => {
    const { form: f, dropped } = prefill(
      "?name=%3Cscript%3Ealert(1)%3C/script%3E&visibility=private&homepage=javascript:alert(1)&gitignore=Cobol&license=proprietary" +
        "&default_branch=..%2Fx&owner=a%20b&token=abc&onload=x&paper=not-a-doi",
    );
    assert.equal(f.name, "");
    assert.equal(f.homepage, "");
    assert.equal(f.gitignore, "");
    assert.equal(f.license, DEFAULT_LICENCE);
    assert.equal(f.defaultBranch, "");
    assert.equal(f.owner, "");
    assert.deepEqual(f.papers, []);
    assert.deepEqual(dropped.sort(), ["default_branch", "gitignore", "homepage", "license", "name", "onload", "owner", "paper", "token", "visibility"].sort());
    // "public" is what the page does anyway: taken without a word.
    assert.deepEqual(prefill("?visibility=public").dropped, []);
    // Controls are turned into spaces, lengths are GitHub's.
    assert.equal(prefill(`?description=${encodeURIComponent("a\u0000b\nc")}`).form.description, "a b c");
    assert.equal(prefill(`?description=${"x".repeat(400)}`).form.description.length, 350);
    for (const key of new URLSearchParams("?a=1").keys()) assert.ok(!(PREFILL_KEYS as readonly string[]).includes(key));
  });

  test("papers: repeated, separated, as DOI addresses; at most 20", () => {
    const { form: f } = prefill("?paper=10.5555/A.1&paper=doi:10.5555/b.2%20https://doi.org/10.5555/c.3&paper=10.5555/a.1");
    assert.deepEqual(f.papers, ["10.5555/a.1", "10.5555/b.2", "10.5555/c.3"]);
    const many = Array.from({ length: 30 }, (_, i) => `paper=10.5555/x.${i}`).join("&");
    assert.equal(prefill(`?${many}`).form.papers.length, 20);
  });

  test("an import's empty repository (readme=0): no README and no licence file", () => {
    const { form: f } = prefill("?name=eeg&readme=0&paper=10.5555/oscr.fixture.1");
    assert.equal(f.readme, false);
    assert.equal(f.license, "");
    const input = startInput(f);
    assert.ok(!("problem" in input));
    assert.deepEqual(input.payload, { name: "eeg", readme: false, template: false, papers: ["10.5555/oscr.fixture.1"] });
  });

  test("a template: owner/name, or the research compendium when the site offers one", () => {
    assert.deepEqual(prefill("?template=lab/compendium&include_all_branches=1&owner=lab").form, {
      ...EMPTY_FORM,
      from: "template",
      template: "lab/compendium",
      owner: "lab",
      includeAllBranches: true,
      papers: [],
    });
    assert.equal(prefill("?template=compendium", "oscr-templates/research-compendium").form.template, "oscr-templates/research-compendium");
    assert.deepEqual(prefill("?template=compendium").dropped, ["template"]);
    assert.equal(templateRef("a/b/c"), null);
    assert.equal(templateRef("a/x.git"), null);
  });
});

describe("the name's rules and the declared action", () => {
  test("the page's rules are the Worker's", () => {
    for (const name of ["eeg", "EEG-study_2", "a.b", "x".repeat(100), "", "a b", "é", "..", ".", "x.git", "X.GIT", "x".repeat(101), "a/b", "-a", "a-"]) {
      assert.equal(nameProblem(name) === null, isNewRepoName(name), JSON.stringify(name));
    }
    assert.match(nameProblem("a b") ?? "", /Letters, digits/);
  });

  test("create: the payload the Worker accepts, and the Worker's own sentence", () => {
    const d = declare(form({ name: "eeg", gitignore: "R", license: "gpl-3.0", defaultBranch: "trunk", markTemplate: true, wiki: false, papers: ["10.5555/oscr.fixture.1"] }));
    assert.ok(!("problem" in d));
    assert.equal(d.input.kind, "create");
    assert.equal(d.input.back, "/new/");
    const parsed = validateCreate(d.input.payload);
    assert.ok(!isProblem(parsed));
    assert.equal(d.sentence, `${describeCreate(parsed)}.`);
    assert.deepEqual(parsed.features, { wiki: false });
    // What the Worker refuses, the page says before anything is sent.
    const empty = declare(form({ name: "eeg", readme: false, license: "", defaultBranch: "trunk" }));
    assert.ok("problem" in empty && /first push names it/.test(empty.problem));
    const badName = declare(form({ name: "a b" }));
    assert.ok("problem" in badName);
  });

  test("generate: a template, the receiving account, the branches", () => {
    const d = declare(form({ from: "template", name: "study", template: "lab/compendium", owner: "ada", includeAllBranches: true }));
    assert.ok(!("problem" in d));
    assert.equal(d.input.kind, "generate");
    assert.deepEqual(d.input.payload, { template: { owner: "lab", name: "compendium" }, owner: "ada", name: "study", includeAllBranches: true, papers: [] });
    assert.match(d.sentence, /^Create the public repository ada\/study from the template lab\/compendium \(all its branches\)\.$/);
    assert.ok("problem" in declare(form({ from: "template", name: "study", template: "compendium", owner: "ada" })));
    assert.ok("problem" in declare(form({ from: "template", name: "study", template: "lab/c", owner: "" })));
  });
});

describe("the static lists", () => {
  test("GitHub's .gitignore templates and licences, without a request", () => {
    for (const name of ["Python", "R", "Julia", "C++", "Fortran", "TeX"]) assert.ok(isGitignoreTemplate(name), name);
    assert.ok(!isGitignoreTemplate("python"));
    assert.equal(new Set(GITIGNORE_TEMPLATES).size, GITIGNORE_TEMPLATES.length);
    assert.ok(LICENCES.length >= 10);
    for (const l of LICENCES) {
      assert.match(l.key, /^[a-z0-9.-]+$/);
      assert.ok(l.spdx && l.name && l.explain.endsWith("."), l.key);
      assert.equal(l.open, true, l.key);
      assert.ok(isLicenceKey(l.key));
    }
    assert.equal(licenceOf("mit")?.spdx, "MIT");
    assert.ok(!isLicenceKey("proprietary"));
    const source = readFileSync(new URL("../../src/lib/forge-templates.ts", import.meta.url), "utf8");
    assert.ok(!/fetch\(|api\.github\.com/.test(source));
  });

  test("the page says why a licence matters: copies, archiving, reuse", () => {
    const why = whyLicence("the registry").join(" ");
    assert.match(why, /keep and publish copies of your scripts/);
    assert.match(why, /licence file allows redistribution/);
    assert.match(why, /archiving/);
    assert.match(why, /Without a licence, nobody may legally reuse the code/);
  });
});

describe("the page", () => {
  const page = readFileSync(new URL("../../src/pages/new/index.astro", import.meta.url), "utf8");
  const script = readFileSync(new URL("../../src/scripts/new-repo.ts", import.meta.url), "utf8");

  test("one script, a file of the site; no inline code, no style; the form shown by it", () => {
    const scripts = [...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0][1], "");
    assert.match(scripts[0][2], /^\s*import "\.\.\/\.\.\/scripts\/new-repo";\s*$/);
    assert.ok(!/\son[a-z]+=/i.test(page) && !/\sstyle=/i.test(page) && !/<style/i.test(page));
    assert.match(page, /<form id="new-form"[^>]*\shidden>/);
  });

  test("every field the script reads is on the page", () => {
    for (const name of ["from", "name", "description", "homepage", "readme", "gitignore", "license", "default_branch", "mark_template", "issues", "wiki", "template", "owner", "include_all_branches", "papers"]) {
      assert.ok(page.includes(`name="${name}"`), name);
      assert.ok(script.includes(`"${name}"`), name);
    }
    for (const id of ["new-form", "new-message", "new-name-rules", "new-confirm"]) {
      assert.ok(page.includes(`id="${id}"`), id);
      assert.ok(script.includes(`"${id}"`), id);
    }
  });

  test("the limits come from GITHUB_LIMITS, the compendium only when the build names it", () => {
    assert.match(page, /hostingFacts\(\)/);
    for (const f of ["{t.fileWarn}", "{t.file}", "{t.push}", "{t.repoIdeal}", 'href="/hosting/limits/"']) assert.ok(page.includes(f), f);
    assert.match(page, /import\.meta\.env\.COMPENDIUM_TEMPLATE/);
    assert.match(page, /\{compendium && /);
  });
});
