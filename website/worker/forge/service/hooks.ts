// Outgoing webhooks: the routes and the deliveries (night phase 10, E3; hooks-core.ts is what a hook is;
// docs/AUTOMATION.md "Webhooks").
//
//   GET  /api/forge/hooks              signed in  the reader's hooks, the events a subject offers, limits
//   GET  /api/forge/hooks/deliveries   signed in  ?id=: one of the reader's hooks, its last 7 days of deliveries
//   POST /api/forge/hooks/write        signed in  {op: "create", subject, url, events}: pinged first,
//                                                 active when the ping got 2xx; its secret answered ONCE
//                                                 (4 rows: the hook, its index entry, the ping's
//                                                 delivery, the action row)
//                                                 {op: "update", id, events?, active: false}: 1 + 1
//                                                 {op: "ping", id}: again, and active when it answers 2xx
//                                                 {op: "redeliver", id, guid}: an event's delivery, again
//                                                 {op: "rotate", id}: a new secret, answered once (1 + 1)
//                                                 {op: "delete", id}: 2 + 1
// The public API serves the same (/api/v1/hooks, /hooks/deliveries, /hooks/write: hooks:read and
// hooks:write), through who.ts. Every write: FORGE_OPEN (until phase 16, the owner only), the
// account's `automation` cap (50 changes a day), the day's rows; pausing or deleting a hook is never
// refused by a cap or FORGE_OPEN (a person can always stop what posts in their name).
//
// Deliveries of events (`queueHooks`): after the batch that wrote an event (act.ts, research.ts,
// webhook.ts), in waitUntil: the subject's active hooks (hooks_subject: 1 query, 0 rows when there are
// none), the event row by its key (an event another path already wrote is not there twice: D08-6),
// then one POST per hook that wants it, retried within the request (after 1 s and 4 s, on no answer,
// a 5xx, 408 or 429; never on another 4xx or a redirection), at most HOOK_SENDS_PER_REQUEST sends in
// all. No Queues, no Cron Triggers: a delivery that failed three times waits for its person's
// redelivery. Each delivery is 1 row in hook_deliveries (the day's global count sees it; past the cap,
// the delivery is made and not logged). Ten failures in a row pause the hook (1 row).

import type { SignedIn } from "../../account/guard.ts";
import { commitAutomation, mayAutomate, readJsonBody } from "./automation.ts";
import { closed, globalCap, mayWrite } from "./gate.ts";
import { hiddenEventFilter } from "./hidden.ts";
import {
  deliveriesOf,
  deliveryInsert,
  deliveryView,
  eventPayload,
  eventsFor,
  eventsText,
  hookDelete,
  hookInsert,
  hookSecret,
  hooksOf,
  hooksOn,
  hookUpdate,
  hookUrl,
  hookView,
  HOOK_BODY_BYTES,
  HOOK_SENDS_PER_REQUEST,
  HOOK_TIMEOUT_MS,
  HOOKS_PER_ACCOUNT,
  HOOKS_PER_SUBJECT,
  newHookId,
  newSalt,
  PAUSE_AFTER_FAILURES,
  pingPayload,
  readEvents,
  RETRY_WAITS_MS,
  signDelivery,
  validateHook,
  wants,
  type DeliveryRow,
  type HookRow,
  type Payload,
} from "./hooks-core.ts";
import { eventByKey, type EventRow } from "./events.ts";
import { json, problemAnswer, redact } from "./http.ts";
import { actionRow, all, first, newNonce, repoByKey, statements } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type ForgeServiceEnv, type RepoRow, type Write } from "./types.ts";
import { who } from "./who.ts";
import { linkedGithub } from "./identity.ts";

// ─── sending ─────────────────────────────────────────────────────────────────

export interface Sent {
  ok: boolean;
  status: number;
  ms: number;
  words: string;
  /** Worth another attempt: no answer, a 5xx, 408 or 429. */
  retry: boolean;
  attempts: number;
}

export interface Sender {
  fetch: typeof fetch;
  /** Waits between attempts (tests pass none). */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  allowLocal: boolean;
  siteHost: string;
  /** Sends left in this request. */
  budget: { sends: number };
}

export function senderOf(r: ForgeRequest): Sender {
  return {
    fetch: r.deps.hookFetch ?? globalThis.fetch.bind(globalThis),
    sleep: r.deps.hookFetch ? async () => undefined : (ms) => new Promise((ok) => setTimeout(ok, ms)),
    now: () => Date.now(),
    allowLocal: (r.env.HOOKS_ALLOW_LOCAL ?? "") === "1",
    siteHost: r.url.hostname,
    budget: { sends: HOOK_SENDS_PER_REQUEST },
  };
}

