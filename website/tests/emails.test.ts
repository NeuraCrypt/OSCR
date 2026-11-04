// No email address on the site: the build's copy step and the checks (src/lib/emails.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkedText, codeLink, EMAIL_ON_PAGE, maskAll } from "../src/lib/emails.ts";

describe("a code link", () => {
  it("is dropped when it is an email address or mailto: read as a link", () => {
    for (const url of ["https://mailto:terry@sangerlab.net", "http://mailto:Abbasi@up.edu", "https://liting@bme.cams.cn", "mailto:x@lab.org"]) {
      assert.equal(codeLink({ repo: "lab.org", url, host: "lab.org" }), null, url);
    }
  });
  it("is made https from GitHub's SSH form, its key recomputed", () => {
    const l = codeLink({ repo: "github.com/l1crispr_adami_2025.git", url: "http://git@github.com:Molecular-Neurogenetics/L1CRISPR_Adami_2025.git", host: "github.com" });
    assert.deepEqual(l, { repo: "github.com/molecular-neurogenetics/l1crispr_adami_2025", url: "https://github.com/Molecular-Neurogenetics/L1CRISPR_Adami_2025", host: "github.com" });
  });
  it("is kept as it is otherwise", () => {
    const l = { repo: "github.com/bulik/ldsc", url: "https://github.com/bulik/ldsc", host: "github.com" };
    assert.equal(codeLink(l), l);
  });
});

describe("the masks and the check", () => {
  it("mask every string, keys kept, nothing else changed", () => {
    const v = { path: "procPharm (u0591788@utah.edu).r", n: 3, list: ["a@b.org", null], ok: true };
    const m = maskAll(v);
    assert.equal(m.path, "procPharm ([email hidden]).r");
    assert.deepEqual(m.list, ["[email hidden]", null]);
    assert.equal(m.n, 3);
    assert.equal(m.ok, true);
    assert.doesNotMatch(JSON.stringify(m), EMAIL_ON_PAGE);
  });
  it("the check leaves the reader's code lines out, and finds an address elsewhere", () => {
    assert.doesNotMatch(checkedText('<p>x</p><ol class="lines" id="lines"><li>a@b.org</li></ol>'), EMAIL_ON_PAGE);
    assert.match('{"url":"https://mailto:terry@sangerlab.net"}', EMAIL_ON_PAGE);
  });
  it("the nightly runs it before every deployment", () => {
    const publish = readFileSync(new URL("../../oscr/publish.py", import.meta.url), "utf8");
    assert.ok(publish.indexOf('"check:emails"') > 0 && publish.indexOf('"check:emails"') < publish.indexOf('"wrangler", "deploy"'));
    assert.match(readFileSync(new URL("../package.json", import.meta.url), "utf8"), /"check:emails": /);
  });
});
