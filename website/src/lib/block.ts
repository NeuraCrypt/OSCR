// Block identifiers (oscr/blocks.py, docs/PLAN_BLOCK_IDS.md): a citable, permanent identifier for a
// block of the authors' code linked to a paper, `oscr:b:` + 13 characters of Crockford's base32 + "-"
// + an ISO 7064 MOD 37,36 check character. The Mac computes it from the paper's DOI, the Software
// Heritage identifier (SWHID) of the file's ORIGINAL content (the bytes whose SHA-256 the registry
// verified, before any email address is masked for display) and the lines; the site never computes
// it, it reads it: on each match (src/data/alignments/), and in the DOI lookup's shards
// (/lookup/NN.json, under its own key, in the shard of its SHA-1), from which the Worker answers
// /b/<id> and /b/<id>.json (worker/block.ts). Pure: shared by the Worker, the reader and the tests.
import { blockPath, normalize } from "./blockid.ts";
import { esc, type View } from "./render.ts";
import { qualifiedSwhid } from "./swhid.ts";

export { BLOCK_ID, blockPath, checkChar, normalize, PREFIX } from "./blockid.ts";

/** A block's entry, as the export writes it (oscr/blocks.py `entry`). */
export type BlockEntry = {
  status: "current" | "superseded" | "withdrawn";
  doi: string;
  since: string;
  page?: string;
  repo?: string;
  commit?: string;
  path?: string;
  swhid?: string;
  lines?: [number, number];
  symbol?: string;
  paragraphs?: [number, string][];
  method?: string;
  origin?: "machine" | "author";
  next?: string;
};

/** Only the known fields, of the expected types: what a shard says is data, never markup. */
export function cleanEntry(e: unknown): BlockEntry | null {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const x = e as Record<string, unknown>;
  const str = (v: unknown, n = 500) => (typeof v === "string" ? v.slice(0, n) : "");
  const status = x.status === "current" || x.status === "superseded" || x.status === "withdrawn" ? x.status : null;
  const doi = str(x.doi, 300);
  if (!status || !/^10\.\S+$/.test(doi)) return null;
  const out: BlockEntry = { status, doi, since: /^\d{4}-\d{2}-\d{2}$/.test(str(x.since)) ? str(x.since) : "" };
  if (/^[a-z0-9._-]+$/.test(str(x.page, 300))) out.page = str(x.page, 300);
  if (status === "withdrawn") return out;
  const lines = Array.isArray(x.lines) && x.lines.length === 2 && x.lines.every((n) => Number.isInteger(n) && n > 0) ? (x.lines as [number, number]) : null;
  if (!lines || !/^swh:1:cnt:[0-9a-f]{40}$/.test(str(x.swhid))) return null;
  Object.assign(out, {
    repo: str(x.repo, 300),
    commit: /^[0-9a-f]{40}$/.test(str(x.commit)) ? str(x.commit) : "",
    path: str(x.path, 500),
    swhid: str(x.swhid),
    lines,
    symbol: str(x.symbol, 200),
    paragraphs: (Array.isArray(x.paragraphs) ? x.paragraphs : [])
      .filter((p): p is [number, string] => Array.isArray(p) && Number.isInteger(p[0]) && typeof p[1] === "string")
      .map(([n, s]) => [n, s.slice(0, 80)] as [number, string])
      .slice(0, 50),
    method: str(x.method, 40),
    origin: x.origin === "author" ? "author" : "machine",
  });
  const next = normalize(str(x.next, 40));
  if (status === "superseded" && next) out.next = next;
  return out;
}

/** The repository's address at its source (github.com/o/r → https://github.com/o/r). */
function repoUrl(repo: string): string {
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/\S+$/i.test(repo)) return `https://${repo}`;
  const zenodo = repo.match(/^zenodo:(\d+)$/);
  if (zenodo) return `https://zenodo.org/records/${zenodo[1]}`;
  const doi = repo.match(/^doi:(10\.\S+)$/);
  return doi ? `https://doi.org/${doi[1]}` : "";
}

/** The page of a paper's reader at the block's lines, or the paper's page. */
export function readerHref(e: BlockEntry): string {
  if (!e.page) return `https://doi.org/${e.doi}`;
  if (!e.path || !e.lines) return `/paper/${e.page}/`;
  return `/paper/${e.page}/?path=${encodeURIComponent(e.path)}#L${e.lines[0]}-L${e.lines[1]}`;
}

