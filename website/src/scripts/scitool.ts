// A scientific tool's viewer (src/pages/scientific-tools/[slug].astro): the file chosen in the list
// is fetched from GitHub's raw files at the pinned commit, its SHA-256 checked against the
// manifest's, its email addresses masked (src/lib/source.ts fetchVerified, the papers' own check),
// then shown as numbered lines and colored by the reader's highlighter. The address keeps the file
// (?file=<path>), so a link opens on it. Nothing here names the platform; nothing asks the Worker.
import { languageOf, planOf } from "../lib/code";
import { plural, number } from "../lib/format";
import { splitLines } from "../lib/lines";
import { fetchVerified } from "../lib/source";
import { highlight } from "./highlighter";

const HIGHLIGHT_MAX_BYTES = 300_000;
const HIGHLIGHT_MAX_LINES = 8_000;

const pane = document.getElementById("scitool");
const viewer = document.getElementById("scitool-viewer");
const pathEl = document.getElementById("scitool-path");
const facts = document.getElementById("scitool-facts");
const source = document.getElementById("scitool-source") as HTMLAnchorElement | null;

if (pane && viewer && pathEl && facts && source) {
  const raw = pane.dataset.raw ?? "";
  const blob = pane.dataset.blob ?? "";
  const links = new Map<string, HTMLAnchorElement>();
  for (const a of pane.querySelectorAll<HTMLAnchorElement>(".files a[data-path]")) links.set(a.dataset.path!, a);
  const encode = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const cache = new Map<string, string>();
  let generation = 0;

  const say = (text: string) => {
    const p = document.createElement("p");
    p.className = "unavailable";
    p.textContent = text;
    viewer.replaceChildren(p);
  };

  async function open(path: string, push: boolean) {
    const a = links.get(path) ?? links.get(pane!.dataset.first ?? "") ?? links.values().next().value;
    if (!a) return say("This tool lists no file.");
    path = a.dataset.path!;
    const gen = ++generation;
    for (const l of links.values()) l.removeAttribute("aria-current");
    a.setAttribute("aria-current", "true");
    for (let d = a.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
    pathEl!.textContent = path;
    source!.href = blob + encode(path);
    const size = Number(a.dataset.size);
    const count = Number(a.dataset.lines);
    facts!.textContent = `${a.dataset.language}, ${plural(count, "line")}, ${number(Math.ceil(size / 1024))} KB`;
    if (push) {
      const url = new URL(location.href);
      url.searchParams.set("file", path);
      history.pushState({ file: path }, "", url);
    }
    let text = cache.get(path);
    if (text === undefined) {
      const loading = document.createElement("p");
      loading.className = "unavailable muted";
      loading.textContent = "Reading the file from GitHub...";
      viewer!.replaceChildren(loading);
      const got = await fetchVerified(raw + encode(path), { path, sha256: a.dataset.sha256!, size });
      if (gen !== generation) return;
      if (!got.ok) {
        const why = {
          large: "it is over 1 MB",
          http: "GitHub did not give it",
          network: "GitHub could not be reached",
          timeout: "GitHub took too long to answer",
          mismatch: "the file GitHub gave is not the one recorded (its SHA-256 differs)",
          binary: "it is not text",
        }[got.reason];
        return say(`This file cannot be shown: ${why}. It is on GitHub at this commit (the link above).`);
      }
      text = got.text;
      cache.set(path, text);
      if (cache.size > 24) cache.delete(cache.keys().next().value!);
    }
    show(gen, path, text, size);
  }

  function show(gen: number, path: string, text: string, size: number) {
    const lines = splitLines(text);
    const ol = document.createElement("ol");
    ol.className = `lines${lines.length >= 10_000 ? " digits-5" : lines.length >= 1_000 ? " digits-4" : ""}`;
    const items = lines.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    });
    ol.append(...items);
    viewer!.replaceChildren(ol);
    viewer!.scrollTo(0, 0);
    if (size > HIGHLIGHT_MAX_BYTES || lines.length > HIGHLIGHT_MAX_LINES) return;
    const plan = planOf(lines, languageOf(path));
    if (!plan.segments.some((s) => s.lang)) return;
    // highlight.js's own HTML: its classes and the text, escaped by it (lib/code.ts splitHighlighted).
    void highlight(lines, plan.segments).then((html) => {
      if (gen !== generation || !html || html.length !== items.length) return;
      html.forEach((h, k) => { items[k].innerHTML = h; });
    });
  }

  pane.addEventListener("click", (ev) => {
    const a = (ev.target as Element).closest<HTMLAnchorElement>(".files a[data-path]");
    if (!a || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    void open(a.dataset.path!, true);
  });
  addEventListener("popstate", () => void open(new URLSearchParams(location.search).get("file") ?? "", false));
  void open(new URLSearchParams(location.search).get("file") ?? "", false);
}
