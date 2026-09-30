// The page /data-rights/, in the reader's browser (src/pages/data-rights.astro): what the site's
// database holds about the signed-in account (GET /api/rights, only when the browser holds a session:
// the `__Host-oscr_signed_in` hint cookie), the account's requests with their answers, and a new
// request (one right, the person's words, one confirmation) checked here with the Worker's own rules
// (src/lib/rights.ts), then sent (POST /api/rights, with the session's CSRF token), then its receipt:
// what happens, and by when. Everything is written as text nodes, never as HTML. Like every browser
// script, it never names the platform: "the registry".
import { slugOf } from "../lib/removal";
import { checkRights, DETAILS_MAX, detailsLength, expectedWords, KIND_WORDS, RECTIFICATION_MIN, type Asker } from "../lib/rights";

type Answer = {
  version?: number;
  matched?: "orcid" | "sandbox" | "none";
  orcid?: string;
  contacts?: {
    rows: number;
    papers: number;
    emails?: number;
    more?: number;
    suppressed?: boolean;
    listed?: {
      paper: { id: string; doi: string; title: string };
      position: number;
      tied_by: string;
      source: string;
      found: string;
      fields: Record<string, string | boolean>;
    }[];
  };
  authorship?: { papers: number; listed?: { id: string; doi: string; title: string }[]; more?: number };
  operator?: { log: { entries: number; first: string; last: string; rules: Record<string, number> }; requests: { kept: number; waiting: number }; corrections: { records: number } };
  erased?: { rows: number; papers: number; emails: number; blanked: number; right: string };
};
type Asked = {
  id: number;
  kind: string;
  details: string;
  orcid: string;
  proof: string;
  status: "open" | "waiting" | "done" | "refused";
  answer: Answer;
  message: string;
  created_at: string | null;
  due_at: string | null;
  decided_at: string | null;
  expected: { words: string; due: string | null } | null;
};
type State = {
  signed_in: boolean;
  available?: boolean;
  user?: { display_name: string; created_at: string };
  handles?: { orcid: string | null; github: string | null };
  orcid?: Asker;
  held?: {
    identities: { provider: string; label: string; subject: string; linked_at: string }[];
    sessions: { browser: string; created_at: string; last_seen_at: string; expires_at: string }[];
    roles: { role: string; scope_kind: string; scope_id: string; granted_by: string; granted_at: string }[];
    requests: Record<string, number>;
  };
  requests?: Asked[];
  csrf?: string;
  error?: { code: string; message: string };
};
type Part = string | Node | { href: string; text: string };

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const show = (id: string, on: boolean) => byId(id)?.toggleAttribute("hidden", !on);

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

function write(el: HTMLElement | null, tone: "" | "ok" | "warning" | "muted" | "summary", ...parts: Part[]) {
  if (!el) return;
  if (tone) el.className = tone;
  else el.removeAttribute("class");
  el.replaceChildren(...parts.map(node));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...parts: Part[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...parts.map(node));
  return e;
}

type Row = [string, Part[], string?];
function rowsInto(dl: HTMLElement | null, rows: Row[]) {
  dl?.replaceChildren(...rows.flatMap(([label, parts, cls]) => [element("dt", "", label), element("dd", cls ?? "", ...parts)]));
}

const day = (iso: string | null | undefined, time = false) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) });
};
const number = (n: number) => n.toLocaleString("en-GB");
const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const word = (tone: "ok" | "warning", text: string) => element("span", tone, text);

const message = byId("rights-message");
let state: State = { signed_in: false };
let csrf = "";

// ---------------------------------------------------------------------------------------------
// Arrival from a sign-in started here (?signed_in=…, ?error=…), said once.

function sayArrival() {
  const q = new URLSearchParams(location.search);
  const names: Record<string, string> = { orcid: "ORCID", github: "GitHub", google: "Google" };
  const who = names[q.get("signed_in") ?? q.get("provider") ?? ""] ?? "the provider";
  if (q.has("signed_in")) write(message, "ok", `You are signed in with ${who}.`);
  else if (q.get("error") === "denied") write(message, "warning", `You declined the sign-in at ${who}: nothing was changed.`);
  else if (q.get("error") === "unavailable_provider") write(message, "warning", `Signing in with ${who} is not set up yet.`);
  else if (q.has("error")) write(message, "warning", "The sign-in did not complete. Please try again.");
  if (q.has("signed_in") || q.has("error")) history.replaceState(null, "", location.pathname);
}

