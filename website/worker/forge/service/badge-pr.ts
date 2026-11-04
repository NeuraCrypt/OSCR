// The badge's one pull request (2026-11-04, D00-4 amended; docs/BADGE.md "The App's one pull request").
// When a researcher installs the GitHub App on a public repository the registry links to a paper, and
// the README on its default branch lacks the badge, the App opens ONE pull request: a branch
// `oscr-badge`, the README with the badge under its title between its two marks (lib/badge.ts
// insertBadge, the same as `oscr badge --write`), and a body that says what it is and how to decline.
//
// - Opt-in: only on an installation the researcher made (webhook.ts, installation_repositories
//   "added"), behind FORGE_OPEN AND its own flag FORGE_BADGE_PR="1".
// - Once: a row per repository (badge_offers, 0019), written whatever happened; a closed pull
//   request, a README that already carries the badge or one in a markup the badge does not cover is
//   never offered again.
// - Within the budget: the row counts toward FORGE_ROWS_PER_DAY (gate.ts globalRowsToday), and one
//   account gets at most BADGE_PRS_PER_ACCOUNT_DAY offers a day.
// - The token: minted for this act only, narrowed to the repository, contents and pull requests
//   written (TOKEN_PERMISSIONS.badge), kept in memory for its hour; never stored, logged or answered.
// - Nothing of the repository is stored: no README text, no address. GitHub requests: the repository,
//   its README, its head, the commit, the pull request (+ the token mint).
import { badgeBox, hasBadge, insertBadge, readmeFormat, type BadgeSubject } from "../../../src/lib/badge.ts";
import { GitBackendError } from "../errors.ts";
import type { GitBackend } from "../gitbackend.ts";
import { utf8 } from "../objects.ts";
import type { RepoRef } from "../types.ts";
import { FORGE_ROWS_PER_DAY, utcDay } from "./caps.ts";
import { forgeOpen, globalRowsToday } from "./gate.ts";
import { redact } from "./http.ts";
import { all, papersOf } from "./store.ts";
import type { D1Database, ForgeRequest, ForgeServiceEnv, RepoRow } from "./types.ts";

/** The branch the pull request comes from. */
export const BADGE_BRANCH = "oscr-badge";
/** The most offers one installing account gets a day. */
export const BADGE_PRS_PER_ACCOUNT_DAY = 20;

export type BadgeOutcome = "opened" | "has_badge" | "no_readme_format" | "failed";

export const badgePrOn = (env: ForgeServiceEnv): boolean => forgeOpen(env) && (env.FORGE_BADGE_PR ?? "").trim() === "1";

/** The pull request's body: what the badge is, that it is offered once, and how to decline. */
export function badgePrBody(name: string, origin: string, subject: BadgeSubject): string {
  const page = subject.kind === "doi" ? `${origin}/badge/?q=${encodeURIComponent(subject.doi)}` : `${origin}/badge/`;
  return [
    `You installed the ${name} GitHub App on this repository, which ${name} links to ${subject.kind === "doi" ? `the paper ${subject.doi}` : "a scientific tool"}.`,
    "",
    `This pull request adds ${name}'s badge to the README, under its title, between two marks. The badge links the code to its paper's page and says what ${name} knows of it (its code, its validated tracing map); it is drawn from public records and runs nothing.`,
    "",
    `- Merge it to keep the badge. Every other form of the badge: ${page}`,
    "- Close it to decline: it is offered once, and never again on this repository.",
    "- Nothing else is changed, and the App writes nothing else.",
  ].join("\n");
}

async function record(db: D1Database, forge: string, repoId: string, account: string, t: number, outcome: BadgeOutcome, number: number | null): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO badge_offers (forge, repo_id, account_login, day, at, outcome, pr_number) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(forge, repoId, account.toLowerCase(), utcDay(t), t, outcome, number)
    .run();
}

export interface BadgeOffer {
  backend: GitBackend;
  db: D1Database;
  env: ForgeServiceEnv;
  origin: string;
  t: number;
  installationId: string;
  accountLogin: string;
  repo: RepoRow;
  ref: RepoRef;
}

