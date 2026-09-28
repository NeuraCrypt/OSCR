// The contributions in D1 (migrations/d1-community/0002_contributions.sql): submissions, edits,
// validations, removal requests, manual author claims, and the jobs the Mac reads. Every write
// says what it costs, as D1 counts it (the row, plus one for each index the insert touches);
// docs/CONTRIBUTIONS.md adds them up per action.

import type { D1Database, D1PreparedStatement } from "../account/types.ts";

export type JobKind = "submission" | "publish" | "edit" | "validation" | "claim" | "report";

export interface SubmissionRow {
  id: number;
  user_id: string;
  doi: string;
  code_urls: string;
  note: string;
  checks: string;
  status: "queued" | "draft" | "publishing" | "moderation" | "published" | "refused";
  revisions: number;
  paper_id: string;
  author: number;
  draft: string;
  message: string;
  created_at: number;
  updated_at: number;
}

export interface EditRow {
  id: number;
  paper_id: string;
  as_role: string;
  repo: string;
  changes: string;
  note: string;
  status: string;
  version: number | null;
  message: string;
  created_at: number;
  decided_at: number | null;
}

export interface ValidationRow {
  id: number;
  paper_id: string;
  orcid: string;
  proof: string;
  map_digest: string;
  status: string;
  instance: string;
  doi: string;
  record_url: string;
  message: string;
  created_at: number;
  decided_at: number | null;
}

export interface ReportRow {
  id: number;
  target_kind: string;
  target_id: string;
  reason: string;
  details: string;
  status: string;
  message: string;
  created_at: number;
  decided_at: number | null;
}

export interface AuthorClaimRow {
  id: number;
  status: "pending" | "verified" | "rejected";
  evidence: string;
  message: string;
  created_at: number;
  decided_at: number | null;
}

/** The job that tells the Mac about a request: 1 row written (the table has no index). */
export function enqueue(db: D1Database, kind: JobKind, ref: number, userId: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT INTO jobs (kind, ref, user_id, created_at) VALUES (?, ?, ?, ?)").bind(kind, ref, userId, now);
}

/** The same, for the row the statement just before it in a batch inserted: its rowid. */
function enqueueLast(db: D1Database, kind: JobKind, userId: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT INTO jobs (kind, ref, user_id, created_at) VALUES (?, last_insert_rowid(), ?, ?)").bind(kind, userId, now);
}

/** Rows of each list the account page shows. */
export const LIST = 50;

const SUBMISSION = "id, doi, code_urls, note, checks, status, revisions, paper_id, author, draft, message, created_at, updated_at";
const EDIT = "id, paper_id, as_role, repo, changes, note, status, version, message, created_at, decided_at";
const VALIDATION = "id, paper_id, orcid, proof, map_digest, status, instance, doi, record_url, message, created_at, decided_at";
const REPORT = "id, target_kind, target_id, reason, details, status, message, created_at, decided_at";

/** The account page's lists, as statements sent in one batch. Each reads the account's rows
 *  through its table's index, newest first. */
export const lists = {
  submissions: (db: D1Database, userId: string): D1PreparedStatement =>
    db.prepare(`SELECT ${SUBMISSION} FROM submissions WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ${LIST}`).bind(userId),
  edits: (db: D1Database, userId: string): D1PreparedStatement =>
    db.prepare(`SELECT ${EDIT} FROM edits WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${LIST}`).bind(userId),
  validations: (db: D1Database, userId: string): D1PreparedStatement =>
    db.prepare(`SELECT ${VALIDATION} FROM validations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${LIST}`).bind(userId),
  reports: (db: D1Database, userId: string): D1PreparedStatement =>
    db.prepare(`SELECT ${REPORT} FROM reports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${LIST}`).bind(userId),
};

/** What one person asked about one paper, as statements for one batch (a paper's page): each is
 *  a lookup by the account's index. */
export const ofPaper = {
  claim: (db: D1Database, userId: string, paperId: string): D1PreparedStatement =>
    db
      .prepare("SELECT id, status, evidence, message, created_at, decided_at FROM claims WHERE user_id = ? AND kind = 'author' AND paper_id = ? AND repo = ''")
      .bind(userId, paperId),
  validation: (db: D1Database, userId: string, paperId: string): D1PreparedStatement =>
    db.prepare(`SELECT ${VALIDATION} FROM validations WHERE user_id = ? AND paper_id = ? ORDER BY id DESC LIMIT 1`).bind(userId, paperId),
  report: (db: D1Database, userId: string, paperId: string): D1PreparedStatement =>
    db.prepare(`SELECT ${REPORT} FROM reports WHERE user_id = ? AND target_kind = 'paper' AND target_id = ?`).bind(userId, paperId),
  edits: (db: D1Database, userId: string, paperId: string): D1PreparedStatement =>
    db.prepare(`SELECT ${EDIT} FROM edits WHERE user_id = ? AND paper_id = ? ORDER BY id DESC LIMIT 5`).bind(userId, paperId),
  submission: (db: D1Database, userId: string, doi: string): D1PreparedStatement =>
    db.prepare(`SELECT ${SUBMISSION} FROM submissions WHERE user_id = ? AND doi = ?`).bind(userId, doi),
};

