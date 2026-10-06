// The release pages' view trees (night phase 07, E4; docs/RELEASES.md): pure functions from what
// GitHub and the registry's layer say to `El` trees, testable in Node
// (tests/forge-pages/release-view.test.ts). src/scripts/repo-releases.ts mounts them.
//
// A state is said in words ("Latest", "Pre-release", "Draft", "Immutable", `.ok` / `.warning`), never
// with a pill; every text is masked for email addresses; the files, the source archives and the
// feeds are GitHub's links, each saying so. Like every browser script, it never names the platform.

import { maskEmails } from "../../worker/forge/mask.ts";
import type * as T from "../../worker/forge/types.ts";
import { repoPath, type RepoCoords } from "./forge.ts";
import {
  ARCHIVES_WHY,
  assetDownloadUrl,
  downloadsInWords,
  editReleasePath,
  releasePath,
  releaseStates,
  sizeInWords,
  sourceArchives,
  tieInWords,
  type ReleaseTie,
  type StateWord,
} from "./releases.ts";
import { type El, h } from "./repo-view.ts";

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : "");
const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");
const isSha = (s: string) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s);

/** The states as words, each in its tone. */
export function statesLine(states: readonly StateWord[]): El | null {
  if (!states.length) return null;
  const out: (El | string)[] = [];
  states.forEach((s, i) => {
    if (i) out.push(" · ");
    out.push(h("span", { class: s.tone ? `state ${s.tone}` : "state" }, s.words));
  });
  return h("span", { class: "states" }, ...out);
}

/** Where the release's code is: its tag at its commit (the registry's code view), when known. */
function codeLine(repo: RepoCoords, r: Pick<T.Release, "tagName" | "target" | "draft">, commit: string | null): (El | string)[] {
  const parts: (El | string)[] = ["Tag ", h("a", { href: repoPath(repo, "tree", r.tagName.split("/")) }, r.tagName)];
  const sha = commit ?? (isSha(r.target) ? r.target : null);
  if (sha) parts.push(" at commit ", h("a", { href: repoPath(repo, "commit", [sha]) }, h("code", null, short(sha))));
  else if (r.target) parts.push(" from ", h("code", null, maskEmails(r.target)));
  if (r.draft) parts.push(" (GitHub makes the tag when the draft is published)");
  return parts;
}

/** One release of the list. */
export function releaseRow(repo: RepoCoords, r: T.Release, latestId: string | null, ties: readonly ReleaseTie[], excerpt: string): El {
  const title = maskEmails(r.name.trim() || r.tagName);
  const when = r.draft ? `drafted ${day(r.createdAt)}` : `published ${day(r.publishedAt ?? r.createdAt)}`;
  return h(
    "li",
    { class: "release-row" },
    h("p", { class: "title" }, r.draft ? h("span", null, title) : h("a", { href: releasePath(repo, r.tagName) }, title), " ", statesLine(releaseStates(r, latestId))),
    h("p", { class: "line" }, ...codeLine(repo, r, null), ` · ${when}${r.author?.login ? ` by ${r.author.login}` : ""}`, r.assets.length ? ` · ${r.assets.length} ${r.assets.length === 1 ? "file" : "files"}` : ""),
    ...ties.map((t) => h("p", { class: "line tie-line" }, `Goes with ${tieInWords(t)} of `, paperLink(t), t.status === "proposed" ? " (proposed to the paper's authors)" : "")),
    excerpt ? h("p", { class: "excerpt" }, excerpt) : null,
    r.draft ? h("p", { class: "line" }, h("a", { href: editReleasePath(repo, r.tagName) }, "Edit or publish the draft")) : null,
  );
}

/** A paper by its page when it has one, else by its DOI (doi.org, the paper's own address). */
export function paperLink(t: Pick<ReleaseTie, "paper">): El | string {
  const title = t.paper.title ? maskEmails(t.paper.title) : `doi:${t.paper.doi}`;
  return t.paper.slug ? h("a", { href: `/paper/${encodeURIComponent(t.paper.slug)}/` }, title) : h("a", { href: `https://doi.org/${t.paper.doi}` }, title);
}

/** The first words of a release's notes, as text (the list shows them; the release's page renders
 *  them whole). */
export function notesExcerpt(body: string, max = 280): string {
  const text = maskEmails(body)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text;
}

/** The release page's head: its title, states, where its code is, who and when. */
export function releaseHead(repo: RepoCoords, r: T.Release, latestId: string | null, commit: string | null): El {
  return h(
    "div",
    { class: "release-head" },
    h("h2", null, maskEmails(r.name.trim() || r.tagName), " ", statesLine(releaseStates(r, latestId))),
    h("p", { class: "line" }, ...codeLine(repo, r, commit)),
    h("p", { class: "line" }, r.draft ? `Drafted ${day(r.createdAt)}` : `Published ${day(r.publishedAt ?? r.createdAt)}`, r.author?.login ? ` by ${r.author.login}` : "", r.immutable ? ". GitHub keeps its tag and its files as they are (an immutable release); its text stays editable." : "."),
  );
}

/** "For the paper": the versions of papers the release goes with, the tracing map versioned with it,
 *  the Zenodo DOI of its validated map when there is one (the real Zenodo's only: a sandbox deposit is
 *  a test, never shown), and what the Mac is doing for it. */
