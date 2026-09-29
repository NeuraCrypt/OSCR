// The account page, in the reader's browser: who is signed in (GET /api/account/me), and the
// actions of the account (POST, with the session's CSRF token). Everything is written with DOM
// text nodes, never as HTML. Like every browser script, it never names the platform: "the registry".
import { REASON_WORDS, SCOPE_WORDS } from "../lib/removal";

type Provider = { name: string; label: string; linked: boolean; start: string };
type Identity = { provider: string; label: string; handle: string; url: string; linked_at: string };
type Role = { role: string; scope_kind: string; scope_id: string; automatic: boolean };
type Paper = { id: string; doi: string; title: string; url: string };
type Claim = { id: number; kind: string; repo: string; paper_id: string; url?: string; status: string; via: string | null; message?: string; created_at: string };
type Me = {
  signed_in: boolean;
  available?: boolean;
  providers?: Provider[];
  user?: { display_name: string; created_at: string };
  handles?: { orcid: string | null; github: string | null };
  identities?: Identity[];
  roles?: Role[];
  papers?: Paper[];
  repositories?: { repo: string; url: string }[];
  claims?: Claim[];
  csrf?: string;
  error?: { code: string; message: string };
};
type Part = string | { href: string; text: string } | { strong: string };

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const LABELS: Record<string, string> = { orcid: "ORCID", github: "GitHub", google: "Google" };
const label = (name: string | null) => LABELS[name ?? ""] ?? "the provider";

/** Text and links into an element, replacing what it held. */
function write(el: HTMLElement | null, tone: "" | "ok" | "warning", ...parts: Part[]) {
  if (!el) return;
  if (tone) el.className = tone;
  else el.removeAttribute("class");
  el.replaceChildren(
    ...parts.map((p) => {
      if (typeof p === "string") return document.createTextNode(p);
      if ("strong" in p) {
        const s = document.createElement("strong");
        s.textContent = p.strong;
        return s;
      }
      // Only this site's pages and web addresses become links; anything else stays text.
      if (!/^(\/(?!\/)|https?:\/\/)/i.test(p.href)) return document.createTextNode(p.text);
      const a = document.createElement("a");
      a.href = p.href;
      a.textContent = p.text;
      return a;
    }),
  );
}

function item(...parts: Part[]): HTMLLIElement {
  const li = document.createElement("li");
  write(li, "", ...parts);
  return li;
}

/** A status in words, green or amber (science.css .ok, .warning): never a pill. */
function statusWords(text: string, tone: "ok" | "warning"): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = tone;
  s.textContent = text;
  return s;
}

const message = byId("account-message");

/** What the Worker's redirects came back with (?signed_in=…, ?error=…, ?maintainer=…). */
function sayArrival(params: URLSearchParams) {
  const provider = label(params.get("provider") ?? params.get("signed_in") ?? params.get("linked"));
  const repo = params.get("repo") ?? "";
  const errors: Record<string, string> = {
    expired: "The sign-in took too long, or was started in another tab. Please try again.",
    denied: `You declined the sign-in at ${provider}: nothing was changed.`,
    provider_error: `${provider} did not confirm the sign-in. Please try again.`,
    unavailable_provider: `Signing in with ${provider} is not set up yet.`,
    unavailable: "The accounts are unavailable at the moment. Please try again later.",
    quota: "The registry has used its daily quota. Please try again tomorrow.",
    identity_in_use: `This ${provider} account is already linked to another account of the registry.`,
    provider_already_linked: `Your account already has a ${provider} account linked to it.`,
    session_changed: "Your session changed during the check. Please try again.",
    other_github_account:
      "GitHub signed you in with another account than the one linked to yours. Sign in to GitHub with that one, then try again.",
    unknown_repo: "This repository is not the code of a paper in the registry.",
  };
  if (params.has("error")) {
    write(message, "warning", errors[params.get("error") ?? ""] ?? "Something went wrong. Please try again.");
  } else if (params.has("signed_in")) {
    write(message, "ok", `You are signed in with ${provider}.`);
  } else if (params.has("linked")) {
    write(message, "ok", `Your ${provider} account is linked to your account.`);
  } else if (params.has("maintainer")) {
    const outcome = params.get("maintainer");
    if (outcome === "verified") write(message, "ok", `You are a maintainer of ${repo}.`);
    else if (outcome === "pending") {
      write(
        message,
        "warning",
        `Your claim on ${repo} waits, 30 days at most: GitHub does not show you as its owner, a public member of its organization, or a contributor. Ask for the check again once it does.`,
      );
    } else if (outcome === "rejected") write(message, "warning", `Your claim on ${repo} was rejected.`);
    else write(message, "warning", "GitHub did not answer: nothing was decided. Please try again later.");
  } else return;
  // The message is said once: the address goes back to the page's own.
  history.replaceState(null, "", location.pathname);
}

