// /report/ (night phase 16, E1): the report form. It reads ?target= and ?label=, says what is reported,
// draws the human check, and sends POST /api/forge/report, with the session's CSRF token when the
// reader is signed in, without an account otherwise (then the site's Origin and Turnstile are the
// proofs). Like every browser script, it never names the platform.

import { KIND_WORDS, readTarget } from "../lib/moderation.ts";
import { humanCheck } from "./human-check.ts";
import { signedInHint, whoIsHere } from "./pull-common.ts";

const q = new URLSearchParams(location.search);
const target = readTarget(q.get("target") ?? "");
const label = (q.get("label") ?? "").slice(0, 200);
const what = document.getElementById("report-what");
const form = document.getElementById("report-form") as HTMLFormElement | null;
const said = document.getElementById("report-said");
const send = document.getElementById("report-send") as HTMLButtonElement | null;

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (signedInHint()) {
    const me = await whoIsHere();
    if ("csrf" in me) headers["X-CSRF-Token"] = me.csrf;
  }
  try {
    const res = await fetch("/api/forge/report", { method: "POST", credentials: "same-origin", headers, body: JSON.stringify(body) });
    return { ok: res.ok, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, body: { error: { message: "The registry could not be reached: check the connection, then try again." } } };
  }
}

async function main(): Promise<void> {
  if (!what || !form || !said || !send) return;
  if (!target) {
    what.className = "warning";
    what.textContent = "This page reports one thing the registry shows: open it from the “Report” link beside that thing.";
    return;
  }
  what.textContent = `You report ${KIND_WORDS[target.kind]}${label ? `: “${label}”` : ""}.`;
  form.hidden = false;
  // Night phase 16 (E5): what a copyright notice or a report of private information needs, said as the
  // reason is chosen.
  const onGithub = ["repo", "issue", "pull", "release"].includes(target.kind);
  form.addEventListener("change", () => {
    const reason = (form.querySelector('input[name="reason"]:checked') as HTMLInputElement | null)?.value;
    (document.getElementById("report-github") as HTMLElement).hidden = !(reason === "copyright" && onGithub);
    (document.getElementById("report-private") as HTMLElement).hidden = reason !== "private_information";
  });
  const check = await humanCheck(document.getElementById("report-check") as HTMLElement);
  if (!check) {
    send.disabled = true;
    return;
  }
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const reason = (form.querySelector('input[name="reason"]:checked') as HTMLInputElement | null)?.value;
    if (!reason) return void (said.textContent = "Choose why you report it.");
    if (!check.token()) return void (said.textContent = "Tick the human check first.");
    send.disabled = true;
    said.textContent = "Sending…";
    const r = await post({ target: target.target, label, reason, details: (document.getElementById("report-details") as HTMLTextAreaElement).value, turnstile: check.token() });
    check.reset();
    send.disabled = false;
    if (r.ok) {
      form.replaceChildren(Object.assign(document.createElement("p"), { className: "ok", textContent: String(r.body.sentence ?? "Thank you: your report is in the owner's queue.") }));
      return;
    }
    said.className = "warning";
    said.textContent = String((r.body.error as { message?: string } | undefined)?.message ?? "The report could not be sent.");
  });
}

void main();
