// The paper's pane of the Code ↔ Paper reader, in the reader's browser.
//
// Its full text is fetched from Europe PMC (open access; CORS is allowed) by this browser,
// never by the site, and shown as plain text. Its paragraphs are numbered the way the harvester
// numbers them: the index of each <p> among all the <p> of the JATS <body>, in document order
// (Python: `body.iter("p")`). The text is loaded only when the pane is shown.
//
// When Europe PMC does not answer (twice), a paper in PubMed Central is read from NCBI's copy
// (E-utilities, CORS allowed), whose paragraphs may be numbered otherwise: each pair is then
// placed by its section and its terms (src/lib/anchor.ts), and the pane says so.
import { placePairs, type CopyParagraph } from "../lib/anchor";
import { pairClass, type Part } from "../lib/lines";
import type { ReaderData, ReaderPair } from "../lib/reader";
import { HttpError, TimeoutError, withRetry } from "../lib/retry";

type Source = "europepmc" | "pmc";
const EUROPE_PMC = (id: string) => `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(id)}/fullTextXML`;
const PMC = (id: string) => `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${id.replace(/^PMC/i, "")}`;

/** The link that activates pair k (the same markup on both sides, see code-view.ts). */
export function pairLink(k: number, text: string, to: "code" | "paragraph"): HTMLAnchorElement {
  const a = link(`#pair-${k}`, text);
  a.dataset.pair = String(k);
  a.title = `Match ${k}: show the ${to === "code" ? "lines of code" : "paragraph"}`;
  return a;
}

export const link = (href: string, text: string) => Object.assign(document.createElement("a"), { href, textContent: text });
const nodes = (parts: Part[]) => parts.map((p) => (typeof p === "string" ? p : link(p.href, p.text)));

// Elements whose paragraphs get a heading: sections (their title), figures, tables and boxes
// (their label and caption title).
const CONTAINERS = new Set(["sec", "app", "fig", "table-wrap", "boxed-text", "supplementary-material"]);
// Elements left out of a paragraph's text: nested blocks (their own <p> are shown on their
// own), and what is not text (images, alternative TeX, descriptions).
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
    return Object.assign(document.createElement(`h${Math.min(depth + 3, 6)}`), { textContent: text });
  }
  const label = child(c, "label");
  const title = child(child(c, "caption"), "title");
  const l = label ? clean(flatten(label)) : "";
  const t = title ? clean(flatten(title)) : "";
  if (!l && !t) return null;
  const p = document.createElement("p");
  p.className = "caption";
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

/** The paper's pane: `load` fetches and renders the text once (then calls `loaded`);
 *  `paragraph` finds one. */