async function readState(): Promise<State> {
  if (!document.cookie.split(/;\s*/).includes("__Host-oscr_signed_in=1")) return { signed_in: false };
  try {
    const res = await fetch("/api/rights", { credentials: "same-origin", headers: { Accept: "application/json" } });
    return (await res.json()) as State;
  } catch {
    return { signed_in: false, error: { code: "unreachable", message: "The registry could not be reached: check the connection, then reload the page." } };
  }
}

// ---------------------------------------------------------------------------------------------
// What the site's database holds about the account.

const ROLE_WORDS: Record<string, string> = {
  verified_author: "verified author",
  maintainer: "maintainer",
  moderator: "moderator",
  admin: "administrator",
};
const GRANTED: Record<string, string> = { system: "the automatic checks", rules: "the moderator's rules", owner: "the operator", someone: "a moderator" };
const TABLE_WORDS: [string, string, string][] = [
  ["submissions", "submission", "submissions"],
  ["claims", "claim", "claims"],
  ["edits", "correction", "corrections"],
  ["validations", "validation", "validations"],
  ["reports", "removal request", "removal requests"],
  ["rights", "data-rights request", "data-rights requests"],
];

function renderHeld(s: State) {
  const h = s.held;
  if (!h) return;
  const rows: Row[] = [];
  rows.push(["Name", [s.user?.display_name ? `“${s.user.display_name}”, as your provider gave it` : "none (Google gives none)"]]);
  rows.push(["Account created", [day(s.user?.created_at)]]);
  rows.push([
    "Linked identities",
    h.identities.flatMap((i, n) => {
      const what =
        i.provider === "orcid"
          ? `ORCID iD ${i.subject}`
          : i.provider === "github"
            ? `GitHub account No. ${i.subject}${s.handles?.github ? ` (login ${s.handles.github})` : ""}`
            : `Google's identifier for you, ${i.subject}`;
      return [n ? "; " : "", `${what}, linked on ${day(i.linked_at)}`];
    }),
  ]);
  rows.push([
    "Sessions",
    h.sessions.length
      ? h.sessions.flatMap((x, n) => [n ? "; " : "", `${x.browser || "a browser"}: since ${day(x.created_at)}, last seen ${day(x.last_seen_at, true)}, until ${day(x.expires_at)}`])
      : ["none"],
  ]);
  const papers = h.roles.filter((r) => r.role === "verified_author").length;
  const other = h.roles.filter((r) => r.role !== "verified_author" && r.role !== "member");
  rows.push([
    "Roles",
    [
      "member",
      papers ? `; verified author of ${plural(papers, "paper")}` : "",
      ...other.map((r) => `; ${ROLE_WORDS[r.role] ?? r.role}${r.scope_id ? ` of ${r.scope_id}` : ""} (granted by ${GRANTED[r.granted_by] ?? "a moderator"} on ${day(r.granted_at)})`),
    ],
  ]);
  // The data-rights requests are listed on this page; the others, on the account page.
  const others = TABLE_WORDS.filter(([t]) => t !== "rights" && (h.requests[t] ?? 0) > 0).map(([t, one, many]) => plural(h.requests[t], one, many));
  const rights = h.requests.rights ?? 0;
  const parts: Part[] = [];
  if (others.length) parts.push(others.join(", "), " (listed on ", { href: "/account/#requests", text: "your account page" }, ")");
  if (rights) parts.push(others.length ? "; " : "", `${plural(rights, "data-rights request")} (listed above)`);
  rows.push(["Requests", parts.length ? parts : ["none"]]);
  rowsInto(byId("rights-held"), rows);
}

// ---------------------------------------------------------------------------------------------
// The requests, and their answers.

