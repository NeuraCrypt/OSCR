// Add (or re-pin) a scientific tool, BY HAND, from its GitHub repository (src/lib/scitools.ts):
//
//   npm run scitool:add -- https://github.com/<owner>/<name> [--ref <branch|tag>] [--slug <slug>]
//                          [--name <name>] [--description <text>] [--homepage <https://…>]
//
// It clones the repository (shallow, nothing of it run: no checkout, hooks at the null device),
// reads every blob as bytes from git's object store, and writes ONE manifest,
// src/scitools/<slug>.json: the pinned commit, the licence its licence file names, and each text
// file's path, size, SHA-256, lines and language. No file's text is kept: the page's reader fetches
// it from GitHub at that commit and checks its SHA-256. Then commit the manifest; the next build
// (the nightly's or yours) shows it. To remove a tool, delete its manifest and commit.
//
// Independent of the papers: it reads and writes nothing of scripts/data.mjs, the export, D1 or
// Hugging Face. GitHub's anonymous API is asked once for the description and homepage; when it does
// not answer, the README and the options give them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  languageOf, licenceFileOf, licenceOf, parseGithubUrl, problemsOf, readmeOf, SCITOOL_FILE_MAX_BYTES,
  SCITOOL_FILES_MAX, SCITOOLS_MAX, slugOf,
} from "../src/lib/scitools.ts";
import { decodeBytes, isBinary, maskEmails } from "../src/lib/source.ts";

const DIR = "src/scitools";
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  if (v === undefined) fail(`--${name} needs a value`);
  return v;
};
function fail(message) {
  console.error(`scitool:add: ${message}`);
  process.exit(1);
}
const ref = opt("ref");
const slugOpt = opt("slug");
const nameOpt = opt("name");
const descriptionOpt = opt("description");
const homepageOpt = opt("homepage");
if (args.length !== 1) fail("give one GitHub repository link, e.g. https://github.com/<owner>/<name>");
const repo = parseGithubUrl(args[0]);
if (!repo) fail(`${args[0]} is not a GitHub repository link (https://github.com/<owner>/<name>)`);
const url = `https://github.com/${repo.owner}/${repo.name}`;

// GitHub's anonymous API, once, for what only it knows (the description, the homepage).
let meta = {};
try {
  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "scitool-add" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) meta = await res.json();
  else if (res.status === 404) fail(`${url}: GitHub answers 404 (a private repository is never added)`);
} catch { /* offline, or rate-limited: the README and the options give the rest */ }
if (meta.private === true) fail(`${url} is private: only a public repository is added`);

