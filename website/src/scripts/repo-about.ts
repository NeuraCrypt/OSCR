// The About panel's parts that need the files (night phase 02, E6), filled on the repository's home
// once its tree is read: the languages in words (from the tree's sizes, .gitattributes obeyed), the
// community health files and the owner's defaults, and "Cite this repository" (CITATION.cff, or
// codemeta.json) as APA and BibTeX with their Copy buttons. The file view takes a file's language
// from .gitattributes too (linguist-language).
//
// What it costs the reader's 60 anonymous GitHub requests an hour: nothing more. The tree is the
// one the page read; .gitattributes, the citation file and the owner's default files are raw reads,
// not counted.

import { maskEmails } from "../../worker/forge/mask.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import { communityFiles, type CommunityFile, languagesInWords, languageStats, overviewLinks, ownerDefaults } from "../lib/about.ts";
import { attributesOf, parseAttributes } from "../lib/attributes.ts";
import { apa, bibtex, type Citation, citationOfCff, citationOfCodemeta } from "../lib/citation.ts";
import { entryAt, refSegments } from "../lib/code-nav.ts";
import { repoPath } from "../lib/forge.ts";
import { type El, h } from "../lib/repo-view.ts";
import { show } from "./dom.ts";
import { type CodeEnv, copy, languageOverrides, type Opened, repoRef, treeExtras } from "./repo-code.ts";

/** A small file of the repository at the page's commit (a raw read), or null. */
async function small(env: CodeEnv, commit: string, path: string, max = 256 * 1024): Promise<string | null> {
  try {
    const f = await env.session.git.readFile(repoRef(env), commit, path, { maxBytes: max });
    return f.binary || f.lfs ? null : utf8Text(f.bytes);
  } catch {
    return null;
  }
}

const attributes = new Map<string, Promise<string>>();
/** The root .gitattributes at a commit ("" without one), read once per page. */
function gitattributes(env: CodeEnv, opened: Opened): Promise<string> {
  let p = attributes.get(opened.commit);
  if (!p) {
    p = entryAt(opened.entries, ".gitattributes") ? small(env, opened.commit, ".gitattributes", 64 * 1024).then((t) => t ?? "") : Promise.resolve("");
    attributes.set(opened.commit, p);
  }
  return p;
}

languageOverrides.push(async (env, opened, path) => attributesOf(parseAttributes(await gitattributes(env, opened)), path).language ?? null);

/** "Cite this repository": the preferred citation (or the software), APA and BibTeX, copied. */
function citeBlock(env: CodeEnv, ref: string, c: Citation, path: string): El {
  const lines: El[] = [
    h("p", { class: "cite-apa", id: "cite-apa" }, apa(c.work)),
    h("p", null, h("button", { type: "button", class: "link", id: "copy-apa" }, "Copy APA")),
    h("pre", { class: "cite-bibtex", id: "cite-bibtex" }, bibtex(c.work)),
    h("p", null, h("button", { type: "button", class: "link", id: "copy-bibtex" }, "Copy BibTeX")),
  ];
  return h(
    "details",
    { class: "cite-repo" },
    h("summary", null, "Cite this repository"),
    c.message ? h("p", { class: "cite-message" }, c.message) : null,
    c.preferred ? h("p", { class: "cite-message" }, "Its authors ask to cite this work:") : null,
    ...lines,
    c.preferred && c.software.doi ? h("p", { class: "cite-message" }, `The software itself: doi:${c.software.doi}${c.software.version ? `, version ${c.software.version}` : ""}.`) : null,
    h("p", { class: "cite-message" }, "From ", h("a", { href: repoPath(env.repo, "blob", refSegments(ref, path)) }, path), "."),
  );
}

treeExtras.push(async (_slot, env, opened, dir) => {
  const about = document.getElementById("about-extras");
  if (dir !== "" || !about) return;
  const blocks: (El | null)[] = [];
  // Languages, from the tree's sizes.
  const stats = languageStats(opened.entries, await gitattributes(env, opened));
  if (stats.length) blocks.push(h("p", { class: "languages" }, `Languages: ${languagesInWords(stats)}.`));
  // Community health files, the owner's defaults for those missing (raw reads of <owner>/.github).
  const found: CommunityFile[] = communityFiles(opened.entries);
  if (env.repo.name.toLowerCase() !== ".github") {
    const defaults = await Promise.all(
      ownerDefaults(found).map(async (d) => ((await small({ ...env, repo: { owner: env.repo.owner, name: ".github" } }, "HEAD", d.path, 64 * 1024)) !== null ? { ...d, fromOwner: true } : null)),
    );
    found.push(...defaults.filter((d): d is CommunityFile => d !== null));
  }
  const links = overviewLinks(env.repo, opened.ref.ref, found);
  if (links) blocks.push(h("p", { class: "community-title" }, "Community"), links);
  // The citation.
  const cff = found.find((f) => f.kind === "citation");
  let citation: Citation | null = null;
  let from = "";
  if (cff) {
    const t = await small(env, opened.commit, cff.path);
    citation = t ? citationOfCff(t) : null;
    from = cff.path;
  }
  if (!citation && entryAt(opened.entries, "codemeta.json")) {
    const t = await small(env, opened.commit, "codemeta.json");
    citation = t ? citationOfCodemeta(t) : null;
    from = "codemeta.json";
  }
  if (citation) blocks.push(citeBlock(env, opened.ref.ref, citation, from));
  if (!blocks.some(Boolean)) return;
  show(about, h("h3", null, "About the code"), ...blocks);
  for (const [button, source, idle] of [["copy-apa", "cite-apa", "Copy APA"], ["copy-bibtex", "cite-bibtex", "Copy BibTeX"]] as const) {
    const b = about.querySelector<HTMLElement>(`#${button}`);
    b?.addEventListener("click", () => void copy(maskEmails(about.querySelector(`#${source}`)?.textContent ?? ""), b, idle));
  }
});
