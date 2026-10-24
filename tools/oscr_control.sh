#!/bin/zsh
# Interrupteur marche/pause de tout le moteur OSCR, appele par l'appli de la barre de menus.
#   oscr_control.sh pause    arrete le ramassage et la publication (watchdog compris)
#   oscr_control.sh resume   relance tout
#   oscr_control.sh status   -> "paused" ou "running"
# Ne touche jamais au tableau de bord, au surveillant, ni a l'appli de la barre de menus.
set -u
U=$(id -u)
AGENTS=(org.oscr.harvester org.oscr.watchdog org.oscr.jobs org.oscr.nightly)
LA="$HOME/Library/LaunchAgents"
FLAG="$HOME/OSCR/data/state/paused"

case "${1:-status}" in
  pause)
    for a in $AGENTS; do launchctl bootout gui/$U/$a 2>/dev/null; done
    # stoppe aussi un ramasseur/publication deja en cours
    pkill -f '/OSCR/.venv/bin/python -m oscr --no-records watch' 2>/dev/null
    mkdir -p "$(dirname "$FLAG")"; : > "$FLAG"
    echo paused ;;
  resume)
    rm -f "$FLAG"
    for a in $AGENTS; do [ -f "$LA/$a.plist" ] && launchctl bootstrap gui/$U "$LA/$a.plist" 2>/dev/null; done
    echo running ;;
  status)
    [ -f "$FLAG" ] && echo paused || echo running ;;
  *)
    echo "usage: oscr_control.sh pause|resume|status" >&2; exit 2 ;;
esac
