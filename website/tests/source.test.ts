// Shown from the source (src/lib/source.ts): a file the registry may not copy, fetched by the reader's
// browser from where its authors published it, at the pinned version, checked against the digest the
// registry's machine computed, decoded and masked exactly as the machine does (oscr/contents.py,
// catalog.mask_emails; the masking cases are the Python version's own: tests/fixtures/mask_emails.json).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  decodeBytes, EMAIL_MASK, failureWords, fetchVerified, fillTemplate, isBinary, maskEmails, noCopy, notebookToText, planOf,
  pySplitLines, sha256Hex, shownFrom, SOURCE_MAX_BYTES, SOURCE_ORIGINS, sourceFacts, SWH_TEMPLATE, textOf,
} from "../src/lib/source.ts";
import { PAPER_HEADERS } from "../worker/pages.ts";

const hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const SHA = "c".repeat(40);
const GITHUB = { via: "github" as const, url: `https://raw.githubusercontent.com/lab/code/${SHA}/{path}`, at: SHA };

describe("email addresses, masked as the export masks them", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../tests/fixtures/mask_emails.json", import.meta.url), "utf8")) as {
    mask: string;
    cases: { name: string; text: string; masked: string }[];
  };

  it("matches the Python version on every case of the shared fixture", () => {
    assert.equal(fixture.mask, EMAIL_MASK);
    assert.ok(fixture.cases.length >= 25);
    for (const c of fixture.cases) assert.equal(maskEmails(c.text), c.masked, c.name);
  });

  it("keeps the lines, so that the line numbers and the matches hold", () => {
    for (const c of fixture.cases) assert.equal(maskEmails(c.text).split("\n").length, c.text.split("\n").length, c.name);
  });
});

describe("the text, as the registry's machine reads it", () => {
  it("decodes UTF-8 (its byte-order mark dropped), else Windows-1252, else Latin-1", () => {
    assert.equal(decodeBytes(new TextEncoder().encode("% Jérôme\n")), "% Jérôme\n");
    assert.equal(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), "a");
    // "Søren" and a curly quote written on Windows: not UTF-8.
    assert.equal(decodeBytes(new Uint8Array([0x53, 0xf8, 0x72, 0x65, 0x6e, 0x20, 0x93, 0x78, 0x94])), "Søren “x”");
    // A byte Windows-1252 does not define: Latin-1, as Python falls back to it.
    assert.equal(decodeBytes(new Uint8Array([0x41, 0x81, 0x93])), "A\u0081\u0093");
  });

  it("splits lines as Python's str.splitlines", () => {
    assert.deepEqual(pySplitLines("a\nb\r\nc\rd\u2028e\x0bf\x0cg\x1ch\x85i"), ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    assert.deepEqual(pySplitLines("a\n"), ["a"]);
    assert.deepEqual(pySplitLines(""), []);
    assert.deepEqual(pySplitLines("a\n\nb"), ["a", "", "b"]);
  });

  it("writes a notebook by cells, without its outputs (contents.notebook_to_text)", () => {
    const nb = JSON.stringify({
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "Some *text*\n"] },
        { cell_type: "code", source: "import numpy as np\nx = 1", outputs: [{ text: "an output never shown" }] },
        { cell_type: "raw", source: "skipped" },
        { cell_type: "code", source: ["y = 2\n"] },
      ],
    });
    assert.equal(notebookToText(nb), "# %% [markdown]\n# # Title\n# Some *text*\n\n# %%\nimport numpy as np\nx = 1\n\n# %%\ny = 2\n\n");
    assert.equal(notebookToText("not json"), "not json");
    assert.equal(textOf("a.ipynb", new TextEncoder().encode(nb)), notebookToText(nb));
    assert.equal(textOf("a.py", new TextEncoder().encode(nb)), nb);
  });

  it("knows a binary file as the machine does", () => {
    assert.ok(isBinary("live.mlx", new Uint8Array([0x50, 0x4b])));
    assert.ok(isBinary("x.m", new Uint8Array([0x61, 0, 0x62])));
    assert.ok(!isBinary("x.m", new TextEncoder().encode("disp(1)\n")));
  });
});

