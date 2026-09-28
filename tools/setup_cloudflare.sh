#!/bin/sh
# Cloudflare for OSCR, in one go, run by the owner in their own Terminal (docs/SEARCH.md §7,
# docs/ACCOUNTS.md "The owner's steps"):
#
#   1. the three D1 databases, created if missing (oscr_catalog and oscr_search for the search,
#      oscr_community for the accounts), bound in website/wrangler.toml, with their tables;
#   2. the site rebuilt from the public catalogue and put online;
#   3. the search's first load (then every night: OSCR_D1_PUSH=remote in the settings);
#   4. the server key SESSION_KEY, made here and never shown;
#   5. the six sign-in values (ORCID, GitHub, Google), asked for one by one, never shown, never
#      written to a file: each goes straight into the Worker's Cloudflare secrets.
#
#   cd /Volumes/Expansion/Scrapper && sh tools/setup_cloudflare.sh
#
# It runs again safely: what exists is kept, and an empty answer keeps the current value. It uses
# wrangler's own login (`npx wrangler login`, the one the nightly deployment uses): no API token.
# Everything stays within the free plans of Workers and D1.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PY="$ROOT/.venv/bin/python"
PROJECT=oscr

say() { printf '\n== %s\n' "$1"; }

say "1/7 Cloudflare login and packages"
if [ -x /opt/homebrew/bin/uv ]; then /opt/homebrew/bin/uv sync -q; fi
cd "$ROOT/website"
if ! npx wrangler whoami </dev/null >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare. Run:  cd $ROOT/website && npx wrangler login"
  echo "then run this script again."
  exit 1
fi
echo "logged in"

say "2/7 The databases"
list_json() { npx wrangler d1 list --json </dev/null 2>/dev/null; }
existing=$(list_json)
for name in oscr_catalog oscr_search oscr_community; do
  if printf '%s' "$existing" | "$PY" -c 'import json,sys; n=sys.argv[1]; sys.exit(0 if any(d.get("name")==n for d in json.load(sys.stdin)) else 1)' "$name"; then
    echo "$name: exists"
  else
    npx wrangler d1 create "$name" --location weur </dev/null >/dev/null
    echo "$name: created (Western Europe)"
  fi
done
existing=$(list_json)
# The three databases bound at the top of wrangler.toml (their ids are identifiers, not secrets).
printf '%s' "$existing" | "$PY" "$ROOT/tools/bind_d1.py" "$ROOT/website/wrangler.toml"

say "3/7 Their tables"
for name in oscr_catalog oscr_search oscr_community; do
  npx wrangler d1 migrations apply "$name" --remote </dev/null | tail -n 2
done

say "4/7 The site, rebuilt and put online (a few minutes)"
cd "$ROOT"
"$PY" -m oscr --public --out data/public export
"$PY" -c 'from pathlib import Path; from oscr import publish; print(publish.deploy_cloudflare(Path("data/public"), "'"$PROJECT"'"))'

say "5/7 The search's first load"
"$PY" "$ROOT/tools/bind_d1.py" --settings OSCR_D1_PUSH=remote
"$PY" -m oscr d1 push --remote

say "6/7 The server key"
cd "$ROOT/website"
if npx wrangler secret list </dev/null 2>/dev/null | grep -qw SESSION_KEY; then
  echo "SESSION_KEY: already set, kept"
else
  openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SESSION_KEY >/dev/null
  echo "SESSION_KEY: made and stored (never shown)"
fi

say "7/7 The six sign-in values"
echo "Paste each value, then press Enter. Nothing shows while you paste: that is on purpose."
echo "An empty answer keeps the current value."
for name in ORCID_CLIENT_ID ORCID_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  printf '%s: ' "$name"
  stty -echo 2>/dev/null || true
  IFS= read -r value || value=""
  stty echo 2>/dev/null || true
  printf '\n'
  value=$(printf '%s' "$value" | tr -d '[:space:]')
  if [ -n "$value" ]; then
    printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null
    echo "  stored"
  else
    echo "  kept"
  fi
  value=""
done

printf '\nDone. Try https://oscr.yannbellec-b.workers.dev/account/ and https://oscr.yannbellec-b.workers.dev/search/\n'
printf 'Then tell Claude: it records the databases bound in website/wrangler.toml.\n'
