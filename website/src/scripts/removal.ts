// The page /removal/?paper=…, in the reader's browser (src/pages/removal.astro): the paper's facts,
// read from the site's own files (its record, or the top of its static page: src/lib/removal.ts,
// no Worker request); who is signed in and what they asked about this paper (GET
// /api/contributions/paper, only when the browser holds a session: the `__Host-oscr_signed_in` hint
// cookie); then the request in three steps — the form, checked here with the Worker's own rules; its
// review, where nothing has been sent yet; "Confirm and send" (POST /api/reports, with the session's
// CSRF token), and the receipt: what the registry's rules will do with it (src/lib/moderation.ts).
// Revisited, the page shows the request's state and the decision's
// words. Everything is written as text nodes, never as HTML. Like every browser script, it never
// names the platform: "the registry".
import {
  checkRequest, DETAILS_MAX, DETAILS_MIN, detailsLength, loadFacts, NIGHTLY, paperOf, REASONS, REASON_WORDS, removalUrl, ROLE_WORDS,
  SCOPE_WORDS, type PaperFacts,
} from "../lib/removal";
import { lookupShard } from "../lib/shards";

type Report = {
  id: number;
  paper_id: string;
  url: string;
  removal_url: string;
  role: string;
  author_verified: boolean;
  scope: string;
  repo: string;
  path: string;
  reason: string;
  details: string;
  evidence_url: string;
  confirmed: boolean;
  status: string;
  message: string;
  created_at: string | null;
  updated_at: string | null;
  decided_at: string | null;
  /** While it is open: what the moderator's rules will do with it, in words (worker's reportJson). */
  expected?: { rule: string; outcome: string; words: string; deadline: string | null } | null;
};
type State = {
  signed_in: boolean;
  available?: boolean;
  user?: { display_name: string; orcid: string | null; github: string | null };
  author?: boolean;
  report?: Report | null;
  csrf?: string;
  error?: { code: string; message: string };
};
type Part = string | Node | { href: string; text: string };
type Body = Record<string, unknown>;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const show = (id: string, on: boolean) => byId(id)?.toggleAttribute("hidden", !on);

function write(el: HTMLElement | null, tone: "" | "ok" | "warning" | "muted" | "summary", ...parts: Part[]) {
  if (!el) return;
  if (tone) el.className = tone;
  else el.removeAttribute("class");
  el.replaceChildren(...parts.map(node));
}

function node(p: Part): Node {
  if (typeof p === "string") return document.createTextNode(p);
  if (p instanceof Node) return p;
  // Only this site's pages and web addresses become links; anything else stays text.
  if (!/^(\/(?!\/)|https?:\/\/)/i.test(p.href)) return document.createTextNode(p.text);
  const a = document.createElement("a");
  a.href = p.href;
  a.textContent = p.text;
  return a;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...parts: Part[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...parts.map(node));
  return e;
}

const message = byId("removal-message");
const target = paperOf(new URLSearchParams(location.search).get("paper"));
let facts: PaperFacts | null = null;
let state: State = { signed_in: false };
let csrf = "";
/** The request as reviewed: what "Confirm and send" sends, and nothing else. */
let reviewed: Body | null = null;

const day = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const reasonLabel = (v: string) => REASONS.find(([x]) => x === v)?.[1] ?? REASON_WORDS[v] ?? v;
const number = (n: number) => n.toLocaleString("en-GB");

// ---------------------------------------------------------------------------------------------
// Arrival: where a sign-in started here came back with (?signed_in=…, ?error=…), said once.

function sayArrival() {
  const q = new URLSearchParams(location.search);
  const names: Record<string, string> = { orcid: "ORCID", github: "GitHub", google: "Google" };
  const who = names[q.get("signed_in") ?? q.get("provider") ?? ""] ?? "the provider";
  if (q.has("signed_in")) write(message, "ok", `You are signed in with ${who}.`);
  else if (q.get("error") === "denied") write(message, "warning", `You declined the sign-in at ${who}: nothing was changed.`);
  else if (q.get("error") === "unavailable_provider") write(message, "warning", `Signing in with ${who} is not set up yet.`);
  else if (q.has("error")) write(message, "warning", "The sign-in did not complete. Please try again.");
  if (q.has("signed_in") || q.has("error")) history.replaceState(null, "", target ? removalUrl(target.id) : location.pathname);
}

