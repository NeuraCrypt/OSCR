#!/bin/zsh
# Install OSCR on this Mac, as background tasks. Running this script again updates the
# installation; the data and the settings stay.
#
#   tools/install_mac.sh              install (or update) and start
#   tools/install_mac.sh --uninstall  remove everything (the data stays)
#
# Three launchd tasks:
#   org.oscr.harvester  the harvester, continuously and at low priority
#   org.oscr.dashboard  the local dashboard on http://127.0.0.1:8790
#   org.oscr.nightly    every night at 04:17: the catalogue on Hugging Face and the website
#
# The logs go to ~/Library/Logs/oscr: launchd refuses to open a log on the external disk
# (the task dies before starting, exit code 78).
set -euo pipefail

HERE=${0:A:h}
ROOT=${HERE:h}
AGENTS=~/Library/LaunchAgents
LOGS=~/Library/Logs/oscr
DOMAIN=gui/$(id -u)
SETTINGS=~/.config/oscr/settings
TASKS=(org.oscr.harvester org.oscr.dashboard org.oscr.nightly org.oscr.jobs)

remove() {
  for task in "$@"; do
    launchctl bootout $DOMAIN/$task 2>/dev/null || true
    rm -f $AGENTS/$task.plist
  done
}

if [[ ${1:-} == --uninstall ]]; then
  remove $TASKS
  echo "Tasks removed. The data stays in $ROOT/data."
  exit 0
fi

echo "1/5 Python environment"
cd "$ROOT"
/opt/homebrew/bin/uv sync -q

echo "2/5 settings ($SETTINGS)"
mkdir -p ${SETTINGS:h}
[[ -f $SETTINGS ]] || print -r -- "# OSCR settings, read by \`oscr watch\` and \`oscr nightly\`" > $SETTINGS
add() {  # KEY value [comment], never touching what is already set
  grep -q "^$1=" $SETTINGS && return
  [[ -n ${3:-} ]] && print -r -- "# $3" >> $SETTINGS
  print -r -- "$1=$2" >> $SETTINGS
}
add OSCR_DOMAIN neuro "neuro | electrophysiology | a Europe PMC query"
add OSCR_NEWS_MINUTES 60
add OSCR_SLICE_MINUTES 30
add OSCR_BACK_TO 2000
add OSCR_PRIORITY background "background: discreet, macOS also throttles its network; normal: ~3 times faster. Run this installer again after a change."
add OSCR_HF_DATASET opsecsystems/oscr-catalog "Hugging Face dataset of the nightly publication (empty: nothing sent)"
add OSCR_CLOUDFLARE_PROJECT "" "Website: empty = not put online; a Cloudflare Pages project name = rebuilt and put online every night (after npx wrangler login)."
add OSCR_ZENODO_INSTANCE sandbox "Zenodo: sandbox for all development (CLAUDE.md), zenodo for real DOIs."
add OSCR_ZENODO_COMMUNITY oscr
add OSCR_PLATFORM_NAME "Open Scientific Code Registry (OSCR)"

echo "3/5 Zenodo tokens"
for service in org.oscr.zenodo-sandbox org.oscr.zenodo; do
  if security find-generic-password -s $service >/dev/null 2>&1; then
    echo "  ✓ $service is in the keychain"
  else
    echo "  – $service is not in the keychain (see docs/GETTING_STARTED.md)"
  fi
done

case $(grep "^OSCR_PRIORITY=" $SETTINGS | tail -1 | cut -d= -f2) in
  normal) PROCESS_TYPE=Standard ;;
  *)      PROCESS_TYPE=Background ;;
esac

echo "4/5 launchd tasks (logs: $LOGS; harvester as $PROCESS_TYPE)"
mkdir -p $AGENTS $LOGS
for task in $TASKS; do
  new=$(mktemp)
  sed -e "s|@ROOT@|$ROOT|g" -e "s|@LOGS@|$LOGS|g" -e "s|@PROCESS_TYPE@|$PROCESS_TYPE|g" "$HERE/$task.plist" > $new
  plutil -lint -s $new
  # An unchanged nightly task is not reloaded: that would cut an upload in progress. The
  # harvester and the dashboard are, to pick up the updated code.
  if [[ $task == org.oscr.nightly ]] && cmp -s $new $AGENTS/$task.plist \
      && launchctl print $DOMAIN/$task >/dev/null 2>&1; then
    rm -f $new
    continue
  fi
  mv $new $AGENTS/$task.plist
  chmod 644 $AGENTS/$task.plist
  launchctl bootout $DOMAIN/$task 2>/dev/null || true
  # Right after a bootout, launchd sometimes refuses for a moment ("5: Input/output error").
  for attempt in 1 2 3 4 5; do
    launchctl bootstrap $DOMAIN $AGENTS/$task.plist 2>/dev/null && break
    sleep 1
  done
  launchctl print $DOMAIN/$task >/dev/null || { echo "  ✗ $task did not load"; exit 1; }
done

echo "5/5 checks"
sleep 4
for task in org.oscr.harvester org.oscr.dashboard; do
  if launchctl print $DOMAIN/$task | grep -q "state = running"; then
    echo "  ✓ $task is running"
  else
    echo "  ✗ $task is not running: see $LOGS/${task#org.oscr.}.log"
  fi
done
# At start-up, the dashboard waits for the harvester to let go of the database for a moment.
for attempt in {1..15}; do
  curl -fsS -m 5 http://127.0.0.1:8790/api/stats >/dev/null 2>&1 && break
  sleep 2
done
if curl -fsS -m 5 http://127.0.0.1:8790/api/stats >/dev/null 2>&1; then
  echo "  ✓ the dashboard answers"
else
  echo "  ✗ the dashboard does not answer: see $LOGS/dashboard.log"
fi

echo
echo "Installed."
echo "  Dashboard  : http://127.0.0.1:8790 (in a browser, on this Mac)"
echo "  Harvester  : tail -f $LOGS/harvester.log"
echo "  Nightly    : every night at 04:17; tail $LOGS/nightly.log"
echo "  Settings   : $SETTINGS"
