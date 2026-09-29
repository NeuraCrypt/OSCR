// "Shown from the source" (decided 2026-09-29; docs/SCRIPT_STORAGE.md, /policies/code/): a file of the
// authors' code whose license does not allow copying it is never copied by the registry — no text in
// the site's lots, its open data or its Hugging Face dataset. The reader's own browser fetches it from
// where its authors published it, at the version the registry verified (a commit, a Zenodo record),
// checks that its SHA-256 is the one the registry's machine computed from the same bytes, and only
// then shows it, its email addresses masked as the export masks them (catalog.mask_emails).
//
// Pure, but for `fetchVerified`, which is given the way to fetch: the reader's browser
// (src/scripts/reader.ts) and the tests (tests/source.test.ts, with the export's own cases in
// tests/fixtures/mask_emails.json) share it. Nothing here names the platform.

/** A path as an address: each part percent-encoded, the slashes kept (lib/reader.ts's encodePath). */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The places a reader's browser fetches a file from (catalog.SOURCE_TEMPLATES): the only origins
 *  outside the site that a paper's page may connect to besides Europe PMC and NCBI
 *  (public/_headers, worker/pages.ts; a test checks that the three agree). */
export const SOURCE_ORIGINS = [
  "https://raw.githubusercontent.com",
  "https://gitlab.com",
  "https://bitbucket.org",
  "https://codeberg.org",
  "https://huggingface.co",
  "https://zenodo.org",
  "https://archive.softwareheritage.org",
] as const;

/** A file past this size is not fetched (catalog.SOURCE_MAX_BYTES). */
export const SOURCE_MAX_BYTES = 1_000_000;
/** How long a fetch may take before it is given up. */
export const SOURCE_TIMEOUT_MS = 20_000;
/** Software Heritage, by digest: for a file that its repository's host does not give by itself. */
export const SWH_TEMPLATE = "https://archive.softwareheritage.org/api/1/content/sha256:{sha256}/raw/";

export type Via = "github" | "gitlab" | "bitbucket" | "codeberg" | "huggingface" | "zenodo" | "swh";
export const VIAS: readonly Via[] = ["github", "gitlab", "bitbucket", "codeberg", "huggingface", "zenodo", "swh"];
/** The place, as a reader names it. */
export const PLACES: Readonly<Record<Via, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  codeberg: "Codeberg",
  huggingface: "Hugging Face",
  zenodo: "Zenodo",
  swh: "Software Heritage",
};

/** Where a repository's files are fetched (catalog.source_of): a template and the pinned version, or
 *  why they cannot be. */
export type SourceFacts = { via: Via | ""; url?: string; at?: string; why?: string };

/** Why a repository's files cannot be fetched, in a sentence. */
const CANNOT: Readonly<Record<string, string>> = {
  osf: "OSF does not let the page of another site read its files",
  pmc: "PubMed Central's collection of supplementary files does not let the page of another site read them",
  host: "its host does not let the page of another site read it",
  dead: "its repository no longer answers",
  no_commit: "the registry has no fixed version of it to check it against",
};

const DIGEST = /^[0-9a-f]{64}$/;

/** Why a repository's files cannot be fetched by the browser (a reason of catalog.source_of). */
export const cannotWords = (why: string) => CANNOT[why] ?? CANNOT.host;

/** A repository's facts as the export gives them, kept only when they are well formed and name one of
 *  SOURCE_ORIGINS: anything else is "cannot". */
export function sourceFacts(value: unknown): SourceFacts | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.via === "") return { via: "", why: typeof v.why === "string" && Object.hasOwn(CANNOT, v.why) ? v.why : "host" };
  if (typeof v.via !== "string" || !(VIAS as readonly string[]).includes(v.via) || typeof v.url !== "string") return null;
  if (fillTemplate(v.url, "a/b.py", "0".repeat(64)) === "") return { via: "", why: "host" };
  return { via: v.via as Via, url: v.url, at: typeof v.at === "string" ? v.at.slice(0, 64) : "" };
}

/** The address of one file: the template's `{path}` (its slashes kept), `{file}` (encoded) and
 *  `{sha256}` filled; "" when the address would leave SOURCE_ORIGINS, carry credentials, keep a
 *  placeholder, or climb out of the repository. */
export function fillTemplate(template: string, path: string, sha256: string): string {
  if (template.includes("{sha256}") && !DIGEST.test(sha256)) return "";
  // A path never climbs out of its repository ("..", "."), nor starts at the root.
  if (/(^|\/)\.{1,2}(\/|$)/.test(path) || path.startsWith("/")) return "";
  const url = template
    .replace(/\{path\}/g, () => encodePath(path))
    .replace(/\{file\}/g, () => encodeURIComponent(path))
    .replace(/\{sha256\}/g, () => sha256);
  if (/[{}]/.test(url)) return "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" || u.username || u.password || !(SOURCE_ORIGINS as readonly string[]).includes(u.origin)) return "";
  return url;
}

