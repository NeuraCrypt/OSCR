// The environment a release carries, and the packages a repository publishes (night phase 07, E6;
// docs/RELEASES.md "Environments", "Packages"): the release page's Environment panel (repo-releases.ts
// `releaseExtras`) and the view environment/<ref> (the default branch when no ref is named).
//
// Read in the reader's browser, on the reader's own quota: the tree at the release's commit (1
// request), then each environment file raw (not counted), at most MAX_FILES of MAX_BYTES each; parsed
// as data by src/lib/environments.ts, never built, installed or run (D00-11). The panel says what each
// file pins in words, where the code can run under the visitor's own account and quota (Binder,
// GitHub Codespaces: plain links, each saying who runs it), and the packages the manifests declare:
// with their registry and an install line at the declared version, "declared by the repository" until
// a person who may push confirms or declines each one (act-packages.ts, one authorization).
//
// Everything is text nodes or view trees, masked for email addresses; like every browser script, it
// never names the platform.

import { maskEmails } from "../../worker/forge/mask.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import {
  environmentFiles,
  installLine,
  openElsewhere,
  packagesOf,
  readEnvironment,
  REGISTRY_WORDS,
  registryUrl,
  type DeclaredPackage,
  type EnvReport,
} from "../lib/environments.ts";
import { repoPath } from "../lib/forge.ts";
import { declarePull } from "../lib/pull-view.ts";
import { type El, h } from "../lib/repo-view.ts";
import { refSegments } from "../lib/code-nav.ts";
import { show, toDom } from "./dom.ts";
import { confirmAction, signedInHint } from "./pull-common.ts";
import { type CodeEnv, codeViews, copy, failed, repoRef, resolveRef } from "./repo-code.ts";
import { releaseExtras } from "./repo-releases.ts";

/** Environment files read at most, and the bytes of each. */
export const MAX_FILES = 12;
export const MAX_BYTES = 512 * 1024;

interface Recorded {
  registry: string;
  name: string;
  status: "confirmed" | "declined";
}

/** The packages a person confirmed or declined, as the layer says (signed in: live; else last night's). */
function recorded(env: CodeEnv): Recorded[] {
  const out: Recorded[] = [];
  for (const p of Array.isArray(env.layer?.packages) ? env.layer.packages : []) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    if (typeof r.registry !== "string" || typeof r.name !== "string") continue;
    out.push({ registry: r.registry, name: r.name, status: r.status === "declined" ? "declined" : "confirmed" });
  }
  return out;
}

const checkList = (r: EnvReport): El | null =>
  r.checks.length ? h("ul", { class: "env-checks" }, ...r.checks.map((c) => h("li", { class: c.tone || null }, c.words))) : null;

