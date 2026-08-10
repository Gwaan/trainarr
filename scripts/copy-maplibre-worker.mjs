/**
 * Publie le worker MapLibre dans `public/` avant chaque `dev` / `build`.
 *
 * Pourquoi ce détour : MapLibre déduit l'URL de son worker de `import.meta.url`
 * et renonce si ce n'est pas une URL `http(s)` — or Turbopack y écrit un
 * `file:///ROOT/...`. Il faut donc lui donner l'URL nous-mêmes
 * (`setWorkerUrl`, cf. `activity-map.tsx`), et cette URL doit pointer sur un
 * fichier réellement servi.
 *
 * Turbopack ne peut pas la fournir : référencé via `new URL(..., import.meta.url)`
 * le worker est recopié tel quel, sous un nom haché, sans que ses propres
 * imports soient suivis — son `import "./maplibre-gl-shared.mjs"` part alors en
 * 404. Seul le couple `new Worker(new URL(...))` déclenche un vrai bundling, et
 * MapLibre construit son `Worker` lui-même : hors de portée.
 *
 * On recopie donc les deux fichiers du paquet côte à côte, sous leurs noms
 * d'origine, pour que l'import relatif du worker retombe sur son voisin.
 *
 * La copie est refaite à chaque `dev`/`build` : impossible qu'elle se désynchronise
 * de la version installée de `maplibre-gl`.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Le worker et le chunk partagé qu'il importe — les deux, ou rien. */
const FICHIERS = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

const dist = join(
  dirname(createRequire(import.meta.url).resolve("maplibre-gl/package.json")),
  "dist",
);
const destination = new URL("../public/maplibre/", import.meta.url);

await mkdir(destination, { recursive: true });

for (const fichier of FICHIERS) {
  // Pas de garde-fou : une erreur ici doit casser le build. Un renommage de
  // chunk chez MapLibre se verrait autrement à l'exécution, sous la forme d'une
  // trace GPS silencieusement absente.
  await copyFile(join(dist, fichier), new URL(fichier, destination));
}
