// /settings/blocked/ (night phase 16, E2): the reader's blocks (unblock), and the interaction limits of
// their repositories. One request to read; one per change, with the session's CSRF token; a repository
// named by its path is found with GET /api/forge/repo?path= (1 request). Like every browser script, it
// never names the platform.

import { el, signInLine } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn, type Json } from "./social-client.ts";

const status = document.getElementById("blocked-status");
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

async function load(): Promise<void> {
  if (!status) return;
  if (!signedIn()) return void status.replaceChildren(signInLine("Your blocks are your account's:"));
  const r = await getJson("/api/forge/blocks");
  if (!r.ok) return void status.replaceChildren(problemOf(r.body));
  const blocks = (r.body.blocks ?? []) as Json[];
  const limit = r.body.limit as Json | null;
  status.textContent = `${blocks.length ? `${blocks.length} ${blocks.length === 1 ? "person" : "people"} blocked` : "Nobody blocked"}; ${limit ? `every repository you manage is limited to ${limit.words} until ${day(Number(limit.until))}` : "no limit on every repository you manage at once (a repository may have its own)"}.`;
  const box = document.getElementById("blocked-list") as HTMLElement;
  if (!blocks.length) return void box.replaceChildren(el("p", {}, "Nobody."));
  const table = el("table", { class: "queue" }, el("thead", {}, el("tr", {}, el("th", {}, "Who"), el("th", {}, "Since"), el("th", {}, "Your note"), el("th", {}, ""))));
  const body = el("tbody", {});
  for (const b of blocks) {
    const said = el("span", { role: "status" });
    const unblock = el("button", { type: "button" }, "Unblock");
    unblock.addEventListener("click", async () => {
      unblock.disabled = true;
      const res = await postJson("/api/forge/blocks/write", { ref: b.ref, on: false });
      if (!res.ok) {
        unblock.disabled = false;
        return void (said.textContent = problemOf(res.body));
      }
      void load();
    });
    const who = String(b.ref).startsWith("orcid:") ? el("a", { href: `/u/${String(b.ref).slice(6)}/` }, String(b.label)) : String(b.label);
    body.append(el("tr", {}, el("td", {}, who), el("td", {}, day(Number(b.at))), el("td", { class: "text" }, String(b.note || "-")), el("td", {}, unblock, " ", said)));
  }
  table.append(body);
  box.replaceChildren(table);
}

document.getElementById("limit-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const said = document.getElementById("limit-said") as HTMLElement;
  const path = (document.getElementById("limit-scope") as HTMLInputElement).value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  const level = (document.querySelector('input[name="level"]:checked') as HTMLInputElement | null)?.value;
  if (level === undefined) return void (said.textContent = "Choose who may still interact.");
  let scope = "account";
  if (path) {
    const repo = await getJson(`/api/forge/repo?path=${encodeURIComponent(path)}`);
    if (!repo.ok || typeof repo.body.id !== "string") return void (said.textContent = repo.ok ? "The registry does not know this repository." : problemOf(repo.body));
    scope = `repo:${repo.body.forge ?? "github"}:${repo.body.id}`;
  }
  const r = await postJson("/api/forge/limits/write", { scope, level: level || null, duration: (document.getElementById("limit-duration") as HTMLSelectElement).value });
  said.textContent = r.ok ? (level ? `Limited until ${day(Number(r.body.until))}.` : "Lifted.") : problemOf(r.body);
  if (r.ok) void load();
});

void load();
