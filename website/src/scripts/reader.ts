// The Code ↔ Paper reader, in the reader's browser.
//
// LEFT, the paper. Its full text is fetched from Europe PMC (open access; CORS is
// allowed) by this browser, never by the site, and shown as plain text. Its paragraphs
// are numbered the way the harvester numbers them: the index of each <p> among all
// the <p> of the JATS <body>, in document order (Python: `body.iter("p")`).
//
// RIGHT, the authors' code. One view is prerendered by the build; the others are
// fetched on demand from the lot of their repository (/scripts/NN.json).
//
// A pair joins paragraph p-<i> and the lines start..end of a file: the same color on
// both sides. Clicking one side brings the other into view and marks both
// `.is-active`; clicking an entry of the legend does both.
import { decorate, fileInfo, pairClass, splitLines, type Part } from "../lib/lines";

type RepoData = { repo: string; name: string; url: string; lot: string; license: string };
type ViewData = {
  repo: number;
  block: boolean;
  path?: string;
  language?: string;
  lines?: number | null;
  truncated?: boolean;
  text?: boolean;
  source?: string;
  pairs: number[];
};
type PairData = { pair: number; paragraph: number; view: number; start: number; end: number; source: string; label: string };
type Data = {
  fulltextId: string;
  doiUrl: string;
  epmcUrl: string;
  repos: RepoData[];
  views: ViewData[];
  pairs: PairData[];
  initial: number;
};
type LotData = Record<string, { files: { path: string; text: string | null }[] }>;
type Side = "legend" | "paper" | "code";

const data = JSON.parse(document.getElementById("reader-data")!.textContent!) as Data;
const pairs = new Map(data.pairs.map((p) => [p.pair, p]));
const compare = document.getElementById("compare")!;
const paperPane = document.getElementById("paper-pane")!;
const codePane = document.getElementById("code-pane")!;
const paper = document.getElementById("paper")!;
const status = document.getElementById("paper-status")!;
const code = document.getElementById("code")!;
const ol = document.getElementById("lines") as HTMLOListElement;
const info = document.getElementById("file-info")!;
const select = document.getElementById("file-select") as HTMLSelectElement | null;
const motion: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

let current = data.initial; // the view shown in the code pane
let active = 0; // the pair being read; 0: none
let ticket = 0; // the latest request to show a view: an older one that ends late is ignored

const link = (href: string, text: string) => Object.assign(document.createElement("a"), { href, textContent: text });
const nodes = (parts: Part[]) => parts.map((p) => (typeof p === "string" ? p : link(p.href, p.text)));
/** The link that activates pair k: in a paragraph (to its code), or on the first line
 *  of its code (to its paragraph). The same markup as the build's (code.astro). */
function pairLink(k: number, text: string, to: "code" | "paragraph") {
  const a = link(`#pair-${k}`, text);
  a.dataset.pair = String(k);
  a.title = `Match ${k}: show the ${to === "code" ? "lines of code" : "paragraph"}`;
  return a;
}

/* ---------- The paper ---------- */

// Elements whose paragraphs get a heading: sections (their title), figures, tables
// and boxes (their label and caption title).
const CONTAINERS = new Set(["sec", "app", "fig", "table-wrap", "boxed-text", "supplementary-material"]);
// Elements left out of a paragraph's text: nested blocks (their own <p> are shown
// on their own), and what is not text (images, alternative TeX, descriptions).
const SKIP = new Set([
  "p", "fig", "fig-group", "table-wrap", "table-wrap-group", "boxed-text", "supplementary-material", "list",
  "def-list", "disp-quote", "alt-text", "long-desc", "object-id", "graphic", "inline-graphic", "media",
  "annotation", "annotation-xml",
]);
const SPACED = new Set(["break", "label", "title", "caption", "disp-formula"]);

/** The text of an element, inline markup flattened; references stay as text. */
function flatten(node: Element): string {
  let s = "";
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE || c.nodeType === Node.CDATA_SECTION_NODE) s += c.nodeValue ?? "";
    if (c.nodeType !== Node.ELEMENT_NODE) continue;
    const e = c as Element;
    if (SKIP.has(e.localName) || e.getElementsByTagName("p").length > 0) continue;
    // A formula given both in MathML and in TeX: the MathML is kept.
    if (e.localName === "tex-math" && Array.from(e.parentElement?.children ?? []).some((x) => x.localName === "math")) continue;
    const t = flatten(e);
    s += SPACED.has(e.localName) ? ` ${t} ` : t;
  }
  return s;
}
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const child = (e: Element | undefined, name: string) => (e ? Array.from(e.children).find((x) => x.localName === name) : undefined);

