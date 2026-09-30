// The Code ↔ Paper reader's data: what the build writes into a paper's page for the reader's
// browser (src/components/paper/Reader.astro → src/scripts/reader.ts). Pure: the build hands
// it the lot entries it read, the tests hand it their own (tests/reader.test.ts).
//
// Every file of the authors' code is one entry, whether its text is here or not: `why` says
// why it is not ("license": the repository's license does not allow republishing it; "binary":
// the harvester could not read it as text; "missing": not in the lot; "withheld": its copy was
// withheld at a removal request). A pair joins a paragraph
// of the paper and lines of one of these files (`file`, -1 when the file is not among them).
// Never any text of the paper: only paragraph numbers, section titles and short terms.
//
// A file held back for its license ("license") may carry its digest (`sha256`), its size, and its
// repository where the reader's browser fetches it itself, at the pinned version (`source`,
// lib/source.ts): it is then shown from its source, never from a copy.
import { sourceLines, splitLines, wholeFile } from "./lines.ts";
import { cannotWords, sourceFacts, type SourceFacts } from "./source.ts";

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
  /** A file OSCR has a copy of: the SHA-256 of its original bytes, their number, and the lot its
   *  text lives in (`text_lot`, keyed by sha256). "swh" when only Software Heritage can fetch it as
   *  a fallback. A withheld, binary, note or digest-less file carries none. */
  sha256?: string;
  size?: number | null;
  text_lot?: string;
  via?: string;
};
export type RepoIn = {
  repo: string;
  url: string;
  name: string;
  license: string;
  state: string;
  lot: string;
  /** The lot's entry, when files were read. */
  entry?: { commit: string; license: string; published: boolean; files: LotFileIn[]; source?: unknown; redistributable?: string };
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

export type Why = "" | "license" | "binary" | "missing" | "withheld";
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
  /** Where the reader's browser fetches its files itself, when it is held back for its license
   *  (lib/source.ts); null otherwise. */
  source: SourceFacts | null;
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
  /** A file OSCR has a copy of: the SHA-256 of its bytes ("" when unknown or withheld) and the lot
   *  its text lives in (`textLot`, keyed by that sha256); the reader fetches it from there. "swh"
   *  when only Software Heritage can fetch it as a fallback. */
  sha256: string;
  textLot: string;
  via: string;
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
  /** The titles of its paragraph's sections ("Methods › Spike sorting"), as the harvester read them. */
  section: string;
  /** The lines at the source (a forge's #L10-L20), or the file there. */
  source: string;
  label: string;
  evidence: string[];
  score: number | null;
  /** The range is the whole file, or nearly: a weak match (its lines are not tinted). */
  whole: boolean;
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
  /** The paper's id (its removal request's page) and the platform's name, for the words of a file
   *  shown from its source. */
  paperId: string;
  site: string;
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
  // A copy withheld at a removal request (catalog.NOTE_WITHHELD), a repository's or one file's.
  if (f.text === null && /removal request/i.test(f.note)) return "withheld";
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
      // The source is a graceful FALLBACK now (the reader fetches a copy's text from its digest lot;
      // the source is used only when a lot unexpectedly lacks it): kept whenever the export gives it.
      source: e ? sourceFacts(e.source) : null,
    });
    for (const f of list) {
      const derived = rule.same || (rule.prefix ? rule.prefix + encodePath(f.path) : "");
      const index = files.length;
      const text = e?.published ? f.text : null;
      const why = whyOf(!!e?.published, f);
      const digest = typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : "";
      // OSCR has a copy iff the file has a text lot; the reader fetches its text from there by sha256.
      const copy = text !== null && !!digest && !!f.text_lot;
      const held = why === "license" && !!digest;               // a legacy "shown from the source" file
      files.push({
        repo: i,
        path: f.path,
        language: f.language,
        kind: f.kind,
        lines: f.lines ?? (text !== null ? splitLines(text).length : null),
        bytes: text !== null ? new TextEncoder().encode(text).length : (copy || held) && typeof f.size === "number" ? f.size : null,
        text: text !== null,
        truncated: !!f.truncated,
        why,
        note: f.note,
        source: f.source_url && f.source_url !== derived ? f.source_url : "",
        sha256: copy || held ? digest : "",
        textLot: copy ? f.text_lot! : "",
        via: (copy || held) && f.via === "swh" ? "swh" : "",
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
        section: p.section ?? "",
        source: f ? sourceLines(at, p.start_line, p.end_line) : at,
        label: `§ ${p.section || `paragraph ${p.paragraph}`}`,
        evidence: p.evidence ?? [],
        score: typeof p.score === "number" ? p.score : null,
        whole: !!f && wholeFile(p.start_line, p.end_line, f.lines),
      };
    });
}

