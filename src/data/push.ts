import 'server-only';

import { and, count, eq, inArray, lt } from 'drizzle-orm';

import { AthleteNotFoundError, getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import { athlete, pushNotices, pushSubscriptions, type PushNoticeKind } from './db/schema';

/**
 * Notifications push — abonnements des appareils, préférences de catégorie, et
 * réservation des envois.
 *
 * **Cloisonnement, comme partout dans le DAL**, et selon la même règle que
 * `./weather-forecast.ts` :
 *
 * - ce qu'appelle un **écran** résout l'athlète depuis la session
 *   ({@link saveSubscription}, {@link removeSubscription},
 *   {@link getPushPreferences}, {@link setPushPreferences},
 *   {@link countSubscriptions}) ;
 * - ce qu'appelle un **service de fond** reçoit l'athlète en paramètre
 *   ({@link listSubscriptions}, {@link getPushPreferencesFor},
 *   {@link claimNotice}, {@link releaseNotice}) : ces boucles tournent hors
 *   requête, il n'y a aucune session à interroger. {@link purgeStaleNotices}
 *   n'en prend même pas : c'est un entretien global, borné par la seule date.
 *
 * **L'endpoint vient du navigateur, elle ne désigne jamais rien toute seule.**
 * {@link removeSubscription} ne peut effacer qu'une ligne de l'athlète de la
 * session : un appel direct avec l'endpoint d'un autre compte ne trouve rien —
 * et ne dit pas non plus qu'elle existe ailleurs. {@link dropSubscription},
 * elle, prend un identifiant interne : elle n'est appelée que par l'envoi, sur
 * une ligne qu'il vient lui-même de lire sous son athlète.
 */

/**
 * L'endpoint proposée appartient déjà à **un autre athlète**.
 *
 * Nommée pour que la Server Action la distingue d'une panne : c'est un refus,
 * pas un incident, et il a un remède (cf. {@link saveSubscription}).
 */
export class PushEndpointOwnedError extends Error {
  constructor() {
    super('Cet appareil est déjà enregistré sous un autre compte.');
    this.name = 'PushEndpointOwnedError';
  }
}

/** Ce que le navigateur remet à l'abonnement — déjà validé par la Server Action. */
export type PushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
};

/**
 * Ce dont l'envoi a besoin, et rien de plus : ni la date de création, ni
 * l'agent utilisateur, ni l'athlète (l'appelant le tient déjà).
 */
