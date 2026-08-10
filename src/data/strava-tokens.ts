import 'server-only';

import { asc, eq, sql } from 'drizzle-orm';

import { refreshTokens, type StravaTokenSet } from '@/lib/strava/oauth';

import { db } from './db/client';
import { athlete, stravaTokens } from './db/schema';

/**
 * Jetons OAuth Strava — zone la plus sensible du DAL.
 *
 * ⚠️ Aucun DTO n'est exposé ici : `getFreshAccessToken()` est la SEULE sortie, et
 * elle ne sert que du code serveur (client API Strava, service de sync). Les
 * jetons ne sont jamais retournés à un composant, une Server Action ou un log.
 */

/** En deçà de cette marge, le jeton est considéré comme expiré et rafraîchi. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Clé du verrou advisory Postgres qui sérialise le rafraîchissement des jetons.
 *
 * Valeur arbitraire mais **stable et dédiée à cet usage** : deux processus (une
 * requête et un webhook, par exemple) qui prennent la même clé s'excluent
 * mutuellement. Ne jamais la réutiliser pour un autre verrou de l'application.
 */
const STRAVA_REFRESH_LOCK_KEY = 728_314_501;

/**
 * `db` ou une transaction : les deux exposent les méthodes utilisées ici, ce qui
 * permet d'écrire les jetons indifféremment hors ou dans la section critique.
 */
type Executor = Pick<typeof db, 'select' | 'insert' | 'update'>;

/** Application mono-utilisateur : la première (et unique) ligne de `athlete`. */
async function requireAthleteId(executor: Executor): Promise<number> {
  const rows = await executor
    .select({ id: athlete.id })
    .from(athlete)
    .orderBy(asc(athlete.id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      "Aucun athlète enregistré : impossible d'associer des jetons Strava (onboarding requis).",
    );
  }
  return row.id;
}

/**
 * Écrit le jeu de jetons de l'athlète unique.
 *
 * La table n'a pas de contrainte d'unicité sur `athlete_id` (une seule ligne en
 * pratique) : l'upsert est fait en lecture puis écriture plutôt qu'en
 * `ON CONFLICT`, ce qui éviterait une migration de schéma pour rien.
 *
 * `scope` et `athleteStravaId` ne sont écrits que lorsqu'ils sont connus : les
 * réponses de refresh ne les renvoient pas, et les mettre à `null` effacerait
 * les informations obtenues à la connexion (dont dépend le filtrage des
 * événements webhook).
 */
async function writeTokens(executor: Executor, tokens: StravaTokenSet): Promise<void> {
  const athleteId = await requireAthleteId(executor);

  const existing = await executor
    .select({ id: stravaTokens.id })
    .from(stravaTokens)
    .where(eq(stravaTokens.athleteId, athleteId))
    .limit(1);

  const values = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.scope === null ? {} : { scope: tokens.scope }),
    updatedAt: new Date(),
  };

  const row = existing[0];
  if (row) {
    await executor.update(stravaTokens).set(values).where(eq(stravaTokens.id, row.id));
  } else {
    await executor.insert(stravaTokens).values({ athleteId, ...values });
  }

  if (tokens.athleteStravaId !== null) {
    await executor
      .update(athlete)
      .set({ stravaAthleteId: tokens.athleteStravaId, updatedAt: new Date() })
      .where(eq(athlete.id, athleteId));
  }
}

/**
 * Enregistre le jeu de jetons de l'athlète unique, ainsi que l'identifiant
 * Strava et le périmètre accordé qui l'accompagnent.
 *
 * Les deux tables sont écrites dans une même transaction : des jetons sans
 * `athlete.strava_athlete_id` feraient rejeter tous les événements webhook.
 */
export async function saveStravaTokens(tokens: StravaTokenSet): Promise<void> {
  await db.transaction((tx) => writeTokens(tx, tokens));
}

/** Ligne de jetons de l'athlète unique, ou `null` si Strava n'est pas connecté. */
async function readTokens(executor: Executor): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
} | null> {
  const rows = await executor
    .select({
      accessToken: stravaTokens.accessToken,
      refreshToken: stravaTokens.refreshToken,
      expiresAt: stravaTokens.expiresAt,
    })
    .from(stravaTokens)
    .orderBy(asc(stravaTokens.id))
    .limit(1);

  return rows[0] ?? null;
}

/** `true` si le jeton expire dans moins que la marge de sécurité. */
function needsRefresh(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
}

/**
 * Jeton d'accès utilisable immédiatement, rafraîchi de façon transparente s'il
 * expire dans moins de 5 minutes. `null` quand aucun jeton n'est en base
 * (Strava jamais connecté ou connexion révoquée côté base).
 *
 * Strava fait tourner le refresh token à chaque rafraîchissement : deux
 * rafraîchissements concurrents partiraient du même refresh token et celui qui
 * perd la course écrirait un jeton déjà invalidé — Strava resterait déconnecté
 * jusqu'à une réautorisation manuelle. La section critique est donc sérialisée
 * par un verrou advisory Postgres, et le détenteur du verrou relit les jetons
 * dans la transaction : si un concurrent a déjà rafraîchi, on sert son jeton au
 * lieu d'en demander un second.
 *
 * ⚠️ Réservé au code serveur : la valeur retournée est un secret.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const tokens = await readTokens(db);
  if (!tokens) return null;
  if (!needsRefresh(tokens.expiresAt)) return tokens.accessToken;

  return db.transaction(async (tx) => {
    // Verrou de transaction (`xact`) : relâché au commit comme au rollback,
    // aucun risque de le laisser pris si le refresh échoue.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${STRAVA_REFRESH_LOCK_KEY})`);

    const current = await readTokens(tx);
    if (!current) return null;
    // Un concurrent a rafraîchi pendant l'attente du verrou : son jeton fait foi.
    if (!needsRefresh(current.expiresAt)) return current.accessToken;

    const refreshed = await refreshTokens(current.refreshToken);
    await writeTokens(tx, refreshed);
    return refreshed.accessToken;
  });
}

/** Indique si un jeu de jetons existe — sans jamais exposer sa valeur. */
export async function isStravaConnected(): Promise<boolean> {
  return (await readTokens(db)) !== null;
}
