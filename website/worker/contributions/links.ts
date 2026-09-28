// A link as a person types it into a form, recognized the way the harvester recognizes links
// (oscr/links.py, which stays the reference: the Mac normalizes every link again before it uses
// it). The Worker needs three things from it: whether the place is one the registry knows (a
// forge, an archive, a data repository: "the forge is recognized"), the key the registry gives it
// ("github.com/owner/name", "zenodo:123"), and the address to ask whether it answers.
//
// Only these places, never an arbitrary address: the Worker's checks fetch the links, and must
// not be made to fetch anything else.

import { repoKey } from "../account/repo.ts";

export type Role = "code" | "data";

export interface Recognized {
  /** The registry's key: "github.com/owner/name", "zenodo:123", "doi:10.5061/dryad.x". */
  key: string;
  /** The link as the registry keeps it: https, canonical, without a query or a fragment. */
  url: string;
  /** Where the Worker checks that it answers (a web page; the DOI proxy's handle API for a DOI). */
  check: string;
  /** How the check reads the answer: a page (2xx/3xx: there; 404/410: missing), or a DOI handle. */
  via: "page" | "doi";
  /** forge, archive, data: what kind of place it is. */
  kind: "forge" | "archive" | "data";
}

const DOI = /^10\.\d{3,9}\/\S{1,200}$/;

/** "https://doi.org/10.1234/ABC" or "doi:10.1234/abc" → "10.1234/abc"; "" when it is not a DOI.
 *  The rule of normalizeDoi in src/scripts/lookup.ts and of normalize_doi in oscr/entities.py. */
export function normalizeDoi(text: unknown): string {
  if (typeof text !== "string" || text.length > 300) return "";
  let doi = text.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  if (doi.includes("%")) {
    try {
      doi = decodeURIComponent(doi);
    } catch {
      return "";
    }
  }
  doi = doi.toLowerCase();
  return DOI.test(doi) ? doi : "";
}

/** The DOI proxy's handle API for a DOI: 200 and responseCode 1 when it exists, 404 otherwise. */
export function handleUrl(doi: string): string {
  return `https://doi.org/api/handles/${encodeURIComponent(doi).replace(/%2F/gi, "/")}`;
}

/** Archives whose records are known by a DOI prefix (oscr/links.py DOI_PREFIXES). */
function fromDoi(doi: string, role: Role): Recognized | null {
  let m = /^10\.5281\/zenodo\.(\d{1,12})$/.exec(doi);
  if (m) return zenodo(m[1]);
  m = /^10\.17605\/osf\.io\/([a-z0-9]{5})$/.exec(doi);
  if (m) return osf(m[1]);
  m = /^10\.6084\/m9\.figshare\.(\d{1,12})(?:\.v\d+)?$/.exec(doi);
  if (m) return figshare(m[1]);
  // Any other DOI is a data link at most (a dataset at Dryad, Figshare, a data journal…); code
  // is recognized by its place.
  if (role !== "data") return null;
  return { key: `doi:${doi}`, url: `https://doi.org/${doi}`, check: handleUrl(doi), via: "doi", kind: "data" };
}

const zenodo = (id: string): Recognized => ({
  key: `zenodo:${id}`,
  url: `https://zenodo.org/records/${id}`,
  check: `https://zenodo.org/records/${id}`,
  via: "page",
  kind: "archive",
});
const osf = (guid: string): Recognized => ({
  key: `osf:${guid}`,
  url: `https://osf.io/${guid}/`,
  check: `https://osf.io/${guid}/`,
  via: "page",
  kind: "archive",
});
const figshare = (id: string): Recognized => ({
  key: `figshare:${id}`,
  url: `https://figshare.com/articles/_/${id}`,
  check: `https://figshare.com/articles/_/${id}`,
  via: "page",
  kind: "archive",
});

/** The link in `text` recognized for `role`, or null when it names no place the registry knows. */
export function recognize(text: unknown, role: Role): Recognized | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t || t.length > 300 || /\s/.test(t)) return null;
  const doi = normalizeDoi(t);
  if (doi) return fromDoi(doi, role);

  // A forge whose addresses name an owner: the accounts' own rule (account/repo.ts).
  const forge = repoKey(t);
  if (forge) {
    if (forge.startsWith("github.com/") && /^github\.com\/(orgs|settings|marketplace|features|topics|sponsors|apps|login)\//.test(forge)) {
      return null;
    }
    return { key: forge, url: `https://${forge}`, check: `https://${forge}`, via: "page", kind: "forge" };
  }

  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let m: RegExpExecArray | null;
  switch (host) {
    case "zenodo.org":
      if (parts.length >= 2 && (parts[0] === "records" || parts[0] === "record") && /^\d{1,12}$/.test(parts[1])) return zenodo(parts[1]);
      if (parts[0] === "doi" && (m = /^10\.5281\/zenodo\.(\d{1,12})$/.exec(parts.slice(1).join("/").toLowerCase()))) return zenodo(m[1]);
      return null;
    case "osf.io":
      return parts.length >= 1 && /^[a-z0-9]{5}$/i.test(parts[0]) ? osf(parts[0].toLowerCase()) : null;
    case "figshare.com": {
      const id = parts.find((p, i) => i > 0 && /^\d{4,12}$/.test(p));
      return parts[0] === "articles" && id ? figshare(id) : null;
    }
    case "huggingface.co": {
      const [a, b, c] = parts;
      const path = (a === "spaces" || a === "datasets") && b && c ? `${a}/${b}/${c}` : a && b && !["papers", "docs", "blog", "models", "learn"].includes(a) ? `${a}/${b}` : "";
      if (!path || !/^[A-Za-z0-9._/-]{3,200}$/.test(path)) return null;
      if (a === "datasets" && role !== "data") return null;
      const key = `huggingface.co/${path.toLowerCase()}`;
      return { key, url: `https://${key}`, check: `https://${key}`, via: "page", kind: a === "datasets" ? "data" : "forge" };
    }
    case "codeocean.com":
      if (parts[0] === "capsule" && /^\d{1,12}$/.test(parts[1] ?? "")) {
        return { key: `codeocean:${parts[1]}`, url: `https://codeocean.com/capsule/${parts[1]}/tree`, check: `https://codeocean.com/capsule/${parts[1]}/tree`, via: "page", kind: "archive" };
      }
      return null;
    case "openneuro.org": {
      const i = parts.indexOf("datasets");
      const ds = i >= 0 ? (parts[i + 1] ?? "").toLowerCase() : "";
      if (role !== "data" || !/^ds\d{6}$/.test(ds)) return null;
      return { key: `openneuro:${ds}`, url: `https://openneuro.org/datasets/${ds}`, check: `https://openneuro.org/datasets/${ds}`, via: "page", kind: "data" };
    }
    case "dandiarchive.org": {
      const i = parts.indexOf("dandiset");
      const ds = i >= 0 ? (parts[i + 1] ?? "") : "";
      if (role !== "data" || !/^\d{6}$/.test(ds)) return null;
      return { key: `dandi:${ds}`, url: `https://dandiarchive.org/dandiset/${ds}`, check: `https://dandiarchive.org/dandiset/${ds}`, via: "page", kind: "data" };
    }
  }
  return null;
}

/** A key the registry gives a link, as a correction names it ("github.com/owner/name",
 *  "zenodo:123", "doi:10.1234/x"): its shape only; the Mac knows whether the paper has it. */
export function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 5 && value.length <= 250 && /^[a-z0-9][a-z0-9._~:/()+-]*$/i.test(value) && !value.includes("//");
}
