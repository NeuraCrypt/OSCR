// Uploads, deletions and images added to Markdown, in the registry (night phase 03, E4;
// docs/WEB_EDITING.md): the views upload/<branch>/<dir> and delete/<branch>/<path> of the /r/
// shell, GitHub's own shapes, and the editor's aid that adds an image pasted or dropped into a
// Markdown file to the same commit, beside it (src/lib/upload.ts holds the rules).
//
// - Upload: files chosen or dropped (a folder keeps its structure), each checked (its name, a file
//   where a folder is, LFS patterns of .gitattributes, sizes), then one commit through the commit
//   dialog. The files stay in the page only (nothing is kept if it closes). Over the registry's
//   1 MiB: GitHub's own upload page, at the source, with the reason.
// - Delete: a file, or a folder and every file under it (at most 100), reviewed first; the history
//   keeps them, said in words; the tracing-map links on them are said in the dialog.
// - An image into Markdown: added to the commit next to the Markdown file, and `![…](name)` written
//   at the caret with its description to write in place of the placeholder (never a block).
// What it costs: the view's reads (the branches, the tree; .gitattributes raw), nothing of the
// Worker until the commit.

import { maskEmails } from "../../worker/forge/mask.ts";
import { base64, text as utf8Text } from "../../worker/forge/objects.ts";
import type { PayloadChange } from "../../worker/forge/service/act-commit.ts";
import { atSource, entryAt, githubLinks, isDirectory, pathCrumbs, refSegments, textLines } from "../lib/code-nav.ts";
import { commitBack, type FileTouch } from "../lib/commit-view.ts";
import { defaultMessage } from "../lib/editor.ts";
import { repoPath } from "../lib/forge.ts";
import { isMarkdownPath } from "../lib/markdown.ts";
import { h } from "../lib/repo-view.ts";
import { deletePlan, freeName, imageMarkdown, type Picked, UPLOAD_BUDGET, uploadPlan } from "../lib/upload.ts";
import { applyEdit, el } from "./code-editor.ts";
import { openCommitDialog } from "./commit-dialog.ts";
import { show, toDom } from "./dom.ts";
import { codeViews, type CodeEnv, failed, openRef, type Opened, repoRef, sourceUrl } from "./repo-code.ts";
import { editorAids } from "./repo-edit.ts";
import { mapLinksIn } from "./repo-traced.ts";

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** The page head: the path, the branch, Cancel. */
function head(env: CodeEnv, branch: string, dir: string, what: string, cancel: string): HTMLElement {
  const crumbs = toDom(pathCrumbs(env.repo, branch, dir, false)) as HTMLElement;
  crumbs.classList.add("edit-crumbs");
  return el("div", { class: "edit-head" }, crumbs, el("p", { class: "edit-name" }, el("strong", {}, what), el("span", { class: "edit-branch" }, ` in ${branch}`)), el("p", { class: "edit-actions" }, el("a", { href: cancel }, "Cancel")));
}

async function opened(slot: HTMLElement, env: CodeEnv, what: string): Promise<Opened | null> {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the branch…"));
  try {
    const o = await openRef(env, env.target.rest ?? []);
    if (o.ref.kind !== "branch") {
      const branch = env.info.defaultBranch;
      show(
        slot,
        h(
          "div",
          { class: "editor-page" },
          h("p", { class: "warning" }, `Files are ${what} on a branch; this address names a tag or a commit.`),
          branch ? h("p", null, h("a", { href: repoPath(env.repo, env.target.view, refSegments(branch, o.ref.path)) }, `The same on the ${branch} branch`)) : null,
        ),
      );
      return null;
    }
    return o;
  } catch (e) {
    const rest = env.target.rest ?? [];
    failed(slot, e, sourceUrl(env, "tree", rest[0] ?? "HEAD", rest.slice(1).join("/")), "directory");
    return null;
  }
}