const SOURCES: Record<string, string> = { jats: "the paper's full text", epmc: "its Europe PMC record", "jats+epmc": "the paper's full text and its Europe PMC record" };
const FIELDS: [string, string][] = [
  ["given", "Given names"],
  ["family", "Family name"],
  ["name", "Name as printed"],
  ["orcid", "ORCID iD"],
  ["email", "Email address"],
  ["organization", "Organisation"],
  ["address", "Postal address"],
  ["affiliation", "Affiliation"],
  ["corresponding", "Corresponding author"],
];

function paperLink(p: { id: string; doi: string; title: string }): Part[] {
  return [{ href: `/paper/${slugOf(p.id)}/`, text: p.title || p.id }, p.doi ? ` (doi:${p.doi})` : ""];
}

function renderAnswer(a: Answer): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (a.erased) {
    out.push(element("p", "", `Erased: ${plural(a.erased.rows, "row")} of contact details, from ${plural(a.erased.papers, "paper")}; ${plural(a.erased.emails, "address", "addresses")} kept only as fingerprints, to never collect them again.`));
  }
  if (a.contacts) {
    const c = a.contacts;
    out.push(element("h4", "", "Your contact details, kept privately under your ORCID iD"));
    out.push(
      element(
        "p",
        c.rows ? "" : "muted",
        c.rows
          ? `${plural(c.rows, "row")}, from ${plural(c.papers, "paper")}. Each email address is masked: the site never shows or stores one. The paper named with it prints it in full, which is where the registry read it.`
          : "None: the registry keeps no contact details under your ORCID iD.",
      ),
    );
    for (const item of c.listed ?? []) {
      const dl = element("dl", "review");
      const rows: Row[] = [["Paper", paperLink(item.paper)], ["Author No.", [String(item.position || "n/a")]]];
      rows.push(["Tied to you by", [item.tied_by === "orcid" ? "your ORCID iD, which the paper gives" : "your address, under your family name (the paper gives no iD)"]]);
      for (const [key, label] of FIELDS) {
        const v = item.fields[key];
        if (key === "corresponding") rows.push([label, [v ? "yes" : "no"]]);
        else rows.push([label, [v ? String(v) : "n/a", key === "email" && v ? " (masked)" : ""]]);
      }
      rows.push(["Read from", [`${SOURCES[item.source] ?? item.source}, on ${item.found}`]]);
      rowsInto(dl, rows);
      out.push(dl);
    }
    if (c.more) out.push(element("p", "muted", `And ${plural(c.more, "more row")}, not listed here for room: ask for a rectification to have the operator give them.`));
    if (c.suppressed) out.push(element("p", "", "Your ORCID iD is on the list of people whose contact details the registry never collects again."));
  }
  if (a.authorship) {
    const p = a.authorship;
    out.push(element("h4", "", "The papers whose public metadata list your ORCID iD"));
    out.push(element("p", "", p.papers ? `${plural(p.papers, "paper")}, the public record, as each paper's page shows it.` : "None."));
    if (p.listed?.length) {
      const ul = element("ul", "");
      for (const x of p.listed) ul.append(element("li", "", ...paperLink(x)));
      out.push(ul);
    }
    if (p.more) out.push(element("p", "muted", `And ${plural(p.more, "more paper")}.`));
  }
  if (a.operator) {
    const o = a.operator;
    const rules = Object.entries(o.log.rules ?? {}).map(([rule, n]) => `${rule} (${number(n)})`).join(", ");
    out.push(element("h4", "", "On the operator's computer"));
    const dl = element("dl", "review");
    rowsInto(dl, [
      ["The moderator's log", [o.log.entries ? `${plural(o.log.entries, "entry", "entries")} about your account, from ${o.log.first} to ${o.log.last}${rules ? `: ${rules}` : ""}; kept 12 months` : "nothing about your account"]],
      ["Your requests' state", [o.requests.kept ? `${plural(o.requests.kept, "request")}${o.requests.waiting ? `, ${number(o.requests.waiting)} waiting for the operator` : ""}` : "none"]],
      ["Records' history", [o.corrections.records ? `corrections by you on ${plural(o.corrections.records, "record")} (the pages never say who)` : "no correction by you"]],
    ]);
    out.push(dl);
  }
  return out;
}