/** The one pull request for one repository, or why none: never twice, within the budget. */
export async function offerBadge(o: BadgeOffer): Promise<{ outcome: BadgeOutcome | "skipped"; why?: string; number?: number }> {
  if (!badgePrOn(o.env)) return { outcome: "skipped", why: "off" };
  const forge = o.repo.forge;
  const before = await all<{ n: number }>(o.db.prepare("SELECT count(*) AS n FROM badge_offers WHERE forge = ? AND repo_id = ?").bind(forge, o.repo.repo_id));
  if (Number(before[0]?.n ?? 0) > 0) return { outcome: "skipped", why: "offered before" };
  const mine = await all<{ n: number }>(o.db.prepare("SELECT count(*) AS n FROM badge_offers WHERE day = ? AND account_login = ?").bind(utcDay(o.t), o.accountLogin.toLowerCase()));
  if (Number(mine[0]?.n ?? 0) >= BADGE_PRS_PER_ACCOUNT_DAY) return { outcome: "skipped", why: "the account's daily cap" };
  if ((await globalRowsToday(o.db, o.t)) + 1 > FORGE_ROWS_PER_DAY) return { outcome: "skipped", why: "today's write budget" };
  const papers = (await all<{ paper_id: string }>(papersOf(o.db, forge, o.repo.repo_id))).map((p) => p.paper_id.replace(/^doi:/, ""));
  if (!papers.length) return { outcome: "skipped", why: "no paper" };
  const subject: BadgeSubject = papers.length === 1 ? { kind: "doi", doi: papers[0].toLowerCase() } : { kind: "repo", repo: `github.com/${o.ref.owner}/${o.ref.name}`.toLowerCase() };
  const name = (o.env.SITE_NAME ?? "").trim().slice(0, 60) || "the registry";
  const s = o.backend.session({ kind: "installation", installationId: o.installationId, purpose: "badge" });
  try {
    const info = await s.repos.get(o.ref);
    if (info.archived) return { outcome: "skipped", why: "archived" };
    const base = info.defaultBranch;
    if (!base) return { outcome: "skipped", why: "an empty repository" };
    const readme = await s.repos.readme(o.ref, base);
    const path = readme?.path ?? "README.md";
    const format = readmeFormat(path);
    const text = readme && !readme.binary ? new TextDecoder().decode(readme.bytes) : "";
    if (!format || (readme && readme.binary)) {
      await record(o.db, forge, o.repo.repo_id, o.accountLogin, o.t, "no_readme_format", null);
      return { outcome: "no_readme_format" };
    }
    if (hasBadge(text, new URL(o.origin).host)) {
      await record(o.db, forge, o.repo.repo_id, o.accountLogin, o.t, "has_badge", null);
      return { outcome: "has_badge" };
    }
    const marked = badgeBox(o.origin, subject, name).snippets.find((x) => x.format === format)!.text;
    const head = await s.git.resolve(o.ref, base);
    await s.git.createCommit(o.ref, {
      branch: BADGE_BRANCH,
      expectedHead: null,
      createFrom: head,
      message: `README: the ${name} badge`,
      changes: [{ op: "put", path, content: utf8(insertBadge(text, format, marked)) }],
    });
    const pr = await s.pulls.create(o.ref, { title: `Add the ${name} badge`, head: BADGE_BRANCH, base, body: badgePrBody(name, o.origin, subject) });
    await record(o.db, forge, o.repo.repo_id, o.accountLogin, o.t, "opened", pr.number);
    return { outcome: "opened", number: pr.number };
  } catch (e) {
    const code = e instanceof GitBackendError ? e.code : "error";
    console.error(`forge badge ${o.ref.owner}/${o.ref.name}: ${code}: ${redact(String((e as Error)?.message ?? e)).slice(0, 200)}`);
    // A branch already there, a refusal: recorded, so it is never tried again.
    await record(o.db, forge, o.repo.repo_id, o.accountLogin, o.t, "failed", null).catch(() => undefined);
    return { outcome: "failed", why: code };
  }
}

/** After an installation added repositories: their offers, in waitUntil (the delivery's answer does
 *  not wait), one repository after the other. */
export function queueBadgeOffers(r: ForgeRequest, installationId: string, accountLogin: string, repos: { row: RepoRow; ref: RepoRef }[]): void {
  if (!badgePrOn(r.env) || !repos.length) return;
  const run = (async () => {
    for (const { row, ref } of repos.slice(0, BADGE_PRS_PER_ACCOUNT_DAY)) {
      await offerBadge({ backend: r.backend(), db: r.db, env: r.env, origin: r.url.origin, t: r.t, installationId, accountLogin, repo: row, ref });
    }
  })().catch(() => undefined);
  r.ctx.waitUntil(run);
}