export type StoredPushSubscription = {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** Les trois catégories réglables, telles que l'écran et les services les lisent. */
export type PushPreferences = {
  dailySession: boolean;
  activityAnalyzed: boolean;
  suggestions: boolean;
};

/**
 * Ce que valent les préférences en l'absence d'athlète.
 *
 * Les mêmes valeurs que les défauts des colonnes, et pour la même raison : ce
 * qui autorise un envoi, c'est l'existence d'un abonnement — sans athlète il
 * n'y en a aucun, ces trois booléens ne décident donc de rien.
 */
const DEFAULT_PREFERENCES: PushPreferences = {
  dailySession: true,
  activityAnalyzed: true,
  suggestions: true,
};

/*
 * Les abonnements.
 */

/**
 * Enregistre (ou rafraîchit) l'abonnement de l'appareil courant, sous l'athlète
 * de la session.
 *
 * **Upsert sur l'endpoint**, parce que c'est la clé naturelle de l'appareil :
 * le navigateur rend la même à chaque appel de `pushManager.subscribe()` tant
 * que l'abonnement vit. Sans upsert, chaque passage dans les réglages ajouterait
 * une ligne, et la notification partirait en autant d'exemplaires.
 *
 * ## Le conflit ne réattribue **jamais** `athlete_id`
 *
 * C'est le point de sécurité de cette fonction. L'installation est
 * multi-comptes (invitations, `canInvite`), et l'endpoint arrive **du client** :
 * sans garde, le compte B qui poste l'endpoint d'un appareil du compte A
 * s'appropriait la ligne. A cessait de recevoir sans aucun signe, et son
 * téléphone se mettait à afficher l'entraînement de B.
 *
 * Le `setWhere` borne donc la mise à jour à l'athlète propriétaire : sur une
 * endpoint qui appartient à quelqu'un d'autre, l'`UPDATE` ne s'applique pas, le
 * `RETURNING` est vide, et on refuse en le disant
 * ({@link PushEndpointOwnedError}) plutôt que de laisser croire à un succès.
 *
 * **Le remède existe et passe par le navigateur** : se désabonner depuis les
 * réglages fait oublier l'abonnement au navigateur, qui en fabrique une
 * **nouvelle** endpoint au réabonnement — laquelle n'appartient à personne. La
 * ligne de A, elle, sera effacée au premier 404/410 (cf. {@link
 * dropSubscription}).
 *
 * `last_success_at` n'est **pas** remis à zéro : un réabonnement sur la même
 * endpoint ne fait pas oublier que cet appareil recevait.
 *
 * @throws {AthleteNotFoundError} si le compte n'a pas d'athlète.
 * @throws {PushEndpointOwnedError} si l'endpoint appartient à un autre athlète.
 */
export async function saveSubscription(input: PushSubscriptionInput): Promise<void> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  const device = {
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: input.userAgent ?? null,
  };

  const written = await db
    .insert(pushSubscriptions)
    .values({ athleteId, endpoint: input.endpoint, ...device })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      // `athlete_id` n'est pas dans le `set` : une ligne existante garde son
      // propriétaire, toujours.
      set: device,
      // Dans un `ON CONFLICT DO UPDATE`, la colonne non qualifiée désigne la
      // **ligne déjà en base** : la mise à jour n'a lieu que si elle est déjà
      // celle de cet athlète.
      setWhere: eq(pushSubscriptions.athleteId, athleteId),
    })
    .returning({ athleteId: pushSubscriptions.athleteId });

  // Aucune ligne rendue = le conflit a eu lieu et l'`UPDATE` a été écarté par le
  // `setWhere`. Le seul cas possible : l'endpoint est à quelqu'un d'autre.
  if (written.length === 0) throw new PushEndpointOwnedError();
}

/**
 * Retire l'abonnement de cet appareil — **s'il appartient à l'athlète de la
 * session**.
 *
 * Ne lève pas quand rien n'est effacé : l'endpoint peut avoir déjà été purgée
 * par un envoi (404/410), et l'écran doit pouvoir se désabonner malgré tout. Le
 * silence est aussi ce qui empêche l'action de dire si une endpoint existe
 * ailleurs.
 *
 * @throws {AthleteNotFoundError} si le compte n'a pas d'athlète.
 */
export async function removeSubscription(endpoint: string): Promise<void> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.athleteId, athleteId), eq(pushSubscriptions.endpoint, endpoint)),
    );
}

/**
 * Tous les appareils abonnés d'un athlète **désigné** — la lecture de l'envoi,
 * qui tourne hors requête.
 */
export async function listSubscriptions(athleteId: number): Promise<StoredPushSubscription[]> {
  return db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.athleteId, athleteId))
    .orderBy(pushSubscriptions.id);
}

/**
 * Efface un abonnement mort, par son identifiant interne.
 *
 * Appelée par l'envoi quand le service de push répond 404 ou 410 : ces deux
 * codes disent que l'endpoint n'existe plus (application désinstallée,
 * permission révoquée). La garder ferait réessayer indéfiniment, et fausserait
 * le compte d'appareils affiché.
 *
 * L'identifiant vient de {@link listSubscriptions}, donc d'une lecture déjà
 * bornée à l'athlète : il n'y a rien à recloisonner ici.
 */
export async function dropSubscription(id: number): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}

/**
 * Date le dernier envoi accepté d'un abonnement — la seule façon de distinguer
 * un appareil vivant d'un appareil qui n'a jamais rien reçu.
 */
export async function touchSubscription(id: number): Promise<void> {
  await db
    .update(pushSubscriptions)
    .set({ lastSuccessAt: new Date() })
    .where(eq(pushSubscriptions.id, id));
}

/**
 * Combien d'appareils sont abonnés **pour le compte connecté**. `0` sans
 * session, sans athlète, ou sans appareil : l'écran a la même phrase pour les
 * trois.
 */
