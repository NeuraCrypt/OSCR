// The Code ↔ Paper reader, first on a paper's page (src/components/paper/Reader.astro), in the
// reader's browser.
//
// LEFT, the paper (reader-paper.ts): its text is fetched from Europe PMC by this browser, only
// while its pane is shown; a button hides the pane (the choice is kept in this browser).
// RIGHT, the authors' code: the list of its files (file-tree.ts) and the viewer (code-view.ts).
// The file shown first is written into the page by the build; the others are fetched from the
// lot of their repository (/scripts/NN.json).
//
// A pair joins paragraph p-<i> and the lines start..end of a file: the same color on both
// sides. Clicking one side brings the other into view and marks both `.is-active`; the legend,
// and the previous and next buttons, do both.
//
// The address says what is shown: ?path=… (and repo=… when the paper has several repositories)
// for the file, then #pair-3 for a pair, or #L10-L20 for lines. Like every browser script, it
// never names the platform.
import { anchorText, lineAnchor, type Range } from "../lib/code";
import { browserStore, PREFS, readPref, writePref } from "../lib/prefs";
import { fileHref, type ReaderData } from "../lib/reader";
import { codeView, scrollInto } from "./code-view";
import { fileTree } from "./file-tree";
import { paperPane } from "./reader-paper";

type LotData = Record<string, { files: { path: string; text: string | null }[] }>;
type Side = "legend" | "paper" | "code";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const dataEl = byId("reader-data");

if (dataEl) start(JSON.parse(dataEl.textContent!) as ReaderData);

