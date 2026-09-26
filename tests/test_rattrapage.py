import time

from scrapper import base, tourner
from scrapper.reseau import Client


def test_les_mois_se_remontent_et_se_bornent():
    assert tourner._mois_precedent("2026-01") == "2025-12"
    assert tourner._mois_precedent("2026-03") == "2026-02"
    assert tourner._bornes("2024-02") == ("2024-02-01", "2024-02-29")
    assert tourner._bornes("2025-12") == ("2025-12-01", "2025-12-31")


def test_un_budget_epuise_rend_la_main_sans_bouger_le_curseur(tmp_path):
    # Échéance déjà passée : aucun mois n'est entamé, le curseur ne bouge pas,
    # et aucune requête ne part (client hors ligne).
    con = base.ouvrir(tmp_path / "b.db")
    base.poser_curseur(con, "rattrapage:neuro", "2019-06")
    c = tourner.rattraper(con, Client(hors_ligne=True), "neuro", tourner.Options(biblio=tmp_path),
                          duree_max_s=-1, rapport=lambda _: None)
    assert c.articles == 0
    assert base.curseur(con, "rattrapage:neuro") == "2019-06"


def test_le_rattrapage_s_arrete_a_l_annee_demandee(tmp_path):
    con = base.ouvrir(tmp_path / "b.db")
    base.poser_curseur(con, "rattrapage:neuro", "1999-12")
    debut = time.time()
    tourner.rattraper(con, Client(hors_ligne=True), "neuro", tourner.Options(biblio=tmp_path),
                      duree_max_s=60, jusqu_en=2000, rapport=lambda _: None)
    assert time.time() - debut < 5


def test_le_mois_en_cours_est_note_des_son_debut(tmp_path, monkeypatch):
    # L'interface doit montrer le mois que la veille remonte, pas attendre sa fin.
    con = base.ouvrir(tmp_path / "b.db")
    base.poser_curseur(con, "rattrapage:neuro", "2019-06")
    vus = []
    def scanner(con, client, q, opts, **k):
        vus.append(base.curseur(con, "rattrapage:neuro"))
        return tourner.Compte(interrompu=True)
    monkeypatch.setattr(tourner, "scanner_requete", scanner)
    tourner.rattraper(con, Client(hors_ligne=True), "neuro", tourner.Options(biblio=tmp_path),
                      duree_max_s=60, rapport=lambda _: None)
    assert vus == ["2019-06"] and base.curseur(con, "rattrapage:neuro") == "2019-06"
