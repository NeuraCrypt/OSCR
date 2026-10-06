// The file finder and the search of the /r/ shell (night phase 02, E7), in the registry's viewer:
// find/<ref> (key t anywhere in the code views) lists the files as the reader types, and search/?q=
// reads the text of a small repository in the reader's browser when the form is sent. Pure parts:
// src/lib/finder.ts.
//
// What it costs the reader's 60 anonymous GitHub requests an hour: the branches and the tree (kept
// for the tab), as the code view; the search's files are raw reads, not counted. Beyond the search's
// limits, GitHub's code search (it needs a GitHub sign-in) is the last resort, said as such.

import { text as utf8Text } from "../../worker/forge/objects.ts";
import { atSource, entryAt, githubLinks, licenceShows, refSegments, refSwitcher } from "../lib/code-nav.ts";
import { finderFiles, finderList, findFiles, type Hit, parseQuery, SEARCH_LIMITS, searchPlan, searchResults, searchText } from "../lib/finder.ts";
import { isPathSegment, repoPath } from "../lib/forge.ts";
import { type El, h } from "../lib/repo-view.ts";
import { show } from "./dom.ts";
import { type CodeEnv, codeViews, failed, openRef, type Opened, repoRef, sourceUrl, wireSwitcher } from "./repo-code.ts";

async function gitattributes(env: CodeEnv, opened: Opened): Promise<string> {
  if (!entryAt(opened.entries, ".gitattributes")) return "";
  try {
    return utf8Text((await env.session.git.readFile(repoRef(env), opened.commit, ".gitattributes", { maxBytes: 64 * 1024 })).bytes);
  } catch {
    return "";
  }
}

// ─── the finder ──────────────────────────────────────────────────────────────

codeViews.find = async (slot, env) => {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the files…"));
  let opened: Opened;
  try {
    opened = await openRef(env, env.target.rest ?? []);
  } catch (e) {
    failed(slot, e, sourceUrl(env, "tree", (env.target.rest ?? [])[0] ?? env.info.defaultBranch ?? "HEAD", ""), "file list");
    return;
  }
  const ref = opened.ref.ref;
  const files = finderFiles(opened.entries, await gitattributes(env, opened));
  const initial = new URLSearchParams(env.search).get("q") ?? "";
  show(
    slot,
    h(
      "div",
      { class: "code-head" },
      refSwitcher(env.repo, "find", opened.ref, "", opened.refs, env.info.defaultBranch),
      h("p", { class: "file-actions" }, h("a", { href: repoPath(env.repo, "tree", refSegments(ref)) }, "The files"), " · ", h("a", { href: `${repoPath(env.repo, "search")}?${new URLSearchParams({ ref })}` }, "Search the text")),
    ),
    h(
      "form",
      { class: "finder", role: "search", id: "finder-form" },
      h("label", { for: "finder-input" }, "Find a file "),
      h("input", { type: "search", id: "finder-input", autocomplete: "off", spellcheck: "false", placeholder: "Letters of its path, in order", value: initial }),
      h("small", null, " ↑ ↓ to choose, Enter to open, Esc to go back"),
    ),
    opened.truncated ? h("p", { class: "warning" }, "This repository's tree is very large: the finder lists the files GitHub sent (over 100,000).") : null,
    h("div", { id: "finder-list" }),
  );
  wireSwitcher(slot, env, opened, "");
  const input = slot.querySelector<HTMLInputElement>("#finder-input");
  const list = slot.querySelector<HTMLElement>("#finder-list");
  if (!input || !list) return;
  let selected = 0;
  const render = () => {
    const matches = findFiles(files, input.value, 100);
    selected = 0;
    show(list, finderList(env.repo, ref, input.value.trim() ? matches : findFiles(files, "", 100), files.length));
  };
  const items = () => [...list.querySelectorAll<HTMLLIElement>("ol.finder-results > li")];
  const choose = (k: number) => {
    const all = items();
    if (!all.length) return;
    selected = (k + all.length) % all.length;
    all.forEach((li, i) => li.classList.toggle("selected", i === selected));
    all[selected].scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => {
    render();
    const u = new URL(location.href);
    if (input.value) u.searchParams.set("q", input.value);
    else u.searchParams.delete("q");
    history.replaceState(null, "", u.pathname + u.search);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      choose(selected + 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      choose(selected - 1);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      history.back();
    }
  });
  slot.querySelector("#finder-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const a = items()[selected]?.querySelector("a");
    if (a) location.assign(a.href);
  });
  render();
  input.focus();
};

