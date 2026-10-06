#!/bin/bash
# nuit.sh — fait travailler Claude Code toute la nuit sur docs/NIGHT_RUN.md.
# Si une session s'arrête (limite d'usage, erreur, blocages répétés), elle est relancée
# et reprend grâce à docs/NIGHT_PROGRESS.md.
#
# Utilisation, depuis la racine du projet OSCR :
#   chmod +x nuit.sh
#   ./nuit.sh
# Pour arrêter : Ctrl+C dans ce terminal.

# Runs in the night worktree (.worktrees/night), never in the production checkout.
cd "$(dirname "$0")" || exit 1

JOURNAL_DIR="$HOME/oscr-night-logs"
mkdir -p "$JOURNAL_DIR"

# Empêche le Mac de se mettre en veille tant que ce script tourne.
caffeinate -ims -w $$ &

CONSIGNE="Tu es dans le worktree de nuit /Volumes/Expansion/Scrapper/.worktrees/night : ne change jamais la branche du dossier de production /Volumes/Expansion/Scrapper. Lis docs/NIGHT_RUN.md puis docs/NIGHT_PROGRESS.md, et reprends exactement là où le journal s'arrête. Respecte strictement les règles de la section 1."

while true; do
  if grep -q "NIGHT_RUN_COMPLETE" docs/NIGHT_PROGRESS.md 2>/dev/null; then
    echo "$(date '+%F %T') Mission terminée." | tee -a "$JOURNAL_DIR/boucle.log"
    break
  fi

  JOURNAL="$JOURNAL_DIR/session-$(date '+%F_%H-%M-%S').log"
  echo "$(date '+%F %T') Lancement d'une session → $JOURNAL" | tee -a "$JOURNAL_DIR/boucle.log"

  claude -p "$CONSIGNE" --permission-mode auto >> "$JOURNAL" 2>&1
  CODE=$?

  if [ $CODE -ne 0 ]; then
    # Souvent une limite d'usage atteinte : on attend avant de relancer.
    echo "$(date '+%F %T') Session terminée avec le code $CODE, pause de 15 min." | tee -a "$JOURNAL_DIR/boucle.log"
    sleep 900
  else
    sleep 60
  fi
done
