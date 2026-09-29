// The import pages, in the reader's browser (D00-8: no import runs in the Worker or on the Mac):
// - /new/import/: the commands of an import (a git address, a Zenodo, figshare or OSF record, or
//   another version control system), with the steps around them (create the EMPTY repository first,
//   link it after); ?paper=<doi> reads the catalogue's static lookup shard and prefills the paper's
//   code links and the paper to link;
// - /hosting/import/: the bulk import, a POSIX sh script generated here and run by the researcher;
// - /hosting/leave/: the backup commands for one repository, and its layer exported as JSON from the
//   static shard, saved by the browser.
// Every command comes from src/lib/import-commands.ts (validated, single-quoted). The pages ask the
// Worker nothing: the only requests are the static files /lookup/NN.json and /forge/layer/NN.json.
// Everything is written as text nodes, never as HTML. Like every browser script, it never names the
// platform.
import { isOwner, isRepoName, layerShard, layerUrl, repoPath, type RepoCoords } from "../lib/forge.ts";
import {
  backupCommands,
  bulkScript,
  CONVERT_KINDS,
  convertCommands,
  importSteps,
  IMPORTER_URL,
  layerExport,
  layerFileName,
  linkRepoUrl,
  lookupShardOf,
  lookupUrl,
  migrationArchiveCommands,
  mirrorPlan,
  normalizeDoi,
  parseBulkList,
  parseGitUrl,
  parseRecord,
  parseRepoInput,
  prefillFromPaper,
  recordCommands,
  type ConvertKind,
  type LookupShard,
  type PaperPrefill,
} from "../lib/import-commands.ts";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const value = (id: string) => (byId<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id)?.value ?? "").trim();
const checked = (id: string) => !!byId<HTMLInputElement>(id)?.checked;
type Part = string | { href: string; text: string; download?: string };

function write(el: HTMLElement | null, tone: "" | "ok" | "warning", ...parts: Part[]) {
  if (!el) return;
  if (tone) el.className = tone;
  else el.removeAttribute("class");
  el.replaceChildren(
    ...parts.map((p) => {
      if (typeof p === "string") return document.createTextNode(p);
      // Only this site's pages, https addresses and the browser's own files become links.
      if (!/^(\/(?!\/)|https:\/\/|blob:)/i.test(p.href)) return document.createTextNode(p.text);
      const a = document.createElement("a");
      a.href = p.href;
      a.textContent = p.text;
      if (p.download) a.download = p.download;
      return a;
    }),
  );
}

const show = (el: HTMLElement | null, on: boolean) => el?.toggleAttribute("hidden", !on);
const setText = (el: HTMLElement | null, text: string) => {
  if (el) el.textContent = text;
};
const setLink = (id: string, href: string) => {
  const a = byId<HTMLAnchorElement>(id);
  if (a) a.href = href;
};

// ─── copy buttons: after every command block ─────────────────────────────────

for (const block of document.querySelectorAll<HTMLElement>("pre[data-copy]")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = "Copy";
  const what = block.dataset.copy || "the commands";
  button.setAttribute("aria-label", `Copy ${what}`);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(block.textContent ?? "");
      button.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      button.textContent = "Selected: copy it with the keyboard";
    }
    setTimeout(() => (button.textContent = "Copy"), 4000);
  });
  block.after(button);
}

/** A file the browser saves (the bulk script, the layer's JSON): made here, never uploaded. */
let lastBlob = "";
function fileUrl(text: string, type: string): string {
  if (lastBlob) URL.revokeObjectURL(lastBlob);
  lastBlob = URL.createObjectURL(new Blob([text], { type }));
  return lastBlob;
}

function papersIn(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/[\s,]+/)) {
    const doi = normalizeDoi(word);
    if (doi && !out.includes(doi)) out.push(doi);
  }
  return out.slice(0, 20);
}

// ─── /new/import/ ────────────────────────────────────────────────────────────

const importForm = byId<HTMLFormElement>("import-form");

type Kind = "git" | "record" | "convert";
const KINDS: Kind[] = ["git", "record", "convert"];

