// The badge generator (src/pages/badge/index.astro; docs/BADGE.md), in the reader's browser. It
// reads only static files of this site (the DOI lookup, /data/papers/, /data/repos/: no Worker
// request but the preview's image) and, for each repository of the paper, the forge's own public API
// to find its README and whether the badge is in it (GitHub, GitLab.com, Hugging Face; on the
// reader's own quota). It runs when the form is submitted, never as one types. Like every browser
// script, it never names the platform itself: the name comes from the page (data-name, SITE_NAME).
import {
  BADGE_SHOWS, BADGE_STYLES, BADGE_TARGETS, SNIPPET_FORMATS, badgeDoi, badgeRepoKey, badgeUrls, cleanText, hasBadge, snippet,
  type BadgeOptions, type BadgeSubject, type BadgeTarget,
} from "../lib/badge";
import { REPO_SHARDS } from "../lib/apispec";
import { lookupShard, shardOf, SHARDS } from "../lib/shards";

type Part = string | { href: string; text: string };
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const form = byId<HTMLFormElement>("badge-form");
const origin = form?.dataset.origin || location.origin;
const name = form?.dataset.name || "";
const status = byId("badge-status");

function write(out: HTMLElement | null, tone: "" | "ok" | "warning", ...parts: Part[]) {
  if (!out) return;
  out.className = tone;
  out.replaceChildren(
    ...parts.map((p) => {
      if (typeof p === "string") return document.createTextNode(p);
      const a = document.createElement("a");
      a.href = p.href;
      a.textContent = p.text;
      return a;
    }),
  );
}