let csrf = "";

async function call(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: { error: { code: "network", message: "The registry could not be reached: check the connection." } } };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

const problem = (data: Record<string, unknown>) =>
  ((data.error as { message?: string } | undefined)?.message ?? "Something went wrong. Please try again.");

function showSignedOut(me: Me | null) {
  byId("signed-in")?.setAttribute("hidden", "");
  byId("signed-out")?.removeAttribute("hidden");
  if (!me) return;
  if (me.available === false || (me.providers && me.providers.length === 0)) {
    if (!message?.textContent) write(message, "warning", "Signing in is not set up yet.");
  }
  // Only the ways to sign in that are set up.
  const ready = new Set((me.providers ?? []).map((p) => p.name));
  for (const li of document.querySelectorAll<HTMLLIElement>("#sign-in li[data-provider]")) {
    li.hidden = !ready.has(li.dataset.provider ?? "");
  }
}

function roleText(r: Role): Part[] | null {
  if (r.role === "member") return ["Member"];
  if (r.role === "verified_author") return null; // counted once, below
  if (r.role === "maintainer") return ["Maintainer of ", { href: `https://${r.scope_id}`, text: r.scope_id }];
  if (r.role === "moderator") return ["Moderator"];
  if (r.role === "admin") return ["Administrator"];
  return [r.role];
}

function showSignedIn(me: Me) {
  byId("signed-out")?.setAttribute("hidden", "");
  byId("signed-in")?.removeAttribute("hidden");
  csrf = me.csrf ?? "";
  write(byId("account-name"), "", me.user?.display_name || "a member without a name");

  const identities = byId("identities");
  identities?.replaceChildren(
    ...(me.identities ?? []).map((i) => {
      if (i.provider === "orcid") return item("ORCID iD: ", { href: i.url, text: i.url });
      if (i.provider === "github") return item("GitHub: ", { href: i.url, text: i.handle });
      return item(`${i.label}: linked (Google shares no name or address with the registry)`);
    }),
  );
  const missing = (me.providers ?? []).filter((p) => !p.linked);
  const links = byId("link-links");
  links?.replaceChildren(
    ...missing.flatMap((p, i) => {
      const a = document.createElement("a");
      a.href = p.start;
      a.textContent = `link your ${p.label} account`;
      return i === 0 ? [a] : [document.createTextNode(", "), a];
    }),
  );
  byId("link-others")?.toggleAttribute("hidden", missing.length === 0);

  const papers = me.papers ?? [];
  const roles = byId("roles");
  const lines = (me.roles ?? []).map(roleText).filter((p): p is Part[] => p !== null).map((p) => item(...p));
  if (papers.length) lines.splice(1, 0, item(`Verified author of ${papers.length === 1 ? "1 paper" : `${papers.length} papers`}, below`));
  roles?.replaceChildren(...lines);

  const intro = byId("papers-intro");
  if (papers.length) {
    write(intro, "", "The papers whose authors include your ORCID iD, as their metadata gives it:");
  } else if (me.handles?.orcid) {
    write(intro, "", "No paper of the registry lists your ORCID iD among its authors yet.");
  } else {
    write(intro, "", "Link your ORCID iD: the papers whose authors include it become yours here.");
  }
  byId("papers")?.replaceChildren(
    ...papers.map((p) => item({ href: p.url, text: p.title || p.doi || p.id }, ...(p.doi ? [` (doi:${p.doi})`] : []))),
  );
  byId("authorship-form")?.toggleAttribute("hidden", !me.handles?.orcid);

  const claims = me.claims ?? [];
  byId("claims-none")?.toggleAttribute("hidden", claims.length > 0);
  byId("claims")?.replaceChildren(
    ...claims.map((c) => {
      const li =
        c.kind === "maintainer"
          ? item(`Maintainer of ${c.repo}: `)
          : item("Author of ", c.url ? { href: c.url, text: c.paper_id } : c.paper_id, ": ");
      const via: Record<string, string> = {
        owner: "you own it",
        org_member: "you belong to its organization",
        contributor: "you contributed to it",
        commit_author: "you committed to it",
      };
      if (c.status === "verified") li.append(statusWords(`verified${c.via && via[c.via] ? `, ${via[c.via]}` : ""}`, "ok"));
      else if (c.status === "pending") li.append(statusWords("waiting (30 days at most)", "warning"));
      else li.append(statusWords("rejected", "warning"));
      if (c.message) li.append(document.createTextNode(` — ${c.message}`));
      return li;
    }),
  );
}

