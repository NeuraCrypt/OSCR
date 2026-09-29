// Uploads and deletions from the browser, their pure part (night phase 03, E4; docs/WEB_EDITING.md):
// no DOM, testable in Node (tests/forge-pages/upload.test.ts). The pages are
// src/scripts/repo-upload.ts (upload/<branch>/<dir>, delete/<branch>/<path>, images into Markdown).
//
// - An upload is one commit of up to COMMIT_FILES files whose payload (texts as text, other bytes
//   as base64, in the commit's JSON) stays inside the Worker's ACTION_PAYLOAD_BYTES (1 MiB, D00-7):
//   about 750 KiB of bytes. Beyond, GitHub's own upload page (25 MiB a file) or git, said with the
//   reason (the "At the source" rule).
// - Names are checked as GitHub's name field reads them (src/lib/editor.ts `resolvePath`: no ".git",
//   nothing above the repository); a folder dropped keeps its structure; a file that exists is
//   replaced (as on GitHub), keeping its executable bit; a file where a folder is (or the reverse)
//   is refused.
// - Unlike GitHub's web upload, `.gitattributes`' `filter=lfs` is obeyed: such a file is refused
//   with the reason (git lfs stores it), since GitHub would commit the bytes themselves.
// - Types are not restricted: git holds any bytes, and nothing uploaded is ever run or served as a
//   page by the registry (text is shown as text nodes, images from object URLs, SVG as an image,
//   HTML as its source). An executable or a large binary is said in words.
// - A deletion is the file, or every file under the folder (at most COMMIT_FILES), reviewed first.

import { base64, isBinary, isUtf8, text as utf8Text } from "../../worker/forge/objects.ts";
import type { PayloadChange } from "../../worker/forge/service/act-commit.ts";
import { ACTION_PAYLOAD_BYTES, COMMIT_FILES } from "../../worker/forge/service/caps.ts";
import type { TreeEntry } from "../../worker/forge/types.ts";
import { attributesOf, parseAttributes } from "./attributes.ts";
import { resolvePath } from "./editor.ts";

/** The part of the payload the commit's own fields take (message, description, trailers). */
export const PAYLOAD_MARGIN = 72 * 1024;
/** What the files of one upload may take in the payload. */
export const UPLOAD_BUDGET = ACTION_PAYLOAD_BYTES - PAYLOAD_MARGIN;
/** GitHub's own web upload: 25 MiB a file (where the registry sends a larger file). */
export const GITHUB_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface Picked {
  /** The name, or the path inside a folder dropped ("figures/f1.png"). */
  name: string;
  bytes: Uint8Array;
  /** The file's size when its bytes were not read (a file far over the limits). */
  size?: number;
}

export interface UploadRow {
  path: string;
  size: number;
  /** Sent as text (UTF-8) or as bytes (base64). */
  as: "text" | "bytes";
  /** A file of that name exists: it is replaced. */
  replaces: boolean;
  /** Why it cannot be part of the commit, or null. */
  problem: string | null;
  /** A remark that does not stop it ("an executable program"). */
  note: string | null;
}

export interface UploadPlan {
  rows: UploadRow[];
  changes: PayloadChange[];
  /** The payload's bytes the accepted files take. */
  bytes: number;
  /** Why the whole upload cannot be committed (too many files, too large), or null. */
  problem: string | null;
}

const encoder = new TextEncoder();

/** The bytes a change takes in the commit's JSON (a text escaped, bytes in base64). */
export function payloadSize(c: PayloadChange): number {
  if (c.op !== "put") return 64 + encoder.encode(JSON.stringify(c)).length;
  if ("text" in c) return encoder.encode(JSON.stringify(c.text)).length + 64 + c.path.length;
  return c.base64.length + 64 + c.path.length;
}

const sizeWords = (n: number): string => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const EXECUTABLES = /\.(?:exe|dll|so|dylib|bin|msi|app|dmg|jar|class|pyc|o|a)$/i;

