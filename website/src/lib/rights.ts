// Data rights (2026-09-29; the page /data-rights/, docs/CONTRIBUTIONS.md "Data rights"): the rights a
// signed-in person asks of the registry under the EU's General Data Protection Regulation, what the
// registry's machine does with each (oscr/rights.py), and when. Shared by the page's script
// (src/scripts/data-rights.ts), which checks a request and says what will happen before it is sent,
// and the Worker (worker/rights/index.ts), which checks it again before it records it: the same rules
// and the same words on both sides. Nothing here names the platform: "the registry".
import { oneMonthAfter, POLL_MINUTES } from "./moderation.ts";
import { addressIn } from "./removal.ts";

/** The rights, in the order the page offers them: the stored value, its label, its article of the GDPR. */
export const KINDS = [
  ["access", "Access: what the registry holds about me", "15"],
  ["erasure", "Erasure of my contact details", "17"],
  ["objection", "Objection: stop collecting my contact details", "21"],
  ["rectification", "Rectification: correct my contact details", "16"],
  ["account", "Deletion of my account", "17"],
] as const;
export type Kind = (typeof KINDS)[number][0];

/** A right in a few words, as the lists and the operator's messages name it. */
export const KIND_WORDS: Readonly<Record<string, string>> = {
  access: "access to your data",
  erasure: "erasure of your contact details",
  objection: "objection to the keeping of your contact details",
  rectification: "rectification of your contact details",
  account: "deletion of your account",
};

/** The person's words: optional, but a rectification says what to correct. */
export const DETAILS_MAX = 1000;
export const RECTIFICATION_MIN = 10;
/** Requests one account may send in 24 hours (counted from its rows: no write of their own). */
export const RIGHTS_PER_DAY = 5;

/** What the Worker knows of the person when they ask: their ORCID iD, and which ORCID proved it. */
export type Asker = { orcid: string; proof: "" | "orcid" | "orcid-sandbox" };

const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The legal deadline of a request made at `t` (Unix seconds): one month (GDPR art. 12(3)). */
export const dueAt = (t: number) => oneMonthAfter(t);

/** Whether the registry's machine answers this right by itself, for this person. */
export function automatic(kind: string, who: Asker): boolean {
  if (kind === "account") return true;
  if (kind === "access") return true; // the account's part at least; the contact details need an iD
  if (kind === "erasure" || kind === "objection") return who.orcid !== "";
  return false;
}

/** What will happen to a request, and when, in words, before it is sent and on its receipt. */
export function expectedWords(kind: string, who: Asker, createdAt: number): string {
  const soon = `within about ${POLL_MINUTES} minutes, when the registry's machine next reads the requests`;
  const due = `by ${day(dueAt(createdAt))} at the latest (one month, as the GDPR requires)`;
  const operator = `The operator answers it on this page ${due}. There is no human moderator on duty at the moment, but a request about your data is never closed unanswered.`;
  switch (kind) {
    case "access":
      if (!who.orcid) {
        return `What the registry holds about your account is shown here ${soon}. Your account has no ORCID iD, so the registry cannot tell by itself which authors' contact details are yours (a name, a GitHub login or a Google account proves nothing): ${operator} Faster: link your ORCID iD from your account page first.`;
      }
      if (who.proof !== "orcid") {
        return `What the registry holds about your account, and the papers that list your ORCID iD, are shown here ${soon}. You signed in with ORCID's sandbox, whose iDs are tests: the registry shows no contact detail to them.`;
      }
      return `The answer comes to this page ${soon}: what the registry holds about your account, the papers that list your ORCID iD, and each contact detail it keeps under that iD, field by field, your email address masked (the site never shows or stores one): the paper it was read in prints it in full.`;
    case "erasure":
    case "objection":
      if (!who.orcid) {
        return `Your account has no ORCID iD, so the registry cannot tell by itself which contact details are yours. ${operator} Faster: link your ORCID iD from your account page, then ask again: the erasure is then automatic.`;
      }
      return `${soon[0].toUpperCase()}${soon.slice(1)}, the contact details kept under your ORCID iD are erased, and your iD goes on the list of people whose contact details the registry never collects again (with a fingerprint of each address found with it, never the address). The private copy on Hugging Face loses them at the next nightly publication, which rewrites its history. Erasure and objection have the same effect here.`;
    case "rectification":
      return `The operator corrects what you say, and answers on this page ${due}. There is no human moderator on duty at the moment, but this request is never closed unanswered.`;
    case "account":
      return `${soon[0].toUpperCase()}${soon.slice(1)}, your account is deleted with its sessions (you are signed out everywhere), its linked identities, its roles, its claims and every request it made, this one included: nothing of it can be shown afterwards. What your requests changed in the public records stays; the registry's privacy page says what else is kept, and why.`;
    default:
      return operator;
  }
}

// ---------------------------------------------------------------------------------------------
// A request, checked.

export type RightsRequest = { kind: Kind; details: string };
export type Refusal = { status: number; code: string; message: string; field: string };
export type Checked = { ok: true; request: RightsRequest } | ({ ok: false } & Refusal);

const refuse = (code: string, message: string, field: string, status = 400): Checked => ({ ok: false, status, code, message, field });
const isKind = (v: unknown): v is Kind => typeof v === "string" && KINDS.some(([k]) => k === v);

/** The words' length as it is counted: spaces collapsed. */
export const detailsLength = (text: string) => Array.from(text.trim().replace(/\s+/g, " ")).length;

/** A request as the form sends it: one right, the person's words (no email address: the registry never
 *  keeps one), and the confirmation. */
export function checkRights(body: Record<string, unknown>): Checked {
  const kind = body.kind;
  if (!isKind(kind)) return refuse("bad_kind", "Choose the right you ask for.", "kind");
  const details = typeof body.details === "string" ? body.details.trim() : "";
  const address = addressIn(details);
  if (address || /[@＠]/.test(details)) {
    return refuse(
      "email_in_text",
      `Your text contains ${address ? `an email address (${address})` : "an at sign (@)"}: remove it. The registry never keeps an email address; its answer comes to this page.`,
      "details",
    );
  }
  const n = detailsLength(details);
  if (n > DETAILS_MAX) return refuse("long_details", `Keep your text to ${DETAILS_MAX} characters (${n} now).`, "details");
  if (kind === "rectification" && n < RECTIFICATION_MIN) {
    return refuse("short_details", "Say what to correct, and how: the operator corrects what you write.", "details");
  }
  if (body.confirm !== true) return refuse("not_confirmed", "Confirm that this request is yours and that you read what it does.", "confirm");
  return { ok: true, request: { kind, details } };
}
