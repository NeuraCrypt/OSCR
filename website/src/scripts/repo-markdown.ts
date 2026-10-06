// Rendered Markdown in the /r/ shell (night phase 02, E2): a Markdown file's blob view ("Rendered ·
// Source", ?plain=1 for the source and its line anchors), and the README under a directory's files
// and on the repository's home (GitHub's precedence: .github/, the root, docs/). The renderer is
// src/lib/markdown.ts (a view tree, never an HTML string) with its math (src/lib/mathml.ts: MathML
// drawn by the browser itself).
//
// What it costs the reader's 60 anonymous GitHub requests an hour: nothing more. The README and the
// repository's own images are raw reads (raw.githubusercontent.com, not counted), at the commit the
// page shows; each image is read once per page, up to 50, and shown from an object URL (img-src
// blob:). An image on another site is a link the reader follows, never loaded by the page (D02-6).
//
// The licence gate (D02-7) holds: without an open licence, the README is not rendered (the home
// keeps its short excerpt, phase 01's).

import { maskEmails } from "../../worker/forge/mask.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { CODE_LIMITS, entryAt, imageType, isDirectory, licenceShows, refSegments, sizeInWords } from "../lib/code-nav.ts";
import { repoPath } from "../lib/forge.ts";
import { cutForRendering, isMarkdownPath, outline, readmeOf, renderMarkdown, repoResolvers, USER_CONTENT } from "../lib/markdown.ts";
import { type El, h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { type CodeEnv, type Opened, renderers, repoRef, sourceUrl, treeExtras } from "./repo-code.ts";

/** The directory of a path ("" at the root). */
const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** A Markdown text as the viewer renders it: cut at 500 KiB (said in words), its outline, its body. */
async function rendered(env: CodeEnv, ref: string, commit: string, path: string, entries: readonly T.TreeEntry[], text: string): Promise<El> {
  const { text: shown, cut } = cutForRendering(text, CODE_LIMITS.renderBytes);
  const r = await renderMarkdown(shown, {
    ...repoResolvers({ repo: env.repo, ref, dir: dirOf(path), isDir: (p) => isDirectory(entries, p), web: env.endpoints.web, raw: env.endpoints.raw }),
    plainCode: shown.length > CODE_LIMITS.highlightBytes,
    sourceUrl: sourceUrl(env, "blob", commit, path),
  });
  const here = repoPath(env.repo, "blob", refSegments(ref, path));
  return h(
    "div",
    { class: "rendered" },
    cut ? h("p", { class: "warning" }, `This file is longer than the viewer renders (${sizeInWords(CODE_LIMITS.renderBytes)}, GitHub's own limit): the rest is in `, h("a", { href: `${here}?plain=1` }, "its source"), ".") : null,
    outline(r.headings),
    r.el,
  );
}

/** The repository's own images of a rendered text: read at the commit (raw, not counted), shown from
 *  object URLs; one that cannot be read keeps its words. */
export async function fillImages(root: HTMLElement, env: CodeEnv, commit: string, entries: readonly T.TreeEntry[]): Promise<void> {
  const urls = new Map<string, Promise<string | null>>();
  const read = async (path: string): Promise<string | null> => {
    const entry = entryAt(entries, path);
    const type = imageType(path);
    if (!entry || entry.type !== "blob" || entry.mode === "120000" || !type || (entry.size ?? 0) > CODE_LIMITS.imageBytes) return null;
    const f = await env.session.git.readFile(repoRef(env), commit, path, { maxBytes: CODE_LIMITS.imageBytes });
    if (f.lfs) return null;
    return URL.createObjectURL(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type }));
  };
  const images = [...root.querySelectorAll<HTMLImageElement>("img[data-src]")].slice(0, 50);
  await Promise.all(
    images.map(async (img) => {
      const path = img.dataset.src ?? "";
      img.removeAttribute("data-src");
      if (!urls.has(path)) urls.set(path, read(path).catch(() => null));
      const url = await urls.get(path)!;
      if (url) img.src = url;
      else img.replaceWith(toDom(h("span", { class: "missing-image" }, `${img.alt || "An image"} (${path.split("/").pop()}: not found at this commit)`)));
    }),
  );
}

/** GitHub's anchors are "#name" for "user-content-name": an address with one scrolls to it. */
export function scrollToHash(root: ParentNode = document): void {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (!hash || /^L\d+(-L\d+)?$/.test(hash)) return;
  const el = document.getElementById(hash) ?? document.getElementById(`${USER_CONTENT}${hash}`);
  if (el && root.contains(el)) el.scrollIntoView();
}

// ─── the blob view of a Markdown file ────────────────────────────────────────

renderers.push({
  name: "markdown",
  claims: (path, language) => isMarkdownPath(path) || language === "Markdown",
  render: (file) => (file.text === null ? Promise.resolve(null) : rendered(file.env, file.ref.ref, file.commit, file.path, file.entries, file.text)),
  async mounted(root, file) {
    await fillImages(root, file.env, file.commit, file.entries);
    scrollToHash(root);
  },
});

// ─── a directory's README ────────────────────────────────────────────────────

/** The README of a directory, under its files (on the home too). */
async function readmeExtra(slot: HTMLElement, env: CodeEnv, opened: Opened, dir: string): Promise<void> {
  const path = readmeOf(opened.entries, dir, dir === "");
  if (!path || !licenceShows(env.info.licenseSpdx).show) return;
  const entry = entryAt(opened.entries, path);
  const name = path.split("/").pop() ?? path;
  const here = repoPath(env.repo, "blob", refSegments(opened.ref.ref, path));
  const heading = h("h2", { class: "readme-name" }, h("a", { href: here }, name));
  if ((entry?.size ?? 0) > CODE_LIMITS.displayBytes) {
    show(slot, h("section", { class: "readme", "aria-label": "README" }, heading, h("p", null, `This README is larger than the viewer reads (${sizeInWords(CODE_LIMITS.displayBytes)}).`)));
    return;
  }
  const f = await env.session.git.readFile(repoRef(env), opened.commit, path, { maxBytes: CODE_LIMITS.displayBytes });
  if (f.binary || f.lfs) return;
  const text = utf8Text(f.bytes);
  const body: El = isMarkdownPath(path)
    ? await rendered(env, opened.ref.ref, opened.commit, path, opened.entries, text)
    : h("pre", { class: "readme-text" }, maskEmails(cutForRendering(text, CODE_LIMITS.renderBytes).text));
  show(slot, h("section", { class: "readme", "aria-label": "README" }, heading, body));
  // The home's short excerpt (phase 01) gives way to the whole README.
  document.getElementById("readme-excerpt")?.remove();
  await fillImages(slot, env, opened.commit, opened.entries);
  scrollToHash(slot);
}

treeExtras.push(readmeExtra);
