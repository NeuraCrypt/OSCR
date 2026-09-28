// History, commits and comparisons in the registry's own viewer (night phase 02, E3): the views
// commits/<ref>/<path> (a branch's or a file's history, with its filters), commit/<sha> (one
// commit: its message, people, signature, checks, the branches and tags that hold it, its diffs)
// and compare/<base>...<head> (three dots, from the merge base) or <base>..<head> (two dots, the two
// trees, computed here). Read in the reader's browser on the reader's own quota; nothing sends the
// reader to GitHub (the owner's rule, 2026-09-29).
//
// What a view costs the reader's 60 anonymous requests an hour (answers at commit ids are kept for
// the tab, src/lib/gitcache.ts):
// - the history: the branches (1, kept 5 minutes), one page of 30 commits (1);
// - a commit: the commit and its first 100 files (1), then, after the rest: whether the default
//   branch holds it (1), its checks (2);
// - a comparison: each side resolved (0 to 1 each, 1 per ~ or ^ step), then GitHub's comparison
//   (1), or the two trees (2) for two dots;
// - expanding a diff's context, an image diff, a two-dot file: raw files, not counted.
//
// Diffs are unified or split (?diff=split), whitespace shown or hidden (?w=1), highlighted with
// highlight.js on each side; the `.diff` is built here from the patches (a `.patch` would carry
// the authors' email addresses).

import { GitBackendError } from "../../worker/forge/errors.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import { isObjectId } from "../../worker/forge/paths.ts";
import type * as T from "../../worker/forge/types.ts";
import { CODE_LIMITS, degradedView, githubLinks, imageType, refSegments, refSwitcher, shortSha } from "../lib/code-nav.ts";
import { repoPath } from "../lib/forge.ts";
import { plural } from "../lib/format.ts";
import { detectLanguage, highlightText, type LineNodes } from "../lib/highlight.ts";
import {
  changedTree,
  commitHeader,
  commitList,
  comparePath,
  comparisonInWords,
  type CompareSpec,
  diffTable,
  diffText,
  type DiffMode,
  fileHeader,
  type Hunk,
  hunksOf,
  hunkStats,
  ignoreWhitespace,
  parseCompare,
  parsePatch,
  type RefSpec,
  refSpecText,
  type SideNodes,
  treeChanges,
} from "../lib/history.ts";
import { type El, h } from "../lib/repo-view.ts";
import { show } from "./dom.ts";
import { type CodeEnv, codeViews, failed, readRefs, repoRef, resolveRef, sourceUrl, wireSwitcher } from "./repo-code.ts";

const gh = repoRef;

/** What a view of diffs needs: the two sides' commits, the mode, the whitespace choice. */
interface DiffContext {
  env: CodeEnv;
  /** The commit of the old side (a parent, the merge base, the base), or null for a root commit. */
  oldRev: string | null;
  newRev: string;
  mode: DiffMode;
  hideWhitespace: boolean;
}

/** Extra blocks under a commit's header (E4: the tracing-map links the commit changed). */
export const commitExtras: ((env: CodeEnv, commit: T.CommitDetail) => Promise<El | null>)[] = [];

// ─── the options bar ─────────────────────────────────────────────────────────

function optionsBar(env: CodeEnv, mode: DiffMode, hide: boolean): El {
  const params = new URLSearchParams(env.search);
  const at = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v === null) p.delete(k);
    else p.set(k, v);
    const q = p.toString();
    return `${location.pathname}${q ? `?${q}` : ""}`;
  };
  return h(
    "p",
    { class: "diff-options" },
    mode === "unified" ? h("strong", null, "Unified") : h("a", { href: at("diff", null) }, "Unified"),
    " · ",
    mode === "split" ? h("strong", null, "Split") : h("a", { href: at("diff", "split") }, "Split"),
    " | ",
    hide ? h("a", { href: at("w", null) }, "Show whitespace changes") : h("a", { href: at("w", "1") }, "Hide whitespace changes"),
    " | ",
    h("button", { type: "button", class: "link", id: "download-diff" }, "Download the .diff"),
    " | ",
    h("label", { for: "file-filter" }, "Filter the files "),
    h("input", { type: "search", id: "file-filter", name: "files", autocomplete: "off", spellcheck: "false", placeholder: "a path" }),
  );
}

// ─── one file's diff ─────────────────────────────────────────────────────────

