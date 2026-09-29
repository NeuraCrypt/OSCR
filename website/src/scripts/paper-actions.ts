// A paper's Contribute section (Phase 6), in the reader's browser: what this reader may do here.
// The page is static and says how to sign in; this script asks the Worker only when the browser
// holds a session (the `__Host-oscr_signed_in` hint cookie: a signed-out reader costs no request),
// once: GET /api/contributions/paper. Then the forms send their request with the session's CSRF
// token. A removal is asked on its own page, /removal/ (src/scripts/removal.ts): this one only says
// where the reader's request stands. Everything is written as text nodes, never as HTML. Like every browser script, it never
// names the platform: "the registry".

type Validation = { status: string; doi: string; record_url: string; instance: string; message: string; map_digest: string };
type Request = { id?: number; status: string; message: string; reason?: string; scope?: string; removal_url?: string };
type Edit = { status: string; message: string; version: number | null; created_at: string };
type State = {
  signed_in: boolean;
  available?: boolean;
  user?: { display_name: string; orcid: string | null; github: string | null };
  author?: boolean;
  maintains?: string[];
  claim?: Request | null;
  validation?: Validation | null;
  report?: Request | null;
  edits?: Edit[];
  csrf?: string;
  error?: { code: string; message: string };
};
type Part = string | { href: string; text: string };

const section = document.getElementById("contribute");
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const paper = section?.dataset.paper ?? "";
const digest = section?.dataset.digest ?? "";
let csrf = "";
/** What the Worker said of this reader, once asked. */
let state: State | null = null;

function write(el: HTMLElement | null, tone: "" | "ok" | "warning", ...parts: Part[]) {
  if (!el) return;
  if (tone) el.className = tone;
  else el.removeAttribute("class");
  el.replaceChildren(
    ...parts.map((p) => {
      if (typeof p === "string") return document.createTextNode(p);
      // Only this site's pages and web addresses become links; anything else stays text.
      if (!/^(\/(?!\/)|https?:\/\/)/i.test(p.href)) return document.createTextNode(p.text);
      const a = document.createElement("a");
      a.href = p.href;
      a.textContent = p.text;
      return a;
    }),
  );
}

const show = (id: string, on: boolean) => byId(id)?.toggleAttribute("hidden", !on);
const status = byId("contribute-status");

/** Where a sign-in started here came back with (?signed_in=…, ?error=…), said once. */
function sayArrival() {
  const q = new URLSearchParams(location.search);
  const names: Record<string, string> = { orcid: "ORCID", github: "GitHub", google: "Google" };
  const who = names[q.get("signed_in") ?? q.get("provider") ?? ""] ?? "the provider";
  if (q.has("signed_in")) write(status, "ok", `You are signed in with ${who}.`);
  else if (q.get("error") === "unavailable_provider") write(status, "warning", `Signing in with ${who} is not set up yet.`);
  else if (q.get("error") === "denied") write(status, "warning", `You declined the sign-in at ${who}: nothing was changed.`);
  else if (q.has("error")) write(status, "warning", "The sign-in did not complete. Please try again.");
  else return;
  history.replaceState(null, "", location.pathname + location.hash);
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, any> }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: { error: { message: "The registry could not be reached: check the connection." } } };
  }
  return { ok: res.ok, status: res.status, data: ((await res.json().catch(() => ({}))) as Record<string, any>) };
}

const problem = (data: Record<string, any>) => data?.error?.message ?? "Something went wrong. Please try again.";

function busy(form: HTMLFormElement, on: boolean) {
  for (const b of form.querySelectorAll("button, select, textarea, input")) (b as HTMLButtonElement).disabled = on;
}

// ---------------------------------------------------------------------------------------------
// The blocks, by the reader's roles and requests.