/** One POST: the answer's status only (its body is never read), no redirection followed. */
async function sendOnce(s: Sender, url: string, body: string, headers: Record<string, string>): Promise<Omit<Sent, "attempts">> {
  const start = s.now();
  try {
    const res = await s.fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });
    void res.body?.cancel().catch(() => undefined);
    const ms = Math.max(0, s.now() - start);
    const st = res.status;
    if (st >= 200 && st < 300) return { ok: true, status: st, ms, words: "delivered", retry: false };
    if (st >= 300 && st < 400) return { ok: false, status: st, ms, words: "a redirection, not followed", retry: false };
    return { ok: false, status: st, ms, words: `the receiver answered ${st}`, retry: st >= 500 || st === 408 || st === 429 };
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { ok: false, status: 0, ms: Math.max(0, s.now() - start), words: timeout ? `no answer within ${HOOK_TIMEOUT_MS / 1000} seconds` : "the receiver could not be reached", retry: true };
  }
}

/** A delivery: signed, its address checked again, retried within the request while it is worth it. */
export async function deliver(s: Sender, hook: Pick<HookRow, "id" | "url">, secret: string, payload: Payload, retries = true): Promise<Sent> {
  const url = hookUrl(hook.url, { allowLocal: s.allowLocal, siteHost: s.siteHost });
  if (url instanceof ForgeProblem) return { ok: false, status: 0, ms: 0, words: "its address is no longer allowed", retry: false, attempts: 1 };
  const body = JSON.stringify(payload);
  const signature = await signDelivery(secret, body);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "research-code-registry-hooks/1",
    "X-Hook-Event": payload.event,
    "X-Hook-Delivery": payload.delivery,
    "X-Hook-ID": hook.id,
    "X-Hub-Signature-256": signature,
    "X-Hook-Signature-256": signature,
  };
  let attempts = 0;
  let last: Omit<Sent, "attempts"> = { ok: false, status: 0, ms: 0, words: "not sent: this request's deliveries are spent", retry: false };
  for (;;) {
    if (s.budget.sends <= 0) break;
    s.budget.sends -= 1;
    attempts += 1;
    last = await sendOnce(s, url, body, headers);
    if (last.ok || !last.retry || !retries || attempts > RETRY_WAITS_MS.length) break;
    await s.sleep(RETRY_WAITS_MS[attempts - 1]);
  }
  return { ...last, attempts: Math.max(1, attempts) };
}

// ─── the deliveries of events ────────────────────────────────────────────────

export interface EventKey {
  subject: string;
  at: number;
  nonce: string;
}

/** Whether ten deliveries in a row failed (its recent deliveries read only on a failure). */
async function failingStill(db: D1Database, hookId: string, t: number): Promise<boolean> {
  const recent = await all<DeliveryRow>(deliveriesOf(db, hookId, t, PAUSE_AFTER_FAILURES));
  return recent.length >= PAUSE_AFTER_FAILURES && recent.every((d) => d.ok === 0);
}