/** What the reader knows of a file it may show from its source. */
export type SourceFile = { path: string; sha256: string; bytes: number | null; via: string };
export type Plan =
  | { ok: true; url: string; via: Via; place: string; at: string; size: number | null }
  | { ok: false; why: string };

/** How to fetch a file of a repository held back for its license, or why the browser cannot. */
export function planOf(source: SourceFacts | null, file: SourceFile): Plan {
  if (!source) return { ok: false, why: CANNOT.host };
  if (!source.via) return { ok: false, why: CANNOT[source.why ?? "host"] ?? CANNOT.host };
  if (!DIGEST.test(file.sha256)) return { ok: false, why: "the registry has no fingerprint (SHA-256) of this file to check it against" };
  if (file.bytes !== null && file.bytes > SOURCE_MAX_BYTES) {
    return { ok: false, why: `it is too large to be fetched here (${megabytes(file.bytes)}; the limit is ${megabytes(SOURCE_MAX_BYTES)})` };
  }
  const via: Via = file.via === "swh" ? "swh" : (source.via as Via);
  const url = fillTemplate(via === "swh" && source.via !== "swh" ? SWH_TEMPLATE : source.url ?? "", file.path, file.sha256);
  if (!url) return { ok: false, why: CANNOT.host };
  return { ok: true, url, via, place: PLACES[via], at: source.at ?? "", size: file.bytes };
}

const megabytes = (n: number) => `${(n / 1_000_000).toLocaleString("en", { maximumFractionDigits: 1 })} MB`;

// ---------------------------------------------------------------------------------------------
// The text, as the registry's machine reads it (oscr/contents.py).

/** Python's cp1252 codec knows no character for these bytes: the Mac then reads the file as Latin-1. */
const CP1252_HOLES = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/** A binary file, as contents.read decides: a MATLAB live script, or a NUL byte in the first 8,000. */
export function isBinary(path: string, bytes: Uint8Array): boolean {
  return /\.mlx$/i.test(path) || bytes.subarray(0, 8000).includes(0);
}