/** The map links on the files a commit writes over or deletes, at the branch's head (raw reads). */
async function touchesOf(env: CodeEnv, o: Opened, paths: readonly string[], kind: "edit" | "delete", after: (path: string) => string): Promise<FileTouch[]> {
  const out: FileTouch[] = [];
  for (const path of paths.slice(0, 100)) {
    let lines: string[] = [];
    let before = "";
    try {
      const f = await env.session.git.readFile(repoRef(env), o.commit, path, { maxBytes: 1024 * 1024 });
      if (!f.binary && !f.lfs) {
        before = utf8Text(f.bytes);
        lines = textLines(maskEmails(before));
      }
    } catch {
      continue;
    }
    const located = await mapLinksIn(env, o.commit, path, lines);
    if (located.length) out.push({ path, kind, before, after: after(path), located });
  }
  return out;
}

// ─── upload/<branch>/<dir> ───────────────────────────────────────────────────

async function readPicked(list: FileList | File[]): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const f of [...list].slice(0, 1000)) {
    const name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    // A file over what one commit may pass is not read at all: its size says enough.
    if (f.size > UPLOAD_BUDGET) out.push({ name, bytes: new Uint8Array(0), size: f.size });
    else out.push({ name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}

export async function mountUpload(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const o = await opened(slot, env, "uploaded");
  if (!o) return;
  const branch = o.ref.ref;
  let dir = o.ref.path;
  if (dir && !isDirectory(o.entries, dir) && entryAt(o.entries, dir)) dir = parentOf(dir);
  let gitattributes = "";
  if (entryAt(o.entries, ".gitattributes")) {
    try {
      gitattributes = utf8Text((await env.session.git.readFile(repoRef(env), o.commit, ".gitattributes", { maxBytes: 64 * 1024 })).bytes);
    } catch {
      gitattributes = "";
    }
  }
  const cancel = repoPath(env.repo, "tree", refSegments(branch, dir));
  const pickFiles = el("input", { type: "file", id: "upload-files", multiple: "multiple" });
  const pickFolder = el("input", { type: "file", id: "upload-folder", webkitdirectory: "webkitdirectory", multiple: "multiple" });
  const drop = el(
    "div",
    { class: "upload-drop", tabindex: "0", role: "group", "aria-label": "Drop files here" },
    el("p", {}, el("strong", {}, "Drag files or a folder here"), ", or choose them:"),
    el("p", {}, el("label", { for: "upload-files" }, "Files "), pickFiles, " ", el("label", { for: "upload-folder" }, "A folder "), pickFolder),
  );
  const listing = el("div", { class: "upload-listing", "aria-live": "polite" });
  const commitButton = el("button", { type: "button", class: "primary", disabled: "disabled" }, "Commit changes…");
  const dialog = el("section", { class: "commit-dialog", "aria-label": "Commit changes", hidden: "hidden" });
  const where = dir ? `the folder ${dir}` : "the repository's root";
  slot.replaceChildren(
    el(
      "div",
      { class: "editor-page" },
      head(env, branch, dir, "Upload files", cancel),
      el(
        "p",
        {},
        `Add files to ${where} in one commit, as you. A file of the same name is replaced. Up to 100 files and about ${Math.floor((UPLOAD_BUDGET * 3) / 4 / 1024)} KB together pass through the registry; the files stay in this page only until committed.`,
      ),
      drop,
      listing,
      el("p", {}, commitButton),
      dialog,
    ),
  );

  let picked: Picked[] = [];
  let plan = uploadPlan([], dir, o.entries, gitattributes);
  const render = () => {
    plan = uploadPlan(picked, dir, o.entries, gitattributes);
    const rows = plan.rows.map((r) =>
      el(
        "tr",
        { class: r.problem ? "refused" : "" },
        el("td", { class: "name" }, r.path),
        el("td", { class: "num" }, r.size < 1024 ? `${r.size} B` : `${(r.size / 1024).toFixed(r.size < 10240 ? 1 : 0)} KB`),
        el("td", {}, r.problem ? el("span", { class: "warning" }, r.problem) : `${r.replaces ? "Replaces the file" : "New"}${r.as === "text" ? ", text" : ", bytes"}${r.note ? `. ${r.note}` : ""}`),
      ),
    );
    const tooLarge = plan.rows.some((r) => r.problem && /Too large|Over 25 MB|too large/.test(r.problem)) || /too large/.test(plan.problem ?? "");
    listing.replaceChildren(
      picked.length
        ? el("table", { class: "files upload-files" }, el("caption", {}, `${plan.changes.length} of ${plan.rows.length} ${plan.rows.length === 1 ? "file" : "files"} to commit`), el("thead", {}, el("tr", {}, el("th", {}, "File"), el("th", { class: "num" }, "Size"), el("th", {}, "What"))), el("tbody", {}, ...rows))
        : "",
      plan.problem && picked.length ? el("p", { class: "warning" }, plan.problem) : "",
      tooLarge ? toDom(atSource("Larger files go through GitHub's own upload page (25 MB a file) or git: the registry passes 1 MiB at most in one commit.", githubLinks(env.endpoints.web).upload(repoRef(env), branch, dir || undefined))) : "",
    );
    commitButton.disabled = !!plan.problem || !plan.changes.length;
  };
  const add = async (files: FileList | File[]) => {
    picked = [...picked, ...(await readPicked(files))];
    render();
  };
  pickFiles.addEventListener("change", () => pickFiles.files && void add(pickFiles.files));
  pickFolder.addEventListener("change", () => pickFolder.files && void add(pickFolder.files));
  drop.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    drop.classList.remove("over");
    if (ev.dataTransfer?.files.length) void add(ev.dataTransfer.files);
  });
  commitButton.addEventListener("click", async () => {
    let branches: string[];
    try {
      branches = (await env.session.git.listBranches(repoRef(env), { perPage: 100 })).items.map((b) => b.name);
    } catch {
      branches = [branch];
    }
    const texts = new Map(plan.changes.flatMap((c): [string, string][] => (c.op === "put" && "text" in c ? [[c.path, c.text]] : [])));
    await openCommitDialog(dialog, {
      env,
      branch,
      head: o.commit,
      base: o.commit,
      branches,
      defaultMessage: defaultMessage(plan.changes, { uploaded: true }),
      changes: () => plan.problem ?? plan.changes,
      touches: () => touchesOf(env, o, plan.rows.filter((r) => r.replaces && !r.problem).map((r) => r.path), "edit", (p) => texts.get(p) ?? ""),
      texts: () => [...texts],
      drafts: [],
      back: commitBack(env.repo, location.pathname),
    });
    dialog.scrollIntoView({ block: "start" });
  });
}

