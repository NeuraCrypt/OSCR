// /organizations/: the reader's organizations and invitations, and a create form (night phase 09, E1
// and E2). Reads GET /api/forge/orgs; creates with POST /api/forge/org/create; accepts or declines an
// invitation with POST /api/forge/org/members. Like every browser script, it never names the platform.

import { h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { signInLine } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn } from "./social-client.ts";

const shell = document.getElementById("orgs-shell");

interface OrgItem { id: string; handle: string; displayName: string; kind: string; myRole?: string }
interface InviteItem { orgId: string; id: string; handle: string; role: string; expiresAt: number; expired: boolean }
interface Listing { organizations: OrgItem[]; invitations: InviteItem[]; can: { create: boolean } }

const KINDS = ["lab", "group", "department", "institution", "project", "other"];

async function draw(): Promise<void> {
  if (!shell) return;
  const status = shell.querySelector(".summary");
  const list = document.getElementById("orgs-list")!;
  const invites = document.getElementById("invitations")!;
  const make = document.getElementById("orgs-make")!;
  if (!signedIn()) {
    status?.replaceChildren("Sign in to see and create organizations.");
    show(list, signInLine("Your organizations are your account's:"));
    return;
  }
  const r = await getJson("/api/forge/orgs");
  if (!r.ok) return void status?.replaceChildren(problemOf(r.body));
  const data = r.body as unknown as Listing;
  status?.replaceChildren(`${data.organizations.length} ${data.organizations.length === 1 ? "organization" : "organizations"}; ${data.invitations.length} ${data.invitations.length === 1 ? "invitation" : "invitations"}.`);

  // Invitations.
  show(invites, data.invitations.length
    ? h("ul", { class: "plain" }, ...data.invitations.map((i) =>
        h("li", null, `${i.handle} invites you as ${i.role}. `,
          i.expired ? h("span", { class: "muted" }, "(expired)") : h("span", null,
            h("button", { type: "button", "data-accept": `${i.orgId}:${i.id}` }, "Accept"), " ",
            h("button", { type: "button", "data-decline": `${i.orgId}:${i.id}` }, "Decline")))))
    : h("p", { class: "muted" }, "No invitations."));
  const answer = (attr: string, op: string) => {
    for (const b of invites.querySelectorAll<HTMLButtonElement>(`button[${attr}]`)) {
      b.addEventListener("click", async () => {
        const [id, inviteId] = (b.getAttribute(attr) ?? "").split(":");
        b.disabled = true;
        const out = await postJson("/api/forge/org/members", { id, op, inviteId });
        if (!out.ok) return void (b.disabled = false);
        await draw();
      });
    }
  };
  answer("data-accept", "accept");
  answer("data-decline", "decline");

  // The organizations.
  show(list, data.organizations.length
    ? h("dl", { class: "listing" }, ...data.organizations.flatMap((o) => [
        h("dt", null, h("a", { href: `/org/${o.handle}/` }, o.displayName || o.handle)),
        h("dd", null, h("span", { class: "muted" }, `${o.kind}${o.myRole ? `, you are ${o.myRole}` : ""}`)),
      ]))
    : h("p", { class: "muted" }, "You are in no organization yet."));

  // The create form.
  if (!data.can.create) {
    show(make, h("p", { class: "warning" }, "Creating an organization opens with the registry's content rules: until then, only its owner can."));
    return;
  }
  show(make,
    h("form", { id: "org-form" },
      h("p", null, h("label", { for: "org-handle" }, "Handle (letters, digits, hyphens) "), h("input", { id: "org-handle", name: "handle", required: "required", maxlength: "39" })),
      h("p", null, h("label", { for: "org-name" }, "Name "), h("input", { id: "org-name", name: "display_name", maxlength: "100" })),
      h("p", null, h("label", { for: "org-kind" }, "Kind "), h("select", { id: "org-kind", name: "kind" }, ...KINDS.map((k) => h("option", { value: k }, k)))),
      h("p", null, h("button", { type: "submit" }, "Create")),
    ),
    h("p", { id: "org-made", "aria-live": "polite" }),
  );
  const form = make.querySelector<HTMLFormElement>("#org-form");
  form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    const out = await postJson("/api/forge/org/create", { handle: String(fd.get("handle") ?? ""), display_name: String(fd.get("display_name") ?? ""), kind: String(fd.get("kind") ?? "lab") });
    if (button) button.disabled = false;
    const made = document.getElementById("org-made");
    if (!out.ok) return void made?.replaceChildren(toDom(h("span", { class: "warning" }, problemOf(out.body))));
    form.reset();
    await draw();
  });
}

if (typeof document !== "undefined") void draw();
