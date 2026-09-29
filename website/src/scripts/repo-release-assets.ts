// A release's files, attached and deleted as the person (night phase 07, E5; docs/RELEASES.md; D00-9):
// the release page's form (repo-releases.ts `assetUpload.mount`).
//
// Attaching a file is ONE authorized action (act-releases.ts `asset_upload`): the page reads the file
// in the browser (its size, its SHA-256 with WebCrypto: the file does not leave the computer for that),
// confirms {release, name, label, size, sha256, contentType}, keeps the file in the tab's IndexedDB
// (forge-client.ts `indexedFiles`), and goes to GitHub's authorization; the callback page then posts
// the file itself to the registry's asset route, which streams it to GitHub as the person (≤ 25 MiB,
// never parsed); GitHub computes its SHA-256 again, and a file that is not the one confirmed is removed.
// Larger files go on GitHub's own release page (up to 2 GiB), or to Zenodo or Hugging Face, said with
// the reason. Deleting a file is one authorization too, its name typed.
//
// Like every browser script, it never names the platform.

import { ASSET_UPLOAD_BYTES } from "../../worker/forge/service/caps.ts";
import type * as T from "../../worker/forge/types.ts";
import { apiStart } from "../lib/forge.ts";
import { declarePull } from "../lib/pull-view.ts";
import { newReleaseWebUrl, releasePath, releasesPath, releaseWebUrl, sizeInWords } from "../lib/releases.ts";
import { indexedFiles } from "./forge-client.ts";
import { confirmAction, el } from "./pull-common.ts";
import type { CodeEnv } from "./repo-code.ts";
import { assetUpload } from "./repo-releases.ts";

const MiB = 2 ** 20;

/** The file's type as GitHub takes it: "type/subtype", its parameters dropped. */
export const contentTypeOf = (file: { type: string }): string => {
  const t = (file.type || "").split(";")[0].trim().toLowerCase();
  return /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/.test(t) ? t : "application/octet-stream";
};

async function sha256(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mount(slot: HTMLElement, env: CodeEnv, release: T.Release): void {
  const where = release.draft ? releasesPath(env.repo) : releasePath(env.repo, release.tagName);
  const repo = { ...env.repo, id: env.info.key.id };
  if (release.immutable) {
    slot.replaceChildren(el("p", { class: "explain" }, "GitHub locks the files of this release: it is immutable, so a citation of it keeps meaning the same files."));
    return;
  }
  const input = el("input", { type: "file", id: "asset-file" });
  const label = el("input", { type: "text", id: "asset-label", maxlength: "255", placeholder: "what it is: “Source data of Figure 2”" });
  const go = el("button", { type: "button", id: "asset-go" }, "Attach");
  const said = el("div", { "aria-live": "polite" });
  const big = el(
    "p",
    { class: "explain" },
    `Up to ${ASSET_UPLOAD_BYTES / MiB} MiB through the registry. A larger file goes `,
    el("a", { href: release.draft ? newReleaseWebUrl(env.repo, release.tagName) : releaseWebUrl(env.repo, release.tagName) }, "on GitHub's own release page"),
    " (up to 2 GiB: the registry streams nothing that large within its limits), or, for data, to Zenodo or Hugging Face with a DOI.",
  );
  const parts: (HTMLElement | string)[] = [
    el("h4", {}, "Attach a file"),
    el("p", {}, el("label", { for: "asset-file" }, "The file "), input),
    el("p", {}, el("label", { for: "asset-label" }, "Its label "), label, " ", go),
    big,
    el("p", { class: "explain" }, "Its SHA-256 is computed in your browser first; GitHub computes it again when the file arrives, and a file that is not the one you confirmed is removed."),
    said,
  ];
  if (release.assets.length) {
    const pick = el("select", { id: "asset-delete" }, ...release.assets.map((a) => el("option", { value: a.id }, a.name)));
    const typed = el("input", { type: "text", id: "asset-delete-confirm", autocomplete: "off", spellcheck: "false", placeholder: "its name, to confirm" });
    const del = el("button", { type: "button", id: "asset-delete-go" }, "Delete it");
    parts.push(el("p", {}, el("label", { for: "asset-delete" }, "Delete the file "), pick, " ", typed, " ", del));
    del.addEventListener("click", () => {
      void confirmAction(said, declarePull(repo, "asset_delete", { release: release.id, id: pick.value, confirm: typed.value.trim() }, where));
    });
  }
  slot.replaceChildren(el("section", { class: "asset-form" }, ...parts));
  go.addEventListener("click", async () => {
    const file = input.files?.[0];
    if (!file) {
      said.replaceChildren(el("p", { class: "warning" }, "Choose a file first."));
      return;
    }
    if (file.size > ASSET_UPLOAD_BYTES) {
      said.replaceChildren(el("p", { class: "warning" }, `${file.name} is ${sizeInWords(file.size)}: larger than the registry passes to GitHub. Attach it on GitHub's own release page (the link above), or deposit the data on Zenodo or Hugging Face.`));
      return;
    }
    said.replaceChildren(el("p", {}, `Reading ${file.name} (${sizeInWords(file.size)}) to compute its SHA-256…`));
    const payload: Record<string, unknown> = { release: release.id, name: file.name, size: file.size, sha256: await sha256(file), contentType: contentTypeOf(file) };
    if (label.value.trim()) payload.label = label.value.trim();
    const declared = declarePull(repo, "asset_upload", payload, where);
    if ("problem" in declared) {
      said.replaceChildren(el("p", { class: "warning" }, declared.problem));
      return;
    }
    // The file waits in the tab while GitHub authorizes: keyed by the action's own digest.
    const files = indexedFiles();
    const { body } = await apiStart(declared.input);
    if (!files || !(await files.put(body.digest, file))) {
      said.replaceChildren(el("p", { class: "warning" }, "This browser keeps no file for GitHub's return (a private window, or site data blocked): attach it on GitHub's own release page (the link above)."));
      return;
    }
    void confirmAction(said, declared);
  });
}

assetUpload.mount = mount;
