// /forge/authorized/, in the reader's browser: the page GitHub sends the tab back to after one
// authorized action (D00-4; the design's §10.2 step 3), and after an installation of the App.
//
// 1. The address's code and state are removed at once (`history.replaceState`), before anything
//    else runs: they never stay in the history, a bookmark or a shared link (the page also sends no
//    Referer: public/_headers).
// 2. The action this tab confirmed is taken from sessionStorage (forge-client.ts `takePending`),
//    and {code, state, payload} is posted to /api/forge/act.
// 3. The outcome is said in words, with a link back to the page the action started from.
// An installation's return (installation_id, setup_action) says what GitHub did and offers the link
// page with that installation preselected; with an action waiting, that action is declared again
// for an ordinary authorization (forge-client.ts `resumeAction`); a return with no action waiting in this tab says what
// happened and what to do. Nothing is written as HTML; the page never names the platform.

import { stashAnswer } from "../lib/release-stash.ts";
import {
  completeAction,
  completeUpload,
  indexedFiles,
  dropDrafts,
  localStore,
  hasReturn,
  installationOutcome,
  outcomeOf,
  readReturn,
  render,
  resumeAction,
  sessionStore,
  takePending,
  type ClientDeps,
  type Outcome,
} from "./forge-client.ts";

const START_AGAIN = { href: "/repositories/", text: "Your repositories" };

/** Everything the page says for a return whose address was `search`. */
export async function arrive(search: string, deps: ClientDeps = {}): Promise<Outcome[]> {
  const ret = readReturn(search);
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  const storage = deps.storage === undefined ? sessionStore() : deps.storage;
  const installed = installationOutcome(ret);

  if (!hasReturn(search)) {
    return [
      {
        tone: "",
        text: ["This page receives GitHub's answer after you confirm an action on a repository. Nothing is waiting here."],
        links: [START_AGAIN],
      },
    ];
  }

  // The person did not authorize on GitHub (or GitHub refused): nothing to carry out.
  if (ret.error) {
    const pending = takePending(storage, now);
    const back = typeof pending === "object" ? pending.back : "/repositories/";
    return [
      {
        tone: "warning",
        text: [
          ret.error === "access_denied"
            ? "You did not authorize the action on GitHub: nothing was done."
            : "GitHub did not authorize the action: nothing was done. Go back to the page, then try again.",
        ],
        links: [{ href: back, text: "Back to the page you came from" }],
      },
    ];
  }

  const pending = takePending(storage, now);
  if (typeof pending !== "object") {
    const out: Outcome[] = installed ? [installed] : [];
    if (ret.code || ret.state) {
      out.push({
        tone: installed ? "" : "warning",
        text: [
          pending === "expired"
            ? "GitHub sent you back, but the action you confirmed waited more than ten minutes: nothing was done. Go back to the page, then start it again."
            : installed
              ? "No other action was waiting in this tab: nothing else was done."
              : "GitHub sent you back, but this tab holds no action waiting for it (it was confirmed in another tab or browser, or already carried out): nothing was done. Go back to the page, then start the action again.",
        ],
        links: installed ? [] : [START_AGAIN],
      });
    }
    return out.length ? out : [{ tone: "", text: ["Nothing is waiting here."], links: [START_AGAIN] }];
  }

  // Back from installing the App with an action waiting: the same action is authorized again the
  // ordinary way (GitHub's authorization page, with PKCE), whatever GitHub added to the address: a
  // code from the installation page was not asked with a PKCE challenge, so it is never used (D01-20).
  if (installed && ret.setupAction !== "request" && pending.start) {
    const again = await resumeAction(pending, deps);
    if (again.ok) {
      return [installed, { tone: "", text: ["Carrying on with the action you confirmed: GitHub asks for your authorization, then sends you back here."], links: [] }];
    }
    return [installed, { tone: "warning", text: [again.message], links: [{ href: pending.back, text: "Back to the page you came from" }] }];
  }

  if (!ret.code || !ret.state) {
    const out: Outcome[] = installed ? [installed] : [];
    out.push({
      tone: "warning",
      text: ["GitHub came back without an authorization for the action you confirmed: nothing was done. Go back to the page, then start it again."],
      links: [{ href: pending.back, text: "Back to the page you came from" }],
    });
    return out;
  }

  // Phase 07: a release asset's file waited in the tab's IndexedDB; it goes to the asset route.
  let res: Awaited<ReturnType<typeof completeAction>>;
  if (pending.kind === "asset_upload") {
    const files = deps.files === undefined ? indexedFiles() : deps.files;
    const file = files ? await files.take(pending.digest) : null;
    if (!file) {
      return [
        {
          tone: "warning",
          text: ["The file you chose was not kept in this tab for GitHub's return (a private window, another tab, or more than ten minutes): nothing was done. Go back to the release, then attach it again."],
          links: [{ href: pending.back, text: "Back to the page you came from" }],
        },
      ];
    }
    res = await completeUpload(ret, pending, file, deps);
  } else res = await completeAction(ret, pending, deps);
  // A commit made: the editor's drafts it carried are dropped (phase 03); kept on any failure, so
  // the change is still there when the person goes back.
  if (res?.status === 200 && pending.drafts?.length) dropDrafts(pending.drafts, deps.local === undefined ? localStore() : deps.local);
  // Phase 07: the draft releases GitHub showed the person, or the one just saved, kept in the tab for
  // the releases page (masked texts as the Worker answered them; never a token).
  if (res?.status === 200) stashAnswer(pending.kind, res.body.result, storage, now);
  const outcome = outcomeOf(res, pending);
  return installed ? [installed, outcome] : [outcome];
}

async function main(): Promise<void> {
  const search = location.search;
  // At once, before anything else: the code and the state leave the address bar.
  if (hasReturn(search)) history.replaceState(null, "", location.pathname);
  const root = document.getElementById("forge-outcome");
  if (!root) return;
  const busy = document.createElement("p");
  busy.textContent = "Carrying out the action you confirmed…";
  if (/[?&]code=/.test(search)) root.replaceChildren(busy);
  render(root, await arrive(search));
}

if (typeof document !== "undefined" && typeof location !== "undefined") void main();
