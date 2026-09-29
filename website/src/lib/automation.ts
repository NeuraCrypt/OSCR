// The settings pages of phase 10 (E5): the reader's personal tokens (/settings/tokens/) and outgoing
// webhooks (/settings/hooks/), as view trees; the scripts (src/scripts/tokens.ts, hooks.ts) wire them.
// Pure, no DOM, testable in Node (tests/forge-pages/automation.test.ts). A token is shown once, when it
// is made; a hook's secret likewise; neither is ever read back. Like every browser script, it never
// names the platform.

import { type Child, type El, h, link } from "./repo-view.ts";

/** The lives a token may be given, in days (the Worker takes 1 to 366). */
export const EXPIRY_CHOICES = [7, 30, 60, 90, 180, 366] as const;

export interface TokenItem {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  expired: boolean;
  last_used: string | null;
}

export interface ScopeItem {
  id: string;
  words: string;
}

const day = (iso: string) => iso.slice(0, 10);

/** The reader's tokens: name, scopes, dates, last use, and a button to revoke each. */
export function tokensTable(tokens: readonly TokenItem[]): El {
  if (!tokens.length) return h("p", null, "You have no token.");
  return h(
    "table",
    { class: "branches tokens" },
    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "May"), h("th", null, "Made"), h("th", null, "Expires"), h("th", null, "Last used"), h("th", null, ""))),
    h(
      "tbody",
      null,
      tokens.map((t) =>
        h(
          "tr",
          { "data-token": t.id },
          h("td", { class: "name" }, t.name),
          h("td", null, t.scopes.join(", ")),
          h("td", null, day(t.created_at)),
          h("td", { class: t.expired ? "warning" : "" }, t.expired ? `expired ${day(t.expires_at)}` : day(t.expires_at)),
          h("td", null, t.last_used ?? "never"),
          h("td", { class: "actions" }, h("button", { type: "button", "data-revoke": t.id }, "Revoke")),
        ),
      ),
    ),
  );
}

/** The form that makes a token: its name, what it may do (each scope in words), its life. */
export function tokenForm(scopes: readonly ScopeItem[], defaultDays = 30): El {
  return h(
    "form",
    { id: "token-form", class: "automation-form" },
    h("p", null, h("label", { for: "token-name" }, "Name"), " ", h("input", { id: "token-name", name: "name", type: "text", maxlength: "60", placeholder: "What it is for: the lab's CI, a notebook", autocomplete: "off", spellcheck: "false" })),
    h(
      "div",
      { class: "choices", role: "group", "aria-label": "What it may do" },
      h("p", { class: "legend" }, "What it may do"),
      scopes.map((s) => h("label", null, h("input", { type: "checkbox", name: "scope", value: s.id }), ` ${s.id}`, h("span", { class: "explain" }, s.words))),
    ),
    h(
      "p",
      null,
      h("label", { for: "token-days" }, "Expires after"),
      " ",
      h("select", { id: "token-days", name: "days", "data-default": String(defaultDays) }, EXPIRY_CHOICES.map((d) => h("option", { value: String(d) }, `${d} days`))),
    ),
    h("p", null, h("button", { type: "submit" }, "Make the token")),
  );
}

/** A token just made: shown this once, with its copy button and what to do with it. */
export function madeToken(token: string, name: string, expires: string): El {
  return h(
    "section",
    { class: "token-made confirm", "aria-live": "polite" },
    h("p", { class: "sentence" }, `The token “${name}”, until ${day(expires)}:`),
    h("pre", { class: "commands" }, token),
    h("button", { type: "button", class: "copy", "data-copy": token }, "Copy"),
    h("p", { class: "warning" }, "Copy it now: the registry keeps only its fingerprint (SHA-256) and will never show it again. Keep it as a secret (your system's keychain, your CI's secrets), never in a repository."),
    h("p", null, "Use it as ", h("code", null, "Authorization: Bearer <token>"), " on the API: ", link("/developers/", "the reference"), "."),
  );
}

// ─── webhooks ────────────────────────────────────────────────────────────────

