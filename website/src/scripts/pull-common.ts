// What the pull request and fork pages share (night phase 04, E3): who is reading (the signed-in
// hint cookie; the session's CSRF token and GitHub login, asked of the Worker once per page and only
// when an action or "@me" needs them), one action confirmed and started (the Worker's own sentence,
// forge-client.ts), and a file's text read raw (not counted in the reader's GitHub quota).
//
// Like every browser script, it never names the platform.

import { maskEmails } from "../../worker/forge/mask.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import type { Declared } from "../lib/pull-view.ts";
import { el } from "./code-editor.ts";
import { showConfirm, startAction } from "./forge-client.ts";
import { type CodeEnv, repoRef } from "./repo-code.ts";

const HINT = "__Host-oscr_signed_in=1";

/** Whether the reader is signed in, as the hint cookie says (no request). */
export const signedInHint = (): boolean => typeof document !== "undefined" && document.cookie.split(/;\s*/).includes(HINT);

export type Me = { csrf: string; login: string | null } | { message: string; signIn: boolean };

let me: Promise<Me> | null = null;

/** The session's CSRF token and the reader's GitHub login (GET /api/account/me), asked once per page. */
export function whoIsHere(): Promise<Me> {
  me ??= (async (): Promise<Me> => {
    if (!signedInHint()) return { message: "Sign in with GitHub to act here: the registry acts as you, with your own GitHub account, one authorization at a time.", signIn: true };
    try {
      const res = await fetch("/api/account/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
      const body = ((await res.json().catch(() => ({}))) ?? {}) as { signed_in?: boolean; csrf?: unknown; handles?: { github?: unknown } };
      if (!body.signed_in || typeof body.csrf !== "string") return { message: "Sign in with GitHub to act here.", signIn: true };
      return { csrf: body.csrf, login: typeof body.handles?.github === "string" ? body.handles.github : null };
    } catch {
      return { message: "The registry could not be reached: check the connection, then try again.", signIn: false };
    }
  })();
  return me;
}

/** A sentence that asks the reader to sign in, with the link. */
export function signInLine(text: string): HTMLElement {
  return el("p", {}, `${text} `, el("a", { href: "/account/" }, "Sign in"));
}

/** One action: the Worker's own sentence confirmed in `box`, then GitHub. A problem is said there. */
export async function confirmAction(box: HTMLElement, d: Declared | { problem: string }, keep: { drafts?: string[] } = {}): Promise<void> {
  if ("problem" in d) {
    box.replaceChildren(el("p", { class: "warning" }, d.problem));
    box.scrollIntoView({ block: "nearest" });
    return;
  }
  const who = await whoIsHere();
  if ("message" in who) {
    box.replaceChildren(who.signIn ? signInLine(who.message) : el("p", { class: "warning" }, who.message));
    return;
  }
  showConfirm(box, d.sentence, () => startAction(d.input, d.sentence, { csrf: who.csrf }, keep));
  box.scrollIntoView({ block: "nearest" });
}

/** A text file at a commit, masked as the viewer shows it; null when it cannot be read (raw read). */
export async function textAt(env: CodeEnv, rev: string, path: string, max = 1024 * 1024): Promise<string | null> {
  try {
    const f = await env.session.git.readFile(repoRef(env), rev, path, { maxBytes: max });
    return f.binary || f.lfs ? null : utf8Text(f.bytes);
  } catch {
    return null;
  }
}

export const masked = (s: string): string => maskEmails(s);
