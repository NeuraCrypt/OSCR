// The page of a paper past STATIC_PAPERS, in the reader's browser: only when the assets serve
// the shell themselves (wrangler.toml `not_found_handling = "404-page"`, with no Worker
// request); as configured, the Worker renders the page and this script is not in it
// (src/pages/paper/404.astro). It reads the paper's record in /records/paper/NN.json and renders
// it with the markup of lib/render.ts, the Worker's. It never names the platform.
import { missingPaper, paperView, type PaperRecord, type View } from "../lib/render";
import { keyOf, shardOf, SHARDS } from "../lib/shards";

const root = document.getElementById("paper");
const status = document.getElementById("paper-status");

function show(view: View, found: boolean) {
  const main = root?.closest("main");
  if (!main) return;
  main.innerHTML = view.html;
  const site = document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content ?? "";
  document.title = site ? `${view.title} — ${site}` : view.title;
  const crumb = document.getElementById("crumb");
  if (crumb) crumb.textContent = view.crumb;
  if (view.description) document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", view.description);
  if (found && location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

function fail(why: string) {
  if (!status) return;
  status.className = "warning";
  status.textContent = `This page could not be loaded: ${why}. Please try again in a moment.`;
}

async function render() {
  // /paper/<slug>/ or, for a reader that is not built, /paper/<slug>/code/
  const [first, raw = "", ...rest] = location.pathname.split("/").filter(Boolean);
  const slug = first === "paper" && (rest.length === 0 || (rest.length === 1 && rest[0] === "code")) ? keyOf("paper", raw) : "";
  if (!slug) return show(missingPaper(raw), false);
  let name: string;
  try {
    name = await shardOf(slug, SHARDS.paper);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  let shard: Record<string, PaperRecord>;
  try {
    const res = await fetch(`/records/paper/${name}.json`, { headers: { Accept: "application/json" } });
    if (res.status === 404) return show(missingPaper(slug), false);
    if (!res.ok) return fail(`the registry answered with the error ${res.status}`);
    shard = (await res.json()) as Record<string, PaperRecord>;
  } catch (e) {
    return fail(e instanceof SyntaxError ? "the registry sent an answer that could not be read" : "the registry could not be reached; check the connection");
  }
  const record = shard[slug];
  if (!record) return show(missingPaper(slug), false);
  if (rest.length === 1) history.replaceState(null, "", `/paper/${slug}/#code`);
  show(paperView(record), true);
}

if (root) void render();
