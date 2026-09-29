// /device/, in the reader's browser (night phase 14; the view: src/lib/device.ts; the routes:
// worker/forge/service/device.ts): a command line's sign-in, read (GET /api/forge/device, 1 request)
// then approved or refused (POST /api/forge/device/decide with the session's CSRF token and, to approve,
// the human check's token). A signed-out reader asks the Worker nothing. Like every browser script, it
// never names the platform.

import { decisionForm, noRequest, requestOf, requestView, signInLinks, stateView, type DeviceRead } from "../lib/device.ts";
import { h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { HUMAN_WAIT, humanToken } from "./human-check.ts";
import { getJson, postJson, problemOf, signedIn } from "./social-client.ts";

const root = document.getElementById("device-shell");

async function draw(): Promise<void> {
  if (!root) return;
  const status = root.querySelector(".summary");
  const box = document.getElementById("device-box");
  const said = document.getElementById("device-said");
  if (!box || !said) return;
  const request = requestOf(location.search);
  if (!request) {
    status?.replaceChildren("No sign-in request in this address.");
    show(box, noRequest());
    return;
  }
  if (!signedIn()) {
    status?.replaceChildren("Sign in to approve or refuse this sign-in.");
    show(box, signInLinks(request));
    return;
  }
  const r = await getJson(`/api/forge/device?r=${encodeURIComponent(request)}`);
  if (!r.ok) {
    status?.replaceChildren(problemOf(r.body));
    box.replaceChildren();
    return;
  }
  const d = r.body as unknown as DeviceRead;
  status?.replaceChildren(d.state === "pending" && !d.expired ? "A command line waits for your decision." : "This sign-in request:");
  const state = stateView(d);
  const decidable = d.state === "pending" && !d.expired;
  show(box, requestView(d), state, decidable ? decisionForm() : null);
  if (!decidable) return;
  const form = box.querySelector<HTMLFormElement>("#device-form");
  if (!form) return;
  if (!d.can.approve) form.querySelector<HTMLButtonElement>('button[data-decision="approve"]')?.setAttribute("disabled", "");
  const send = async (decision: "approve" | "deny"): Promise<void> => {
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button")];
    const code = String(new FormData(form).get("code") ?? "");
    if (decision === "approve" && !/^[A-Za-z]{4}-?[A-Za-z]{4}$/.test(code.trim())) {
      said.replaceChildren(toDom(h("p", { class: "warning" }, "Type the 8 letters your terminal shows (for example BCDF-GHJK).")));
      return;
    }
    for (const b of buttons) b.disabled = true;
    let turnstile: string | null = "";
    if (decision === "approve") {
      turnstile = await humanToken(form.querySelector<HTMLElement>('button[data-decision="approve"]') ?? form);
      if (turnstile === null) {
        for (const b of buttons) b.disabled = false;
        said.replaceChildren(HUMAN_WAIT);
        return;
      }
    }
    const out = await postJson("/api/forge/device/decide", { request, code, decision, turnstile });
    for (const b of buttons) b.disabled = false;
    if (!out.ok) {
      said.replaceChildren(toDom(h("p", { class: "warning", role: "alert" }, problemOf(out.body))));
      return;
    }
    said.replaceChildren();
    await draw();
  };
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send("approve");
  });
  form.querySelector<HTMLButtonElement>('button[data-decision="deny"]')?.addEventListener("click", () => {
    if (confirm("Refuse this sign-in? The command line gets no token.")) void send("deny");
  });
  form.querySelector<HTMLInputElement>("#device-code")?.focus();
}

if (typeof document !== "undefined") void draw();
