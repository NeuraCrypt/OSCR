// Releases and tags in the /r/ shell (night phase 07, E4; docs/RELEASES.md): the list (releases/,
// ?q= the filter, on submit only), a release's page (releases/tag/<tag>, releases/latest), the form
// (releases/new, releases/edit/<tag>), the changelog (releases/changelog), a file of a release
// (releases/download/<tag>/<file>, releases/latest/download/<file>: GitHub's, linked), and the tags
// (tags/).
//
// Releases and tags are GitHub's objects (D00-6): read in the reader's browser, on the reader's own
// quota (the list, 1 request; the latest, 1; a release, 2 or 3; the form, 3 to 5 with the generated
// notes), written as the person, ONE authorized action each (act-releases.ts). The registry's own is
// the release's tie to a version of a paper, the tracing map versioned with it, and the Mac's work for
// it (Software Heritage, the Zenodo deposit of the validated map): the static layer as of last night
// (0 Worker requests signed out), live for a signed-in reader (the shell's one request). Drafts are
// seen only by the people who may push: they are read as the person, one authorization, and kept in
// the tab (src/lib/release-stash.ts).
//
// Everything is text nodes or view trees, masked for email addresses; the files, the archives and the
// feeds are GitHub's links, each saying so. Like every browser script, it never names the platform.

import { GitBackendError } from "../../worker/forge/errors.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { layerShard, layerUrl, repoPath } from "../lib/forge.ts";
import { parseSummaries } from "../lib/issue-view.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { declarePull } from "../lib/pull-view.ts";
import { stashedDrafts, type StashedRelease } from "../lib/release-stash.ts";
import { archivesBlock, assetsTable, notesExcerpt, releaseHead, releaseRow, tagRow, tieBlock } from "../lib/release-view.ts";
import {
  changelogPath,
  changelogText,
  coAuthorLogins,
  digestVerdict,
  editReleasePath,
  exportIgnored,
  FEEDS_WHY,
  feedUrls,
  generateNotes,
  latestDownloadUrl,
  matchRelease,
  newReleasePath,
  PAPER_VERSIONS,
  parseReleaseConfig,
  parseReleaseQuery,
  parseReleaseTarget,
  parseTies,
  previousTag,
  pullsInRange,
  releasePath,
  releasePrefill,
  releasesPath,
  RESEARCH_RELEASE_YML,
  assetDownloadUrl,
  sortReleases,
  tagsPath,
  VERSION_WORDS,
  type NotesMapLink,
  type ReleaseTie,
} from "../lib/releases.ts";
import { type El, h, moderatedThread } from "../lib/repo-view.ts";
import { nextVersions, parseSemver, sortTags } from "../lib/semver.ts";
import { show, toDom } from "./dom.ts";
import { sessionStore } from "./forge-client.ts";
import { confirmAction, el, signedInHint, signInLine, whoIsHere } from "./pull-common.ts";
import { type CodeEnv, codeViews, copy, failed, repoRef } from "./repo-code.ts";
import { mapsOf } from "./repo-traced.ts";

/** Releases read on one page (GitHub's largest page). */
export const RELEASES_PAGE = 100;
/** Tags read on one page. */
export const TAGS_PAGE = 100;

// ─── extension points (E5: the files' upload; E6: the environment) ──────────

/** Panels a later element adds to a release's page, after its files. */
export const releaseExtras: ((slot: HTMLElement, env: CodeEnv, release: T.Release, commit: string | null) => Promise<void>)[] = [];
/** The upload of a file to a release (E5), when built: it mounts its form in `slot`. */
export const assetUpload: { mount: ((slot: HTMLElement, env: CodeEnv, release: T.Release) => void) | null } = { mount: null };

// ─── the registry's layer for the releases ───────────────────────────────────

interface Context {
  ties: Map<string, ReleaseTie[]>;
  papers: { doi: string; slug: string | null; title: string | null; map: string | null }[];
  answered: { kind: string; ref: string; paper: string; outcome: string; message: string }[];
  pending: { kind: string; ref: string }[];
}

let staticEntry: Promise<Record<string, unknown> | null> | null = null;