function currentKind(): Kind {
  const input = importForm?.querySelector<HTMLInputElement>('input[name="kind"]:checked');
  return KINDS.includes(input?.value as Kind) ? (input!.value as Kind) : "git";
}

function showKind() {
  const kind = currentKind();
  for (const k of KINDS) show(byId(`import-${k}`), k === kind);
}

function chooseKind(kind: Kind) {
  const input = importForm?.querySelector<HTMLInputElement>(`input[name="kind"][value="${kind}"]`);
  if (input) input.checked = true;
  showKind();
}

function setField(id: string, text: string) {
  const el = byId<HTMLInputElement>(id);
  if (el) el.value = text;
}

function showImport() {
  const message = byId("import-message");
  const result = byId("import-result");
  show(result, false);
  const owner = value("import-owner");
  if (!isOwner(owner)) {
    write(message, "warning", "Give your GitHub account's name (the account the new repository goes into).");
    return;
  }
  const papers = papersIn(value("import-papers"));
  const kind = currentKind();
  let name = value("import-name");
  let commands: string[];
  let description: string;
  let ongoing: string[] | null = null;
  let linkInstead: string | null = null;
  let note = "";
  try {
    if (kind === "git") {
      const source = parseGitUrl(value("import-source"));
      if (!source) {
        write(message, "warning", "This is not an https or ssh git address. Copy it from the Clone or Code button of the repository's page, with no user name or password in it.");
        return;
      }
      if (!name) setField("import-name", (name = source.name));
      if (!isRepoName(name)) {
        write(message, "warning", "This name is not one GitHub accepts: letters, digits, '.', '-' and '_', at most 100 characters.");
        return;
      }
      const plan = mirrorPlan({ source, owner, name, lfs: checked("import-lfs"), ongoing: checked("import-ongoing"), papers });
      commands = plan.commands;
      ongoing = plan.ongoing;
      linkInstead = plan.linkInstead;
      description = `Imported from ${source.label}`;
      note = "Every commit keeps its id: the tracing maps pinned to the source's commits stay valid on the copy.";
    } else if (kind === "record") {
      const record = parseRecord(value("import-record-doi"));
      if (!record) {
        write(message, "warning", "Give the record's DOI (10.5281/zenodo.…, 10.6084/m9.figshare.…, 10.17605/osf.io/…) or its page's address.");
        return;
      }
      if (!name) setField("import-name", (name = record.id ? `${record.kind}-${record.id}` : "code"));
      if (!isRepoName(name)) {
        write(message, "warning", "This name is not one GitHub accepts: letters, digits, '.', '-' and '_', at most 100 characters.");
        return;
      }
      commands = recordCommands(record, { owner, name });
      description = `Imported from doi:${record.doi}`;
      note = "An archive has no history: the repository starts with one commit, whose message cites the record's DOI.";
    } else {
      const convertKind = value("import-convert-kind") as ConvertKind;
      if (!CONVERT_KINDS.includes(convertKind)) {
        write(message, "warning", "Choose the version control system the code is in.");
        return;
      }
      if (!name || !isRepoName(name)) {
        write(message, "warning", "Give the new repository's name: letters, digits, '.', '-' and '_', at most 100 characters.");
        return;
      }
      try {
        commands = convertCommands({
          kind: convertKind,
          source: value("import-convert-source"),
          dest: { owner, name },
          tfvcPath: value("import-tfvc-path"),
          p4port: value("import-p4port"),
          authors: checked("import-authors"),
          lfs: checked("import-convert-lfs"),
        });
      } catch {
        write(message, "warning", "The source's address (or, for TFVC and Perforce, its path or server) is not one the converter accepts: see the examples under each field.");
        return;
      }
      description = "Converted to Git";
      note = "A converted history gets new commit ids: tracing maps are made again on the new commits.";
    }
    const steps = importSteps(owner, name, papers, description);
    setLink("import-create", steps.createUrl);
    setText(byId("import-commands"), commands.join("\n"));
    show(byId("import-ongoing-step"), !!ongoing);
    setText(byId("import-ongoing-commands"), (ongoing ?? []).join("\n"));
    setLink("import-link", steps.linkUrl);
    setText(byId("import-note"), note);
    show(byId("import-importer"), kind === "git");
    const instead = byId("import-link-instead");
    show(instead, !!linkInstead);
    if (linkInstead) {
      write(instead, "", "This repository is already on GitHub: you can also ", { href: linkInstead, text: "link it as it is" },
        " (the mirror mode), with no copy at all.");
    }
    write(message, "ok", `The steps for ${owner}/${name} are below. Nothing has been sent anywhere: the commands run on your computer.`);
    show(result, true);
    result?.scrollIntoView({ block: "start" });
  } catch {
    write(message, "warning", "These values cannot make a safe command. Check the account, the name and the source.");
  }
}

