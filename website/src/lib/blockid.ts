// Block identifiers (oscr/blocks.py, docs/PLAN_BLOCK_IDS.md), their form only: `oscr:b:` + 13
// characters of Crockford's base32 + "-" + an ISO 7064 MOD 37,36 check character. No dependency:
// the reader's browser loads it (src/lib/reader.ts); the pages and the Worker use src/lib/block.ts.
export const PREFIX = "oscr:b:";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** An identifier in its one form (its check character verified apart: `normalize`). */
export const BLOCK_ID = /^oscr:b:[0-9A-HJKMNP-TV-Z]{13}-[0-9A-Z]$/;

/** ISO 7064 MOD 37,36 (hybrid system) over the body's characters, read in base 36. */
export function checkChar(body: string): string {
  const m = 36;
  let p = m;
  for (const c of body) {
    const s = (p + BASE36.indexOf(c)) % m || m;
    p = (s * 2) % (m + 1);
  }
  return BASE36[(m + 1 - p) % m];
}

/** An identifier as a person wrote it (lower case, an O for a zero, an I or an L for a one) → its one
 *  form, or "" when it is not one (a wrong check character included). */
export function normalize(text: string): string {
  let t = String(text ?? "").trim();
  if (t.toLowerCase().startsWith(PREFIX)) t = t.slice(PREFIX.length);
  const [rawBody, check, ...rest] = t.toUpperCase().split("-");
  if (rest.length || check === undefined || check.length !== 1 || !/^[0-9A-Z]$/.test(check)) return "";
  const body = rawBody.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (body.length !== 13 || [...body].some((c) => !ALPHABET.includes(c))) return "";
  return checkChar(body) === check ? `${PREFIX}${body}-${check}` : "";
}

/** The site's address of a block. */
export const blockPath = (id: string) => `/b/${id}`;

