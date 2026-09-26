"""La base : un fichier SQLite, la seule mémoire du ramasseur.

**Pourquoi SQLite.** Un seul fichier, qu'on copie, qu'on versionne, qu'on
publie : il tient sur un hébergement gratuit (un dépôt GitHub, un jeu Hugging
Face) comme sur le Mac, et Datasette sait l'ouvrir tel quel.

**Les quatre tables qui comptent.**

- `article` : un article scanné, identifié par son DOI (à défaut son PMCID) ;
- `lien` : chaque dépôt qu'il cite, avec son RÔLE (code des auteurs, données,
  outil tiers) et les raisons du verdict ;
- `depot` : ce que la vérification a trouvé au bout du lien — vivant ou mort,
  commit, licence, nombre de scripts ;
- `script` : la BIBLIOTHÈQUE. Une ligne par article, origine et dépôt, avec
  son NIVEAU de preuve. L'origine vaut `natif` aujourd'hui ; `genere` (scripts
  écrits par stat_bruteforce) et `auteur` (corrections déposées par les
  auteurs) sont prévus par le schéma et ne sont pas codés.

**Les niveaux de preuve**, comme au catalogue de méthodes — un gabarit y est
EXÉCUTÉ ou seulement DOCUMENTÉ — : `trouve` (l'article cite le lien), `vivant`
(le lien répond), `inventorie` (on a la liste des fichiers et le commit),
`importe` (un instantané est gardé, avec son empreinte).

L'extrait de phrase qui a fait juger un lien est gardé pour la relecture, et
n'est JAMAIS exporté : une citation littérale du texte n'a rien à faire dans
une bibliothèque publique.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable

VERSION_SCHEMA = 1

STATUTS: tuple[str, ...] = (
    "code_verifie",      # un dépôt des auteurs, vivant, inventorié
    "code_trouve",       # un lien de code des auteurs, pas encore vérifié
    "code_vide",         # le dépôt répond mais ne contient aucun script reconnu
    "code_mort",         # le lien de code ne répond plus
    "sur_demande",       # l'article dit « disponible sur demande »
    "donnees_seules",    # des liens de données, aucun de code
    "aucun",             # rien
    "sans_texte",        # pas de plein texte : seules les métadonnées ont parlé
    "a_scanner",
)
NIVEAUX: tuple[str, ...] = ("trouve", "vivant", "inventorie", "importe")
ORIGINES: tuple[str, ...] = ("natif", "genere", "auteur")

SCHEMA = """
CREATE TABLE IF NOT EXISTS article (
    id                  TEXT PRIMARY KEY,
    doi                 TEXT NOT NULL DEFAULT '',
    pmid                TEXT NOT NULL DEFAULT '',
    pmcid               TEXT NOT NULL DEFAULT '',
    titre               TEXT NOT NULL DEFAULT '',
    auteurs             TEXT NOT NULL DEFAULT '[]',
    revue               TEXT NOT NULL DEFAULT '',
    date_pub            TEXT NOT NULL DEFAULT '',
    licence             TEXT NOT NULL DEFAULT '',
    source              TEXT NOT NULL DEFAULT '',
    plein_texte         INTEGER NOT NULL DEFAULT 0,
    a_declaration       INTEGER NOT NULL DEFAULT 0,
    code_sur_demande    INTEGER NOT NULL DEFAULT 0,
    donnees_sur_demande INTEGER NOT NULL DEFAULT 0,
    statut              TEXT NOT NULL DEFAULT 'a_scanner',
    familles            TEXT NOT NULL DEFAULT '[]',
    methodes            TEXT NOT NULL DEFAULT '[]',
    scanne_le           REAL,
    modifie_le          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS i_article_statut ON article(statut);
CREATE INDEX IF NOT EXISTS i_article_date ON article(date_pub);

CREATE TABLE IF NOT EXISTS lien (
    article_id   TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    norme        TEXT NOT NULL,
    url          TEXT NOT NULL,
    hote         TEXT NOT NULL,
    genre        TEXT NOT NULL,
    role         TEXT NOT NULL,
    confiance    TEXT NOT NULL,
    ecart        REAL NOT NULL DEFAULT 0,
    trouve_par   TEXT NOT NULL,
    section      TEXT NOT NULL DEFAULT '',
    raisons      TEXT NOT NULL DEFAULT '[]',
    extrait      TEXT NOT NULL DEFAULT '',
    occurrences  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (article_id, norme)
);
CREATE INDEX IF NOT EXISTS i_lien_norme ON lien(norme);

CREATE TABLE IF NOT EXISTS depot (
    norme           TEXT PRIMARY KEY,
    url             TEXT NOT NULL,
    hote            TEXT NOT NULL,
    genre           TEXT NOT NULL,
    etat            TEXT NOT NULL DEFAULT 'a_verifier',
    statut_http     INTEGER,
    type_ressource  TEXT NOT NULL DEFAULT '',
    licence         TEXT NOT NULL DEFAULT '',
    redistribuable  TEXT NOT NULL DEFAULT 'inconnu',
    commit_         TEXT NOT NULL DEFAULT '',
    date_commit     TEXT NOT NULL DEFAULT '',
    nb_fichiers     INTEGER,
    nb_scripts      INTEGER,
    langages        TEXT NOT NULL DEFAULT '{}',
    fichiers        TEXT NOT NULL DEFAULT '[]',
    etoiles         INTEGER,
    cree_le         TEXT NOT NULL DEFAULT '',
    cite_article    TEXT NOT NULL DEFAULT '',
    archive_swh     INTEGER,
    lie_a           TEXT NOT NULL DEFAULT '',
    erreur          TEXT NOT NULL DEFAULT '',
    verifie_le      REAL,
    CHECK (etat IN ('a_verifier', 'vivant', 'mort', 'inaccessible', 'non_verifiable'))
);

CREATE TABLE IF NOT EXISTS script (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    origine     TEXT NOT NULL,
    norme       TEXT NOT NULL,
    niveau      TEXT NOT NULL,
    commit_     TEXT NOT NULL DEFAULT '',
    chemin      TEXT NOT NULL DEFAULT '',
    empreinte   TEXT NOT NULL DEFAULT '',
    importe_le  REAL,
    PRIMARY KEY (article_id, origine, norme),
    CHECK (origine IN ('natif', 'genere', 'auteur')),
    CHECK (niveau IN ('trouve', 'vivant', 'inventorie', 'importe'))
);

-- Le TEXTE des scripts de chaque dépôt, tel qu'au commit vérifié. Un dépôt
-- revérifié à un autre commit remplace ses lignes. `texte` est NULL quand le
-- fichier est binaire ou n'a pas pu descendre ; `note` dit pourquoi.
CREATE TABLE IF NOT EXISTS fichier (
    depot        TEXT NOT NULL,
    chemin       TEXT NOT NULL,
    version      TEXT NOT NULL DEFAULT '',
    langage      TEXT NOT NULL DEFAULT '',
    genre        TEXT NOT NULL DEFAULT 'script',
    taille       INTEGER,
    lignes       INTEGER,
    empreinte    TEXT NOT NULL DEFAULT '',
    texte        TEXT,
    tronque      INTEGER NOT NULL DEFAULT 0,
    note         TEXT NOT NULL DEFAULT '',
    recupere_le  REAL,
    PRIMARY KEY (depot, chemin),
    CHECK (genre IN ('script', 'doc', 'note'))
);

CREATE TABLE IF NOT EXISTS curseur (
    source  TEXT PRIMARY KEY,
    valeur  TEXT NOT NULL,
    maj_le  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
    t          REAL NOT NULL,
    evenement  TEXT NOT NULL,
    details    TEXT NOT NULL DEFAULT '{}'
);

-- La validation d'une carte de traçage par un de ses auteurs (ORCID). La carte
-- gardée est celle qu'il a vue. Seule une carte validée reçoit un DOI : voir
-- CLAUDE.md et invenio.py. Preuve « essai » : développement, bac à sable seulement.
CREATE TABLE IF NOT EXISTS validation (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    orcid       TEXT NOT NULL,
    nom         TEXT NOT NULL,
    preuve      TEXT NOT NULL CHECK (preuve IN ('orcid', 'essai')),
    valide_le   REAL NOT NULL,
    carte       TEXT NOT NULL,
    PRIMARY KEY (article_id, orcid)
);

-- Le DOI Zenodo d'une carte validée, par instance (bac-a-sable ou zenodo).
CREATE TABLE IF NOT EXISTS carte_zenodo (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    instance    TEXT NOT NULL,
    recid       TEXT NOT NULL,
    doi         TEXT NOT NULL DEFAULT '',
    doi_concept TEXT NOT NULL DEFAULT '',
    depose_le   REAL NOT NULL,
    PRIMARY KEY (article_id, instance)
);

CREATE TABLE IF NOT EXISTS meta (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
"""


def ouvrir(chemin: Path | str) -> sqlite3.Connection:
    chemin = Path(chemin)
    chemin.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(chemin, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    # WAL : sur le Mac, la veille écrit en continu pendant que l'interface et
    # la publication de la nuit lisent ; en WAL, aucun ne bloque l'autre. Ce
    # qui SORT d'ici (tableau._base_publique) repasse en un seul fichier.
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA synchronous = NORMAL")  # sûr en WAL, et moins d'écritures
    con.executescript(SCHEMA)
    con.execute("INSERT OR IGNORE INTO meta VALUES ('version_schema', ?)", (str(VERSION_SCHEMA),))
    colonnes = {r["name"] for r in con.execute("PRAGMA table_info(depot)")}
    if "scripts_lus" not in colonnes:
        # Schéma 2 : le nombre de scripts dont le TEXTE est dans la table fichier.
        con.execute("ALTER TABLE depot ADD COLUMN scripts_lus INTEGER")
        con.execute("INSERT OR REPLACE INTO meta VALUES ('version_schema', '2')")
    return con


def _j(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)


def enregistrer_article(con: sqlite3.Connection, a: dict[str, Any]) -> None:
    """Créer ou compléter un article. Un champ vide n'efface jamais un champ plein."""
    maintenant = time.time()
    vu = con.execute("SELECT * FROM article WHERE id = ?", (a["id"],)).fetchone()
    champs = ("doi", "pmid", "pmcid", "titre", "revue", "date_pub", "licence", "source")
    if vu is None:
        con.execute(
            "INSERT INTO article (id, doi, pmid, pmcid, titre, auteurs, revue, date_pub, "
            "licence, source, modifie_le) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (a["id"], *(a.get(c, "") or "" for c in champs[:4]), _j(a.get("auteurs", [])),
             *(a.get(c, "") or "" for c in champs[4:]), maintenant))
        return
    maj = {c: a[c] for c in champs if a.get(c) and not vu[c]}
    if a.get("auteurs") and vu["auteurs"] == "[]":
        maj["auteurs"] = _j(a["auteurs"])
    if maj:
        ensemble = ", ".join(f"{c} = ?" for c in maj)
        con.execute(f"UPDATE article SET {ensemble}, modifie_le = ? WHERE id = ?",
                    (*maj.values(), maintenant, a["id"]))


def marquer_scan(con: sqlite3.Connection, article_id: str, *, plein_texte: bool,
                 a_declaration: bool, code_sur_demande: bool, donnees_sur_demande: bool,
                 familles: list[str], methodes: list[str]) -> None:
    con.execute(
        "UPDATE article SET plein_texte=?, a_declaration=?, code_sur_demande=?, "
        "donnees_sur_demande=?, familles=?, methodes=?, scanne_le=?, modifie_le=? WHERE id=?",
        (int(plein_texte), int(a_declaration), int(code_sur_demande), int(donnees_sur_demande),
         _j(familles), _j(methodes), time.time(), time.time(), article_id))


def remplacer_liens(con: sqlite3.Connection, article_id: str, candidats: Iterable[Any]) -> None:
    """Les liens d'un article sont ceux du DERNIER scan : on remplace, on n'empile pas."""
    con.execute("DELETE FROM lien WHERE article_id = ?", (article_id,))
    for c in candidats:
        con.execute(
            "INSERT OR REPLACE INTO lien (article_id, norme, url, hote, genre, role, confiance, "
            "ecart, trouve_par, section, raisons, extrait, occurrences) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (article_id, c.lien.norme, c.lien.url, c.lien.hote, c.lien.genre, c.role,
             c.confiance, c.ecart, c.trouve_par, c.section[:200], _j(c.raisons),
             c.extrait[:1000], c.occurrences))
        con.execute("INSERT OR IGNORE INTO depot (norme, url, hote, genre) VALUES (?,?,?,?)",
                    (c.lien.norme, c.lien.url, c.lien.hote, c.lien.genre))