/** The static layer's entry of the repository (as of last night; a static file, no Worker request). */
function layerEntry(env: CodeEnv): Promise<Record<string, unknown> | null> {
  staticEntry ??= (async () => {
    try {
      const res = await fetch(layerUrl(await layerShard(env.repo.owner, env.repo.name)), { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      const shard = (await res.json()) as Record<string, unknown>;
      const e = shard[`${env.repo.owner}/${env.repo.name}`.toLowerCase()];
      return e && typeof e === "object" ? (e as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  })();
  return staticEntry;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The ties, the papers and the Mac's answers: the static layer's, and the live ones signed in. */
async function context(env: CodeEnv): Promise<Context> {
  const entry = await layerEntry(env);
  const frozen = parseTies(entry?.releases ?? env.layer?.releases);
  const ties = new Map<string, ReleaseTie[]>();
  const add = (t: ReleaseTie) => ties.set(t.tag, [...(ties.get(t.tag) ?? []).filter((x) => x.paper.doi !== t.paper.doi), t]);
  const live = Array.isArray(env.layer?.releaseTies) ? env.layer.releaseTies : null;
  if (live) {
    // Signed in: the live ties, with what the Mac versioned last night for the same (tag, paper).
    for (const raw of live) {
      if (!isObj(raw) || typeof raw.tag !== "string" || typeof raw.paper !== "string") continue;
      const known = frozen.find((f) => f.tag === raw.tag && f.paper.doi.toLowerCase() === String(raw.paper).toLowerCase());
      const paper = (env.layer?.papers ?? []).find((p) => p.doi.toLowerCase() === String(raw.paper).toLowerCase());
      const [t] = parseTies([
        {
          tag: raw.tag,
          paper: known?.paper ?? { doi: raw.paper, slug: paper?.slug ?? null, title: paper?.title ?? null },
          version: raw.version,
          label: raw.label,
          status: raw.status,
          commit: raw.commit,
          shown: raw.shown,
          map: known?.map ?? null,
          deposit: known?.deposit ?? null,
        },
      ]);
      if (t) add(t);
    }
  } else frozen.forEach(add);
  const papers = new Map<string, Context["papers"][number]>();
  for (const p of [...(env.layer?.papers ?? []), ...(Array.isArray(entry?.papers) ? (entry.papers as unknown[]) : [])]) {
    if (!isObj(p) || typeof p.doi !== "string") continue;
    const k = p.doi.toLowerCase();
    const before = papers.get(k);
    papers.set(k, {
      doi: p.doi,
      slug: typeof p.slug === "string" ? p.slug : (before?.slug ?? null),
      title: typeof p.title === "string" ? maskEmails(p.title) : (before?.title ?? null),
      map: typeof p.map === "string" && /^[0-9a-f]{64}$/.test(p.map) ? p.map : (before?.map ?? null),
    });
  }
  const answered = (Array.isArray(env.layer?.answered) ? env.layer.answered : [])
    .filter(isObj)
    .map((a) => ({ kind: String(a.kind ?? ""), ref: String(a.ref ?? ""), paper: String(a.paper ?? ""), outcome: String(a.outcome ?? ""), message: String(a.message ?? "") }));
  const pending = (Array.isArray(env.layer?.jobs) ? env.layer.jobs : []).filter(isObj).map((j) => ({ kind: String(j.kind ?? ""), ref: String(j.ref ?? "") }));
  return { ties, papers: [...papers.values()], answered, pending };
}

const back = (env: CodeEnv, path?: string) => path ?? releasesPath(env.repo);
const repoWithId = (env: CodeEnv) => ({ ...env.repo, id: env.info.key.id });
const box = (id: string) => h("div", { id, "aria-live": "polite" });

/** A draft as the Worker answered it, as GitHub's type (the list and the form read both). */
function fromStash(d: StashedRelease): T.Release {
  return {
    id: d.id,
    tagName: d.tag,
    target: d.target,
    name: d.name,
    body: d.body,
    draft: true,
    prerelease: d.prerelease,
    immutable: d.immutable,
    author: { id: "", login: "", name: null } as unknown as T.Actor,
    createdAt: d.createdAt,
    publishedAt: null,
    assets: d.assets.map((a) => ({ ...a, downloadUrl: "" })),
    webUrl: "",
  };
}

// ─── releases/: the list ─────────────────────────────────────────────────────

async function mountList(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const q = new URLSearchParams(env.search).get("q")?.trim() ?? "";
  const parsed = parseReleaseQuery(q);
  const signedIn = signedInHint();
  const feeds = feedUrls(env.repo);
  const head: El[] = [
    h(
      "div",
      { class: "code-head" },
      h("h2", null, "Releases"),
      h(
        "p",
        { class: "file-actions" },
        h("a", { href: newReleasePath(env.repo) }, "Draft a new release"),
        " · ",
        h("a", { href: tagsPath(env.repo) }, "Tags"),
        " · ",
        h("a", { href: changelogPath(env.repo) }, "Changelog"),
      ),
    ),
    h(
      "form",
      { class: "repo-search pull-filter", role: "search", id: "release-filter" },
      h("label", { for: "release-q" }, "Find "),
      h("input", { type: "search", id: "release-q", name: "q", value: q, autocomplete: "off", spellcheck: "false", placeholder: "words, tag:v1, prerelease:false, paper:10.…" }),
      " ",
      h("button", { type: "submit" }, "Find"),
    ),
  ];
  if (parsed.errors.length) head.push(h("p", { class: "warning" }, parsed.errors.join(" ")));
  show(slot, ...head, h("p", { "aria-live": "polite" }, "Reading the releases…"));
  let list: T.Page<T.Release>;
  let latest: T.Release | null;
  let ctx: Context;
  try {
    [list, latest, ctx] = await Promise.all([
      env.session.releases.list(repoRef(env), { perPage: RELEASES_PAGE }),
      env.session.releases.latest(repoRef(env)),
      context(env),
    ]);
  } catch (e) {
    const b = document.createElement("div");
    show(slot, ...head);
    slot.append(b);
    failed(b, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/releases`, "releases");
    return;
  }
  const stash = signedIn ? stashedDrafts(env.repo, sessionStore()) : null;
  const drafts = (stash?.drafts ?? []).map(fromStash).filter((d) => !list.items.some((r) => r.id === d.id));
  const items = sortReleases([...drafts, ...list.items]);
  const latestId = latest?.id ?? null;
  // Night phase 16: a release the owner hid leaves the registry's list.
  const shown = items.filter((r) => !moderatedThread(env.layer, "release", r.tagName));
  const kept = q ? shown.filter((r) => matchRelease(r, parsed.node, { latestId, ties: ctx.ties })) : shown;
  const rows = kept.map((r) => releaseRow(env.repo, r, latestId, ctx.ties.get(r.tagName) ?? [], notesExcerpt(r.body)));
  const count = list.items.length;
  const draftsLine = !signedIn
    ? null
    : stash
      ? h("p", { class: "explain" }, `Your drafts are listed as GitHub showed them to you at ${new Date(stash.at * 1000).toISOString().slice(11, 16)} UTC, in this tab only. `, h("button", { type: "button", id: "show-drafts" }, "Read them again"))
      : h("p", { class: "explain" }, "A draft is seen only by the people who may push. ", h("button", { type: "button", id: "show-drafts" }, "Show my drafts"), " (GitHub shows them to you, one authorization; the registry keeps nothing).");
  show(
    slot,
    ...head,
    h(
      "p",
      { class: "status-line" },
      q
        ? `${rows.length} of the ${items.length} ${items.length === 1 ? "release matches" : "releases match"} “${q}”.`
        : count
          ? `${count}${list.next ? "+" : ""} published ${count === 1 ? "release" : "releases"}, the highest version first${latest ? `; GitHub's latest is ${latest.tagName}` : ""}.`
          : "No release is published yet.",
    ),
    draftsLine,
    box("release-act"),
    rows.length ? h("ul", { class: "release-list" }, ...rows) : null,
    !count && !drafts.length ? h("p", null, "A release gives the code a version: the one a paper cites. ", h("a", { href: newReleasePath(env.repo) }, "Draft the first release"), ".") : null,
    h("p", { class: "at-source" }, "Feeds: ", h("a", { href: feeds.releases }, "the releases"), " · ", h("a", { href: feeds.tags }, "the tags"), ", at the source. ", FEEDS_WHY),
  );
  slot.querySelector<HTMLFormElement>("#release-filter")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    location.assign(releasesPath(env.repo, slot.querySelector<HTMLInputElement>("#release-q")?.value.trim() || undefined));
  });
  slot.querySelector("#show-drafts")?.addEventListener("click", () => {
    const b = slot.querySelector<HTMLElement>("#release-act");
    if (b) void confirmAction(b, declarePull(repoWithId(env), "release_drafts", {}, back(env)));
  });
}

// ─── releases/tag/<tag>: a release ───────────────────────────────────────────

async function mountRelease(slot: HTMLElement, env: CodeEnv, wanted: string | null): Promise<void> {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the release…"));
  const ref = repoRef(env);
  let release: T.Release | null = null;
  let all: T.Page<T.Release>;
  let latest: T.Release | null;
  let ctx: Context;
  try {
    [all, latest, ctx] = await Promise.all([env.session.releases.list(ref, { perPage: RELEASES_PAGE }), env.session.releases.latest(ref), context(env)]);
    const tag = wanted ?? latest?.tagName ?? null;
    if (tag) {
      release = all.items.find((r) => r.tagName === tag) ?? null;
      if (!release) {
        try {
          release = await env.session.releases.byTag(ref, tag);
        } catch (e) {
          if (!(e instanceof GitBackendError && e.code === "not_found")) throw e;
        }
      }
    }
    if (!release && wanted && signedInHint()) {
      const d = stashedDrafts(env.repo, sessionStore())?.drafts.find((x) => x.tag === wanted);
      if (d) release = fromStash(d);
    }
  } catch (e) {
    failed(slot, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/releases`, "release");
    return;
  }
  if (!release) {
    show(
      slot,
      h("h2", null, wanted ? `No release ${wanted}` : "No release yet"),
      h("p", null, wanted ? `GitHub has no published release with the tag ${wanted}.` : "GitHub has no published release of this repository yet."),
      h("p", null, h("a", { href: releasesPath(env.repo) }, "The releases"), " · ", h("a", { href: tagsPath(env.repo) }, "The tags"), wanted ? [" · ", h("a", { href: newReleasePath(env.repo, { tag: wanted }) }, `Draft a release of ${wanted}`)] : null),
    );
    return;
  }
  const r = release;
  let commit: string | null = null;
  if (!r.draft) {
    try {
      commit = await env.session.git.resolve(ref, `refs/tags/${r.tagName}`);
    } catch {
      commit = null;
    }
  }
  const signedIn = signedInHint();
  const ties = ctx.ties.get(r.tagName) ?? [];
  const others = sortReleases(all.items.filter((x) => !x.draft && x.tagName !== r.tagName));
  const prev = previousTag(r.tagName, all.items);
  const notes = r.body.trim() ? (await renderMarkdown(maskEmails(r.body), { repo: env.repo })).el : h("p", { class: "muted-note" }, "No notes.");
  const latestLine = wanted === null ? h("p", { class: "explain" }, "The latest release, as GitHub says: the one its maintainers set as latest, or else the highest version that is neither a draft nor a pre-release.") : null;
  const compare = others.length
    ? h(
        "form",
        { class: "compare-form", id: "release-compare" },
        h("label", { for: "compare-with" }, "Compare with "),
        h("select", { id: "compare-with", name: "with" }, ...others.map((o) => h("option", { value: o.tagName }, o.tagName))),
        " ",
        h("button", { type: "submit" }, "Compare"),
        prev ? [" · ", h("a", { href: repoPath(env.repo, "compare", [`${prev}...${r.tagName}`]) }, `What changed since ${prev}`)] : null,
      )
    : null;
  const body: (El | null)[] = [
    latestLine,
    releaseHead(env.repo, r, latest?.id ?? null, commit),
    h("section", { class: "release-notes" }, notes),
    h("h3", null, "Files"),
    assetsTable(env.repo, r.tagName, r.assets),
    r.assets.some((a) => a.digest) ? h("p", { class: "explain" }, "A file you have is checked against these here: its SHA-256 is computed in your browser, and the file never leaves your computer. ", h("button", { type: "button", id: "check-file" }, "Check a file")) : null,
    box("check-said"),
    box("asset-upload"),
    ...(r.draft ? [] : archivesBlock(env.repo, r.tagName)),
    r.draft ? null : h("p", null, h("button", { type: "button", id: "export-ignore" }, "What the archives leave out"), " (the repository's .gitattributes, read at the tag)"),
    box("export-said"),
    compare,
    h("div", { id: "release-extras" }),
  ];
  const research: (El | null)[] = [
    ...tieBlock(ties, ctx.answered.filter((a) => a.ref === r.tagName), ctx.pending.filter((j) => j.ref === r.tagName)),
    signedIn && !r.draft ? researchForm(ctx, ties) : null,
    signedIn && r.draft ? h("p", { class: "explain" }, "Publish the draft to ask for Software Heritage's archive or the Zenodo deposit of its tracing map; tie it to a paper's version from its form.") : null,
    box("research-act"),
  ];
  const actions: (El | null)[] = signedIn
    ? [
        h("h3", null, "Change it"),
        h(
          "p",
          null,
          h("a", { href: editReleasePath(env.repo, r.tagName) }, r.draft ? "Edit or publish the draft" : "Edit its title, notes and flags"),
          " · ",
          h("button", { type: "button", id: "delete-release" }, "Delete the release"),
        ),
        box("release-act"),
      ]
    : [h("p", { class: "explain" }, "Sign in with GitHub to tie this release to a paper's version, ask for its archive, or change it: every change is made by GitHub, as you.")];
  const toc = h(
    "div",
    { class: "sidebar" },
    h("h3", null, "Releases"),
    h(
      "ul",
      { class: "release-toc" },
      ...sortReleases(all.items.filter((x) => !x.draft)).slice(0, 40).map((o) =>
        h("li", null, o.tagName === r.tagName ? h("strong", null, o.tagName) : h("a", { href: releasePath(env.repo, o.tagName) }, o.tagName), ` ${(o.publishedAt ?? o.createdAt).slice(0, 10)}`),
      ),
    ),
    h("p", null, h("a", { href: releasesPath(env.repo) }, "All the releases"), " · ", h("a", { href: tagsPath(env.repo) }, "Tags")),
  );
  show(slot, h("div", { class: "record" }, h("div", { class: "body" }, ...body, ...research, ...actions), toc));
  wireRelease(slot, env, r, commit, ties);
  if (assetUpload.mount && signedIn) {
    const up = slot.querySelector<HTMLElement>("#asset-upload");
    if (up) assetUpload.mount(up, env, r);
  }
  const extras = slot.querySelector<HTMLElement>("#release-extras");
  if (extras) for (const x of releaseExtras) await x(extras, env, r, commit);
}

/** The research extension on a published release: tie a paper's version, untie, archive, deposit. */
function researchForm(ctx: Context, ties: readonly ReleaseTie[]): El {
  const papers = ctx.papers;
  return h(
    "form",
    { class: "release-research", id: "research-form" },
    h("p", null, h("strong", null, "Tie it to a version of a paper")),
    papers.length
      ? h("p", null, h("label", { for: "tie-paper" }, "The paper "), h("select", { id: "tie-paper", name: "paper" }, ...papers.map((p) => h("option", { value: p.doi }, p.title ? `${p.title} (${p.doi})` : p.doi)), h("option", { value: "" }, "another DOI…")))
      : null,
    h("p", { hidden: papers.length ? "hidden" : null, id: "tie-doi-line" }, h("label", { for: "tie-doi" }, "Its DOI "), h("input", { type: "text", id: "tie-doi", name: "doi", placeholder: "10.1234/…", spellcheck: "false", autocomplete: "off" })),
    h("p", null, h("label", { for: "tie-version" }, "The version it goes with "), h("select", { id: "tie-version", name: "version" }, ...PAPER_VERSIONS.map((v) => h("option", { value: v }, VERSION_WORDS[v])))),
    h("p", null, h("label", { for: "tie-label" }, "Its label, if any "), h("input", { type: "text", id: "tie-label", name: "label", maxlength: "80", placeholder: "bioRxiv v2, revision 1…" })),
    h("p", null, h("button", { type: "button", id: "tie-go" }, "Tie"), ties.length ? [" · ", ...ties.flatMap((t, i) => [i ? " · " : "", h("button", { type: "button", "data-untie": t.paper.doi }, `Untie ${t.paper.doi}`)])] : null),
    h("p", null, h("strong", null, "Keep it")),
    h("p", null, h("button", { type: "button", id: "ask-archive" }, "Ask Software Heritage to archive it"), ", by a person who may push; Software Heritage then keeps the code when GitHub does not."),
    ties.length
      ? h(
          "p",
          null,
          h("button", { type: "button", id: "ask-deposit" }, "Ask for a Zenodo DOI for its tracing map"),
          ", validated by you, a verified author of the paper with your ORCID iD; the DOI goes on the map (its links and metadata), never on the code, and on Zenodo's sandbox while the registry is built.",
        )
      : null,
  );
}

function wireRelease(slot: HTMLElement, env: CodeEnv, r: T.Release, commit: string | null, ties: readonly ReleaseTie[]): void {
  const act = (id: string) => slot.querySelector<HTMLElement>(`#${id}`);
  const here = releasePath(env.repo, r.tagName);
  slot.querySelector<HTMLFormElement>("#release-compare")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const other = slot.querySelector<HTMLSelectElement>("#compare-with")?.value;
    if (other) location.assign(repoPath(env.repo, "compare", [`${other}...${r.tagName}`]));
  });
  // A file checked against its digest, in the browser (WebCrypto): the file never leaves.
  slot.querySelector("#check-file")?.addEventListener("click", () => {
    const said = act("check-said");
    if (!said) return;
    const input = el("input", { type: "file", id: "check-input" });
    said.replaceChildren(el("p", {}, el("label", { for: "check-input" }, "The file "), input));
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f) return;
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const asset = r.assets.find((a) => a.name === f.name) ?? r.assets.find((a) => a.digest === digest) ?? null;
      const v = digestVerdict(digest, asset?.digest ?? null);
      said.replaceChildren(
        el("p", { class: v.same ? "ok" : v.same === false ? "warning" : "" }, asset ? `${asset.name}: ${v.words}` : "No file of this release has this name or this SHA-256."),
        el("p", { class: "explain" }, "Its SHA-256: ", el("code", { class: "digest" }, digest)),
      );
    });
    input.click();
  });
  // What an archive of the tag leaves out: .gitattributes' export-ignore, read at the tag (raw, not
  // counted in the reader's quota), with the tree (1 request).
  slot.querySelector("#export-ignore")?.addEventListener("click", async () => {
    const said = act("export-said");
    if (!said || !commit) return;
    said.replaceChildren(el("p", {}, "Reading .gitattributes at the tag…"));
    let attrs = "";
    try {
      const f = await env.session.git.readFile(repoRef(env), commit, ".gitattributes", { maxBytes: 256 * 1024 });
      attrs = f.binary ? "" : utf8Text(f.bytes);
    } catch {
      attrs = "";
    }
    if (!/export-(ignore|subst)/.test(attrs)) {
      said.replaceChildren(el("p", {}, "The repository's .gitattributes names no export-ignore at this tag: the archives hold every file of the tag."));
      return;
    }
    try {
      const tree = await env.session.git.tree(repoRef(env), commit, { recursive: true });
      const out = exportIgnored(attrs, tree.entries.filter((e) => e.type === "blob").map((e) => e.path));
      said.replaceChildren(
        el("p", {}, out.ignored.length ? `The archives leave out ${out.ignored.length} ${out.ignored.length === 1 ? "file" : "files"} (export-ignore):` : "No file of the tag is left out."),
        out.ignored.length ? el("ul", { class: "fork-list" }, ...out.ignored.slice(0, 50).map((p) => el("li", {}, el("code", {}, p)))) : "",
        out.substituted.length ? el("p", { class: "explain" }, `${out.substituted.length} ${out.substituted.length === 1 ? "file has" : "files have"} placeholders git fills when it archives (export-subst: the commit, its date; git's own formatting, nothing of the repository runs).`) : "",
        el("p", { class: "explain" }, "Read from the .gitattributes at the repository's root; git also reads those of folders."),
      );
    } catch (e) {
      failed(said, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}`, "files");
    }
  });
  const research = act("research-act");
  const declare = (payload: Record<string, unknown>) => (research ? void confirmAction(research, declarePull(repoWithId(env), "release_research", { tag: r.tagName, ...payload }, here)) : undefined);
  const paperSel = slot.querySelector<HTMLSelectElement>("#tie-paper");
  const doiLine = act("tie-doi-line");
  paperSel?.addEventListener("change", () => {
    if (doiLine) doiLine.hidden = paperSel.value !== "";
  });
  slot.querySelector("#tie-go")?.addEventListener("click", async () => {
    const doi = paperSel?.value || slot.querySelector<HTMLInputElement>("#tie-doi")?.value.trim() || "";
    const version = slot.querySelector<HTMLSelectElement>("#tie-version")?.value ?? "published";
    const label = slot.querySelector<HTMLInputElement>("#tie-label")?.value.trim() ?? "";
    const ctx = await context(env);
    const map = ctx.papers.find((p) => p.doi.toLowerCase() === doi.toLowerCase())?.map ?? null;
    declare({ paper: { doi, version, ...(label ? { label } : {}) }, ...(map ? { map } : {}) });
  });
  for (const b of slot.querySelectorAll<HTMLButtonElement>("button[data-untie]")) {
    b.addEventListener("click", () => declare({ untie: b.dataset.untie }));
  }
  slot.querySelector("#ask-archive")?.addEventListener("click", () => declare({ archive: true }));
  slot.querySelector("#ask-deposit")?.addEventListener("click", async () => {
    const t = ties[0];
    if (!t) return;
    const ctx = await context(env);
    const map = ctx.papers.find((p) => p.doi.toLowerCase() === t.paper.doi.toLowerCase())?.map ?? t.shown ?? null;
    declare({ deposit: t.paper.doi, ...(map ? { map } : {}) });
  });
  slot.querySelector("#delete-release")?.addEventListener("click", () => {
    const b = act("release-act");
    if (!b) return;
    const input = el("input", { type: "text", id: "delete-confirm", autocomplete: "off", spellcheck: "false" });
    const go = el("button", { type: "button" }, "Delete it");
    b.replaceChildren(
      el("section", { class: "danger" }, el("p", {}, `Deleting the release keeps its tag ${r.tagName} and its commit; the files attached to it go. A release a paper's version is tied to stays: untie it first.`), el("p", {}, el("label", { for: "delete-confirm" }, `Type ${r.tagName} to confirm `), input, " ", go)),
    );
    go.addEventListener("click", () => {
      const said = document.createElement("div");
      b.append(said);
      void confirmAction(said, declarePull(repoWithId(env), "release_delete", { id: r.id, confirm: input.value.trim() }, releasesPath(env.repo)));
    });
  });
}

