// security/: the Security (and quality) tab of a repository (night phase 11, E1; docs/SECURITY_QUALITY.md).
// It reads the registry's security layer (GET /api/forge/security: the dependency graph the Mac computed
// from the environment files, read as text, never run) and shows it, with search, filters and "show
// paths". Signed out, it asks to sign in (the analysis is a signed-in view, budget §15.6). Later
// elements of phase 11 add the alerts, the code scanning and the licence compatibility here.
//
// Like every browser script, it never names the platform.

import { advisoryItem, depsList, filterDeps, securityView, type AdvisoryView, type DepFilter, type DepView, type SecurityAnswer } from "../lib/security-view.ts";
import { spdxDocument } from "../lib/sbom.ts";
import { h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { getJson, postJson } from "./social-client.ts";
import { codeViews, type CodeEnv } from "./repo-code.ts";

async function load(env: CodeEnv): Promise<SecurityAnswer | number> {
  const id = env.layer?.id ?? env.info.key.id;
  try {
    const r = await fetch(`/api/forge/security?id=${encodeURIComponent(`${env.info.key.forge}:${id}`)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!r.ok) return r.status;
    return (await r.json()) as SecurityAnswer;
  } catch {
    return 0;
  }
}

/** Read the filter from one section's form. */
function readFilter(form: HTMLFormElement): DepFilter {
  const value = (name: string): string => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
  const kind = value("kind");
  return {
    query: value("q"),
    ecosystem: value("ecosystem"),
    scope: value("scope"),
    kind: kind === "direct" || kind === "transitive" ? kind : "all",
  };
}

/** Wire one Dependencies section's form to its list (re-rendered on each change). */
function wireSection(section: HTMLElement, deps: DepView[]): void {
  const form = section.querySelector<HTMLFormElement>("form.dep-filter");
  const listBox = section.querySelector<HTMLElement>(".dep-list");
  if (!form || !listBox) return;
  const render = (): void => {
    const kept = filterDeps(deps, readFilter(form));
    listBox.replaceChildren(toDom(depsList(kept)));
  };
  form.addEventListener("input", render);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    render();
  });
}

codeViews.security = async (slot, env) => {
  show(slot, h("div", { class: "security" }, h("h2", null, "Security and quality"), h("p", { "aria-live": "polite" }, "Reading the security layer…")));
  const answer = await load(env);
  if (answer === 401) {
    show(slot, h("div", { class: "security" },
      h("h2", null, "Security and quality"),
      h("p", null, "Sign in to see this repository's dependency graph and its security analysis."),
    ));
    return;
  }
  if (typeof answer === "number") {
    show(slot, h("div", { class: "security" },
      h("h2", null, "Security and quality"),
      h("p", { class: "warning" }, answer === 404 ? "The registry does not know this repository, or it is not public." : "The security layer could not be read just now."),
    ));
    return;
  }
  render(slot, answer, env);
};

function render(slot: HTMLElement, answer: SecurityAnswer, env: CodeEnv): void {
  slot.replaceChildren(toDom(securityView(answer)));
  const bySnapshot: Record<string, DepView[]> = {
    default: answer.dependencies.default,
    cited: answer.dependencies.cited,
  };
  for (const section of slot.querySelectorAll<HTMLElement>("section.security-deps")) {
    wireSection(section, bySnapshot[section.dataset.snapshot ?? "default"] ?? []);
  }
  if (answer.mayTriage) wireTriage(slot, answer, env);
  wireSbom(slot, answer, env);
  void wireReporting(slot, answer, env);
}

const repoId = (env: CodeEnv): string => `${env.info.key.forge}:${env.layer?.id ?? env.info.key.id}`;

/** The private vulnerability reports: list the ones the reader may see, and wire the open form. */
async function wireReporting(slot: HTMLElement, answer: SecurityAnswer, env: CodeEnv): Promise<void> {
  const list = slot.querySelector<HTMLElement>(".advisory-list");
  const form = slot.querySelector<HTMLFormElement>("form.advisory-form");
  const id = repoId(env);
  const refresh = async (): Promise<void> => {
    if (!list) return;
    const r = await getJson(`/api/forge/advisory?id=${encodeURIComponent(id)}`);
    const advisories = (r.ok && Array.isArray((r.body as { advisories?: unknown }).advisories) ? (r.body as { advisories: AdvisoryView[] }).advisories : []);
    list.replaceChildren(
      advisories.length
        ? toDom(h("ul", { class: "advisories" }, ...advisories.map(advisoryItem)))
        : toDom(h("p", { class: "muted" }, "No vulnerability report you may see.")),
    );
    for (const button of list.querySelectorAll<HTMLButtonElement>("button.advisory-open")) {
      button.addEventListener("click", () => void openThread(list, id, button.dataset.ref ?? ""));
    }
  };
  await refresh();
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = (name: string): string => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
    const title = value("title").trim();
    if (!title) return;
    const res = await postJson(`/api/forge/advisory/open?id=${encodeURIComponent(id)}`, { title, severity: value("severity"), affected: value("affected"), summary: value("summary") });
    if (res.ok) {
      form.reset();
      const details = form.closest("details");
      if (details) details.open = false;
      await refresh();
    }
  });
}

/** Expand one advisory's private thread under its list item. */
async function openThread(list: HTMLElement, id: string, ref: string): Promise<void> {
  if (!ref) return;
  const item = list.querySelector<HTMLElement>(`li.advisory[data-ref="${ref}"]`);
  if (!item) return;
  const existing = item.querySelector(".advisory-thread");
  if (existing) { existing.remove(); return; }
  const r = await getJson(`/api/forge/advisory?id=${encodeURIComponent(id)}&ref=${encodeURIComponent(ref)}`);
  const adv = r.ok ? (r.body as { advisory?: AdvisoryView }).advisory : undefined;
  const box = document.createElement("div");
  box.className = "advisory-thread";
  if (!adv) {
    box.append(toDom(h("p", { class: "warning" }, "This report is private.")));
  } else {
    const thread = adv.thread ?? [];
    box.append(toDom(h("div", null,
      adv.summary ? h("p", null, adv.summary) : null,
      adv.cve ? h("p", { class: "muted" }, `CVE: ${adv.cve}`) : null,
      thread.length ? h("ul", { class: "advisory-posts" }, ...thread.map((p) => h("li", null, h("strong", null, p.author), " ", h("span", null, p.body)))) : h("p", { class: "muted" }, "No message yet."),
    )));
  }
  item.append(box);
}

/** The "Download SBOM (SPDX)" button: build the SPDX JSON here from the dependency graph and hand it
 *  to the reader as a file. Nothing of the code is sent anywhere. */
function wireSbom(slot: HTMLElement, answer: SecurityAnswer, env: CodeEnv): void {
  const button = slot.querySelector<HTMLButtonElement>("button.sbom-download");
  if (!button) return;
  button.addEventListener("click", () => {
    const name = `${answer.repo.owner}/${answer.repo.name}`;
    const doc = spdxDocument(name, `https://spdx.org/oscr/${answer.repo.forge}/${answer.repo.id}`, answer.dependencies.default, {
      repoLicence: answer.licence?.spdx || undefined,
      created: new Date().toISOString(),
    });
    const blob = new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${answer.repo.owner}-${answer.repo.name}.spdx.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

/** The dismiss/reopen buttons: a POST, then the whole view is read again. */
function wireTriage(slot: HTMLElement, answer: SecurityAnswer, env: CodeEnv): void {
  const id = `${env.info.key.forge}:${env.layer?.id ?? env.info.key.id}`;
  for (const button of slot.querySelectorAll<HTMLButtonElement>(".alert-actions button[data-op]")) {
    button.addEventListener("click", async () => {
      const { kind, ref, op, reason } = button.dataset;
      button.disabled = true;
      try {
        const res = await postJson(`/api/forge/security/triage?id=${encodeURIComponent(id)}`, { op, kind, ref, reason: reason ?? "" });
        if (res.ok) {
          const fresh = await load(env);
          if (typeof fresh !== "number") {
            render(slot, fresh, env);
            return;
          }
        }
      } catch {
        // fall through to re-enable
      }
      button.disabled = false;
    });
  }
}
