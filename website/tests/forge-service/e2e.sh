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
#    a merge at a head that moved refused, the merge, and a second one refused on its conflict.
#
#   cd website && SITE_PORT=8791 MOCK_PORT=9491 FAKE_PORT=9490 sh tests/forge-service/e2e.sh
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
SITE="http://localhost:$SITE_PORT"
MOCK="http://127.0.0.1:$MOCK_PORT"
FAKE="http://127.0.0.1:$FAKE_PORT"
CLIENT_ID="Iv23liE2ETESTCLIENT"
CLIENT_SECRET="e2e-test-secret-not-real"
WEBHOOK_SECRET="e2e-webhook-$(openssl rand -hex 12)"
PIDS=""
cleanup() {
  if [ "${KEEP:-}" != "1" ]; then
    for p in $PIDS; do kill "$p" 2>/dev/null || true; done
    rm -rf "$TMP"
  else
    echo "servers kept: $PIDS; state in $TMP"
  fi
}
trap cleanup EXIT INT TERM

# 1. The databases.
"$PYTHON" "$ROOT/tools/make_fixture.py" --database "$TMP/mac.db" >/dev/null
(cd "$ROOT" && "$PYTHON" -m oscr --db "$TMP/mac.db" --cache "$TMP/cache" community build --local --folder "$TMP/community" >/dev/null)
npx wrangler d1 migrations apply oscr_community --local --env local --persist-to "$TMP/state" >/dev/null
npx wrangler d1 migrations apply oscr_forge --local --env local --persist-to "$TMP/state" >/dev/null
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

# 3. The site, reading the fake GitHub, and the Worker.
FORGE_GITHUB_API_URL="$FAKE/api" FORGE_GITHUB_RAW_URL="$FAKE/raw" FORGE_GITHUB_WEB_URL="$FAKE/web" \
  CATALOG_DIR=../tests/fixtures/public-catalog npm run build >"$TMP/build.log" 2>&1
WRANGLER_SEND_METRICS=false npx wrangler dev --env local --port "$SITE_PORT" --persist-to "$TMP/state" \
  --var "SESSION_KEY:e2e-$(openssl rand -hex 24)" \
  --var "ORCID_CLIENT_ID:APP-TESTORCID0000001" --var "ORCID_CLIENT_SECRET:orcid-test-secret" --var "ORCID_ISSUER:$MOCK/orcid" \
  --var "GITHUB_CLIENT_ID:Iv1.testgithubclient" --var "GITHUB_CLIENT_SECRET:github-test-secret" \
  --var "GITHUB_URL:$MOCK/github" --var "GITHUB_API_URL:$MOCK/github-api" \
  --var "GOOGLE_CLIENT_ID:test-client.apps.googleusercontent.com" --var "GOOGLE_CLIENT_SECRET:google-test-secret" \
  --var "GOOGLE_ISSUER:$MOCK/google" --var "CHECKS_URL:$MOCK/checks" --var "ACCOUNT_DEV_METRICS:1" \
  --var "GITHUB_APP_ID:1" --var "GITHUB_APP_SLUG:code-registry-dev" \
  --var "GITHUB_APP_CLIENT_ID:$CLIENT_ID" --var "GITHUB_APP_CLIENT_SECRET:$CLIENT_SECRET" \
  --var "GITHUB_APP_WEBHOOK_SECRET:$WEBHOOK_SECRET" --var "FORGE_OWNER_GITHUB_ID:$ADA_ID" \
  --var "FORGE_GITHUB_API_URL:$FAKE/api" --var "FORGE_GITHUB_WEB_URL:$FAKE/web" --var "FORGE_GITHUB_RAW_URL:$FAKE/raw" \
  --var "FORGE_GITHUB_UPLOADS_URL:$FAKE/uploads" >"$TMP/dev.log" 2>&1 &
PIDS="$PIDS $!"
i=0
until curl -fs "$SITE/api/account/me" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 120 ] && { echo "wrangler dev did not start:"; tail -20 "$TMP/dev.log"; exit 1; }
  sleep 0.5
done

# 4. The run.
SITE="$SITE" MOCK="$MOCK" FAKE="$FAKE" WEBHOOK_SECRET="$WEBHOOK_SECRET" node --experimental-strip-types tests/forge-service/e2e.ts
