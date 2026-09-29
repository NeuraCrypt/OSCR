// The repository's Settings page, inside the /r/ shell (/r/<owner>/<name>/settings/; night phase 01,
// E8): the settings in a dl.settings, each change one authorized action (E4, E5) confirmed in one
// sentence, the Worker's own (forge-client.ts: then GitHub, then the callback page); and a
// section.danger for archive, transfer and deletion (D00-10: archived and hidden for 30 days with a
// restore, the deletion on GitHub only as the person's own new authorization). A reader who may not
// act here sees the settings read only, and GitHub's own page. The pure logic:
// src/lib/repo-settings-view.ts.
//
// Everything is written as text nodes, never as HTML; like every browser script, it never names the
// platform (the shell hands its name in: data-site).

import type { ShellRepo } from "../lib/forge.ts";
import {
  access,
  declare,
  deleteConsequences,
  GRACE_DAYS,
  papersFromSearch,
  SUGGESTED_AUTOLINKS,
  transferText,
  typedNameMatches,
} from "../lib/repo-settings-view.ts";
import type { ActionKind } from "../../worker/forge/service/types.ts";
import { showConfirm, startAction } from "./forge-client.ts";

type Kid = Node | string | null | false | undefined;

/** An element with text children (never HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

const link = (href: string, text: string) => el("a", { href }, text);

function input(name: string, value = "", attrs: Record<string, string> = {}): HTMLInputElement {
  const i = el("input", { type: "text", name, autocomplete: "off", spellcheck: "false", ...attrs });
  i.value = value;
  return i;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const id = `s-${control.getAttribute("name") ?? Math.random().toString(36).slice(2)}`;
  control.id = id;
  return el("p", {}, el("label", { for: id }, text), el("br"), control);
}

/** The page's site name, as the shell holds it. */
const siteOf = () => document.getElementById("repo-shell")?.dataset.site || "the registry";