/** The hooks of the events a request wrote, delivered (in waitUntil). */
export async function deliverEvents(o: { db: D1Database; env: ForgeServiceEnv; origin: string; t: number; sender: Sender }, keys: EventKey[]): Promise<number> {
  const key = o.env.SESSION_KEY;
  if (!keys.length || typeof key !== "string" || !key) return 0;
  const bySubject = new Map<string, HookRow[]>();
  for (const subject of new Set(keys.map((k) => k.subject))) {
    const hooks = await all<HookRow>(hooksOn(o.db, subject, true));
    if (hooks.length) bySubject.set(subject, hooks);
  }
  if (!bySubject.size) return 0;
  const writes: Write[] = [];
  const failed = new Set<string>();
  const done: Promise<void>[] = [];
  for (const k of keys) {
    const hooks = bySubject.get(k.subject);
    if (!hooks) continue;
    const e = await first<EventRow>(eventByKey(o.db, k.subject, k.at, k.nonce));
    if (!e) continue;
    // Night phase 16: an event of a suspended account, a hidden repository or a hidden thread is never
    // delivered.
    if ((await hiddenEventFilter(o.db, [e]))(e)) continue;
    for (const h of hooks) {
      if (!wants(h, e.kind)) continue;
      done.push(
        (async () => {
          const guid = crypto.randomUUID();
          const sent = await deliver(o.sender, h, await hookSecret(key, h.id, h.salt), eventPayload(h, e, guid, o.origin, o.t));
          if (!sent.ok) failed.add(`${h.user_id}\n${h.id}`);
          writes.push(deliveryInsert(o.db, { hook_id: h.id, at: o.t, guid, event: e.kind, ev_subject: e.subject, ev_at: e.at, ev_nonce: e.nonce, status: sent.status, ok: sent.ok ? 1 : 0, attempts: sent.attempts, ms: sent.ms, words: sent.words, redelivery: 0 }));
        })(),
      );
    }
  }
  await Promise.all(done);
  if (!writes.length) return 0;
  // Logged when the day's rows allow it; the delivery was made either way.
  if (!(await globalCap(o.db, o.t, writes.length))) await o.db.batch(statements(writes));
  for (const f of failed) {
    const [userId, id] = f.split("\n");
    if (await failingStill(o.db, id, o.t)) await hookUpdate(o.db, userId, id, { active: 0 }, o.t).stmt.run();
  }
  return writes.length;
}

/** After a batch that wrote events: their hooks, delivered in waitUntil (the answer does not wait). */
export function queueHooks(r: ForgeRequest, keys: EventKey[]): void {
  const real = keys.filter((k) => k.subject && k.nonce);
  if (!real.length) return;
  const run = deliverEvents({ db: r.db, env: r.env, origin: r.url.origin, t: r.t, sender: senderOf(r) }, real).catch((e: unknown) => {
    // Redacted like every log line: an address may carry a token of the receiver's.
    console.error(`forge hooks: ${redact(String((e as Error)?.message ?? e)).slice(0, 200)}`);
    return 0;
  });
  r.ctx.waitUntil(run);
}

// ─── the routes ──────────────────────────────────────────────────────────────

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const ID = /^[A-Za-z0-9_-]{16}$/;

/** GET /api/forge/hooks (and /api/v1/hooks): the reader's hooks. */
export async function handleHooks(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const rows = await all<HookRow>(hooksOf(r.db, s.user.id));
  // A repository's path, for the list's words (by its key: one read each, ten at most).
  const labels = new Map<string, string>();
  for (const h of rows) {
    const m = /^repo:(github|memory):(\d+)$/.exec(h.subject);
    if (!m || labels.has(h.subject)) continue;
    const row = await first<RepoRow>(repoByKey(r.db, m[1], m[2]));
    if (row?.name) labels.set(h.subject, `${row.owner_login}/${row.name}`);
  }
  return json(
    {
      hooks: rows.map((h) => ({ ...hookView(h), label: labels.get(h.subject) ?? null })),
      events: { repository: eventsFor("repo:github:1"), paper: eventsFor("paper:doi:10.1/x") },
      limits: { hooks: HOOKS_PER_ACCOUNT, perSubject: HOOKS_PER_SUBJECT, timeoutSeconds: HOOK_TIMEOUT_MS / 1000, attempts: RETRY_WAITS_MS.length + 1 },
    },
    200,
    s.cookies,
  );
}

/** GET /api/forge/hooks/deliveries?id= (and /api/v1/hooks/deliveries): one hook's recent deliveries. */
export async function handleHookDeliveries(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const id = r.url.searchParams.get("id") ?? "";
  if (!ID.test(id)) return problemAnswer(bad("Which hook? Its id is 16 characters."), s.cookies);
  const mine = (await all<HookRow>(hooksOf(r.db, s.user.id))).find((h) => h.id === id);
  if (!mine) return problemAnswer(new ForgeProblem(404, "not_found", "You hold no hook with this id."), s.cookies);
  const rows = await all<DeliveryRow>(deliveriesOf(r.db, id, r.t));
  return json({ hook: hookView(mine), deliveries: rows.map(deliveryView) }, 200, s.cookies);
}

/** Whether the subject is one the registry follows: a repository it knows, alive; any paper by DOI. */
async function knownSubject(r: ForgeRequest, subject: string): Promise<boolean> {
  if (subject.startsWith("paper:")) return true;
  const m = /^repo:(github|memory):(\d+)$/.exec(subject);
  if (!m) return false;
  const row = await first<RepoRow>(repoByKey(r.db, m[1], m[2]));
  return !!row && !!row.name && (row.state === "active" || row.state === "archived");
}

