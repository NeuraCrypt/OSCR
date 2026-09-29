// Tracing maps in the /r/ shell's code views (night phase 02, E4): a traced file's lines in the
// reader's colours, a note of the paragraphs they carry out, "explain these lines" in the line
// menu, and on a commit's page the map links whose lines it changed. No model runs: the words are
// the maps' own links (src/lib/traced.ts).
//
// What it costs: the repository's shard, /forge/traced/NN.json (a file of this site: no Worker
// request, no GitHub quota), read once per page; at another commit than a map's, the file at the
// map's commit (and, for a commit's page, at its parent): raw reads, not counted in the reader's
// 60 anonymous requests an hour.

import { maskEmails } from "../../worker/forge/mask.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { textLines } from "../lib/code-nav.ts";
import { layerShard } from "../lib/forge.ts";
import { parsePatch } from "../lib/history.ts";
import {
  commitTouches,
  explainLines,
  hunksTouch,
  lineMarks,
  type Located,
  locate,
  locateBySymbol,
  relocate,
  type Touched,
  type TracedMap,
  tracedNote,
  tracedUrl,
} from "../lib/traced.ts";
import { blobNotes, type CodeEnv, lineMarkers, lineMenuExtras, type Opened, repoRef } from "./repo-code.ts";
import { commitExtras } from "./repo-history.ts";

/** A map read from a shard, checked (the file is the site's own, read defensively all the same). */
function validMap(x: unknown): x is TracedMap {
  const m = x as TracedMap;
  return (
    !!m &&
    typeof m.paper === "string" &&
    typeof m.title === "string" &&
    typeof m.doi === "string" &&
    /^[0-9a-f]{40}$/.test(m.commit) &&
    Array.isArray(m.pairs) &&
    m.pairs.every((p) => Number.isInteger(p.pair) && typeof p.path === "string" && Number.isInteger(p.start) && Number.isInteger(p.end) && typeof p.section === "string" && Number.isInteger(p.paragraph) && typeof p.symbol === "string")
  );
}

let maps: Promise<TracedMap[]> | null = null;

/** The maps of the repository the page shows (none when its shard cannot be read). Phase 07: the
 *  release form's notes name the map links a release's changes touch. */
export function mapsOf(env: Pick<CodeEnv, "repo">): Promise<TracedMap[]> {
  maps ??= (async () => {
    try {
      const shard = await layerShard(env.repo.owner, env.repo.name);
      const r = await fetch(tracedUrl(shard), { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!r.ok) return [];
      const all = (await r.json()) as Record<string, unknown>;
      const mine = all[`${env.repo.owner}/${env.repo.name}`.toLowerCase()];
      return Array.isArray(mine) ? mine.filter(validMap) : [];
    } catch {
      return [];
    }
  })();
  return maps;
}

/** A file's lines at a commit, masked as the viewer shows them; null when it cannot be read. */
async function linesAt(env: CodeEnv, commit: string, path: string): Promise<string[] | null> {
  try {
    const f = await env.session.git.readFile(repoRef(env), commit, path, { maxBytes: 1024 * 1024 });
    if (f.binary || f.lfs) return null;
    return textLines(maskEmails(utf8Text(f.bytes)));
  } catch {
    return null;
  }
}

/** The pairs located in the file the page shows, kept for the line menu. */
const located = new Map<string, Promise<Located[]>>();
const settled = new Map<string, Located[]>();
const keyOf = (commit: string, path: string) => `${commit}:${path}`;

function locatedIn(env: CodeEnv, opened: Opened, path: string, lines: readonly string[]): Promise<Located[]> {
  const key = keyOf(opened.commit, path);
  let p = located.get(key);
  if (!p) {
    p = (async () => {
      const all = (await mapsOf(env)).filter((m) => m.pairs.some((x) => x.path === path));
      if (!all.length) return [];
      const found = await locate(all, path, opened.commit, lines, (commit) => linesAt(env, commit, path));
      settled.set(key, found);
      return found;
    })();
    located.set(key, p);
  }
  return p;
}

lineMarkers.push(async (env, opened, path, lines) => lineMarks(await locatedIn(env, opened, path, lines)));

/** The map links on a file at a commit (phase 03: the commit dialog's notice of the links a change
 *  touches). `lines`: the file's lines at that commit, as the viewer shows them. */
export function mapLinksIn(env: CodeEnv, commit: string, path: string, lines: readonly string[]): Promise<Located[]> {
  return locatedIn(env, { commit } as Opened, path, lines);
}
blobNotes.push(async (env, opened, path, lines) => tracedNote(await locatedIn(env, opened, path, lines), opened.commit));
lineMenuExtras.push(({ opened, path, selection }) => explainLines(settled.get(keyOf(opened.commit, path)) ?? [], selection));

// ─── a commit's page ─────────────────────────────────────────────────────────

/** The map links on the files a change touches (a commit against its parent, a pull request against
 *  its merge base: `parent`), and whether it changed their lines. */
export async function changeTouches(env: CodeEnv, files: readonly T.FileChangeSummary[], parent: string): Promise<Touched[]> {
  const all = await mapsOf(env);
  if (!all.length) return [];
  const touched: Touched[] = [];
  for (const f of files) {
    const oldPath = f.previousPath ?? f.path;
    const onFile = all.filter((m) => m.pairs.some((p) => p.path === oldPath));
    if (!onFile.length || f.status === "added") continue;
    const hunks = parsePatch(f.patch);
    let before: string[] | null | undefined;
    for (const map of onFile) {
      const atMap = map.commit === parent ? null : await linesAt(env, map.commit, oldPath);
      for (const pair of map.pairs.filter((p) => p.path === oldPath)) {
        if (f.status === "removed") {
          touched.push({ map, pair, path: oldPath, state: "changed" });
          continue;
        }
        let r: { start: number; end: number } | null = { start: pair.start, end: pair.end };
        if (map.commit !== parent) {
          before ??= await linesAt(env, parent, oldPath);
          r = before ? (atMap ? relocate(atMap, before, pair.start, pair.end) : locateBySymbol(before, pair.start, pair.end, pair.symbol)) : null;
        }
        const state = !r || (f.patch === null && f.status !== "renamed") ? "unknown" : hunksTouch(hunks, r) ? "changed" : "kept";
        touched.push({ map, pair, path: oldPath, state });
      }
    }
  }
  return touched;
}

/** The maps of the repository the page shows (phase 04: a pull request's files). */
export const tracedMaps = (env: Pick<CodeEnv, "repo">): Promise<TracedMap[]> => mapsOf(env);

/** The map links on the files a commit changed, and whether it changed their lines. */
commitExtras.push(async (env: CodeEnv, commit: T.CommitDetail) => {
  const parent = commit.parents[0];
  if (!parent) return null;
  return commitTouches(await changeTouches(env, commit.files.items, parent));
});
