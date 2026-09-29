// Email addresses hidden in free text, as the Mac hides them (oscr/catalog.py, `mask_emails`):
// CLAUDE.md, "the website hides every email address, including those in the authors' code".
//
// GitBackend returns free texts raw (commit messages, bodies, file contents, patches, search
// fragments); every renderer passes them through `maskEmails` before showing them. Lines are
// kept as they are, so line numbers and the tracing maps' ranges still hold.
//
// The pattern is Python's `_EMAIL_IN_TEXT`:
//   (?<![\w.+%-])(?!git@)[\w.+%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b
// Python's `\w` and `\b` are Unicode-aware on text; JavaScript's are ASCII even with the `u` flag.
// So `\w` is written [\p{L}\p{N}_] here, and the final `\b` (which follows a letter) is written
// "not followed by a word character". The parity test reads one fixture,
// tests/fixtures/emails.json, from both sides (tests/forge/mask.test.ts, tests/test_forge.py).

export const EMAIL_MASK = "[email hidden]";

const EMAIL_IN_TEXT = /(?<![\p{L}\p{N}_.+%-])(?!git@)[\p{L}\p{N}_.+%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\p{L}\p{N}_])/gu;

/** The same text, every email address replaced by EMAIL_MASK. */
export function maskEmails(text: string): string {
  return typeof text === "string" && text.includes("@") ? text.replace(EMAIL_IN_TEXT, EMAIL_MASK) : text;
}

/** Email addresses hidden without moving anything (the web editor's visible layer, night phase 03):
 *  each character of an address but "@" and "." becomes "*", so every line keeps its columns under
 *  the text being edited. What remains is no address (its last part is no longer letters), so
 *  `maskEmails` leaves it as it is. */
export function maskEmailsInPlace(text: string): string {
  return typeof text === "string" && text.includes("@") ? text.replace(EMAIL_IN_TEXT, (m) => m.replace(/[^@.]/gu, "*")) : text;
}
