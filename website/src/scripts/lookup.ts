// The DOI lookup, in the reader's browser (decision D2: every paper read can be found,
// with or without a page). Each paper read is in one shard, /lookup/NNN.json, NNN being
// the first 3 hex characters of the SHA-1 of its lowercased DOI (oscr/entities.py). A
// lookup runs only when the form is submitted, never as one types (decision D3's spirit).
// Like every browser script, it never names the platform: "the registry".
import { dateInWords } from "../lib/format";
import { PAGE_STATUSES, status } from "../lib/status";

type Entry = { status: string; read_on: string; slug?: string };
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
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(doi));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 3);
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
  const entry = shard[doi];
  if (!entry) {
    say("", `${doi} is not in the registry, which lists the open-access neuroscience papers it has read.`);
    return;
  }
  const day = dateInWords(entry.read_on);
  if (entry.slug) {
    say("", `${doi} was read on ${day}: `, { href: `/paper/${entry.slug}/`, text: "its page" }, ` (${status(entry.status).label}).`);
  } else if (PAGE_STATUSES.has(entry.status)) {
    say("", `${doi} was read on ${day}: ${status(entry.status).label}.`);
  } else if (entry.status === "no_fulltext") {
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