function sayClaim(s: State) {
  const out = byId("claim-state");
  const form = byId<HTMLFormElement>("claim-form");
  if (s.author) {
    write(out, "ok", "You are a verified author of this paper.");
    form?.setAttribute("hidden", "");
    return;
  }
  const c = s.claim;
  if (c?.status === "pending") write(out, "warning", "Your claim waits for a moderator.");
  else if (c?.status === "rejected") write(out, "warning", `Your claim was refused${c.message ? `: ${c.message}` : "."}`);
  else if (c?.status === "verified") write(out, "ok", "Your claim was accepted: you are a verified author of this paper.");
  else if (!s.user?.orcid) {
    write(out, "", "If this paper's metadata lists your ORCID iD, ", { href: "/account/", text: "link it on your account page" }, ": you are then recognized at once.");
  } else write(out, "");
  form?.toggleAttribute("hidden", !!c && c.status !== "rejected");
}

/** The code repositories of this page that the reader maintains. */
function maintained(s: State): string[] {
  const mine = new Set(s.maintains ?? []);
  return [...document.querySelectorAll<HTMLLIElement>("#edit-links li[data-role='code']")]
    .map((li) => li.dataset.repo ?? "")
    .filter((repo) => mine.has(repo));
}

function sayEdit(s: State) {
  const repos = maintained(s);
  show("edit-block", !!s.author || repos.length > 0);
  if (!s.author) {
    // A maintainer speaks for their own repository; they may add links too.
    for (const li of document.querySelectorAll<HTMLLIElement>("#edit-links li")) {
      const select = li.querySelector("select");
      if (select) select.disabled = !repos.includes(li.dataset.repo ?? "");
    }
  }
  const last = s.edits?.[0];
  const out = byId("edit-state");
  if (!last) return write(out, "");
  if (last.status === "queued") write(out, "warning", "Your last correction is on its way.");
  else if (last.status === "applied") write(out, "ok", last.message || `Your last correction made version ${last.version}.`);
  else write(out, "warning", last.message || "Your last correction was not applied.");
}

function sayValidation(s: State) {
  const block = byId("validate-block");
  if (!block) return;
  show("validate-block", !!s.author && !!digest);
  const out = byId("validate-state");
  const button = block.querySelector("button");
  const v = s.validation;
  if (!s.user?.orcid) {
    write(out, "warning", "A map is validated with your ORCID iD: ", { href: "/account/", text: "link it on your account page" }, ".");
    if (button) button.disabled = true;
    return;
  }
  if (button) button.disabled = false;
  const sandbox = v?.instance === "sandbox" ? " (Zenodo's sandbox, while the registry is being built: a test DOI)" : "";
  if (!v) write(out, "");
  else if (v.status === "queued") {
    write(out, "warning", "Your validation is on its way: the map receives its DOI once the registry has deposited it.");
    if (button) button.disabled = true;
  } else if (v.status === "deposited" && v.map_digest === digest) {
    write(out, "ok", "You validated this map. Its DOI", sandbox, ": ", v.doi ? { href: v.record_url || `https://doi.org/${v.doi}`, text: v.doi } : "being registered", ".");
    if (button) button.disabled = true;
  } else if (v.status === "deposited") write(out, "", "You validated an earlier version of this map; this one is new.");
  else write(out, "warning", v.message || "Your validation could not be completed.");
}

/** The reader's removal request about this record, if any: its state, and its page (/removal/). */
function sayRemoval(s: State) {
  const out = byId("removal-state");
  const r = s.report;
  if (!r) return write(out, "");
  const link = { href: r.removal_url || `/removal/?paper=${encodeURIComponent(paper)}`, text: `Your removal request${r.id ? ` No. ${r.id}` : ""}` };
  if (r.status === "open") write(out, "warning", link, " waits for a moderator: you may complete it on its page.");
  else if (r.status === "accepted") write(out, "ok", link, " was accepted", r.message ? `: ${r.message}` : ".");
  else write(out, "warning", link, " was refused", r.message ? `: ${r.message}` : ".");
}