// ─── releases/new, releases/edit/<tag>: the form ─────────────────────────────

async function mountForm(slot: HTMLElement, env: CodeEnv, editTag: string | null): Promise<void> {
  const title = editTag ? `Edit the release ${editTag}` : "Draft a new release";
  const intro = [
    h("h2", null, title),
    h("p", null, "A release is the version of the code that goes with a version of the paper: its tag names one commit, the one the tracing map's lines are at. GitHub makes it, as you, one authorization; a draft first, published when its files are attached, is the safe way."),
  ];
  if (!signedInHint()) {
    show(slot, ...intro);
    slot.append(signInLine("Sign in with GitHub to draft a release: GitHub makes it as you."));
    return;
  }
  show(slot, ...intro, h("p", { "aria-live": "polite" }, "Reading the tags, the branches and the releases…"));
  const ref = repoRef(env);
  let tags: T.Page<T.Tag>;
  let branches: T.Page<T.Branch>;
  let releases: T.Page<T.Release>;
  let latest: T.Release | null;
  let ctx: Context;
  try {
    [tags, branches, releases, latest, ctx] = await Promise.all([
      env.session.git.listTags(ref, { perPage: TAGS_PAGE }),
      env.session.git.listBranches(ref, { perPage: 100 }),
      env.session.releases.list(ref, { perPage: RELEASES_PAGE }),
      env.session.releases.latest(ref),
      context(env),
    ]);
  } catch (e) {
    const b = document.createElement("div");
    show(slot, ...intro);
    slot.append(b);
    failed(b, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/releases/new`, "tags and branches");
    return;
  }
  let editing: T.Release | null = null;
  if (editTag) {
    editing = releases.items.find((r) => r.tagName === editTag) ?? null;
    if (!editing) {
      const d = stashedDrafts(env.repo, sessionStore())?.drafts.find((x) => x.tag === editTag);
      editing = d ? fromStash(d) : null;
    }
    if (!editing) {
      show(slot, ...intro, h("p", { class: "warning" }, `GitHub shows no release ${editTag} to this page. A draft is listed once GitHub showed it to you: `), h("p", null, h("a", { href: releasesPath(env.repo) }, "Show your drafts on the releases page")));
      return;
    }
  }
  const pre = editing ? {} : releasePrefill(env.search);
  const tagOf = new Map(tags.items.map((t) => [t.name, t.sha]));
  const sortedTags = sortTags(tags.items.map((t) => t.name), (x) => x);
  // The next version follows the highest version tagged (a pre-release included: v1.1.0-rc.1 → v1.1.0),
  // else GitHub's latest release.
  const suggestions = nextVersions(sortedTags.find((t) => parseSemver(t) !== null) ?? latest?.tagName ?? null);
  const defaultBranch = env.info.defaultBranch ?? branches.items[0]?.name ?? "";

  // The fields, as DOM (the view trees have no textarea); every text the person types stays theirs.
  const tagInput = el("input", { type: "text", id: "rel-tag", name: "tag", autocomplete: "off", spellcheck: "false", maxlength: "255" });
  tagInput.value = editing?.tagName ?? pre.tag ?? suggestions[0]?.tag ?? "";
  const tagSaid = el("p", { class: "explain", "aria-live": "polite" });
  const targetSel = el("select", { id: "rel-target", name: "target" }, ...branches.items.map((b) => el("option", { value: b.name }, b.name)));
  targetSel.value = pre.target && branches.items.some((b) => b.name === pre.target) ? pre.target : defaultBranch;
  const commitInput = el("input", { type: "text", id: "rel-commit", name: "commit", autocomplete: "off", spellcheck: "false", maxlength: "64", placeholder: "or a full commit id" });
  if (pre.target && /^[0-9a-f]{40}$/.test(pre.target)) commitInput.value = pre.target;
  if (editing && /^[0-9a-f]{40}$/.test(editing.target)) commitInput.value = editing.target;
  const targetSaid = el("p", { class: "explain", "aria-live": "polite" });
  const prevSel = el("select", { id: "rel-prev", name: "previous" }, el("option", { value: "" }, "none"), ...sortedTags.map((t) => el("option", { value: t }, t)));
  const nameInput = el("input", { type: "text", id: "rel-name", name: "name", maxlength: "256" });
  nameInput.value = editing?.name ?? pre.title ?? "";
  const bodyInput = el("textarea", { id: "rel-body", name: "body", class: "pull-text", rows: "12" });
  bodyInput.value = editing?.body ?? pre.body ?? "";
  const ghNotes = el("input", { type: "checkbox", id: "rel-ghnotes" });
  const preInput = el("input", { type: "checkbox", id: "rel-pre" });
  preInput.checked = editing?.prerelease ?? pre.prerelease ?? false;
  const latestSel = el("select", { id: "rel-latest" }, el("option", { value: "legacy" }, "as GitHub chooses (the highest version)"), el("option", { value: "true" }, "yes"), el("option", { value: "false" }, "no"));
  const preview = el("div", { class: "pull-preview", hidden: "" });
  const notesSaid = el("p", { class: "explain", "aria-live": "polite" });
  // The research extension.
  const paperSel = el(
    "select",
    { id: "rel-paper" },
    el("option", { value: "" }, "no paper"),
    ...ctx.papers.map((p) => el("option", { value: p.doi }, p.title ? `${p.title} (${p.doi})` : p.doi)),
    el("option", { value: "other" }, "another DOI…"),
  );
  const doiInput = el("input", { type: "text", id: "rel-doi", autocomplete: "off", spellcheck: "false", placeholder: "10.1234/…", hidden: "" });
  if (pre.doi) {
    const known = ctx.papers.find((p) => p.doi.toLowerCase() === pre.doi);
    paperSel.value = known ? known.doi : "other";
    if (!known) {
      doiInput.hidden = false;
      doiInput.value = pre.doi;
    }
  }
  const versionSel = el("select", { id: "rel-version" }, ...PAPER_VERSIONS.map((v) => el("option", { value: v }, VERSION_WORDS[v])));
  versionSel.value = pre.paperVersion ?? "published";
  const labelInput = el("input", { type: "text", id: "rel-label", maxlength: "80", placeholder: "bioRxiv v2, revision 1…" });
  const mapSaid = el("p", { class: "explain", "aria-live": "polite" });
  const archiveBox = el("input", { type: "checkbox", id: "rel-archive" });
  const depositBox = el("input", { type: "checkbox", id: "rel-deposit" });
  const said = el("div", { "aria-live": "polite" });
  const saveDraft = el("button", { type: "button", class: "primary", id: "rel-draft" }, editing && !editing.draft ? "Update the release" : "Save the draft");
  const publish = el("button", { type: "button", id: "rel-publish" }, editing && !editing.draft ? "Update" : editing ? "Publish the draft" : "Publish the release");
  if (editing && !editing.draft) publish.hidden = true;

  const existingCommit = () => tagOf.get(tagInput.value.trim()) ?? null;
  let resolved: string | null = null;
  const describeTag = () => {
    const t = tagInput.value.trim();
    const known = existingCommit();
    const used = releases.items.find((r) => r.tagName === t && r.id !== editing?.id);
    tagSaid.replaceChildren(
      !t
        ? "Name the version: a tag such as v1.0.0 (semantic versioning: major, minor, patch)."
        : used
          ? `A release already uses the tag ${t}: edit it, or choose another tag.`
          : known
            ? `The tag ${t} exists: it names commit ${known.slice(0, 7)}, which the release names too.`
            : `A new tag: GitHub makes ${t} at the commit below when the release is published (a draft makes none).`,
    );
    const lock = !!known || (editing !== null && !editing.draft);
    targetSel.disabled = lock;
    commitInput.disabled = lock;
  };
  const resolveTarget = async () => {
    const known = existingCommit();
    if (known) {
      resolved = known;
    } else if (/^[0-9a-f]{40}$/.test(commitInput.value.trim())) {
      resolved = commitInput.value.trim();
    } else {
      try {
        resolved = targetSel.value ? await env.session.git.resolve(ref, `refs/heads/${targetSel.value}`) : null;
      } catch {
        resolved = null;
      }
    }
    targetSaid.replaceChildren(resolved ? `The release names commit ${resolved.slice(0, 12)}${known ? " (the tag's)" : commitInput.value.trim() ? "" : ` (the head of ${targetSel.value} now)`}: the exact code, which a paper can cite.` : "The commit could not be read: check the branch or the commit id.");
  };
  const describeMap = () => {
    const doi = paperSel.value === "other" ? doiInput.value.trim() : paperSel.value;
    const p = ctx.papers.find((x) => x.doi.toLowerCase() === doi.toLowerCase());
    mapSaid.replaceChildren(
      !doi
        ? "Tie the release to the paper it goes with: the paper's page will list it, with the version."
        : p?.map
          ? `The paper's tracing map, as its page shows it now (digest ${p.map.slice(0, 12)}), is versioned with the release when it is published.`
          : "The registry holds no tracing map of this paper yet: the tie is kept, and the map is versioned when there is one.",
    );
  };
  // The previous tag: GitHub's rule, the highest version below.
  const setPrevious = () => {
    const p = previousTag(tagInput.value.trim(), releases.items);
    prevSel.value = p ?? "";
  };
  tagInput.addEventListener("input", () => {
    describeTag();
    setPrevious();
    void resolveTarget();
  });
  targetSel.addEventListener("change", () => void resolveTarget());
  commitInput.addEventListener("change", () => void resolveTarget());
  paperSel.addEventListener("change", () => {
    doiInput.hidden = paperSel.value !== "other";
    describeMap();
  });
  doiInput.addEventListener("change", describeMap);

  const suggestionButtons = editing ? [] : suggestions.slice(0, 3).map((s) => {
    const b = el("button", { type: "button", title: s.why }, s.tag);
    b.addEventListener("click", () => {
      tagInput.value = s.tag;
      tagInput.dispatchEvent(new Event("input"));
    });
    return b;
  });

  const generate = el("button", { type: "button", id: "rel-generate" }, "Write the notes from what was merged");
  generate.addEventListener("click", async () => {
    notesSaid.replaceChildren("Reading what was merged since the previous tag…");
    try {
      const text = await browserNotes(env, tagInput.value.trim() || "the release", resolved ?? targetSel.value, prevSel.value || null);
      bodyInput.value = bodyInput.value.trim() ? `${bodyInput.value.trimEnd()}\n\n${text}` : text;
      notesSaid.replaceChildren("Written as GitHub writes its notes, with the sections a paper's reader needs; edit them freely.");
    } catch (e) {
      notesSaid.replaceChildren(e instanceof GitBackendError && e.code === "rate_limited" ? "GitHub's anonymous quota for your address is spent for the hour: the notes can be written later, or by GitHub (the box below)." : "The notes could not be written from GitHub's answers just now.");
    }
  });
  const previewBtn = el("button", { type: "button" }, "Preview");
  previewBtn.addEventListener("click", async () => {
    preview.hidden = false;
    preview.replaceChildren(toDom((await renderMarkdown(maskEmails(bodyInput.value), { repo: env.repo })).el));
  });

  const form = el(
    "section",
    { class: "pull-form release-form" },
    el("p", {}, el("label", { for: "rel-tag" }, "Tag "), tagInput, " ", ...suggestionButtons.flatMap((b) => [b, " "])),
    tagSaid,
    el("p", {}, el("label", { for: "rel-target" }, "Target "), targetSel, " ", commitInput),
    targetSaid,
    el("p", {}, el("label", { for: "rel-prev" }, "Previous tag "), prevSel, el("span", { class: "explain" }, " (what the notes and the comparison start from)")),
    el("p", {}, el("label", { for: "rel-name" }, "Title "), nameInput),
    el("p", {}, el("label", { for: "rel-body" }, "Notes (Markdown)")),
    bodyInput,
    el("p", {}, generate, " ", previewBtn),
    notesSaid,
    preview,
    el("p", {}, ghNotes, " ", el("label", { for: "rel-ghnotes" }, "Also let GitHub add its own generated notes after yours")),
    el("p", {}, preInput, " ", el("label", { for: "rel-pre" }, "A pre-release: the code of a preprint or of a manuscript under review (never the latest)")),
    el("p", {}, el("label", { for: "rel-latest" }, "The latest release "), latestSel),
    el(
      "fieldset",
      { class: "release-research" },
      el("legend", {}, "For the paper"),
      el("p", {}, el("label", { for: "rel-paper" }, "The paper "), paperSel, " ", doiInput),
      el("p", {}, el("label", { for: "rel-version" }, "The version it goes with "), versionSel, " ", el("label", { for: "rel-label" }, "its label "), labelInput),
      mapSaid,
      el("p", {}, archiveBox, " ", el("label", { for: "rel-archive" }, "When it is published, ask Software Heritage to archive the repository (it keeps the code when GitHub does not)")),
      el("p", {}, depositBox, " ", el("label", { for: "rel-deposit" }, "When it is published, ask for a Zenodo DOI for the paper's tracing map, validated by me (a verified author of the paper, with my ORCID iD; on Zenodo's sandbox while the registry is built; the code is never deposited)")),
    ),
    el("p", {}, saveDraft, " ", publish),
    said,
  );
  if (editing) form.querySelector(".release-research")?.remove();
  show(slot, ...intro);
  slot.append(form);
  if (!editing) {
    slot.append(
      toDom(
        h(
          "p",
          { class: "explain" },
          "Notes grouped the way a paper's reader needs them: commit a ",
          h("a", { href: `${repoPath(env.repo, "new", [defaultBranch, ".github"])}?filename=release.yml&value=${encodeURIComponent(RESEARCH_RELEASE_YML)}` }, ".github/release.yml"),
          " (changes that affect the results, fixes, data, environment, documentation).",
        ),
      ),
    );
  }
  describeTag();
  setPrevious();
  describeMap();
  await resolveTarget();

  const submit = (draft: boolean) => {
    const tag = tagInput.value.trim();
    if (editing) {
      const payload: Record<string, unknown> = { id: editing.id };
      if (editing.draft && tag !== editing.tagName) payload.tag = tag;
      if (editing.draft && resolved && resolved !== editing.target) payload.target = resolved;
      if (nameInput.value !== editing.name) payload.name = nameInput.value;
      if (bodyInput.value !== editing.body) payload.body = bodyInput.value;
      if (preInput.checked !== editing.prerelease) payload.prerelease = preInput.checked;
      if (latestSel.value !== "legacy") payload.latest = latestSel.value;
      if (editing.draft && !draft) payload.draft = false;
      void confirmAction(said, declarePull(repoWithId(env), "release_edit", payload, releasesPath(env.repo)));
      return;
    }
    if (!resolved) {
      said.replaceChildren(el("p", { class: "warning" }, "The commit the release names is not known yet: choose the branch or give the commit id."));
      return;
    }
    const doi = paperSel.value === "other" ? doiInput.value.trim() : paperSel.value;
    const paper = doi ? ctx.papers.find((p) => p.doi.toLowerCase() === doi.toLowerCase()) : null;
    const payload: Record<string, unknown> = { tag, target: resolved, draft };
    if (nameInput.value.trim()) payload.name = nameInput.value;
    if (bodyInput.value.trim()) payload.body = bodyInput.value;
    if (preInput.checked) payload.prerelease = true;
    if (latestSel.value !== "legacy") payload.latest = latestSel.value;
    if (ghNotes.checked) payload.generateNotes = true;
    if (doi) {
      payload.paper = { doi, version: versionSel.value, ...(labelInput.value.trim() ? { label: labelInput.value.trim() } : {}) };
      if (paper?.map) payload.map = paper.map;
    }
    if (!draft && archiveBox.checked) payload.archive = true;
    if (!draft && depositBox.checked) payload.deposit = true;
    void confirmAction(said, declarePull(repoWithId(env), "release_create", payload, releasesPath(env.repo)));
  };
  saveDraft.addEventListener("click", () => submit(editing ? !!editing.draft : true));
  publish.addEventListener("click", () => submit(false));
  void whoIsHere();
}