/** The panel at a commit: the files, their readings, where it runs, the packages. */
async function panel(slot: HTMLElement, env: CodeEnv, commit: string, label: string): Promise<void> {
  show(slot, h("h3", null, "Environment"), h("p", { "aria-live": "polite" }, "Reading the environment files…"));
  let tree: T.Tree;
  try {
    tree = await env.session.git.tree(repoRef(env), commit, { recursive: true });
  } catch (e) {
    show(slot, h("h3", null, "Environment"));
    const b = document.createElement("div");
    slot.append(b);
    failed(b, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/tree/${commit}`, "files");
    return;
  }
  const files = environmentFiles(tree.entries.filter((e) => e.type === "blob").map((e) => e.path));
  const read = await Promise.all(
    files.slice(0, MAX_FILES).map(async (f) => {
      try {
        const got = await env.session.git.readFile(repoRef(env), commit, f.path, { maxBytes: MAX_BYTES });
        const text = got.binary || got.lfs ? "" : utf8Text(got.bytes);
        return { file: f, text, report: readEnvironment(f, text) };
      } catch {
        return { file: f, text: "", report: { ...readEnvironment(f, ""), summary: `${f.path}: could not be read (larger than ${MAX_BYTES / 1024} KiB, or GitHub did not answer)` } };
      }
    }),
  );
  const elsewhere = openElsewhere(env.repo, label, files);
  const declared = packagesOf(read.map((x) => ({ path: x.file.path, kind: x.file.kind, text: x.text })));
  const known = recorded(env);
  const signedIn = signedInHint();
  const commitShort = commit.slice(0, 7);
  show(
    slot,
    h("h3", null, "Environment"),
    h("p", { class: "explain" }, `Read as text at ${label} (commit ${commitShort}): nothing of it is built, installed or run by the registry.`),
    files.length
      ? h(
          "ul",
          { class: "env-files" },
          ...read.map((x) =>
            h("li", null, h("p", null, h("a", { href: repoPath(env.repo, "blob", refSegments(commit, x.file.path)) }, h("code", null, x.file.path)), ` — ${maskEmails(x.report.summary)}`), checkList(x.report)),
          ),
        )
      : h("p", null, "No environment file at this commit: nothing says which versions of the software the results were made with. A requirements.txt, an environment.yml, a renv.lock or a Project.toml would."),
    files.length > MAX_FILES ? h("p", { class: "explain" }, `The first ${MAX_FILES} of ${files.length} files are read.`) : null,
    h("h4", null, "Where it can run again"),
    h("ul", { class: "env-elsewhere" }, ...elsewhere.map((o) => h("li", null, h("a", { href: o.url }, o.service), `: ${o.who}`))),
    ...packagesBlock(declared, known, signedIn),
    h("div", { id: "package-act", "aria-live": "polite" }),
  );
  for (const b of slot.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    b.addEventListener("click", () => void copy(b.dataset.copy ?? "", b, "Copy"));
  }
  const act = slot.querySelector<HTMLElement>("#package-act");
  for (const b of slot.querySelectorAll<HTMLButtonElement>("button[data-package]")) {
    b.addEventListener("click", () => {
      const p = declared[Number(b.dataset.package)];
      if (!p || !act) return;
      const payload = { registry: p.registry, name: p.name, version: p.version ?? "", source: p.source, confirm: b.dataset.confirm === "yes" };
      void confirmAction(act, declarePull({ ...env.repo, id: env.info.key.id }, "package_confirm", payload, repoPath(env.repo, "environment")));
    });
  }
}

/** The packages: declared by the manifests, confirmed or declined by a person who may push. */
function packagesBlock(declared: readonly DeclaredPackage[], known: readonly Recorded[], signedIn: boolean): El[] {
  const out: El[] = [h("h4", null, "Packages")];
  const confirmedOnly = known.filter((k) => k.status === "confirmed" && !declared.some((d) => d.registry === k.registry && d.name.toLowerCase() === k.name.toLowerCase()));
  if (!declared.length && !confirmedOnly.length) {
    out.push(h("p", { class: "explain" }, "The manifests declare no package (a pyproject.toml, a DESCRIPTION, a Project.toml, a package.json or a conda recipe would). The registry hosts none: packages stay at their public registry."));
    return out;
  }
  const items: El[] = declared.map((p, i) => {
    const said = known.find((k) => k.registry === p.registry && k.name.toLowerCase() === p.name.toLowerCase());
    const status = said?.status === "confirmed" ? h("span", { class: "state ok" }, "confirmed by a person who may push") : said?.status === "declined" ? h("span", { class: "state warning" }, "declined: not published by this repository") : h("span", { class: "state" }, `declared by ${p.source}`);
    const line = installLine(p);
    return h(
      "li",
      null,
      h("p", null, h("a", { href: registryUrl(p) }, `${p.name}${p.version ? ` ${p.version}` : ""}`), ` on ${REGISTRY_WORDS[p.registry]} — `, status),
      said?.status === "declined" ? null : h("p", null, h("code", { class: "install" }, line), " ", h("button", { type: "button", "data-copy": line }, "Copy")),
      signedIn && !said ? h("p", null, h("button", { type: "button", "data-package": String(i), "data-confirm": "yes" }, "Confirm it"), " ", h("button", { type: "button", "data-package": String(i), "data-confirm": "no" }, "Decline it")) : null,
    );
  });
  for (const k of confirmedOnly) {
    items.push(h("li", null, h("p", null, `${k.name} on ${k.registry in REGISTRY_WORDS ? REGISTRY_WORDS[k.registry as keyof typeof REGISTRY_WORDS] : k.registry} — `, h("span", { class: "state ok" }, "confirmed"), " (no manifest at this commit declares it)")));
  }
  out.push(h("ul", { class: "env-packages" }, ...items));
  out.push(h("p", { class: "explain" }, "The install lines name the version the manifest declares at this commit. A package stays at its registry: the registry hosts none."));
  return out;
}

// The release page's panel, at the release's commit (its tag).
releaseExtras.push(async (slot, env, release, commit) => {
  const box = document.createElement("section");
  box.className = "env-panel";
  slot.append(box);
  const at = commit ?? (/^[0-9a-f]{40}$/.test(release.target) ? release.target : null);
  if (!at) {
    try {
      const sha = await env.session.git.resolve(repoRef(env), release.target || env.info.defaultBranch || "HEAD");
      await panel(box, env, sha, release.target || "the draft's branch");
    } catch (e) {
      failed(box, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}`, "files");
    }
    return;
  }
  await panel(box, env, at, release.draft ? `the draft's commit` : release.tagName);
});

// environment/<ref>: the same panel at a branch, a tag or a commit.
codeViews.environment = async (slot, env) => {
  const segments = env.target.rest?.length ? env.target.rest : env.info.defaultBranch ? refSegments(env.info.defaultBranch) : [];
  if (!segments.length) {
    show(slot, h("h2", null, "Environment"), h("p", null, "The repository is empty: no environment yet."));
    return;
  }
  try {
    const { ref, commit } = await resolveRef(env, segments);
    show(slot, h("div", { class: "code-head" }, h("h2", null, "Environment"), h("p", { class: "file-actions" }, h("a", { href: repoPath(env.repo, "releases") }, "Releases"))));
    const box = document.createElement("section");
    box.className = "env-panel";
    slot.append(box, toDom(h("p", { class: "explain" }, "A release carries its own environment: its page shows the files at its tag.")));
    await panel(box, env, commit, ref.ref);
  } catch (e) {
    failed(slot, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}`, "files");
  }
};