/** A file the reader's browser may fetch from its source (its digest to check it against, in a
 *  repository whose files can be fetched): the fallback used when a digest lot lacks a copy's text,
 *  and the legacy "shown from the source" path. */
export const fromSource = (repos: readonly Pick<ReaderRepo, "source">[], f: Pick<ReaderFile, "why" | "sha256" | "repo">) =>
  f.sha256 !== "" && !!repos[f.repo]?.source?.via;

/** The file shown first: the one with the most pairs (the earliest pair breaks a tie), else the
 *  first script whose text is here (or can be shown from its source), else any such file, else the
 *  first file. */
export function initialFile(files: ReaderFile[], repos: readonly Pick<ReaderRepo, "source">[] = []): number {
  let best = -1;
  files.forEach((f, i) => {
    if (!f.pairs.length) return;
    const b = files[best];
    if (!b || f.pairs.length > b.pairs.length || (f.pairs.length === b.pairs.length && Math.min(...f.pairs) < Math.min(...b.pairs))) best = i;
  });
  if (best >= 0) return best;
  const readable = (f: ReaderFile) => f.text || fromSource(repos, f);
  const script = files.findIndex((f) => readable(f) && f.kind === "script");
  if (script >= 0) return script;
  const any = files.findIndex(readable);
  return any >= 0 ? any : files.length ? 0 : -1;
}

/** The address of a file in the reader: `/paper/<slug>/?path=…` (and `repo=` when the paper
 *  has several repositories), with an anchor ("#L10-L20", "#code"). */
export function fileHref(base: string, repo: string, path: string, multi: boolean, anchor = ""): string {
  const q = new URLSearchParams(multi ? { repo, path } : { path });
  return `${base}?${q.toString()}${anchor ? `#${anchor}` : ""}`;
}

/** Why a file's text is not shown here, in a sentence (`failure`: why it could not be loaded). */
export function whyNotShown(
  f: Pick<ReaderFile, "why" | "note" | "path"> & Partial<Pick<ReaderFile, "sha256">>,
  r: Pick<ReaderRepo, "license"> & Partial<Pick<ReaderRepo, "source">>,
  failure = "",
): string {
  if (failure) return `This file could not be loaded here (${failure}).`;
  if (f.why === "withheld") return "This file is not shown here: it was withheld at a removal request.";
  if (f.why === "license" && f.sha256 && r.source?.via) {
    return r.license
      ? `The registry keeps no copy of this file: the license of its repository (${r.license}) is not one it has verified to allow it. Your browser shows it from its source, with JavaScript.`
      : "The registry keeps no copy of this file: its repository has no license, so its authors keep all their rights to it. Your browser shows it from its source, with JavaScript.";
  }
  if (f.why === "license") {
    // Why the browser does not show it from its source either (an OSF project, PMC's files…).
    const also = r.source && !r.source.via ? ` Your browser cannot show it from its source either: ${cannotWords(r.source.why ?? "")}.` : "";
    return r.license
      ? `This file is not shown here: the license of its repository (${r.license}) is not one the registry has verified to allow republishing it.${also}`
      : `This file is not shown here: its repository has no license, so its authors keep all their rights to it.${also}`;
  }
  if (f.why === "binary") {
    return /\.mlx$/i.test(f.path)
      ? "This file is not shown here: a MATLAB live script is a binary file (a zip archive), not text."
      : "This file is not shown here: it is not a text file.";
  }
  if (/too large a repository/i.test(f.note)) {
    return "This file is not shown here: its repository is too large for the registry to keep the text of every file, and this one was left out.";
  }
  if (/too much text/i.test(f.note)) {
    return "This file is not shown here: the registry keeps a bounded amount of text for each group of repositories, and this file did not fit.";
  }
  const note = f.note.replace(/[\s:;,.]*(read it at the source|readable (only )?at the source( only)?)[.]?$/i, "").trim();
  return `This file is not shown here: ${note || "its text was not kept"}.`;
}

/** Why one would go to the source, said in the menu that leads there: the copy shown here is
 *  the one the registry read; the source has the authors' latest version and its history. */
export function sourceWhy(commit: string, shown: boolean | "source"): string {
  const at = commit ? ` at commit ${commit.slice(0, 7)}` : "";
  if (shown === "source") return `Shown here from its source${at}, fetched by your browser: the registry keeps no copy of it. The source has the authors' latest version and its history.`;
  return shown
    ? `Shown here as the registry read it${at}. The source has the authors' latest version and its history.`
    : `Not shown here${at ? ` (read${at})` : ""}. The source has the file, the authors' latest version and its history.`;
}