/** The notes written in the reader's browser, as GitHub writes them: the pull requests merged between
 *  the previous tag and the target (GitHub's comparison, 1 request; its closed pull requests, 1),
 *  grouped by `.github/release.yml` (raw, not counted), with the registry's research sections: the
 *  tracing-map links on the files the range changed, the research issues fixed at its commits. */
async function browserNotes(env: CodeEnv, tag: string, target: string, previous: string | null): Promise<string> {
  const ref = repoRef(env);
  const [cmp, closed] = await Promise.all([
    previous ? env.session.git.compare(ref, previous, target) : Promise.resolve(null),
    env.session.pulls.list(ref, { state: "closed", sort: "updated", direction: "desc" }, { perPage: 100 }),
  ]);
  const commits = cmp?.commits ?? [];
  const merged = previous ? pullsInRange(closed.items, commits) : closed.items.filter((p) => p.merged).slice(0, 50).reverse();
  let config = null;
  for (const path of [".github/release.yml", ".github/release.yaml"]) {
    try {
      const f = await env.session.git.readFile(ref, env.info.defaultBranch ?? target, path, { maxBytes: 64 * 1024 });
      if (!f.binary) {
        config = parseReleaseConfig(utf8Text(f.bytes)).config;
        break;
      }
    } catch {
      // no configuration at this path
    }
  }
  const changed = new Set((cmp?.files.items ?? []).map((f) => f.path));
  const mapLinks: NotesMapLink[] = [];
  if (changed.size) {
    for (const m of await mapsOf(env)) {
      for (const p of m.pairs) if (changed.has(p.path)) mapLinks.push({ paper: m.title, paragraph: p.paragraph, section: p.section, path: p.path, start: p.start, end: p.end });
    }
  }
  const shas = new Set(commits.map((c) => c.sha));
  const research = parseSummaries(env.layer?.research)
    .filter((i) => i.resolution === "fixed_in_code" && shas.has(i.resolution_ref))
    .map((i) => ({ id: i.id, title: i.title, type: i.type }));
  return generateNotes({
    repo: env.repo,
    tag,
    previousTag: previous,
    pulls: merged.map((p) => ({ number: p.number, title: p.title, author: p.author?.login ?? null, labels: p.labels, coAuthors: coAuthorLogins(commits.filter((c) => c.sha === p.mergeCommit).map((c) => c.message)) })),
    config,
    mapLinks,
    research,
    site: location.origin,
  });
}

