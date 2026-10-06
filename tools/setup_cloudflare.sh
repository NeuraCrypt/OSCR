#!/bin/sh
# Cloudflare for OSCR, in one go, run by the owner in their own Terminal (docs/SEARCH.md §7,
# docs/ACCOUNTS.md "The owner's steps", docs/FORGE.md "The owner's steps"):
#
#   1. the four D1 databases, created if missing (oscr_catalog and oscr_search for the search,
#      oscr_community for the accounts, oscr_forge for the GitHub side), bound in
#      website/wrangler.toml, with their tables;
#   2. the site rebuilt from the public catalogue and put online;
#   3. the search's first load (then every night: OSCR_D1_PUSH=remote in the settings);
#   4. the server key SESSION_KEY, made here and never shown;
#   5. the six sign-in values (ORCID, GitHub, Google), asked for one by one, never shown, never
#      written to a file: each goes straight into the Worker's Cloudflare secrets;
#   6. the GitHub App of the GitHub side (night phase 01; register it first, docs/FORGE.md): its
#      id, client id, client secret and webhook secret pasted the same way; its private key read
#      from the .pem file GitHub gave (the path is asked, the key is never shown); its public name
#      (slug) and the owner's numeric GitHub id, stored as secrets too so that a deployment never
#      wipes them. FORGE_OPEN is never set here: the GitHub side's writes stay closed to everyone
#      but the owner until phase 16's content rules;
#   7. night phase 16, the human check (Cloudflare Turnstile, free: create the widget first,
#      docs/MODERATION.md "The owner's steps"): its secret key pasted the same way, never shown, a
#      Cloudflare secret; its site key, which is public, written to the Mac's settings
#      (OSCR_TURNSTILE_SITE_KEY) so that the nightly's build puts it in the forms. Without the secret,
#      FORGE_OPEN opens nothing and no report can be sent.
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

# One secret, pasted without being shown, straight into the Worker's Cloudflare secrets. Spaces and
# line breaks are removed. `digits` accepts digits only (an id). Nothing is written to a file, and
# the value is never printed.
ask_secret() {
  name=$1
  kind=${2:-text}
  printf '%s: ' "$name"
  stty -echo 2>/dev/null || true
  IFS= read -r value || value=""
  stty echo 2>/dev/null || true
  printf '\n'
  value=$(printf '%s' "$value" | tr -d '[:space:]')
  if [ -z "$value" ]; then
    echo "  kept"
  elif [ "$kind" = digits ] && printf '%s' "$value" | grep -q '[^0-9]'; then
    echo "  not stored: digits only (the current value is kept)"
  else
    printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null
    echo "  stored"
  fi
  value=""
}

say "1/9 Cloudflare login and packages"
if [ -x /opt/homebrew/bin/uv ]; then /opt/homebrew/bin/uv sync -q; fi
cd "$ROOT/website"
if ! npx wrangler whoami </dev/null >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare. Run:  cd $ROOT/website && npx wrangler login"
  echo "then run this script again."
  exit 1
fi
echo "logged in"

say "2/9 The databases"
list_json() { npx wrangler d1 list --json </dev/null 2>/dev/null; }
existing=$(list_json)
for name in oscr_catalog oscr_search oscr_community oscr_forge; do
  if printf '%s' "$existing" | "$PY" -c 'import json,sys; n=sys.argv[1]; sys.exit(0 if any(d.get("name")==n for d in json.load(sys.stdin)) else 1)' "$name"; then
    echo "$name: exists"
  else
    npx wrangler d1 create "$name" --location weur </dev/null >/dev/null
    echo "$name: created (Western Europe)"
  fi
done
existing=$(list_json)
# The four databases bound at the top of wrangler.toml (their ids are identifiers, not secrets).
printf '%s' "$existing" | "$PY" "$ROOT/tools/bind_d1.py" "$ROOT/website/wrangler.toml"

say "3/9 Their tables"
for name in oscr_catalog oscr_search oscr_community oscr_forge; do
  npx wrangler d1 migrations apply "$name" --remote </dev/null | tail -n 2
done

say "4/9 The site, rebuilt and put online (a few minutes)"
cd "$ROOT"
"$PY" -m oscr --public --out data/public export
"$PY" -c 'from pathlib import Path; from oscr import publish; print(publish.deploy_cloudflare(Path("data/public"), "'"$PROJECT"'"))'

