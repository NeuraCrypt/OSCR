// Uploads and deletions from the browser (night phase 03, E4; src/lib/upload.ts): names as GitHub's
// name field reads them, a folder's structure kept, a file replaced with its executable bit, LFS
// patterns obeyed, the Worker's 1 MiB and 100 files, a folder's files reviewed before they go, and an
// image added beside a Markdown file with its description to write.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { attributesOf, parseAttributes } from "../../src/lib/attributes.ts";
import { deletePlan, freeName, imageMarkdown, type Picked, UPLOAD_BUDGET, uploadPlan } from "../../src/lib/upload.ts";
import { base64, utf8 } from "../../worker/forge/objects.ts";

const ENTRIES = [
  { path: "analysis.py", type: "blob", mode: "100644" },
  { path: "run.sh", type: "blob", mode: "100755" },
  { path: "data", type: "tree", mode: "040000" },
  { path: "data/subjects.csv", type: "blob", mode: "100644" },
  { path: "vendor/lib", type: "commit", mode: "160000" },
  { path: "vendor", type: "tree", mode: "040000" },
] as const;
const pick = (name: string, content: string | Uint8Array): Picked => ({ name, bytes: typeof content === "string" ? utf8(content) : content });

describe("an upload", () => {
  test("texts as text, bytes as base64; a folder's structure kept; a file replaced with its executable bit", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]);
    const plan = uploadPlan([pick("notes.md", "# Notes\n"), pick("figures/f1.png", png), pick("run.sh", "#!/bin/sh\n"), pick("empty.txt", "")], "", ENTRIES);
    assert.equal(plan.problem, null);
    assert.deepEqual(plan.changes, [
      { op: "put", path: "notes.md", text: "# Notes\n" },
      { op: "put", path: "figures/f1.png", base64: base64(png) },
      { op: "put", path: "run.sh", text: "#!/bin/sh\n", executable: true },
      { op: "put", path: "empty.txt", text: "" },
    ]);
    assert.deepEqual(plan.rows.map((r) => [r.path, r.as, r.replaces]), [["notes.md", "text", false], ["figures/f1.png", "bytes", false], ["run.sh", "text", true], ["empty.txt", "text", false]]);
    assert.equal(uploadPlan([pick("x.txt", "x")], "data", ENTRIES).changes[0].op === "put" && (uploadPlan([pick("x.txt", "x")], "data", ENTRIES).changes[0] as { path: string }).path, "data/x.txt");
  });

  test("refused with the reason beside the file: .git, above the repository, a folder, a submodule, a file holding a folder, twice", () => {
    const plan = uploadPlan(
      [pick(".git/config", "x"), pick("../x", "x"), pick("data", "x"), pick("vendor/lib", "x"), pick("analysis.py/inner.txt", "x"), pick("a.txt", "1"), pick("a.txt", "2")],
      "",
      ENTRIES,
    );
    const why = Object.fromEntries(plan.rows.map((r) => [r.path, r.problem]));
    assert.match(why[".git/config"]!, /may hold/);
    assert.match(why["../x"]!, /may hold/);
    assert.match(why.data!, /is a folder/);
    assert.match(why["vendor/lib"]!, /submodule/);
    assert.match(why["analysis.py/inner.txt"]!, /is a file/);
    assert.equal(plan.rows.filter((r) => r.path === "a.txt").map((r) => r.problem)[1], "Picked twice: the first one is kept.");
    assert.deepEqual(plan.changes, [{ op: "put", path: "a.txt", text: "1" }]);
  });

  test("LFS patterns of .gitattributes are obeyed", () => {
    const attrs = "*.h5 filter=lfs diff=lfs merge=lfs -text\ndocs/*.pdf filter=lfs\n*.csv -filter\n";
    const plan = uploadPlan([pick("data/big.h5", new Uint8Array([1, 2, 3])), pick("docs/paper.pdf", new Uint8Array([37, 80])), pick("t.csv", "a,b\n")], "", ENTRIES, attrs);
    assert.match(plan.rows[0].problem!, /Git LFS/);
    assert.match(plan.rows[1].problem!, /Git LFS/);
    assert.equal(plan.rows[2].problem, null);
    assert.equal(attributesOf(parseAttributes(attrs), "x/y.h5").lfs, true);
    assert.equal(attributesOf(parseAttributes(attrs), "t.csv").lfs, false);
  });

  test("sizes: one file over the Worker's budget, over GitHub's 25 MB, all together; 100 files at most", () => {
    const big = new Uint8Array(UPLOAD_BUDGET + 1);
    assert.match(uploadPlan([pick("big.bin", big)], "", ENTRIES).rows[0].problem!, /GitHub's own upload page/);
    assert.match(uploadPlan([{ name: "huge.bin", bytes: new Uint8Array(0), size: 30 * 1024 * 1024 }], "", ENTRIES).rows[0].problem!, /Over 25 MB/);
    const part = new Uint8Array(Math.floor(UPLOAD_BUDGET / 3));
    part[0] = 0;
    const three = uploadPlan([pick("a.bin", part), pick("b.bin", part), pick("c.bin", part)], "", ENTRIES);
    assert.match(three.problem!, /Together these files are too large/);
    const many = uploadPlan(Array.from({ length: 101 }, (_, i) => pick(`f${i}.txt`, "x")), "", ENTRIES);
    assert.match(many.problem!, /At most 100 files/);
    assert.match(uploadPlan([], "", ENTRIES).problem!, /Choose files/);
  });

  test("a compiled program is said in words, never refused", () => {
    const plan = uploadPlan([pick("tool.exe", new Uint8Array([77, 90, 0, 0]))], "", ENTRIES);
    assert.equal(plan.problem, null);
    assert.match(plan.rows[0].note!, /never runs it/);
  });
});

describe("a deletion", () => {
  test("a file, a folder and what it holds, nothing, too many", () => {
    assert.deepEqual(deletePlan(ENTRIES, "analysis.py"), { paths: ["analysis.py"], folder: false, problem: null });
    assert.deepEqual(deletePlan(ENTRIES, "data"), { paths: ["data/subjects.csv"], folder: true, problem: null });
    assert.match(deletePlan(ENTRIES, "nope").problem!, /no file or folder/);
    const many = Array.from({ length: 101 }, (_, i) => ({ path: `d/f${i}`, type: "blob" as const }));
    assert.match(deletePlan([{ path: "d", type: "tree" as const }, ...many], "d").problem!, /git rm -r d/);
  });
});

describe("an image into Markdown", () => {
  test("beside the file, its link relative, its description to write", () => {
    assert.deepEqual(imageMarkdown("docs/methods.md", "docs/figure 1.png"), { text: "![Describe the image](figure%201.png)", placeholder: "Describe the image" });
    assert.equal(imageMarkdown("README.md", "f.png").text, "![Describe the image](f.png)");
    const taken = new Set(["docs/image.png", "docs/image-2.png"]);
    assert.equal(freeName("docs", "image.png", (p) => taken.has(p)), "docs/image-3.png");
    assert.equal(freeName("", "My Figure (final).PNG", () => false), "My-Figure-final-.PNG");
  });
});
