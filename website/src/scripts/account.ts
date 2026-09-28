// The account page, in the reader's browser: who is signed in (GET /api/account/me), and the
// actions of the account (POST, with the session's CSRF token). Everything is written with DOM
// text nodes, never as HTML. Like every browser script, it never names the platform: "the registry".

type Provider = { name: string; label: string; linked: boolean; start: string };
type Identity = { provider: string; label: string; handle: string; url: string; linked_at: string };
type Role = { role: string; scope_kind: string; scope_id: string; automatic: boolean };
type Paper = { id: string; doi: string; title: string; url: string };
type Claim = { id: number; kind: string; repo: string; paper_id: string; status: string; via: string | null; created_at: string };
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
        `Your claim on ${repo} waits for a moderator: GitHub does not show you as its owner, a public member of its organization, or a contributor.`,
      );
    } else if (outcome === "rejected") write(message, "warning", `Your claim on ${repo} was rejected by a moderator.`);
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
      const li = item(c.kind === "maintainer" ? `Maintainer of ${c.repo}: ` : `Author of ${c.paper_id}: `);
      const via: Record<string, string> = {
        owner: "you own it",
        org_member: "you belong to its organization",
        contributor: "you contributed to it",
        commit_author: "you committed to it",
      };
      if (c.status === "verified") li.append(statusWords(`verified${c.via && via[c.via] ? `, ${via[c.via]}` : ""}`, "ok"));
      else if (c.status === "pending") li.append(statusWords("waiting for a moderator", "warning"));
      else li.append(statusWords("rejected by a moderator", "warning"));
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
  if (me.signed_in) showSignedIn(me);
  else showSignedOut(me);
}

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
  else if (r.data.status === "pending") write(out, "warning", `Your claim on ${repo} waits for a moderator: only GitHub is checked automatically.`);
  else write(out, "warning", `Your claim on ${repo} was rejected by a moderator.`);
  await load();
});

sayArrival(new URLSearchParams(location.search));
void load();

export {};
