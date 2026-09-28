// The paper's pane of the Code ↔ Paper reader, in the reader's browser.
//
// Its full text is fetched from Europe PMC (open access; CORS is allowed) by this browser,
// never by the site, and shown as plain text. Its paragraphs are numbered the way the harvester
// numbers them: the index of each <p> among all the <p> of the JATS <body>, in document order
// (Python: `body.iter("p")`). The text is loaded only when the pane is shown.
import { pairClass, type Part } from "../lib/lines";
import type { ReaderData } from "../lib/reader";

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

/** The paper's pane: `load` fetches and renders the text once; `paragraph` finds one. */
export function paperPane(data: ReaderData, body: HTMLElement, status: HTMLElement) {
  let state: "idle" | "loading" | "done" | "failed" = "idle";
  let pending: Promise<void> | null = null;

  function render(xml: Document) {
    const root = xml.documentElement;
    const main = Array.from(root.children).find((e) => e.localName === "body") ?? xml.getElementsByTagName("body")[0];
    if (!main) throw new Error("the full text has no body");
    const list = Array.from(main.getElementsByTagName("p"));
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
    const beyond = data.pairs.filter((p) => p.paragraph >= list.length).length;
    status.replaceChildren(
      ...(lic.length ? nodes(lic) : ["Loaded from Europe PMC."]),
      beyond === 1 ? " One match points past the last paragraph: the text may have changed since it was computed." : "",
      beyond > 1 ? ` ${beyond} matches point past the last paragraph: the text may have changed since they were computed.` : "",
    );
  }

  function fail(reason: string) {
    state = "failed";
    status.className = "warning";
    status.replaceChildren(
      `The text of this paper could not be loaded from Europe PMC (${reason}). Read it at `,
      link(data.doiUrl, "doi.org"),
      " or on ",
      link(data.epmcUrl, "Europe PMC"),
      ".",
    );
  }

  async function fetchText() {
    if (!data.fulltextId) return fail("Europe PMC has no full text for it");
    state = "loading";
    status.textContent = "Loading the paper from Europe PMC…";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(data.fulltextId)}/fullTextXML`;
      const r = await fetch(url, { signal: ctl.signal, credentials: "omit", referrerPolicy: "no-referrer" });
      if (!r.ok) throw new Error(`Europe PMC answered HTTP ${r.status}`);
      const xml = new DOMParser().parseFromString(await r.text(), "application/xml");
      if (xml.getElementsByTagName("parsererror").length > 0) throw new Error("the full text is not valid XML");
      render(xml);
      state = "done";
    } catch (err) {
      const e = err as Error;
      fail(e.name === "AbortError" ? "Europe PMC did not answer in time" : e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Fetch and render the text, once. */
    load(): Promise<void> {
      if (state === "idle") pending = fetchText();
      return pending ?? Promise.resolve();
    },
    get loaded() {
      return state === "done";
    },
    paragraph: (n: number) => document.getElementById(`p-${n}`),
  };
}
