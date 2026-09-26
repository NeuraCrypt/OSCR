"""Les quotas des services tiers (mesurés et documentés le 26/09/2026) : un
quota épuisé met le service de côté, il ne bloque jamais un passage."""
import time

from scrapper import depots, liens, role
from scrapper.jats import Occurrence
from scrapper.reseau import Reponse


class ClientFactice:
    """Rend des réponses préparées, et compte les appels."""

    def __init__(self, reponses):
        self.reponses = list(reponses)
        self.appels = 0

    def get(self, url, **kw):
        self.appels += 1
        return self.reponses.pop(0) if self.reponses else Reponse(url, 200, "{}")


def test_software_heritage_epuise_est_mis_de_cote_jusqu_a_sa_remise_a_zero():
    depots._EN_PAUSE.clear()
    reset = str(int(time.time()) + 1800)
    c = ClientFactice([Reponse("u", 429, "", entetes={"x-ratelimit-remaining": "0",
                                                      "x-ratelimit-reset": reset})])
    assert depots.archive_swh(c, "https://github.com/a/b") is None
    # Le suivant ne part même pas : le service est en pause.
    assert depots.archive_swh(c, "https://github.com/c/d") is None
    assert c.appels == 1
    depots._EN_PAUSE.clear()


def test_osf_epuise_rend_un_depot_a_revoir_pas_un_depot_mort():
    depots._EN_PAUSE.clear()
    c = ClientFactice([Reponse("u", 429, "")])
    fiche = depots.verifier_osf(c, liens.normaliser("https://osf.io/abcde/"))
    assert fiche["etat"] == "inaccessible" and "quota" in fiche["erreur"]
    depots._EN_PAUSE.clear()


def test_le_jeton_passe_dans_un_en_tete_jamais_dans_l_adresse(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "jeton-secret")
    args = depots._auth_github()
    assert args[0] == "-c" and args[1].startswith("http.https://github.com/.extraheader=AUTHORIZATION: basic ")
    assert "jeton-secret" not in args[1]
    monkeypatch.delenv("GITHUB_TOKEN")
    assert depots._auth_github() == []


def test_des_codes_d_accession_ne_sont_pas_du_code():
    u = "https://www.rcsb.org/structure/9D8G"
    occ = Occurrence(u, "The structures have been deposited in the Protein Data Bank with accession "
                        "codes 9D8G and 9D6P.", ("Methods",), "corps")
    assert role.juger(occ, liens.normaliser(u), ["X"]).role == "donnees"
    g = "https://github.com/lab/popcode"
    occ = Occurrence(g, f"The population code analysis scripts are available at {g}.",
                     ("Code availability",), "disponibilite")
    assert role.juger(occ, liens.normaliser(g), ["X"]).role == "code"