function heading(c: Element, depth: number): HTMLElement | null {
  if (c.localName === "sec" || c.localName === "app") {
    const title = child(c, "title");
    const text = title ? clean(flatten(title)) : "";
    if (!text) return null;
    return Object.assign(document.createElement(`h${Math.min(depth + 2, 6)}`), { textContent: text });
  }
  const label = child(c, "label");
  const title = child(child(c, "caption"), "title");
  const l = label ? clean(flatten(label)) : "";
  const t = title ? clean(flatten(title)) : "";
  if (!l && !t) return null;
  const p = document.createElement("p");
  if (l) p.append(Object.assign(document.createElement("strong"), { textContent: l }), t ? " " : "");
  p.append(t);
  return p;
}

/** The license of the text, as the XML gives it. */
function license(xml: Document): Part[] {
  const lic = xml.querySelector("article-meta permissions license") ?? xml.getElementsByTagName("license")[0];
  if (!lic) return [];
  const url =
    lic.getAttribute("xlink:href") ||
    clean(Array.from(lic.children).find((x) => x.localName === "license_ref")?.textContent ?? "") ||
    lic.querySelector("ext-link")?.getAttribute("xlink:href") ||
    "";
  const cc = url.match(/creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/(\d\.\d)/i);
  const name = cc ? (cc[1] === "publicdomain" ? `CC0 ${cc[3]}` : `CC ${cc[2].toUpperCase()} ${cc[3]}`) : "";
  if (/^https?:\/\//.test(url)) return ["License of the text: ", { href: url, text: name || url }, "."];
  const type = lic.getAttribute("license-type");
  return type ? [`License of the text: ${type}.`] : [];
}

function renderPaper(xml: Document) {
  const root = xml.documentElement;
  const body = Array.from(root.children).find((e) => e.localName === "body") ?? xml.getElementsByTagName("body")[0];
  if (!body) throw new Error("the full text has no body");
  const list = Array.from(body.getElementsByTagName("p"));
  const byParagraph = new Map<number, number[]>();
  for (const p of data.pairs) {
    if (!byParagraph.has(p.paragraph)) byParagraph.set(p.paragraph, []);
    byParagraph.get(p.paragraph)!.push(p.pair);
  }
  const out = document.createDocumentFragment();
  const headed = new Set<Element>();
  list.forEach((p, i) => {
    // The headings of the sections, figures and tables this paragraph opens.
    const chain: Element[] = [];
    for (let e = p.parentElement; e && e !== body; e = e.parentElement) if (CONTAINERS.has(e.localName)) chain.unshift(e);
    let depth = 0;
    for (const c of chain) {
      if (c.localName === "sec" || c.localName === "app") depth += 1;
      if (headed.has(c)) continue;
      headed.add(c);
      const h = heading(c, depth);
      if (h) out.append(h);
    }
    const el = document.createElement("p");
    el.id = `p-${i}`;
    const ks = byParagraph.get(i);
    if (ks) {
      el.className = pairClass(ks[0]);
      el.dataset.pairs = ks.join(" ");
      for (const k of ks) el.append(pairLink(k, `[${k}]`, "code"), " ");
    }
    let text = clean(flatten(p));
    const item = p.parentElement;
    if (item?.localName === "list-item" && Array.from(item.children).find((x) => x.localName === "p") === p) {
      const label = child(item, "label");
      text = `${(label && clean(flatten(label))) || "•"} ${text}`;
    }
    el.append(text);
    out.append(el);
  });
  paper.append(out);
  const lic = license(xml);
  const beyond = data.pairs.filter((p) => p.paragraph >= list.length).length;
  status.replaceChildren(
    ...(lic.length ? nodes(lic) : ["Loaded from Europe PMC."]),
    beyond === 1 ? " One match points past the last paragraph: the text may have changed since it was computed." : "",
    beyond > 1 ? ` ${beyond} matches point past the last paragraph: the text may have changed since they were computed.` : "",
  );
}

async function loadPaper() {
  if (!data.fulltextId) return fail("Europe PMC has no full text for it");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(data.fulltextId)}/fullTextXML`;
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`Europe PMC answered HTTP ${r.status}`);
    const xml = new DOMParser().parseFromString(await r.text(), "application/xml");
    if (xml.getElementsByTagName("parsererror").length > 0) throw new Error("the full text is not valid XML");
    renderPaper(xml);
  } catch (err) {
    const e = err as Error;
    return fail(e.name === "AbortError" ? "Europe PMC did not answer in time" : e.message);
  } finally {
    clearTimeout(timer);
  }
  // A pair chosen before the paper arrived (from the address, or a click): show it now.
  const p = pairs.get(active);
  const el = p && document.getElementById(`p-${p.paragraph}`);
  if (el) {
    el.classList.add("is-active");
    scrollInto(paperPane, el);
  } else {
    const at = location.hash.match(/^#p-(\d+)$/);
    const target = at && document.getElementById(`p-${at[1]}`);
    if (target) scrollInto(paperPane, target);
  }
}

function fail(reason: string) {
  status.className = "warning";
  status.replaceChildren(
    `The text of this paper could not be loaded from Europe PMC (${reason}). Read it at `,
    link(data.doiUrl, "doi.org"),
    " or on ",
    link(data.epmcUrl, "Europe PMC"),
    ".",
  );
}

/* ---------- The code ---------- */

const lots = new Map<string, Promise<LotData>>();
function lot(n: string): Promise<LotData> {
  if (!lots.has(n)) {
    const p = fetch(`/scripts/${n}.json`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<LotData>;
    });
    p.catch(() => lots.delete(n)); // a failed load can be tried again
    lots.set(n, p);
  }
  return lots.get(n)!;
}

function renderLines(i: number, text: string) {
  const lines = splitLines(text);
  const spans = data.views[i].pairs.map((k) => pairs.get(k)!).map((p) => ({ pair: p.pair, start: p.start, end: p.end }));
  const { cover, link: links } = decorate(lines, spans);
  const out = document.createDocumentFragment();
  lines.forEach((line, n0) => {
    const li = document.createElement("li");
    const ks = cover.get(n0 + 1);
    if (ks) {
      li.className = pairClass(ks[0]);
      li.dataset.pairs = ks.join(" ");
    }
    const k = links.get(n0 + 1);
    if (k) li.append(pairLink(k, line, "paragraph"));
    else li.textContent = line;
    out.append(li);
  });
  ol.replaceChildren(out);
  ol.hidden = false;
}

/** A file whose text is not republished here: links to the source, and its pairs. */
function renderElsewhere(i: number) {
  const v = data.views[i];
  const s = document.createElement("section");
  s.id = "elsewhere";
  s.dataset.view = String(i);
  const p = document.createElement("p");
  p.className = "warning";
  p.append("This file is not republished here: ", link(v.source || data.repos[v.repo].url, "read it at the source"), ".");
  s.append(p);
  if (v.pairs.length) {
    const ul = document.createElement("ul");
    for (const k of v.pairs) {
      const pr = pairs.get(k)!;
      const li = document.createElement("li");
      li.className = pairClass(k);
      li.dataset.pairs = String(k);
      li.append(`[${k}] `, link(pr.source || v.source || "", `${v.path} L${pr.start}–${pr.end}`), ` ↔ ${pr.label}`);
      ul.append(li);
    }
    s.append(ul);
  }
  ol.before(s);
}

/** Show view i in the code pane; false if it could not be shown (or was overtaken). */
async function show(i: number): Promise<boolean> {
  const mine = ++ticket;
  const v = data.views[i];
  if (!v) return false;
  if (select) select.value = String(i);
  if (i === current) return true;
  const repo = data.repos[v.repo];
  /** Only view i remains in the pane (its lines are rendered by the caller). */
  const settle = (shown: boolean) => {
    document.getElementById("elsewhere")?.remove();
    for (const s of code.querySelectorAll<HTMLElement>("section[data-view]")) s.hidden = !shown || s.dataset.view !== String(i);
    if (!shown || v.block || !v.text) {
      ol.hidden = true;
      ol.replaceChildren();
    }
    current = shown ? i : -1;
    codePane.scrollTop = 0;
  };
  if (v.block || !v.text) {
    settle(true);
    if (!v.block) renderElsewhere(i);
    info.replaceChildren(...nodes(fileInfo(v, repo)));
    return true;
  }
  info.textContent = `Loading ${v.path}…`;
  let text: string | null = null;
  let reason = "it is not in the published files";
  try {
    text = (await lot(repo.lot))[repo.repo]?.files.find((f) => f.path === v.path)?.text ?? null;
  } catch (err) {
    reason = `the lot of its repository did not load: ${(err as Error).message}`;
  }
  if (mine !== ticket) return false;
  if (text === null) {
    settle(false);
    info.replaceChildren(`${v.path} could not be shown (${reason}): `, link(v.source || repo.url, "read it at the source"), ".");
    return false;
  }
  renderLines(i, text);
  settle(true);
  info.replaceChildren(...nodes(fileInfo(v, repo)));
  return true;
}

/* ---------- Pairs ---------- */

/** Scroll a pane to put el near its top, below the header, with two lines of context. */
function scrollInto(pane: HTMLElement, el: HTMLElement) {
  const head = pane.querySelector("header");
  const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - (head?.offsetHeight ?? 0) - 40;
  pane.scrollTo({ top: Math.max(0, top), behavior: motion });
}

/** The two panes in view: when they start low in the window, or above it. */
function bringCompare() {
  const r = compare.getBoundingClientRect();
  if (r.top < 0 || r.top > innerHeight * 0.4) window.scrollTo({ top: scrollY + r.top - 8, behavior: motion });
}

/** Mark the code side of pair k; returns the element to bring into view. */
function markCode(k: number): HTMLElement | null {
  const p = pairs.get(k);
  const v = p && data.views[p.view];
  if (!p || !v || p.view !== current) return null;
  if (v.block || !v.text) {
    const li = code.querySelector<HTMLElement>(`section[data-view="${p.view}"] li[data-pairs~="${k}"]`);
    li?.classList.add("is-active");
    return li;
  }
  let first: HTMLElement | null = null;
  const to = Math.min(ol.children.length, Math.max(p.start, p.end));
  for (let n = Math.max(1, p.start); n <= to; n++) {
    const li = ol.children[n - 1] as HTMLElement;
    li.classList.add("is-active");
    first ??= li;
  }
  return first;
}

async function activate(k: number, from: Side, keyboard: boolean) {
  const p = pairs.get(k);
  if (!p) return;
  active = k;
  history.replaceState(null, "", `#pair-${k}`);
  for (const el of document.querySelectorAll(".is-active")) el.classList.remove("is-active");
  document.querySelector(`#legend a[data-pair="${k}"]`)?.classList.add("is-active");
  const para = document.getElementById(`p-${p.paragraph}`);
  para?.classList.add("is-active");
  const shown = p.view >= 0 && (await show(p.view));
  if (active !== k) return; // another pair was chosen meanwhile
  const lines = shown ? markCode(k) : null;
  bringCompare();
  if (from !== "paper" && para) scrollInto(paperPane, para);
  if (from !== "code" && lines) scrollInto(codePane, lines);
  if (keyboard) {
    // The keyboard follows the pair to the other side.
    const there =
      from === "paper"
        ? (code.querySelector<HTMLElement>(`#lines a[data-pair="${k}"]`) ?? lines?.querySelector("a"))
        : from === "code"
          ? paper.querySelector<HTMLElement>(`a[data-pair="${k}"]`)
          : null;
    there?.focus({ preventScroll: true });
  }
}

