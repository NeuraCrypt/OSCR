# Reconciliation notes (the `reconcile` branch)

This branch merges the GitHub side (the 16 night phases, cumulative tip
`origin/night/phase-15-ease-of-use`) into the live `main`, on a dedicated branch. Main stays
authoritative for the public live site; the GitHub side (the "forge") is additive and dormant behind
`FORGE_OPEN` (unset). The full decisions are in `docs/DECISIONS.md` under "Reconciliation" (DR-1 to
DR-5). This file records the open questions and the follow-ups that remain for the owner.

## What was decided (summary)

- The public keyless read API keeps `/api/v1`; the forge token API moved to `/api/forge/v1`
  (requires a token, dormant behind `FORGE_OPEN`). See DR-1.
- Main's public-site automatic moderator (`oscr/moderation.py`, `website/src/lib/moderation.ts`) is
  unchanged and authoritative. The night's Mac-side hiding helper moved to `oscr/forgehidden.py`
  (test `tests/test_forgehidden.py`); the forge's object moderation stays self-contained in
  `website/worker/forge/service/`. See DR-2.
- File budget: `STATIC_PAPERS` kept at 6,000 (one file per paper, "code first"); `FIXED_FILES_MAX`
  raised to 4,000 to hold the launch pages and the GitHub side's fixed files. See DR-3.
- Public pages and headers keep main's substance; the forge's are additive; the duplicate
  Turnstile-relaxed `/data-rights/` header rule was dropped. See DR-4.
- Em dashes removed from every merged night source so both guards pass; the CLI source repo link
  fixed to `NeuraCrypt/OSCR`.

## Open questions for the owner

1. **The forge token API path.** The forge's bearer API is now under `/api/forge/v1`. If the owner
   prefers a different prefix (for example `/api/v2` or a subdomain) before opening the GitHub side,
   change `API_PREFIX` in `website/worker/forge/service/api.ts` (it cascades to the OpenAPI, the
   `/developers/` page, the CLI and the tests) and the route in `website/worker/index.ts`.

2. **The forge content-moderation extension to new objects.** The night's phase-16 statement says
   the central report/hide kinds must still be extended to `discussion`, `discussion_comment`,
   `snippet` and `snippet_comment` (D06-6, D13-4). This is forge work that lives in the forge's own
   modules (`moderation-core.ts`, `hidden.ts`, `oscr/forgehidden.py`), not in the public-site
   `oscr/moderation.py`. It stays dormant behind `FORGE_OPEN` and is the owner's to finish before
   opening those surfaces.

3. **The `forge-shards.json` sample repository name.** `tests/fixtures/forge-shards.json` still names
   a sample repository `yannbellec/Open-Scientific-Code-Registry-OSCR-`. It is synthetic test data
   (not a link to OSCR's source, not deployed), so it was left as is; nothing asserts the literal
   string. The owner may rename it if a consistent sample name is wanted.

4. **The analytics token step.** Repository statistics (phase 12) read Cloudflare analytics with a
   read-only token the owner keeps in the keychain (`org.oscr.cloudflare-analytics`); it is not a
   `tools/setup_cloudflare.sh` step. If the owner wants it in the setup script, it can be added when
   the GitHub side is opened.

## What remains for the owner before opening the GitHub side

- Create the `oscr_forge` D1 database and bind it in production (`tools/setup_cloudflare.sh` does
  this and adds the production `[[d1_databases]]` block for `FORGE`).
- Register the GitHub App and set its Cloudflare secrets (App id, client id and secret, webhook
  secret, slug, the `.pem` private key) and `FORGE_OWNER_GITHUB_ID` (setup script, steps 8 to 9).
- Create the Cloudflare Turnstile widget and set `TURNSTILE_SECRET_KEY` (Cloudflare secret) and the
  public `TURNSTILE_SITE_KEY` (build-time or the Mac settings). Never commit either.
- Apply the `migrations/d1-forge/` migrations to `oscr_forge`.
- Only then set `FORGE_OPEN` (it opens nothing without Turnstile's secret; `gate.ts` `forgeOpen`).
  The write routes answer only `FORGE_OWNER_GITHUB_ID` until the content rules are reviewed.
- Set `OPERATOR_NAME` and `OPERATOR_ADDRESS` before the public launch (the build prints a launch
  warning while they are empty; this is unchanged by the reconciliation).

## Not done on this branch (by instruction)

- `FORGE_OPEN` is not set; the GitHub-side write routes stay owner-only and dormant.
- `main` was not touched, nothing was merged into `main`, and nothing was deployed.
- The forge-service end-to-end shell harnesses (`website/tests/forge-service/e2e*.sh`, the account
  `e2e.sh`) were not run here: they need a running Worker and live stand-ins. The unit and
  integration suites that do not need live infrastructure all pass.
