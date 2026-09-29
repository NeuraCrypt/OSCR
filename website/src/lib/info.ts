// The information pages (2026-09-29, the launch): About, Help, Policies, Privacy, Brand, Labs,
// Taxonomy — on the model of arXiv's info site, in the site's own words. Their menus, the footer's
// links, and the sitemap's fixed pages come from here. A fixed number of files: one per page below.
//
// Two policies are written with the Code ↔ Paper reader, on another branch: /policies/code/ (why a
// script is shown from the registry's copy or from its source) and /policies/moderation/ (how
// requests are decided). The pages link to them once they exist in src/pages (`pageExists`), and
// name them without a link until then, so that no build ever holds a broken link.

export type InfoLink = { href: string; text: string; summary: string };

/** The source files of every page of the site, known at build time. */
const PAGES = Object.keys(import.meta.glob("../pages/**/*.{astro,md,mdx,ts}"));

/** Whether a page of the site exists: "/policies/code/" is src/pages/policies/code.astro, or
 *  code/index.astro (or .md, .mdx). */
export function pageExists(href: string): boolean {
  const path = href.replace(/^\/|\/$/g, "");
  return PAGES.some((f) => {
    const p = f.replace(/^\.\.\/pages\//, "").replace(/\.(astro|md|mdx|ts)$/, "");
    return p === path || p === `${path}/index` || (path === "" && p === "index");
  });
}

export const ABOUT: InfoLink[] = [
  { href: "/about/", text: "About", summary: "The mission, how the registry works step by step, why it is built this way, who runs it, and its history." },
  { href: "/taxonomy/", text: "Taxonomy", summary: "What the registry covers: its scope, and the categories it classifies papers by, with their definitions and counts." },
  { href: "/brand/", text: "Brand", summary: "The name, the logo files, their colours and rules, the badge, and how to cite and link." },
  { href: "/labs/", text: "Labs", summary: "The open datasets and how to query them, the tracing maps' format, and what is in development." },
];

export const HELP: InfoLink[] = [
  { href: "/help/search/", text: "Searching and the DOI lookup", summary: "The search form, its fields and filters, the query language, exports, the daily quota; and the DOI lookup." },
  { href: "/help/paper/", text: "Reading a paper's page", summary: "Its sections, the statuses and verdicts in words, the levels of evidence, and what an older paper's page leaves out." },
  { href: "/help/reader/", text: "The Code ↔ Paper reader", summary: "The paper and its authors' code side by side: matches, colours, weak matches, hiding the paper, the file tools." },
  { href: "/help/maps/", text: "Tracing maps", summary: "What a map holds, how it is proposed, and what changes once an author validates it." },
  { href: "/help/accounts/", text: "Signing in and your account", summary: "ORCID, GitHub or Google, no email address; roles; sessions; the account page and its notifications." },
  { href: "/help/submit/", text: "Submitting a paper", summary: "A DOI and its code links: the checks, the draft, and publication." },
  { href: "/help/correct/", text: "Correcting a record's links", summary: "Adding, removing or re-labelling a paper's code and data links, as a verified author or a maintainer." },
  { href: "/help/claim/", text: "Claiming authorship", summary: "When your ORCID iD is on the paper, and when it is not." },
  { href: "/help/validate/", text: "Validating a map and its DOI", summary: "What a validation checks, the deposit on Zenodo, and what the DOI covers." },
  { href: "/help/badge/", text: "The badge", summary: "One image for every paper, its snippets, and how to add it to your README." },
  { href: "/help/removal/", text: "Requesting a removal", summary: "What can be removed, who may ask, how the rules decide a request, and when a decision takes effect." },
  { href: "/help/data/", text: "Accessing the data", summary: "The datasets on Hugging Face, their licences, and what stays private." },
  { href: "/help/faq/", text: "Frequently asked questions", summary: "Short answers to the questions readers and authors ask most." },
];

export const POLICIES: InfoLink[] = [
  { href: "/policies/licences/", text: "Licences and availability statements", summary: "What the registry shows of a paper's abstract and statements, and under which licences." },
  { href: "/policies/code/", text: "The authors' code", summary: "Which scripts the registry copies, which it shows from their source without a copy, and how each file is checked." },
  { href: "/policies/full-text/", text: "The paper's full text", summary: "Never stored, never served: the reader's browser fetches it from Europe PMC or PubMed Central." },
  { href: "/policies/removal/", text: "Removal and takedown", summary: "Who may ask, what can be removed, how requests are decided, and what a removal does." },
  { href: "/policies/moderation/", text: "Moderation", summary: "The published rules that decide removal requests, submissions and claims, what waits for the operator, and how to appeal." },
  { href: "/policies/doi/", text: "DOIs for tracing maps", summary: "Zenodo DOIs for maps validated by an author only: what the DOI covers, its relations, its creators." },
  { href: "/privacy/", text: "Privacy", summary: "Every personal datum the registry holds, why, where, for how long, and your rights." },
  { href: "/policies/terms/", text: "Terms of use", summary: "Using the site, the data and the maps; accounts; what the registry promises and what it does not." },
  { href: "/policies/conduct/", text: "Code of conduct", summary: "How to behave in the registry's forms and project spaces, and how conduct is enforced." },
  { href: "/policies/accessibility/", text: "Accessibility", summary: "What the site does for accessibility, its known limits, and how to report a barrier." },
  { href: "/policies/citation/", text: "Citation", summary: "How to cite the registry, a paper's record, a tracing map and the datasets." },
];

/** The footer of every page, arXiv's way: the information pages, the limits, the source. */
export const FOOTER: { href: string; text: string }[] = [
  { href: "/about/", text: "About" },
  { href: "/help/", text: "Help" },
  { href: "/policies/", text: "Policies" },
  { href: "/privacy/", text: "Privacy" },
  { href: "/brand/", text: "Brand" },
  { href: "/labs/", text: "Labs" },
  { href: "/taxonomy/", text: "Taxonomy" },
  { href: "/about/#limits", text: "Limits" },
];
