// The Code ↔ Paper reader's data: what the build writes into a paper's page for the reader's
// browser (src/components/paper/Reader.astro → src/scripts/reader.ts). Pure: the build hands
// it the lot entries it read, the tests hand it their own (tests/reader.test.ts).
//
// Every file of the authors' code is one entry, whether its text is here or not: `why` says
// why it is not ("license": the repository's license does not allow republishing it; "binary":
// the harvester could not read it as text; "missing": not in the lot). A pair joins a paragraph
// of the paper and lines of one of these files (`file`, -1 when the file is not among them).
// Never any text of the paper: only paragraph numbers, section titles and short terms.
import { sourceLines } from "./lines.ts";

/** What the build knows of a repository's files (a lot's entry, oscr/catalog.py). */
export type LotFileIn = {
  path: string;
  language: string;
  kind: string;
  lines: number | null;
  text: string | null;
  truncated: boolean;
  note: string;
  source_url: string;
};
export type RepoIn = {
  repo: string;
  url: string;
  name: string;
  license: string;
  state: string;
  lot: string;
  /** The lot's entry, when files were read. */
  entry?: { commit: string; license: string; published: boolean; files: LotFileIn[] };
};
export type PairIn = {
  pair: number;
  paragraph: number;
  section: string;
  repo: string;
  path: string;
  start_line: number;
  end_line: number;
  score: number | null;
  evidence: string[];
};

export type Why = "" | "license" | "binary" | "missing";
export type ReaderRepo = {
  repo: string;
  name: string;
  url: string;
  lot: string;
  license: string;
  commit: string;
  state: string;
  /** Files were read (a lot entry), and their text may be republished. */
  read: boolean;
  published: boolean;
  /** The harvester's remark on the repository ("repository limit reached …"), if any. */
  note: string;
  /** Where each file is at the source, when every file's address is this plus its path
   *  (`prefix`) or this same address (`same`, an archive): the files then carry none. */
  sourcePrefix: string;
  sourceSame: string;
};
export type ReaderFile = {
  repo: number;
  path: string;
  language: string;
  kind: string;
  lines: number | null;
  /** The size of its text here, in bytes (UTF-8); null when the text is not here. */
  bytes: number | null;
  text: boolean;
  truncated: boolean;
  why: Why;
  note: string;
  /** Its address at the source, when the repository's prefix does not give it. */
  source: string;
  pairs: number[];
};
export type ReaderPair = {
  pair: number;
  paragraph: number;
  file: number;
  repo: string;
  path: string;
  start: number;
  end: number;
  /** The lines at the source (a forge's #L10-L20), or the file there. */
  source: string;
  label: string;
  evidence: string[];
  score: number | null;
};
export type ReaderData = {
  fulltextId: string;
  doiUrl: string;
  epmcUrl: string;
  method: string;
  repos: ReaderRepo[];
  files: ReaderFile[];
  pairs: ReaderPair[];
  /** The file shown first, its lines written into the page by the build; -1: none. */
  initial: number;
  /** Whether the text of the file shown first ends with a new line (the page's lines do not say). */
  initialEol: boolean;
};

/** A path as an address: each part percent-encoded, the slashes kept. */
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Where a file is at the source. */
export function sourceOf(repo: Pick<ReaderRepo, "url" | "sourcePrefix" | "sourceSame">, file: Pick<ReaderFile, "path" | "source">): string {
  if (file.source) return file.source;
  if (repo.sourceSame) return repo.sourceSame;
  if (repo.sourcePrefix) return repo.sourcePrefix + encodePath(file.path);
  return repo.url;
}

/** The files of a repository at the source: one address for all (an archive), a prefix, or
 *  neither; the files whose address is not given by it keep their own. */
function sourceRule(files: LotFileIn[]): { prefix: string; same: string } {
  const urls = files.map((f) => f.source_url).filter(Boolean);
  if (!urls.length) return { prefix: "", same: "" };
  if (urls.length === files.length && urls.every((u) => u === urls[0]) && files.length > 1) return { prefix: "", same: urls[0] };
  const first = files.find((f) => f.source_url && f.source_url.endsWith(encodePath(f.path)));
  if (!first) return { prefix: "", same: "" };
  return { prefix: first.source_url.slice(0, first.source_url.length - encodePath(first.path).length), same: "" };
}

