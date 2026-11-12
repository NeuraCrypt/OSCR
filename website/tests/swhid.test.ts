// A citable identifier for a piece of the authors' code (src/lib/swhid.ts): the file's SWHID with its
// context qualifiers, its archive link, the citation to copy, and the reader's files carrying it
// only when the export gave a well-formed one for a file whose text is here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { readerFiles, type RepoIn } from "../src/lib/reader.ts";
import { archiveUrl, citation, CONTENT_SWHID, qualifiedSwhid } from "../src/lib/swhid.ts";

const ID = "swh:1:cnt:3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const base = { swhid: ID, origin: "https://github.com/lab/code", commit: COMMIT, path: "src/model.py", range: null };

describe("the SWHID", () => {
  it("is git's blob hash: the test vector is git hash-object's for 'hello world\\n'", () => {
    const bytes = Buffer.from("hello world\n");
    const sha1 = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
    assert.equal(`swh:1:cnt:${sha1}`, ID);
    assert.ok(CONTENT_SWHID.test(ID));
  });

  it("carries its origin, anchor, path and lines", () => {
    assert.equal(
      qualifiedSwhid({ ...base, range: { start: 10, end: 25 } }),
      `${ID};origin=https://github.com/lab/code;anchor=swh:1:rev:${COMMIT};path=/src/model.py;lines=10-25`,
    );
    assert.equal(qualifiedSwhid({ ...base, range: { start: 7, end: 7 } }).split(";").pop(), "lines=7");
    assert.equal(qualifiedSwhid(base), `${ID};origin=https://github.com/lab/code;anchor=swh:1:rev:${COMMIT};path=/src/model.py`);
  });

  it("leaves out what it cannot say, and escapes what the grammar reserves", () => {
    // A Zenodo record's number is no git commit: no anchor.
    assert.ok(!qualifiedSwhid({ ...base, commit: "1234567" }).includes("anchor="));
    assert.ok(!qualifiedSwhid({ ...base, origin: "" }).includes("origin="));
    assert.ok(qualifiedSwhid({ ...base, path: "a dir/x;y%.py" }).endsWith("path=/a%20dir/x%3By%25.py"));
    assert.equal(qualifiedSwhid({ ...base, swhid: "swh:1:cnt:xyz" }), "");
    assert.equal(archiveUrl(""), "");
    assert.ok(archiveUrl(qualifiedSwhid(base)).startsWith(`https://archive.softwareheritage.org/${ID};`));
  });

  it("makes a citation of the lines, the version, the identifier and the registry's link", () => {
    const text = citation({ ...base, range: { start: 10, end: 25 }, repoName: "lab/code", link: "https://example.org/paper/x/?path=src/model.py#L10-L25" });
    const [what, id, link] = text.split("\n");
    assert.equal(what, `src/model.py, lines 10 to 25, in lab/code (https://github.com/lab/code), commit ${COMMIT}.`);
    assert.ok(id.startsWith(`SWHID: ${ID};`) && id.endsWith(";lines=10-25"));
    assert.equal(link, "https://example.org/paper/x/?path=src/model.py#L10-L25");
    assert.ok(!text.includes("—"));
    assert.equal(citation({ ...base, swhid: "", repoName: "x", link: "y" }), "");
  });

  it("is given to a reader's file only when its text is here and the identifier is well formed", () => {
    const file = (path: string, swhid: string | undefined, text: string | null) => ({
      path, language: "Python", kind: "script", lines: 1, text, truncated: false, note: "", source_url: "",
      sha256: "a".repeat(64), size: 3, text_lot: "0a", ...(swhid === undefined ? {} : { swhid }),
    });
    const repos: RepoIn[] = [{
      repo: "github.com/lab/code", url: "https://github.com/lab/code", name: "lab/code", license: "MIT", state: "alive", lot: "00",
      entry: { commit: COMMIT, license: "MIT", published: true, files: [file("a.py", ID, "x\n"), file("b.py", "bad", "x\n"), file("c.py", undefined, "x\n"), file("d.py", ID, null)] },
    }];
    assert.deepEqual(readerFiles(repos).files.map((f) => f.swhid), [ID, "", "", ""]);
  });
});
