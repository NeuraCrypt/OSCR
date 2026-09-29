// The automatic moderator, as the site tells it (decided 2026-09-29; the public page
// /policies/moderation/). No human moderator is on duty: the registry's machine decides with
// published rules (oscr/moderation.py), in the safe direction, and nothing waits forever. This module
// holds the base rules for a removal request — the same as the machine's, both test suites reading
// tests/fixtures/moderation_rules.json — so that the page and the Worker tell the requester what will
// happen. The machine adds guards the page cannot see (a limit of hides a day, a justification sent
// many times, the operator's earlier no): then a request waits for the operator instead.
//
// Nothing here names the platform: "the registry".

/** How long a request may wait for the operator before the rules close it (moderation.REVIEW_DAYS). */
export const REVIEW_DAYS = 30;
/** Automatic hides of copies at the word of someone the registry cannot verify (moderation.py). */
export const HIDE_PER_ACCOUNT = 3;
export const HIDE_PER_DAY = 30;
export const CAMPAIGN = 3;
export const CAMPAIGN_DAYS = 7;
/** How often the registry's machine reads the requests (tools/org.oscr.jobs.plist). */
export const POLL_MINUTES = 10;

/** What a removal request may name besides the whole record and the map: copies of the authors' code. */
export const NARROW: ReadonlySet<string> = new Set(["scripts", "repository", "file"]);
/** The reasons for which copies are hidden at once, on anyone's word. */
export const HARM: ReadonlySet<string> = new Set(["copyright", "personal_data"]);

export type Outcome = "apply" | "hide" | "review";
export type Path = { rule: string; outcome: Outcome };

/** What the rules do with a removal request (moderation.report_path): a verified author's is applied,
 *  a maintainer's of their own code's copies too; copies are hidden at once for copyright or personal
 *  data; the rest waits for the operator. */
export function reportPath(scope: string, reason: string, authorVerified: boolean, maintainer: boolean): Path {
  if (authorVerified) return { rule: "report.verified_author", outcome: "apply" };
  if (maintainer && NARROW.has(scope)) return { rule: "report.maintainer", outcome: "apply" };
  if (NARROW.has(scope) && HARM.has(reason)) return { rule: "report.hide_at_once", outcome: "hide" };
  return { rule: "report.review", outcome: "review" };
}

/** The day the rules close a request that waits, from its time (Unix seconds or an ISO date). */
export function reviewDeadline(createdAt: number | string): Date {
  const t = typeof createdAt === "number" ? createdAt * 1000 : Date.parse(createdAt);
  return new Date((Number.isFinite(t) ? t : Date.now()) + REVIEW_DAYS * 86_400_000);
}

const dayWords = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** What will happen to a removal request, in words, for the person who sent it. */
export function expectedWords(path: Path, createdAt: number | string): string {
  switch (path.outcome) {
    case "apply":
      return `The registry's rules apply it without waiting, as a request from ${path.rule === "report.verified_author" ? "a verified author of the paper" : "a maintainer of its code"}: within about ${POLL_MINUTES} minutes it is accepted, and what it names leaves the site at the next nightly publication.`;
    case "hide":
      return `The registry's rules hide copies of the authors' code at once for copyright or personal data: within about ${POLL_MINUTES} minutes it is accepted, and what it names leaves the site at the next nightly publication, then waits for the operator's review, who may restore it. (Past ${HIDE_PER_ACCOUNT} such requests from one account in a day, or when the same justification comes with many requests, it waits for the operator instead.)`;
    default:
      return `No rule can decide it alone: it waits for the operator's review, and nothing is removed meanwhile. There is no human moderator on duty at the moment: if no one decides it by ${dayWords(reviewDeadline(createdAt))}, it is closed without removal, and you may ask again in a way the rules decide.`;
  }
}

/** A request once decided may be asked again when the rules would decide the new one at once. */
export const mayAskAgain = (path: Path) => path.outcome !== "review";

/** Why a decided request cannot be asked again as it is, and how it can. */
export const ASK_AGAIN =
  "Your request about this record has been decided. It can be asked again as a verified author of the paper (signed in with the ORCID iD it lists), as a maintainer of its code (checked on GitHub), or for the copies of its code only, for copyright or personal data.";