function statusWord(r: Asked): Part[] {
  if (r.status === "done") return [word("ok", "Answered"), ` on ${day(r.decided_at, true)}`];
  if (r.status === "refused") return [word("warning", "Refused"), ` on ${day(r.decided_at, true)}`];
  if (r.status === "waiting") return [word("warning", "Waiting for the operator"), `, who answers by ${day(r.due_at)} at the latest`];
  return [word("warning", "Sent"), ": the registry's machine answers it within minutes"];
}

function requestRows(r: Asked): Row[] {
  const rows: Row[] = [
    ["Request", [`No. ${r.id}: ${KIND_WORDS[r.kind] ?? r.kind}`]],
    ["Sent", [day(r.created_at, true)]],
    ["Status", statusWord(r)],
  ];
  if (r.status === "open" || r.status === "waiting") rows.push(["Legal deadline", [`${day(r.due_at)} (one month, GDPR article 12(3))`]]);
  if (r.details) rows.push(["Your words", [r.details], "text"]);
  if (r.orcid) rows.push(["About", [`ORCID iD ${r.orcid}${r.proof === "orcid-sandbox" ? " (ORCID's sandbox: a test iD)" : ""}`]]);
  if (r.message) rows.push(["The answer", [r.message], "text"]);
  else if (r.expected) rows.push(["What happens", [r.expected.words]]);
  return rows;
}