describe("where a file is fetched", () => {
  it("fills a template, its path encoded, and never leaves the allowed places", () => {
    assert.equal(fillTemplate(GITHUB.url, "fig 1/plot #2.py", ""), `https://raw.githubusercontent.com/lab/code/${SHA}/fig%201/plot%20%232.py`);
    assert.equal(
      fillTemplate(`https://gitlab.com/api/v4/projects/g%2Fp/repository/files/{file}/raw?ref=${SHA}`, "src/a b.py", ""),
      `https://gitlab.com/api/v4/projects/g%2Fp/repository/files/src%2Fa%20b.py/raw?ref=${SHA}`,
    );
    assert.equal(fillTemplate(SWH_TEMPLATE, "x.py", "ab".repeat(32)), `https://archive.softwareheritage.org/api/1/content/sha256:${"ab".repeat(32)}/raw/`);
    assert.equal(fillTemplate(SWH_TEMPLATE, "x.py", "not a digest"), "");
    assert.equal(fillTemplate("https://evil.example/{path}", "x.py", ""), "");
    assert.equal(fillTemplate("http://raw.githubusercontent.com/{path}", "x.py", ""), "");
    assert.equal(fillTemplate("https://user:pw@raw.githubusercontent.com/{path}", "x.py", ""), "");
    assert.equal(fillTemplate("https://raw.githubusercontent.com/{owner}/{path}", "x.py", ""), "", "an unknown placeholder");
    // A path never climbs out of its repository.
    assert.equal(fillTemplate(GITHUB.url, "../../other/repo/x.py", ""), "");
    assert.equal(fillTemplate(GITHUB.url, "a/./b.py", ""), "");
    assert.equal(fillTemplate(GITHUB.url, "/etc/x", ""), "");
    assert.equal(fillTemplate(GITHUB.url, "a..b/c...py", ""), `https://raw.githubusercontent.com/lab/code/${SHA}/a..b/c...py`);
  });

  it("keeps a repository's facts only when they name an allowed place", () => {
    assert.deepEqual(sourceFacts(GITHUB), GITHUB);
    assert.deepEqual(sourceFacts({ via: "", why: "osf" }), { via: "", why: "osf" });
    assert.deepEqual(sourceFacts({ via: "", why: "anything" }), { via: "", why: "host" });
    assert.deepEqual(sourceFacts({ via: "github", url: "https://evil.example/{path}" }), { via: "", why: "host" });
    assert.equal(sourceFacts({ via: "ftp", url: GITHUB.url }), null);
    assert.equal(sourceFacts(null), null);
  });

  it("plans a fetch, or says why there is none", () => {
    const file = { path: "run.m", sha256: "ab".repeat(32), bytes: 1000, via: "" };
    const plan = planOf(GITHUB, file);
    assert.deepEqual(plan, { ok: true, url: `https://raw.githubusercontent.com/lab/code/${SHA}/run.m`, via: "github", place: "GitHub", at: SHA, size: 1000 });
    const swh = planOf({ via: "zenodo", url: "https://zenodo.org/api/records/7/files/{file}/content", at: "7" }, { ...file, via: "swh" });
    assert.equal(swh.ok && swh.url, `https://archive.softwareheritage.org/api/1/content/sha256:${"ab".repeat(32)}/raw/`);
    assert.equal(swh.ok && swh.place, "Software Heritage");
    assert.deepEqual(planOf({ via: "", why: "osf" }, file), { ok: false, why: "OSF does not let the page of another site read its files" });
    assert.match((planOf(GITHUB, { ...file, sha256: "" }) as { why: string }).why, /no fingerprint/);
    assert.match((planOf(GITHUB, { ...file, bytes: SOURCE_MAX_BYTES + 1 }) as { why: string }).why, /too large to be fetched here \(1 MB; the limit is 1 MB\)/);
    assert.equal(planOf(null, file).ok, false);
  });

  it("allows exactly these places in the paper page's Content-Security-Policy", () => {
    const connect = PAPER_HEADERS["Content-Security-Policy"].split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src"))!;
    assert.deepEqual(connect.split(/\s+/).slice(1), ["'self'", "https://www.ebi.ac.uk", "https://eutils.ncbi.nlm.nih.gov", ...SOURCE_ORIGINS]);
  });
});