// ---------------------------------------------------------------------------------------------
// The daily limits, counted from the rows through each table's index: no write of their own.

export type Counted = "submissions" | "edits" | "validations" | "reports";

export async function countSince(db: D1Database, table: Counted, userId: string, since: number): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND created_at > ?`).bind(userId, since).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function authorClaimsSince(db: D1Database, userId: string, since: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM claims WHERE user_id = ? AND kind = 'author' AND created_at > ?")
    .bind(userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Submissions.

export function submissionOf(db: D1Database, userId: string, doi: string): Promise<SubmissionRow | null> {
  return ofPaper.submission(db, userId, doi).first<SubmissionRow>();
}

/** A submission of this account, by its id. */
export function mySubmission(db: D1Database, userId: string, id: number): Promise<SubmissionRow | null> {
  return db.prepare(`SELECT ${SUBMISSION} FROM submissions WHERE id = ? AND user_id = ?`).bind(id, userId).first<SubmissionRow>();
}

/** A new submission and its job: 3 rows written (the row, its index entry, the job). */
export async function createSubmission(
  db: D1Database,
  a: { userId: string; doi: string; codeUrls: string[]; note: string; checks: unknown; now: number },
): Promise<number> {
  const [inserted] = await db.batch([
    db
      .prepare("INSERT INTO submissions (user_id, doi, code_urls, note, checks, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
      .bind(a.userId, a.doi, JSON.stringify(a.codeUrls), a.note, JSON.stringify(a.checks), a.now, a.now),
    enqueueLast(db, "submission", a.userId, a.now),
  ]);
  return Number(inserted?.meta?.last_row_id ?? 0);
}

/** The statuses from which a submitter may correct the links. */
export const REVISABLE = ["draft", "refused", "moderation"] as const;
/** Corrections of one submission. */
export const MAX_REVISIONS = 10;

/** The links corrected, the submission queued again: 2 rows written (the row, the job). Only a
 *  submission the Mac has answered, at most ten times. Returns false when it was not. */
export async function reviseSubmission(
  db: D1Database,
  a: { id: number; userId: string; codeUrls: string[]; note: string; checks: unknown; now: number },
): Promise<boolean> {
  const [updated] = await db.batch([
    db
      .prepare(
        "UPDATE submissions SET code_urls = ?, note = ?, checks = ?, status = 'queued', revisions = revisions + 1, message = '', " +
          `updated_at = ? WHERE id = ? AND user_id = ? AND status IN (${REVISABLE.map((s) => `'${s}'`).join(", ")}) AND revisions < ${MAX_REVISIONS}`,
      )
      .bind(JSON.stringify(a.codeUrls), a.note, JSON.stringify(a.checks), a.now, a.id, a.userId),
    // The job only when this request queued the row: its status and time say so (a batch is one
    // transaction).
    db
      .prepare(
        "INSERT INTO jobs (kind, ref, user_id, created_at) SELECT 'submission', id, user_id, ? FROM submissions " +
          "WHERE id = ? AND user_id = ? AND status = 'queued' AND updated_at = ?",
      )
      .bind(a.now, a.id, a.userId, a.now),
  ]);
  return (updated?.meta?.changes ?? 0) > 0;
}

/** A draft published: at once when the submitter is an author of the paper (the Mac said so),
 *  otherwise for the owner to decide. 2 rows written (the row, the job). */
export async function publishSubmission(db: D1Database, a: { id: number; userId: string; now: number }): Promise<boolean> {
  const [updated] = await db.batch([
    db
      .prepare(
        "UPDATE submissions SET status = CASE author WHEN 1 THEN 'publishing' ELSE 'moderation' END, updated_at = ? " +
          "WHERE id = ? AND user_id = ? AND status = 'draft'",
      )
      .bind(a.now, a.id, a.userId),
    db
      .prepare(
        "INSERT INTO jobs (kind, ref, user_id, created_at) SELECT 'publish', id, user_id, ? FROM submissions " +
          "WHERE id = ? AND user_id = ? AND status IN ('publishing', 'moderation') AND updated_at = ?",
      )
      .bind(a.now, a.id, a.userId, a.now),
  ]);
  return (updated?.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------
// Edits, validations, removal requests.

/** 3 rows written: the edit, its index entry, the job. */
export async function createEdit(
  db: D1Database,
  a: { userId: string; paperId: string; asRole: string; repo: string; changes: unknown[]; note: string; now: number },
): Promise<number> {
  const [inserted] = await db.batch([
    db
      .prepare("INSERT INTO edits (user_id, paper_id, as_role, repo, changes, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(a.userId, a.paperId, a.asRole, a.repo, JSON.stringify(a.changes), a.note, a.now),
    enqueueLast(db, "edit", a.userId, a.now),
  ]);
  return Number(inserted?.meta?.last_row_id ?? 0);
}

export function latestValidation(db: D1Database, userId: string, paperId: string): Promise<ValidationRow | null> {
  return ofPaper.validation(db, userId, paperId).first<ValidationRow>();
}

/** 3 rows written: the validation, its index entry, the job. */
export async function createValidation(
  db: D1Database,
  a: { userId: string; paperId: string; orcid: string; proof: "orcid" | "orcid-sandbox"; digest: string; now: number },
): Promise<number> {
  const [inserted] = await db.batch([
    db
      .prepare("INSERT INTO validations (user_id, paper_id, orcid, proof, map_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(a.userId, a.paperId, a.orcid, a.proof, a.digest, a.now),
    enqueueLast(db, "validation", a.userId, a.now),
  ]);
  return Number(inserted?.meta?.last_row_id ?? 0);
}

export function reportOf(db: D1Database, userId: string, paperId: string): Promise<ReportRow | null> {
  return ofPaper.report(db, userId, paperId).first<ReportRow>();
}

/** 3 rows written: the request, its index entry, the job. */
export async function createReport(
  db: D1Database,
  a: { userId: string; paperId: string; reason: string; details: string; now: number },
): Promise<number> {
  const [inserted] = await db.batch([
    db
      .prepare("INSERT INTO reports (user_id, target_kind, target_id, reason, details, created_at) VALUES (?, 'paper', ?, ?, ?, ?)")
      .bind(a.userId, a.paperId, a.reason, a.details, a.now),
    enqueueLast(db, "report", a.userId, a.now),
  ]);
  return Number(inserted?.meta?.last_row_id ?? 0);
}

/** An open request asked again: its reason and details replaced. 2 rows written (the row, the
 *  job). Returns false when it was decided meanwhile. */
export async function updateReport(db: D1Database, a: { id: number; userId: string; reason: string; details: string; now: number }): Promise<boolean> {
  const [updated] = await db.batch([
    db.prepare("UPDATE reports SET reason = ?, details = ? WHERE id = ? AND user_id = ? AND status = 'open'").bind(a.reason, a.details, a.id, a.userId),
    db
      .prepare("INSERT INTO jobs (kind, ref, user_id, created_at) SELECT 'report', id, user_id, ? FROM reports WHERE id = ? AND user_id = ? AND status = 'open'")
      .bind(a.now, a.id, a.userId),
  ]);
  return (updated?.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------
// Author claims by hand (Phase 5's `claims`, kind 'author').

export function authorClaimOf(db: D1Database, userId: string, paperId: string): Promise<AuthorClaimRow | null> {
  return ofPaper.claim(db, userId, paperId).first<AuthorClaimRow>();
}

/** A claim waiting for the owner, and its job. New: 3 rows written (the row, its entry in
 *  claims_user_target, the job); asked again while pending: 2 (the evidence replaced, the job); a
 *  decided claim is left as it is. Returns the claim as it now is. */
export async function pendingAuthorClaim(db: D1Database, userId: string, paperId: string, evidence: unknown, now: number): Promise<AuthorClaimRow> {
  const before = await authorClaimOf(db, userId, paperId);
  if (before && before.status !== "pending") return before;
  if (before) {
    await db.batch([
      db.prepare("UPDATE claims SET evidence = ? WHERE id = ? AND status = 'pending'").bind(JSON.stringify(evidence), before.id),
      enqueue(db, "claim", before.id, userId, now),
    ]);
    return { ...before, evidence: JSON.stringify(evidence) };
  }
  const [inserted] = await db.batch([
    db
      .prepare("INSERT INTO claims (user_id, kind, paper_id, evidence, status, created_at) VALUES (?, 'author', ?, ?, 'pending', ?)")
      .bind(userId, paperId, JSON.stringify(evidence), now),
    enqueueLast(db, "claim", userId, now),
  ]);
  return { id: Number(inserted?.meta?.last_row_id ?? 0), status: "pending", evidence: JSON.stringify(evidence), message: "", created_at: now, decided_at: null };
}

// ---------------------------------------------------------------------------------------------
// The facts the checks read (pushed by the Mac, never written here).

/** Whether `repo` is a code repository of `paperId`, as the Mac pushed it (paper_repo). */
export async function isRepoOfPaper(db: D1Database, repo: string, paperId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS yes FROM paper_repo WHERE repo = ? AND paper_id = ?").bind(repo, paperId).first<{ yes: number }>();
  return row !== null;
}