// ---------------------------------------------------------------------------------------------
// The paper, and who reads the page.

/** Why the paper has no facts, when the DOI lookup says it (read, but without a page). */
let missing = "";

/** The paper's facts. A DOI is looked up first (/lookup/NN.json, a static file): a paper the
 *  registry read without giving it a page, or never read, is said so without asking for a page
 *  that is not there (which the Worker would answer). undefined: the site could not be reached. */
async function readFacts(): Promise<PaperFacts | null | undefined> {
  if (!target) return null;
  const get = (path: string) => fetch(path, { headers: { Accept: "application/json, text/html" } });
  try {
    let slug = target.slug;
    if (target.doi) {
      const res = await get(`/lookup/${await lookupShard(target.doi)}.json`);
      if (!res.ok && res.status !== 404) return undefined;
      const entry = res.ok ? ((await res.json()) as Record<string, string[]>)[target.doi] : undefined;
      if (!entry || !entry[2]) {
        if (entry) missing = `The registry read this paper${entry[1] ? ` on ${entry[1]}` : ""}, but it has no page: there is nothing of it to remove.`;
        return null;
      }
      slug = entry[2];
    }
    const f = await loadFacts(get, slug, "record-first");
    return f && f.id === target.id ? f : null;
  } catch {
    return undefined;
  }
}