function start(data: ReaderData) {
  const pairs = new Map(data.pairs.map((p) => [p.pair, p]));
  const multi = data.repos.length > 1;
  const base = location.pathname;
  const compare = byId("compare")!;
  const paperSide = byId("paper-pane")!;
  const paperBody = byId("paper")!;
  const status = byId("paper-status")!;
  const codeSide = byId("code-pane")!;
  const nav = byId("file-tree");
  const togglePaper = byId<HTMLButtonElement>("toggle-paper");
  const toggleFiles = byId<HTMLButtonElement>("toggle-files");
  const wrapBtn = byId<HTMLButtonElement>("wrap-lines");
  const live = byId("code-status");
  const narrow = matchMedia("(max-width: 900px)");
  const motion: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

  let active = 0; // the pair being read; 0: none
  let ticket = 0; // the latest request to show a file: an older one that ends late is ignored

  const paper = paperPane(data, paperBody, status, () => afterPaper());
  const say = (text: string) => {
    if (live) live.textContent = text;
  };
  /** The address of file i, with lines or a pair. */
  const url = (i: number, range: Range | null, pair = 0): string => {
    const f = data.files[i];
    const anchor = pair ? `pair-${pair}` : range ? anchorText(range) : "";
    if (!f || i === data.initial) return `${base}${anchor ? `#${anchor}` : ""}`;
    return fileHref(base, data.repos[f.repo].repo, f.path, multi, anchor);
  };
  const view = codeView(data, { url: (i, r) => url(i, r), say });
  const tree = nav ? fileTree(nav, data, base, (i) => void pick(i)) : null;

  /* ---------- The paper pane, shown or hidden ---------- */

  const paperShown = () => !paperSide.hidden;
  function setPaper(on: boolean, remember: boolean) {
    paperSide.hidden = !on;
    compare.classList.toggle("paper-hidden", !on);
    if (togglePaper) {
      togglePaper.setAttribute("aria-expanded", String(on));
      togglePaper.textContent = on ? "Hide the paper" : "Show the paper";
    }
    if (remember) writePref(browserStore, PREFS.paper, on ? "shown" : "hidden");
    if (on) void paper.load();
  }
  togglePaper?.addEventListener("click", () => {
    setPaper(!paperShown(), true);
    say(paperShown() ? "The paper is shown beside the code." : "The paper is hidden: the code takes the whole width.");
  });

  /** Once the paper is there: the pair or paragraph already chosen, in view. */
  function afterPaper() {
    const p = pairs.get(active);
    const para = p && paper.paragraph(p.paragraph);
    if (para) {
      para.classList.add("is-active");
      scrollInto(paperBody, para);
      return;
    }
    const at = location.hash.match(/^#p-(\d+)$/);
    const target = at && paper.paragraph(Number(at[1]));
    if (target) scrollInto(paperBody, target);
  }

  /* ---------- The list of files, shown or hidden ---------- */

  function setFiles(on: boolean, remember: boolean) {
    if (!nav) return;
    nav.hidden = !on;
    toggleFiles?.setAttribute("aria-expanded", String(on));
    if (remember) writePref(browserStore, PREFS.files, on ? "shown" : "hidden");
    if (on) tree?.setCurrent(view.current);
  }
  toggleFiles?.addEventListener("click", () => setFiles(!!nav?.hidden, !narrow.matches));

  wrapBtn?.addEventListener("click", () => {
    const on = wrapBtn.getAttribute("aria-pressed") !== "true";
    view.setWrap(on);
    writePref(browserStore, PREFS.wrap, on ? "on" : "off");
  });

  /* ---------- The files ---------- */

  const lots = new Map<string, Promise<LotData>>();
  function lot(n: string): Promise<LotData> {
    if (!lots.has(n)) {
      const p = fetch(`/scripts/${n}.json`).then((r) => {
        if (!r.ok) throw new Error(`the registry answered HTTP ${r.status}`);
        return r.json() as Promise<LotData>;
      });
      p.catch(() => lots.delete(n)); // a failed load can be tried again
      lots.set(n, p);
    }
    return lots.get(n)!;
  }

  /** Show file i in the code pane; false if it could not be shown (or was overtaken). */
  async function show(i: number): Promise<boolean> {
    const mine = ++ticket;
    const f = data.files[i];
    if (!f) return false;
    tree?.setCurrent(i);
    if (i === view.current) return true;
    if (!f.text) {
      view.showAway(i);
      return true;
    }
    view.loading(i);
    const repo = data.repos[f.repo];
    let text: string | null = null;
    let failure = "";
    try {
      text = (await lot(repo.lot))[repo.repo]?.files.find((x) => x.path === f.path)?.text ?? null;
      if (text === null) failure = "it is not among the published files";
    } catch (err) {
      failure = `the files of its repository did not load: ${(err as Error).message}`;
    }
    if (mine !== ticket) return false;
    if (text === null) {
      view.showAway(i, failure);
      return false;
    }
    view.show(i, text);
    return true;
  }

  /** A file chosen in the list: shown, and named in the address. */
  async function pick(i: number) {
    active = 0;
    clearActive();
    history.replaceState(null, "", url(i, null));
    if (narrow.matches) setFiles(false, false);
    await show(i);
  }

  /* ---------- Pairs ---------- */

  function clearActive() {
    for (const e of Array.from(document.querySelectorAll(".is-active"))) e.classList.remove("is-active");
  }

  /** In a narrow window the panes are one above the other: bring the one to read into view.
   *  Otherwise, the two panes whole, when they start low in the window or above it. */
  function bring(to: "paper" | "code") {
    const box = (narrow.matches ? (to === "paper" && paperShown() ? paperSide : codeSide) : compare).getBoundingClientRect();
    if (box.top < 0 || box.top > innerHeight * 0.35) window.scrollTo({ top: scrollY + box.top - 8, behavior: motion });
  }

  async function activate(k: number, from: Side, keyboard: boolean) {
    const p = pairs.get(k);
    if (!p) return;
    active = k;
    history.replaceState(null, "", url(p.file >= 0 ? p.file : view.current, null, k));
    clearActive();
    document.querySelector(`#legend a[data-pair="${k}"]`)?.classList.add("is-active");
    const para = paperShown() ? paper.paragraph(p.paragraph) : null;
    para?.classList.add("is-active");
    const shown = p.file >= 0 && (await show(p.file));
    if (active !== k) return; // another pair was chosen meanwhile
    const lines = shown ? view.markPair(p) : null;
    bring(from === "code" ? "paper" : "code");
    if (from !== "paper" && para) scrollInto(paperBody, para);
    if (from !== "code" && lines) scrollInto(view.viewer, lines);
    say(`Match ${k}: ${p.label}, ${p.path} lines ${p.start} to ${p.end}.`);
    if (keyboard) {
      // The keyboard follows the pair to the other side.
      const there =
        from === "paper"
          ? (codeSide.querySelector<HTMLElement>(`#lines a[data-pair="${k}"]`) ?? lines?.querySelector("a"))
          : from === "code"
            ? paperBody.querySelector<HTMLElement>(`a[data-pair="${k}"]`)
            : null;
      there?.focus({ preventScroll: true });
    }
  }

  document.addEventListener("click", (ev) => {
    const target = ev.target as Element;
    if (!target.closest("#code")) return;
    const keyboard = ev.detail === 0;
    const a = target.closest<HTMLAnchorElement>("a[data-pair]");
    if (a) {
      ev.preventDefault();
      const side: Side = a.closest("#paper") ? "paper" : a.closest("#code-pane") ? "code" : "legend";
      void activate(Number(a.dataset.pair), side, keyboard);
      return;
    }
    if (target.closest("a, select, button, summary, label, input")) return;
    if (getSelection()?.toString()) return; // text is being selected, not clicked
    const holder = target.closest<HTMLElement>("#paper [data-pairs], #code-view [data-pairs]");
    if (!holder) return;
    // Several pairs on the same paragraph or line: each click shows the next one.
    const ks = holder.dataset.pairs!.split(" ").map(Number);
    void activate(ks[(ks.indexOf(active) + 1) % ks.length], holder.closest("#paper") ? "paper" : "code", false);
  });

  // The previous and next matches, in the order of their numbers.
  const order = data.pairs.map((p) => p.pair);
  const step = (d: 1 | -1) => {
    if (!order.length) return;
    const at = order.indexOf(active);
    const next = at < 0 ? (d > 0 ? 0 : order.length - 1) : (at + d + order.length) % order.length;
    void activate(order[next], "legend", false);
  };
  byId("pair-prev")?.addEventListener("click", () => step(-1));
  byId("pair-next")?.addEventListener("click", () => step(1));

  /* ---------- The address ---------- */

  /** What the address asks for: a pair, else lines of the file shown. */
  async function follow(hash: string, scroll: boolean) {
    const pair = hash.match(/^#pair-(\d+)$/);
    if (pair && pairs.has(Number(pair[1]))) return activate(Number(pair[1]), "legend", false);
    const range = lineAnchor(hash);
    if (range && view.lineCount) view.select(range, scroll);
  }
  addEventListener("hashchange", () => void follow(location.hash, true));

  /* ---------- Start ---------- */

  // The choices kept in this browser: the paper, long lines, the list of files (closed on a phone).
  view.setWrap(readPref(browserStore, PREFS.wrap, ["on", "off"], "off") === "on");
  setFiles(narrow.matches ? false : readPref(browserStore, PREFS.files, ["shown", "hidden"], "shown") === "shown", false);
  const first = asked(location.search);
  const prerendered = data.initial >= 0 && data.files[data.initial]?.text;
  const ready = first >= 0 && first === data.initial && prerendered ? Promise.resolve(view.adopt(first)) : first >= 0 ? show(first) : Promise.resolve(false);
  tree?.setCurrent(first);
  setPaper(readPref(browserStore, PREFS.paper, ["shown", "hidden"], "shown") === "shown", false);
  void ready.then(() => follow(location.hash, true));

  /** The file an address asks for (?path=…, ?repo=…): else the one shown first. A repository
   *  alone: its file with the most matches, else its first file whose text is here. */
  function asked(search: string): number {
    const params = new URLSearchParams(search);
    const path = params.get("path");
    const repo = params.get("repo");
    const ofRepo = (i: number) => !repo || data.repos[data.files[i].repo].repo === repo;
    const all = data.files.map((_, i) => i).filter(ofRepo);
    if (path) return all.find((i) => data.files[i].path === path) ?? data.initial;
    if (!repo || !all.length) return data.initial;
    if (all.includes(data.initial)) return data.initial;
    const best = [...all].sort((x, y) => data.files[y].pairs.length - data.files[x].pairs.length)[0];
    return data.files[best].pairs.length ? best : (all.find((i) => data.files[i].text) ?? all[0]);
  }

  // A link elsewhere on the page to a file of the reader (the Repositories section, the
  // sidebar): shown here, without loading the page again.
  document.addEventListener("click", (ev) => {
    const a = (ev.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!a || a.closest("#code") || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (a.origin !== location.origin || a.pathname !== base || !a.search) return;
    const params = new URLSearchParams(a.search);
    if (!params.has("path") && !params.has("repo")) return;
    ev.preventDefault();
    const i = asked(a.search);
    if (i >= 0) void pick(i);
    byId("code")?.scrollIntoView({ behavior: motion });
  });
}