async function load() {
  let me: Me | null = null;
  try {
    const res = await fetch("/api/account/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
    me = (await res.json()) as Me;
    if (!res.ok && !me.error) throw new Error(String(res.status));
  } catch {
    write(message, "warning", "The accounts could not be reached. Please try again in a moment.");
    showSignedOut(null);
    return;
  }
  if (me.error) {
    write(message, "warning", me.error.message);
    showSignedOut(null);
    return;
  }
  if (me.signed_in) {
    showSignedIn(me);
    await loadContributions();
  } else showSignedOut(me);
}

// ---------------------------------------------------------------------------------------------
// Phase 6: the account's submissions, corrections, validations and removal requests
// (GET /api/contributions), and a submission's draft to review, correct and publish.

type DraftLink = { key: string; url: string; role: string; source: string; state: string; license: string; scripts: number | null };
type Draft = {
  paper?: { id: string; doi: string; title: string; journal: string; published: string; page: boolean };
  links?: DraftLink[];
  map?: { repositories: number; files: number; pairs: number | null };
  notes?: string[];
};
type Submission = {
  id: number;
  doi: string;
  code_urls: string[];
  note: string;
  status: string;
  revisions: number;
  url: string;
  author: boolean;
  draft: Draft;
  message: string;
};
type Asked = {
  id: number;
  paper_id: string;
  url: string;
  status: string;
  message: string;
  doi?: string;
  record_url?: string;
  instance?: string;
  reason?: string;
  version?: number | null;
  /** A removal request's (src/lib/removal.ts): what it asks to remove, and its own page. */
  scope?: string;
  repo?: string;
  path?: string;
  removal_url?: string;
};
type Lists = { submissions?: Submission[]; edits?: Asked[]; validations?: Asked[]; reports?: Asked[]; error?: { message: string } };

const SUBMISSION: Record<string, [string, "ok" | "warning"]> = {
  queued: ["being read by the registry", "warning"],
  draft: ["draft ready: review it, then publish it", "ok"],
  publishing: ["being published", "warning"],
  moderation: ["checked by the registry's rules, or waiting for the operator (30 days at most)", "warning"],
  published: ["published", "ok"],
  refused: ["refused", "warning"],
};
const STATES: Record<string, string> = { alive: "the link answers", dead: "the link is dead", unreachable: "unreachable at the last attempt", unverified: "not verified yet" };
const SOURCES: Record<string, string> = { paper: "found in the paper", you: "given by you", both: "found in the paper and given by you" };

function para(tone: "" | "ok" | "warning", ...parts: Part[]): HTMLParagraphElement {
  const p = document.createElement("p");
  write(p, tone, ...parts);
  return p;
}

function textarea(id: string, value: string, rows: number): HTMLTextAreaElement {
  const t = document.createElement("textarea");
  t.id = id;
  t.rows = rows;
  t.value = value;
  t.spellcheck = false;
  return t;
}

function labelled(id: string, text: string, field: HTMLElement): HTMLParagraphElement {
  const p = document.createElement("p");
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = text;
  p.append(label, document.createElement("br"), field);
  return p;
}

function button(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  const b = document.createElement("button");
  b.type = "submit";
  b.textContent = text;
  p.append(b);
  return p;
}

function submissionItem(s: Submission): HTMLElement {
  const box = document.createElement("details");
  box.open = s.status === "draft" || s.status === "refused";
  const summary = document.createElement("summary");
  const [words, tone] = SUBMISSION[s.status] ?? [s.status, "warning"];
  summary.append(document.createTextNode(`doi:${s.doi}: `), statusWords(words, tone));
  box.append(summary);
  if (s.message) box.append(para(s.status === "published" ? "ok" : "", s.message));
  const d = s.draft ?? {};
  if (d.paper) {
    box.append(
      para("", "The paper: ", { href: `https://doi.org/${d.paper.doi}`, text: d.paper.title || d.paper.doi }, d.paper.journal ? `, ${d.paper.journal}` : "", d.paper.published ? ` (${d.paper.published})` : "", "."),
    );
    const links = d.links ?? [];
    if (links.length) {
      box.append(para("", "Its links, as the registry verified them:"));
      const ul = document.createElement("ul");
      for (const l of links) {
        const li = item({ href: l.url, text: l.key }, ` — ${l.role === "data" ? "data" : "code"}, ${SOURCES[l.source] ?? l.source}: `);
        li.append(statusWords(STATES[l.state] ?? l.state, l.state === "alive" ? "ok" : "warning"));
        li.append(document.createTextNode(`${l.license ? `; license ${l.license}` : "; no license"}${l.scripts != null ? `; ${l.scripts} script${l.scripts === 1 ? "" : "s"}` : ""}`));
        ul.append(li);
      }
      box.append(ul);
    }
    if (d.map) {
      const pairs = d.map.pairs == null ? "the matches with the paper come after publication" : `${d.map.pairs} match${d.map.pairs === 1 ? "" : "es"} with the paper's paragraphs`;
      box.append(para("", `Its tracing map: ${d.map.repositories} code repositor${d.map.repositories === 1 ? "y" : "ies"}, ${d.map.files} script${d.map.files === 1 ? "" : "s"}, ${pairs}.`));
    }
    for (const n of d.notes ?? []) box.append(para("warning", n));
  }
  if (["draft", "refused", "moderation"].includes(s.status) && s.revisions < 10) {
    const form = document.createElement("form");
    form.method = "post";
    form.dataset.revise = String(s.id);
    form.append(
      labelled(`revise-${s.id}`, "Its code links, one a line (at most five)", textarea(`revise-${s.id}`, s.code_urls.join("\n"), 3)),
      labelled(`revise-note-${s.id}`, "A note for the operator (optional)", textarea(`revise-note-${s.id}`, s.note, 2)),
      button("Correct the links"),
    );
    box.append(form);
  }
  if (s.status === "draft") {
    const form = document.createElement("form");
    form.method = "post";
    form.dataset.publish = String(s.id);
    form.append(
      para("", s.author ? "Your ORCID iD is among the paper's authors: the record is published at once." : "The registry's rules publish it only when each code link is proven the paper's (cited by the paper itself, or its owner proven one of its authors); otherwise it waits for the operator, 30 days at most. A README citing the paper proves nothing."),
      button("Publish"),
    );
    box.append(form);
  }
  if (s.status === "published" && s.url) box.append(para("", "Its page, after the site's next update: ", { href: s.url, text: s.url }, "."));
  return box;
}

const EDIT: Record<string, [string, "ok" | "warning"]> = { queued: ["on its way", "warning"], applied: ["applied", "ok"], refused: ["not applied", "warning"] };
const VALIDATION: Record<string, [string, "ok" | "warning"]> = {
  queued: ["on its way to Zenodo", "warning"],
  deposited: ["deposited", "ok"],
  map_changed: ["the map changed since: validate it again from its page", "warning"],
  refused: ["refused", "warning"],
  failed: ["could not be deposited", "warning"],
};
const REPORT: Record<string, [string, "ok" | "warning"]> = { open: ["open: decided by the rules, or waiting for the operator", "warning"], accepted: ["accepted", "ok"], rejected: ["refused", "warning"] };

/** A removal request: its number and its page (/removal/), what it asks to remove, of which
 *  paper, why, and where it stands. */
function reportItem(r: Asked): HTMLLIElement {
  const [w, tone] = REPORT[r.status] ?? [r.status, "warning"];
  const scope = r.scope ?? "record";
  const target = scope === "file" ? ` (${r.repo}: ${r.path})` : scope === "repository" ? ` (${r.repo})` : "";
  const li = item(
    { href: r.removal_url || `/removal/?paper=${encodeURIComponent(r.paper_id)}`, text: `Request No. ${r.id}` },
    `: ${SCOPE_WORDS[scope] ?? scope}${target} of `,
    { href: r.url, text: r.paper_id },
    ` (${REASON_WORDS[r.reason ?? ""] ?? r.reason}): `,
  );
  li.append(statusWords(w, tone));
  if (r.message) li.append(document.createTextNode(` — ${r.message}`));
  return li;
}

function askedItem(what: string, a: Asked, words: Record<string, [string, "ok" | "warning"]>, extra: Part[] = [], quiet = false): HTMLLIElement {
  const [w, tone] = words[a.status] ?? [a.status, "warning"];
  const li = item(what, { href: a.url, text: a.paper_id }, ...extra, ": ");
  li.append(statusWords(w, tone));
  // The registry's words, unless the line already says it all.
  if (a.message && !quiet) li.append(document.createTextNode(` — ${a.message}`));
  return li;
}

function list(id: string, none: string, items: HTMLElement[]) {
  byId(none)?.toggleAttribute("hidden", items.length > 0);
  byId(id)?.replaceChildren(...items);
}

async function loadContributions() {
  let lists: Lists;
  try {
    const res = await fetch("/api/contributions", { credentials: "same-origin", headers: { Accept: "application/json" } });
    lists = (await res.json()) as Lists;
  } catch {
    write(byId("submissions-result"), "warning", "Your submissions and requests could not be read. Please try again in a moment.");
    return;
  }
  if (lists.error) return write(byId("submissions-result"), "warning", lists.error.message);
  list("submissions-list", "submissions-none", (lists.submissions ?? []).map(submissionItem));
  list("edits", "edits-none", (lists.edits ?? []).map((e) => askedItem("Of ", e, EDIT, e.version ? [` (version ${e.version})`] : [])));
  list(
    "validations",
    "validations-none",
    (lists.validations ?? []).map((v) =>
      askedItem(
        "The map of ",
        v,
        VALIDATION,
        v.doi ? [", DOI ", { href: v.record_url || `https://doi.org/${v.doi}`, text: v.doi }, v.instance === "sandbox" ? " (Zenodo's sandbox: a test DOI)" : ""] : [],
        v.status === "deposited",
      ),
    ),
  );
  list("reports", "reports-none", (lists.reports ?? []).map(reportItem));
}

byId("submissions-list")?.addEventListener("submit", async (ev) => {
  const form = ev.target as HTMLFormElement;
  if (!(form instanceof HTMLFormElement)) return;
  ev.preventDefault();
  const out = byId("submissions-result");
  busy(form, true);
  let r;
  if (form.dataset.revise) {
    const id = form.dataset.revise;
    const links = (byId<HTMLTextAreaElement>(`revise-${id}`)?.value ?? "").split(/\s+/).filter(Boolean);
    r = await call(`/api/submissions/${id}/revise`, { code_urls: links, note: byId<HTMLTextAreaElement>(`revise-note-${id}`)?.value ?? "" });
    if (r.ok) write(out, "ok", "Corrected: the registry reads the links again and writes a new draft.");
  } else {
    r = await call(`/api/submissions/${form.dataset.publish}/publish`);
    if (r.ok) write(out, "ok", r.data.status === "publishing" ? "Published: the record goes on the site at its next update." : "Sent: the registry's rules check its links within about ten minutes, then publish it, or leave it to the operator and say why.");
  }
  busy(form, false);
  if (!r.ok) return write(out, "warning", problem(r.data));
  await loadContributions();
});

function busy(form: HTMLFormElement, on: boolean) {
  for (const b of form.querySelectorAll("button")) b.disabled = on;
}

byId<HTMLFormElement>("signout-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget as HTMLFormElement;
  busy(form, true);
  const r = await call("/api/account/signout");
  busy(form, false);
  if (r.ok) {
    write(message, "ok", "You are signed out.");
    await load();
  } else write(message, "warning", problem(r.data));
});