function fillSource(url: string) {
  chooseKind("git");
  setField("import-source", url);
  setField("import-name", parseGitUrl(url)?.name ?? "");
  byId("import-form")?.scrollIntoView({ block: "start" });
  byId<HTMLInputElement>("import-owner")?.focus();
}

function fillRecord(doi: string) {
  chooseKind("record");
  setField("import-record-doi", doi);
  byId("import-form")?.scrollIntoView({ block: "start" });
  byId<HTMLInputElement>("import-owner")?.focus();
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function listItem(...children: (Node | string)[]): HTMLLIElement {
  const li = document.createElement("li");
  li.append(...children);
  return li;
}

function anchor(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  return a;
}

function showPrefill(p: PaperPrefill) {
  const status = byId("from-paper-status");
  const list = byId("from-paper-links");
  const paperLink: Part = p.slug ? { href: `/paper/${p.slug}/`, text: `doi:${p.doi}` } : `doi:${p.doi}`;
  if (!p.found) {
    write(status, "warning", "The paper ", paperLink, " is not in the catalogue: give the code's address below. It will still be linked to the new repository.");
  } else if (!p.sources.length && !p.records.length) {
    write(status, "", "The catalogue has no code link for ", paperLink, " that can be imported: give the code's address below. It will still be linked to the new repository.");
  } else {
    write(status, "ok", "The paper ", paperLink, "'s code links, from the catalogue. The paper will be linked to the new repository, and its tracing maps carry over because every commit keeps its id.");
  }
  const items: HTMLLIElement[] = [];
  for (const s of p.sources) {
    if (s.github) {
      items.push(listItem(`${s.label}: already on GitHub. `, anchor(linkRepoUrl(s.github, p.papers), "Link it to the paper"),
        " (yours, as it is), or ", linkButton("Import a copy", () => fillSource(s.url))));
    } else {
      items.push(listItem(`${s.label} `, linkButton("Import it", () => fillSource(s.url))));
    }
  }
  for (const r of p.records) items.push(listItem(`${r.label}, doi:${r.doi} `, linkButton("Import it as one commit", () => fillRecord(r.doi))));
  for (const url of p.other) items.push(listItem(anchor(url, url), ": not a git repository nor a record; download its files and import them as a record's."));
  list?.replaceChildren(...items);
  show(list, items.length > 0);
  setField("import-papers", p.papers.join(" "));
  const first = p.sources.find((s) => !s.github) ?? p.sources[0];
  if (first) {
    chooseKind("git");
    setField("import-source", first.url);
    setField("import-name", first.name);
  } else if (p.records[0]) {
    chooseKind("record");
    setField("import-record-doi", p.records[0].doi);
  }
}

async function loadPaper() {
  const doiText = new URLSearchParams(location.search).get("paper");
  if (doiText == null) return;
  const section = byId("from-paper");
  show(section, true);
  const status = byId("from-paper-status");
  const doi = normalizeDoi(doiText);
  if (!doi) {
    write(status, "warning", "The address names a paper, but not with a DOI: give the code's address below.");
    return;
  }
  write(status, "", "Reading the catalogue…");
  let shard: LookupShard = {};
  try {
    if (!globalThis.crypto?.subtle) throw new Error("no crypto");
    const res = await fetch(lookupUrl(await lookupShardOf(doi)), { headers: { Accept: "application/json" } });
    if (res.ok) shard = (await res.json()) as LookupShard;
    else if (res.status !== 404) throw new Error(String(res.status));
  } catch {
    write(status, "warning", "The catalogue could not be read. Give the code's address below; the paper will still be linked.");
    setField("import-papers", doi);
    return;
  }
  const prefill = prefillFromPaper(doi, shard);
  if (prefill) showPrefill(prefill);
}

if (importForm) {
  importForm.addEventListener("change", (ev) => {
    if ((ev.target as HTMLInputElement | null)?.name === "kind") showKind();
  });
  importForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    showImport();
  });
  setLink("import-importer-link", IMPORTER_URL);
  show(importForm, true);
  showKind();
  void loadPaper();
}

