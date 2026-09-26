#!/bin/zsh
# Installer le ramasseur sur ce Mac, en tâche de fond. Relancer ce script met
# l'installation à jour ; les données et les réglages restent.
#
#   outils/installer_mac.sh            installer (ou mettre à jour) et démarrer
#   outils/installer_mac.sh --retirer  tout retirer (les données restent)
#
# Trois tâches launchd :
#   fr.scrapper.veille     le ramasseur, en continu et en priorité basse
#   fr.scrapper.interface  le tableau sur http://127.0.0.1:8790
#   fr.scrapper.publier    chaque nuit à 4 h 17 : le catalogue sur Hugging Face
#
# Les journaux vont dans ~/Library/Logs/scrapper : launchd refuse d'ouvrir un
# journal sur le disque externe (la tâche meurt avant de démarrer, code 78).
set -euo pipefail

ICI=${0:A:h}
RACINE=${ICI:h}
AGENTS=~/Library/LaunchAgents
JOURNAUX=~/Library/Logs/scrapper
DOMAINE=gui/$(id -u)
REGLAGES=~/.config/scrapper/reglages
TACHES=(fr.scrapper.veille fr.scrapper.interface fr.scrapper.publier)
ANCIENNES=(fr.scrapper.tourner)  # le passage de nuit d'avant la veille

retirer() {
  for tache in "$@"; do
    launchctl bootout $DOMAINE/$tache 2>/dev/null || true
    rm -f $AGENTS/$tache.plist
  done
}

if [[ ${1:-} == --retirer ]]; then
  retirer $TACHES $ANCIENNES
  echo "Tâches retirées. Les données restent dans $RACINE/donnees."
  exit 0
fi

echo "1/4 environnement Python"
cd "$RACINE"
/opt/homebrew/bin/uv sync -q

echo "2/4 réglages ($REGLAGES)"
mkdir -p ${REGLAGES:h}
[[ -f $REGLAGES ]] || print -r -- "# Réglages du ramasseur (lus par scrapper veiller et scrapper nuit)" > $REGLAGES
ajouter() {  # CLE valeur [commentaire] — sans toucher à ce qui est déjà réglé
  grep -q "^$1=" $REGLAGES && return
  [[ -n ${3:-} ]] && print -r -- "# $3" >> $REGLAGES
  print -r -- "$1=$2" >> $REGLAGES
}
ajouter SCRAPPER_DOMAINE neuro
ajouter SCRAPPER_NOUVEAUTES_MINUTES 60
ajouter SCRAPPER_TRANCHE_MINUTES 30
ajouter SCRAPPER_JUSQU_EN 2000
ajouter SCRAPPER_HF_DATASET opsecsystems/bibliotheque-code-natif
ajouter SCRAPPER_PRIORITE fond "fond : discret, macOS bride aussi son réseau ; normale : ~3 fois plus rapide. Relancer l'installateur après changement."
ajouter SCRAPPER_ZENODO_INSTANCE bac-a-sable "Zenodo : bac-a-sable pour tout le développement (CLAUDE.md), zenodo pour les vrais DOI."
ajouter SCRAPPER_ZENODO_COMMUNAUTE code-natif-neurosciences
ajouter SCRAPPER_PLATEFORME "Bibliothèque du code natif"
ajouter SCRAPPER_CLOUDFLARE_PROJET "" "Site public : vide = pas de mise en ligne ; code-natif = reconstruit et mis en ligne chaque nuit (après npx wrangler login)."
# Le budget du passage de nuit ne sert plus : la veille remonte le stock en continu.
sed -i '' 's/^SCRAPPER_RATTRAPAGE_HEURES=/# (plus utilisé) SCRAPPER_RATTRAPAGE_HEURES=/' $REGLAGES

case $(grep "^SCRAPPER_PRIORITE=" $REGLAGES | tail -1 | cut -d= -f2) in
  normale) TYPE=Standard ;;
  *)       TYPE=Background ;;
esac

echo "3/4 tâches launchd (journaux : $JOURNAUX ; veille en $TYPE)"
retirer $ANCIENNES
mkdir -p $AGENTS $JOURNAUX
for tache in $TACHES; do
  neuf=$(mktemp)
  sed -e "s|@RACINE@|$RACINE|g" -e "s|@JOURNAUX@|$JOURNAUX|g" -e "s|@TYPE@|$TYPE|g" "$ICI/$tache.plist" > $neuf
  plutil -lint -s $neuf
  # La publication inchangée n'est pas rechargée : ce serait couper un envoi
  # en cours. La veille et l'interface, si, pour prendre le code à jour.
  if [[ $tache == fr.scrapper.publier ]] && cmp -s $neuf $AGENTS/$tache.plist \
      && launchctl print $DOMAINE/$tache >/dev/null 2>&1; then
    rm -f $neuf
    continue
  fi
  mv $neuf $AGENTS/$tache.plist
  chmod 644 $AGENTS/$tache.plist
  launchctl bootout $DOMAINE/$tache 2>/dev/null || true
  # Juste après un bootout, launchd refuse parfois un instant (« 5: Input/output error »).
  for essai in 1 2 3 4 5; do
    launchctl bootstrap $DOMAINE $AGENTS/$tache.plist 2>/dev/null && break
    sleep 1
  done
  launchctl print $DOMAINE/$tache >/dev/null || { echo "  ✗ $tache ne s'est pas chargée"; exit 1; }
done

echo "4/4 vérification"
sleep 4
for tache in fr.scrapper.veille fr.scrapper.interface; do
  if launchctl print $DOMAINE/$tache | grep -q "state = running"; then
    echo "  ✓ $tache tourne"
  else
    echo "  ✗ $tache ne tourne pas : voir $JOURNAUX/${tache#fr.scrapper.}.log"
  fi
done
# Au démarrage, l'interface attend que la veille lâche la base un instant.
for essai in {1..15}; do
  curl -fsS -m 5 http://127.0.0.1:8790/api/etat >/dev/null 2>&1 && break
  sleep 2
done
if curl -fsS -m 5 http://127.0.0.1:8790/api/etat >/dev/null 2>&1; then
  echo "  ✓ l'interface répond"
else
  echo "  ✗ l'interface ne répond pas : voir $JOURNAUX/interface.log"
fi

echo
echo "C'est installé."
echo "  Le tableau     : http://127.0.0.1:8790 (dans un navigateur, sur ce Mac)"
echo "  La veille      : tail -f $JOURNAUX/veille.log"
echo "  La publication : chaque nuit à 4 h 17 ; tail $JOURNAUX/publication.log"
echo "  Les réglages   : $REGLAGES"