byId<HTMLFormElement>("authorship-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget as HTMLFormElement;
  const out = byId("authorship-result");
  busy(form, true);
  write(out, "", "Checking…");
  const r = await call("/api/account/authorship");
  busy(form, false);
  if (!r.ok) {
    write(out, "warning", problem(r.data));
    return;
  }
  const granted = Number(r.data.granted ?? 0);
  const revoked = Number(r.data.revoked ?? 0);
  write(
    out,
    "ok",
    granted || revoked
      ? `Done: ${granted} paper${granted === 1 ? "" : "s"} added, ${revoked} removed.`
      : "Done: your papers are up to date.",
  );
  await load();
});

byId<HTMLFormElement>("maintainer-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget as HTMLFormElement;
  const out = byId("maintainer-result");
  const input = byId<HTMLInputElement>("repo");
  busy(form, true);
  write(out, "", "Checking…");
  const r = await call("/api/account/maintainer", { repo: input?.value ?? "" });
  busy(form, false);
  const repo = String(r.data.repo ?? "");
  if (r.ok && r.data.status === "redirect" && typeof r.data.url === "string") {
    // GitHub confirms who you are (at once once you have allowed it), then comes back here.
    write(out, "", "On to GitHub, to check who you are…");
    location.assign(r.data.url);
    return;
  }
  if (!r.ok) write(out, "warning", problem(r.data));
  else if (r.data.status === "verified") write(out, "ok", `You are a maintainer of ${repo}.`);
  else if (r.data.status === "pending") write(out, "warning", `Your claim on ${repo} waits, 30 days at most: only GitHub is checked automatically.`);
  else write(out, "warning", `Your claim on ${repo} was rejected.`);
  await load();
});

sayArrival(new URLSearchParams(location.search));
void load();

export {};
