// /settings/tokens/: the reader's personal tokens for the public API (night phase 10, E5; docs/API.md).
// One request to list them (GET /api/forge/tokens), one to make or revoke one (POST
// /api/forge/tokens/write, with the session's CSRF token). A token is shown once, when it is made: the
// registry keeps only its SHA-256. Like every browser script, it never names the platform.

import { madeToken, tokenForm, tokensTable, type ScopeItem, type TokenItem } from "../lib/automation.ts";
import { h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { signInLine } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn } from "./social-client.ts";

const root = document.getElementById("tokens-shell");

interface Listing {
  tokens: TokenItem[];
  scopes: ScopeItem[];
  limits: { tokens: number; days: { min: number; max: number; default: number } };
  can: { create: boolean };
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

async function draw(): Promise<void> {
  if (!root) return;
  const status = root.querySelector(".summary");
  const list = document.getElementById("tokens-list");
  const make = document.getElementById("tokens-make");
  const made = document.getElementById("tokens-made");
  if (!list || !make || !made) return;
  if (!signedIn()) {
    status?.replaceChildren("Sign in to make and see your tokens.");
    list.replaceChildren(signInLine("Your tokens are your account's:"));
    return;
  }
  const r = await getJson("/api/forge/tokens");
  if (!r.ok) {
    status?.replaceChildren(problemOf(r.body));
    return;
  }
  const data = r.body as unknown as Listing;
  status?.replaceChildren(`${data.tokens.length} of the ${data.limits.tokens} tokens an account may hold.`);
  show(list, tokensTable(data.tokens));
  for (const b of list.querySelectorAll<HTMLButtonElement>("button[data-revoke]")) {
    b.addEventListener("click", async () => {
      const id = b.dataset.revoke ?? "";
      const row = b.closest("tr");
      const name = row?.querySelector("td.name")?.textContent ?? "this token";
      if (!confirm(`Revoke “${name}”? Whatever uses it stops at once.`)) return;
      b.disabled = true;
      const out = await postJson("/api/forge/tokens/write", { op: "revoke", id });
      if (!out.ok) {
        b.disabled = false;
        made.replaceChildren(toDom(h("p", { class: "warning" }, problemOf(out.body))));
        return;
      }
      made.replaceChildren(toDom(h("p", { class: "ok" }, `“${name}” is revoked: it opens nothing any more.`)));
      await draw();
    });
  }
  if (!data.can.create) {
    show(make, h("p", { class: "warning" }, "Making tokens opens with the registry's content rules: until then, only its owner can make one."));
    return;
  }
  show(make, tokenForm(data.scopes, data.limits.days.default));
  const form = make.querySelector<HTMLFormElement>("#token-form");
  const days = make.querySelector<HTMLSelectElement>("#token-days");
  if (days) days.value = days.dataset.default ?? "30";
  form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const scopes = fd.getAll("scope").map(String);
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    const out = await postJson("/api/forge/tokens/write", { op: "create", name: String(fd.get("name") ?? ""), scopes, days: Number(fd.get("days") ?? 30) });
    if (button) button.disabled = false;
    if (!out.ok) {
      made.replaceChildren(toDom(h("p", { class: "warning" }, problemOf(out.body))));
      return;
    }
    const b = out.body as { token: string; name: string; expires_at: string };
    made.replaceChildren(toDom(madeToken(b.token, b.name, b.expires_at)));
    wireCopy(made);
    form.reset();
    if (days) days.value = days.dataset.default ?? "30";
    await draw();
    made.scrollIntoView({ block: "nearest" });
  });
}

if (typeof document !== "undefined") void draw();
