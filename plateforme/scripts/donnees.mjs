// Le catalogue de sortie du ramasseur → les données du site.
//
// La source est le dossier que produit `scrapper nuit` (donnees/publication),
// TOUJOURS en mode public : seuls y figurent le texte des scripts sous licence
// libre, et aucune phrase d'article. Un catalogue non public est refusé.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const source = process.env.CATALOGUE ?? "../donnees/publication";
const fichier = `${source}/donnees.json`;
if (!existsSync(fichier)) {
  console.error(`Pas de catalogue dans ${source} : lancer \`scrapper nuit --jeu ''\` dans le dossier du ramasseur.`);
  process.exit(1);
}
const catalogue = JSON.parse(readFileSync(fichier, "utf8"));
if (!catalogue.public) {
  console.error(`${source} n'a pas été généré en mode public : il ne part pas sur le site.`);
  process.exit(1);
}
mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/catalogue.json", JSON.stringify(catalogue));
// Les lots de scripts, lus à la demande par le lecteur (un fichier par lot).
rmSync("public/scripts", { recursive: true, force: true });
cpSync(`${source}/scripts`, "public/scripts", { recursive: true });
const avecCode = catalogue.articles.filter((a) => a.code.length > 0).length;
console.log(`catalogue du ${catalogue.genere_le} : ${catalogue.articles.length} articles, ${avecCode} avec code, ${catalogue.depots.length} dépôts`);