/** contents.decode: UTF-8 (a byte-order mark dropped), else Windows-1252, else Latin-1. */
export function decodeBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // not UTF-8
  }
  if (!bytes.some((b) => CP1252_HOLES.has(b))) return new TextDecoder("windows-1252").decode(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

/** Python's str.splitlines: every line boundary it knows, and no empty last piece. */
export function pySplitLines(text: string): string[] {
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** contents.notebook_to_text: a Jupyter notebook as text by cells (jupytext's percent format),
 *  without its outputs; the text as it is when it is not JSON. */
export function notebookToText(raw: string): string {
  let nb: unknown;
  try {
    nb = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!nb || typeof nb !== "object" || Array.isArray(nb)) return raw;
  const cells = (nb as { cells?: unknown }).cells;
  const pieces: string[] = [];
  for (const cell of Array.isArray(cells) ? cells : []) {
    if (!cell || typeof cell !== "object") continue;
    const c = cell as { source?: unknown; cell_type?: unknown };
    const s = c.source ?? "";
    const source = Array.isArray(s) ? s.map(String).join("") : typeof s === "string" ? s : pyStr(s);
    if (c.cell_type === "markdown") pieces.push("# %% [markdown]\n" + pySplitLines(source).map((l) => "# " + l).join("\n"));
    else if (c.cell_type === "code") pieces.push("# %%\n" + source);
  }
  return pieces.join("\n\n") + "\n";
}

const pyStr = (v: unknown) => (v === null ? "None" : v === true ? "True" : v === false ? "False" : String(v));

/** The text of a file's bytes, as the registry's machine keeps it: decoded, a notebook by cells. */
export function textOf(path: string, bytes: Uint8Array): string {
  const text = decodeBytes(bytes);
  return /\.ipynb$/i.test(path) ? notebookToText(text) : text;
}

// ---------------------------------------------------------------------------------------------
// Email addresses (catalog.mask_emails, its regular expression ported: Python's \w is Unicode's
// letters and numbers and "_", its final \b a lookahead).

export const EMAIL_MASK = "[email hidden]";
const EMAIL_IN_TEXT = /(?<![\p{L}\p{N}_.+%-])(?!git@)[\p{L}\p{N}_.+%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\p{L}\p{N}_])/gu;

/** The same text, every email address replaced by EMAIL_MASK; its lines as they are, so that the
 *  line numbers and the matches with the paper still hold. */
export function maskEmails(text: string): string {
  return text.includes("@") ? text.replace(EMAIL_IN_TEXT, EMAIL_MASK) : text;
}

// ---------------------------------------------------------------------------------------------
// The fetch.

export type Fetched =
  | { ok: true; text: string; bytes: number; masked: boolean }
  | { ok: false; reason: "large" | "http" | "network" | "timeout" | "mismatch" | "binary"; status?: number };

/** The hexadecimal SHA-256 of some bytes (crypto.subtle: the browser's, Node's). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fetch a file (no cookie, no header of its own: a simple request, which every host above answers),
 *  at most `max` bytes, then check its digest; its text, masked, only when the digest is `sha256`. */
export async function fetchVerified(
  url: string,
  expect: { path: string; sha256: string; size: number | null },
  opts: { fetch?: typeof fetch; max?: number; timeoutMs?: number } = {},
): Promise<Fetched> {
  const max = opts.max ?? SOURCE_MAX_BYTES;
  if (expect.size !== null && expect.size > max) return { ok: false, reason: "large" };
  const go = opts.fetch ?? fetch;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? SOURCE_TIMEOUT_MS);
  let bytes: Uint8Array;
  try {
    const res = await go(url, { credentials: "omit", redirect: "follow", signal: abort.signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return { ok: false, reason: "http", status: res.status };
    }
    const length = Number(res.headers.get("Content-Length") ?? "");
    if (Number.isFinite(length) && length > max) {
      res.body?.cancel().catch(() => {});
      return { ok: false, reason: "large" };
    }
    const read = await readAtMost(res, max);
    if (read === null) return { ok: false, reason: "large" };
    bytes = read;
  } catch {
    return { ok: false, reason: abort.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
  if ((await sha256Hex(bytes)) !== expect.sha256) return { ok: false, reason: "mismatch" };
  if (isBinary(expect.path, bytes)) return { ok: false, reason: "binary" };
  const text = textOf(expect.path, bytes);
  const masked = maskEmails(text);
  return { ok: true, text: masked, bytes: bytes.length, masked: masked !== text };
}

/** A response's body, or null past `max` bytes (the rest is not read). */
async function readAtMost(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.length > max ? null : all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// In words.

/** Where the file shown comes from, at which version. */
export function shownFrom(plan: Extract<Plan, { ok: true }>, repoName: string, repoVia: Via | ""): string {
  const commit = /^[0-9a-f]{40}$/.test(plan.at) ? plan.at.slice(0, 7) : "";
  if (plan.via === "zenodo") return `Shown from Zenodo, record ${plan.at}, whose files never change, where its authors published it.`;
  if (plan.via === "swh") {
    const where = repoVia === "zenodo" ? `the file of Zenodo record ${plan.at}` : commit ? `the file of ${repoName} at commit ${commit}` : `the file of ${repoName}`;
    return `Shown from Software Heritage's archive: the same bytes as ${where}, where its authors published it.`;
  }
  return `Shown from ${plan.place}${commit ? ` at commit ${commit}` : ""}, where its authors published it.`;
}

/** Why the registry keeps no copy of it. */
export function noCopy(site: string, license: string): string {
  const why = license
    ? `the license of this repository (${license}) is not one it has verified to allow redistribution`
    : "this repository has no license that allows redistribution";
  return `${site} keeps no copy: ${why}. Rights remain with its authors.`;
}

/** Why a file could not be shown from its source, in a sentence. */
export function failureWords(reason: Extract<Fetched, { ok: false }>["reason"], plan: Extract<Plan, { ok: true }>, status?: number): string {
  switch (reason) {
    case "mismatch":
      return `This file is not shown: the file ${plan.place} sent is not the one the registry verified (its SHA-256 differs), so neither it nor its matches with the paper are shown here.`;
    case "large":
      return `This file is not shown: it is too large to be fetched here (the limit is ${megabytes(SOURCE_MAX_BYTES)}).`;
    case "binary":
      return "This file is not shown: it is not a text file.";
    case "timeout":
      return `This file is not shown: ${plan.place} did not answer in time.`;
    case "http":
      return status === 404 || status === 410
        ? `This file is not shown: ${plan.place} no longer serves it at this version (HTTP ${status}).`
        : status === 429
          ? `This file is not shown: ${plan.place} asks to wait before it is asked again (HTTP 429).`
          : `This file is not shown: ${plan.place} answered with an error${status ? ` (HTTP ${status})` : ""}.`;
    default:
      return `This file is not shown: your browser could not reach ${plan.place}.`;
  }
}