/** The upload of files picked or dropped into a folder of the branch. */
export function uploadPlan(files: readonly Picked[], dir: string, entries: readonly Pick<TreeEntry, "path" | "type" | "mode">[], gitattributes = ""): UploadPlan {
  const rules = parseAttributes(gitattributes);
  const rows: UploadRow[] = [];
  const changes: PayloadChange[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  for (const f of files.slice(0, 1000)) {
    const path = resolvePath(dir, f.name);
    const fileSize = f.size ?? f.bytes.length;
    const row: UploadRow = { path: path ?? f.name, size: fileSize, as: "bytes", replaces: false, problem: null, note: null };
    rows.push(row);
    if (!path) {
      row.problem = "This name is not one a repository may hold (“.git”, an empty part, or above the repository).";
      continue;
    }
    if (seen.has(path)) {
      row.problem = "Picked twice: the first one is kept.";
      continue;
    }
    seen.add(path);
    const existing = entries.find((e) => e.path === path);
    if (existing && existing.type === "tree") {
      row.problem = `${path} is a folder.`;
      continue;
    }
    if (existing && existing.type === "commit") {
      row.problem = `${path} is a submodule: it is changed with git.`;
      continue;
    }
    const parts = path.split("/");
    const blocked = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")).find((p) => entries.some((e) => e.path === p && e.type !== "tree"));
    if (blocked) {
      row.problem = `${blocked} is a file, so it cannot hold a folder.`;
      continue;
    }
    if (attributesOf(rules, path).lfs) {
      row.problem = "The repository's .gitattributes stores this kind of file with Git LFS: upload it with git (git lfs), so that it goes to LFS.";
      continue;
    }
    row.replaces = !!existing;
    // Too large before anything is encoded.
    if (fileSize > GITHUB_UPLOAD_BYTES) {
      row.problem = `Over 25 MB (${sizeWords(fileSize)}): git stores it (and a release asset, Zenodo or a data repository suit data better).`;
      continue;
    }
    if (fileSize > UPLOAD_BUDGET || fileSize !== f.bytes.length) {
      row.problem = `Too large to pass through the registry (${sizeWords(fileSize)}; about ${sizeWords(Math.floor((UPLOAD_BUDGET * 3) / 4))} at most in one commit): GitHub's own upload page takes up to 25 MB.`;
      continue;
    }
    const executable = existing?.mode === "100755";
    const text = f.bytes.length > 0 && isUtf8(f.bytes) && !isBinary(f.bytes) ? utf8Text(f.bytes) : f.bytes.length === 0 ? "" : null;
    const change: PayloadChange =
      text !== null
        ? executable ? { op: "put", path, text, executable: true } : { op: "put", path, text }
        : executable ? { op: "put", path, base64: base64(f.bytes), executable: true } : { op: "put", path, base64: base64(f.bytes) };
    row.as = text !== null ? "text" : "bytes";
    const size = payloadSize(change);
    if (size > UPLOAD_BUDGET) {
      row.problem = `Too large to pass through the registry (${sizeWords(f.bytes.length)}; about ${sizeWords(Math.floor((UPLOAD_BUDGET * 3) / 4))} at most in one commit): GitHub's own upload page takes up to 25 MB.`;
      continue;
    }
    if (EXECUTABLES.test(path)) row.note = "A compiled program or library: the registry never runs it, and readers are told what it is.";
    else if (row.as === "bytes" && f.bytes.length > 256 * 1024) row.note = "A large binary: its whole bytes stay in the history for good.";
    changes.push(change);
    bytes += size;
  }
  let problem: string | null = null;
  if (!changes.length) problem = rows.length ? "No file can be committed as it is: the reasons are beside each." : "Choose files, or drop them here.";
  else if (changes.length > COMMIT_FILES) problem = `At most ${COMMIT_FILES} files in one commit from the browser (${changes.length} chosen): git takes more.`;
  else if (bytes > UPLOAD_BUDGET) problem = `Together these files are too large to pass through the registry in one commit (about ${sizeWords(bytes)} of ${sizeWords(UPLOAD_BUDGET)}): commit them in several parts, or use GitHub's own upload page.`;
  return { rows, changes, bytes, problem };
}

/** A deletion: the file, or every file under the folder. */
export function deletePlan(entries: readonly Pick<TreeEntry, "path" | "type">[], path: string): { paths: string[]; folder: boolean; problem: string | null } {
  const exact = entries.find((e) => e.path === path);
  if (exact && exact.type !== "tree") return { paths: [path], folder: false, problem: null };
  const under = entries.filter((e) => e.type !== "tree" && e.path.startsWith(`${path}/`)).map((e) => e.path);
  if (!exact && !under.length) return { paths: [], folder: false, problem: `There is no file or folder ${path} on this branch.` };
  if (under.length > COMMIT_FILES) {
    return { paths: under, folder: true, problem: `This folder holds ${under.length} files: a commit from the browser deletes at most ${COMMIT_FILES}. git can delete it (git rm -r ${path}).` };
  }
  return { paths: under, folder: true, problem: under.length ? null : `The folder ${path} holds no file.` };
}

/** The Markdown of an image added beside a Markdown file: its description to write in place of the
 *  placeholder (a reminder, never a block), and its path relative to the file. */
export function imageMarkdown(mdPath: string, imagePath: string): { text: string; placeholder: string } {
  const mdDir = mdPath.includes("/") ? mdPath.slice(0, mdPath.lastIndexOf("/")) : "";
  const rel = mdDir && imagePath.startsWith(`${mdDir}/`) ? imagePath.slice(mdDir.length + 1) : mdDir ? `/${imagePath}` : imagePath;
  const placeholder = "Describe the image";
  const href = rel.split("/").map((s) => encodeURIComponent(s)).join("/");
  return { text: `![${placeholder}](${href})`, placeholder };
}

/** A free name for an image in a folder: "figure.png", else "figure-2.png"… */
export function freeName(dir: string, name: string, taken: (path: string) => boolean): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "image.png";
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  const at = (n: number) => `${dir ? `${dir}/` : ""}${n === 1 ? stem : `${stem}-${n}`}${ext}`;
  for (let n = 1; n < 1000; n++) if (!taken(at(n))) return at(n);
  return at(Date.now());
}
