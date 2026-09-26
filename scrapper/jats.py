"""Le plein texte JATS : chaque lien de l'article, avec la phrase et la section qui le portent.

**Pourquoi le XML et pas la recherche.** Mesuré le 25/09/2026 : la requête
Europe PMC `github OR zenodo OR osf.io OR gitlab` rend 13,5 % des articles
EEG/MEG, le plein texte en porte 33,3 %. L'index sous-déclare d'un facteur 2,4.
On ne présélectionne donc pas les articles « à code » : on lit le XML de chacun
(1,2 s et 145 Ko par article).

**Pourquoi le CONTEXTE compte plus que l'URL.** Sur `eeg-neurostream`, deux
liens GitHub : l'un est le code des auteurs, l'autre le jeu de données d'un
autre laboratoire. Rien dans l'URL ne les distingue ; la phrase et la section,
si. Chaque occurrence garde donc :

- la PHRASE qui porte le lien, découpée sans couper les URL ;
- le chemin des TITRES de sections, du plus large au plus proche ;
- le LIEU : corps, section de disponibilité, références, tableau, notes,
  matériel supplémentaire, remerciements ;
- pour une référence, les NOMS des auteurs cités — un logiciel cité dont les
  auteurs sont ceux de l'article est leur propre code.

Les éditeurs rangent la déclaration de disponibilité à six endroits différents :
une `<sec>` titrée (Frontiers, Elsevier, eLife), un `sec-type` ou un
`notes-type` (Springer Nature), un `custom-meta` « Data Availability » (PLOS),
des `<notes>` (MDPI), une ligne du tableau des ressources (Cell Press STAR).
Tous sont lus.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from . import liens

XLINK = "{http://www.w3.org/1999/xlink}href"

#: Un titre de section de DISPONIBILITÉ (ce qui est partagé et où).
DISPO = re.compile(
    r"availab|accessib|\bsharing\b|\bdeposit|open (science|research|practices)"
    r"|reproducib|resource availability|data and (code|software|materials)"
    r"|code and data|supporting information|supplementary (material|information)",
    re.I)

#: Un titre de section qui parle de CODE.
TITRE_CODE = re.compile(r"\bcodes?\b|\bsoftware\b|\bscripts?\b|\bimplementation\b"
                        r"|\bsource code\b|\bnotebooks?\b", re.I)

#: Une section de Méthodes : c'est là qu'on lit les méthodes employées.
TITRE_METHODES = re.compile(
    r"method|material|procedure|experimental (design|setup)|protocol|analys"
    r"|participants|recording|acquisition|preprocessing|statistic", re.I)

#: Les types d'`ext-link` qui sont des adresses (les autres sont des accessions).
_TYPES_LIEN = frozenset({"uri", "url", "ftp", "doi", "http", "https", "software", "data"})

#: Les abréviations qui ne terminent pas une phrase.
_ABREV = re.compile(r"(?:\be\.g|\bi\.e|\bet al|\bFigs?|\bEqs?|\bvs|\bcf|\bapprox"
                    r"|\bNo|\bRefs?|\bSuppl|\bSec|\bDr|\bProf|\bca|\bresp)\.$", re.I)


@dataclass
class Occurrence:
    """Un lien tel que l'article l'écrit, dans son contexte."""

    url: str
    phrase: str
    sections: tuple[str, ...]
    lieu: str
    type_section: str = ""
    texte_lien: str = ""
    ref_auteurs: tuple[str, ...] = ()
    ref_annee: str = ""

    @property
    def titre_proche(self) -> str:
        return self.sections[-1] if self.sections else ""


@dataclass
class Declaration:
    """Une déclaration de disponibilité (texte complet), avec son titre."""

    titre: str
    texte: str


@dataclass
class TexteArticle:
    titre: str = ""
    doi: str = ""
    pmcid: str = ""
    annee: str = ""
    auteurs: list[str] = field(default_factory=list)       # noms de famille
    occurrences: list[Occurrence] = field(default_factory=list)
    declarations: list[Declaration] = field(default_factory=list)
    methodes: str = ""                                      # texte des Méthodes
    supplementaires: list[tuple[str, str]] = field(default_factory=list)  # (fichier, légende)


def _texte(e: ET.Element | None) -> str:
    if e is None:
        return ""
    return re.sub(r"\s+", " ", "".join(_morceaux(e))).strip()


#: Les éléments qui se COLLENT au mot précédent si on les lit bout à bout :
#: l'appel de référence en exposant faisait lire « zenodo.15795242 » + « 93 »
#: comme `zenodo.1579524293` (PMC12381021).
_DETACHES = frozenset({"xref", "sup", "sub"})


def _morceaux(e: ET.Element):
    if e.text:
        yield e.text
    for enfant in e:
        detache = _nom(enfant.tag) in _DETACHES
        if detache:
            yield " "
        yield from _morceaux(enfant)
        if detache:
            yield " "
        if enfant.tail:
            yield enfant.tail


def _nom(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def lire(xml: str) -> TexteArticle:
    """Analyser un article JATS. Ne lève jamais : un XML abîmé rend un article vide."""
    racine = _analyser(xml)
    art = TexteArticle()
    if racine is None:
        return art
    meta = racine.find(".//front/article-meta")
    if meta is not None:
        art.titre = _texte(meta.find("title-group/article-title"))
        for aid in meta.findall("article-id"):
            t = aid.get("pub-id-type", "")
            if t == "doi":
                art.doi = _texte(aid).lower()
            elif t in ("pmcid", "pmc"):
                v = _texte(aid)
                art.pmcid = v if v.upper().startswith("PMC") else f"PMC{v}"
        for c in meta.findall(".//contrib-group/contrib"):
            if c.get("contrib-type", "author") != "author":
                continue
            s = _texte(c.find(".//surname"))
            if s:
                art.auteurs.append(s)
        date = meta.find("pub-date/year")
        art.annee = _texte(date)
        for cm in meta.findall(".//custom-meta"):
            nom = _texte(cm.find("meta-name"))
            if re.search(r"availab", nom, re.I):
                valeur = cm.find("meta-value")
                art.declarations.append(Declaration(nom, _texte(valeur)))
                # PLOS écrit la déclaration en texte nu dans `meta-value`, sans
                # paragraphe : la lire comme un paragraphe (PMC12037073).
                if valeur is not None:
                    _paragraphe(valeur, art, (nom,), "disponibilite", "custom-meta")
    corps = racine.find(".//body")
    fond = racine.find(".//back")
    meth: list[str] = []
    if corps is not None:
        _parcourir(corps, art, (), "corps", "", meth)
    if fond is not None:
        _parcourir(fond, art, (), "fond", "")
    art.methodes = " ".join(meth) if meth else _texte(corps)
    return art


def _analyser(xml: str) -> ET.Element | None:
    try:
        return ET.fromstring(xml)
    except ET.ParseError:
        pass
    # Une entité nommée inconnue (&nbsp;) ou un DOCTYPE gênant : on les efface.
    propre = re.sub(r"<!DOCTYPE[^>]*>", "", xml)
    propre = re.sub(r"&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)\w+;", " ", propre)
    try:
        return ET.fromstring(propre)
    except ET.ParseError:
        return None


def _parcourir(e: ET.Element | None, art: TexteArticle, sections: tuple[str, ...],
               lieu: str, type_sec: str, meth: list[str] | None = None) -> None:
    if e is None:
        return
    for enfant in list(e):
        nom = _nom(enfant.tag)
        if nom in ("sec", "notes", "app", "boxed-text", "glossary"):
            titre = _texte(enfant.find("title"))
            t_sec = enfant.get("sec-type", "") or enfant.get("notes-type", "")
            nouveau_lieu = lieu
            if DISPO.search(titre) or re.search(r"availab", t_sec, re.I):
                nouveau_lieu = "disponibilite"
                art.declarations.append(Declaration(titre or t_sec, _texte(enfant)))
            elif nom == "notes" and lieu != "disponibilite":
                nouveau_lieu = "notes"
            elif nom == "app":
                nouveau_lieu = "annexe"
            elif re.search(r"acknowledg|funding", titre, re.I):
                nouveau_lieu = "remerciements"
            en_meth = meth
            if meth is not None and not sections and TITRE_METHODES.search(titre + " " + t_sec):
                meth.append(_texte(enfant))
            _parcourir(enfant, art, sections + ((titre,) if titre else ()),
                       nouveau_lieu, t_sec or type_sec, en_meth)
        elif nom == "ref-list":
            for ref in enfant.iter():
                if _nom(ref.tag) == "ref":
                    _reference(ref, art, sections + ("References",))
        elif nom == "table-wrap":
            titre = _texte(enfant.find(".//caption")) or _texte(enfant.find("label"))
            for tr in enfant.iter():
                if _nom(tr.tag) == "tr":
                    _paragraphe(tr, art, sections + (titre[:80],),
                                "disponibilite" if lieu == "disponibilite" else "tableau",
                                type_sec)
        elif nom == "supplementary-material":
            fichier = enfant.get(XLINK, "")
            legende = _texte(enfant.find("caption")) or _texte(enfant.find("label"))
            media = enfant.find(".//media")
            if not fichier and media is not None:
                fichier = media.get(XLINK, "")
            art.supplementaires.append((fichier, legende))
            _paragraphe(enfant, art, sections, "supplementaire", type_sec)
        elif nom == "ack":
            _parcourir(enfant, art, sections + ("Acknowledgments",), "remerciements", "")
        elif nom in ("p", "list-item", "fn", "def", "disp-quote", "attrib",
                     "caption", "statement"):
            _paragraphe(enfant, art, sections, lieu, type_sec)
        elif nom in ("title", "label"):
            continue
        else:
            _parcourir(enfant, art, sections, lieu, type_sec, meth)


def _reference(ref: ET.Element, art: TexteArticle, sections: tuple[str, ...]) -> None:
    # Une `element-citation` est une suite d'éléments sans espaces entre eux :
    # lue bout à bout, elle donnait « SchmidtF2022Data from: … Repository10.5061 »,
    # où aucun mot n'a plus de frontière. On sépare chaque élément.
    texte = re.sub(r"\s+", " ", " ".join(ref.itertext())).strip()
    auteurs = tuple(_texte(s) for s in ref.iter() if _nom(s.tag) == "surname")
    annee = next((_texte(y) for y in ref.iter() if _nom(y.tag) == "year"), "")
    vus: set[str] = set()
    for x in ref.iter():
        n = _nom(x.tag)
        url = ""
        if n in ("ext-link", "uri"):
            url = x.get(XLINK, "") or _texte(x)
        elif n == "pub-id" and x.get("pub-id-type") == "doi":
            url = _texte(x)
        if url and url not in vus:
            vus.add(url)
            art.occurrences.append(Occurrence(url, texte[:600], sections, "references",
                                              "", _texte(x), auteurs, annee))
    for url in liens.dans_le_texte(texte):
        if not any(url in v or v in url for v in vus):
            vus.add(url)
            art.occurrences.append(Occurrence(url, texte[:600], sections, "references",
                                              "", "", auteurs, annee))


def _paragraphe(p: ET.Element, art: TexteArticle, sections: tuple[str, ...],
                lieu: str, type_sec: str) -> None:
    texte = _texte(p)
    if not texte:
        return
    # eLife cite ses jeux « générés » par une `element-citation` DANS la
    # déclaration de disponibilité (« The following dataset was generated: »).
    # C'est une référence signée, pas une phrase : ses auteurs disent si le
    # dépôt est celui de l'article (PMC9754634, étalon Zenodo, 25/09/2026).
    citations = [x for x in p.iter() if _nom(x.tag) in ("element-citation", "mixed-citation")]
    dans_citation: set[int] = set()
    textes_citations: list[str] = []
    for c in citations:
        _reference(c, art, sections + ("Data citation",))
        dans_citation.update(id(x) for x in c.iter())
        textes_citations.append(_texte(c))
    if citations and len(texte) - sum(map(len, textes_citations)) < 40:
        return
    ancres: list[tuple[str, str]] = []
    for x in p.iter():
        if id(x) in dans_citation:
            continue
        if _nom(x.tag) in ("ext-link", "uri", "self-uri", "inline-supplementary-material"):
            # Un `ext-link` typé `gen`, `pdb`, `uniprot`… est un numéro
            # d'accession fouillé par l'éditeur (« R81071 » dans un numéro de
            # comité d'éthique, PMC12319822), pas une adresse écrite par l'auteur.
            if x.get("ext-link-type", "uri").lower() not in _TYPES_LIEN:
                continue
            href = x.get(XLINK, "")
            aff = _texte(x)
            if href or aff:
                ancres.append((href or aff, aff))
        elif _nom(x.tag) == "pub-id" and x.get("pub-id-type") == "doi":
            ancres.append((_texte(x), _texte(x)))
    vus = {h for h, _ in ancres}
    for url in liens.dans_le_texte(texte):
        if any(url in tc for tc in textes_citations):
            continue
        if not any(url in h or h in url for h in vus if h):
            ancres.append((url, url))
            vus.add(url)
    for url, aff in ancres:
        art.occurrences.append(Occurrence(url, phrase_autour(texte, aff or url),
                                          sections, lieu, type_sec, aff))


def phrase_autour(texte: str, ancre: str, marge: int = 400) -> str:
    """La phrase qui contient `ancre`, découpée sans couper les URL."""
    i = texte.find(ancre) if ancre else -1
    if i < 0:
        return texte[:marge]
    # On masque les URL : leurs points ne sont pas des fins de phrase. Mais la
    # ponctuation qui suit l'URL, si : « (…dryad.np5hqc00n). All code… »
    # (PMC12723408) — l'expression des URL l'avale, on la rend.
    def _masquer(m: re.Match[str]) -> str:
        u = m.group(0)
        coeur = u.rstrip(liens._FIN)
        return "x" * len(coeur) + u[len(coeur):]
    masque = liens.URL_TEXTE.sub(_masquer, texte)
    debut = 0
    for m in re.finditer(r"[.!?]\s+(?=[A-Z(\[])", masque[:i]):
        if not _ABREV.search(masque[max(0, m.start() - 8):m.start() + 1]):
            debut = m.end()
    fin = len(texte)
    for m in re.finditer(r"[.!?](\s+(?=[A-Z(\[])|$)", masque[i + len(ancre):]):
        j = i + len(ancre) + m.start()
        if not _ABREV.search(masque[max(0, j - 8):j + 1]):
            fin = j + 1
            break
    phrase = texte[debut:fin].strip()
    if len(phrase.replace(ancre, "").strip(" ().;,[]")) < 25 and debut > 0:
        # Le lien seul entre parenthèses après un point : « …are publicly
        # available. (lien). » (PMC12381375). La phrase qui le porte est la
        # précédente.
        avant = masque[:debut].rstrip()
        precedent = 0
        for m in re.finditer(r"[.!?]\s+(?=[A-Z(\[])", avant[:-1]):
            precedent = m.end()
        phrase = texte[precedent:fin].strip()
    if len(phrase) > 2 * marge:
        k = i - debut
        phrase = phrase[max(0, k - marge):k + len(ancre) + marge]
    return phrase
