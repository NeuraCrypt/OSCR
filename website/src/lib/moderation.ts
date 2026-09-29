// The words and addresses of the content rules (night phase 16) for the pages: what can be reported,
// why, and where the report form is. The Worker's own module (moderation-core.ts) is the source: its
// words are the ones the answers use.

export {
  KIND_WORDS,
  LIMIT_DURATIONS,
  LIMIT_WORDS,
  REASON_WORDS,
  REPORT_REASONS,
  RIGHT_WORDS,
  RIGHTS,
  readTarget,
  type ReportKind,
  type ReportReason,
} from "../../worker/forge/service/moderation-core.ts";

/** The report form for one thing: /report/?target=…&label=… (the label the page shows). */
export function reportHref(target: string, label = ""): string {
  const q = new URLSearchParams({ target });
  if (label) q.set("label", label.slice(0, 200));
  return `/report/?${q}`;
}

/** What each reason means, in one sentence, for the form (the acceptable-use policy's words). */
export const REASON_HELP: Readonly<Record<string, string>> = {
  spam: "Advertising, links for their own sake, repeated or automated posts.",
  abuse: "Harassment, threats, insults, hate aimed at a person or a group.",
  private_information: "Someone's address, telephone, health or other private details, published without their consent.",
  malware: "A file or code that harms the computers that run it.",
  copyright: "Your own work copied without the licence allowing it. Say which work, and where it is.",
  impersonation: "Someone pretending to be a researcher, a lab or an organisation they are not.",
  misinformation: "Content made to deceive: fabricated results, fake citations, false claims about a paper.",
  unlawful: "Content that is illegal to publish.",
  other: "Anything else that breaks the rules: say what in your words.",
};