export function mountSettings(root: HTMLElement, repo: ShellRepo): void {
  const site = siteOf();
  const can = access(repo, site);
  const back = `/r/${repo.owner}/${repo.name}/settings/`;
  const githubSettings = `${repo.web}/settings`;

  /** A form whose submission declares one action, shown for confirmation in its own box. */
  function actionForm(kind: ActionKind, button: string, controls: HTMLElement[], payload: (f: HTMLFormElement) => Record<string, unknown> | string): HTMLFormElement {
    const box = el("div", { "aria-live": "polite" });
    const f = el("form", {}, ...controls, el("p", {}, el("button", { type: "submit" }, button)), box);
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const p = payload(f);
      if (typeof p === "string") {
        box.replaceChildren(el("p", { class: "warning" }, p));
        return;
      }
      const d = declare(repo, kind, p, back);
      if ("problem" in d) {
        box.replaceChildren(el("p", { class: "warning" }, d.problem));
        return;
      }
      showConfirm(box, d.sentence, () => startAction(d.input, d.sentence));
    });
    return f;
  }
  const val = (f: HTMLFormElement, name: string) => ((f.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "").trim();
  const on = (kind: ActionKind, button: string, controls: HTMLElement[], payload: (f: HTMLFormElement) => Record<string, unknown> | string) =>
    can.act ? actionForm(kind, button, controls, payload) : null;

  const out: HTMLElement[] = [el("h2", { text: "Settings" })];
  if (!can.act) out.push(el("p", {}, can.why, " ", link(githubSettings, "The repository's settings on GitHub"), "."));

  const dl = el("dl", { class: "settings" });
  const row = (term: string, ...kids: Kid[]) => dl.append(el("dt", { text: term }), el("dd", {}, ...kids));

  row(
    "Name",
    `${repo.owner}/${repo.name}. `,
    "After a rename, GitHub sends the old address to the new one, for the web and for git, until another repository takes the old name (it may then be retired).",
    on("rename", "Rename", [labelled("New name", input("name", repo.name, { maxlength: "100" }))], (f) => ({ name: val(f, "name") })),
  );
  row(
    "Description and website",
    repo.description ? `${repo.description}. ` : "No description. ",
    repo.homepage ? link(repo.homepage, repo.homepage) : "No website.",
    on("edit", "Save", [labelled("Description", input("description", repo.description, { maxlength: "350" })), labelled("Website (https)", input("homepage", repo.homepage, { maxlength: "255" }))], (f) => ({
      description: val(f, "description"),
      homepage: val(f, "homepage"),
    })),
  );
  row(
    "Topics",
    repo.topics.length ? `${repo.topics.join(", ")}.` : "None.",
    on("topics", "Save", [labelled("Topics, separated by spaces (lower case, at most 20)", input("topics", repo.topics.join(" ")))], (f) => ({
      topics: val(f, "topics").split(/[\s,]+/).filter(Boolean),
    })),
  );
  const feature = (name: string, text: string) => {
    const s = el("select", { name }, el("option", { value: "" }, "leave as it is"), el("option", { value: "on" }, "on"), el("option", { value: "off" }, "off"));
    return labelled(text, s);
  };
  row(
    "Features",
    "Issues, the wiki, auto-merge, and deleting a branch once its pull request is merged.",
    on(
      "features",
      "Save",
      [feature("issues", "Issues"), feature("wiki", "Wiki"), feature("autoMerge", "Auto-merge"), feature("deleteBranchOnMerge", "Delete a branch once merged")],
      (f) => {
        const p: Record<string, boolean> = {};
        for (const k of ["issues", "wiki", "autoMerge", "deleteBranchOnMerge"]) {
          const v = val(f, k);
          if (v) p[k] = v === "on";
        }
        return Object.keys(p).length ? p : "Choose at least one feature to turn on or off.";
      },
    ),
  );
  row(
    "Template repository",
    repo.isTemplate ? "Yes: others can start their own repositories from it." : "No.",
    on("template", repo.isTemplate ? "Stop offering it as a template" : "Mark it as a template", [], () => ({ template: !repo.isTemplate })),
  );
  row(
    "Default branch",
    repo.defaultBranch ? `${repo.defaultBranch}. ` : "None yet: the repository is empty. ",
    repo.defaultBranch ? link(`/r/${repo.owner}/${repo.name}/branches/`, "All its branches") : null,
    repo.defaultBranch ? on("default_branch", "Change", [labelled("An existing branch", input("branch", "", { maxlength: "255" }))], (f) => ({ branch: val(f, "branch") })) : null,
  );
  row(
    "Visibility",
    `Public. ${site} follows public repositories only: to make it private, do it in `,
    link(githubSettings, "its settings on GitHub"),
    `; it then leaves ${site}, and its name is kept nowhere.`,
  );
  row(
    "Git LFS objects in archives",
    "Whether GitHub's ZIP and tarball downloads include the files stored with Git LFS (they count against the LFS bandwidth quota): a setting of ",
    link(githubSettings, "the repository on GitHub"),
    ". ",
    link("/hosting/large-files/", "Large files"),
    ".",
  );

  // Autolinks: GitHub lists them to the repository's admins only (not to an anonymous reader).
  const suggestions = el("ul");
  for (const s of SUGGESTED_AUTOLINKS) {
    suggestions.append(
      el(
        "li",
        {},
        `${s.keyPrefix}: ${s.explain} `,
        can.act ? actionForm("autolink_create", `Add ${s.keyPrefix}`, [], () => ({ keyPrefix: s.keyPrefix, urlTemplate: s.urlTemplate, isAlphanumeric: s.isAlphanumeric })) : null,
      ),
    );
  }
  row(
    "Autolinks",
    "An identifier cited in an issue, a pull request or a commit message becomes a link to its resolver. Suggested for research code:",
    suggestions,
    on(
      "autolink_create",
      "Add an autolink",
      [
        labelled("Prefix (letters, digits and . - _ + = : / #)", input("keyPrefix", "", { maxlength: "32" })),
        labelled("Address, with <num> where the identifier goes", input("urlTemplate", "", { maxlength: "2048" })),
        el("p", {}, el("label", {}, el("input", { type: "checkbox", name: "digits" }), " Identifiers of digits only")),
      ],
      (f) => ({ keyPrefix: val(f, "keyPrefix"), urlTemplate: val(f, "urlTemplate"), isAlphanumeric: !(f.elements.namedItem("digits") as HTMLInputElement | null)?.checked }),
    ),
    on("autolink_delete", "Delete an autolink", [labelled("Its number, as GitHub's settings page shows it", input("id", "", { maxlength: "20" }))], (f) => ({ id: val(f, "id") })),
    link(`${githubSettings}/key_links`, "The repository's autolinks on GitHub"),
    ".",
  );

  const papers = repo.layer?.papers ?? [];
  row(
    "Papers",
    papers.length ? `${papers.map((p) => `${p.doi} (${p.status === "linked" ? "linked" : "proposed to its authors"})`).join(", ")}.` : "No paper yet.",
    on("papers", "Save", [labelled("Add, as DOIs separated by spaces", input("add", papersFromSearch(location.search).join(" "))), labelled("Remove, as DOIs separated by spaces", input("remove"))], (f) => ({
      repository: `${repo.owner}/${repo.name}`,
      add: val(f, "add").split(/[\s,]+/).filter(Boolean),
      remove: val(f, "remove").split(/[\s,]+/).filter(Boolean),
    })),
  );
  row(
    "Archive at Software Heritage",
    "Software Heritage keeps public code for the long term; a request saves the repository as it is now.",
    on("software_heritage", "Ask Software Heritage to save it now", [], () => ({})),
  );
  out.push(dl);

  // The danger zone: archive, transfer, deletion.
  if (can.act) {
    const danger = el("section", { class: "danger" }, el("h2", { text: "Archive, transfer, delete" }));
    const state = repo.layer?.state;
    if (state === "pending_deletion") {
      const due = repo.layer?.deleteAfter ? new Date(repo.layer.deleteAfter * 1000).toISOString().slice(0, 10) : "";
      danger.append(
        el("h3", { text: "Its deletion was asked" }),
        el("p", {}, `It is archived on GitHub and hidden here${due ? ` until ${due} (UTC)` : ""}. Restore it, or delete it on GitHub now.`),
        actionForm("restore", "Restore it", [], () => ({})),
      );
      const typed = input("confirmName", "", { maxlength: "201" });
      danger.append(
        actionForm("delete_final", "Delete it on GitHub, for good", [labelled(`Type ${repo.owner}/${repo.name} to confirm`, typed)], (f) =>
          typedNameMatches(val(f, "confirmName"), repo) ? { confirmName: val(f, "confirmName") } : `Type ${repo.owner}/${repo.name} exactly, to confirm.`,
        ),
      );
    } else {
      danger.append(
        el("h3", { text: repo.archived ? "Unarchive" : "Archive" }),
        el("p", {}, repo.archived ? "It becomes writable again." : "Read only for everyone: no push, issue or pull request until it is unarchived. It stays public and citable."),
        actionForm(repo.archived ? "unarchive" : "archive", repo.archived ? "Unarchive it" : "Archive it", [], () => ({})),
        el("h3", { text: "Transfer" }),
        el("ul", {}, ...transferText("").map((t) => el("li", { text: t }))),
        actionForm(
          "transfer",
          "Transfer it",
          [labelled("The account that receives it", input("newOwner", "", { maxlength: "39" })), labelled("Its new name (optional)", input("newName", "", { maxlength: "100" }))],
          (f) => (val(f, "newName") ? { newOwner: val(f, "newOwner"), newName: val(f, "newName") } : { newOwner: val(f, "newOwner") }),
        ),
        el("h3", { text: "Delete" }),
        el("ul", {}, ...deleteConsequences(repo, site).map((t) => el("li", { text: t }))),
        actionForm(
          "delete_request",
          `Archive and hide it for ${GRACE_DAYS} days`,
          [labelled(`Type ${repo.owner}/${repo.name} to confirm`, input("confirmName", "", { maxlength: "201" }))],
          (f) =>
            typedNameMatches(val(f, "confirmName"), repo)
              ? { confirmName: val(f, "confirmName"), maps: repo.layer?.maps ?? 0 }
              : `Type ${repo.owner}/${repo.name} exactly, to confirm.`,
        ),
      );
    }
    out.push(danger);
  }
  root.replaceChildren(...out);
}