/** A ping, sent now (one attempt: the person is waiting), and its delivery row. */
async function ping(r: ForgeRequest, s: SignedIn, h: Pick<HookRow, "id" | "url" | "subject" | "events" | "salt">): Promise<{ sent: Awaited<ReturnType<typeof deliver>>; row: Write }> {
  const guid = crypto.randomUUID();
  const sender = senderOf(r);
  const sent = await deliver(sender, h, await hookSecret(String(r.env.SESSION_KEY), h.id, h.salt), pingPayload(h, guid, r.t), false);
  return {
    sent,
    row: deliveryInsert(r.db, { hook_id: h.id, at: r.t, guid, event: "ping", ev_subject: "", ev_at: 0, ev_nonce: "", status: sent.status, ok: sent.ok ? 1 : 0, attempts: sent.attempts, ms: sent.ms, words: sent.words, redelivery: 0 }),
  };
}

const sentView = (x: { ok: boolean; status: number; words: string; ms: number }) => ({ ok: x.ok, status: x.status, words: x.words, ms: x.ms });

/** POST /api/forge/hooks/write (and /api/v1/hooks/write). */
export async function handleHookWrite(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  if (typeof r.env.SESSION_KEY !== "string") return say(new ForgeProblem(503, "not_configured", "Accounts are not set up yet."));
  const body = await readJsonBody(r, HOOK_BODY_BYTES);
  if (body instanceof ForgeProblem) return say(body);
  const p = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const op = p.op;
  const mine = await all<HookRow>(hooksOf(r.db, s.user.id));

  if (op === "create") {
    // FORGE_OPEN first: nothing is looked up, nothing sent, for an account that may not write.
    if (!mayWrite(r.env, await linkedGithub(s.db, s.user.id))) return say(closed());
    const req = validateHook(p, { allowLocal: (r.env.HOOKS_ALLOW_LOCAL ?? "") === "1", siteHost: r.url.hostname });
    if (req instanceof ForgeProblem) return say(req);
    if (mine.length >= HOOKS_PER_ACCOUNT) return say(new ForgeProblem(409, "too_many_hooks", `An account holds ${HOOKS_PER_ACCOUNT} webhooks at most: delete one first.`));
    if (mine.some((h) => h.subject === req.subject && h.url === req.url)) return say(new ForgeProblem(409, "already_hooked", "You already have a webhook with this address on this subject."));
    if (!(await knownSubject(r, req.subject))) return say(new ForgeProblem(404, "unknown_subject", "The registry does not follow this repository: link it first, or name a paper by its DOI."));
    if ((await all<HookRow>(hooksOn(r.db, req.subject, false))).length >= HOOKS_PER_SUBJECT) {
      return say(new ForgeProblem(409, "too_many_hooks", `This subject has ${HOOKS_PER_SUBJECT} webhooks already, the most the registry delivers to.`));
    }
    const gate = await mayAutomate(r, s, "hook", 4);
    if (gate instanceof ForgeProblem) return say(gate);
    const hook = { id: newHookId(), salt: newSalt(), subject: req.subject, url: req.url, events: eventsText(req.events) };
    const pinged = await ping(r, s, hook);
    const writes = [hookInsert(r.db, { user_id: s.user.id, ...hook, active: pinged.sent.ok ? 1 : 0, created_at: r.t }), pinged.row];
    const written = await commitAutomation(r, s, "hook", gate.github, writes, `hook:${hook.id}`);
    const secret = await hookSecret(r.env.SESSION_KEY, hook.id, hook.salt);
    return json(
      { ok: true, written, secret, hook: hookView({ user_id: "", ...hook, active: pinged.sent.ok ? 1 : 0, created_at: r.t, updated_at: r.t }), ping: sentView(pinged.sent) },
      201,
      s.cookies,
    );
  }

  const id = typeof p.id === "string" && ID.test(p.id) ? p.id : null;
  if (!id) return say(bad("Which hook? Its id is 16 characters."));
  const h = mine.find((x) => x.id === id);
  if (!h) return say(new ForgeProblem(404, "not_found", "You hold no hook with this id."));

  // Pausing and deleting: never refused by a cap or FORGE_OPEN.
  const stop = async (writes: Write[], extra: Record<string, unknown>) => {
    const github = (await linkedGithub(s.db, s.user.id)) ?? "";
    const rows = writes.reduce((n, w) => n + w.rows, 0);
    const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind: "hook", githubUser: github, outcome: "done", rows: 1 + rows, subject: `hook:${id}` });
    await r.db.batch(statements([...writes, action]));
    return json({ ok: true, written: 1 + rows, ...extra }, 200, s.cookies);
  };
  if (op === "delete") return stop([hookDelete(r.db, s.user.id, id)], { deleted: id });
  if (op === "update") {
    const set: { events?: string; active?: 0 } = {};
    if (p.events !== undefined) {
      const ev = readEvents(p.events, h.subject);
      if (ev instanceof ForgeProblem) return say(ev);
      set.events = eventsText(ev);
    }
    if (p.active === true) return say(bad("A hook becomes active again when its ping is answered: ping it."));
    if (p.active === false) set.active = 0;
    if (set.events === undefined && set.active === undefined) return say(bad("Nothing to change."));
    if (set.events === undefined) return stop([hookUpdate(r.db, s.user.id, id, set, r.t)], { hook: hookView({ ...h, active: 0 }) });
    const gate = await mayAutomate(r, s, "hook", 2);
    if (gate instanceof ForgeProblem) return say(gate);
    const written = await commitAutomation(r, s, "hook", gate.github, [hookUpdate(r.db, s.user.id, id, set, r.t)], `hook:${id}`);
    return json({ ok: true, written, hook: hookView({ ...h, events: set.events, active: set.active ?? h.active }) }, 200, s.cookies);
  }
  if (op === "ping") {
    const gate = await mayAutomate(r, s, "hook", 3);
    if (gate instanceof ForgeProblem) return say(gate);
    const pinged = await ping(r, s, h);
    const writes = [pinged.row];
    if (pinged.sent.ok && h.active !== 1) writes.push(hookUpdate(r.db, s.user.id, id, { active: 1 }, r.t));
    const written = await commitAutomation(r, s, "hook", gate.github, writes, `hook:${id}`);
    return json({ ok: true, written, ping: sentView(pinged.sent), active: pinged.sent.ok || h.active === 1 }, 200, s.cookies);
  }
  if (op === "rotate") {
    const gate = await mayAutomate(r, s, "hook", 2);
    if (gate instanceof ForgeProblem) return say(gate);
    const salt = newSalt();
    const written = await commitAutomation(r, s, "hook", gate.github, [hookUpdate(r.db, s.user.id, id, { salt }, r.t)], `hook:${id}`);
    return json({ ok: true, written, secret: await hookSecret(r.env.SESSION_KEY, id, salt) }, 200, s.cookies);
  }
  if (op === "redeliver") {
    const guid = typeof p.guid === "string" && /^[0-9a-f-]{36}$/.test(p.guid) ? p.guid : null;
    if (!guid) return say(bad("Which delivery? Its id is the X-Hook-Delivery it was sent with."));
    const past = (await all<DeliveryRow>(deliveriesOf(r.db, id, r.t, 200))).find((d) => d.guid === guid);
    if (!past) return say(new ForgeProblem(404, "not_found", "This hook has no such delivery in the last 7 days."));
    if (past.event === "ping" || !past.ev_subject) return say(bad("A ping is not redelivered: ping the hook again."));
    const e = await first<EventRow>(eventByKey(r.db, past.ev_subject, past.ev_at, past.ev_nonce));
    if (!e) return say(new ForgeProblem(410, "gone", "This event is no longer kept: it cannot be delivered again."));
    const gate = await mayAutomate(r, s, "hook", 2);
    if (gate instanceof ForgeProblem) return say(gate);
    const again = crypto.randomUUID();
    const sent = await deliver(senderOf(r), h, await hookSecret(r.env.SESSION_KEY, h.id, h.salt), eventPayload(h, e, again, r.url.origin, r.t), false);
    const row = deliveryInsert(r.db, { hook_id: id, at: r.t, guid: again, event: e.kind, ev_subject: e.subject, ev_at: e.at, ev_nonce: e.nonce, status: sent.status, ok: sent.ok ? 1 : 0, attempts: sent.attempts, ms: sent.ms, words: sent.words, redelivery: 1 });
    const written = await commitAutomation(r, s, "hook", gate.github, [row], `hook:${id}`);
    return json({ ok: true, written, delivery: again, sent: sentView(sent) }, 200, s.cookies);
  }
  return say(bad("Say what to do: create, update, ping, redeliver, rotate or delete."));
}