say "5/9 The search's first load"
"$PY" "$ROOT/tools/bind_d1.py" --settings OSCR_D1_PUSH=remote
"$PY" -m oscr d1 push --remote

say "6/9 The server key"
cd "$ROOT/website"
if npx wrangler secret list </dev/null 2>/dev/null | grep -qw SESSION_KEY; then
  echo "SESSION_KEY: already set, kept"
else
  openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SESSION_KEY >/dev/null
  echo "SESSION_KEY: made and stored (never shown)"
fi

say "7/9 The six sign-in values"
echo "Paste each value, then press Enter. Nothing shows while you paste: that is on purpose."
echo "An empty answer keeps the current value."
for name in ORCID_CLIENT_ID ORCID_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  ask_secret "$name"
done

say "8/9 The GitHub App (the GitHub side; register it on GitHub first: docs/FORGE.md)"
echo "Paste each value from the App's settings page on GitHub, then press Enter. Nothing shows."
echo "An empty answer keeps the current value."
ask_secret GITHUB_APP_ID digits
ask_secret GITHUB_APP_CLIENT_ID
ask_secret GITHUB_APP_CLIENT_SECRET
ask_secret GITHUB_APP_WEBHOOK_SECRET
echo "The App's public name, as in its address https://github.com/apps/<name>:"
ask_secret GITHUB_APP_SLUG
echo "Your own numeric GitHub id (https://api.github.com/users/<your login>, the field \"id\"):"
echo "while FORGE_OPEN is not set, only this GitHub account may act on the GitHub side."
ask_secret FORGE_OWNER_GITHUB_ID digits
# The private key: GitHub's .pem file as it is (PKCS#1). Only its path is asked; the key goes from
# the file straight to wrangler, and is never printed.
printf 'The path of the private key file GitHub gave you (.pem; empty keeps the current key): '
IFS= read -r pem || pem=""
if [ -z "$pem" ]; then
  echo "  kept"
elif [ ! -f "$pem" ] || [ ! -r "$pem" ]; then
  echo "  not stored: no readable file at that path"
elif ! head -n 1 "$pem" | grep -Eq '^-----BEGIN (RSA )?PRIVATE KEY-----'; then
  echo "  not stored: that file is not a private key in PEM form"
else
  npx wrangler secret put GITHUB_APP_PRIVATE_KEY <"$pem" >/dev/null
  echo "  stored (you may now delete the .pem file, or keep it somewhere safe)"
fi
pem=""
echo "FORGE_OPEN: not set, on purpose: the GitHub side opens to the public with its content rules (phase 16)."

say "9/9 The human check: Cloudflare Turnstile (night phase 16; create the widget first: docs/MODERATION.md)"
echo "Paste the widget's SECRET key, then press Enter. Nothing shows. An empty answer keeps the current value."
ask_secret TURNSTILE_SECRET_KEY
printf 'The widget'"'"'s SITE key (public: the forms carry it; empty keeps the current one): '
IFS= read -r sitekey || sitekey=""
sitekey=$(printf '%s' "$sitekey" | tr -d '[:space:]')
SETTINGS="$HOME/.config/oscr/settings"
if [ -z "$sitekey" ]; then
  echo "  kept"
elif ! printf '%s' "$sitekey" | grep -Eq '^[0-9A-Za-z_-]{10,100}$'; then
  echo "  not stored: a site key is letters, digits, - and _"
else
  mkdir -p "$(dirname "$SETTINGS")"
  touch "$SETTINGS"
  grep -v '^OSCR_TURNSTILE_SITE_KEY=' "$SETTINGS" >"$SETTINGS.next" || true
  printf 'OSCR_TURNSTILE_SITE_KEY=%s\n' "$sitekey" >>"$SETTINGS.next"
  mv "$SETTINGS.next" "$SETTINGS"
  echo "  written to the Mac's settings: every build of the nightly puts it in the forms"
  echo "  (a build by hand: TURNSTILE_SITE_KEY=<the site key> npm run deploy, in website/)"
fi
sitekey=""

printf '\nDone. Try https://openscicode.org/account/ and https://openscicode.org/search/\n'
printf 'Then tell Claude: it records the databases bound in website/wrangler.toml.\n'