export async function countSubscriptions(): Promise<number> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return 0;

  const rows = await db
    .select({ value: count() })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.athleteId, athleteId));

  return rows[0]?.value ?? 0;
}

/*
 * Les préférences de catégorie.
 */

/** Les trois booléens d'un athlète **désigné** — la lecture des services de fond. */
export async function getPushPreferencesFor(athleteId: number): Promise<PushPreferences> {
  const rows = await db
    .select({
      dailySession: athlete.pushDailySession,
      activityAnalyzed: athlete.pushActivityAnalyzed,
      suggestions: athlete.pushSuggestions,
    })
    .from(athlete)
    .where(eq(athlete.id, athleteId))
    .limit(1);

  return rows[0] ?? DEFAULT_PREFERENCES;
}

/** Les trois booléens **du compte connecté**, à leurs défauts s'il n'y a pas d'athlète. */
export async function getPushPreferences(): Promise<PushPreferences> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return DEFAULT_PREFERENCES;

  return getPushPreferencesFor(athleteId);
}

/**
 * Change une partie des préférences du compte connecté.
 *
 * **Partiel, et pas par accident** : l'écran bascule un interrupteur à la fois,
 * et envoyer les trois à chaque clic écraserait les deux autres avec l'état que
 * le navigateur croyait vrai — celui d'avant, si un second onglet vient de les
 * changer.
 *
 * @throws {AthleteNotFoundError} si le compte n'a pas d'athlète.
 */
export async function setPushPreferences(next: Partial<PushPreferences>): Promise<void> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  // Construit colonne par colonne : ce qui n'est pas dans `next` n'est pas
  // écrit, et rien d'autre que ces trois colonnes ne peut l'être.
  const changes: Partial<{
    pushDailySession: boolean;
    pushActivityAnalyzed: boolean;
    pushSuggestions: boolean;
  }> = {};
  if (next.dailySession !== undefined) changes.pushDailySession = next.dailySession;
  if (next.activityAnalyzed !== undefined) changes.pushActivityAnalyzed = next.activityAnalyzed;
  if (next.suggestions !== undefined) changes.pushSuggestions = next.suggestions;

  // Rien à changer : pas de requête, et surtout pas un `updated_at` qui
  // prétendrait qu'il s'est passé quelque chose.
  if (Object.keys(changes).length === 0) return;

  await db
    .update(athlete)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(athlete.id, athleteId));
}

/*
 * L'idempotence des envois.
 */

/**
 * Réserve l'émission d'une notification, **atomiquement**.
 *
 * `true` : la ligne vient d'être insérée, l'appelant doit envoyer.
 * `false` : elle existait déjà, il n'y a rien à faire.
 *
 * La décision appartient à l'`INSERT … ON CONFLICT DO NOTHING`, pas à une
 * lecture préalable : deux cycles concurrents qui liraient d'abord
 * concluraient tous les deux « rien en base » et enverraient deux fois. Ici,
 * l'index unique `(athlete_id, kind, dedupe_key)` tranche en base, et le
 * `RETURNING` vide de la seconde insertion est la réponse.
 *
 * **Réserver, c'est s'engager** : un envoi qui échoue après coup ne sera pas
 * repris. C'est le compromis voulu — mieux vaut une notification manquée qu'une
 * boucle qui en émet une par minute jusqu'à ce que le réseau revienne.
 */
export async function claimNotice(
  athleteId: number,
  kind: PushNoticeKind,
  dedupeKey: string,
): Promise<boolean> {
  const inserted = await db
    .insert(pushNotices)
    .values({ athleteId, kind, dedupeKey })
    .onConflictDoNothing()
    .returning({ athleteId: pushNotices.athleteId });

  return inserted.length > 0;
}

