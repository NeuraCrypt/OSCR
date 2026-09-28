// What the contributions' routes answer: the rows of D1 as the pages read them (times in ISO 8601,
// JSON columns parsed, each paper with its page), and the shape of a paper's id.

import { paperSlug } from "../account/index.ts";
import type { AuthorClaimRow, EditRow, ReportRow, SubmissionRow, ValidationRow } from "./store.ts";

export const iso = (t: number | null | undefined): string | null => (t ? new Date(t * 1000).toISOString() : null);

function parsed<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A paper's id as the registry gives it ("doi:10.1234/abc", "pmcid:PMC123"), or "" when `value`
 *  has not its shape. Whether the paper has a page is the Mac's to say. */
export function paperId(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (v.length < 5 || v.length > 250) return "";
  if (/^doi:10\.\d{3,9}\/\S+$/.test(v) && v === v.toLowerCase()) return v;
  if (/^pmcid:PMC\d{1,12}$/.test(v)) return v;
  if (/^epmc:[A-Za-z0-9._-]{1,60}$/.test(v)) return v;
  return "";
}

/** The page of a paper on this site. */
export const paperUrl = (id: string) => `/paper/${paperSlug(id)}/`;

export function submissionJson(r: SubmissionRow) {
  return {
    id: r.id,
    doi: r.doi,
    code_urls: parsed<string[]>(r.code_urls, []),
    note: r.note,
    checks: parsed<Record<string, unknown>>(r.checks, {}),
    status: r.status,
    revisions: r.revisions,
    paper_id: r.paper_id,
    url: r.paper_id ? paperUrl(r.paper_id) : "",
    author: r.author === 1,
    draft: parsed<Record<string, unknown>>(r.draft, {}),
    message: r.message,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export function editJson(r: EditRow) {
  return {
    id: r.id,
    paper_id: r.paper_id,
    url: paperUrl(r.paper_id),
    as_role: r.as_role,
    repo: r.repo,
    changes: parsed<unknown[]>(r.changes, []),
    note: r.note,
    status: r.status,
    version: r.version,
    message: r.message,
    created_at: iso(r.created_at),
    decided_at: iso(r.decided_at),
  };
}

export function validationJson(r: ValidationRow) {
  return {
    id: r.id,
    paper_id: r.paper_id,
    url: paperUrl(r.paper_id),
    orcid: r.orcid,
    proof: r.proof,
    map_digest: r.map_digest,
    status: r.status,
    instance: r.instance,
    doi: r.doi,
    record_url: r.record_url,
    message: r.message,
    created_at: iso(r.created_at),
    decided_at: iso(r.decided_at),
  };
}

export function reportJson(r: ReportRow) {
  return {
    id: r.id,
    paper_id: r.target_id,
    url: paperUrl(r.target_id),
    reason: r.reason,
    details: r.details,
    status: r.status,
    message: r.message,
    created_at: iso(r.created_at),
    decided_at: iso(r.decided_at),
  };
}

export function authorClaimJson(r: AuthorClaimRow) {
  const evidence = parsed<{ statement?: string; link?: string }>(r.evidence, {});
  return {
    id: r.id,
    status: r.status,
    statement: evidence.statement ?? "",
    link: evidence.link ?? "",
    message: r.message,
    created_at: iso(r.created_at),
    decided_at: iso(r.decided_at),
  };
}
