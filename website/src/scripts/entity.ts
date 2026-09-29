// An entity's page, in the reader's browser: the page is one shell per type (/author/, …),
// which public/_redirects serves for every /author/<orcid>/ and the like. The script reads the
// key from the address, fetches its shard, /records/<type>/NN.json (one file, from this site),
// and renders the entity with the markup of lib/render.ts. Like every browser script, it never
// names the platform: the page's own <meta name="application-name"> does.
import { entityView, missingEntity, type EntityShard, type View } from "../lib/render";
import { ENTITY_TYPES, keyOf, shardOf, SHARDS, type EntityType } from "../lib/shards";

const root = document.getElementById("entity");
const status = document.getElementById("entity-status");
const type = root?.dataset.type as EntityType | undefined;

function show(view: View, found: boolean) {
  const main = root?.closest("main");
  if (!main) return;
  main.innerHTML = view.html;
  const site = document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content ?? "";
  document.title = site ? `${view.title} — ${site}` : view.title;
  const crumb = document.getElementById("crumb");
  if (crumb) crumb.textContent = view.crumb;
  if (view.description) document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", view.description);
  if (!found) {
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex";
    document.head.append(robots);
  }
}

function fail(why: string) {
  if (!status) return;
  status.className = "warning";
  status.textContent = `This page could not be loaded: ${why}. Please try again in a moment.`;
}

async function render(t: EntityType) {
  // /author/0000-0002-1825-0097/ → "author", "0000-0002-1825-0097"
  const [first, raw = "", ...rest] = location.pathname.split("/").filter(Boolean);
  const key = first === t && rest.length === 0 ? keyOf(t, raw) : "";
  if (!key) return show(missingEntity(t, ""), false);
  let name: string;
  try {
    name = await shardOf(key, SHARDS[t]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  let shard: EntityShard;
  try {
    const res = await fetch(`/records/${t}/${name}.json`, { headers: { Accept: "application/json" } });
    // No shard: no entity of the registry has a key there.
    if (res.status === 404) return show(missingEntity(t, key), false);
    if (!res.ok) return fail(`the registry answered with the error ${res.status}`);
    shard = (await res.json()) as EntityShard;
  } catch (e) {
    return fail(e instanceof SyntaxError ? "the registry sent an answer that could not be read" : "the registry could not be reached; check the connection");
  }
  const e = shard.entities?.[key];
  show(e ? entityView(t, e, shard.rows ?? {}) : missingEntity(t, key), e !== undefined);
  // Night phase 08: an author's Follow button (their ORCID iD), loaded only on an author's page.
  const main = root?.closest("main") ?? document.querySelector("main");
  if (e && t === "author" && main?.querySelector("[data-social]")) void import("./social-buttons").then((m) => m.mountAll(main));
}

if (type && (ENTITY_TYPES as readonly string[]).includes(type)) void render(type);