// ─── delete/<branch>/<path> ──────────────────────────────────────────────────

export async function mountDelete(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const o = await opened(slot, env, "deleted");
  if (!o) return;
  const branch = o.ref.ref;
  const path = o.ref.path;
  const plan = deletePlan(o.entries, path);
  const cancel = plan.folder ? repoPath(env.repo, "tree", refSegments(branch, path)) : repoPath(env.repo, "blob", refSegments(branch, path));
  const commitButton = el("button", { type: "button", class: "primary" }, plan.folder ? "Delete the folder…" : "Delete the file…");
  const dialog = el("section", { class: "commit-dialog", "aria-label": "Commit changes", hidden: "hidden" });
  const shown = plan.paths.slice(0, 100);
  slot.replaceChildren(
    el(
      "div",
      { class: "editor-page" },
      head(env, branch, parentOf(path), plan.folder ? `Delete the folder ${path.split("/").pop()}` : `Delete ${path.split("/").pop()}`, cancel),
      plan.problem ? el("p", { class: "warning" }, plan.problem) : null,
      plan.paths.length && plan.folder ? el("p", {}, plan.paths.length === 1 ? "Its one file goes, in one commit:" : `Its ${plan.paths.length} files go, in one commit:`) : null,
      plan.paths.length && plan.folder ? el("ul", { class: "delete-files" }, ...shown.map((p) => el("li", {}, p))) : null,
      plan.paths.length
        ? el("p", {}, "They stay in the repository's history: an earlier commit still holds them, and a tracing map pinned to one of those commits keeps its links.")
        : null,
      plan.problem ? null : el("p", {}, commitButton),
      dialog,
    ),
  );
  if (plan.problem) return;
  const changes: PayloadChange[] = plan.paths.map((p) => ({ op: "delete", path: p }));
  commitButton.addEventListener("click", async () => {
    let branches: string[];
    try {
      branches = (await env.session.git.listBranches(repoRef(env), { perPage: 100 })).items.map((b) => b.name);
    } catch {
      branches = [branch];
    }
    await openCommitDialog(dialog, {
      env,
      branch,
      head: o.commit,
      base: o.commit,
      branches,
      defaultMessage: defaultMessage(changes, { folder: plan.folder ? path.split("/").pop() ?? path : null }),
      changes: () => changes,
      touches: () => touchesOf(env, o, plan.paths, "delete", () => ""),
      texts: () => [],
      drafts: [],
      back: commitBack(env.repo, location.pathname),
    });
    dialog.scrollIntoView({ block: "start" });
  });
}

