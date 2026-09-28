// The highlighter, in a worker of the reader's browser: the page never waits for it. It
// receives a file's lines and its plan (src/lib/code.ts, planOf: runs of lines of one language
// each), loads the languages it needs (each its own small file), and answers the HTML of each
// line. The HTML is highlight.js's own: its classes (`hljs-keyword`) and the text, escaped by it;
// never a `style` attribute.
import hljs from "highlight.js/lib/core";
import { escapeHtml, splitHighlighted, unComment, type Segment } from "../lib/code";
import { EMBEDS, LOADERS } from "../lib/hljs-languages";

export type Job = { id: number; lines: string[]; segments: Segment[] };
export type Answer = { id: number; html: string[] | null; error?: string };

const loading = new Map<string, Promise<boolean>>();

/** Load a language (and those it embeds); false when there is no such language. */
function ensure(id: string): Promise<boolean> {
  if (!id || !Object.hasOwn(LOADERS, id)) return Promise.resolve(false);
  if (hljs.getLanguage(id)) return Promise.resolve(true);
  if (!loading.has(id)) {
    const p = (async () => {
      await Promise.all((EMBEDS[id] ?? []).map(ensure));
      const mod = await LOADERS[id]();
      hljs.registerLanguage(id, mod.default);
      return true;
    })();
    p.catch(() => loading.delete(id)); // a failed load may be tried again
    loading.set(id, p);
  }
  return loading.get(id)!;
}

async function run(job: Job): Promise<string[]> {
  const out = new Array<string>(job.lines.length);
  for (const s of job.segments) {
    const lines = job.lines.slice(s.from, s.to).map((l) => (s.strip ? unComment(l) : l));
    let html: string[] | null = null;
    if (await ensure(s.lang).catch(() => false)) {
      try {
        html = splitHighlighted(hljs.highlight(lines.join("\n"), { language: s.lang, ignoreIllegals: true }).value);
      } catch {
        html = null;
      }
    }
    if (!html || html.length !== lines.length) html = lines.map(escapeHtml);
    for (let i = 0; i < html.length; i++) out[s.from + i] = html[i];
  }
  for (let i = 0; i < out.length; i++) out[i] ??= escapeHtml(job.lines[i]);
  return out;
}

self.addEventListener("message", (ev: MessageEvent<Job>) => {
  const job = ev.data;
  run(job).then(
    (html) => self.postMessage({ id: job.id, html } satisfies Answer),
    (e: unknown) => self.postMessage({ id: job.id, html: null, error: e instanceof Error ? e.message : String(e) } satisfies Answer),
  );
});