function render(s: State) {
  show("contribute-signed-out", false);
  show("contribute-signed-in", true);
  csrf = s.csrf ?? "";
  const handles = [s.user?.orcid && `ORCID iD ${s.user.orcid}`, s.user?.github && `GitHub ${s.user.github}`].filter(Boolean).join(", ");
  write(byId("contribute-who"), "", `Signed in as ${s.user?.display_name || "a member without a name"}${handles ? ` (${handles})` : ""}. `, { href: "/account/", text: "Your account" }, ".");
  show("claim-block", true);
  sayClaim(s);
  sayEdit(s);
  sayValidation(s);
  show("badge-block", !!s.author || maintained(s).length > 0);
  sayRemoval(s);
}

async function load() {
  if (!section || !paper) return;
  if (!document.cookie.split(/;\s*/).includes("__Host-oscr_signed_in=1")) return;
  let s: State;
  try {
    const res = await fetch(`/api/contributions/paper?id=${encodeURIComponent(paper)}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    s = (await res.json()) as State;
  } catch {
    write(status, "warning", "The registry could not be reached: the page shows what anyone may do.");
    return;
  }
  if (s.error) write(status, "warning", s.error.message);
  if (s.signed_in) {
    state = s;
    render(s);
  }
}

// ---------------------------------------------------------------------------------------------
// The forms.

function onSubmit(id: string, run: (form: HTMLFormElement) => Promise<void>) {
  byId<HTMLFormElement>(id)?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget as HTMLFormElement;
    busy(form, true);
    try {
      await run(form);
    } finally {
      busy(form, false);
    }
  });
}

const value = (id: string) => (byId<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id)?.value ?? "").trim();

onSubmit("claim-form", async () => {
  const r = await post("/api/claims", { paper_id: paper, statement: value("claim-statement"), link: value("claim-link") });
  if (!r.ok) return write(byId("claim-state"), "warning", problem(r.data));
  if (r.data.status === "verified") write(byId("claim-state"), "ok", "You are a verified author of this paper.");
  else write(byId("claim-state"), "warning", "Your claim waits for a moderator: your account page follows it.");
  byId("claim-form")?.setAttribute("hidden", "");
});

onSubmit("edit-form", async () => {
  const changes: Record<string, string>[] = [];
  for (const li of document.querySelectorAll<HTMLLIElement>("#edit-links li")) {
    const select = li.querySelector("select");
    if (!select || select.disabled || select.value === li.dataset.role) continue;
    changes.push(select.value === "remove" ? { op: "remove", repo: li.dataset.repo ?? "" } : { op: "role", repo: li.dataset.repo ?? "", role: select.value });
  }
  const role = value("edit-add-role") === "data" ? "data" : "code";
  for (const url of value("edit-add").split(/\s+/).filter(Boolean)) changes.push({ op: "add", url, role });
  const out = byId("edit-state");
  if (changes.length === 0) return write(out, "warning", "Nothing to send: change a link, or add one.");
  const mine = maintained(state ?? { signed_in: true });
  const as = state?.author ? {} : { as: "maintainer", repo: mine[0] ?? "" };
  const r = await post("/api/edits", { paper_id: paper, changes, note: value("edit-note"), ...as });
  if (!r.ok) return write(out, "warning", problem(r.data));
  write(out, "ok", "Your correction is on its way: it becomes a new version of this record once the registry has applied it.");
});

onSubmit("validate-form", async () => {
  const out = byId("validate-state");
  const r = await post("/api/validations", { paper_id: paper, map_digest: digest });
  if (!r.ok) return write(out, "warning", problem(r.data));
  write(out, "ok", "Your validation is on its way: the map receives its DOI once the registry has deposited it. Your account page follows it.");
  const button = byId("validate-block")?.querySelector("button");
  if (button) button.disabled = true;
});

sayArrival();
void load();

export {};