// ─── releases/changelog ──────────────────────────────────────────────────────

async function mountChangelog(slot: HTMLElement, env: CodeEnv): Promise<void> {
  show(slot, h("h2", null, "Changelog"), h("p", { "aria-live": "polite" }, "Reading the releases…"));
  let list: T.Page<T.Release>;
  try {
    list = await env.session.releases.list(repoRef(env), { perPage: RELEASES_PAGE });
  } catch (e) {
    failed(slot, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/releases`, "releases");
    return;
  }
  const text = changelogText(env.repo, list.items);
  show(
    slot,
    h("div", { class: "code-head" }, h("h2", null, "Changelog"), h("p", { class: "file-actions" }, h("a", { href: releasesPath(env.repo) }, "The releases"), " · ", h("button", { type: "button", id: "copy-changelog" }, "Copy as Markdown"))),
    h("p", { class: "explain" }, "Every published release's notes, the highest version first: the repository's changelog, to keep in a CHANGELOG.md."),
    (await renderMarkdown(text, { repo: env.repo })).el,
  );
  const b = slot.querySelector<HTMLElement>("#copy-changelog");
  b?.addEventListener("click", () => void copy(text, b, "Copy as Markdown"));
}

// ─── a file of a release: GitHub's ───────────────────────────────────────────

async function mountDownload(slot: HTMLElement, env: CodeEnv, tag: string | null, file: string): Promise<void> {
  let release: T.Release | null = null;
  try {
    release = tag ? await env.session.releases.byTag(repoRef(env), tag) : await env.session.releases.latest(repoRef(env));
  } catch {
    release = null;
  }
  const asset = release?.assets.find((a) => a.name === file) ?? null;
  const url = tag ? assetDownloadUrl(env.repo, tag, file) : latestDownloadUrl(env.repo, file);
  show(
    slot,
    h("h2", null, maskEmails(file)),
    h("p", null, release ? `A file of the release ${release.tagName}${tag ? "" : " (the latest)"}.` : "A file of a release."),
    h("p", null, "The file is GitHub's: the registry never downloads it. ", h("a", { href: url }, "Download it from GitHub"), "."),
    asset?.digest ? h("p", null, "Its SHA-256, as GitHub computed it: ", h("code", { class: "digest" }, asset.digest)) : null,
    release ? h("p", null, h("a", { href: releasePath(env.repo, release.tagName) }, `The release ${release.tagName}`)) : null,
  );
}

// ─── tags/ ───────────────────────────────────────────────────────────────────

async function mountTags(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const head = h("div", { class: "code-head" }, h("h2", null, "Tags"), h("p", { class: "file-actions" }, h("a", { href: releasesPath(env.repo) }, "Releases")));
  show(slot, head, h("p", { "aria-live": "polite" }, "Reading the tags…"));
  let tags: T.Page<T.Tag>;
  let releases: T.Page<T.Release>;
  let ctx: Context;
  try {
    [tags, releases, ctx] = await Promise.all([env.session.git.listTags(repoRef(env), { perPage: TAGS_PAGE }), env.session.releases.list(repoRef(env), { perPage: RELEASES_PAGE }), context(env)]);
  } catch (e) {
    const b = document.createElement("div");
    show(slot, head);
    slot.append(b);
    failed(b, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/tags`, "tags");
    return;
  }
  const byTag = new Map(releases.items.map((r) => [r.tagName, r]));
  const ordered = sortTags(tags.items, (t) => t.name);
  const signedIn = signedInHint();
  show(
    slot,
    head,
    h("p", { class: "status-line" }, tags.items.length ? `${tags.items.length}${tags.next ? "+" : ""} ${tags.items.length === 1 ? "tag" : "tags"}, the highest version first.` : "No tag yet."),
    ordered.length
      ? h(
          "table",
          { class: "branches tags" },
          h("thead", null, h("tr", null, h("th", null, "Tag"), h("th", null, "Commit"), h("th", null, "Release"), h("th", null, "Source (GitHub's)"))),
          h("tbody", null, ...ordered.map((t) => tagRow(env.repo, t, byTag.get(t.name) ?? null))),
        )
      : null,
    h("p", { class: "explain" }, "A tag a published release uses, or one a paper's version is tied to, is not deleted here: a citation of it keeps meaning the same code."),
    signedIn
      ? h(
          "form",
          { class: "tag-form", id: "tag-form" },
          h("h3", null, "Create a tag"),
          h("p", null, h("label", { for: "tag-name" }, "Name "), h("input", { type: "text", id: "tag-name", autocomplete: "off", spellcheck: "false", maxlength: "255" }), " ", h("label", { for: "tag-at" }, "at "), h("input", { type: "text", id: "tag-at", autocomplete: "off", spellcheck: "false", value: env.info.defaultBranch ?? "", placeholder: "a branch or a commit id" })),
          h("p", null, h("label", { for: "tag-message" }, "Message (an annotated tag; leave it empty for a lightweight one) "), h("input", { type: "text", id: "tag-message", autocomplete: "off" })),
          h("p", null, h("button", { type: "submit" }, "Create the tag")),
          h("p", null, h("label", { for: "tag-delete" }, "Or delete the tag "), h("input", { type: "text", id: "tag-delete", autocomplete: "off", spellcheck: "false" }), " ", h("button", { type: "button", id: "tag-delete-go" }, "Delete it")),
        )
      : h("p", { class: "explain" }, "Sign in with GitHub to create or delete a tag: GitHub does it, as you."),
    box("tag-act"),
  );
  const act = slot.querySelector<HTMLElement>("#tag-act");
  slot.querySelector<HTMLFormElement>("#tag-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!act) return;
    const name = slot.querySelector<HTMLInputElement>("#tag-name")?.value.trim() ?? "";
    const at = slot.querySelector<HTMLInputElement>("#tag-at")?.value.trim() ?? "";
    const message = slot.querySelector<HTMLInputElement>("#tag-message")?.value ?? "";
    let sha: string | null = /^[0-9a-f]{40}$/.test(at) ? at : null;
    if (!sha) {
      try {
        sha = await env.session.git.resolve(repoRef(env), at.startsWith("refs/") ? at : `refs/heads/${at}`);
      } catch {
        act.replaceChildren(el("p", { class: "warning" }, `GitHub has no branch ${at}: give a branch or a full commit id.`));
        return;
      }
    }
    void confirmAction(act, declarePull(repoWithId(env), "tag_create", { name, target: sha, ...(message.trim() ? { message } : {}) }, tagsPath(env.repo)));
  });
  slot.querySelector("#tag-delete-go")?.addEventListener("click", () => {
    if (!act) return;
    const name = slot.querySelector<HTMLInputElement>("#tag-delete")?.value.trim() ?? "";
    if (ctx.ties.has(name)) {
      act.replaceChildren(el("p", { class: "warning" }, `A paper's version is tied to ${name}: its tag stays.`));
      return;
    }
    void confirmAction(act, declarePull(repoWithId(env), "tag_delete", { name, confirm: name }, tagsPath(env.repo)));
  });
}

// ─── the dispatcher ──────────────────────────────────────────────────────────

async function mountReleases(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const t = parseReleaseTarget(env.target.rest ?? []);
  if (!t) {
    show(slot, h("p", { class: "warning" }, "This address names no release view."), h("p", null, h("a", { href: releasesPath(env.repo) }, "The releases")));
    return;
  }
  switch (t.kind) {
    case "list":
      return mountList(slot, env);
    case "tag":
      return mountRelease(slot, env, t.tag);
    case "latest":
      return mountRelease(slot, env, null);
    case "new":
      return mountForm(slot, env, null);
    case "edit":
      return mountForm(slot, env, t.tag);
    case "changelog":
      return mountChangelog(slot, env);
    case "latest-download":
      return mountDownload(slot, env, null, t.file);
    case "download":
      return mountDownload(slot, env, t.tag, t.file);
  }
}

codeViews.releases = mountReleases;
codeViews.tags = mountTags;
