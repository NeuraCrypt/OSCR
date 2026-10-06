// The approval page of the command line's sign-in, /device/ (night phase 14; the Worker's routes:
// worker/forge/service/device.ts; D14-2): what a sealed request asks, as view trees. Pure, no DOM,
// testable in Node (tests/forge-pages/device.test.ts); src/scripts/device.ts wires it. Like every
// browser script, it never names the platform.
//
// The page never shows the code to type: the person reads it in their own terminal and types it here,
// so an address someone else sent them cannot be approved by a click.

import { type El, h, link } from "./repo-view.ts";

export interface DeviceRead {
  name: string;
  scopes: { id: string; words: string }[];
  days: number;
  requested_at: string;
  expires_at: string;
  expired: boolean;
  state: "pending" | "approved" | "denied" | "collected" | "decided";
  account: { github: string | null; orcid: string | null };
  can: { approve: boolean };
}

const SEALED = /^[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{43}$/;

/** The sealed request the address carries (?r=), or null when there is none, or it is not one. */
export function requestOf(search: string): string | null {
  const r = new URLSearchParams(search).get("r");
  return r && SEALED.test(r) ? r : null;
}

/** The sign-in links, each coming back to this very request. */
export function signInLinks(request: string): El {
  const back = encodeURIComponent(`/device/?r=${request}`);
  return h(
    "p",
    null,
    "Sign in first, with the account the token will act as: ",
    link(`/api/auth/orcid/start?return=${back}`, "ORCID"),
    ", ",
    link(`/api/auth/github/start?return=${back}`, "GitHub"),
    " or ",
    link(`/api/auth/google/start?return=${back}`, "Google"),
    ". You come back to this page after.",
  );
}

const who = (a: DeviceRead["account"]): string => (a.github ? `your account (GitHub ${a.github}${a.orcid ? `, ORCID ${a.orcid}` : ""})` : a.orcid ? `your account (ORCID ${a.orcid})` : "your account");

const minutesLeft = (expires: string, now: number): number => Math.max(0, Math.ceil((Date.parse(expires) - now) / 60_000));

/** The request in words: who asks, what the token may do, for how long; the warning while it waits. */
export function requestView(d: DeviceRead, now = Date.now()): El {
  const waiting = d.state === "pending" && !d.expired;
  const asked = `${d.requested_at.slice(0, 16).replace("T", " ")} UTC`;
  return h(
    "section",
    { class: "panel" },
    h("h2", null, "A command line asks for a token"),
    h(
      "dl",
      { class: "settings" },
      h("dt", null, "Its name"),
      h("dd", null, d.name),
      h("dt", null, "It will act as"),
      h("dd", null, who(d.account)),
      h("dt", null, "What it may do"),
      h("dd", null, h("ul", null, d.scopes.map((s) => h("li", null, h("code", null, s.id), `: ${s.words}`)))),
      h("dt", null, "For"),
      h("dd", null, `${d.days} days, then it stops working; you can revoke it before in your personal tokens.`),
      h("dt", null, "Asked at"),
      h("dd", null, waiting ? `${asked}, this request ends in ${minutesLeft(d.expires_at, now)} minutes.` : asked),
    ),
    waiting
      ? h(
          "p",
          { class: "warning" },
          "Approve only if you started this sign-in yourself, a moment ago, in your own terminal (",
          h("code", null, "oscr auth login"),
          "). Someone who sent you this address would get a token that acts as you.",
        )
      : null,
  );
}

/** The form: the code the terminal shows, then approve or refuse. */
export function decisionForm(): El {
  return h(
    "form",
    { id: "device-form", class: "automation-form", autocomplete: "off" },
    h(
      "p",
      null,
      h("label", { for: "device-code" }, "The code your terminal shows"),
      h("br", null),
      h("input", {
        id: "device-code",
        class: "device-code",
        name: "code",
        type: "text",
        inputmode: "text",
        maxlength: "9",
        placeholder: "XXXX-XXXX",
        autocapitalize: "characters",
        autocomplete: "off",
        spellcheck: "false",
        "aria-describedby": "device-code-help",
      }),
    ),
    h("p", { id: "device-code-help", class: "muted" }, "8 letters, as your terminal printed them. If it shows none, do not approve."),
    h("p", null, h("button", { type: "submit", class: "primary", "data-decision": "approve" }, "Approve"), " ", h("button", { type: "button", "data-decision": "deny" }, "Refuse")),
  );
}

/** What the page says once the request is decided, expired, or cannot be approved by this account. */
export function stateView(d: DeviceRead): El | null {
  if (d.state === "approved" || d.state === "collected") {
    return h(
      "div",
      { class: "confirm", role: "status" },
      h("p", { class: "sentence ok" }, "Approved."),
      h("p", null, "Go back to your terminal: it receives the token within 5 seconds, and keeps it in your system's keychain. The registry keeps only its fingerprint."),
      h("p", null, "You can see it, and revoke it at any time, in ", link("/settings/tokens/", "your personal tokens"), "."),
    );
  }
  if (d.state === "denied") return h("p", { class: "ok", role: "status" }, "Refused: the command line gets no token. You can close this page.");
  if (d.state === "decided") return h("p", { class: "warning", role: "status" }, "This request was decided already, with another account.");
  if (d.expired) return h("p", { class: "warning", role: "status" }, "This request expired (a sign-in request lives 15 minutes): run the sign-in again in your terminal.");
  if (!d.can.approve) {
    return h("p", { class: "warning" }, "Making tokens opens with the registry's content rules: until then, only its owner can approve a sign-in. You can refuse it.");
  }
  return null;
}

/** The page without a request in its address. */
export function noRequest(): El {
  return h(
    "div",
    null,
    h("p", null, "This page approves a sign-in started in a terminal with ", h("code", null, "oscr auth login"), "."),
    h("p", null, "Open the whole address your terminal printed (it ends with a long ", h("code", null, "?r=…"), "): it says what the command line asks for. Then type here the code the terminal shows."),
  );
}