export function tieBlock(ties: readonly ReleaseTie[], answered: readonly { kind: string; paper: string; outcome: string; message: string }[] = [], pending: readonly { kind: string }[] = []): El[] {
  const out: El[] = [h("h3", null, "For the paper")];
  if (!ties.length) {
    out.push(h("p", null, "This release is tied to no version of a paper yet. A person who may push, or a verified author of the paper, ties it below: the version of the paper it goes with, and the tracing map versioned with it."));
  }
  for (const t of ties) {
    const items: El[] = [h("p", null, `It goes with ${tieInWords(t)} of `, paperLink(t), ` (doi:${t.paper.doi}).`, t.status === "proposed" ? " The tie is proposed: the paper's verified authors confirm it." : "")];
    if (t.map) {
      items.push(
        h(
          "p",
          null,
          `Its tracing map is versioned with it: digest `,
          h("code", { class: "digest" }, t.map.digest.slice(0, 12)),
          `, ${t.map.pairs} paragraph–line ${t.map.pairs === 1 ? "pair" : "pairs"} in this repository`,
          t.map.commit && t.commit && t.map.commit !== t.commit ? `; the map's lines are at commit ${short(t.map.commit)}, the release at ${short(t.commit)}` : "",
          ".",
        ),
      );
    } else if (!answered.some((a) => a.kind === "release" && a.paper === t.paper.doi && a.outcome === "done")) {
      items.push(h("p", { class: "explain" }, "The registry's Mac versions the tracing map with the release when it next reads it; this page then says so."));
    }
    if (t.deposit) items.push(h("p", null, "Its validated tracing map has a Zenodo DOI: ", h("a", { href: `https://doi.org/${t.deposit.doi}` }, t.deposit.doi), "."));
    // The Mac's words for this paper (its map versioned: only while last night's layer has no map yet).
    for (const a of answered.filter((x) => (x.paper === t.paper.doi || x.kind === "archive") && !(x.kind === "release" && t.map))) {
      items.push(h("p", { class: a.outcome === "done" ? "ok" : a.outcome === "failed" ? "warning" : "" }, `${JOB_NAMES[a.kind] ?? a.kind}: ${maskEmails(a.message)}`));
    }
    out.push(h("div", { class: "tie" }, ...items));
  }
  const waiting = [...new Set(pending.map((j) => j.kind).filter((k) => k in JOB_WAITING))];
  if (waiting.length) out.push(h("p", { class: "explain" }, `Asked of the registry's Mac, not answered yet: ${waiting.map((k) => JOB_WAITING[k]).join(", ")}.`));
  return out;
}

const JOB_NAMES: Readonly<Record<string, string>> = {
  release: "The map versioned with the release",
  archive: "Software Heritage",
  deposit: "Zenodo",
};
const JOB_WAITING: Readonly<Record<string, string>> = {
  release: "the tracing map's version",
  archive: "Software Heritage's archive",
  deposit: "the Zenodo deposit",
};

/** The release's files: GitHub's, each with its size, its SHA-256 (GitHub's, computed at upload) and
 *  GitHub's download count. */
export function assetsTable(repo: RepoCoords, tag: string, assets: readonly T.ReleaseAsset[], web?: string): El {
  if (!assets.length) return h("p", { class: "muted-note" }, "No file is attached to this release.");
  return h(
    "table",
    { class: "assets" },
    h("thead", null, h("tr", null, h("th", null, "File"), h("th", null, "Size"), h("th", null, "SHA-256"), h("th", null, "Downloads"), h("th", null, "Attached"))),
    h(
      "tbody",
      null,
      ...assets.map((a) =>
        h(
          "tr",
          { "data-asset": a.id },
          h("td", { class: "name" }, h("a", { href: assetDownloadUrl(repo, tag, a.name, web) }, maskEmails(a.name)), a.label ? h("span", { class: "label-text" }, ` ${maskEmails(a.label)}`) : null),
          h("td", null, sizeInWords(a.size)),
          h("td", { class: "digest" }, a.digest ? h("code", { title: a.digest }, `${a.digest.slice(0, 16)}…`) : "not given"),
          h("td", null, downloadsInWords(a.downloads)),
          h("td", null, day(a.createdAt)),
        ),
      ),
    ),
  );
}

/** The source archives: GitHub's links, and why they are. */
export function archivesBlock(repo: RepoCoords, tag: string, web?: string): El[] {
  const a = sourceArchives(repo, tag, web);
  return [
    h("p", null, "Source code, as GitHub archives the tag: ", h("a", { href: a.zip }, "zip"), " · ", h("a", { href: a.tarball }, "tar.gz"), "."),
    h("p", { class: "explain" }, ARCHIVES_WHY),
  ];
}

/** One tag of the tags page. */
export function tagRow(repo: RepoCoords, tag: T.Tag, release: T.Release | null, web?: string): El {
  const a = sourceArchives(repo, tag.name, web);
  return h(
    "tr",
    null,
    h("td", { class: "name" }, h("a", { href: repoPath(repo, "tree", tag.name.split("/")) }, tag.name)),
    h("td", null, h("a", { href: repoPath(repo, "commit", [tag.sha]) }, h("code", null, short(tag.sha)))),
    h(
      "td",
      null,
      release
        ? release.draft
          ? "a draft release"
          : h("a", { href: releasePath(repo, tag.name) }, maskEmails(release.name.trim() || release.tagName))
        : h("a", { href: `${repoPath(repo, "releases", ["new"])}?tag=${encodeURIComponent(tag.name)}` }, "Draft a release from it"),
    ),
    h("td", { class: "archives" }, h("a", { href: a.zip }, "zip"), " · ", h("a", { href: a.tarball }, "tar.gz")),
  );
}
