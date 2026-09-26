"""L'interface lit la base en direct, en lecture seule, sur la machine seule."""
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from scrapper import base, contenus, interface


@pytest.fixture
def serveur(tmp_path):
    chemin = tmp_path / "b.db"
    con = base.ouvrir(chemin)
    base.enregistrer_article(con, {"id": "doi:10.1/x", "doi": "10.1/x", "titre": "Ondes alpha",
                                   "revue": "J Neuro", "date_pub": "2026-09-01"})
    con.execute("UPDATE article SET scanne_le = 1, statut = 'code_verifie' WHERE id = 'doi:10.1/x'")
    con.execute("INSERT INTO lien (article_id, norme, url, hote, genre, role, confiance, trouve_par) "
                "VALUES ('doi:10.1/x', 'github.com/lab/alpha', 'https://github.com/lab/alpha', "
                "'github.com', 'forge', 'code', 'forte', 'texte:disponibilite')")
    con.execute("INSERT INTO depot (norme, url, hote, genre, etat, licence, commit_) VALUES "
                "('github.com/lab/alpha', 'https://github.com/lab/alpha', 'github.com', 'forge', "
                "'vivant', '', 'abc123')")
    base.enregistrer_contenus(con, "github.com/lab/alpha", "abc123",
                              [contenus.lire("filtre.py", b"import mne\n")])
    con.commit()
    con.close()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), interface.gestionnaire(chemin))
    fil = threading.Thread(target=srv.serve_forever, daemon=True)
    fil.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def lire(url):
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())


def test_le_tableau_montre_l_article_son_depot_et_ses_scripts(serveur):
    r = lire(serveur + "/api/articles?n=10")
    assert r["total"] == 1
    a = r["lignes"][0]
    assert a["doi"] == "10.1/x" and a["code"][0]["norme"] == "github.com/lab/alpha" and a["code"][0]["n"] == 1
    s = lire(serveur + "/api/scripts?article=doi:10.1/x")
    f = s["depots"][0]["fichiers"][0]
    assert f["c"] == "filtre.py" and f["lisible"] is True
    assert f["src"] == "https://github.com/lab/alpha/blob/abc123/filtre.py"
    t = lire(serveur + "/api/fichier?depot=github.com/lab/alpha&chemin=filtre.py")
    assert t["texte"] == "import mne\n"


def test_la_recherche_filtre_et_la_page_est_servie(serveur):
    assert lire(serveur + "/api/articles?q=inexistant")["total"] == 0
    assert lire(serveur + "/api/articles?q=alpha")["total"] == 1
    with urllib.request.urlopen(serveur + "/") as r:
        assert b"<title>Code natif</title>" in r.read()


def test_l_interface_n_ecrit_jamais(serveur, tmp_path):
    avant = (tmp_path / "b.db").stat().st_mtime
    lire(serveur + "/api/etat")
    lire(serveur + "/api/articles")
    assert (tmp_path / "b.db").stat().st_mtime == avant