export function paperPane(data: ReaderData, body: HTMLElement, status: HTMLElement, loaded: () => void) {
  const sourceName = document.getElementById("paper-source");
  let state: "idle" | "loading" | "done" | "failed" = "idle";
  let pending: Promise<void> | null = null;

  /** Where each pair's paragraph is in the text shown (pair → index). */
  let at = new Map<number, number>();

  /** The titles of the sections around a paragraph, as the harvester joins them. */
  function sectionOf(p: Element, main: Element): string {
    const titles: string[] = [];
    for (let e = p.parentElement; e && e !== main; e = e.parentElement) {
      if (e.localName !== "sec") continue;
      const t = child(e, "title");
      const text = t ? clean(flatten(t)) : "";
      if (text) titles.unshift(text);
    }
    return titles.join(" \u203a ");
  }

  function render(xml: Document, source: Source) {
    // NCBI's copy holds the article in a <pmc-articleset>.
    const top = xml.documentElement;
    const root = top.localName === "pmc-articleset" ? (Array.from(top.children).find((e) => e.localName === "article") ?? top) : top;
    const main = Array.from(root.children).find((e) => e.localName === "body");
    if (!main) throw new Error("the full text has no body");
    const list = Array.from(main.getElementsByTagName("p"));
    let placed = { moved: 0, lost: 0 };
    if (source === "europepmc") at = new Map(data.pairs.filter((p) => p.paragraph < list.length).map((p) => [p.pair, p.paragraph]));
    else {
      const copy: CopyParagraph[] = list.map((p) => ({ section: sectionOf(p, main), text: clean(flatten(p)) }));
      const r = placePairs(data.pairs, copy);
      at = r.at;
      placed = r;
    }
    const byParagraph = new Map<number, number[]>();
    for (const p of data.pairs) {
      const i = at.get(p.pair);
      if (i === undefined) continue;
      if (!byParagraph.has(i)) byParagraph.set(i, []);
      byParagraph.get(i)!.push(p.pair);
    }
    const out = document.createDocumentFragment();
    const headed = new Set<Element>();
    list.forEach((p, i) => {
      // The headings of the sections, figures and tables this paragraph opens.
      const chain: Element[] = [];
      for (let e = p.parentElement; e && e !== main; e = e.parentElement) if (CONTAINERS.has(e.localName)) chain.unshift(e);
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
    body.append(out);
    const lic = license(xml);
    if (source === "pmc") {
      if (sourceName) sourceName.textContent = "PubMed Central";
      const n = data.pairs.length;
      status.replaceChildren(
        "Europe PMC did not answer: this is PubMed Central's copy of the paper, whose paragraphs may be numbered otherwise. ",
        n === 0
          ? ""
          : placed.lost === 0
            ? `${n === 1 ? "The match was" : `The ${n} matches were`} placed by their sections and their terms. `
            : `The matches were placed by their sections and their terms; ${placed.lost} of ${n} could not be. `,
        ...(lic.length ? nodes(lic) : []),
      );
      return;
    }
    const beyond = data.pairs.filter((p) => p.paragraph >= list.length).length;
    status.replaceChildren(
      ...(lic.length ? nodes(lic) : ["Loaded from Europe PMC."]),
      beyond === 1 ? " One match points past the last paragraph: the text may have changed since it was computed." : "",
      beyond > 1 ? ` ${beyond} matches point past the last paragraph: the text may have changed since they were computed.` : "",
    );
  }

  /** The pane while the text comes: a sentence, and a thin bar that moves (science.css). */
  function waiting(text: string) {
    status.className = "loading";
    status.textContent = text;
  }

  function fail(reason: string) {
    state = "failed";
    status.className = "warning";
    const again = document.createElement("button");
    again.type = "button";
    again.textContent = "Try again";
    again.addEventListener("click", () => {
      state = "idle";
      void load();
    });
    status.replaceChildren(
      `The text of this paper could not be loaded from Europe PMC (${reason}). Read it at `,
      link(data.doiUrl, "doi.org"),
      " or on ",
      link(data.epmcUrl, "Europe PMC"),
      ", or ",
      again,
    );
  }

  /** The text at `url`: `tries` tries of 20 seconds, the pane saying what it waits for. */
  function get(url: string, tries: number, where: string): Promise<string> {
    return withRetry(
      async (signal) => {
        const r = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
        if (!r.ok) throw new HttpError(r.status);
        return r.text();
      },
      {
        tries,
        timeout: 20_000,
        pause: 1_500,
        slowAfter: 7_000,
        onSlow: (n) => waiting(n === 1 ? `Loading the paper from ${where}… it is slow to answer; still waiting.` : `Still waiting for ${where}…`),
        onRetry: () => waiting(`${where} did not answer; trying again…`),
      },
    );
  }

  function parse(text: string): Document {
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.getElementsByTagName("parsererror").length > 0) throw new Error("the full text is not valid XML");
    return xml;
  }

  function show(xml: Document, source: Source) {
    status.className = "";
    render(xml, source);
    state = "done";
    loaded();
  }

  async function fetchText() {
    if (!data.fulltextId) return fail("Europe PMC has no full text for it");
    state = "loading";
    waiting("Loading the paper from Europe PMC…");
    let first: unknown = null;
    try {
      // Europe PMC's XML takes one to six seconds, sometimes more: 20 seconds a try, and one
      // more try when the first gets no answer, a network error or a server's error.
      return show(parse(await get(EUROPE_PMC(data.fulltextId), 2, "Europe PMC")), "europepmc");
    } catch (err) {
      first = err;
    }
    // Europe PMC did not give it: PubMed Central's copy, for a paper there.
    if (/^PMC\d+$/i.test(data.fulltextId)) {
      waiting("Europe PMC did not answer; loading the paper from PubMed Central…");
      try {
        return show(parse(await get(PMC(data.fulltextId), 1, "PubMed Central")), "pmc");
      } catch {
        // The first failure is the one told.
      }
    }
    const e = first as Error;
    if (e instanceof HttpError && e.status === 404) return fail("it has no full text for this paper");
    if (e instanceof TimeoutError) return fail(`no answer within ${e.seconds} seconds, tried twice`);
    fail(e instanceof TypeError ? "the network did not let the request through" : e.message);
  }

  function load(): Promise<void> {
    if (state === "idle") pending = fetchText();
    return pending ?? Promise.resolve();
  }

  return {
    /** Fetch and render the text, once (again after a failure, from its button). */
    load,
    get loaded() {
      return state === "done";
    },
    /** Paragraph n of the text shown (an address's #p-12). */
    paragraph: (n: number) => document.getElementById(`p-${n}`),
    /** The paragraph of a pair, where it was placed in the text shown. */
    forPair(p: ReaderPair): HTMLElement | null {
      const i = at.get(p.pair);
      return i === undefined ? null : document.getElementById(`p-${i}`);
    },
  };
}