/** Highlighted lines of the hunks, on each side, by their numbers. */
async function highlightHunks(hunks: readonly Hunk[], path: string): Promise<SideNodes> {
  const language = detectLanguage(path);
  const nodes: SideNodes = { old: new Map(), new: new Map() };
  for (const hk of hunks) {
    const olds = hk.lines.filter((l) => l.kind === "context" || l.kind === "del");
    const news = hk.lines.filter((l) => l.kind === "context" || l.kind === "add");
    const [a, b] = await Promise.all([highlightText(olds.map((l) => l.text), language), highlightText(news.map((l) => l.text), language)]);
    olds.forEach((l, i) => l.old !== null && nodes.old.set(l.old, a[i] as LineNodes));
    news.forEach((l, i) => l.new !== null && nodes.new.set(l.new, b[i] as LineNodes));
  }
  return nodes;
}

async function readText(ctx: DiffContext, rev: string | null, path: string | null): Promise<string | null> {
  if (!rev || !path) return "";
  try {
    const f = await ctx.env.session.git.readFile(gh(ctx.env), rev, path, { maxBytes: CODE_LIMITS.displayBytes });
    return f.binary || f.lfs ? null : utf8Text(f.bytes);
  } catch {
    return null;
  }
}

async function readImage(ctx: DiffContext, rev: string | null, path: string | null): Promise<string | null> {
  if (!rev || !path) return null;
  try {
    const f = await ctx.env.session.git.readFile(gh(ctx.env), rev, path, { maxBytes: CODE_LIMITS.imageBytes });
    return URL.createObjectURL(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: imageType(path) ?? "application/octet-stream" }));
  } catch {
    return null;
  }
}

/** An image changed: the two versions side by side, or one over the other (swipe, onion skin). */
function imageDiff(oldUrl: string | null, newUrl: string | null): El {
  const fig = (url: string | null, caption: string) => (url ? h("figure", null, h("img", { src: url, alt: caption }), h("figcaption", null, caption)) : h("figure", null, h("figcaption", null, `${caption}: none`)));
  if (!oldUrl || !newUrl) return h("div", { class: "image-diff two-up" }, fig(oldUrl, "Before"), fig(newUrl, "After"));
  return h(
    "div",
    { class: "image-diff" },
    h(
      "p",
      { class: "image-modes" },
      h("button", { type: "button", class: "link" }, "Side by side"),
      " · ",
      h("button", { type: "button", class: "link" }, "Swipe"),
      " · ",
      h("button", { type: "button", class: "link" }, "Onion skin"),
      " ",
      h("label", { for: "image-mix", class: "mix" }, "Mix "),
      h("input", { type: "range", class: "mix", name: "mix", value: "5", title: "How much of each version" }),
    ),
    h("div", { class: "two-up" }, fig(oldUrl, "Before"), fig(newUrl, "After")),
    h("div", { class: "overlay onion-5", hidden: "hidden" }, h("img", { src: oldUrl, alt: "Before" }), h("img", { src: newUrl, alt: "After", class: "top" })),
  );
}

/** Renders one file's diff into its block: the table from the hunks, or what the file is. */
async function fillFile(block: HTMLElement, ctx: DiffContext, f: T.FileChangeSummary, context: number | null): Promise<void> {
  const body = block.querySelector<HTMLElement>(".file-body");
  if (!body) return;
  const oldPath = f.previousPath ?? f.path;
  const oldRev = f.status === "added" ? null : ctx.oldRev;
  const newRev = f.status === "removed" ? null : ctx.newRev;
  if (imageType(f.path) && !/\.svg$/i.test(f.path)) {
    const [a, b] = await Promise.all([readImage(ctx, oldRev, oldPath), readImage(ctx, newRev, f.path)]);
    show(body, imageDiff(a, b));
    wireImageDiff(body);
    return;
  }
  let hunks: Hunk[];
  if (context === null && f.patch) hunks = parsePatch(f.patch);
  else {
    const [a, b] = await Promise.all([readText(ctx, oldRev, oldPath), readText(ctx, newRev, f.path)]);
    if (a === null || b === null) {
      show(body, h("p", null, f.patch === null ? "A binary file, or larger than the viewer compares: it has no lines to show." : "The whole file could not be read."));
      return;
    }
    hunks = hunksOf(maskEmails(a), maskEmails(b), context ?? 3);
    if (f.additions === 0 && f.deletions === 0) {
      const s = hunkStats(hunks);
      const counts = block.querySelector("header .counts");
      if (counts) counts.textContent = `+${s.additions} −${s.deletions}`;
    }
  }
  if (ctx.hideWhitespace) hunks = ignoreWhitespace(hunks);
  if (!hunks.length) {
    show(body, h("p", null, ctx.hideWhitespace ? "Only whitespace changed." : f.status === "renamed" ? "Renamed, with no change to its lines." : "No change to its lines."));
    return;
  }
  const nodes = await highlightHunks(hunks, f.path);
  const expandable = f.status !== "added" && f.status !== "removed";
  show(
    body,
    diffTable(hunks, ctx.mode, nodes, `Changes to ${f.path}`),
    expandable
      ? h(
          "p",
          { class: "expand" },
          h("button", { type: "button", class: "link", "data-context": String((context ?? 3) + 20) }, "Show 20 more lines of context"),
          " · ",
          h("button", { type: "button", class: "link", "data-context": "all" }, "Show the whole file"),
        )
      : null,
  );
}

