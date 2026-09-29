-- The verified authors of a paper (night phase 04, D04-*): a pull request's page suggests them as
-- reviewers to the people who manage the paper's code (website/worker/forge/service/read.ts,
-- GET /api/forge/repo `reviewers`). 0001's note foresaw it: "The verified authors of a paper will
-- need (scope_kind, scope_id): its index comes with the query."
--
-- One more row written per role granted (rare: an ORCID sign-in's verification, the owner's hand);
-- the reads go by the index, never a scan.
CREATE INDEX roles_scope ON roles(scope_kind, scope_id, role);
