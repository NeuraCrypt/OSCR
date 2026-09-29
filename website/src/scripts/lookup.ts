// The DOI lookup, in the reader's browser (decision D2: every paper read can be found,
// with or without a page). Each paper read is in one shard, /lookup/NN.json, NN being the
// first 2 hex characters of the SHA-1 of its lowercased DOI (oscr/entities.py, LOOKUP_HEX):
// 256 shards, one fetched per lookup. A shard maps a DOI to [status, day read] and, when the
// paper has a page, its name. A lookup runs only when the form is submitted, never as one
// types (decision D3's spirit). Like every browser script, it never names the platform:
// "the registry".
import { dateInWords } from "../lib/format";
import { lookupShard } from "../lib/shards";
import { PAGE_STATUSES, status } from "../lib/status";

/** [status, day read] or [status, day read, page]. */
type Entry = [string, string] | [string, string, string];
type Part = string | { href: string; text: string };

/** "https://doi.org/10.1234/ABC" or "doi:10.1234/abc" → "10.1234/abc"; "" when it is not a
 *  DOI. The same rule as normalize_doi in oscr/entities.py. */
export function normalizeDoi(text: string): string {
  let doi = text.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  if (doi.includes("%")) {
    try {
      doi = decodeURIComponent(doi);
    } catch {
      // not an encoded DOI: kept as typed
    }
  }
  doi = doi.toLowerCase();
  return /^10\.\d{3,9}\/\S+$/.test(doi) ? doi : "";
}

class Unavailable extends Error {}

/** The shard of a normalized DOI. */
export async function shardOf(doi: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Unavailable("this browser can only look up over a secure (https) connection");
  return lookupShard(doi);
}

const form = document.getElementById("lookup") as HTMLFormElement | null;
const input = document.getElementById("doi") as HTMLInputElement | null;
const out = document.getElementById("lookup-result");

function say(tone: "" | "warning", ...parts: Part[]) {
  if (!out) return;
  if (tone) out.className = tone;
  else out.removeAttribute("class");
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

let asked = 0;

async function lookup(typed: string) {
  const n = ++asked;
  const doi = normalizeDoi(typed);
  if (!doi) {
    say("warning", `“${typed.trim()}” is not a DOI: a DOI starts with “10.”, as in 10.1234/abcd.`);
    return;
  }
  say("", `Looking up ${doi}…`);
  let shard: Record<string, Entry>;
  try {
    const res = await fetch(`/lookup/${await shardOf(doi)}.json`, { headers: { Accept: "application/json" } });
    // No shard: no paper read has a DOI there.
    if (res.status === 404) shard = {};
    else if (!res.ok) throw new Unavailable(`the registry's index answered with the error ${res.status}`);
    else shard = (await res.json()) as Record<string, Entry>;
  } catch (e) {
    if (n !== asked) return;
    const why =
      e instanceof Unavailable ? e.message
      : e instanceof SyntaxError ? "the registry's index sent an answer that could not be read"
      : "the registry's index could not be reached; check the connection";
    say("warning", `The lookup failed: ${why}. Please try again in a moment.`);
    return;
  }
  if (n !== asked) return; // a later lookup has started
  const entry = Object.hasOwn(shard, doi) ? shard[doi] : undefined;
  if (!Array.isArray(entry)) {
    say("", `${doi} is not in the registry, which lists the open-access neuroscience papers it has read.`);
    return;
  }
  const [state, readOn, slug] = entry;
  const day = dateInWords(readOn);
  if (slug && /^[a-z0-9._-]+$/.test(slug)) {
    say("", `${doi} was read on ${day}: `, { href: `/paper/${slug}/`, text: "its page" }, ` (${status(state).label}).`);
  } else if (PAGE_STATUSES.has(state)) {
    say("", `${doi} was read on ${day}: ${status(state).label}.`);
  } else if (state === "no_fulltext") {
    say("", `${doi} was read on ${day}, no code found: its full text was not available, only its metadata was read.`);
  } else {
    say("", `${doi} was read on ${day}, no code found.`);
  }
}

/** The DOI asked for in the address (?doi=…): the form was submitted to it. */
const asking = () => new URLSearchParams(location.search).get("doi") ?? "";

if (form && input) {
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const typed = input.value;
    const url = new URL(location.href);
    url.searchParams.set("doi", typed.trim());
    history.pushState(null, "", url);
    void lookup(typed);
  });
  window.addEventListener("popstate", () => {
    input.value = asking();
    if (input.value) void lookup(input.value);
    else say("");
  });
  if (asking()) {
    input.value = asking();
    void lookup(input.value);
  }
}