function wireImageDiff(body: HTMLElement): void {
  const modes = body.querySelectorAll<HTMLButtonElement>(".image-modes button");
  const twoUp = body.querySelector<HTMLElement>(".two-up");
  const overlay = body.querySelector<HTMLElement>(".overlay");
  const range = body.querySelector<HTMLInputElement>("input.mix");
  if (!twoUp || !overlay || !range) return;
  let mode = "two-up";
  const apply = () => {
    twoUp.hidden = mode !== "two-up";
    overlay.hidden = mode === "two-up";
    range.hidden = mode === "two-up";
    const step = Math.max(0, Math.min(10, Number(range.value) || 0));
    overlay.className = `overlay ${mode === "swipe" ? `swipe-${step}` : `onion-${step}`}`;
  };
  range.min = "0";
  range.max = "10";
  modes.forEach((b, i) =>
    b.addEventListener("click", () => {
      mode = ["two-up", "swipe", "onion"][i] ?? "two-up";
      apply();
    }),
  );
  range.addEventListener("input", apply);
  apply();
}

/** The files of a commit or a comparison: the tree of changed files, then each file's diff. */
async function mountFiles(into: HTMLElement, ctx: DiffContext, files: T.FileChangeSummary[], more: string | null): Promise<void> {
  const blocks = files.map((f, i) =>
    h("section", { class: "file-diff", id: `diff-${i + 1}` }, fileHeader(ctx.env.repo, f.status === "removed" ? ctx.oldRev : ctx.newRev, f, i), h("div", { class: "file-body", "aria-live": "polite" }, h("p", null, "Reading…"))),
  );
  show(
    into,
    h(
      "div",
      { class: "code-layout" },
      changedTree(files),
      h("div", { class: "code-main" }, optionsBar(ctx.env, ctx.mode, ctx.hideWhitespace), ...blocks, more ? h("p", null, h("a", { href: `${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(ctx.env.search)), page: more })}` }, "The next files")) : null),
    ),
  );
  const sections = [...into.querySelectorAll<HTMLElement>("section.file-diff")];
  // The first 30 files at once, the others when they come near (raw reads are not counted, but a
  // comparison of hundreds of files should not read them all).
  const fill = (i: number) => {
    const s = sections[i];
    if (!s || s.dataset.filled) return;
    s.dataset.filled = "1";
    void fillFile(s, ctx, files[i], null);
  };
  sections.slice(0, 30).forEach((_, i) => fill(i));
  if (sections.length > 30 && "IntersectionObserver" in globalThis) {
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) fill(sections.indexOf(e.target as HTMLElement));
    }, { rootMargin: "600px" });
    sections.slice(30).forEach((s) => seen.observe(s));
  } else sections.forEach((_, i) => fill(i));
  into.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement | null;
    const more = t?.dataset?.context;
    const section = t?.closest?.("section.file-diff") as HTMLElement | null;
    if (!more || !section) return;
    const i = sections.indexOf(section);
    if (i < 0) return;
    void fillFile(section, ctx, files[i], more === "all" ? Number.POSITIVE_INFINITY : Number(more));
  });
  into.querySelector<HTMLInputElement>("#file-filter")?.addEventListener("input", (ev) => {
    const q = (ev.target as HTMLInputElement).value.trim().toLowerCase();
    sections.forEach((s, i) => (s.hidden = q !== "" && !files[i].path.toLowerCase().includes(q)));
  });
  into.querySelector<HTMLButtonElement>("#download-diff")?.addEventListener("click", async () => {
    // Two-dot comparisons compute their patches here, from the raw files.
    const all = await Promise.all(
      files.map(async (f) => {
        if (f.patch !== null || (f.status !== "added" && f.status !== "removed" && f.status !== "modified")) return f;
        const [a, b] = await Promise.all([readText(ctx, f.status === "added" ? null : ctx.oldRev, f.previousPath ?? f.path), readText(ctx, f.status === "removed" ? null : ctx.newRev, f.path)]);
        return a === null || b === null ? f : { ...f, patch: hunksOf(a, b).length ? unifiedOf(a, b) : "" };
      }),
    );
    const blob = new Blob([diffText(all)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${shortSha(ctx.newRev)}.diff`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
}

/** The unified hunks of two texts, as text. */
function unifiedOf(a: string, b: string): string {
  const out: string[] = [];
  for (const hk of hunksOf(a, b)) {
    out.push(`@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`);
    for (const l of hk.lines) out.push(l.kind === "note" ? `\\ ${l.text}` : `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);
  }
  return out.join("\n");
}

const diffOptions = (env: CodeEnv): { mode: DiffMode; hideWhitespace: boolean } => {
  const p = new URLSearchParams(env.search);
  return { mode: p.get("diff") === "split" ? "split" : "unified", hideWhitespace: p.get("w") === "1" };
};

// ─── the history ─────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

async function mountCommits(slot: HTMLElement, env: CodeEnv): Promise<void> {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the history…"));
  const params = new URLSearchParams(env.search);
  const author = params.get("author") ?? "";
  const since = params.get("since") ?? "";
  const until = params.get("until") ?? "";
  const page = params.get("page");
  let resolved: Awaited<ReturnType<typeof resolveRef>>;
  try {
    resolved = await resolveRef(env, env.target.rest ?? []);
  } catch (e) {
    failed(slot, e, sourceUrl(env, "tree", (env.target.rest ?? [])[0] ?? "HEAD", ""), "history");
    return;
  }
  const path = resolved.ref.path;
  const filter: T.CommitFilter = { rev: resolved.commit, path: path || undefined };
  if (LOGIN.test(author)) filter.authorLogin = author;
  if (DAY.test(since)) filter.since = `${since}T00:00:00Z`;
  if (DAY.test(until)) filter.until = `${until}T23:59:59Z`;
  let list: T.Page<T.CommitSummary>;
  try {
    list = await env.session.git.commits(gh(env), filter, { perPage: 30, cursor: page && /^\d{1,5}$/.test(page) ? page : null });
  } catch (e) {
    failed(slot, e, sourceUrl(env, "tree", resolved.commit, path), "history");
    return;
  }
  const here = (p: string | null) => {
    const q = new URLSearchParams(params);
    if (p === null) q.delete("page");
    else q.set("page", p);
    const s = q.toString();
    return `${location.pathname}${s ? `?${s}` : ""}`;
  };
  const current = Number(page ?? "1") || 1;
  show(
    slot,
    h(
      "div",
      { class: "code-head" },
      refSwitcher(env.repo, "commits", resolved.ref, path, resolved.refs, env.info.defaultBranch),
      h("p", { class: "path-crumbs" }, path ? ["History of ", h("a", { href: repoPath(env.repo, "blob", refSegments(resolved.ref.ref, path)) }, path)] : `History of ${resolved.ref.ref}`),
    ),
    h(
      "form",
      { class: "commit-filters", role: "search" },
      h("label", { for: "f-author" }, "Author (GitHub login) "),
      h("input", { type: "text", id: "f-author", name: "author", value: author, autocomplete: "off", spellcheck: "false", maxlength: "39" }),
      " ",
      h("label", { for: "f-since" }, "Since "),
      h("input", { type: "date", id: "f-since", name: "since", value: DAY.test(since) ? since : "" }),
      " ",
      h("label", { for: "f-until" }, "Until "),
      h("input", { type: "date", id: "f-until", name: "until", value: DAY.test(until) ? until : "" }),
      " ",
      h("button", { type: "submit" }, "Filter"),
      author || since || until ? [" ", h("a", { href: location.pathname }, "Clear the filters")] : null,
    ),
    list.items.length ? h("div", null, commitList(env.repo, list.items, { path: path || undefined })) : h("p", null, "No commit matches."),
    h(
      "p",
      { class: "pager" },
      current > 1 ? h("a", { href: here(current === 2 ? null : String(current - 1)) }, "Newer") : null,
      current > 1 && list.next ? " · " : null,
      list.next ? h("a", { href: here(list.next) }, "Older") : null,
    ),
  );
  wireSwitcher(slot, env, resolved, path);
}

// ─── one commit ──────────────────────────────────────────────────────────────

async function mountCommit(slot: HTMLElement, env: CodeEnv): Promise<void> {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the commit…"));
  const params = new URLSearchParams(env.search);
  const given = (env.target.rest ?? [])[0] ?? "";
  let detail: T.CommitDetail;
  try {
    const sha = isObjectId(given) ? given : await env.session.git.resolve(gh(env), given);
    const page = params.get("page");
    detail = await env.session.git.commit(gh(env), sha, { perPage: 100, cursor: page && /^\d{1,3}$/.test(page) ? page : null });
  } catch (e) {
    failed(slot, e, githubLinks(env.endpoints.web).commit(gh(env), given), "commit");
    return;
  }
  const { mode, hideWhitespace } = diffOptions(env);
  const ctx: DiffContext = { env, oldRev: detail.parents[0] ?? null, newRev: detail.sha, mode, hideWhitespace };
  show(
    slot,
    commitHeader(env.repo, detail),
    h("p", { class: "commit-stats" }, `${plural(detail.files.items.length, "file")} changed${detail.files.next ? " (the first page)" : ""}, `, `${detail.stats.additions.toLocaleString("en-GB")} lines added, ${detail.stats.deletions.toLocaleString("en-GB")} deleted.`),
    detail.parents.length > 1 ? h("p", null, `A merge: the changes shown are against its first parent, ${shortSha(detail.parents[0])}.`) : null,
    h("div", { id: "commit-facts", "aria-live": "polite" }),
    h("div", { id: "commit-extras" }),
    h("div", { id: "commit-files" }),
  );
  const files = slot.querySelector<HTMLElement>("#commit-files");
  if (files) await mountFiles(files, ctx, detail.files.items, detail.files.next);
  const extras = slot.querySelector<HTMLElement>("#commit-extras");
  if (extras) {
    const found = (await Promise.all(commitExtras.map((f) => f(env, detail).catch(() => null)))).filter((x): x is El => !!x);
    if (found.length) show(extras, ...found);
  }
  const facts = slot.querySelector<HTMLElement>("#commit-facts");
  if (facts) void commitFacts(facts, env, detail);
}

/** Where the commit is (the default branch, tags at it) and its checks, after the rest. */
async function commitFacts(into: HTMLElement, env: CodeEnv, c: T.CommitDetail): Promise<void> {
  const lines: El[] = [];
  const refs = await readRefs(env, true).catch(() => null);
  const tags = refs?.tags.filter((t) => t.sha === c.sha).map((t) => t.name) ?? [];
  const branches = refs?.branches.filter((b) => b.sha === c.sha).map((b) => b.name) ?? [];
  if (branches.length) lines.push(h("p", null, `The head of ${branches.length === 1 ? "the branch" : "the branches"} ${branches.join(", ")}.`));
  if (tags.length) lines.push(h("p", null, `Tagged ${tags.join(", ")}.`));
  const def = env.info.defaultBranch;
  const defSha = refs?.branches.find((b) => b.name === def)?.sha;
  if (def && defSha && defSha !== c.sha) {
    try {
      const cmp = await env.session.git.compare(gh(env), c.sha, defSha, { perPage: 1 });
      lines.push(h("p", null, cmp.status === "ahead" || cmp.status === "identical" ? `On the default branch, ${def}.` : `Not on the default branch, ${def}.`));
    } catch {
      // a nicety
    }
  }
  try {
    const runs = await env.session.checks.runs(gh(env), c.sha, { perPage: 100 });
    if (runs.items.length) {
      const done = runs.items.filter((r) => r.status === "completed");
      const count = (k: string) => done.filter((r) => r.conclusion === k).length;
      const failedRuns = count("failure") + count("timed_out") + count("cancelled");
      const words = [
        count("success") ? `${count("success")} passed` : "",
        failedRuns ? `${failedRuns} failed` : "",
        runs.items.length - done.length ? `${runs.items.length - done.length} still running` : "",
        count("skipped") + count("neutral") ? `${count("skipped") + count("neutral")} skipped or neutral` : "",
      ].filter(Boolean);
      lines.push(h("p", { class: failedRuns ? "warning" : "ok" }, `Checks of its own continuous integration: ${words.join(", ")}.`), h("ul", { class: "checks" }, runs.items.slice(0, 20).map((r) => h("li", null, `${maskEmails(r.name)}: ${r.status === "completed" ? (r.conclusion ?? "done") : r.status.replace("_", " ")}`))));
    }
  } catch {
    // checks are a nicety
  }
  if (lines.length) show(into, h("section", { class: "commit-facts" }, lines));
}

// ─── comparisons ─────────────────────────────────────────────────────────────

/** A side of a comparison, resolved to a commit (of this repository, or of a fork of it). */
async function resolveSide(env: CodeEnv, side: RefSpec): Promise<string> {
  const repo: T.RepoRef = side.owner ? { forge: "github", owner: side.owner, name: side.repo ?? env.repo.name } : gh(env);
  let sha: string;
  if (isObjectId(side.ref)) sha = side.ref;
  else if (!side.owner) {
    const refs = await readRefs(env, true);
    sha = refs?.branches.find((b) => b.name === side.ref)?.sha ?? refs?.tags.find((t) => t.name === side.ref)?.sha ?? (await env.session.git.resolve(repo, side.ref));
  } else sha = await env.session.git.resolve(repo, side.ref);
  for (const [op, n] of side.ancestry) {
    if (op === "~") {
      for (let i = 0; i < n; i++) {
        const c = await env.session.git.commit(repo, sha, { perPage: 1 });
        if (!c.parents[0]) throw new GitBackendError("not_found", "no such ancestor");
        sha = c.parents[0];
      }
    } else if (n > 0) {
      const c = await env.session.git.commit(repo, sha, { perPage: 1 });
      if (!c.parents[n - 1]) throw new GitBackendError("not_found", "no such parent");
      sha = c.parents[n - 1];
    }
  }
  return sha;
}

function compareForm(env: CodeEnv, spec: CompareSpec | null): El {
  return h(
    "form",
    { class: "compare-form", id: "compare-form" },
    h("label", { for: "cmp-base" }, "Base "),
    h("input", { type: "text", id: "cmp-base", name: "base", value: spec ? refSpecText(spec.base) : env.info.defaultBranch ?? "", autocomplete: "off", spellcheck: "false", placeholder: "main, v1.0, a commit, main~3" }),
    " ",
    h("label", { for: "cmp-dots" }, "compared "),
    h("select", { id: "cmp-dots", name: "dots" }),
    " ",
    h("label", { for: "cmp-head" }, "with "),
    h("input", { type: "text", id: "cmp-head", name: "head", value: spec ? refSpecText(spec.head) : "", autocomplete: "off", spellcheck: "false", placeholder: "a branch, a tag, owner:branch of a fork" }),
    " ",
    h("button", { type: "submit" }, "Compare"),
  );
}

function wireCompareForm(slot: HTMLElement, env: CodeEnv, dots: 2 | 3): void {
  const form = slot.querySelector<HTMLFormElement>("#compare-form");
  const select = slot.querySelector<HTMLSelectElement>("#cmp-dots");
  if (!form || !select) return;
  for (const [v, label] of [["3", "from their common ancestor (three dots)"], ["2", "directly (two dots)"]] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    o.selected = String(dots) === v;
    select.appendChild(o);
  }
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const base = (form.querySelector<HTMLInputElement>("#cmp-base")?.value ?? "").trim();
    const head = (form.querySelector<HTMLInputElement>("#cmp-head")?.value ?? "").trim();
    const spec = `${base}${select.value === "2" ? ".." : "..."}${head}`;
    if (!base || !head || !parseCompare(spec, env.info.defaultBranch)) {
      form.querySelector("p.warning")?.remove();
      const p = document.createElement("p");
      p.className = "warning";
      p.textContent = "Give a base and a head: a branch, a tag, a commit id, owner:branch for a fork, with ~N or ^ for an ancestor.";
      form.appendChild(p);
      return;
    }
    location.assign(comparePath(env.repo, spec));
  });
}

