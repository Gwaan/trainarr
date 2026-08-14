import 'server-only';

import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { db } from './client';
import { authAccounts, authSessions, authUsers, authVerifications } from './schema';

/**
 * Le pont entre better-auth et notre base.
 *
 * Il vit dans le DAL et non dans `src/lib/auth/` par respect d'une règle du
 * projet : le client Drizzle n'est importé que depuis `src/data/`
 * (cf. `.claude/rules/security.md`). `src/lib/auth/` assemble l'instance
 * d'authentification, mais ne connaît ni la connexion ni les tables.
 *
 * La correspondance ci-dessous est la seule chose qui relie les **noms de
 * modèles** de better-auth (`user`, `session`, `account`, `verification` — ses
 * noms canoniques, ceux auxquels ses propres références de clés étrangères
 * renvoient) à nos tables préfixées `auth_`. L'adaptateur ne lit rien d'autre :
 * il prend l'objet Drizzle correspondant et l'interroge par nom de champ.
 */
const AUTH_SCHEMA = {
  user: authUsers,
  session: authSessions,
  account: authAccounts,
  verification: authVerifications,
} as const;

/**
 * Construit l'adaptateur. Aucune connexion n'est ouverte ici : `db` est un proxy
 * paresseux qui ne se connecte qu'à la première requête (cf. `client.ts`), ce
 * qui laisse `next build` importer ce module sans base.
 */
export function authDatabaseAdapter(): ReturnType<typeof drizzleAdapter> {
  return drizzleAdapter(db, {
    provider: 'pg',
    schema: AUTH_SCHEMA,
    /**
     * Écritures groupées en transaction. Ce n'est pas le défaut de better-auth,
     * et ça compte ici : une inscription écrit le compte **puis** son moyen
     * d'accès (le hachage du mot de passe). Sans transaction, une panne entre
     * les deux laisserait un compte sans mot de passe — et comme il existerait,
     * il refermerait la porte d'amorçage : plus aucune connexion possible, plus
     * aucune inscription non plus. Tout ou rien.
     */
    transaction: true,
    /**
     * Les clés de `AUTH_SCHEMA` sont déjà les noms de modèles de better-auth :
     * rien à dépluraliser. C'est le nom de table SQL qui porte le préfixe, et
     * il est déclaré dans le schéma Drizzle, hors de portée de l'adaptateur.
     */
    usePlural: false,
  });
}