def enregistrer_depot(con: sqlite3.Connection, norme: str, fiche: dict[str, Any]) -> None:
    fiche = dict(fiche)
    contenus = fiche.pop("_contenus", None)
    if contenus is not None:
        enregistrer_contenus(con, norme, fiche.get("commit_", "") or "", contenus)
        fiche["scripts_lus"] = sum(1 for c in contenus if c["genre"] == "script" and c["texte"])
    colonnes = [k for k in fiche if k != "norme"]
    valeurs = [(_j(v) if isinstance(v, (dict, list)) else v) for v in (fiche[k] for k in colonnes)]
    ensemble = ", ".join(f"{c} = ?" for c in colonnes)
    con.execute(f"UPDATE depot SET {ensemble}, verifie_le = ? WHERE norme = ?",
                (*valeurs, time.time(), norme))


def enregistrer_contenus(con: sqlite3.Connection, depot: str, version: str,
                         contenus: list[dict[str, Any]]) -> None:
    """Remplacer le texte des scripts d'un dépôt par celui de sa dernière vérification."""
    con.execute("DELETE FROM fichier WHERE depot = ?", (depot,))
    maintenant = time.time()
    for c in contenus:
        con.execute(
            "INSERT OR REPLACE INTO fichier (depot, chemin, version, langage, genre, taille, lignes, "
            "empreinte, texte, tronque, note, recupere_le) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (depot, c["chemin"], version, c.get("langage", ""), c.get("genre", "script"),
             c.get("taille"), c.get("lignes"), c.get("empreinte", ""), c.get("texte"),
             int(c.get("tronque", 0)), c.get("note", ""), maintenant))


def curseur(con: sqlite3.Connection, source: str, defaut: str = "") -> str:
    r = con.execute("SELECT valeur FROM curseur WHERE source = ?", (source,)).fetchone()
    return r["valeur"] if r else defaut


def poser_curseur(con: sqlite3.Connection, source: str, valeur: str) -> None:
    con.execute("INSERT OR REPLACE INTO curseur VALUES (?,?,?)", (source, valeur, time.time()))


def journaliser(con: sqlite3.Connection, evenement: str, **details: Any) -> None:
    con.execute("INSERT INTO journal VALUES (?,?,?)", (time.time(), evenement, _j(details)))