async function readState(): Promise<State> {
  if (!target || !document.cookie.split(/;\s*/).includes("__Host-oscr_signed_in=1")) return { signed_in: false };
  try {
    const res = await fetch(`/api/contributions/paper?id=${encodeURIComponent(target.id)}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    return (await res.json()) as State;
  } catch {
    return { signed_in: false, error: { code: "unreachable", message: "The registry could not be reached: check the connection, then reload the page." } };
  }
}

function renderFacts(f: PaperFacts) {
  const out = byId("removal-facts");
  if (!out) return;
  const lines: HTMLElement[] = [element("p", "title", f.title || f.id)];
  const line = (label: string, ...parts: Part[]) => {
    const div = element("div", "line", ...parts);
    div.prepend(element("span", "label", `${label}:`), " ");
    lines.push(div);
  };
  if (f.doi) line("DOI", { href: `https://doi.org/${f.doi}`, text: f.doi });
  else line("Identifier", f.id);
  if (f.authors.length) line(f.authors.length + f.authors_more === 1 ? "Author" : "Authors", f.authors.join(", ") + (f.authors_more ? `, and ${number(f.authors_more)} others` : ""));
  if (f.repos.length) {
    const parts: Part[] = [];
    f.repos.forEach((r, i) => {
      if (i) parts.push("; ");
      parts.push(r.url ? { href: r.url, text: r.name } : r.name);
      const n = r.files.length + r.more;
      parts.push(` (${number(n)} ${n === 1 ? "file" : "files"}, ${r.copies ? "copies kept here" : "not copied here: read at the source"})`);
    });
    line("Authors' code", ...parts);
  } else line("Authors' code", "none in the registry");
  line("Its page", { href: `/paper/${f.slug}/`, text: `/paper/${f.slug}/` });
  out.replaceChildren(...lines);
}

function renderMissing(unreadable: boolean) {
  const out = byId("removal-facts");
  if (!target) {
    write(out, "", "Name the paper: its DOI below, or open this page from the paper's own page (“Request removal”, in its sidebar).");
  } else if (unreadable) {
    write(out, "warning", "The record could not be read: check the connection, then reload the page.");
    return;
  } else {
    const words = missing || "The registry has no page for this paper: there is nothing of it to remove.";
    write(out, "warning", words, " ", { href: "/lookup/", text: "The DOI lookup" }, " finds any paper the registry has read.");
  }
  show("removal-find", true);
}

// ---------------------------------------------------------------------------------------------
// A request, in words: the review, the receipt and the state share one list.

type Shown = { role: string; author_verified: boolean; scope: string; repo: string; path: string; reason: string; details: string; evidence_url: string; confirmed: boolean };

type Row = [string, Part[], string?];
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** A request's list: `lead` rows (its number, its status) first, then what it asks. */
function summary(dl: HTMLElement | null, r: Shown, lead: Row[] = []) {
  if (!dl) return;
  const items: Row[] = [...lead];
  const paper: Part[] = facts ? [{ href: `/paper/${facts.slug}/`, text: facts.title || facts.id }, facts.doi ? ` (doi:${facts.doi})` : ""] : [target?.id ?? ""];
  items.push(["Paper", paper]);
  items.push(["You are", [capital(ROLE_WORDS[r.role] ?? r.role), r.role === "author" ? (r.author_verified ? " (verified: your ORCID iD is among its authors)" : " (not verified: your ORCID iD is not among its authors)") : ""]]);
  items.push(["To remove", [capital(SCOPE_WORDS[r.scope] ?? r.scope), r.scope === "repository" ? `: ${r.repo}` : r.scope === "file" ? `: ${r.path}, in ${r.repo}` : ""]]);
  items.push(["Why", [reasonLabel(r.reason)]]);
  items.push(["Justification", [r.details || "—"], "text"]);
  items.push(["Evidence", [r.evidence_url ? { href: r.evidence_url, text: r.evidence_url } : "none"]]);
  items.push(["Confirmations", [r.confirmed ? "The information is accurate; you read how requests are decided." : "not given (a request made before this page)"]]);
  dl.replaceChildren(...items.flatMap(([label, parts, cls]) => [element("dt", "", label), element("dd", cls ?? "", ...parts)]));
}

const shownOf = (b: Body): Shown => ({
  role: String(b.role ?? ""),
  author_verified: b.role === "author" && !!state.author,
  scope: String(b.scope ?? "record"),
  repo: String(b.repo ?? ""),
  path: String(b.path ?? ""),
  reason: String(b.reason ?? ""),
  details: String(b.details ?? "").trim(),
  evidence_url: String(b.evidence_url ?? "").trim(),
  confirmed: b.confirm_accurate === true && b.confirm_review === true,
});

/** What leaves the site when a request is accepted, in words. */
function removed(r: Pick<Report, "scope" | "repo" | "path">): string {
  if (r.scope === "repository") return `the copies of ${r.repo}`;
  if (r.scope === "file") return `the copy of ${r.path}`;
  if (r.scope === "record") return "the record";
  return SCOPE_WORDS[r.scope] ?? "what it names";
}

/** A request's number, dates, status, what the rules will do, the decision's words, and when it takes effect. */
function statusRows(r: Report): Row[] {
  const word = (tone: "ok" | "warning", text: string) => element("span", tone, text);
  const rows: Row[] = [["Request", [`No. ${r.id}`]]];
  rows.push(["Sent", [`${day(r.created_at)}${r.updated_at ? `; completed on ${day(r.updated_at)}` : ""}`]]);
  const nightly = `the nightly publication (${NIGHTLY}, the registry's local time)`;
  if (r.status === "open") {
    rows.push(["Status", [word("warning", "Open"), r.expected?.outcome === "review" ? ": it waits for the operator" : ": the registry's rules decide it within minutes"]]);
    if (r.expected) rows.push(["What happens", [r.expected.words]]);
    rows.push(["Takes effect", [`Once accepted: at ${nightly} that follows, ${removed(r)} leaves the site.`]]);
  } else if (r.status === "accepted") {
    rows.push(["Status", [word("ok", "Accepted"), ` on ${day(r.decided_at)}`]]);
    if (r.message) rows.push(["The decision's words", [`“${r.message}”`], "text"]);
    rows.push(["Takes effect", [r.scope === "record" && !facts ? "Done: the record has left the site." : `At ${nightly} that follows the decision: ${removed(r)} leaves the site.`]]);
  } else {
    rows.push(["Status", [word("warning", "Refused"), ` on ${day(r.decided_at)}`]]);
    if (r.message) rows.push(["The decision's words", [`“${r.message}”`], "text"]);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Steps.

type Step = "form" | "review" | "receipt" | "state";
function step(which: Step, focus = true) {
  show("removal-form", which === "form");
  show("removal-review", which === "review");
  show("removal-receipt", which === "receipt");
  if (which === "state") show("removal-request", true);
  const heading = { form: null, review: "removal-review-title", receipt: "removal-receipt-title", state: "removal-request-title" }[which];
  if (focus && heading) {
    const h = byId(heading);
    h?.focus();
    h?.scrollIntoView({ block: "start" });
  }
}

/** The reader's request about this paper, as it stands. */
function renderRequest(r: Report) {
  show("removal-request", true);
  write(byId("removal-request-title"), "", `Your request No. ${r.id}`);
  const out = byId("removal-request-state");
  const next = byId("removal-request-next");
  if (r.status === "open") {
    write(out, "warning", r.expected?.outcome === "review" ? "Your request waits for the operator." : "Your request is being decided by the registry's rules.");
    write(next, "", facts ? "You may complete it below: what you send replaces it, and it keeps its number." : "");
  } else if (r.status === "accepted") {
    write(out, "ok", "Your request was accepted.");
    write(next, "", "");
  } else {
    write(out, "warning", "Your request was refused.");
    write(next, "", "It can be asked again as a verified author of the paper, as a maintainer of its code, or for the copies of its code only, for copyright or personal data: the rules decide those at once.");
  }
  summary(byId("removal-request-summary"), r, statusRows(r));
}

// ---------------------------------------------------------------------------------------------
// The form.

const form = byId<HTMLFormElement>("removal-form");
const radios = (name: string) => [...(form?.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`) ?? [])];
const checked = (name: string) => radios(name).find((r) => r.checked)?.value ?? "";
const select = (id: string) => byId<HTMLSelectElement>(id);

function options(sel: HTMLSelectElement | null, list: [string, string][], selected = "") {
  if (!sel) return;
  sel.replaceChildren(
    ...list.map(([value, text]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      o.selected = value === selected;
      return o;
    }),
  );
}

function fillFiles(repo: string, selected = "") {
  const r = facts?.repos.find((x) => x.repo === repo);
  options(select("removal-file"), (r?.files ?? []).map((p) => [p, p]), selected);
  const more = byId("removal-file-more");
  if (r && r.more > 0) {
    write(more, "summary", `${number(r.more)} more ${r.more === 1 ? "file is" : "files are"} not listed: ask for the repository's copies, and name the file in your justification.`);
    show("removal-file-more", true);
  } else show("removal-file-more", false);
  if (r && r.files.length === 0) {
    write(more, "summary", "No file of this repository is listed: ask for its copies instead.");
    show("removal-file-more", true);
  }
}

function syncScope() {
  const scope = checked("scope");
  show("removal-repo-detail", scope === "repository");
  show("removal-file-detail", scope === "file");
  const note = byId("removal-scope-note");
  const noCopies = facts && facts.repos.length > 0 && facts.repos.every((r) => !r.copies);
  if (facts && facts.repos.length === 0) {
    write(note, "summary", "The registry holds no code of this paper, so no copy of a script and no tracing map: only its whole record can be removed.");
    show("removal-scope-note", true);
  } else if (noCopies && ["scripts", "repository", "file"].includes(scope)) {
    write(note, "summary", "The registry keeps no copy of this paper's code (its license does not allow it): the reader shows its files from their source, when their host allows it, and removing them stops that display.");
    show("removal-scope-note", true);
  } else show("removal-scope-note", false);
}

function syncReason() {
  show("removal-incorrect", checked("reason") === "incorrect");
}

function syncCount() {
  const text = byId<HTMLTextAreaElement>("removal-details")?.value ?? "";
  const n = detailsLength(text);
  const out = byId("removal-details-count");
  if (n === 0) return write(out, "muted", `${DETAILS_MIN} characters at least.`);
  if (n < DETAILS_MIN) return write(out, "muted", `${number(n)} characters: ${DETAILS_MIN - n} more at least.`);
  if (n > DETAILS_MAX) return write(out, "warning", `${number(n)} characters: ${number(n - DETAILS_MAX)} too many.`);
  write(out, "muted", `${number(n)} characters of ${number(DETAILS_MAX)} at most.`);
}

function prepareForm(f: PaperFacts, before: Report | null) {
  const repos = f.repos.map((r): [string, string] => [r.repo, r.repo]);
  options(select("removal-repo"), repos, before?.scope === "repository" ? before.repo : "");
  options(select("removal-file-repo"), repos, before?.scope === "file" ? before.repo : "");
  fillFiles(before?.scope === "file" ? before.repo : (f.repos[0]?.repo ?? ""), before?.scope === "file" ? before.path : "");
  for (const r of radios("scope")) {
    if (r.value !== "record") r.disabled = f.repos.length === 0;
  }
  const correct = byId<HTMLAnchorElement>("removal-correct");
  if (correct) correct.href = `/paper/${f.slug}/#contribute`;
  const note = byId("removal-author-note");
  if (state.author) write(note, "ok", "(verified: your ORCID iD is among this paper's authors)");
  else if (state.user?.orcid) write(note, "muted", "(not verified: your ORCID iD is not among this paper's authors in its metadata)");
  else write(note, "muted", "(not verified; ", { href: "/account/", text: "link your ORCID iD" }, " to be recognized at once)");
  if (before) {
    for (const [name, value] of [["role", before.role], ["scope", before.scope], ["reason", before.reason]] as const) {
      for (const r of radios(name)) r.checked = r.value === value;
    }
    const details = byId<HTMLTextAreaElement>("removal-details");
    if (details) details.value = before.details;
    const evidence = byId<HTMLInputElement>("removal-evidence");
    if (evidence) evidence.value = before.evidence_url;
    write(byId("removal-form-title"), "", `Complete your request No. ${before.id}`);
  }
  syncScope();
  syncReason();
  syncCount();
}

function collect(): Body {
  const scope = checked("scope");
  const value = (id: string) => (byId<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id)?.value ?? "");
  const box = (id: string) => byId<HTMLInputElement>(id)?.checked === true;
  return {
    paper_id: facts?.id ?? target?.id ?? "",
    role: checked("role"),
    scope,
    repo: scope === "repository" ? value("removal-repo") : scope === "file" ? value("removal-file-repo") : "",
    path: scope === "file" ? value("removal-file") : "",
    reason: checked("reason"),
    details: value("removal-details"),
    evidence_url: value("removal-evidence").trim(),
    confirm_accurate: box("removal-confirm-accurate"),
    confirm_review: box("removal-confirm-review"),
  };
}

/** Where a refused field is, to bring the reader to it. */
const FIELDS: Record<string, string> = {
  role: "removal-role",
  scope: "removal-scope",
  repo: "removal-repo",
  path: "removal-file",
  reason: "removal-reason",
  details: "removal-details",
  evidence_url: "removal-evidence",
  confirm: "removal-confirm",
};

function refuse(where: "form" | "review", text: string, field = "") {
  const out = byId(where === "form" ? "removal-form-error" : "removal-review-error");
  write(out, "warning", text);
  out?.removeAttribute("hidden");
  if (where === "form" && field) {
    const el = byId(field === "repo" && checked("scope") === "file" ? "removal-file-repo" : (FIELDS[field] ?? ""));
    el?.scrollIntoView({ block: "center" });
    (el?.matches("fieldset") ? el.querySelector<HTMLInputElement>("input:not([disabled])") : el)?.focus();
  }
}

/** A refusal said under the form goes once the reader changes what it was about. */
const clearError = () => byId("removal-form-error")?.setAttribute("hidden", "");
form?.addEventListener("input", clearError);
form?.addEventListener("change", (ev) => {
  clearError();
  const t = ev.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.name === "scope") syncScope();
  if (t instanceof HTMLInputElement && t.name === "reason") syncReason();
  if (t.id === "removal-file-repo") fillFiles((t as HTMLSelectElement).value);
});
byId("removal-details")?.addEventListener("input", syncCount);

form?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  byId("removal-form-error")?.setAttribute("hidden", "");
  if (!facts) return;
  const body = collect();
  const c = checkRequest(body, facts);
  if (!c.ok) return refuse("form", c.message, c.field);
  reviewed = body;
  summary(byId("removal-review-summary"), shownOf(body));
  byId("removal-review-error")?.setAttribute("hidden", "");
  step("review");
});