document.addEventListener("click", (ev) => {
  const target = ev.target as Element;
  const keyboard = ev.detail === 0;
  const a = target.closest<HTMLAnchorElement>("a[data-pair]");
  if (a) {
    ev.preventDefault();
    const side: Side = a.closest("#paper") ? "paper" : a.closest("#code") ? "code" : "legend";
    activate(Number(a.dataset.pair), side, keyboard);
    return;
  }
  if (target.closest("a, select, button, summary, label")) return;
  if (getSelection()?.toString()) return; // text is being selected, not clicked
  const holder = target.closest<HTMLElement>("#paper [data-pairs], #code [data-pairs]");
  if (!holder) return;
  // Several pairs on the same paragraph or line: each click shows the next one.
  const ks = holder.dataset.pairs!.split(" ").map(Number);
  activate(ks[(ks.indexOf(active) + 1) % ks.length], holder.closest("#paper") ? "paper" : "code", false);
});

select?.addEventListener("change", async () => {
  if (await show(Number(select.value))) markCode(active);
});

/* ---------- Start ---------- */

// A file asked for by the address (the record page links "read" here), then a pair.
const params = new URLSearchParams(location.search);
const wantPath = params.get("path");
const wantRepo = params.get("repo");
const initialView = data.views[current];
if (initialView && !initialView.block && !initialView.text) {
  current = -1; // not prerendered: show it now
  show(data.initial);
}
if (wantPath) {
  const ofRepo = (v: ViewData) => !wantRepo || data.repos[v.repo].repo === wantRepo;
  let i = data.views.findIndex((v) => !v.block && v.path === wantPath && ofRepo(v));
  if (i < 0 && wantRepo) i = data.views.findIndex((v) => v.block && ofRepo(v));
  if (i >= 0) show(i);
}
const asked = location.hash.match(/^#pair-(\d+)$/);
if (asked && pairs.has(Number(asked[1]))) activate(Number(asked[1]), "legend", false);
loadPaper();
