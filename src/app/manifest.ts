import type { MetadataRoute } from "next";

/**
 * Manifeste PWA — Trainarr est installable sur l'écran d'accueil (cible : iPhone).
 *
 * `background_color` et `theme_color` valent tous deux le token `bg` : la première
 * peint l'écran de démarrage affiché avant le premier rendu, la seconde le chrome
 * du système. Toute autre valeur (le blanc par défaut en particulier) produirait
 * un flash lumineux à chaque ouverture, à l'opposé d'une appli dark-first.
 *
 * Route handler purement statique : aucune lecture d'env, aucun accès au DAL,
 * pas de `connection()` — sous `cacheComponents`, elle doit ressortir en `○` au build.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Trainarr",
    short_name: "Trainarr",
    description:
      "Plans d'entraînement, analytics de course à pied et coach IA — le tout auto-hébergé.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0B0D16",
    theme_color: "#0B0D16",
    lang: "fr",
    dir: "ltr",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // Cadrage resserré (55 % de la largeur) : les lanceurs Android rognent
      // l'icône à une forme arbitraire, seul le cercle central de 80 % survit.
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