/**
 * Rend une réservation, pour que la **prochaine** occurrence renotifie.
 *
 * Le pendant exact de {@link claimNotice}, et la moitié qui manquait aux
 * propositions : leur clé ne porte plus la valeur proposée mais le seul genre
 * (« max-hr »), de sorte qu'une médiane qui dérive d'un battement ne fabrique
 * plus une bannière par jour pour une carte que personne n'a traitée. Ce qui
 * fait une notification, ce n'est alors plus une valeur nouvelle, c'est une
 * **transition « absente → présente »** — et il faut donc effacer la ligne au
 * moment où la proposition disparaît (acceptée, écartée, ou simplement plus
 * calculée), sans quoi elle ne pourrait plus jamais se réannoncer.
 *
 * Idempotente : effacer ce qui n'existe pas n'est pas une erreur, et l'appelant
 * ne sait pas — n'a pas à savoir — si une réservation était en cours. Rien n'est
 * rendu pour la même raison.
 */
export async function releaseNotice(
  athleteId: number,
  kind: PushNoticeKind,
  dedupeKey: string,
): Promise<void> {
  await db
    .delete(pushNotices)
    .where(
      and(
        eq(pushNotices.athleteId, athleteId),
        eq(pushNotices.kind, kind),
        eq(pushNotices.dedupeKey, dedupeKey),
      ),
    );
}

/**
 * Âge au-delà duquel une réservation ne sert plus à rien — **90 jours**.
 *
 * `push_notices` est de l'anti-doublon, pas de l'historique : sans purge, elle
 * gagne une ligne par jour et par athlète pour le rappel du matin, et une par
 * séance importée, à conserver jusqu'à la fin des temps.
 *
 * Le chiffre est **très** au-delà de ce que la déduplication demande, et c'est
 * volontaire : une purge qui mordrait sur une fenêtre encore vivante
 * ressusciterait la notification correspondante. Marge par catégorie purgée :
 *
 * - `daily-session` : la clé est une **date civile**, et sa fenêtre d'envoi ne
 *   rouvre jamais (`isReminderDue` ne vaut que pour la matinée du jour). Une
 *   ligne de plus de 90 jours ne peut plus rien réclamer, à un jour près ;
 * - `activity-analyzed` : la clé est l'**identifiant d'une activité**, réclamée
 *   à son ingestion. Il faudrait qu'une séance déjà importée soit réanalysée
 *   plus de trois mois plus tard pour qu'une bannière reparte — le watcher
 *   déduplique déjà par empreinte de fichier.
 */
export const NOTICE_RETENTION_DAYS = 90;

/**
 * Les catégories que la purge efface, et **elles seules**.
 *
 * `suggestion` en est exclue exprès, et l'exclusion n'a fait que gagner en force
 * depuis que sa clé est le **genre** de la proposition (« max-hr ») : la ligne ne
 * dit plus « cette valeur-là a été annoncée » mais « une proposition de ce genre
 * est en cours ». Elle vaut tant que la carte est sur le tableau de bord, c'est
 * à dire potentiellement des mois, et sa disparition est un **geste** —
 * {@link releaseNotice}, appelé quand la proposition n'est plus calculée — jamais
 * un effet du temps. Une purge par ancienneté la ferait renotifier sans que rien
 * n'ait changé : exactement la résurrection interdite. Ces lignes sont d'ailleurs
 * bornées par nature : quatre au plus par athlète.
 *
 * `test` n'y figure pas non plus, pour une raison plus simple : la notification
 * de test ne réserve rien (cf. `sendTestNotificationAction`), il n'y a jamais de
 * ligne de ce genre.
 */
const PURGED_NOTICE_KINDS: readonly PushNoticeKind[] = ['daily-session', 'activity-analyzed'];

/**
 * Efface les réservations périmées, et rend combien de lignes sont parties.
 *
 * Appelée par la boucle du service push, à cadence lente (cf.
 * `src/lib/push/service.ts`) : c'est un entretien, pas un travail de cycle.
 * Aucun athlète en paramètre — c'est un balayage global, borné par la seule
 * date.
 */
export async function purgeStaleNotices(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - NOTICE_RETENTION_DAYS * 24 * 60 * 60 * 1_000);

  const deleted = await db
    .delete(pushNotices)
    .where(and(inArray(pushNotices.kind, PURGED_NOTICE_KINDS), lt(pushNotices.sentAt, cutoff)))
    .returning({ athleteId: pushNotices.athleteId });

  return deleted.length;
}
