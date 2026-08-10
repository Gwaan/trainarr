/**
 * Applique les migrations Drizzle versionnées dans `drizzle/`, puis rend la main.
 *
 * Point d'entrée exécutable (pas un module du DAL) :
 * - **pas de `import 'server-only'`** — il tourne en Node pur, hors React ;
 * - **pas d'import de `./client`** ni de `@/config/env`, tous deux `server-only` ;
 *   il ouvre donc sa propre connexion, à usage unique, et lit `DATABASE_URL`
 *   directement (il est dans le DAL, seule couche autorisée à lire l'env).
 *
 * `drizzle-kit` est une dépendance de dev, absente de l'image de production :
 * les migrations y sont appliquées par ce script via le migrator de `drizzle-orm`.
 *
 * Usage : `pnpm db:migrate:run` (dev) ou `pnpm exec tsx src/data/db/migrate.ts`.
 * Le chemin des migrations est relatif au répertoire de travail : lancer depuis
 * la racine du projet (ou `/app` dans l'image).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const MIGRATIONS_FOLDER = 'drizzle';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL est requise pour appliquer les migrations.');
  }

  // `max: 1` : une seule connexion, les migrations sont strictement séquentielles.
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    // Sans fermeture explicite, le pool garde le process en vie.
    await sql.end();
  }
}

main().then(
  () => {
    console.log('Migrations appliquées.');
    process.exit(0);
  },
  (error: unknown) => {
    console.error('Échec des migrations :', error);
    process.exit(1);
  },
);