describe("the fetch, checked", () => {
  const TEXT = "% run the analysis — Jérôme, jerome@lab.example.org\ndisp('run')\n";
  const BYTES = new TextEncoder().encode(TEXT);
  const DIGEST = hex(BYTES);
  const expect = { path: "run.m", sha256: DIGEST, size: BYTES.length };
  const answer = (body: BodyInit | null, init: ResponseInit = {}) => (async () => new Response(body, init)) as unknown as typeof fetch;

  it("computes the digest as the machine does", async () => {
    assert.equal(await sha256Hex(BYTES), DIGEST);
  });

  it("shows a file whose digest is the registry's, its addresses masked", async () => {
    const asked: [string, RequestInit | undefined][] = [];
    const got = await fetchVerified("https://raw.githubusercontent.com/x", expect, {
      fetch: (async (url: string, init?: RequestInit) => {
        asked.push([url, init]);
        return new Response(BYTES);
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(got, { ok: true, text: TEXT.replace("jerome@lab.example.org", EMAIL_MASK), bytes: BYTES.length, masked: true });
    // No cookie, no header of its own: a simple request.
    assert.equal(asked[0][1]?.credentials, "omit");
    assert.equal(asked[0][1]?.headers, undefined);
  });

  it("refuses a file whose digest differs", async () => {
    assert.deepEqual(await fetchVerified("u", expect, { fetch: answer(TEXT + " ") }), { ok: false, reason: "mismatch" });
  });

  it("refuses a file too large, before and while it is read", async () => {
    assert.deepEqual(await fetchVerified("u", { ...expect, size: SOURCE_MAX_BYTES + 1 }, { fetch: answer(BYTES) }), { ok: false, reason: "large" });
    assert.deepEqual(await fetchVerified("u", expect, { fetch: answer(BYTES, { headers: { "Content-Length": String(SOURCE_MAX_BYTES + 5) } }) }), {
      ok: false,
      reason: "large",
    });
    const stream = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(400_000));
      },
    });
    assert.deepEqual(await fetchVerified("u", { ...expect, size: null }, { fetch: answer(stream) }), { ok: false, reason: "large" });
  });

  it("says an error, a failure to reach the place, and a time out", async () => {
    assert.deepEqual(await fetchVerified("u", expect, { fetch: answer("gone", { status: 404 }) }), { ok: false, reason: "http", status: 404 });
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchVerified("u", expect, { fetch: down }), { ok: false, reason: "network" });
    const slow = ((_: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    assert.deepEqual(await fetchVerified("u", expect, { fetch: slow, timeoutMs: 20 }), { ok: false, reason: "timeout" });
  });

  it("refuses a binary file even when its digest is right", async () => {
    const bin = new Uint8Array([1, 0, 2]);
    assert.deepEqual(await fetchVerified("u", { path: "x.m", sha256: hex(bin), size: 3 }, { fetch: answer(bin) }), { ok: false, reason: "binary" });
  });

  it("reads a notebook by cells once its bytes are checked", async () => {
    const nb = new TextEncoder().encode(JSON.stringify({ cells: [{ cell_type: "code", source: "x = 1" }] }));
    const got = await fetchVerified("u", { path: "a.ipynb", sha256: hex(nb), size: nb.length }, { fetch: answer(nb) });
    assert.deepEqual(got, { ok: true, text: "# %%\nx = 1\n", bytes: nb.length, masked: false });
  });
});

describe("in words", () => {
  const plan = { ok: true as const, url: "u", via: "github" as const, place: "GitHub", at: SHA, size: 10 };

  it("says where the file comes from, and why the registry keeps no copy", () => {
    assert.equal(shownFrom(plan, "lab/code", "github"), "Shown from GitHub at commit ccccccc, where its authors published it.");
    assert.equal(
      shownFrom({ ...plan, via: "zenodo", place: "Zenodo", at: "123" }, "Zenodo 123", "zenodo"),
      "Shown from Zenodo, record 123, whose files never change, where its authors published it.",
    );
    assert.equal(
      shownFrom({ ...plan, via: "swh", place: "Software Heritage" }, "gitlab.inria.fr/team/tool", "swh"),
      "Shown from Software Heritage's archive: the same bytes as the file of gitlab.inria.fr/team/tool at commit ccccccc, where its authors published it.",
    );
    assert.equal(
      shownFrom({ ...plan, via: "swh", place: "Software Heritage", at: "123" }, "Zenodo 123", "zenodo"),
      "Shown from Software Heritage's archive: the same bytes as the file of Zenodo record 123, where its authors published it.",
    );
    assert.equal(noCopy("OSCR", ""), "OSCR keeps no copy: this repository has no license that allows redistribution. Rights remain with its authors.");
    assert.match(noCopy("OSCR", "other"), /the license of this repository \(other\) is not one it has verified to allow redistribution/);
  });

  it("says why a file could not be shown", () => {
    assert.match(failureWords("mismatch", plan), /not the one the registry verified \(its SHA-256 differs\), so neither it nor its matches/);
    assert.match(failureWords("http", plan, 404), /GitHub no longer serves it at this version \(HTTP 404\)/);
    assert.match(failureWords("http", plan, 429), /HTTP 429/);
    assert.match(failureWords("network", plan), /could not reach GitHub/);
    assert.match(failureWords("timeout", plan), /did not answer in time/);
    assert.match(failureWords("large", plan), /too large/);
    assert.match(failureWords("binary", plan), /not a text file/);
  });
});
