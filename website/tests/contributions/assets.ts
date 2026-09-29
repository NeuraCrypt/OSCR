// Test support: the site's own files behind the Worker's ASSETS binding, as a removal request reads
// them (src/lib/removal.ts, loadFacts): the static page of a recent paper, which carries its facts at
// the top of <main>, and the record of a paper rendered on demand, in its shard. The fixture's
// papers: 1 (static, its code on GitHub, three files), 2 (rendered on demand, its code without a
// license: no copy on the site), 3 (static, code on request: no repository).
import { FACTS_ID, type PaperFacts } from "../../src/lib/removal.ts";
import type { PaperRecord } from "../../src/lib/render.ts";
import { shardOf, SHARDS } from "../../src/lib/shards.ts";
import type { Assets } from "../../worker/pages.ts";

// The fixture's papers and repositories (world.ts names them too; not imported from there, which
// imports this file).
const P1 = "doi:10.5555/oscr.fixture.1";
const P2 = "doi:10.5555/oscr.fixture.2";
const P3 = "doi:10.5555/oscr.fixture.3";
const EEG = "github.com/oscr-fixture/eeg-analysis";
const UNLICENSED = "github.com/oscr-fixture/unlicensed";

const slug = (id: string) => id.replace(/[^a-z0-9._-]+/g, "_");

export const FILES_P1 = ["analysis.py", "plot.py", "LICENSE"];

/** Paper 1's facts, as its static page carries them. */
export const FACTS_P1: PaperFacts = {
  id: P1,
  slug: slug(P1),
  doi: P1.slice(4),
  title: "A synthetic EEG study for the OSCR build test",
  authors: ["Ada Fixture", "Ben Example"],
  authors_more: 0,
  repos: [{ repo: EEG, name: "oscr-fixture/eeg-analysis", url: `https://${EEG}`, license: "MIT", copies: true, files: FILES_P1, more: 0 }],
};
export const FACTS_P3: PaperFacts = {
  id: P3,
  slug: slug(P3),
  doi: P3.slice(4),
  title: "A synthetic study with code on request",
  authors: ["Ada Fixture"],
  authors_more: 0,
  repos: [],
};

/** Paper 2's record, as /records/paper/NN.json holds it (the build adds `copies` and `files`). */
export const RECORD_P2 = {
  id: P2,
  slug: slug(P2),
  doi: P2.slice(4),
  title: "A synthetic study whose code has no license",
  journal: { text: "Journal of Synthetic Fixtures", href: "" },
  published: "2026-09-01",
  type: "",
  license: "",
  status: "code_verified",
  notices: [],
  authors: [{ text: "Ben Example", href: "" }],
  institutions: [],
  categories: [],
  code: [{ repo: UNLICENSED, name: "oscr-fixture/unlicensed", url: `https://${UNLICENSED}`, license: "", state: "alive", copies: false, files: ["run.m"] }],
  files: 1,
  pairs: 0,
  map: "",
  datasets: [],
  data: [],
  tools: [],
  europepmc: "",
};
export const recordP2 = () => RECORD_P2 as unknown as PaperRecord;

/** A static page: the masthead, then the facts at the top of <main>, then a long body. */
export function staticPage(facts: PaperFacts, filler = 200_000): string {
  const json = JSON.stringify(facts).replace(/</g, "\\u003c");
  return (
    `<!doctype html><html lang="en"><head><title>${facts.title}</title></head><body><header class="masthead">…</header>` +
    `<main><script type="application/json" id="${FACTS_ID}">${json}</script><h1>${facts.title}</h1>` +
    `<p>${"x".repeat(filler)}</p></main></body></html>`
  );
}

/** The fixture's files: papers 1 and 3 static, paper 2 rendered on demand. */
export class MockAssets implements Assets {
  files = new Map<string, string>();
  /** The paths asked, in order. */
  asked: string[] = [];
  /** Bytes the Worker read of each page (a page is read until its facts). */
  read = new Map<string, number>();
  private ready: Promise<void>;

  constructor() {
    this.files.set(`/paper/${FACTS_P1.slug}/`, staticPage(FACTS_P1));
    this.files.set(`/paper/${FACTS_P3.slug}/`, staticPage(FACTS_P3));
    this.ready = shardOf(RECORD_P2.slug, SHARDS.paper).then((shard) => {
      this.files.set(`/records/paper/${shard}.json`, JSON.stringify({ [RECORD_P2.slug]: RECORD_P2 }));
    });
  }

  async fetch(input: Request | URL | string): Promise<Response> {
    await this.ready;
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    this.asked.push(path);
    const text = this.files.get(path);
    if (text === undefined) return new Response("Not found", { status: 404 });
    // Served in chunks, as a stream: the reader may stop early.
    const bytes = new TextEncoder().encode(text);
    let at = 0;
    const read = this.read;
    read.set(path, 0);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        const chunk = bytes.slice(at, at + 4096);
        at += chunk.length;
        read.set(path, at);
        controller.enqueue(chunk);
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": path.endsWith(".json") ? "application/json" : "text/html" } });
  }
}