codeViews.upload = mountUpload;
codeViews.delete = mountDelete;

// ─── an image into a Markdown file (the editor's aid) ────────────────────────

const IMAGE = /^image\/(?:png|jpeg|gif|webp|svg\+xml)$/;
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg" };

editorAids.push((ctx) => {
  const list = el("p", { class: "editor-extra", "aria-live": "polite", hidden: "hidden" });
  ctx.editor.root.after(list);
  const said = () => {
    const names = [...ctx.extra.keys()];
    list.hidden = !names.length;
    list.replaceChildren(
      names.length ? `Added with this commit, beside the file: ` : "",
      ...names.flatMap((n, i) => {
        const remove = el("button", { type: "button", class: "link" }, "remove");
        remove.addEventListener("click", () => {
          ctx.extra.delete(n);
          said();
          ctx.changed();
        });
        return [i ? "; " : "", el("code", {}, n), " (", remove, ")"];
      }),
    );
  };
  const take = async (files: File[]): Promise<boolean> => {
    const path = ctx.path();
    if (!path || !(isMarkdownPath(path) || ctx.language() === "Markdown")) return false;
    const images = files.filter((f) => IMAGE.test(f.type));
    if (!images.length) return false;
    const dir = parentOf(path);
    for (const f of images.slice(0, 10)) {
      if (f.size > (UPLOAD_BUDGET * 3) / 4) {
        list.hidden = false;
        list.replaceChildren(el("span", { class: "warning" }, `${f.name || "The image"} is too large to pass through the registry: add it with git, or GitHub's upload page, then link it.`));
        continue;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const name = f.name && f.name !== "image.png" ? f.name : `image${EXT[f.type] ?? ".png"}`;
      const target = freeName(dir, name, (p) => ctx.extra.has(p) || p === path);
      ctx.extra.set(target, { op: "put", path: target, base64: base64(bytes) });
      const md = imageMarkdown(path, target);
      const ta = ctx.editor.input;
      const at = ta.selectionStart;
      applyEdit(ta, { from: at, to: ta.selectionEnd, insert: md.text, select: { start: at + 2, end: at + 2 + md.placeholder.length } });
    }
    said();
    ctx.changed();
    return true;
  };
  ctx.editor.input.addEventListener("paste", (ev) => {
    const files = [...(ev.clipboardData?.files ?? [])];
    if (files.some((f) => IMAGE.test(f.type))) {
      ev.preventDefault();
      void take(files);
    }
  });
  ctx.editor.input.addEventListener("drop", (ev) => {
    const files = [...(ev.dataTransfer?.files ?? [])];
    if (files.some((f) => IMAGE.test(f.type))) {
      ev.preventDefault();
      void take(files);
    }
  });
});
