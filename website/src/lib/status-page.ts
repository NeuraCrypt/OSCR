// The /status page's figures (night phase 15): it reads the availability the Mac wrote
// (src/data/site-status.json, from oscr/sitestatus.py) and turns it into what the page shows, and it
// states the daily free-tier quotas in words. Pure, no DOM, tested in Node
// (tests/forge-pages/status-page.test.ts).
//
// The page is static: it changes only when the site is next built, so it says when it was built. The
// availability comes from the Mac's own outbound checks (nothing on the Mac listens); until the
// owner enables those checks, the data says so and the page shows the quotas alone.
//
// It never names the platform; the page's shell does.

import { dateInWords } from "./format.ts";

export interface StatusDay {
  date: string;
  checks: number;
  ok: number;
  state: "up" | "partial" | "down" | "none";
  uptime: number | null;
}

export interface StatusIncident {
  start: string;
  end: string;
  checks: number;
  title: string;
}

export interface StatusData {
  enabled: boolean;
  generated_at: string;
  window_days: number;
  checks_per_day: number;
  interval_seconds: number;
  days: StatusDay[];
  incidents: StatusIncident[];
  total_checks: number;
  ok_checks: number;
  overall_uptime: number | null;
}

/** The free-tier quotas that shape the service, in words. The figures are the free-tier limits
 *  (docs/PLATFORM_PLAN.md Appendix A); a reader learns what runs out and what happens then. */
export const QUOTAS: readonly { what: string; limit: string; whenSpent: string }[] = [
  {
    what: "Search",
    limit: "up to 5,000,000 rows read a day (Cloudflare D1, the search database)",
    whenSpent: "search says so in a clear message and waits for the next day (midnight UTC); the rest of the site stays up.",
  },
  {
    what: "Pages served by the Worker",
    limit: "100,000 requests a day (Cloudflare Workers)",
    whenSpent: "the static pages keep working; a page rendered on demand may be delayed.",
  },
  {
    what: "The nightly writes",
    limit: "100,000 rows written a day (Cloudflare D1)",
    whenSpent: "the registry keeps its own nightly push well under this, so the search index still updates.",
  },
  {
    what: "Sign-in and the readers' requests",
    limit: "shared with the 100,000 Worker requests a day",
    whenSpent: "a signed-out reader's page view asks the Worker nothing, so reading is never blocked.",
  },
];

const STATES: Record<StatusDay["state"], string> = {
  up: "fully available",
  partial: "partly available",
  down: "mostly unavailable",
  none: "no check recorded",
};

/** A percentage with two decimals, or a dash when there is nothing yet. */
export function percent(fraction: number | null): string {
  return fraction == null ? "not measured yet" : `${(fraction * 100).toFixed(2)}%`;
}

/** "2026-10-05T12:00:00Z" as "5 October 2026, 12:00 UTC". */
export function builtInWords(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (!m) return iso;
  return `${dateInWords(m[1])}, ${m[2]} UTC`;
}

/** A day's label for a screen reader and the cell's title. */
export function dayLabel(d: StatusDay): string {
  const base = `${dateInWords(d.date)}: ${STATES[d.state]}`;
  return d.checks ? `${base} (${percent(d.uptime)} of ${d.checks} checks)` : base;
}

export interface StatusView {
  enabled: boolean;
  builtAt: string;
  windowDays: number;
  overall: string;
  days: StatusDay[];
  incidents: { label: string; title: string }[];
  /** A one-sentence summary for the top of the page and the screen reader. */
  summary: string;
}

/** Everything the page needs. Guards a malformed file: a missing or wrong field degrades to the
 *  "not enabled yet" state rather than throwing at build time. */
export function summarize(data: Partial<StatusData> | null | undefined): StatusView {
  const enabled = !!data?.enabled && Array.isArray(data?.days) && data.days.length > 0;
  const windowDays = typeof data?.window_days === "number" ? data.window_days : 90;
  const days = Array.isArray(data?.days) ? (data!.days as StatusDay[]) : [];
  const incidentsRaw = Array.isArray(data?.incidents) ? (data!.incidents as StatusIncident[]) : [];
  const builtAt = data?.generated_at ? builtInWords(data.generated_at) : "not built yet";
  const overall = percent(enabled ? data?.overall_uptime ?? null : null);
  const incidents = incidentsRaw.map((inc) => ({
    title: inc.title,
    label: `${builtInWords(inc.start)} to ${builtInWords(inc.end)} (${inc.checks} failed checks)`,
  }));
  const summary = enabled
    ? `Availability over the last ${windowDays} days: ${overall}. ${incidents.length === 0 ? "No incident recorded." : `${incidents.length} incident${incidents.length === 1 ? "" : "s"} recorded.`}`
    : "The availability checks are not running yet, so there is no history to show. The daily quotas are below.";
  return { enabled, builtAt, windowDays, overall, days, incidents, summary };
}