/** What a block is, in JSON (/b/<id>.json): its entry, its identifier and addresses. */
export function blockJson(id: string, e: BlockEntry, origin: string): Record<string, unknown> {
  const out: Record<string, unknown> = { id, url: `${origin}${blockPath(id)}`, ...e, paper: `https://doi.org/${e.doi}` };
  if (e.status !== "withdrawn" && e.swhid && e.path && e.lines) {
    out.swhid_qualified = qualifiedSwhid({
      swhid: e.swhid, origin: repoUrl(e.repo ?? ""), commit: e.commit ?? "", path: e.path, range: { start: e.lines[0], end: e.lines[1] },
    });
    out.reader = `${origin}${readerHref(e)}`;
  }
  if (e.next) out.next_url = `${origin}${blockPath(e.next)}`;
  return out;
}

const STATUS_WORDS: Record<BlockEntry["status"], string> = {
  current: "Current: the registry links these lines to the paper today.",
  superseded: "Superseded: the registry no longer links these exact lines to the paper (the code or the match changed). The identifier stays, and names what it named.",
  withdrawn: "Withdrawn: the paper left the registry, or a removal request withheld this code or this map. The identifier stays; its code is no longer shown.",
};

/** A block's page: what it names, where, and how to cite it. Every text is escaped. */
export function blockView(id: string, e: BlockEntry, siteName: string): View {
  const rows: string[] = [];
  const row = (term: string, value: string) => rows.push(`<dt>${esc(term)}</dt><dd>${value}</dd>`);
  row("Identifier", `<code>${esc(id)}</code>`);
  row("Status", esc(STATUS_WORDS[e.status]));
  row("Paper", `<a href="https://doi.org/${esc(e.doi)}">doi:${esc(e.doi)}</a>${e.page ? ` · <a href="/paper/${esc(e.page)}/">its page here</a>` : ""}`);
  if (e.status !== "withdrawn" && e.path && e.lines && e.swhid) {
    const url = repoUrl(e.repo ?? "");
    row("Code", `${url ? `<a href="${esc(url)}">${esc(e.repo)}</a>` : esc(e.repo)}, <code>${esc(e.path)}</code>, lines ${e.lines[0]} to ${e.lines[1]}${e.symbol ? ` (<code>${esc(e.symbol)}</code>)` : ""}`);
    if (e.commit) row("Commit read", `<code>${esc(e.commit)}</code>`);
    const qualified = qualifiedSwhid({ swhid: e.swhid, origin: url, commit: e.commit ?? "", path: e.path, range: { start: e.lines[0], end: e.lines[1] } });
    row("SWHID", `<code>${esc(qualified || e.swhid)}</code> <span class="muted">(the Software Heritage identifier of the file as its authors published it, before any email address is hidden for display; it opens in Software Heritage's archive once the repository is archived there)</span>`);
    const paragraphs = (e.paragraphs ?? []).map(([n, s]) => `paragraph ${n}${s ? ` (${esc(s)})` : ""}`).join("; ");
    if (paragraphs) row("In the paper", paragraphs);
    row("Linked by", e.origin === "author" ? "an author of the paper" : `the registry's matching program (${esc(e.method || "lexical")}), which can be wrong`);
  }
  if (e.since) row("Identifier given", esc(e.since));
  if (e.next) row("Replaced by", `<a href="${esc(blockPath(e.next))}"><code>${esc(e.next)}</code></a>`);
  const open = e.status !== "withdrawn" && e.page ? `<p><a href="${esc(readerHref(e))}">Open these lines beside the paper</a></p>` : "";
  const html =
    `<h1>Block <code>${esc(id)}</code></h1>` +
    `<p class="summary">A block of code linked to a paper, with an identifier ${esc(siteName)} gives it for good: it is never reused nor deleted. <a href="/help/reader/#block-ids">What a block identifier is</a> · <a href="${esc(blockPath(id))}.json">this block in JSON</a></p>` +
    `<dl class="facts">${rows.join("")}</dl>` + open;
  return {
    title: `Block ${id}`,
    description: e.status === "withdrawn" ? `A withdrawn block of code of the paper doi:${e.doi}.` : `Lines ${e.lines?.[0]} to ${e.lines?.[1]} of ${e.path}, linked to the paper doi:${e.doi}.`,
    crumb: "Block",
    html,
  };
}