byId("removal-back")?.addEventListener("click", () => {
  step("form");
  form?.scrollIntoView({ block: "start" });
});

byId("removal-send")?.addEventListener("click", async (ev) => {
  const button = ev.currentTarget as HTMLButtonElement;
  if (!reviewed) return step("form");
  button.disabled = true;
  byId<HTMLButtonElement>("removal-back")!.disabled = true;
  let res: Response;
  try {
    res = await fetch("/api/reports", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(reviewed),
    });
  } catch {
    button.disabled = false;
    byId<HTMLButtonElement>("removal-back")!.disabled = false;
    return refuse("review", "The registry could not be reached: nothing was sent. Check the connection, then confirm again.");
  }
  const data = (await res.json().catch(() => ({}))) as { status?: string; updated?: boolean; reopened?: boolean; report?: Report; error?: { code: string; message: string; field?: string } };
  button.disabled = false;
  byId<HTMLButtonElement>("removal-back")!.disabled = false;
  if (!res.ok) {
    const text = data.error?.message ?? "Something went wrong: nothing was sent. Please try again.";
    if (data.error?.code === "already_decided" && data.report) {
      step("state");
      show("removal-review", false);
      renderRequest(data.report);
      return write(message, "warning", text);
    }
    if (data.error?.code === "signed_out") return refuse("review", "Your session has ended: nothing was sent. Sign in again from your account page, then come back here.");
    if (data.error?.field) {
      step("form");
      return refuse("form", text, data.error.field);
    }
    return refuse("review", `${text} Nothing was sent.`);
  }
  const r = data.report;
  reviewed = null;
  write(byId("removal-receipt-title"), "", data.updated ? "Request completed" : "Request received");
  write(
    byId("removal-receipt-state"),
    "ok",
    `${data.updated ? "Your request is completed, and keeps its number." : data.reopened ? "Your request is open again, and keeps its number." : "Your request is sent."} ${r?.expected?.words ?? ""}`.trim(),
  );
  if (r) summary(byId("removal-receipt-summary"), r, statusRows(r));
  write(
    byId("removal-receipt-next"),
    "",
    "Follow it on this page and on ",
    { href: "/account/#removals", text: "your account page" },
    ": the decision and its words show on both, and no email is sent. While it is open, you may complete it here.",
  );
  show("removal-request", false);
  step("receipt");
});

