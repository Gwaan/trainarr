import 'server-only';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import { env } from '@/config/env';
import * as schema from './schema';

/**
 * Client Postgres + Drizzle.
 *
 * Réservé au Data Access Layer : aucun composant, aucune Server Action n'importe
 * ce module directement.
 *
 * En dev, Turbopack recharge les modules à chaud : sans singleton sur `globalThis`,
 * chaque rechargement ouvrirait un nouveau pool de connexions.
 */

declare global {
  var __trainarrSql: Sql | undefined;
}

type Database = ReturnType<typeof drizzle<typeof schema>>;

let cached: Database | undefined;

/**
 * Ouvre (ou réutilise) la connexion. Volontairement appelé à la première requête
 * et non à l'évaluation du module : `next build` importe les modules applicatifs
 * sans variables d'environnement, donc lire `DATABASE_URL` ici ferait échouer le
 * build dès qu'une page consomme le DAL.
 */
function getDb(): Database {
  if (!cached) {
    const sql = globalThis.__trainarrSql ?? postgres(env.DATABASE_URL);
    if (process.env.NODE_ENV !== 'production') {
      globalThis.__trainarrSql = sql;
    }
    cached = drizzle(sql, { schema });
  }
  return cached;
}

/** Accès paresseux : `db.select(...)` n'ouvre la connexion qu'au premier appel. */
export const db: Database = new Proxy({} as Database, {
  get: (_target, prop) => Reflect.get(getDb(), prop) as unknown,
  has: (_target, prop) => prop in getDb(),
});