// The repository's objects, never its working tree: nothing of it is checked out or run.
const tmp = mkdtempSync(join(tmpdir(), "scitool-"));
const git = (...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...a], {
  cwd: tmp, maxBuffer: 1 << 30, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
});
let tool;
try {
  git("clone", "--quiet", "--depth", "1", "--no-checkout", ...(ref ? ["--branch", ref] : []), `${url}.git`, "repo");
  const at = (...a) => git("-C", "repo", ...a);
  const commit = at("rev-parse", "HEAD").toString().trim();
  const committedAt = at("log", "-1", "--format=%cI").toString().trim();
  // mode, type, object, size, path: blobs only (a submodule or a symbolic link is no file to show).
  const entries = at("ls-tree", "-r", "-l", "-z", "HEAD").toString().split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, type, object, size] = line.slice(0, tab).split(/\s+/);
    return { mode, type, object, size: Number(size), path: line.slice(tab + 1) };
  }).filter((e) => e.type === "blob" && e.mode !== "120000");
  const skipped = { binary: 0, large: 0, over_limit: 0 };
  const files = [];
  const texts = new Map();
  for (const e of entries.sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    if (e.size > SCITOOL_FILE_MAX_BYTES) { skipped.large += 1; continue; }
    const bytes = new Uint8Array(at("cat-file", "blob", e.object));
    if (isBinary(e.path, bytes)) { skipped.binary += 1; continue; }
    const text = decodeBytes(bytes);
    if (text.startsWith("version https://git-lfs.github.com/spec/")) { skipped.large += 1; continue; }
    if (files.length >= SCITOOL_FILES_MAX) { skipped.over_limit += 1; continue; }
    const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    files.push({
      path: e.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), lines,
      language: languageOf(e.path),
    });
    texts.set(e.path, text);
  }
  const paths = files.map((f) => f.path);
  const readme = readmeOf(paths);
  const licenceFile = licenceFileOf(paths);
  const spdx = (meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION" ? meta.license.spdx_id : "") ||
    (licenceFile ? licenceOf(texts.get(licenceFile) ?? "") : "");
  const name = nameOpt ?? meta.name ?? repo.name;
  const slug = slugOpt ?? slugOf(name);
  tool = {
    slug,
    name,
    description: clean(descriptionOpt ?? meta.description ?? firstParagraph(texts.get(readme) ?? "")),
    repository: { host: "github", owner: repo.owner, name: repo.name, url },
    commit,
    committed_at: committedAt,
    added: new Date().toISOString().slice(0, 10),
    licence: { spdx, file: licenceFile },
    homepage: homepageOpt ?? (/^https:\/\//.test(meta.homepage ?? "") ? meta.homepage : ""),
    readme,
    files,
    skipped,
  };
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// The same repository keeps its slug and its first date; another repository never takes a slug.
const target = join(DIR, `${tool.slug}.json`);
if (existsSync(target)) {
  const old = JSON.parse(readFileSync(target, "utf8"));
  if (old.repository?.url?.toLowerCase() !== url.toLowerCase()) fail(`${target} is another repository's (${old.repository?.url}): choose --slug`);
  tool.added = old.added ?? tool.added;
  if (!descriptionOpt && old.description) tool.description = old.description;
  if (!homepageOpt && old.homepage && !tool.homepage) tool.homepage = old.homepage;
} else {
  const count = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).length : 0;
  if (count >= SCITOOLS_MAX) fail(`the section holds ${SCITOOLS_MAX} tools at most (src/lib/scitools.ts SCITOOLS_MAX)`);
  for (const f of existsSync(DIR) ? readdirSync(DIR).filter((x) => x.endsWith(".json")) : []) {
    const other = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    if (other.repository?.url?.toLowerCase() === url.toLowerCase()) fail(`${url} is already ${join(DIR, f)}`);
  }
}
const problems = problemsOf(tool, `${tool.slug}.json`);
if (problems.length) fail(problems.join("\n"));

// One file per line, so that a re-pin's diff says which files changed.
const { files, ...head } = tool;
const body = JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "files": [\n${files.map((f) => `    ${JSON.stringify(f)}`).join(",\n")}\n  ]\n}\n`);
writeFileSync(target, body);
console.log(`${target}: ${tool.name} at ${tool.commit.slice(0, 7)}, ${files.length} files` +
  ` (skipped: ${tool.skipped.binary} binary, ${tool.skipped.large} over 1 MB or in LFS, ${tool.skipped.over_limit} past the limit);` +
  ` licence ${tool.licence.spdx || "not recognised"}. Commit it; the next build shows ${`/scientific-tools/${tool.slug}/`}.`);

/** A description, as the page shows it: one line, no email address, no em dash, 600 characters at most. */
function clean(text) {
  let t = maskEmails(String(text)).replace(/\s+/g, " ").trim();
  t = t.replace(/\s*\u2014\s*/g, ", "); // emdash-ok: strips em dashes out of the repository's text
  return t.length > 600 ? `${t.slice(0, 597).replace(/\s+\S*$/, "")}...` : t;
}

/** The README's first paragraph of prose (Markdown or reStructuredText), its markup dropped. */
function firstParagraph(readme) {
  const paras = readme.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const p of paras) {
    const lines = p.split("\n").filter((l) => !/^\s*([=\-~^"#*`+])\1{2,}\s*$/.test(l));
    const text = lines.join(" ").trim();
    if (!text || /^(#|\.\. |\[!\[|!\[|<|\||:|```|\*\*[^*]+:\*\*)/.test(text) || text.length < 60) continue;
    return text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`<]+?)(?:\s*<[^>]+>)?`_?/g, "$1").replace(/``|\*\*|__|\*/g, "");
  }
  return "";
}
