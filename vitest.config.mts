import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Aligné sur `paths` de tsconfig.json.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    /**
     * `scripts/` en plus de `src/` : les scripts autonomes (rattrapages) portent
     * des invariants qui ne se vérifient qu'en les faisant tourner — « le
     * compteur d'activités en attente finit par atteindre zéro » ne se lit dans
     * aucun module du DAL.
     */
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    /**
     * `src/config/env.ts` valide l'environnement au chargement du module : sans
     * DATABASE_URL, tout import d'un module serveur échouerait. Valeur factice —
     * aucun test n'ouvre de connexion (le client DB est mocké, et postgres.js
     * ne se connecte qu'à la première requête).
     */
    env: {
      DATABASE_URL: 'postgres://trainarr:test@localhost:5432/trainarr_test',
    },
  },
});