// ─── /hosting/import/: the bulk import ───────────────────────────────────────

const bulkForm = byId<HTMLFormElement>("bulk-form");
if (bulkForm) {
  show(bulkForm, true);
  bulkForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const message = byId("bulk-message");
    const result = byId("bulk-result");
    show(result, false);
    const { items, errors } = parseBulkList(value("bulk-list"), value("bulk-owner"));
    const list = byId("bulk-errors");
    list?.replaceChildren(...errors.map((e) => listItem(e)));
    show(list, errors.length > 0);
    if (errors.length || !items.length) {
      write(message, "warning", items.length || errors.length ? "Correct these lines, then try again." : "Give at least one repository, one a line.");
      return;
    }
    const script = bulkScript(items);
    setText(byId("bulk-script"), script);
    write(byId("bulk-download"), "", { href: fileUrl(script, "text/x-shellscript"), text: "Save it as import.sh", download: "import.sh" });
    write(message, "ok", `A script for ${items.length} ${items.length === 1 ? "repository" : "repositories"}. It was made in your browser; nothing was sent.`);
    show(result, true);
  });
}

// ─── /hosting/leave/: backups and the layer's export ─────────────────────────

const leaveForm = byId<HTMLFormElement>("leave-form");
let leaveRepo: RepoCoords | null = null;

if (leaveForm) {
  show(leaveForm, true);
  leaveForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const message = byId("leave-message");
    const result = byId("leave-result");
    show(result, false);
    const repo = parseRepoInput(value("leave-repo"));
    if (!repo) {
      write(message, "warning", "Give the repository as account/name, or its GitHub address.");
      return;
    }
    leaveRepo = repo;
    setText(byId("leave-backup"), backupCommands(repo, { lfs: checked("leave-lfs") }).join("\n"));
    setText(byId("leave-migration"), migrationArchiveCommands(repo).join("\n"));
    write(byId("leave-settings"), "", "Unlink its papers, or ask for the layer's deletion, from ", { href: repoPath(repo, "settings"), text: `${repo.owner}/${repo.name}'s settings` }, ".");
    write(byId("leave-export-message"), "", "");
    write(message, "ok", `The commands for ${repo.owner}/${repo.name} are below.`);
    show(result, true);
  });

  byId("leave-export")?.addEventListener("click", async () => {
    const out = byId("leave-export-message");
    if (!leaveRepo) return;
    const repo = leaveRepo;
    write(out, "", "Reading the layer…");
    try {
      const res = await fetch(layerUrl(await layerShard(repo.owner, repo.name)), { headers: { Accept: "application/json" } });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      const shard = res.ok ? await res.json() : {};
      const data = await layerExport(repo, shard, new Date());
      const text = `${JSON.stringify(data, null, 2)}\n`;
      write(out, data.layer ? "ok" : "", data.layer ? "Ready: " : "The registry keeps nothing public about this repository; the file says so. ",
        { href: fileUrl(text, "application/json"), text: `save ${layerFileName(repo)}`, download: layerFileName(repo) }, ".");
    } catch {
      write(out, "warning", "The layer could not be read. Please try again in a moment.");
    }
  });
}