// ---------------------------------------------------------------------------------------------

function signInLinks(id: string) {
  for (const a of document.querySelectorAll<HTMLAnchorElement>("#removal-sign-in a[data-provider]")) {
    a.href = `/api/auth/${a.dataset.provider}/start?return=${encodeURIComponent(removalUrl(id))}`;
  }
}

async function main() {
  sayArrival();
  if (target) signInLinks(target.id);
  const [f, s] = await Promise.all([readFacts(), readState()]);
  facts = f ?? null;
  state = s;
  if (facts) renderFacts(facts);
  else renderMissing(f === undefined);
  if (s.error) write(message, "warning", s.error.message);
  if (!target) return;
  if (!s.signed_in) {
    // Sign in only where there is something to ask.
    show("removal-signed-out", !!facts && s.available !== false);
    if (facts && s.available === false) write(message, "warning", "Removal requests are not open yet: please come back later.");
    return;
  }
  csrf = s.csrf ?? "";
  show("removal-signed-in", true);
  const handles = [s.user?.orcid && `ORCID iD ${s.user.orcid}`, s.user?.github && `GitHub ${s.user.github}`].filter(Boolean).join(", ");
  write(byId("removal-who"), "", `Signed in as ${s.user?.display_name || "a member without a name"}${handles ? ` (${handles})` : ""}. `, { href: "/account/", text: "Your account" }, ".");
  const before = s.report ?? null;
  if (before) renderRequest(before);
  if (facts && (!before || before.status === "open")) {
    prepareForm(facts, before);
    step("form", false);
  }
}

void main();

export {};
