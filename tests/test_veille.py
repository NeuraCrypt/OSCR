"""La veille continue du Mac : elle enchaîne nouveautés, revérification et stock,
survit aux coupures sans rien conclure pendant qu'elles durent, et partage la
base avec l'interface et la publication de la nuit."""
import io
import sqlite3
import zipfile

import httpx
import pytest

from scrapper import base, contenus, publier, tableau, tourner
from scrapper.reseau import Client, Panne, Reponse
from scrapper.sources import europepmc


class Journal:
    """Remplace les étapes de la veille et note leur ordre."""

    def __init__(self, monkeypatch, pannes=0):
        self.appels, self.pannes, self.siestes = [], pannes, []
        monkeypatch.setattr(tourner, "tourner", self._tourner)
        monkeypatch.setattr(tourner, "reverifier", lambda *a, **k: self.appels.append("reverif") or 0)
        monkeypatch.setattr(tourner, "rattraper", lambda *a, **k: self.appels.append("stock")
                            or tourner.Compte())
        monkeypatch.setattr(tourner.time, "sleep", self.siestes.append)

    def _tourner(self, *a, **k):
        if self.pannes:
            self.pannes -= 1
            raise Panne("réseau coupé")
        self.appels.append("nouveautes")
        return tourner.Compte()


def test_la_veille_enchaine_nouveautes_revérification_et_stock(tmp_path, monkeypatch):
    con = base.ouvrir(tmp_path / "b.db")
    j = Journal(monkeypatch)
    tourner.veiller(con, Client(hors_ligne=True), "neuro", tourner.Options(), iterations=2,
                    rapport=lambda _: None)
    # Les nouveautés et la revérification une fois, le stock à chaque tour.
    assert j.appels == ["nouveautes", "reverif", "stock", "stock"]


def test_le_stock_fini_la_veille_dort(tmp_path, monkeypatch):
    con = base.ouvrir(tmp_path / "b.db")
    base.poser_curseur(con, "rattrapage:neuro", "1999-12")
    assert tourner.stock_termine(con, "neuro", 2000)
    j = Journal(monkeypatch)
    tourner.veiller(con, Client(hors_ligne=True), "neuro", tourner.Options(), iterations=1,
                    repos_s=900, rapport=lambda _: None)
    assert "stock" not in j.appels and j.siestes == [900]


def test_une_coupure_fait_attendre_puis_reprendre(tmp_path, monkeypatch):
    con = base.ouvrir(tmp_path / "b.db")
    j = Journal(monkeypatch, pannes=2)
    messages = []
    tourner.veiller(con, Client(hors_ligne=True), "neuro", tourner.Options(), iterations=3,
                    rapport=messages.append)
    assert j.siestes == [120, 240]            # 2 min, puis 4 min
    assert j.appels[0] == "nouveautes"        # puis le travail reprend
    assert any("Panne" in m for m in messages)


def test_une_panne_qui_dure_arrete_la_veille_pour_que_launchd_la_relance(tmp_path, monkeypatch):
    con = base.ouvrir(tmp_path / "b.db")
    Journal(monkeypatch, pannes=100)
    with pytest.raises(Panne):
        tourner.veiller(con, Client(hors_ligne=True), "neuro", tourner.Options(), iterations=50,
                        rapport=lambda _: None)


def test_la_veille_rend_la_main_apres_sa_duree(tmp_path, monkeypatch):
    con = base.ouvrir(tmp_path / "b.db")
    j = Journal(monkeypatch)
    tourner.veiller(con, Client(hors_ligne=True), "neuro", tourner.Options(), duree_max_s=0,
                    rapport=lambda _: None)
    assert j.appels == []


def test_une_page_d_erreur_tient_en_une_ligne_dans_le_journal(tmp_path, monkeypatch):
    con = base.ouvrir(tmp_path / "b.db")
    j = Journal(monkeypatch)
    monkeypatch.setattr(tourner, "tourner", lambda *a, **k: (_ for _ in ()).throw(Panne(
        "Europe PMC /search : HTTP 503 — <html>\n<head><title>503 Service Temporarily Unavailable"
        "</title></head>\n<body><hr><center>nginx</cente")))
    messages = []
    tourner.veiller(con, Client(hors_ligne=True), "neuro", tourner.Options(), iterations=1,
                    rapport=messages.append)
    assert len(messages) == 1 and "\n" not in messages[0]
    assert messages[0].endswith(" ! Panne: Europe PMC /search : HTTP 503 — "
                                "503 Service Temporarily Unavailable nginx — reprise dans 2 min")


class ClientCoupe:
    def __init__(self, statut):
        self.statut = statut

    def get(self, url, **kw):
        return Reponse(url, self.statut, "panne réseau : ConnectError" if self.statut == 0 else "")


def test_un_article_lu_pendant_une_coupure_n_est_pas_sans_texte():
    with pytest.raises(Panne):
        europepmc.plein_texte(ClientCoupe(0), "PMC123")
    with pytest.raises(Panne):
        europepmc.plein_texte(ClientCoupe(503), "PMC123")
    # Un 404, lui, est une réponse : l'article n'a pas de texte.
    assert europepmc.plein_texte(ClientCoupe(404), "PMC123") is None


