// The /r/ shell (night phase 01, E7): ONE static page serves every /r/<owner>/<name>/… path
// (public/_redirects: "/r/* /r/ 200"; 0 Worker requests signed out, D00-5). This script reads the
// path (src/lib/forge.ts parseRepoPath), then, in the reader's browser:
// - the repository from GitHub's anonymous API and raw files, on the reader's own quota (a GitSession
//   of githubBackend over {kind: "anonymous"}); a rate limit or an outage says so in words and
//   links to GitHub;
// - OSCR's layer: the static shard /forge/layer/NN.json signed out, GET /api/forge/repo signed in
//   (the hint cookie);
// and shows it (src/lib/repo-view.ts, src/scripts/repo-code-panel.ts): the heading line, the status
// line in words, the Code button, the quick setup of an empty repository, the papers, the GitHub
// Pages site; under settings/ and branches/, E8's modules (mountSettings, mountBranches).
// Phase 02 builds the code views here (repo-code.ts, repo-history.ts, repo-markdown.ts,
// repo-traced.ts, repo-rich.ts, repo-docs.ts, repo-about.ts, repo-find.ts).
//
// Everything is written as text nodes (masked for email addresses), never as HTML; links are
// checked again here (repo-view.ts safeHref). Like every browser script, it never names the
// platform: the page hands its name in (data-site).

import { githubBackend } from "../../worker/forge/github/index.ts";
import { cachedSession, gitCache, tabStore } from "../lib/gitcache.ts";
import { CODE_VIEWS, repoPath } from "../lib/forge.ts";
import {
  capital,
  dateOfIso,
  degradedBlock,
  type El,
  githubEndpoints,
  goneBlock,
  h,
  latestCommit,
  link,
  loadRepository,
  type Loaded,
  pagesBlock,
  pagesSite,
  papersBlock,
  renamedPath,
  repoHead,
  repoTabs,
  safeHref,
  shellRepo,
  shellTarget,
  siteName,
  statusLine,
  swhUrl,
} from "../lib/repo-view.ts";
import { refSegments } from "../lib/code-nav.ts";
import { toDom } from "./dom.ts";
import { type CodeEnv, mountCode, mountTree, wireKeys } from "./repo-code.ts";
import "./repo-history.ts";
import "./repo-markdown.ts";
import "./repo-traced.ts";
import "./repo-rich.ts";
import "./repo-docs.ts";
import "./repo-about.ts";
import "./repo-find.ts";
import "./repo-edit.ts";
import "./repo-upload.ts";
import "./repo-templates.ts";
import "./repo-pulls.ts";
import "./repo-pull.ts";
import "./repo-pull-files.ts";
import "./repo-conflicts.ts";
import "./repo-issues.ts";
import "./repo-issue.ts";
import "./issue-links.ts";
import { mountForkStatus } from "./repo-forks.ts";
import { codePanel, quickSetup, useTemplate, wireCopy } from "./repo-code-panel.ts";
import { mountBranches } from "./repo-branches.ts";
import { mountSettings } from "./repo-settings.ts";

const HINT = "__Host-oscr_signed_in=1";

/** The page's body for the home view: the Code button or the quick setup, the latest commit, the
 *  README excerpt; the sidebar: the papers, the Pages site, the archive, about. */
function home(loaded: Loaded, site: string): El {
  const { repo, info } = loaded;
  const body: (El | null)[] = [];
  const options = { defaultBranch: info?.defaultBranch ?? null, parent: info?.parent ?? null, isTemplate: info?.isTemplate, site };
  if (info?.description) body.push(h("p", { class: "summary" }, info.description));
  if (loaded.empty) {
    body.push(quickSetup(repo, options));
  } else {
    body.push(codePanel(repo, options));
    // Phase 04: Fork, the forks, the pull requests; a fork's standing against its upstream.
    if (info) body.push(h("div", { id: "fork-status", "aria-live": "polite" }));
    if (info?.isTemplate) body.push(useTemplate(repo));
    if (loaded.latest) body.push(latestCommit(repo, loaded.latest));
    if (info) body.push(h("div", { id: "repo-files", "aria-live": "polite" }));
    // The README's excerpt: the whole README replaces it once the files are read (repo-markdown.ts),
    // under an open licence.
    if (loaded.readme && info?.defaultBranch) {
      body.push(
        h(
          "div",
          { id: "readme-excerpt" },
          h("h2", null, "README"),
          loaded.readme.excerpt ? h("p", null, loaded.readme.excerpt) : null,
          h("p", null, h("a", { href: repoPath(repo, "blob", refSegments(info.defaultBranch, loaded.readme.path)) }, "Read the whole README")),
        ),
      );
    }
  }
  return h("div", { class: "record" }, h("div", { class: "body" }, body), sidebar(loaded, site));
}

