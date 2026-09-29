// /data-rights/ (night phase 16, E4): a data-rights request, signed in, behind the human check; the
// answer is read on /account/moderation/. Like every browser script, it never names the platform.

import { HUMAN_WAIT, humanToken } from "./human-check.ts";
import { signInLine } from "./pull-common.ts";
import { postJson, problemOf, signedIn } from "./social-client.ts";

const status = document.getElementById("rights-status");
const form = document.getElementById("rights-form") as HTMLFormElement | null;
const said = document.getElementById("rights-said");
const send = document.getElementById("rights-send") as HTMLButtonElement | null;

async function main(): Promise<void> {
  if (!status || !form || !said || !send) return;
  if (!signedIn()) return void status.replaceChildren(signInLine("Sign in first: it is how the registry knows the request is yours."));
  status.textContent = "Signed in: your request is linked to your account.";
  form.hidden = false;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const right = (form.querySelector('input[name="right"]:checked') as HTMLInputElement | null)?.value;
    if (!right) return void (said.textContent = "Choose what you ask for.");
    send.disabled = true;
    const turnstile = await humanToken(send);
    if (turnstile === null) {
      send.disabled = false;
      return void (said.textContent = HUMAN_WAIT);
    }
    const r = await postJson("/api/forge/rights", { right, details: (document.getElementById("rights-details") as HTMLTextAreaElement).value, turnstile });
    send.disabled = false;
    said.className = r.ok ? "ok" : "warning";
    said.textContent = r.ok ? String(r.body.sentence ?? "Sent.") : problemOf(r.body);
  });
}

void main();
