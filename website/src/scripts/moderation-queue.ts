// /moderation/ (night phase 16, E1): the owner's queue. One request to read it; one per decision, with
// the session's CSRF token. The Worker checks that the account is the owner's: this page only draws what
// it answers. Like every browser script, it never names the platform.

import { el, signInLine } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn, type Json } from "./social-client.ts";

const status = document.getElementById("queue-status");
const reasonsTpl = document.getElementById("hide-reasons") as HTMLTemplateElement | null;
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Where a target's page is, when the registry has one to show. */
function pageOf(target: string): string | null {
  let m = /^research:(\d+)(?:#(\d+))?$/.exec(target);
  if (m) return `/research/${m[1]}`;
  m = /^person:orcid:(.+)$/.exec(target);
  return m ? `/u/${m[1]}/` : null;
}

function reasonSelect(chosen: string): HTMLSelectElement {
  const s = el("select", { "aria-label": "Why it is hidden" });
  for (const o of reasonsTpl?.content.querySelectorAll("option") ?? []) s.append(o.cloneNode(true));
  s.value = chosen;
  return s;
}

/** The form that hides a target: reason, public notice, message to the person (and for a person,
 *  the whole account or only the profile's words). */
function hideForm(target: string, reason: string, report: number | null, done: () => void): HTMLElement {
  const box = el("div", { class: "confirm" });
  const select = reasonSelect(reason);
  const notice = el("textarea", { rows: "2", maxlength: "1000", "aria-label": "Public notice", placeholder: "Public notice (redacted: no names, no hidden words). Empty: the reason in words." });
  const message = el("textarea", { rows: "2", maxlength: "1000", "aria-label": "Message to the person", placeholder: "Your words to the person (shown on their page)." });
  const scope = el("select", { "aria-label": "What of the person" }, el("option", { value: "account" }, "suspend the account"), el("option", { value: "profile" }, "hide only the profile's words"));
  const said = el("span", { role: "status" });
  const go = el("button", { type: "button" }, "Hide");
  go.addEventListener("click", async () => {
    go.disabled = true;
    const r = await postJson("/api/forge/moderation/decide", { op: "hide", target, reason: select.value, notice: notice.value, message: message.value, report, ...(target.startsWith("person:") ? { scope: scope.value } : {}) });
    go.disabled = false;
    if (!r.ok) return void (said.textContent = problemOf(r.body));
    said.textContent = String(r.body.sentence ?? "Hidden.");
    done();
  });
  box.append(el("p", {}, select, target.startsWith("person:") ? scope : ""), el("p", {}, notice), el("p", {}, message), el("p", {}, go, " ", said));
  return box;
}

async function decide(payload: Record<string, unknown>, said: HTMLElement): Promise<boolean> {
  const r = await postJson("/api/forge/moderation/decide", payload);
  said.textContent = r.ok ? String(r.body.sentence ?? "Done.") : problemOf(r.body);
  return r.ok;
}

function drawReports(box: HTMLElement, reports: Json[]): void {
  if (!reports.length) return void box.replaceChildren(el("p", {}, "No open report."));
  const table = el("table", { class: "queue" }, el("thead", {}, el("tr", {}, el("th", {}, "When"), el("th", {}, "What"), el("th", {}, "Why"), el("th", {}, "Their words"), el("th", {}, "Decide"))));
  const body = el("tbody", {});
  for (const x of reports) {
    const target = String(x.target);
    const page = pageOf(target);
    const said = el("span", { role: "status" });
    const actions = el("td", {});
    const hide = el("button", { type: "button" }, "Hide…");
    const dismiss = el("button", { type: "button" }, "Dismiss");
    hide.addEventListener("click", () => actions.append(hideForm(target, String(x.reason), Number(x.id), () => void load())));
    dismiss.addEventListener("click", async () => void ((await decide({ op: "dismiss", report: x.id }, said)) && load()));
    actions.append(hide, " ", dismiss, " ", said);
    body.append(
      el(
        "tr",
        {},
        el("td", {}, day(Number(x.at)), el("br", {}), x.signedIn ? "signed in" : "without an account"),
        el("td", {}, page ? el("a", { href: page }, String(x.label || target)) : String(x.label || target), el("br", {}), el("code", {}, target)),
        el("td", {}, String(x.words)),
        el("td", { class: "text" }, String(x.details || "-")),
        actions,
      ),
    );
  }
  table.append(body);
  box.replaceChildren(table);
}

function drawAppeals(box: HTMLElement, appeals: Json[]): void {
  if (!appeals.length) return void box.replaceChildren(el("p", {}, "No appeal waiting."));
  const table = el("table", { class: "queue" }, el("thead", {}, el("tr", {}, el("th", {}, "Since"), el("th", {}, "What was hidden"), el("th", {}, "Their words"), el("th", {}, "Decide"))));
  const body = el("tbody", {});
  for (const x of appeals) {
    const said = el("span", { role: "status" });
    const accept = el("button", { type: "button" }, x.appealKind === "counter_notice" ? "Accept: restore" : "Accept: restore");
    const reject = el("button", { type: "button" }, "Reject");
    accept.addEventListener("click", async () => void ((await decide({ op: "appeal", target: x.target, appeal: "accepted" }, said)) && load()));
    reject.addEventListener("click", async () => void ((await decide({ op: "appeal", target: x.target, appeal: "rejected" }, said)) && load()));
    body.append(
      el(
        "tr",
        {},
        el("td", {}, day(Number(x.appealAt ?? x.updated))),
        el("td", {}, String(x.label || x.target), el("br", {}), `${x.words}${x.appealKind === "counter_notice" ? ", a counter-notice" : ""}`),
        el("td", { class: "text" }, String(x.appealText)),
        el("td", {}, accept, " ", reject, " ", said),
      ),
    );
  }
  table.append(body);
  box.replaceChildren(table);
}

function drawRights(box: HTMLElement, rights: Json[]): void {
  if (!rights.length) return void box.replaceChildren(el("p", {}, "No request waiting."));
  const table = el("table", { class: "queue" }, el("thead", {}, el("tr", {}, el("th", {}, "Since"), el("th", {}, "Who"), el("th", {}, "What"), el("th", {}, "Answer (read on their page)"))));
  const body = el("tbody", {});
  for (const x of rights) {
    const who = (x.who ?? {}) as Json;
    const text = el("textarea", { rows: "3", maxlength: "2000", "aria-label": "Your answer" });
    const said = el("span", { role: "status" });
    const send = (state: string) => async () => {
      const r = await postJson("/api/forge/rights/answer", { id: x.id, at: x.at, state, answer: text.value });
      said.textContent = r.ok ? "Answered." : problemOf(r.body);
      if (r.ok) void load();
    };
    const answer = el("button", { type: "button" }, "Answer");
    const refuse = el("button", { type: "button" }, "Refuse");
    answer.addEventListener("click", send("answered"));
    refuse.addEventListener("click", send("refused"));
    body.append(el("tr", {},
      el("td", {}, day(Number(x.at)), el("br", {}), `due ${day(Number(x.at) + 30 * 86_400)}`),
      el("td", {}, [who.github ? `GitHub ${who.github}` : "", who.orcid ? `ORCID ${who.orcid}` : "", who.name ? String(who.name) : ""].filter(Boolean).join(" · ") || "an account"),
      el("td", { class: "text" }, `${x.kind}: ${x.details || "(no words)"}`),
      el("td", {}, text, el("br", {}), answer, " ", refuse, " ", said),
    ));
  }
  table.append(body);
  box.replaceChildren(table);
}

async function load(): Promise<void> {
  if (!status) return;
  if (!signedIn()) return void status.replaceChildren(signInLine("The queue is the owner's:"));
  const r = await getJson("/api/forge/moderation");
  if (!r.ok) return void status.replaceChildren(problemOf(r.body));
  const reports = (r.body.reports ?? []) as Json[];
  const appeals = (r.body.appeals ?? []) as Json[];
  const rights = (r.body.rights ?? []) as Json[];
  status.textContent = `${reports.length} open ${reports.length === 1 ? "report" : "reports"}, ${appeals.length} ${appeals.length === 1 ? "appeal" : "appeals"}, ${rights.length} data-rights ${rights.length === 1 ? "request" : "requests"}.`;
  drawReports(document.getElementById("queue-reports") as HTMLElement, reports);
  drawAppeals(document.getElementById("queue-appeals") as HTMLElement, appeals);
  drawRights(document.getElementById("queue-rights") as HTMLElement, rights);
}

document.getElementById("queue-lookup")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const found = document.getElementById("queue-found") as HTMLElement;
  const target = (document.getElementById("lookup-target") as HTMLInputElement).value.trim();
  const r = await getJson(`/api/forge/moderation?target=${encodeURIComponent(target)}`);
  if (!r.ok) return void found.replaceChildren(el("p", { class: "warning" }, problemOf(r.body)));
  const m = r.body.moderation as Json | null;
  const said = el("span", { role: "status" });
  if (m && m.state === "hidden") {
    const restore = el("button", { type: "button" }, "Restore");
    restore.addEventListener("click", async () => void (await decide({ op: "restore", target: r.body.target }, said)));
    found.replaceChildren(el("p", { class: "moderated" }, `${r.body.label}: hidden since ${day(Number(m.since))} (${m.words}). `, restore, " ", said));
  } else {
    found.replaceChildren(el("p", {}, `${r.body.label}: ${m ? `restored (${m.words})` : "never hidden"}.`), hideForm(String(r.body.target), "spam", null, () => void 0));
  }
});

void load();