export interface HookItem {
  id: string;
  subject: string;
  url: string;
  events: "*" | string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeliveryItem {
  guid: string;
  event: string;
  at: string;
  status: number;
  ok: boolean;
  attempts: number;
  ms: number;
  words: string;
  redelivery: boolean;
  redeliverable: boolean;
}

/** An event kind in words: "research_opened" → "research opened". */
export const eventWords = (kind: string): string => kind.replace(/_/g, " ");

/** What a hook follows, in words. */
export function subjectWords(subject: string): string {
  if (subject.startsWith("paper:doi:")) return `the paper ${subject.slice("paper:doi:".length)}`;
  const m = /^repo:([a-z]+):(\d+)$/.exec(subject);
  return m ? `the repository ${m[1]}:${m[2]}` : subject;
}

/** What a person typed as a hook's subject: a paper by DOI (in any of its forms), a repository by
 *  owner/name (or its GitHub address), or a subject as the API names it. Null: none of them. */
export function readHookSubject(input: string): { kind: "paper"; subject: string } | { kind: "repo"; path: string } | { kind: "subject"; subject: string } | null {
  const v = input.trim();
  if (!v || v.length > 300) return null;
  if (/^(repo:(github|memory):\d+|paper:doi:10\.\S+)$/.test(v)) return { kind: "subject", subject: v.toLowerCase().startsWith("paper:") ? v.toLowerCase() : v };
  const doi = /(?:^|doi\.org\/|doi:)\s*(10\.\d{4,9}\/\S+)$/i.exec(v);
  if (doi) return { kind: "paper", subject: `paper:doi:${doi[1].toLowerCase().replace(/[.,;]+$/, "")}` };
  const repo = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(v);
  if (repo && !/^\.+$/.test(repo[2])) return { kind: "repo", path: `${repo[1]}/${repo[2]}` };
  return null;
}

/** The reader's hooks, each with its state in words and its buttons. */
export function hooksList(hooks: readonly HookItem[]): El {
  if (!hooks.length) return h("p", null, "You have no webhook.");
  return h(
    "ul",
    { class: "hooks" },
    hooks.map((k) =>
      h(
        "li",
        { "data-hook": k.id },
        h("p", null, h("strong", null, k.url), " — ", subjectWords(k.subject), ", ", k.events === "*" ? "every event" : k.events.map(eventWords).join(", "), "."),
        h("p", { class: k.active ? "ok" : "warning" }, k.active ? "Active: it receives its events." : "Paused: it receives nothing until a ping is answered (2xx)."),
        h(
          "p",
          { class: "hook-actions" },
          h("button", { type: "button", "data-op": "ping", "data-id": k.id }, "Ping"),
          " ",
          k.active ? h("button", { type: "button", "data-op": "pause", "data-id": k.id }, "Pause") : null,
          " ",
          h("button", { type: "button", "data-op": "deliveries", "data-id": k.id }, "Recent deliveries"),
          " ",
          h("button", { type: "button", "data-op": "rotate", "data-id": k.id }, "New secret"),
          " ",
          h("button", { type: "button", "data-op": "delete", "data-id": k.id }, "Delete"),
        ),
        h("div", { class: "hook-said", "aria-live": "polite" }),
      ),
    ),
  );
}

/** The form that makes a hook: what it follows, where it posts, which events. */
export function hookForm(events: { repository: readonly string[]; paper: readonly string[] }, prefill = ""): El {
  const boxes = (kind: "repository" | "paper") =>
    h(
      "div",
      { class: "choices", role: "group", "aria-label": kind === "paper" ? "A paper's events" : "A repository's events", "data-kind": kind, hidden: kind === "paper" ? null : "hidden" },
      h("p", { class: "legend" }, kind === "paper" ? "A paper's events" : "A repository's events"),
      h("label", null, h("input", { type: "radio", name: `events-${kind}`, value: "*", checked: "checked" }), " Every event"),
      h("label", null, h("input", { type: "radio", name: `events-${kind}`, value: "some" }), " Only these:"),
      events[kind].map((e) => h("label", null, h("input", { type: "checkbox", name: `event-${kind}`, value: e }), ` ${eventWords(e)}`)),
    );
  return h(
    "form",
    { id: "hook-form", class: "automation-form" },
    h("p", null, h("label", { for: "hook-subject" }, "Follows"), " ", h("input", { id: "hook-subject", name: "subject", type: "text", value: prefill, placeholder: "A paper's DOI, or a repository: owner/name", autocomplete: "off", spellcheck: "false" })),
    h("p", null, h("label", { for: "hook-url" }, "Posts to"), " ", h("input", { id: "hook-url", name: "url", type: "url", placeholder: "https://…", autocomplete: "off", spellcheck: "false" })),
    boxes("paper"),
    boxes("repository"),
    h("p", null, h("button", { type: "submit" }, "Make the webhook")),
    h("p", { class: "explain" }, "The registry pings the address first: the webhook is active once it answers 2xx. Addresses on a private network, this machine or a local name are refused, and redirections are not followed."),
  );
}

/** A hook just made or given a new secret: the secret, this once. */
export function madeSecret(secret: string, pinged: { ok: boolean; words: string } | null): El {
  const out: Child[] = [
    h("p", { class: "sentence" }, "Its secret:"),
    h("pre", { class: "commands" }, secret),
    h("button", { type: "button", class: "copy", "data-copy": secret }, "Copy"),
    h("p", { class: "warning" }, "Copy it now: it is never shown again. Your receiver checks each delivery's X-Hub-Signature-256 with it."),
  ];
  if (pinged) out.push(h("p", { class: pinged.ok ? "ok" : "warning" }, pinged.ok ? "The ping was answered: the webhook is active." : `The ping failed (${pinged.words}): the webhook stays paused until a ping is answered.`));
  return h("section", { class: "confirm", "aria-live": "polite" }, out);
}

/** A hook's recent deliveries: what, when, the answer, and Redeliver where it can be. */
export function deliveriesTable(deliveries: readonly DeliveryItem[]): El {
  if (!deliveries.length) return h("p", null, "No delivery in the last 7 days.");
  return h(
    "table",
    { class: "branches deliveries" },
    h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Event"), h("th", null, "Answer"), h("th", null, "Attempts"), h("th", null, ""))),
    h(
      "tbody",
      null,
      deliveries.map((d) =>
        h(
          "tr",
          null,
          h("td", null, `${d.at.slice(0, 16).replace("T", " ")} UTC`),
          h("td", null, eventWords(d.event), d.redelivery ? " (redelivered)" : ""),
          h("td", { class: d.ok ? "ok" : "warning" }, d.status ? `${d.status}, ` : "", d.words, `, ${d.ms} ms`),
          h("td", { class: "num" }, String(d.attempts)),
          h("td", { class: "actions" }, d.redeliverable ? h("button", { type: "button", "data-op": "redeliver", "data-guid": d.guid }, "Redeliver") : null),
        ),
      ),
    ),
  );
}
