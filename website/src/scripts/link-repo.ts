// /new/link/, in the reader's browser (night phase 01, E3): the mirror mode. A public repository the
// person administers or maintains on GitHub, named by its address or owner/name, linked to the
// registry and to its papers in one authorized action (forge-client.ts): with the App when one of
// the person's installations covers it (its pushes followed as they happen), without it otherwise
// (read every night). "Install the App first" goes through GitHub's installation page, then the
// action is authorized the ordinary way (D01-20). Pre-filled from the address (?repo=owner/name,
// ?paper=DOI, repeated; ?installation=ID after an installation, which the page mentions).
//
// The pure parts are exported for the tests; the page's wiring runs only in a browser. A signed-out
// reader asks the Worker nothing until they confirm. Text nodes only; the platform is never named
// here (the Worker's sentence says "the registry").

import type { StartInput } from "../lib/forge.ts";
import { SEGMENT } from "../../worker/forge/paths.ts";
import { describeLink, validateLink } from "../../worker/forge/service/act-link.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { showConfirm, startAction } from "./forge-client.ts";

export interface LinkForm {
  /** As typed: owner/name, or a github.com address. */
  repository: string;
  papers: string[];
  /** Go through the App's installation page first. */
  install: boolean;
}

const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,9}\/[^\s"<>@]{1,190})$/i;

/** owner/name from what a person types: "owner/name", "https://github.com/owner/name(.git)(/…)". */
export function repoFromInput(text: unknown): { owner: string; name: string } | null {
  if (typeof text !== "string") return null;
  let value = text.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)(?:[/?#].*)?$/i.exec(value);
  if (url) value = `${url[1]}/${url[2]}`;
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(value.replace(/\/+$/, ""));
  if (!m) return null;
  const name = m[2].replace(/\.git$/i, "");
  return SEGMENT.test(m[1]) && SEGMENT.test(name) ? { owner: m[1], name } : null;
}

/** The DOIs of a text: separated by spaces or commas, as "10.…", "doi:10.…" or doi.org addresses. */
export function doisOf(text: string): { dois: string[]; bad: string[] } {
  const dois: string[] = [];
  const bad: string[] = [];
  for (const word of text.split(/[\s,]+/)) {
    if (!word) continue;
    const m = DOI.exec(word);
    if (m) {
      const d = m[1].toLowerCase();
      if (!dois.includes(d)) dois.push(d);
    } else bad.push(word.slice(0, 80));
  }
  return { dois: dois.slice(0, 20), bad };
}

/** The form as the address pre-fills it: ?repo=, ?paper= (repeated), ?installation=; the rest is
 *  dropped. */
export function prefillLink(search: string): { form: LinkForm; installation: string | null; dropped: string[] } {
  const q = new URLSearchParams(search);
  const dropped = [...new Set(q.keys())].filter((k) => !["repo", "paper", "installation", "setup_action"].includes(k));
  const repo = q.get("repo");
  const parsed = repo === null ? null : repoFromInput(repo);
  if (repo !== null && !parsed) dropped.push("repo");
  const { dois, bad } = doisOf(q.getAll("paper").join(" "));
  if (bad.length) dropped.push("paper");
  const installation = /^\d{1,20}$/.test(q.get("installation") ?? "") ? (q.get("installation") as string) : null;
  if (q.get("installation") !== null && !installation) dropped.push("installation");
  return { form: { repository: parsed ? `${parsed.owner}/${parsed.name}` : "", papers: dois, install: false }, installation, dropped };
}

/** The action the form declares, checked by the Worker's own rules (act-link.ts), with the
 *  sentence the Worker will repeat. `forge`: GitHub's, on the site. */
export function declareLink(form: LinkForm, forge = "github"): { input: StartInput; sentence: string } | { problem: string } {
  const repo = repoFromInput(form.repository);
  if (!repo) return { problem: "Name the repository as owner/name, or paste its GitHub address." };
  const { dois, bad } = doisOf(form.papers.join(" "));
  if (bad.length) return { problem: `Not a DOI: ${bad.join(", ")}.` };
  const payload = { repository: `${repo.owner}/${repo.name}`, papers: dois };
  const parsed = validateLink(payload);
  if (isProblem(parsed)) return { problem: parsed.message };
  const input: StartInput = {
    kind: "link",
    repo: { forge: forge as "github", owner: repo.owner, name: repo.name },
    payload,
    back: "/new/link/",
    ...(form.install ? { install: true } : {}),
  };
  return { input, sentence: `${describeLink(parsed)}.` };
}

// ─── the page ────────────────────────────────────────────────────────────────

function main(): void {
  const f = document.getElementById("link-form") as HTMLFormElement | null;
  if (!f) return;
  const { form, installation, dropped } = prefillLink(location.search);
  const field = (name: string) => f.elements.namedItem(name) as HTMLInputElement | null;
  const repoField = field("repository");
  const papersField = field("papers");
  if (repoField) repoField.value = form.repository;
  if (papersField) papersField.value = form.papers.join(" ");
  f.hidden = false;
  const note = document.getElementById("link-installed");
  if (note && installation) note.hidden = false;
  const said = document.getElementById("link-message");
  if (said && dropped.length) {
    said.className = "warning";
    said.textContent = `Left out of the address, as not usable here: ${dropped.join(", ")}.`;
  }
  const box = document.getElementById("link-confirm");
  f.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!box) return;
    const declared = declareLink({
      repository: repoField?.value ?? "",
      papers: (papersField?.value ?? "").split(/[\s,]+/).filter(Boolean),
      install: !!field("install")?.checked,
    });
    if ("problem" in declared) {
      const p = document.createElement("p");
      p.className = "warning";
      p.textContent = declared.problem;
      box.replaceChildren(p);
      return;
    }
    showConfirm(box, declared.sentence, () => startAction(declared.input, declared.sentence));
    box.scrollIntoView({ block: "nearest" });
  });
}

if (typeof document !== "undefined" && typeof location !== "undefined") main();
