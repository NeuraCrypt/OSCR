#!/bin/sh
# The accounts and the contributions end to end, on this machine only (docs/ACCOUNTS.md, "Local
# end-to-end run"; docs/CONTRIBUTIONS.md):
#
# 1. the fixture's synthetic Mac database (tools/make_fixture.py), and its facts as SQL files
#    (`oscr community build --local`);
# 2. a throwaway local D1: the migrations, then those files (`wrangler d1 execute --local --file`);
# 3. the mock server (mock-server.ts: the providers; doi.org and the forges under /checks/; the Zenodo
#    sandbox under /zenodo/) and `wrangler dev --env local` (the site's Worker) with development
#    values only, never real client ids or secrets;
# 4. tests/account/e2e.ts: sign-ins, linking, verifications, sign-out, D1's count of rows written;
# 5. tests/contributions/e2e.ts, in three steps with the Mac's job runner between them (`oscr jobs
#    poll --local`, offline, its deposits on the mock Zenodo sandbox) and the owner's decisions
#    (`oscr claims accept`, `oscr reports reject`, `oscr submissions accept`).
#
#   cd website && npm ci && CATALOG_DIR=../tests/fixtures/public-catalog npm run build
#   SITE_PORT=8788 MOCK_PORT=9480 sh tests/account/e2e.sh     (KEEP=1 leaves both servers running)
#
# Everything lives in a temporary folder (--persist-to): the local D1 of `wrangler dev` is not
# touched, and nothing is remote: no real provider, forge, DOI registry or Zenodo is asked.
set -eu
cd "$(dirname "$0")/../.."
ROOT=$(cd .. && pwd)
PYTHON="$ROOT/.venv/bin/python"
TMP=$(mktemp -d)
MOCK_PORT=${MOCK_PORT:-9471}
SITE_PORT=${SITE_PORT:-8787}
MOCK_PID=""
DEV_PID=""
cleanup() {
  if [ "${KEEP:-}" != "1" ]; then
    [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true
    [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
    rm -rf "$TMP"
  else
    echo "servers kept: mock $MOCK_PID, wrangler dev $DEV_PID; state in $TMP"
  fi
}
trap cleanup EXIT INT TERM

[ -f dist/index.html ] || { echo "build the site first: CATALOG_DIR=../tests/fixtures/public-catalog npm run build"; exit 1; }

"$PYTHON" "$ROOT/tools/make_fixture.py" --database "$TMP/mac.db"
(cd "$ROOT" && "$PYTHON" -m oscr --db "$TMP/mac.db" --cache "$TMP/cache" community build --local --folder "$TMP/community")
npx wrangler d1 migrations apply oscr_community --local --env local --persist-to "$TMP/state" >/dev/null
for f in "$TMP"/community/local-*/*.sql; do
  npx wrangler d1 execute oscr_community --local --env local --persist-to "$TMP/state" --file "$f" --yes >/dev/null
done

node --experimental-strip-types tests/account/mock-server.ts "$MOCK_PORT" &
MOCK_PID=$!
MOCK="http://127.0.0.1:$MOCK_PORT"
WRANGLER_SEND_METRICS=false npx wrangler dev --env local --port "$SITE_PORT" --persist-to "$TMP/state" \
  --var "SESSION_KEY:e2e-$(openssl rand -hex 24)" \
  --var "ORCID_CLIENT_ID:APP-TESTORCID0000001" --var "ORCID_CLIENT_SECRET:orcid-test-secret" --var "ORCID_ISSUER:$MOCK/orcid" \
  --var "GITHUB_CLIENT_ID:Iv1.testgithubclient" --var "GITHUB_CLIENT_SECRET:github-test-secret" \
  --var "GITHUB_URL:$MOCK/github" --var "GITHUB_API_URL:$MOCK/github-api" \
  --var "GOOGLE_CLIENT_ID:test-client.apps.googleusercontent.com" --var "GOOGLE_CLIENT_SECRET:google-test-secret" \
  --var "GOOGLE_ISSUER:$MOCK/google" --var "CHECKS_URL:$MOCK/checks" --var "ACCOUNT_DEV_METRICS:1" >"$TMP/dev.log" 2>&1 &
DEV_PID=$!

i=0
until curl -fs "http://localhost:$SITE_PORT/api/account/me" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 120 ] && { echo "wrangler dev did not start:"; tail -20 "$TMP/dev.log"; exit 1; }
  sleep 0.5
done

SITE="http://localhost:$SITE_PORT" MOCK="$MOCK" node --experimental-strip-types tests/account/e2e.ts

# The contributions. The Mac's side runs offline (no Europe PMC, no git), its Zenodo is the mock
# (an explicit sandbox, whatever the settings say), and it reads and writes the same local D1.
mac() {
  (cd "$ROOT" && OSCR_ZENODO_SANDBOX_URL="$MOCK/zenodo" ZENODO_SANDBOX_TOKEN="e2e-mock-token" "$PYTHON" -m oscr \
    --db "$TMP/mac.db" --cache "$TMP/cache" --offline --no-verify --no-metadata --no-swh --no-contents --no-records "$@" \
    --local --persist-to "$TMP/state" --folder "$TMP/community" --instance sandbox)
}
owner_list() {
  (cd "$ROOT" && "$PYTHON" -m oscr --db "$TMP/mac.db" --cache "$TMP/cache" "$1" list --folder "$TMP/community")
}
export SITE="http://localhost:$SITE_PORT" MOCK JARS="$TMP/jars.json"
node --experimental-strip-types tests/contributions/e2e.ts ask
mac jobs poll
CLAIM=$(owner_list claims | sed -n 's/^claim \([0-9]*\):.* as author of .*/\1/p' | head -n 1)
REPORT=$(owner_list reports | sed -n 's/^request \([0-9]*\):.*/\1/p' | head -n 1)
mac claims accept "$CLAIM" --message "Welcome."
mac reports reject "$REPORT" --message "The record is correct."
node --experimental-strip-types tests/contributions/e2e.ts answers
mac jobs poll
SUBMISSION=$(owner_list submissions | sed -n 's/^submission \([0-9]*\):.*/\1/p' | head -n 1)
mac submissions accept "$SUBMISSION"
mac jobs poll
node --experimental-strip-types tests/contributions/e2e.ts published
(cd "$ROOT" && "$PYTHON" -m oscr --db "$TMP/mac.db" --cache "$TMP/cache" jobs status --folder "$TMP/community")