/** Why a file's text is not here. */
function whyOf(published: boolean, f: LotFileIn): Why {
  if (!published) return "license";
  if (f.text !== null) return "";
  return /binary/i.test(f.note) ? "binary" : "missing";
}

/** The reader's files, from the repositories' lot entries. */
export function readerFiles(repos: RepoIn[]): { repos: ReaderRepo[]; files: ReaderFile[]; texts: Map<number, string> } {
  const outRepos: ReaderRepo[] = [];
  const files: ReaderFile[] = [];
  const texts = new Map<number, string>();
  repos.forEach((r, i) => {
    const e = r.entry;
    const list = (e?.files ?? []).filter((f) => f.kind !== "note");
    const rule = sourceRule(list);
    outRepos.push({
      repo: r.repo,
      name: r.name,
      url: r.url,
      lot: r.lot,
      license: r.license || e?.license || "",
      commit: e?.commit ?? "",
      state: r.state,
      read: !!e && list.length > 0,
      published: !!e?.published,
      note: e?.files.find((f) => f.kind === "note")?.note ?? "",
      sourcePrefix: rule.prefix,
      sourceSame: rule.same,
    });
    for (const f of list) {
      const derived = rule.same || (rule.prefix ? rule.prefix + encodePath(f.path) : "");
      const index = files.length;
      const text = e?.published ? f.text : null;
      files.push({
        repo: i,
        path: f.path,
        language: f.language,
        kind: f.kind,
        lines: f.lines,
        bytes: text !== null ? new TextEncoder().encode(text).length : null,
        text: text !== null,
        truncated: !!f.truncated,
        why: whyOf(!!e?.published, f),
        note: f.note,
        source: f.source_url && f.source_url !== derived ? f.source_url : "",
        pairs: [],
      });
      if (text !== null) texts.set(index, text);
    }
  });
  return { repos: outRepos, files, texts };
}

/** The pairs, each tied to its file (whose `pairs` lists it), in the order of their numbers. */
export function mapPairs(pairs: PairIn[], repos: ReaderRepo[], files: ReaderFile[]): ReaderPair[] {
  const index = new Map(files.map((f, i) => [`${repos[f.repo].repo}\u0000${f.path}`, i]));
  return [...pairs]
    .sort((x, y) => x.pair - y.pair)
    .map((p) => {
      const file = index.get(`${p.repo}\u0000${p.path}`) ?? -1;
      const f = files[file];
      if (f) f.pairs.push(p.pair);
      const at = f ? sourceOf(repos[f.repo], f) : repos.find((r) => r.repo === p.repo)?.url ?? "";
      return {
        pair: p.pair,
        paragraph: p.paragraph,
        file,
        repo: p.repo,
        path: p.path,
        start: p.start_line,
        end: p.end_line,
        source: f ? sourceLines(at, p.start_line, p.end_line) : at,
        label: `§ ${p.section || `paragraph ${p.paragraph}`}`,
        evidence: p.evidence ?? [],
        score: typeof p.score === "number" ? p.score : null,
      };
    });
}

/** The file shown first: the one with the most pairs (the earliest pair breaks a tie), else the
 *  first script whose text is here, else any file whose text is here, else the first file. */
export function initialFile(files: ReaderFile[]): number {
  let best = -1;
  files.forEach((f, i) => {
    if (!f.pairs.length) return;
    const b = files[best];
    if (!b || f.pairs.length > b.pairs.length || (f.pairs.length === b.pairs.length && Math.min(...f.pairs) < Math.min(...b.pairs))) best = i;
  });
  if (best >= 0) return best;
  const script = files.findIndex((f) => f.text && f.kind === "script");
  if (script >= 0) return script;
  const any = files.findIndex((f) => f.text);
  return any >= 0 ? any : files.length ? 0 : -1;
}

/** The address of a file in the reader: `/paper/<slug>/?path=…` (and `repo=` when the paper
 *  has several repositories), with an anchor ("#L10-L20", "#code"). */
export function fileHref(base: string, repo: string, path: string, multi: boolean, anchor = ""): string {
  const q = new URLSearchParams(multi ? { repo, path } : { path });
  return `${base}?${q.toString()}${anchor ? `#${anchor}` : ""}`;
}
