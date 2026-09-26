"""Le réseau : un client poli, qui attend, réessaie et garde ce qu'il a lu.

**Pourquoi un seul client.** Toutes les sources du ramasseur sont des services
publics gratuits qu'on interroge sans clé. Ce qui les garde gratuits, c'est
qu'on ne les martèle pas. La politesse ne peut donc pas être laissée à chaque
module : un intervalle minimal PAR HÔTE est tenu ici, une fois pour toutes.

**Pourquoi un cache sur disque.** Un plein texte ne change pas, et une
reprise après une coupure ne doit rien re-télécharger. Le cache vit dans
`donnees/cache/`, jamais publié : on n'héberge ni le PDF ni le plein texte d'un
article, seulement ce qu'on en a tiré.

**Ce qu'il n'envoie pas.** Aucune adresse de contact par défaut. Crossref et
OpenAlex servent mieux les requêtes qui en portent une (le « pool poli ») ;
c'est à l'utilisateur de la donner, par la variable `SCRAPPER_CONTACT`.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any
from urllib.parse import urlsplit

import httpx

#: Intervalle minimal entre deux requêtes vers un même hôte, en secondes.
#: Europe PMC a tenu 1,4 requête/s sans étranglement (mesuré le 25/09/2026) ;
#: Zenodo limite les invités à 60 requêtes/minute ; l'API GitHub anonyme
#: n'en accorde que 60 à l'heure — elle n'est appelée qu'avec un jeton.
INTERVALLES: dict[str, float] = {
    "www.ebi.ac.uk": 0.75,
    "api.crossref.org": 0.5,
    "api.datacite.org": 0.5,
    # Zenodo : 60/min ET 2 000/h pour un invité — c'est l'horaire qui mord.
    "zenodo.org": 1.8,
    "api.github.com": 0.8,
    "api.osf.io": 0.5,
    "api.figshare.com": 0.5,
    "huggingface.co": 0.5,
    "archive.softwareheritage.org": 1.0,
}
INTERVALLE_DEFAUT: float = 1.0

#: Les statuts qui valent une nouvelle tentative : trop de requêtes, et les
#: pannes passagères du serveur. Un 404 est une réponse, pas une panne.
REESSAYABLES: frozenset[int] = frozenset({429, 500, 502, 503, 504})
ESSAIS: int = 4
ATTENTE_MAX_S: float = 120.0

AGENT: str = "scrapper/0.1 (ramasseur de code natif, neurosciences)"


class Panne(RuntimeError):
    """Le réseau ou le serveur a lâché, pas la ressource : il faut réessayer plus
    tard, et surtout ne rien conclure (un article lu pendant une coupure n'est
    pas un article « sans texte »)."""


def passagere(statut: int) -> bool:
    """Une réponse de panne (réseau coupé, serveur saturé), pas une réponse sur la ressource."""
    return statut == 0 or statut in REESSAYABLES


def contact() -> str:
    """L'adresse que l'utilisateur a choisi de déclarer, ou rien."""
    return os.environ.get("SCRAPPER_CONTACT", "").strip()


@dataclass
class Reponse:
    url: str
    statut: int
    texte: str
    depuis_cache: bool = False
    entetes: dict[str, str] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return 200 <= self.statut < 300

    def json(self) -> Any:
        return json.loads(self.texte) if self.texte else None


class Cache:
    """Un fichier par URL, nommé par l'empreinte de l'URL."""

    def __init__(self, dossier: Path) -> None:
        self.dossier = Path(dossier)

    def _chemin(self, cle: str) -> Path:
        h = hashlib.sha256(cle.encode()).hexdigest()
        return self.dossier / h[:2] / h

    def lire(self, cle: str, ttl_s: float | None) -> Reponse | None:
        p = self._chemin(cle)
        meta = p.with_suffix(".meta")
        if not p.exists() or not meta.exists():
            return None
        m = json.loads(meta.read_text())
        if ttl_s is not None and time.time() - m["t"] > ttl_s:
            return None
        return Reponse(url=m["url"], statut=m["statut"], texte=p.read_text(),
                       depuis_cache=True)

    def ecrire(self, cle: str, r: Reponse) -> None:
        p = self._chemin(cle)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Écrire à côté puis renommer : une coupure au milieu ne laisse
        # jamais un fichier tronqué que la prochaine lecture croirait complet.
        tmp = p.with_suffix(".tmp")
        tmp.write_text(r.texte)
        tmp.replace(p)
        p.with_suffix(".meta").write_text(json.dumps(
            {"url": r.url, "statut": r.statut, "t": time.time()}))


class Client:
    """Le client HTTP du ramasseur. Synchrone, poli, avec cache."""

    def __init__(self, cache: Cache | None = None, *, delai_s: float = 30.0,
                 hors_ligne: bool = False) -> None:
        self.cache = cache
        self.hors_ligne = hors_ligne
        ua = AGENT + (f" mailto:{contact()}" if contact() else "")
        self._http = httpx.Client(timeout=delai_s, follow_redirects=True,
                                  headers={"User-Agent": ua})
        self._dernier: dict[str, float] = {}
        self._verrou = threading.Lock()
        #: Requêtes réellement envoyées, par hôte — le coût réseau d'un passage.
        self.compteur: dict[str, int] = {}

    def fermer(self) -> None:
        self._http.close()

    def _attendre(self, hote: str, url: str = "") -> None:
        with self._verrou:
            ecart = INTERVALLES.get(hote, INTERVALLE_DEFAUT)
            if hote == "api.github.com" and "/search/" in url:
                # La recherche GitHub a son propre quota : 10/min sans jeton, 30 avec.
                ecart = 2.1 if os.environ.get("GITHUB_TOKEN") else 6.5
                hote = "api.github.com/search"
            reste = self._dernier.get(hote, 0.0) + ecart - time.monotonic()
            if reste > 0:
                time.sleep(reste)
            self._dernier[hote] = time.monotonic()

    def _entetes(self, hote: str) -> dict[str, str]:
        jeton = os.environ.get("GITHUB_TOKEN", "").strip()
        if hote == "api.github.com" and jeton:
            return {"Authorization": f"Bearer {jeton}",
                    "Accept": "application/vnd.github+json"}
        return {}

    def get(self, url: str, *, params: dict[str, Any] | None = None,
            ttl_s: float | None = None, entetes: dict[str, str] | None = None,
            methode: str = "GET", patience: bool = True) -> Reponse:
        """GET (ou HEAD) poli. `ttl_s=None` : pas de cache ; `float('inf')` :
        garder pour toujours (un plein texte). `patience=False` : un quota
        épuisé (429, ou 403 à quota nul) rend la réponse au lieu d'attendre —
        pour un service dont on peut se passer ce passage-ci."""
        cle = str(httpx.URL(url, params=params)) if params else url
        if self.cache is not None and ttl_s is not None and methode == "GET":
            vu = self.cache.lire(cle, None if ttl_s == float("inf") else ttl_s)
            if vu is not None:
                return vu
        if self.hors_ligne:
            return Reponse(url=cle, statut=0, texte="")
        hote = urlsplit(url).hostname or ""
        h = dict(self._entetes(hote))
        h.update(entetes or {})
        derniere: Exception | None = None
        for essai in range(ESSAIS):
            self._attendre(hote, url)
            self.compteur[hote] = self.compteur.get(hote, 0) + 1
            try:
                r = self._http.request(methode, url, params=params, headers=h)
            except httpx.TransportError as e:
                derniere = e
                time.sleep(min(ATTENTE_MAX_S, 2.0 ** essai))
                continue
            # GitHub dit « quota épuisé » par un 403, pas un 429 : sans ce cas,
            # la recherche rendait zéro dépôt en silence.
            quota = r.status_code == 403 and r.headers.get("x-ratelimit-remaining") == "0"
            if not patience and (r.status_code == 429 or quota):
                return Reponse(url=str(r.url), statut=r.status_code, texte="",
                               entetes={k.lower(): v for k, v in r.headers.items()})
            if (r.status_code in REESSAYABLES or quota) and essai < ESSAIS - 1:
                time.sleep(_attente(r, essai))
                continue
            rep = Reponse(url=str(r.url), statut=r.status_code,
                          texte=r.text if methode == "GET" else "",
                          entetes={k.lower(): v for k, v in r.headers.items()})
            # On ne garde que ce qui a une chance de rester vrai : une réponse
            # 2xx, ou un 404 (le dépôt n'existe pas). Une panne ne se cache pas.
            if (self.cache is not None and ttl_s is not None and methode == "GET"
                    and (rep.ok or rep.statut in (404, 410))):
                self.cache.ecrire(cle, rep)
            return rep
        return Reponse(url=cle, statut=0, texte=f"panne réseau : {derniere!r}")


    def _flux(self, url: str, max_octets: int, sortie: IO[bytes]) -> bool:
        """Lire `url` en flux dans `sortie`, abandonné au-delà de `max_octets` :
        une archive de données de 4 Go ne doit pas être lue pour y chercher
        trois scripts. Vrai si le fichier est arrivé en entier."""
        if self.hors_ligne:
            return False
        hote = urlsplit(url).hostname or ""
        for essai in range(ESSAIS):
            self._attendre(hote, url)
            self.compteur[hote] = self.compteur.get(hote, 0) + 1
            sortie.seek(0)
            sortie.truncate()
            try:
                with self._http.stream("GET", url, headers=self._entetes(hote)) as r:
                    if r.status_code in REESSAYABLES and essai < ESSAIS - 1:
                        time.sleep(_attente(r, essai))
                        continue
                    if r.status_code != 200:
                        return False
                    annonce = r.headers.get("content-length")
                    if annonce and annonce.isdigit() and int(annonce) > max_octets:
                        return False
                    lu = 0
                    for m in r.iter_bytes():
                        lu += len(m)
                        if lu > max_octets:
                            return False
                        sortie.write(m)
                    return True
            except httpx.TransportError:
                time.sleep(min(ATTENTE_MAX_S, 2.0 ** essai))
        return False

    def telecharger(self, url: str, max_octets: int) -> bytes | None:
        """Un petit fichier binaire (un script distant), en mémoire."""
        tampon = io.BytesIO()
        return tampon.getvalue() if self._flux(url, max_octets, tampon) else None

    def telecharger_archive(self, url: str, max_octets: int) -> IO[bytes] | None:
        """Une archive de code, par le DISQUE au-delà de 1 Mo : un zip de 60 Mo
        passait deux fois par la mémoire (les morceaux, puis leur jointure) —
        c'était le pic de 280 Mo du passage. À fermer par l'appelant (`with`)."""
        f = tempfile.SpooledTemporaryFile(max_size=1_000_000)
        if not self._flux(url, max_octets, f):
            f.close()
            return None
        f.seek(0)
        return f


def _attente(r: httpx.Response, essai: int) -> float:
    """Ce que le serveur demande (Retry-After, ou la remise à zéro de GitHub),
    sinon un recul exponentiel."""
    ra = r.headers.get("retry-after")
    if ra and ra.isdigit():
        return min(ATTENTE_MAX_S, float(ra))
    reset = r.headers.get("x-ratelimit-reset")
    if r.headers.get("x-ratelimit-remaining") == "0" and reset and reset.isdigit():
        return min(ATTENTE_MAX_S, max(1.0, float(reset) - time.time()))
    return min(ATTENTE_MAX_S, 2.0 ** (essai + 1))
