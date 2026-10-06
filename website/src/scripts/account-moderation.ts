// /account/moderation/ (night phase 16): the reader's hidden things, their appeals, their data-rights
// requests and the answers. One request to read; an appeal or a counter-notice is one more, behind the
// human check. Like every browser script, it never names the platform.

import { HUMAN_WAIT, humanToken } from "./human-check.ts";
import { el, signInLine } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn, type Json } from "./social-client.ts";

const status = document.getElementById("mine-status");
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

function appealForm(x: Json, counter: boolean): HTMLElement {
  const box = el("div", { class: "confirm" });
  const text = el("textarea", { rows: "4", maxlength: "2000", "aria-label": counter ? "Your counter-notice" : "Your appeal" });
  const goodFaith = el("input", { type: "checkbox", id: `gf-${x.target}` });
  const accurate = el("input", { type: "checkbox", id: `acc-${x.target}` });
  const said = el("span", { role: "status" });
  const send = el("button", { type: "button" }, counter ? "Send the counter-notice" : "Send the appeal");
  send.addEventListener("click", async () => {
    send.disabled = true;
    const turnstile = await humanToken(send);
    if (turnstile === null) {
      send.disabled = false;
      return void (said.textContent = HUMAN_WAIT);
    }
    const r = await postJson("/api/forge/appeal", { target: x.target, kind: counter ? "counter_notice" : "appeal", text: text.value, goodFaith: goodFaith.checked, accurate: accurate.checked, scope: x.kind === "profile" ? "profile" : undefined, turnstile });
    send.disabled = false;
    said.textContent = r.ok ? String(r.body.sentence ?? "Sent.") : problemOf(r.body);
    if (r.ok) void load();
  });
  box.append(el("p", {}, counter ? "Say why the content is yours to publish, or was removed by mistake:" : "Say why the decision is wrong:"), el("p", {}, text));
  if (counter) {
    box.append(
      el("p", {}, goodFaith, " ", el("label", { for: `gf-${x.target}` }, "I believe in good faith that it was removed by mistake or misidentification.")),
      el("p", {}, accurate, " ", el("label", { for: `acc-${x.target}` }, "What I say is accurate, and I understand the claimant may take the matter further.")),
    );
  }
  box.append(el("p", {}, send, " ", said));
  return box;
}

async function load(): Promise<void> {
  if (!status) return;
  if (!signedIn()) return void status.replaceChildren(signInLine("This page is your account's:"));
  const r = await getJson("/api/forge/moderation/mine");
  if (!r.ok) return void status.replaceChildren(problemOf(r.body));
  const hidden = (r.body.hidden ?? []) as Json[];
  const rights = (r.body.rights ?? []) as Json[];
  status.textContent = r.body.suspended
    ? "Your account is suspended: you cannot write in the registry. You may appeal below."
    : hidden.some((x) => x.state === "hidden")
      ? `${hidden.filter((x) => x.state === "hidden").length} of your things are hidden.`
      : "Nothing of yours is hidden.";
  const box = document.getElementById("mine-hidden") as HTMLElement;
  if (!hidden.length) box.replaceChildren(el("p", {}, "Nothing, now or before."));
  else {
    const list = el("ul", {});
    for (const x of hidden) {
      const item = el(
        "li",
        {},
        el("strong", {}, String(x.label || x.target)),
        `: ${x.state === "hidden" ? `hidden since ${day(Number(x.since))}` : "restored"}, ${x.words}.`,
        x.message ? el("p", { class: "moderated" }, `The owner's words: ${x.message}`) : "",
        x.appeal === "open" ? el("p", {}, "Your appeal waits for the owner.") : x.appeal ? el("p", {}, `Your appeal was ${x.appeal}.`) : "",
      );
      if (x.canAppeal) {
        const b = el("button", { type: "button" }, "Appeal…");
        b.addEventListener("click", () => void item.append(appealForm(x, false)));
        item.append(b);
        if (x.counterNotice) {
          const c = el("button", { type: "button" }, "Counter-notice…");
          c.addEventListener("click", () => void item.append(appealForm(x, true)));
          item.append(" ", c);
        }
      }
      list.append(item);
    }
    box.replaceChildren(list);
  }
  const rb = document.getElementById("mine-rights") as HTMLElement;
  if (!rights.length) rb.replaceChildren(el("p", {}, "None."));
  else {
    const list = el("ul", {});
    for (const x of rights) list.append(el("li", { id: `rights-${x.id}` }, `${day(Number(x.at))}, ${x.kind}: ${x.state === "open" ? "waiting for the owner" : `${x.state} on ${day(Number(x.answered_at))}`}.`, x.answer ? el("p", { class: "moderated" }, String(x.answer)) : ""));
    rb.replaceChildren(list);
  }
}

void load();
