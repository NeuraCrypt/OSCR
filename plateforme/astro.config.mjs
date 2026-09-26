// Un site STATIQUE : chaque page est construite d'avance, et Cloudflare Pages
// sert les fichiers statiques gratuitement, sans limite de trafic. Les actions
// (connexion ORCID des auteurs, validation d'une carte, recherche) viendront
// en Pages Functions dans functions/ ; elles seules consomment des requêtes.
import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://code-natif.pages.dev",
  output: "static",
  trailingSlash: "always",
  // science.css en UN fichier externe, partagé par toutes les pages et mis en
  // cache, plutôt que recopié dans chacune.
  build: { inlineStylesheets: "never" },
});
