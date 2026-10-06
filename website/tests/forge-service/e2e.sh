#!/bin/sh
# The GitHub side end to end, on this machine only (night phase 01; docs/FORGE.md, "Local end-to-end
# run"):
#
# 1. the fixture's synthetic Mac database and its facts, into a throwaway local D1 (oscr_community),
#    with oscr_forge's migrations;
# 2. the sign-in mocks (tests/account/mock-server.ts) and the fake GitHub over HTTP
#    (tests/forge/fake-github-server.ts: api, github.com's pages, raw files, with CORS);
# 3. the site built with FORGE_GITHUB_*_URL pointing at the fake (the /r/ shell reads it), and
#    `wrangler dev --env local` with development values only: the App's client id and secret are
#    the fake's, the webhook secret this run's, FORGE_OPEN unset and FORGE_OWNER_GITHUB_ID the fake's
#    Ada;
# 4. tests/forge-service/e2e.ts: sign-in, create, link, settings, branches, autolinks, webhooks,
#    FORGE_OPEN closed to another account, with D1's count of rows written; phase 03's web commits:
#    an edit committed through the fake GitHub, a branch that moved refused, a new branch, a move;
#    phase 04's pull requests: one opened, a line comment with a suggestion, the suggestion applied,
#    a merge at a head that moved refused, the merge, and a second one refused on its conflict;
#    phase 05's issues: a GitHub issue opened with its type, labelled, commented, closed as not
#    planned; a research issue (a code–paper mismatch) opened, labelled, commented, closed with a
#    resolution; a second one closed by the merge of a pull request that says it fixes it; a copy on
#    GitHub; Bob's issue and research issue refused (FORGE_OPEN); phase 07's releases: Ada's ORCID iD
#    linked, a release published with notes, tied to the paper's accepted manuscript with its map,
#    Software Heritage and a Zenodo deposit asked, tags, the drafts, a package confirmed; Bob's release
#    and file refused;
# 5. phase 07: the Mac's forge poll, offline, its Zenodo the mock sandbox (never a real Zenodo), then
#    the checks of its answers: the map versioned with the release, the deposit made on the mock;
# 6. phase 08 (in 4: stars, a follow by ORCID iD, a watch, Bob's comment by webhook into Ada's inbox,
#    marked read, Bob's star refused): the Mac's forge and social layers and the search's index, then
#    the search of repositories, research issues and people, and the static social shards.
# Phase 16 (7): a report without an account behind Turnstile (Cloudflare's test secrets, against the
#    mock's siteverify: TURNSTILE_VERIFY_URL, development only), the owner's queue, the comment hidden for
#    others; the Worker started again with FORGE_OPEN=true: a non-owner's write, a block (his comment and
#    reaction refused), an interaction limit; and again with the always-failing test secret.
# Phase 10 (in 4): a personal token made on the site, the public API called with it, a commit status
#    posted, an outgoing webhook to a local receiver (RECEIVER_PORT, this run's own; HOOKS_ALLOW_LOCAL=1,
#    development only) pinged then delivered an event, both signatures checked; the App installed on
#    the fixture's organization (the fake) posts the registry's check run on a pull request from its
#    pull_request delivery (the App's key: a throwaway key made for this run, never a real one).
#
# Night phase 06 (11): discussions, projects and the wiki (tests/forge-service/e2e.ts phase06): Ada,
#    a verified author of the fixture paper, opens its discussion space, posts and upvotes an answer and
#    marks it, hides a comment that is then gone for Bob; creates a project with a paper item; commits a
#    wiki page on the repository's wiki branch and edits it (history). A second run with Turnstile's
#    always-failing secret checks the human check refuses a write.
#
# Phase 14 (8): the researchers' command line (cli/, run as `python -m oscr_cli`; tests/forge-service/e2e-cli.ts)
#    against the fake GitHub and the Worker started again (Turnstile's passing test secret, FORGE_OPEN unset:
#    Ada, the owner, approves; DEVICE_CODE_SECONDS=12, a development life for the expired code): sign-in through
#    both device flows (the harness approves on the fake's device page and on /device/), status, the API, the
#    git credential helper, check, cite, trace, repo create and its paper linked through the site's write
#    path, issue create, a wrong scope, a refused approval, an expired code, MCP, sign-out; the credentials in
#    a throwaway keychain file made and deleted by the run. TRANSCRIPTS=<folder> keeps its terminal
#    transcripts (tokens scrubbed).
#
#   cd website && SITE_PORT=8791 MOCK_PORT=9491 FAKE_PORT=9490 RECEIVER_PORT=9492 sh tests/forge-service/e2e.sh
#   (KEEP=1 leaves the three servers running, for screenshots; kill them after.)
#
# Nothing is remote: no real GitHub, provider or Cloudflare database is asked.
set -eu
cd "$(dirname "$0")/../.."
ROOT=$(cd .. && pwd)
PYTHON="$ROOT/.venv/bin/python"
TMP=$(mktemp -d)
SITE_PORT=${SITE_PORT:-8791}
MOCK_PORT=${MOCK_PORT:-9491}
FAKE_PORT=${FAKE_PORT:-9490}
RECEIVER_PORT=${RECEIVER_PORT:-9492}
SITE="http://localhost:$SITE_PORT"
MOCK="http://127.0.0.1:$MOCK_PORT"
FAKE="http://127.0.0.1:$FAKE_PORT"
CLIENT_ID="Iv23liE2ETESTCLIENT"
CLIENT_SECRET="e2e-test-secret-not-real"
WEBHOOK_SECRET="e2e-webhook-$(openssl rand -hex 12)"
PIDS=""
# A process and every process it started (npx → wrangler → workerd), so that no server is left behind.
kill_tree() {
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill "$1" 2>/dev/null || true
}
cleanup() {
  if [ "${KEEP:-}" != "1" ]; then
    for p in $PIDS; do kill_tree "$p"; done
    rm -rf "$TMP"
  else
    echo "servers kept: $PIDS; state in $TMP"
  fi
}
trap cleanup EXIT INT TERM

