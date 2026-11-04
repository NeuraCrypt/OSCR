// No email address on the site (CLAUDE.md): the helpers the build's copy step (scripts/data.mjs)
// and the checks (scripts/check.mjs, scripts/check-emails.mjs) share. Pure.
import { maskEmails } from "../../worker/forge/mask.ts";

/** What the checks refuse in a built file: anything shaped like an email address. */
export const EMAIL_ON_PAGE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;

/** A built file's text as the check reads it: the Code ↔ Paper reader's lines are the authors' own
 *  code, masked by the export, and are left out. */
export const checkedText = (text: string): string => text.replace(/<ol class="lines[^"]*" id="lines"[^>]*>[\s\S]*?<\/ol>/, "");

/** Every string of a JSON value, its email addresses masked (keys kept). */
export function maskAll<T>(v: T): T {
  if (typeof v === "string") return maskEmails(v) as T;
  if (Array.isArray(v)) return v.map(maskAll) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskAll(x)])) as T;
  return v;
}

const SSH = /^(?:[a-z][a-z0-9+.-]*:\/\/)?git@([a-z0-9-]+(?:\.[a-z0-9-]+)+)[:/]\/?(.+)$/i;

/** A code link as the site may show it: GitHub's SSH form made https, its key recomputed; null for an
 *  address with a user part (an email address or "mailto:" read as a link), which is no repository's. */
export function codeLink<T extends { url?: string; repo?: string; host?: string }>(link: T): T | null {
  const url = String(link.url ?? "");
  const ssh = SSH.exec(url);
  if (ssh) {
    const host = ssh[1].toLowerCase();
    const path = ssh[2].replace(/\.git$/i, "").replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    const repo = parts.length >= 2 ? `${host}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}` : link.repo;
    return { ...link, url: `https://${host}/${path}`, repo, host };
  }
  if (/^mailto:/i.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
  } catch {
    return link;
  }
  return link;
}
