// What phase 10's writes share (night phase 10: tokens.ts, hooks.ts, statuses.ts): the body read as
// JSON within a size, who may write (FORGE_OPEN), the account's cap for the kind and the day's rows,
// then ONE batch with its action row. The same rules as the social writes (social.ts), for the kinds
// `token`, `hook` and `status` (types.ts AUTOMATION_KINDS; caps.ts `automation`, `statuses`).

import type { SignedIn } from "../../account/guard.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { readCapped } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { linkedGithub } from "./identity.ts";
import { actionRow, newNonce, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type AutomationKind, type ForgeRequest, type Write } from "./types.ts";

/** A POST's JSON body, at most `max` bytes; a problem in words otherwise. */
export async function readJsonBody(r: ForgeRequest, max: number): Promise<unknown | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return new ForgeProblem(400, "bad_payload", "The request is not JSON.");
  const text = await readCapped(r.request, max);
  if (text === null) return new ForgeProblem(413, "too_large", `This request is larger than the registry reads (${Math.round(max / 1024)} KiB).`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return new ForgeProblem(400, "bad_payload", "The request is not readable.");
  }
}

/** Who may write (FORGE_OPEN: until phase 16, the owner only), the account's cap for this kind, the
 *  day's rows: the problem, or the linked GitHub account's id ("" without one) for the action row. */
export async function mayAutomate(r: ForgeRequest, s: SignedIn, kind: AutomationKind, rows: number): Promise<ForgeProblem | { github: string }> {
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  const caps = await dailyCaps(r.db, s.user.id, kind, r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, Math.min(rows, FORGE_ROWS_PER_DAY))) ?? { github: github ?? "" };
}

/** The writes and their action row, in ONE batch: the rows written, the action's own included. */
export async function commitAutomation(
  r: ForgeRequest,
  s: SignedIn,
  kind: AutomationKind,
  github: string,
  writes: Write[],
  subject: string,
  repo: { forge: string; repoId: string } | null = null,
): Promise<number> {
  const action = actionRow(r.db, {
    userId: s.user.id,
    t: r.t,
    nonce: newNonce(),
    kind,
    forge: repo?.forge ?? "",
    repoId: repo?.repoId ?? "",
    githubUser: github,
    outcome: "done",
    rows: 1 + rowsOf(writes),
    subject,
  });
  await r.db.batch([...statements(writes), action.stmt]);
  return 1 + rowsOf(writes);
}
