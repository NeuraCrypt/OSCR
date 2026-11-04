-- The forge database, part 19: the badge's one pull request (2026-11-04, D00-4 amended; docs/BADGE.md
-- "The App's one pull request"; worker/forge/service/badge-pr.ts).
--
-- When a researcher installs the GitHub App on a public repository the registry links to a paper, and
-- its README lacks the badge, the App opens ONE pull request that adds it (behind FORGE_OPEN and
-- FORGE_BADGE_PR). This table is what makes it one: a row per repository, written when the offer is
-- made (or found needless), never deleted by the offer itself, so a closed pull request is never
-- offered again. It holds no text of the repository, no token, no address: the repository's key, the
-- day (it counts toward FORGE_ROWS_PER_DAY, gate.ts), the account that installed the App (the daily
-- per-account cap), what happened, and the pull request's number when one was opened.
--
-- Times are Unix seconds; `day` is the UTC day (caps.ts utcDay).
CREATE TABLE IF NOT EXISTS badge_offers (
  forge TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  day INTEGER NOT NULL,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('opened', 'has_badge', 'no_readme_format', 'failed')),
  pr_number INTEGER,
  PRIMARY KEY (forge, repo_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS badge_offers_day ON badge_offers (day, account_login);