// ─── the search ──────────────────────────────────────────────────────────────

codeViews.search = async (slot, env) => {
  const params = new URLSearchParams(env.search);
  const q = params.get("q") ?? "";
  // A ref from the address: its segments must be path segments (repoPath's rule), else the default.
  const asked = params.get("ref") ?? "";
  const refAsked = asked.length <= 255 && asked.split("/").every(isPathSegment) ? asked : "";
  const caseSensitive = params.get("case") === "1";
  const form = (ref: string): El =>
    h(
      "form",
      // GET to this same page (the view's own address): ?q=…&ref=…&case=1
      { class: "repo-search", role: "search" },
      h("label", { for: "repo-q" }, "Search the text of this repository "),
      h("input", { type: "search", id: "repo-q", name: "q", value: q, autocomplete: "off", spellcheck: "false", maxlength: "200", placeholder: "words, path:src/ language:python" }),
      h("input", { type: "hidden", name: "ref", value: ref }),
      " ",
      h("label", null, h("input", { type: "checkbox", name: "case", value: "1", checked: caseSensitive ? "checked" : null }), " match case"),
      " ",
      h("button", { type: "submit" }, "Search"),
    );
  let opened: Opened;
  try {
    opened = await openRef(env, refAsked ? refSegments(refAsked) : []);
  } catch (e) {
    failed(slot, e, sourceUrl(env, "tree", refAsked || env.info.defaultBranch || "HEAD", ""), "repository");
    return;
  }
  const ref = opened.ref.ref;
  const head = h("div", { class: "code-head" }, h("p", null, `At ${ref}. `, h("a", { href: repoPath(env.repo, "find", refSegments(ref)) }, "Find a file by its name"), " (key t)."));
  const query = q ? parseQuery(q, caseSensitive) : null;
  if (!query) {
    show(slot, head, form(ref), q ? h("p", { class: "warning" }, "Write the words to look for (200 characters at most), with path: or language: if you like.") : null);
    return;
  }
  const licence = licenceShows(env.info.licenseSpdx);
  if (!licence.show) {
    show(slot, head, form(ref), h("p", null, licence.why));
    return;
  }
  const plan = searchPlan(opened.entries, query, await gitattributes(env, opened));
  const githubSearch = githubLinks(env.endpoints.web).search(repoRef(env), q);
  if (plan.tooLarge) {
    show(
      slot,
      head,
      form(ref),
      h("p", null, `This repository is larger than the viewer searches in your browser (${SEARCH_LIMITS.files} files or ${SEARCH_LIMITS.bytes / 1024 / 1024} MB of text). Narrow the search with path: or language:.`),
      atSource("GitHub's code search reads it all, for readers signed in to GitHub.", githubSearch),
    );
    return;
  }
  show(slot, head, form(ref), h("p", { id: "search-progress", "aria-live": "polite" }, `Reading ${plan.files.length.toLocaleString("en-GB")} files…`), h("div", { id: "search-results" }));
  const progress = slot.querySelector<HTMLElement>("#search-progress");
  const results = slot.querySelector<HTMLElement>("#search-results");
  const hits: Hit[] = [];
  let read = 0;
  let failedReads = 0;
  const queue = [...plan.files];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      try {
        const f = await env.session.git.readFile(repoRef(env), opened.commit, path, { maxBytes: SEARCH_LIMITS.fileBytes });
        if (!f.binary && !f.lfs) {
          const hit = searchText(path, utf8Text(f.bytes), query);
          if (hit) hits.push(hit);
        }
      } catch {
        failedReads++;
      }
      read++;
      if (progress && read % 10 === 0) progress.textContent = `Read ${read.toLocaleString("en-GB")} of ${plan.files.length.toLocaleString("en-GB")} files…`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  hits.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const shown = hits.slice(0, SEARCH_LIMITS.results);
  const lines = hits.reduce((n, x) => n + x.count, 0);
  if (progress) {
    progress.textContent = hits.length
      ? `${lines.toLocaleString("en-GB")} ${lines === 1 ? "line" : "lines"} in ${hits.length.toLocaleString("en-GB")} ${hits.length === 1 ? "file" : "files"}${hits.length > shown.length ? ` (the first ${shown.length} shown)` : ""}.`
      : "Nothing found.";
    if (plan.skipped || failedReads) progress.textContent += ` ${plan.skipped ? `${plan.skipped} files over 384 KB were not searched, as on GitHub.` : ""}${failedReads ? ` ${failedReads} files could not be read.` : ""}`;
  }
  if (results) show(results, searchResults(env.repo, ref, shown));
};