def test_une_coupure_arrete_le_passage_sans_marquer_l_article(tmp_path, monkeypatch):
    con = base.ouvrir(tmp_path / "b.db")
    art = europepmc.ArticleEPMC(id="pmcid:PMC1", doi="10.1/x", pmcid="PMC1", source="PMC",
                                id_texte="PMC1")
    monkeypatch.setattr(europepmc, "parcourir", lambda *a, **k: iter([art]))
    monkeypatch.setattr(europepmc, "plein_texte", lambda *a: (_ for _ in ()).throw(Panne("coupé")))
    with pytest.raises(Panne):
        tourner.scanner_requete(con, Client(hors_ligne=True), "q", tourner.Options(biblio=tmp_path),
                                rapport=lambda _: None)
    ligne = con.execute("SELECT scanne_le FROM article WHERE id = 'pmcid:PMC1'").fetchone()
    assert ligne is None or ligne["scanne_le"] is None   # il sera relu


def test_la_revérification_ne_reprend_que_les_depots_de_code_a_revoir(tmp_path, monkeypatch):
    con = base.ouvrir(tmp_path / "b.db")
    for art, norme, role, genre, etat in [
        ("a1", "github.com/a/code", "code", "forge", "inaccessible"),
        ("a2", "github.com/b/outil", "outil_tiers", "forge", "inaccessible"),
        ("a3", "doi:10.1/donnees", "donnees", "donnees", "a_verifier"),
        ("a4", "github.com/d/frais", "code", "forge", "vivant"),
    ]:
        con.execute("INSERT INTO article (id, modifie_le) VALUES (?, 0)", (art,))
        con.execute("INSERT INTO lien (article_id, norme, url, hote, genre, role, confiance, trouve_par) "
                    "VALUES (?,?,?,?,?,?,'haute','texte')", (art, norme, f"https://{norme}", "", genre, role))
        con.execute("INSERT INTO depot (norme, url, hote, genre, etat, verifie_le) VALUES (?,?,?,?,?,?)",
                    (norme, f"https://{norme}", "", genre, etat, tourner.time.time()))
    vus = []
    monkeypatch.setattr(tourner, "verifier_article", lambda con, c, i, o: vus.append(i) or 0)
    monkeypatch.setattr(tourner, "conclure", lambda *a: "")
    assert tourner.reverifier(con, Client(hors_ligne=True), tourner.Options(fiches=False)) == 1
    assert vus == ["a1"]


def test_la_base_de_travail_est_en_wal_et_la_copie_publique_en_un_fichier(tmp_path):
    con = base.ouvrir(tmp_path / "b.db")
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    # L'interface lit pendant qu'une écriture est en cours : personne n'attend.
    con.execute("INSERT INTO article (id, titre, modifie_le) VALUES ('x', 'avant', 0)")
    con.commit()
    con.execute("UPDATE article SET titre = 'pendant' WHERE id = 'x'")
    lecteur = sqlite3.connect(f"file:{tmp_path / 'b.db'}?mode=ro", uri=True, timeout=0.1)
    assert lecteur.execute("SELECT titre FROM article").fetchone()[0] == "avant"
    con.commit()
    tableau._base_publique(con, tmp_path / "pub.db")
    entete = (tmp_path / "pub.db").read_bytes()[:20]
    assert (entete[18], entete[19]) == (1, 1)      # mode « rollback » : un seul fichier
    assert not (tmp_path / "pub.db-wal").exists()


def test_un_tableau_prive_ne_part_pas_sur_hugging_face(tmp_path):
    con = base.ouvrir(tmp_path / "b.db")
    tableau.generer(con, tmp_path / "site", public=False)
    with pytest.raises(SystemExit, match="mode public"):
        publier.publier(tmp_path / "site", "compte/jeu", essai=True)
    tableau.generer(con, tmp_path / "site", public=True)
    assert "essai" in publier.publier(tmp_path / "site", "compte/jeu", essai=True)


def _zip(n_octets_bruit: int) -> bytes:
    tampon = io.BytesIO()
    with zipfile.ZipFile(tampon, "w", zipfile.ZIP_STORED) as z:
        z.writestr("depot-v1/analyse.py", "print('ok')\n")
        z.writestr("depot-v1/bruit.bin", b"\0" * n_octets_bruit)
    return tampon.getvalue()


def test_une_archive_passe_par_le_disque_et_se_lit(tmp_path):
    corps = _zip(3_000_000)
    client = Client()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda req: httpx.Response(200, content=corps)))
    client._attendre = lambda *a: None
    with client.telecharger_archive("https://zenodo.org/f.zip", 10_000_000) as f:
        assert f._rolled                        # au-delà de 1 Mo : sur le disque
        fichiers = contenus.depuis_zip(f)
    assert [x["chemin"] for x in fichiers] == ["analyse.py"]
    # Trop gros : abandonné en route, rien n'est rendu.
    assert client.telecharger_archive("https://zenodo.org/f.zip", 1_000_000) is None


def test_les_reglages_du_mac_se_lisent_sans_shell(tmp_path):
    from scrapper import cli
    f = tmp_path / "reglages"
    f.write_text("# commentaire\nSCRAPPER_DOMAINE=electrophysiologie\n"
                 "# (plus utilisé) SCRAPPER_RATTRAPAGE_HEURES=6\nSCRAPPER_HF_DATASET=\"compte/jeu\"\n")
    assert cli.reglages(f) == {"SCRAPPER_DOMAINE": "electrophysiologie", "SCRAPPER_HF_DATASET": "compte/jeu"}
    assert cli.reglages(tmp_path / "absent") == {}
