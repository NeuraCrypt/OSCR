// /settings/hooks/: the reader's outgoing webhooks (night phase 10, E5; docs/AUTOMATION.md "Webhooks").
// One request to list them (GET /api/forge/hooks), one per act (POST /api/forge/hooks/write, with the
// session's CSRF token): make one (pinged first), ping, pause, a new secret, delete, a hook's recent
// deliveries (GET /api/forge/hooks/deliveries) and their redelivery. A repository typed as owner/name
// is found by the registry's layer (GET /api/forge/repo: 1 request). A secret is shown once. Like every
// browser script, it never names the platform.

import { HUMAN_WAIT, humanToken } from "./human-check.ts";
import { deliveriesTable, hookForm, hooksList, madeSecret, readHookSubject, type DeliveryItem, type HookItem } from "../lib/automation.ts";
import { h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { signInLine } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn } from "./social-client.ts";

const root = document.getElementById("hooks-shell");

interface Listing {
  hooks: HookItem[];
  events: { repository: string[]; paper: string[] };
  limits: { hooks: number; perSubject: number; timeoutSeconds: number; attempts: number };
}

function wireCopy(box: Element): void {
  for (const b of box.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy ?? "");
        b.textContent = "Copied";
      } catch {
        b.textContent = "Select it and copy";
      }
    });
  }
}

const say = (box: Element, text: string, tone: "ok" | "warning" | "" = "") => box.replaceChildren(toDom(h("p", { class: tone }, text)));

/** The subject a person typed, as the Worker names it (a repository through its layer). */
async function subjectOf(input: string): Promise<string | { problem: string }> {
  const read = readHookSubject(input);
  if (!read) return { problem: "Name a paper by its DOI, or a repository as owner/name." };
  if (read.kind !== "repo") return read.subject;
  const r = await getJson(`/api/forge/repo?path=${encodeURIComponent(read.path)}`);
  const layer = r.body as { forge?: unknown; id?: unknown };
  if (!r.ok || typeof layer.id !== "string" || typeof layer.forge !== "string") return { problem: `The registry does not follow ${read.path}: link it first, from the repository's page.` };
  return `repo:${layer.forge}:${layer.id}`;
}

async function draw(): Promise<void> {
  if (!root) return;
  const status = root.querySelector(".summary");
  const list = document.getElementById("hooks-list");
  const make = document.getElementById("hooks-make");
  const made = document.getElementById("hooks-made");
  if (!list || !make || !made) return;
  if (!signedIn()) {
    status?.replaceChildren("Sign in to make and see your webhooks.");
    list.replaceChildren(signInLine("Your webhooks are your account's:"));
    return;
  }
  const r = await getJson("/api/forge/hooks");
  if (!r.ok) {
    status?.replaceChildren(problemOf(r.body));
    return;
  }
  const data = r.body as unknown as Listing;
  status?.replaceChildren(`${data.hooks.length} of the ${data.limits.hooks} webhooks an account may hold. Each delivery waits ${data.limits.timeoutSeconds} seconds for an answer, and is tried up to ${data.limits.attempts} times.`);
  show(list, hooksList(data.hooks));
  for (const b of list.querySelectorAll<HTMLButtonElement>("button[data-op]")) {
    b.addEventListener("click", () => void act(b, list));
  }
  const prefill = new URLSearchParams(location.search).get("subject") ?? "";
  show(make, hookForm(data.events, prefill.slice(0, 300)));
  const form = make.querySelector<HTMLFormElement>("#hook-form");
  const subject = make.querySelector<HTMLInputElement>("#hook-subject");
  const kindOf = () => (readHookSubject(subject?.value ?? "")?.kind === "repo" || /^repo:/.test(subject?.value ?? "") ? "repository" : "paper");
  const flip = () => {
    for (const box of make.querySelectorAll<HTMLElement>("div.choices[data-kind]")) box.hidden = box.dataset.kind !== kindOf();
  };
  subject?.addEventListener("input", flip);
  flip();
  form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const kind = kindOf();
    const all = fd.get(`events-${kind}`) !== "some";
    const events = all ? "*" : fd.getAll(`event-${kind}`).map(String);
    const s = await subjectOf(String(fd.get("subject") ?? ""));
    if (typeof s !== "string") return say(made, s.problem, "warning");
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    // Night phase 16: a webhook is made behind the human check (human-check.ts).
    const turnstile = await humanToken(button ?? form);
    if (turnstile === null) {
      if (button) button.disabled = false;
      return say(made, HUMAN_WAIT, "warning");
    }
    say(made, "Pinging the address…");
    const out = await postJson("/api/forge/hooks/write", { op: "create", subject: s, url: String(fd.get("url") ?? ""), events, turnstile });
    if (button) button.disabled = false;
    if (!out.ok) return say(made, problemOf(out.body), "warning");
    const b = out.body as { secret: string; ping: { ok: boolean; words: string } };
    made.replaceChildren(toDom(madeSecret(b.secret, b.ping)));
    wireCopy(made);
    form.reset();
    await draw();
  });
}

async function act(b: HTMLButtonElement, list: HTMLElement): Promise<void> {
  const li = b.closest("li[data-hook]") as HTMLElement | null;
  const said = li?.querySelector(".hook-said");
  const id = b.dataset.id ?? li?.dataset.hook ?? "";
  if (!said || !id) return;
  const op = b.dataset.op;
  if (op === "deliveries") {
    const r = await getJson(`/api/forge/hooks/deliveries?id=${encodeURIComponent(id)}`);
    if (!r.ok) return say(said, problemOf(r.body), "warning");
    show(said as HTMLElement, deliveriesTable((r.body as { deliveries: DeliveryItem[] }).deliveries));
    for (const again of said.querySelectorAll<HTMLButtonElement>("button[data-op=redeliver]")) {
      again.addEventListener("click", async () => {
        again.disabled = true;
        const out = await postJson("/api/forge/hooks/write", { op: "redeliver", id, guid: again.dataset.guid });
        const sent = (out.body as { sent?: { ok: boolean; words: string } }).sent;
        again.replaceWith(toDom(h("span", { class: out.ok && sent?.ok ? "ok" : "warning" }, out.ok ? (sent?.words ?? "sent") : problemOf(out.body))));
      });
    }
    return;
  }
  if (op === "delete" && !confirm("Delete this webhook? Its receiver gets nothing more.")) return;
  b.disabled = true;
  const payload = op === "pause" ? { op: "update", id, active: false } : { op, id };
  const out = await postJson("/api/forge/hooks/write", payload);
  b.disabled = false;
  if (!out.ok) return say(said, problemOf(out.body), "warning");
  if (op === "rotate") {
    said.replaceChildren(toDom(madeSecret((out.body as { secret: string }).secret, null)));
    wireCopy(said);
    return;
  }
  if (op === "ping") {
    const p = (out.body as { ping: { ok: boolean; words: string } }).ping;
    say(said, p.ok ? "The ping was answered: the webhook is active." : `The ping failed: ${p.words}.`, p.ok ? "ok" : "warning");
    if (p.ok) setTimeout(() => void draw(), 800);
    return;
  }
  void list;
  await draw();
}

if (typeof document !== "undefined") void draw();
