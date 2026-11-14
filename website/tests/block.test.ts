// Block identifiers (src/lib/blockid.ts, src/lib/block.ts, worker/block.ts; oscr/blocks.py): the form
// and its check character, the same as Python's; an entry kept to its known fields; and the Worker's
// /b/<id> and /b/<id>.json, read in the DOI lookup's shards, with no file of their own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { blockJson, blockView, cleanEntry } from "../src/lib/block.ts";
import { BLOCK_ID, checkChar, normalize } from "../src/lib/blockid.ts";
import { lookupShard } from "../src/lib/shards.ts";
import { handleBlock } from "../worker/block.ts";
import type { Assets } from "../worker/pages.ts";

// An identifier the Python side gave to the fixture's first match (tests/fixtures/public-catalog).
const ID = "oscr:b:ZHK95W68S9M1K-N";
const FIXTURE = "../tests/fixtures/public-catalog/lookup";

describe("a block identifier's form", () => {
  it("has Python's check character (oscr/blocks.py check_char)", () => {
    assert.ok(BLOCK_ID.test(ID));
    assert.equal(checkChar("ZHK95W68S9M1K"), "N");
    // The hybrid system ends at 1 over the body and its check.
    for (const body of ["0000000000000", "ZZZZZZZZZZZZZ", "7K3M9QX2PD4TA"]) {
      let p = 36;
      let s = 0;
      for (const c of body + checkChar(body)) {
        s = (p + "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(c)) % 36 || 36;
        p = (s * 2) % 37;
      }
      assert.equal(s, 1);
    }
  });

  it("is read as a person writes it, and a typing mistake is refused", () => {
    assert.equal(normalize(ID.toLowerCase()), ID);
    assert.equal(normalize("ZHK95W68S9M1K-N"), ID);
    assert.equal(normalize("oscr:b:ZHK95W68S9M1K-n"), ID);
    assert.equal(normalize("oscr:b:ZHK95W68S9M1K-M"), "");
    assert.equal(normalize("oscr:b:ZHK95W68S9N1K-N"), "");
    assert.equal(normalize("oscr:b:ZHK95W68S9M1-N"), "");
    assert.equal(normalize("10.5555/x"), "");
  });

  it("matches every identifier of the fixture's lookup", async () => {
    let n = 0;
    for (const name of ["04", "14", "1c", "59", "6c", "89", "c4"]) {
      const shard = JSON.parse(readFileSync(`${FIXTURE}/${name}.json`, "utf8")) as Record<string, unknown>;
      for (const key of Object.keys(shard).filter((k) => k.startsWith("oscr:b:"))) {
        assert.equal(normalize(key), key);
        assert.equal(await lookupShard(key), name);
        assert.ok(cleanEntry(shard[key]));
        n += 1;
      }
    }
    assert.equal(n, 2);
  });
});

describe("a block's entry and page", () => {
  const raw = JSON.parse(readFileSync(`${FIXTURE}/1c.json`, "utf8"))[ID];
  it("keeps only the known fields, of the right types", () => {
    const e = cleanEntry({ ...raw, injected: "<script>", path: 7, lines: ["a", 2] });
    assert.equal(e, null);
    const ok = cleanEntry({ ...raw, injected: "<script>" })!;
    assert.ok(!("injected" in ok));
    assert.deepEqual(ok.lines, [6, 10]);
    const withdrawn = cleanEntry({ status: "withdrawn", doi: "10.5555/x", since: "2026-11-14", path: "secret.py" })!;
    assert.deepEqual(withdrawn, { status: "withdrawn", doi: "10.5555/x", since: "2026-11-14" });
  });

  it("is escaped, says who linked it, and opens the reader at its lines", () => {
    const e = cleanEntry({ ...raw, symbol: "<b>x</b>" })!;
    const v = blockView(ID, e, "OSCR");
    assert.ok(!v.html.includes("<b>x</b>") && v.html.includes("&lt;b&gt;x&lt;/b&gt;"));
    assert.ok(v.html.includes("the registry's matching program (lexical-v1), which can be wrong"));
    assert.ok(v.html.includes('href="/paper/doi_10.5555_oscr.fixture.1/?path=analysis.py#L6-L10"'));
    assert.ok(!v.html.includes("—"));
    const j = blockJson(ID, e, "https://openscicode.org");
    assert.equal(j.url, `https://openscicode.org/b/${ID}`);
    assert.match(String(j.swhid_qualified), /^swh:1:cnt:[0-9a-f]{40};origin=https:\/\/github\.com\/oscr-fixture\/eeg-analysis;anchor=swh:1:rev:0{40};path=\/analysis\.py;lines=6-10$/);
  });
});

function assets(files: Record<string, string>): Assets {
  return {
    async fetch(input) {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      const file = files[path];
      return file === undefined ? new Response(null, { status: 404 }) : new Response(file, { status: 200 });
    },
  };
}

describe("the Worker's /b/ (worker/block.ts)", () => {
  const SHELL =
    '<!doctype html><head><title>Page not found: OSCR</title><meta name="application-name" content="OSCR"><meta name="robots" content="noindex"></head><body><span id="crumb">Page not found</span><main id="main"><h1>Page not found</h1></main></body>';
  const site = () => assets({ "/404.html": SHELL, "/lookup/1c.json": readFileSync(`${FIXTURE}/1c.json`, "utf8") });
  const get = (path: string) => handleBlock(new Request(`https://openscicode.org${path}`), site());

  it("answers a block's page, indexable, and its JSON", async () => {
    const page = (await get(`/b/${ID}`))!;
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(`<h1>Block <code>${ID}</code></h1>`) && !html.includes("noindex"));
    assert.ok(html.includes(`<link rel="canonical" href="https://openscicode.org/b/${ID}"`));
    const json = (await get(`/b/${ID}.json`))!;
    assert.equal(json.status, 200);
    assert.equal(json.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (await json.json()) as Record<string, unknown>;
    assert.equal(body.id, ID);
    assert.equal(body.doi, "10.5555/oscr.fixture.1");
  });

  it("sends another writing to the one form, and says why one is not found", async () => {
    const moved = (await get(`/b/${ID.toLowerCase()}`))!;
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get("Location"), `https://openscicode.org/b/${ID}`);
    const bare = (await get("/b/ZHK95W68S9M1K-N.json"))!;
    assert.equal(bare.headers.get("Location"), `https://openscicode.org/b/${ID}.json`);
    const typo = (await get("/b/oscr:b:ZHK95W68S9M1K-M"))!;
    assert.equal(typo.status, 404);
    assert.ok((await typo.text()).includes("check character is wrong"));
    const unknown = (await get(`/b/oscr:b:0000000000000-${checkChar("0000000000000")}.json`))!;
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: string }).error, "not_found");
    assert.equal(await handleBlock(new Request("https://openscicode.org/badge/x"), site()), undefined);
  });
});