function sidebar(loaded: Loaded, site: string): El {
  const { repo, info, layer } = loaded;
  const archive = swhUrl(layer?.swh ?? null);
  const about: (El | string | null)[] = [];
  if (info?.homepage && safeHref(info.homepage)) about.push(h("p", null, "Website: ", link(info.homepage, info.homepage.replace(/^https:\/\//, ""))));
  if (info?.topics.length) about.push(h("p", null, `Topics: ${info.topics.join(", ")}.`));
  if (info?.licenseSpdx) about.push(h("p", null, `Licence detected by GitHub: ${info.licenseSpdx}.`));
  if (info?.pushedAt) {
    const day = dateOfIso(info.pushedAt);
    if (day) about.push(h("p", null, `Last pushed ${day}, as GitHub says.`));
  }
  return h(
    "div",
    { class: "sidebar" },
    // Filled once the files are read (repo-about.ts): languages, community files, the citation.
    h("div", { id: "about-extras", "aria-live": "polite" }),
    papersBlock(layer, site),
    pagesBlock(pagesSite(repo.owner, repo.name, info?.homepage), site),
    archive ? [h("h3", null, "Archive"), h("p", null, link(archive, "Software Heritage's archive"), " of this repository.")] : null,
    about.length ? [h("h3", null, "About"), ...about] : null,
  );
}

/** The whole page for what was read. */
export function page(loaded: Loaded, siteIn: string): El[] {
  const site = siteName(siteIn);
  const { repo, info, error, layer } = loaded;
  const out: El[] = [repoHead({ owner: repo.owner, name: repo.name, info })];
  out.push(statusLine(layer, site, loaded.layerUnknown));
  if (loaded.renamed) {
    out.push(h("p", null, `GitHub now serves ${loaded.target.owner}/${loaded.target.name} as ${repo.owner}/${repo.name} (renamed or transferred); this page follows it.`));
  }
  if (loaded.otherRepository) {
    out.push(h("p", { class: "warning" }, `${capital(site)} knew another repository at this address; the one GitHub serves now is not linked to ${site}.`));
  }
  const gone = layer?.state === "gone" || (error?.code === "not_found" && layer !== null);
  if (!info) {
    if (gone) {
      out.push(goneBlock(repo, layer, site, error?.code === "not_found" ? "GitHub does not serve it any more." : "GitHub did not serve it when last checked."));
      out.push(h("div", { class: "sidebar" }, papersBlock(layer, site)));
      return out;
    }
    if (error) out.push(degradedBlock(repo, error));
    if (error?.code !== "not_found" && loaded.target.view === "home") {
      // The clone commands and GitHub's links need no request: they stay useful.
      out.push(h("div", { class: "record" }, h("div", { class: "body" }, codePanel(repo, { site })), h("div", { class: "sidebar" }, papersBlock(layer, site))));
    }
    return out;
  }
  if (layer?.state === "gone") out.push(goneBlock(repo, layer, site, `${capital(site)} last saw it gone; GitHub serves it again now.`));
  out.push(repoTabs(repo, loaded.target.view));
  if (loaded.target.view === "home") out.push(home(loaded, site));
  else out.push(h("div", { id: "repo-view", "aria-live": "polite" }, h("p", null, "Reading…")));
  return out;
}

async function main(): Promise<void> {
  const root = document.getElementById("repo-shell");
  if (!root) return;
  const site = root.dataset.site ?? "";
  const target = shellTarget(location.pathname);
  if (!target) {
    root.replaceChildren(
      toDom(h("h1", null, "Repository")),
      toDom(h("p", { class: "warning" }, "This address names no repository: it should read /r/<owner>/<name>/, as on GitHub.")),
      toDom(h("p", null, link("/repositories/", "Your repositories"), " · ", link("/hosting/", "the hosting guides"))),
    );
    return;
  }
  const endpoints = githubEndpoints({ api: root.dataset.githubApi, raw: root.dataset.githubRaw, web: root.dataset.githubWeb });
  // The reader's own quota: what never changes is asked once per tab (src/lib/gitcache.ts).
  const session = cachedSession(githubBackend(endpoints, { fetch: globalThis.fetch.bind(globalThis) }).session({ kind: "anonymous" }), gitCache(tabStore()));
  const signedIn = document.cookie.split(/;\s*/).includes(HINT);
  const loaded = await loadRepository(target, {
    session,
    signedIn,
    site: (path) => fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } }),
  });
  const moved = renamedPath(loaded);
  if (moved) history.replaceState(null, "", moved + location.search + location.hash);
  const tail = document.title.includes(" — ") ? document.title.slice(document.title.indexOf(" — ")) : "";
  document.title = `${loaded.repo.owner}/${loaded.repo.name}${tail}`;
  const view = loaded.target.view;
  root.replaceChildren(...page(loaded, site).map(toDom));
  wireCopy(root);
  const slot = document.getElementById("repo-view");
  const env: CodeEnv | null = loaded.info
    ? { repo: loaded.repo, info: loaded.info, session, endpoints, site, target: loaded.target, search: location.search, layer: loaded.layer }
    : null;
  if (slot && loaded.info) {
    const repo = shellRepo(loaded, signedIn);
    if (view === "settings") mountSettings(slot, repo);
    else if (view === "branches") mountBranches(slot, repo, { session });
    else if (env && (CODE_VIEWS as readonly string[]).includes(view)) await mountCode(slot, env);
  }
  const forkSlot = document.getElementById("fork-status");
  if (forkSlot && env) void mountForkStatus(forkSlot, env);
  const files = document.getElementById("repo-files");
  if (files && env && !loaded.empty && loaded.info?.defaultBranch) {
    wireKeys(env);
    await mountTree(files, env, refSegments(loaded.info.defaultBranch), { home: true });
  }
}

if (typeof document !== "undefined") void main();
