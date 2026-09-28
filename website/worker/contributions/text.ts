// The free texts of the forms (a claim's statement, a note, a removal request's details): plain
// text only, never rendered as markup (the pages write them as text nodes), and never an email
// address: one typed in is removed before anything is stored, and so is any at sign (the schema
// refuses one, as it does in a name).

/** An email address, also written with spaces or brackets around the at sign ("name [at] lab.org"). */
const ADDRESS = /[^\s@<>()[\]{},;:]+\s*(?:[@＠]|[[({]\s*at\s*[\])}])\s*[^\s@<>()[\]{},;:.]+(?:\s*(?:\.|[[({]\s*dot\s*[\])}])\s*[^\s@<>()[\]{},;:.]+)+/gi;
/** Control characters but the line feed, and the characters that reorder or hide text. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** `value` as the registry may keep it: at most `max` characters, no address, no at sign, no
 *  control character, single spaces, at most one blank line in a row. "" when it is not a string. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .slice(0, max * 4)
    .replace(/\r\n?/g, "\n")
    .replace(ADDRESS, " ")
    .replace(/[@＠]/g, " ")
    .replace(CONTROL, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return Array.from(text).slice(0, max).join("").trim();
}

/** A web address given as evidence (a lab page, a profile): http or https, no credentials, at most
 *  300 characters; "" otherwise. Never fetched by the Worker: the owner opens it. */
export function cleanUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const t = value.trim();
  if (!t || t.length > 300 || /\s/.test(t)) return "";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return "";
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.href.includes("@")) return "";
  return u.href;
}
