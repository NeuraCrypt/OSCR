// The reader's side of the highlighter: one worker (highlight-worker.ts) for the page, started
// when the first file is shown, asked for each file's lines. The page never waits for it: the
// lines are shown plain first, then colored when its answer comes. Without workers (or if the
// worker cannot start), the lines simply stay plain.
import type { Segment } from "../lib/code";
import type { Answer, Job } from "./highlight-worker";

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (html: string[] | null) => void>();

function start(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module", name: "highlighter" });
    w.addEventListener("message", (ev: MessageEvent<Answer>) => {
      waiting.get(ev.data.id)?.(ev.data.html);
      waiting.delete(ev.data.id);
    });
    w.addEventListener("error", () => {
      for (const done of waiting.values()) done(null);
      waiting.clear();
      worker = null;
    });
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** The HTML of each line, or null when the highlighter is not available. */
export function highlight(lines: string[], segments: Segment[]): Promise<string[] | null> {
  const w = start();
  if (!w) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, lines, segments } satisfies Job);
  });
}