async function mountCompare(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const text = (env.target.rest ?? []).join("/");
  const spec = text ? parseCompare(text, env.info.defaultBranch) : null;
  if (!spec) {
    show(
      slot,
      h("h2", null, "Compare"),
      h("p", null, "Choose two versions of the repository: branches, tags, commits, or a branch of a fork (owner:branch)."),
      text ? h("p", { class: "warning" }, "This address does not name two versions to compare.") : null,
      compareForm(env, null),
    );
    wireCompareForm(slot, env, 3);
    return;
  }
  show(slot, h("p", { "aria-live": "polite" }, "Comparing…"));
  const baseText = refSpecText(spec.base);
  const headText = refSpecText(spec.head);
  let base: string;
  let head: string;
  try {
    [base, head] = await Promise.all([resolveSide(env, spec.base), resolveSide(env, spec.head)]);
  } catch (e) {
    show(slot, h("h2", null, `Comparing ${baseText} and ${headText}`), compareForm(env, spec), degradedView({ code: e instanceof GitBackendError ? e.code : "unavailable" }, sourceUrl(env, "tree", "HEAD", ""), "version"));
    wireCompareForm(slot, env, spec.dots);
    return;
  }
  const { mode, hideWhitespace } = diffOptions(env);
  const head2: El[] = [h("h2", null, `Comparing ${baseText} ${spec.dots === 3 ? "..." : ".."} ${headText}`), compareForm(env, spec)];
  if (spec.dots === 2) {
    let files: T.FileChangeSummary[];
    try {
      const [a, b] = await Promise.all([env.session.git.tree(gh(env), base, { recursive: true }), env.session.git.tree(gh(env), head, { recursive: true })]);
      files = treeChanges(a.entries, b.entries);
    } catch (e) {
      show(slot, ...head2);
      const box = document.createElement("div");
      slot.appendChild(box);
      failed(box, e, sourceUrl(env, "tree", head, ""), "comparison");
      wireCompareForm(slot, env, spec.dots);
      return;
    }
    show(
      slot,
      ...head2,
      h("p", null, base === head ? "The two versions are the same commit." : `The two trees directly (two dots): ${plural(files.length, "file")} differ between ${shortSha(base)} and ${shortSha(head)}.`),
      h("div", { id: "compare-files" }),
    );
    wireCompareForm(slot, env, spec.dots);
    const into = slot.querySelector<HTMLElement>("#compare-files");
    if (into && files.length) await mountFiles(into, { env, oldRev: base, newRev: head, mode, hideWhitespace }, files.slice(0, 300), null);
    return;
  }
  let cmp: T.Comparison;
  try {
    const page = new URLSearchParams(env.search).get("page");
    cmp = await env.session.git.compare(gh(env), base, head, { perPage: 100, cursor: page && /^\d{1,2}$/.test(page) ? page : null });
  } catch (e) {
    show(slot, ...head2);
    const box = document.createElement("div");
    slot.appendChild(box);
    failed(box, e, sourceUrl(env, "tree", head, ""), "comparison");
    wireCompareForm(slot, env, spec.dots);
    return;
  }
  show(
    slot,
    ...head2,
    h("p", { class: "status-line" }, comparisonInWords(cmp, baseText, headText), ` Their common ancestor is ${shortSha(cmp.mergeBase)}.`),
    cmp.commits.length ? h("section", { class: "compare-commits" }, h("h2", null, `${plural(cmp.commits.length, "commit")}`), ...commitList(env.repo, [...cmp.commits].reverse())) : null,
    h("h2", null, "Files changed"),
    h("div", { id: "compare-files" }),
  );
  wireCompareForm(slot, env, spec.dots);
  const into = slot.querySelector<HTMLElement>("#compare-files");
  if (into) {
    if (cmp.files.items.length) await mountFiles(into, { env, oldRev: cmp.mergeBase, newRev: head, mode, hideWhitespace }, cmp.files.items, cmp.files.next);
    else show(into, h("p", null, "No file changed."));
  }
}

codeViews.commits = mountCommits;
codeViews.commit = mountCommit;
codeViews.compare = mountCompare;
