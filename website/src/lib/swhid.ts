// A citable identifier for a piece of the authors' code: the file's Software Heritage identifier
// (SWHID, https://www.swhid.org), computed by the Mac's export from the text whose SHA-256 the
// registry verified (oscr/catalog.py `content_swhid`, the same hash as `git hash-object`), with its
// context qualifiers: where it was found (origin), at which commit (anchor), its path, and the lines
// selected. Pure: shared by the build (src/components/paper/Reader.astro), the reader's browser
// (src/scripts/code-view.ts) and the tests (tests/swhid.test.ts).
//
// The identifier is the content's own: it names the same bytes wherever they are. It opens in
// Software Heritage's archive only once Software Heritage has archived them (the nightly asks it to
// save the repositories linked from a paper, oscr/outreach.py `swh_save`): the pages say so.
import type { Range } from "./code.ts";

export const CONTENT_SWHID = /^swh:1:cnt:[0-9a-f]{40}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** Software Heritage's address for an identifier. */
export const SWH_ARCHIVE = "https://archive.softwareheritage.org/";

/** A qualifier's value: the SWHID grammar reserves ";" (and "%", its escape); white space and
 *  control characters are percent-encoded too. */
const qualifier = (value: string) => value.replace(/[%;\s\u0000-\u001f\u007f]/gu, (c) => encodeURIComponent(c));

export type SwhidContext = {
  /** The file's content identifier, `swh:1:cnt:…` (anything else gives ""). */
  swhid: string;
  /** The repository's address, where Software Heritage found (or will find) it. */
  origin: string;
  /** The commit the registry read (a git commit's 40 hex digits; anything else is left out). */
  commit: string;
  path: string;
  range: Range | null;
};

/** The identifier with its context: `swh:1:cnt:…;origin=…;anchor=swh:1:rev:…;path=/…;lines=10-25`. */
export function qualifiedSwhid(c: SwhidContext): string {
  if (!CONTENT_SWHID.test(c.swhid)) return "";
  const parts = [c.swhid];
  if (/^https?:\/\//.test(c.origin)) parts.push(`origin=${qualifier(c.origin)}`);
  if (COMMIT.test(c.commit)) parts.push(`anchor=swh:1:rev:${c.commit}`);
  if (c.path) parts.push(`path=${qualifier(c.path.startsWith("/") ? c.path : `/${c.path}`)}`);
  if (c.range) parts.push(`lines=${c.range.start}${c.range.end > c.range.start ? `-${c.range.end}` : ""}`);
  return parts.join(";");
}

/** When the identifier opens in Software Heritage's archive, in one sentence. */
export const ARCHIVE_WHY =
  "Its SWHID names this exact content; it opens in Software Heritage's archive only once Software Heritage has archived the repository.";

/** The identifier's page in Software Heritage's archive (it opens once the content is archived). */
export const archiveUrl = (qualified: string) => (qualified ? SWH_ARCHIVE + qualified : "");

/** The lines in words: "lines 10 to 25", "line 7", "" for the whole file. */
const linesWords = (r: Range | null) => (!r ? "" : r.end > r.start ? `lines ${r.start} to ${r.end}` : `line ${r.start}`);

/** A citation to copy: what, where, at which version, its SWHID and the registry's link to it. */
export function citation(c: SwhidContext & { repoName: string; link: string }): string {
  const id = qualifiedSwhid(c);
  if (!id) return "";
  const what = [c.path, linesWords(c.range)].filter(Boolean).join(", ");
  const version = COMMIT.test(c.commit) ? `, commit ${c.commit}` : "";
  return [`${what}, in ${c.repoName} (${c.origin})${version}.`, `SWHID: ${id}`, c.link].join("\n");
}
