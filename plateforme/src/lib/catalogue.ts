// Le catalogue de sortie du ramasseur, lu une fois à la construction du site.
// Voir scripts/donnees.mjs : il vient de donnees/publication, en mode public.
import { readFileSync } from "node:fs";
import brut from "../data/catalogue.json";

export type Depot = {
  norme: string;
  url: string;
  hote: string;
  niveau: "trouve" | "vivant" | "inventorie" | "importe";
  lot: number;
  lus: number;
  etat: string;
  licence: string;
  redistribuable: string;
  scripts: number | null;
  langages: Record<string, number>;
  type: string;
  swh: number | null;
  inventorie: boolean;
  commit: string;
  ou: string;
};

export type Carte = {
  validee_par: { nom: string; orcid: string }[];
  doi?: string;
  doi_concept?: string;
};

export type Article = {
  id: string;
  doi: string;
  titre: string;
  revue: string;
  date: string;
  statut: string;
  familles: string[];
  donnees: number;
  code: Depot[];
  carte: Carte | null;
};

/** Un fichier d'un lot de scripts (tableau.lots_de_scripts). `t` est null quand
 *  la licence du dépôt ne permet pas de republier son texte. */
export type Fichier = { c: string; l: string; g: string; n: number | null; t: string | null; note?: string; src?: string };
export type EntreeLot = { depot: string; version: string; licence: string; publie: boolean; fichiers: Fichier[] };

type Catalogue = {
  genere_le: string;
  chiffres: Record<string, number>;
  articles: Article[];
};

export const catalogue = brut as unknown as Catalogue;

/** Les articles dont le code des auteurs a été trouvé : ce sont eux que le site montre. */
export const avecCode = catalogue.articles.filter((a) => a.code.length > 0);

/** Le même nom de dossier que la bibliothèque du ramasseur (importer.slug). */
export const slug = (id: string) =>
  id.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);

/** Le statut, en toutes lettres ; `classe` vaut `ok`, `alerte` ou rien (science.css). */
export const STATUTS: Record<string, { libelle: string; classe: "ok" | "alerte" | "" }> = {
  code_verifie: { libelle: "code vérifié", classe: "ok" },
  code_trouve: { libelle: "code trouvé, pas encore vérifié", classe: "alerte" },
  code_vide: { libelle: "dépôt vide", classe: "alerte" },
  code_mort: { libelle: "lien mort", classe: "alerte" },
  sur_demande: { libelle: "code sur demande", classe: "" },
  donnees_seules: { libelle: "données seules", classe: "" },
  aucun: { libelle: "aucun code", classe: "" },
  sans_texte: { libelle: "texte de l'article indisponible", classe: "" },
};
export const statut = (s: string) => STATUTS[s] ?? { libelle: s, classe: "" as const };

export const ETATS: Record<string, string> = {
  vivant: "le lien répond",
  mort: "le lien est mort",
  a_verifier: "pas encore vérifié",
  inaccessible: "injoignable au dernier essai",
  non_verifiable: "non vérifiable",
};

export const NIVEAUX: Record<string, string> = {
  trouve: "trouvé dans l'article",
  vivant: "le lien répond",
  inventorie: "fichiers inventoriés",
  importe: "copie gardée",
};

/** Un dépôt ramené à ce qu'on lit d'un coup d'œil : « owner/repo » ou « Zenodo 123 ». */
export function nomCourt(norme: string): string {
  const m = norme.match(/^(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/(.+)$/);
  if (m) return m[1];
  const z = norme.match(/^zenodo:(\d+)$/);
  if (z) return `Zenodo ${z[1]}`;
  return norme.replace(/^doi:/, "doi ");
}

export function nombre(n: number | undefined): string {
  return (n ?? 0).toLocaleString("fr-FR");
}

export const pluriel = (n: number, mot: string, pl = `${mot}s`) => `${nombre(n)} ${n > 1 ? pl : mot}`;

/** Les articles groupés par jour de parution, du plus récent au plus ancien. */
export function parJour(articles: Article[]): { jour: string; libelle: string; articles: Article[] }[] {
  const groupes = new Map<string, Article[]>();
  for (const a of articles) {
    const jour = a.date || "";
    if (!groupes.has(jour)) groupes.set(jour, []);
    groupes.get(jour)!.push(a);
  }
  return [...groupes.entries()]
    .sort(([x], [y]) => (x < y ? 1 : x > y ? -1 : 0))
    .map(([jour, liste]) => ({ jour, libelle: jourEnLettres(jour), articles: liste }));
}

export function jourEnLettres(jour: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) return "Date inconnue";
  const texte = new Date(`${jour}T00:00:00Z`).toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

/** Les fichiers d'un dépôt, lus dans son lot (public/scripts/NN.json) à la construction. */
const lots = new Map<number, Record<string, EntreeLot>>();
export function entreeLot(d: Depot): EntreeLot | undefined {
  if (!d.lus) return undefined;
  if (!lots.has(d.lot)) {
    lots.set(d.lot, JSON.parse(readFileSync(`public/scripts/${String(d.lot).padStart(2, "0")}.json`, "utf8")));
  }
  return lots.get(d.lot)![d.norme];
}