# Phase 10: the App's private key for this run only (the fake GitHub accepts any signed JWT), with its
# line breaks written as \n, as the Worker reads a key pasted on one line.
openssl genrsa -traditional -out "$TMP/app-key.pem" 2048 2>/dev/null || openssl genrsa -out "$TMP/app-key.pem" 2048 2>/dev/null
APP_KEY=$(awk '{printf "%s\\n", $0}' "$TMP/app-key.pem")

# 1. The databases.
"$PYTHON" "$ROOT/tools/make_fixture.py" --database "$TMP/mac.db" >/dev/null
(cd "$ROOT" && "$PYTHON" -m oscr --db "$TMP/mac.db" --cache "$TMP/cache" community build --local --folder "$TMP/community" >/dev/null)
npx wrangler d1 migrations apply oscr_community --local --env local --persist-to "$TMP/state" >/dev/null
npx wrangler d1 migrations apply oscr_forge --local --env local --persist-to "$TMP/state" >/dev/null
# Phase 08: the search's database (papers and the GitHub side's forge_fts).
npx wrangler d1 migrations apply oscr_search --local --env local --persist-to "$TMP/state" >/dev/null
for f in "$TMP"/community/local-*/*.sql; do
  npx wrangler d1 execute oscr_community --local --env local --persist-to "$TMP/state" --file "$f" --yes >/dev/null
done

# 2. The outside world, on this machine.
node --experimental-strip-types tests/account/mock-server.ts "$MOCK_PORT" >"$TMP/mock.log" 2>&1 &
PIDS="$PIDS $!"
SITE="$SITE" FAKE_CLIENT_ID="$CLIENT_ID" FAKE_CLIENT_SECRET="$CLIENT_SECRET" \
  node --experimental-strip-types tests/forge/fake-github-server.ts "$FAKE_PORT" >"$TMP/fake.log" 2>&1 &
PIDS="$PIDS $!"
i=0
until curl -fs "$FAKE/control/seed" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "the fake GitHub did not start:"; cat "$TMP/fake.log"; exit 1; }
  sleep 0.5
done
ADA_ID=$(curl -fs "$FAKE/control/seed" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["ada"]["id"])')

# 3. The site, reading the fake GitHub, and the Worker. Night phase 16: the Worker is started again
# with other values for its last stages (start_worker), on the same databases and the same server key.
FORGE_GITHUB_API_URL="$FAKE/api" FORGE_GITHUB_RAW_URL="$FAKE/raw" FORGE_GITHUB_WEB_URL="$FAKE/web" \
  CATALOG_DIR=../tests/fixtures/public-catalog npm run build >"$TMP/build.log" 2>&1
SESSION_KEY="e2e-$(openssl rand -hex 24)"
TURNSTILE_PASS="1x0000000000000000000000000000000AA"   # Cloudflare's documented test secret: always passes
TURNSTILE_FAIL="2x0000000000000000000000000000000AA"   # and always fails
WORKER=""
start_worker() {
  if [ -n "$WORKER" ]; then
    kill_tree "$WORKER"
    i=0
    while curl -fs "$SITE/api/account/me" >/dev/null 2>&1; do
      i=$((i + 1)); [ "$i" -gt 60 ] && { echo "the previous Worker did not stop"; exit 1; }
      sleep 0.5
    done
  fi
  WRANGLER_SEND_METRICS=false npx wrangler dev --env local --port "$SITE_PORT" --persist-to "$TMP/state" \
  --var "SESSION_KEY:$SESSION_KEY" \
  --var "ORCID_CLIENT_ID:APP-TESTORCID0000001" --var "ORCID_CLIENT_SECRET:orcid-test-secret" --var "ORCID_ISSUER:$MOCK/orcid" \
  --var "GITHUB_CLIENT_ID:Iv1.testgithubclient" --var "GITHUB_CLIENT_SECRET:github-test-secret" \
  --var "GITHUB_URL:$MOCK/github" --var "GITHUB_API_URL:$MOCK/github-api" \
  --var "GOOGLE_CLIENT_ID:test-client.apps.googleusercontent.com" --var "GOOGLE_CLIENT_SECRET:google-test-secret" \
  --var "GOOGLE_ISSUER:$MOCK/google" --var "CHECKS_URL:$MOCK/checks" --var "ACCOUNT_DEV_METRICS:1" \
  --var "GITHUB_APP_ID:1" --var "GITHUB_APP_SLUG:code-registry-dev" \
  --var "GITHUB_APP_CLIENT_ID:$CLIENT_ID" --var "GITHUB_APP_CLIENT_SECRET:$CLIENT_SECRET" \
  --var "GITHUB_APP_WEBHOOK_SECRET:$WEBHOOK_SECRET" --var "FORGE_OWNER_GITHUB_ID:$ADA_ID" \
  --var "FORGE_GITHUB_API_URL:$FAKE/api" --var "FORGE_GITHUB_WEB_URL:$FAKE/web" --var "FORGE_GITHUB_RAW_URL:$FAKE/raw" \
  --var "FORGE_GITHUB_UPLOADS_URL:$FAKE/uploads" \
  --var "GITHUB_APP_PRIVATE_KEY:$APP_KEY" --var "HOOKS_ALLOW_LOCAL:1" \
  --var "TURNSTILE_VERIFY_URL:$MOCK/turnstile/siteverify" "$@" >"$TMP/dev.log" 2>&1 &
  WORKER=$!
  PIDS="$PIDS $WORKER"
  i=0
  until curl -fs "$SITE/api/account/me" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 120 ] && { echo "wrangler dev did not start:"; tail -20 "$TMP/dev.log"; exit 1; }
    sleep 0.5
  done
}
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_PASS"

# 4. The run. Phase 07: the fixture paper's tracing map digest, as the Mac computes it (the map the
# release form shows), for the release's tie and its deposit.
MAP_DIGEST=$(cd "$ROOT" && "$PYTHON" -c "import sqlite3; from oscr import zenodo; con = sqlite3.connect('$TMP/mac.db'); con.row_factory = sqlite3.Row; print(zenodo.map_digest(zenodo.map_of(con, 'doi:10.5555/oscr.fixture.1')))")
SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" WEBHOOK_SECRET="$WEBHOOK_SECRET" MAP_DIGEST="$MAP_DIGEST" E2E_STATE="$TMP/phase07.json" \
  RECEIVER_PORT="$RECEIVER_PORT" node --experimental-strip-types tests/forge-service/e2e.ts

# 5. Phase 07: the Mac's forge jobs, offline (no GitHub, no Software Heritage: those jobs wait), its Zenodo
# the MOCK sandbox (an explicit sandbox, whatever the settings say; a token that is none), on the same
# local D1; then the checks of what it answered.
(cd "$ROOT" && OSCR_ZENODO_SANDBOX_URL="$MOCK/zenodo" ZENODO_SANDBOX_TOKEN="e2e-mock-token" "$PYTHON" -m oscr \
  --db "$TMP/mac.db" --cache "$TMP/cache" --offline --no-verify --no-metadata --no-swh --no-contents --no-records \
  forge poll --local --persist-to "$TMP/state" --folder "$TMP/community" --instance sandbox) >"$TMP/mac-forge.log" 2>&1 \
  || { echo "the Mac's forge poll failed:"; tail -20 "$TMP/mac-forge.log"; exit 1; }
SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" E2E_STATE="$TMP/phase07.json" node --experimental-strip-types tests/forge-service/e2e.ts after-mac

# 6. Phase 08: the Mac's night on the same local D1s — the forge layer, the social layer (stars,
# follows, public profiles, Explore) and the search's index of the GitHub side built from those public
# files — then the search and the static files checked.
mkdir -p "$TMP/export"
OSCR="$PYTHON -m oscr --db $TMP/mac.db --cache $TMP/cache --offline --no-verify --no-metadata --no-swh --no-contents --no-records"
(cd "$ROOT" && $OSCR forge layer --local --persist-to "$TMP/state" --folder "$TMP/community" --export "$TMP/export") >"$TMP/mac-social.log" 2>&1 \
  || { echo "the Mac's forge layer failed:"; tail -20 "$TMP/mac-social.log"; exit 1; }
(cd "$ROOT" && $OSCR social layer --local --persist-to "$TMP/state" --export "$TMP/export") >>"$TMP/mac-social.log" 2>&1 \
  || { echo "the Mac's social layer failed:"; tail -20 "$TMP/mac-social.log"; exit 1; }
(cd "$ROOT" && $OSCR social search --local --persist-to "$TMP/state" --folder "$TMP/community" --export "$TMP/export") >>"$TMP/mac-social.log" 2>&1 \
  || { echo "the Mac's search push failed:"; tail -20 "$TMP/mac-social.log"; exit 1; }
REPO_ID=$("$PYTHON" -c "import json; print(json.load(open('$TMP/phase07.json'))['id'])")
SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" EXPORT="$TMP/export" REPO_ID="$REPO_ID" node --experimental-strip-types tests/forge-service/e2e.ts after-social

# 7. Night phase 16 (tests/forge-service/e2e-rules.ts): reports, the owner's queue, what hiding removes,
# with FORGE_OPEN unset; then the Worker again with FORGE_OPEN=true (a non-owner's write under the caps,
# the human check, a block, an interaction limit); then with Turnstile's always-failing test secret.
env SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" REPO_ID="$REPO_ID" node --experimental-strip-types tests/forge-service/e2e-rules.ts closed
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_PASS" --var "FORGE_OPEN:true"
env SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" REPO_ID="$REPO_ID" node --experimental-strip-types tests/forge-service/e2e-rules.ts open
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_FAIL" --var "FORGE_OPEN:true"
env SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" REPO_ID="$REPO_ID" node --experimental-strip-types tests/forge-service/e2e-rules.ts fail

# 8. Night phase 14 (tests/forge-service/e2e-cli.ts): the command line against the fake GitHub and the Worker,
# started again with Turnstile's passing test secret, FORGE_OPEN unset, and sign-in codes that live 12 s.
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_PASS" --var "DEVICE_CODE_SECONDS:12"
env SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" ROOT="$ROOT" TRANSCRIPTS="${TRANSCRIPTS:-}" node --experimental-strip-types tests/forge-service/e2e-cli.ts

# 9. Night phase 11 (tests/forge-service/e2e-security.ts): a FAKE OSV (tests/forge/fake-osv-server.ts),
# the Mac's security facts seeded through the real code paths against it (seed_security.py: the
# dependency graph, OSV alerts, a secret alert, the licence), then the Worker (FORGE_OPEN=true) shows
# the graph and the alerts, dismisses one, ingests a SARIF file through the token API, files and
# publishes a private vulnerability report, and the SBOM's data is present.
OSV_PORT=${OSV_PORT:-9493}
OSV="http://127.0.0.1:$OSV_PORT"
node --experimental-strip-types tests/forge/fake-osv-server.ts "$OSV_PORT" >"$TMP/osv.log" 2>&1 &
PIDS="$PIDS $!"
i=0
until curl -fs -X POST "$OSV/v1/querybatch" -d '{"queries":[]}' >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "the fake OSV did not start:"; cat "$TMP/osv.log"; exit 1; }
  sleep 0.5
done
(cd "$ROOT" && "$PYTHON" website/tests/forge-service/seed_security.py "$REPO_ID" "$OSV" "$TMP/state" "$(printf 'a%.0s' $(seq 1 40))") \
  >"$TMP/mac-security.log" 2>&1 || { echo "the Mac's security seed failed:"; tail -20 "$TMP/mac-security.log"; exit 1; }
cat "$TMP/mac-security.log"
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_PASS" --var "FORGE_OPEN:true"
env SITE="$SITE" REPO_ID="$REPO_ID" node --experimental-strip-types tests/forge-service/e2e-security.ts

# 10. Night phase 09 (tests/forge-service/e2e-organizations.ts): organizations, membership and research
# permissions, a members-only README refused to a non-member then shown to a member, a passkey (WebAuthn
# with a real ES256 key, verified in the Worker), a session revoked, the audit log exported as CSV. The
# Worker with FORGE_OPEN=true so Bob (a non-owner) may accept an invitation and act on his membership.
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_PASS" --var "FORGE_OPEN:true"
env SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" node --experimental-strip-types tests/forge-service/e2e-organizations.ts

# 11. Night phase 06 (tests/forge-service/e2e.ts phase06): discussions, projects and the wiki. Ada is
# granted the verified_author role on the fixture paper, so she maintains its discussion space; then a
# paper discussion is opened, an answer posted, upvoted and marked, a comment hidden by the triager and
# gone for Bob, a project created with a paper item, and a wiki page committed on the wiki branch. A
# second run with Turnstile's always-failing secret checks the human check refuses a write.
ADA_USER=$(npx wrangler d1 execute oscr_community --local --env local --persist-to "$TMP/state" --json \
  --command "SELECT user_id AS u FROM identities WHERE provider = 'github' AND subject = '$ADA_ID'" \
  | "$PYTHON" -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["results"][0]["u"])')
npx wrangler d1 execute oscr_community --local --env local --persist-to "$TMP/state" --yes \
  --command "INSERT OR IGNORE INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES ('$ADA_USER', 'verified_author', 'paper', 'doi:10.5555/oscr.fixture.1', 'e2e', 1)" >/dev/null
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_PASS" --var "FORGE_OPEN:true"
env SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" REPO_ID="$REPO_ID" node --experimental-strip-types tests/forge-service/e2e.ts phase06
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_FAIL" --var "FORGE_OPEN:true"
env SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" REPO_ID="$REPO_ID" node --experimental-strip-types tests/forge-service/e2e.ts phase06-fail

# 12. Night phase 12 (tests/forge-service/e2e-statistics.ts): repository statistics. A FAKE Cloudflare
# analytics source (tests/forge/fake-cf-analytics-server.ts), the statistics seeded into oscr_forge
# (repo_stats, repo_dependents counting a paper, a research mark), then the Worker (FORGE_OPEN=true,
# the read-only analytics token and the fake endpoint): "Used by" counts a paper and a mark shows on
# the chart, Ada (a maintainer) sees aggregate traffic with no unique-visitor figure, Bob (not a
# maintainer) is refused, and the community checklist reflects a ready and a bare repository.
CF_PORT=${CF_PORT:-9494}
CF="http://127.0.0.1:$CF_PORT"
node --experimental-strip-types tests/forge/fake-cf-analytics-server.ts "$CF_PORT" >"$TMP/cf.log" 2>&1 &
PIDS="$PIDS $!"
i=0
until curl -fs -X POST "$CF/graphql" -d '{}' >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "the fake Cloudflare analytics did not start:"; cat "$TMP/cf.log"; exit 1; }
  sleep 0.5
done
npx wrangler d1 execute oscr_forge --local --env local --persist-to "$TMP/state" --yes --command \
  "INSERT OR REPLACE INTO repo_stats (forge, repo_id, usedby_papers, usedby_repos, stars, computed_at) VALUES ('github', '$REPO_ID', 1, 1, '[[1700000000,1],[1700604800,3]]', 1700604800);
   DELETE FROM repo_dependents WHERE forge = 'github' AND repo_id = '$REPO_ID';
   INSERT INTO repo_dependents (forge, repo_id, dep_kind, dep_ref, via, owner, name, slug, title, computed_at) VALUES
     ('github', '$REPO_ID', 'paper', 'doi:10.5555/oscr.fixture.1', 'PyPI:eeg-analysis', '', '', 'oscr-fixture-1', 'The fixture paper', 1700604800),
     ('github', '$REPO_ID', 'repo', '9001', 'PyPI:eeg-analysis', 'cat', 'downstream', '', '', 1700604800);
   DELETE FROM repo_marks WHERE forge = 'github' AND repo_id = '$REPO_ID';
   INSERT INTO repo_marks (forge, repo_id, kind, ref, t, label, computed_at) VALUES
     ('github', '$REPO_ID', 'paper', 'doi:10.5555/oscr.fixture.1', 1700300000, 'The fixture paper (doi:10.5555/oscr.fixture.1)', 1700604800);" >/dev/null
start_worker --var "TURNSTILE_SECRET_KEY:$TURNSTILE_PASS" --var "FORGE_OPEN:true" \
  --var "CLOUDFLARE_ANALYTICS_TOKEN:ro-test-token" --var "CLOUDFLARE_ACCOUNT_ID:acc-test" \
  --var "CLOUDFLARE_ANALYTICS_SITE_TAG:site-test" --var "CLOUDFLARE_ANALYTICS_URL:$CF/graphql"
env SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" REPO_ID="$REPO_ID" node --experimental-strip-types tests/forge-service/e2e-statistics.ts