async function json<T>(path: string): Promise<T | undefined> {
  try {
    const res = await fetch(path, { headers: { Accept: "application/json" } });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

type Code = { repo: string; url: string; host: string };
type Paper = { doi: string; slug: string; title: string; status: string; code: Code[]; map_doi?: string; links?: { record?: string } };
type Repo = { repo: string; url: string; papers: { doi: string; title: string; record: string }[] };

async function paperOf(doi: string): Promise<{ entry?: [string, string, string?]; paper?: Paper }> {
  const lookup = await json<Record<string, [string, string, string?]>>(`/lookup/${await lookupShard(doi)}.json`);
  const entry = lookup && Object.hasOwn(lookup, doi) ? lookup[doi] : undefined;
  if (!entry?.[2]) return { entry };
  const shard = await json<Record<string, Paper>>(`/data/papers/${await shardOf(entry[2], SHARDS.paper)}.json`);
  return { entry, paper: shard?.[entry[2]] };
}

async function repoOf(key: string): Promise<Repo | undefined> {
  const shard = await json<Record<string, Repo>>(`/data/repos/${await shardOf(key, REPO_SHARDS)}.json`);
  return shard && Object.hasOwn(shard, key) ? shard[key] : undefined;
}

function options(): { o: Partial<BadgeOptions>; to: BadgeTarget } {
  const pick = <T extends string>(id: string, allowed: readonly T[], fallback: T): T => {
    const v = byId<HTMLSelectElement>(id)?.value as T;
    return allowed.includes(v) ? v : fallback;
  };
  return {
    o: {
      style: pick("badge-style", BADGE_STYLES, "flat"),
      show: pick("badge-show", BADGE_SHOWS, "status"),
      theme: pick("badge-theme", ["blue", "light"] as const, "blue"),
      text: cleanText(byId<HTMLInputElement>("badge-text")?.value ?? ""),
    },
    to: pick("badge-to", BADGE_TARGETS, "paper"),
  };
}

/** A block of text with a Copy button (the same behaviour as a paper's page, src/scripts/cite.ts). */
function copyable(text: string, what: string): HTMLElement {
  const wrap = document.createElement("div");
  const pre = document.createElement("pre");
  pre.className = "commands";
  pre.textContent = text;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = "Copy";
  button.setAttribute("aria-label", `Copy ${what}`);
  button.addEventListener("click", async () => {
    const say = byId("badge-copy-status");
    try {
      await navigator.clipboard.writeText(text);
      if (say) say.textContent = `Copied ${what}.`;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      if (say) say.textContent = `This browser does not let the page copy: ${what} is selected, copy it with the keyboard.`;
    }
  });
  wrap.append(pre, button);
  return wrap;
}

function showResult(subject: BadgeSubject, facts: Part[]) {
  const { o, to } = options();
  const urls = badgeUrls(origin, subject, o, to);
  const alt = name;
  const img = byId<HTMLImageElement>("badge-img");
  if (img) {
    // The preview from this very host (the page's policy allows its own images only; the snippets
    // keep the canonical address).
    img.src = urls.image.replace(origin, location.origin);
    img.alt = `${name} badge`;
  }
  const link = byId<HTMLAnchorElement>("badge-link");
  if (link) link.href = urls.link.replace(origin, location.origin);
  write(byId("badge-facts"), "", ...facts);

  const box = byId("badge-snippets");
  box?.replaceChildren(
    ...SNIPPET_FORMATS.map((f) => {
      const d = document.createElement("details");
      d.open = f.id === "markdown";
      const s = document.createElement("summary");
      s.textContent = f.label;
      const where = document.createElement("p");
      where.className = "summary";
      where.textContent = `For ${f.where}.`;
      d.append(s, where, copyable(snippet(f.id, urls.image, urls.link, alt), `the badge in ${f.label}`));
      return d;
    }),
  );

  const dl = byId("badge-addresses");
  const rows: [string, string, string][] = [
    ["The image (SVG)", urls.image, "the image's address"],
    ["The link", urls.link, "the link's address"],
    ["shields.io's endpoint (JSON)", urls.json, "the endpoint's address"],
    ["The same badge drawn by shields.io, in its styles", urls.shields, "the shields.io address"],
  ];
  dl?.replaceChildren(
    ...rows.flatMap(([label, value, what]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.append(copyable(value, what));
      return [dt, dd];
    }),
  );
  byId("badge-result")?.removeAttribute("hidden");
}

// ── the README of each repository ──

type Readme = { found: boolean; has?: boolean; edit: string; view: string };

/** The forge's own address to edit (or add) the README, and whether it holds the badge. */
async function readmeOf(key: string, text: string): Promise<Readme | undefined> {
  const [host, ...path] = key.split("/");
  const host_ = new URL(origin).host;
  try {
    if (host === "github.com" && path.length === 2) {
      const res = await fetch(`https://api.github.com/repos/${path[0]}/${path[1]}/readme`, { headers: { Accept: "application/vnd.github+json" } });
      if (res.status === 404) {
        // No README: GitHub's "new file" page takes the file's text in ?value=, so it opens filled.
        const repo = await fetch(`https://api.github.com/repos/${path[0]}/${path[1]}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as { default_branch?: string };
        const first = `# ${path[1]}\n\n${text}\n`;
        return {
          found: false,
          edit: `https://github.com/${path.join("/")}/new/${encodeURIComponent(repo.default_branch ?? "main")}?filename=README.md&value=${encodeURIComponent(first)}`,
          view: `https://github.com/${path.join("/")}`,
        };
      }
      if (!res.ok) return undefined;
      const r = (await res.json()) as { content?: string; html_url?: string };
      const text = new TextDecoder().decode(Uint8Array.from(atob((r.content ?? "").replace(/\s/g, "")), (c) => c.charCodeAt(0)));
      const view = r.html_url ?? `https://github.com/${path.join("/")}`;
      return { found: true, has: hasBadge(text, host_), edit: view.replace("/blob/", "/edit/"), view };
    }
    if (host === "gitlab.com") {
      const id = encodeURIComponent(path.join("/"));
      const res = await fetch(`https://gitlab.com/api/v4/projects/${id}`);
      if (!res.ok) return undefined;
      const p = (await res.json()) as { readme_url?: string | null; default_branch?: string; web_url?: string };
      const web = p.web_url ?? `https://gitlab.com/${path.join("/")}`;
      if (!p.readme_url) return { found: false, edit: `${web}/-/new/${p.default_branch ?? "main"}?file_name=README.md`, view: web };
      const file = p.readme_url.split("/-/blob/")[1]?.split("/").slice(1).join("/") ?? "README.md";
      const raw = await fetch(`https://gitlab.com/api/v4/projects/${id}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(p.default_branch ?? "HEAD")}`);
      return { found: true, has: raw.ok ? hasBadge(await raw.text(), host_) : undefined, edit: p.readme_url.replace("/-/blob/", "/-/edit/"), view: p.readme_url };
    }
    if (host === "huggingface.co") {
      const repo = path.join("/");
      const raw = await fetch(`https://huggingface.co/${repo}/raw/main/README.md`);
      const view = `https://huggingface.co/${repo}`;
      if (raw.status === 404) return { found: false, edit: `${view}/new/main?filename=README.md`, view };
      return { found: raw.ok, has: raw.ok ? hasBadge(await raw.text(), host_) : undefined, edit: `${view}/edit/main/README.md`, view };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function showRepos(code: Code[]) {
  const list = byId("badge-repos");
  const block = byId("badge-repos-block");
  if (!list || !block) return;
  list.replaceChildren();
  block.toggleAttribute("hidden", code.length === 0);
  for (const c of code) {
    const li = document.createElement("li");
    const head = document.createElement("strong");
    head.textContent = c.repo;
    const say = document.createElement("span");
    say.textContent = ": reading its README…";
    li.append(head, say);
    list.append(li);
    const { o } = options();
    const own = badgeUrls(origin, { kind: "repo", repo: c.repo }, o);
    const paste = snippet("markdown", own.image, own.link, name);
    void readmeOf(c.repo, paste).then((r) => {
      const where = c.url || `https://${c.repo}`;
      if (!r) {
        write(say, "", ": its README could not be read from here (", { href: where, text: "open the repository" }, ").");
      } else if (!r.found) {
        write(say, "warning", ": no README yet. ", { href: r.edit, text: "Create one with the badge" }, ".");
      } else if (r.has) {
        write(say, "ok", ": the README carries the badge (", { href: r.view, text: "see it" }, ").");
      } else {
        write(say, "warning", ": no badge in its README yet. ", { href: r.edit, text: "Edit the README in the forge" }, " and paste the snippet above.");
      }
    });
    const repoLine = document.createElement("p");
    repoLine.className = "summary";
    repoLine.textContent = "This repository's own badge (it follows the repository, even if the paper's DOI is not in its README):";
    li.append(repoLine, copyable(paste, `the badge of ${c.repo}`));
  }
}

// ── the form ──

async function make(raw: string) {
  const subject = raw.trim();
  byId("badge-choose")?.setAttribute("hidden", "");
  byId("badge-result")?.setAttribute("hidden", "");
  byId("badge-repos-block")?.setAttribute("hidden", "");
  if (!globalThis.crypto?.subtle) return write(status, "warning", "This browser can only make a badge over a secure (https) connection.");
  const doi = badgeDoi(subject);
  if (doi) {
    write(status, "", "Reading the registry…");
    const { entry, paper } = await paperOf(doi);
    if (!entry) {
      write(status, "warning", `The registry has not read ${doi} yet: its badge says "not registered" and links to `, { href: `/submit/?doi=${encodeURIComponent(doi)}`, text: "the submission form" }, ".");
      showResult({ kind: "doi", doi }, ["Submitted and published, the same badge then shows what the registry found, by itself."]);
      return;
    }
    if (!paper) {
      write(status, "", "");
      showResult({ kind: "doi", doi }, [`The registry read ${doi} and found no code: the badge says so and links to `, { href: `/lookup/?doi=${encodeURIComponent(doi)}`, text: "its lookup" }, "."]);
      return;
    }
    write(status, "", "");
    showResult({ kind: "doi", doi }, [
      { href: paper.links?.record || `/paper/${paper.slug}/`, text: paper.title || doi },
      paper.map_doi ? `: its tracing map is validated (${paper.map_doi}).` : ".",
    ]);
    await showRepos(paper.code ?? []);
    return;
  }
  const key = badgeRepoKey(/^[a-z]+:\/\//i.test(subject) || subject.startsWith("git@") ? subject : `https://${subject}`);
  if (!key) return write(status, "warning", "Give a DOI (10.1234/abcd) or a repository's address (https://github.com/owner/name).");
  write(status, "", "Reading the registry…");
  const repo = await repoOf(key);
  if (!repo || !repo.papers?.length) {
    write(status, "warning", `The registry does not know ${key} yet: its badge says "not registered" and links to `, { href: `/submit/?code=${encodeURIComponent(`https://${key}`)}`, text: "the submission form" }, ".");
    showResult({ kind: "repo", repo: key }, ["For a GitLab group badge, choose to show nothing for the projects the registry does not know: add &missing=hide to the image's address."]);
    return;
  }
  write(status, "", "");
  if (repo.papers.length > 1) {
    const ul = byId("badge-papers");
    ul?.replaceChildren(
      ...repo.papers.map((p) => {
        const li = document.createElement("li");
        write(li, "", { href: p.record, text: p.title || p.doi }, ` (doi:${p.doi}). `, { href: `/badge/?q=${encodeURIComponent(p.doi)}`, text: "Its badge" });
        return li;
      }),
    );
    byId("badge-choose")?.removeAttribute("hidden");
  }
  showResult({ kind: "repo", repo: key }, [
    repo.papers.length === 1 ? "The code of " : `The code of ${repo.papers.length} papers; the badge links to the list above. The first: `,
    { href: repo.papers[0].record, text: repo.papers[0].title || repo.papers[0].doi },
    ".",
  ]);
}

form?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = byId<HTMLInputElement>("badge-subject")?.value ?? "";
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("q", q.trim());
  history.replaceState(null, "", url);
  void make(q);
});
for (const id of ["badge-style", "badge-show", "badge-theme", "badge-to"]) {
  byId(id)?.addEventListener("change", () => {
    const q = byId<HTMLInputElement>("badge-subject")?.value ?? "";
    if (q.trim() && !byId("badge-result")?.hidden) void make(q);
  });
}

// Arriving with ?q=, ?doi= or ?repo= (a repository's badge links here when it is the code of
// several papers; the account page links here for each paper): made at once.
const asked = new URLSearchParams(location.search);
const first = asked.get("q") || asked.get("doi") || asked.get("repo") || "";
if (first) {
  const input = byId<HTMLInputElement>("badge-subject");
  if (input) input.value = first;
  void make(first);
}

export {};