function renderRequests(list: Asked[]) {
  const out = byId("rights-requests");
  show("rights-none", list.length === 0);
  out?.replaceChildren(
    ...list.map((r) => {
      const section = element("section", "");
      section.id = `request-${r.id}`;
      section.append(element("h3", "", `${capital(KIND_WORDS[r.kind] ?? r.kind)}, request No. ${r.id}`));
      const dl = element("dl", "review");
      // Its heading names it: the list starts with when it was sent.
      rowsInto(dl, requestRows(r).slice(1));
      section.append(dl, ...renderAnswer(r.answer ?? {}));
      return section;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The form.

const form = byId<HTMLFormElement>("rights-form");
const kindOf = () => [...(form?.querySelectorAll<HTMLInputElement>('input[name="kind"]') ?? [])].find((r) => r.checked)?.value ?? "";
const asker = (): Asker => state.orcid ?? { orcid: "", proof: "" };

function syncKind() {
  const kind = kindOf();
  const out = byId("rights-expected");
  if (!kind) return write(out, "summary", "Choose a right: this says what happens, and when.");
  write(out, kind === "account" ? "warning" : "summary", expectedWords(kind, asker(), Math.floor(Date.now() / 1000)));
  write(
    byId("rights-details-hint"),
    "muted",
    kind === "rectification"
      ? `(what to correct, and how: ${RECTIFICATION_MIN} characters at least, ${number(DETAILS_MAX)} at most; no email address)`
      : `(optional; ${number(DETAILS_MAX)} characters at most; no email address)`,
  );
}

function syncCount() {
  const n = detailsLength(byId<HTMLTextAreaElement>("rights-details")?.value ?? "");
  const out = byId("rights-details-count");
  if (n > DETAILS_MAX) return write(out, "warning", `${number(n)} characters: ${number(n - DETAILS_MAX)} too many.`);
  write(out, "muted", n ? `${number(n)} characters of ${number(DETAILS_MAX)} at most.` : "");
}

const FIELD_OF: Record<string, string> = { kind: "rights-kind", details: "rights-details", confirm: "rights-confirm" };

function refuse(text: string, field = "") {
  const out = byId("rights-form-error");
  write(out, "warning", text);
  out?.removeAttribute("hidden");
  const el = field ? byId(FIELD_OF[field] ?? "") : null;
  el?.scrollIntoView({ block: "center" });
  (el?.matches("fieldset") ? el.querySelector<HTMLInputElement>("input") : el)?.focus();
}

form?.addEventListener("change", (ev) => {
  byId("rights-form-error")?.setAttribute("hidden", "");
  if ((ev.target as HTMLInputElement).name === "kind") syncKind();
});
byId("rights-details")?.addEventListener("input", () => {
  byId("rights-form-error")?.setAttribute("hidden", "");
  syncCount();
});

form?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  byId("rights-form-error")?.setAttribute("hidden", "");
  const body = {
    kind: kindOf(),
    details: byId<HTMLTextAreaElement>("rights-details")?.value ?? "",
    confirm: byId<HTMLInputElement>("rights-confirm")?.checked === true,
  };
  const c = checkRights(body);
  if (!c.ok) return refuse(c.message, c.field);
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button) button.disabled = true;
  let res: Response;
  try {
    res = await fetch("/api/rights", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
  } catch {
    if (button) button.disabled = false;
    return refuse("The registry could not be reached: nothing was sent. Check the connection, then send it again.");
  }
  if (button) button.disabled = false;
  const data = (await res.json().catch(() => ({}))) as { request?: Asked; error?: { code: string; message: string; field?: string } };
  if (!res.ok) {
    if (data.error?.code === "signed_out") return refuse("Your session has ended: nothing was sent. Sign in again, then come back here.");
    const shown = data.error?.message ?? "Something went wrong: nothing was sent. Please try again.";
    if (data.error?.code === "already_open" && data.request) {
      byId(`request-${data.request.id}`)?.scrollIntoView({ block: "start" });
      return write(message, "warning", shown);
    }
    return refuse(shown, data.error?.field ?? "");
  }
  const r = data.request;
  if (!r) return refuse("The answer could not be read: reload the page to see your request.");
  write(byId("rights-receipt-title"), "", `Request No. ${r.id} received`);
  write(byId("rights-receipt-state"), "ok", r.expected?.words ?? "The registry's machine answers it within minutes.");
  rowsInto(byId("rights-receipt-summary"), requestRows({ ...r, message: "" }));
  form.reset();
  syncKind();
  syncCount();
  show("rights-form", false);
  show("rights-receipt", true);
  const title = byId("rights-receipt-title");
  title?.focus();
  title?.scrollIntoView({ block: "start" });
  state.requests = [r, ...(state.requests ?? [])];
  renderRequests(state.requests);
  if (state.held) state.held.requests.rights = (state.held.requests.rights ?? 0) + 1;
  renderHeld(state);
});

byId("rights-another")?.addEventListener("click", () => {
  show("rights-receipt", false);
  show("rights-form", true);
  byId("rights-form-title")?.scrollIntoView({ block: "start" });
});

byId("rights-download")?.addEventListener("click", () => {
  const copy = {
    made_at: new Date().toISOString(),
    account: { user: state.user, handles: state.handles, held: state.held },
    requests: state.requests ?? [],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "my-data.json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// ---------------------------------------------------------------------------------------------

async function main() {
  sayArrival();
  const s = await readState();
  state = s;
  if (s.error) write(message, "warning", s.error.message);
  if (!s.signed_in) {
    show("rights-signed-out", s.available !== false);
    if (s.available === false) write(message, "warning", "Signing in is not set up yet: requests are not open. Please come back later.");
    return;
  }
  csrf = s.csrf ?? "";
  show("rights-signed-in", true);
  const handles = [s.handles?.orcid && `ORCID iD ${s.handles.orcid}`, s.handles?.github && `GitHub ${s.handles.github}`].filter(Boolean).join(", ");
  write(byId("rights-who"), "", `Signed in as ${s.user?.display_name || "a member without a name"}${handles ? ` (${handles})` : ""}. `, { href: "/account/", text: "Your account" }, ".");
  const note = byId("rights-orcid-note");
  if (!s.orcid?.orcid) {
    write(
      note,
      "warning",
      "Your account has no ORCID iD: the registry cannot tell by itself which authors' contact details are yours (a name, a GitHub login or a Google account proves nothing), so such a request waits for the operator, who answers within one month. ",
      { href: "/account/", text: "Link your ORCID iD" },
      " for an automatic answer.",
    );
    show("rights-orcid-note", true);
  } else if (s.orcid.proof !== "orcid") {
    write(note, "warning", "The site signs in with ORCID's sandbox for now: its iDs are tests, so the registry shows no contact detail to them. An erasure or an objection is still applied.");
    show("rights-orcid-note", true);
  }
  renderHeld(s);
  renderRequests(s.requests ?? []);
  syncKind();
  syncCount();
  if (location.hash.startsWith("#request-")) byId(location.hash.slice(1))?.scrollIntoView({ block: "start" });
}

void main();

export {};
