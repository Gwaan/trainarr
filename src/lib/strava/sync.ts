import 'server-only';

import { getAthleteProfile, getStravaAthleteId } from '@/data/athlete';
import {
  findActivityIdsWithoutStreams,
  findKnownStravaIds,
  saveActivityStreams,
  upsertActivityFromStrava,
} from '@/data/activities';
import { getFreshAccessToken } from '@/data/strava-tokens';
import { usesFootCadenceSportType } from '@/lib/fit/sport';

import {
  getActivity,
  getActivityStreams,
  listActivities,
  type StravaActivity,
  type StravaStreamSet,
} from './client';
import { StravaAuthError, StravaRateLimitError } from './errors';

/**
 * Service de synchronisation Strava.
 *
 * Seul module de `lib/strava` à toucher la base, et uniquement via le DAL : le
 * jeton n'est obtenu que par `getFreshAccessToken()` et ne quitte jamais ce
 * processus serveur.
 */

const PER_PAGE = 100;

/**
 * Borne dure du backfill : 20 × 100 = 2 000 activités par appel. Elle garantit
 * l'absence de boucle infinie si l'API renvoie indéfiniment des pages pleines ;
 * un historique plus long se rattrape à l'appel suivant.
 */
const MAX_PAGES = 20;

export type SyncReport = {
  fetched: number;
  created: number;
  updated: number;
  /**
   * `true` si le quota Strava a interrompu la synchronisation. Aucun retry ici :
   * le prochain appel reprendra le backfill là où il s'est arrêté.
   */
  rateLimited: boolean;
};

/** Contexte commun aux deux points d'entrée : jeton frais + athlète cible. */
async function syncContext(): Promise<{ accessToken: string; athleteId: number }> {
  const accessToken = await getFreshAccessToken();
  if (accessToken === null) {
    throw new StravaAuthError("Strava n'est pas connecté : aucun jeton en base.");
  }

  const profile = await getAthleteProfile();
  if (!profile) {
    throw new Error(
      "Aucun athlète enregistré : impossible d'importer des activités (onboarding requis).",
    );
  }

  return { accessToken, athleteId: profile.id };
}

/**
 * Défense en profondeur : `true` si l'API affirme que l'activité appartient à
 * quelqu'un d'autre que notre athlète.
 *
 * Ni l'un ni l'autre des deux identifiants n'est garanti (`athlete.id` est absent
 * de certaines réponses, `stravaAthleteId` est nul avant la première connexion) :
 * dans le doute on n'écarte rien, ce contrôle ne remplace pas la vérification de
 * l'`owner_id` du webhook.
 */
function isForeignActivity(activity: StravaActivity, stravaAthleteId: number | null): boolean {
  if (activity.athleteStravaId === null || stravaAthleteId === null) return false;
  return activity.athleteStravaId !== stravaAthleteId;
}

/**
 * Aligne les séries sur les unités de la table `activity_streams`.
 *
 * Strava renvoie la cadence en cycles d'une seule jambe (~87 pour ~174 pas/min).
 * La colonne stocke des **pas par minute** pour les sports à pied — l'unité que
 * connaissent les coureurs, et celle que produit déjà l'import FIT
 * (`src/lib/fit/parse.ts`) comme le scalaire `avgCadenceSpm`. Sans cette
 * conversion, la même colonne mélangeait deux unités selon le canal d'import et
 * les graphes de cadence étaient faux d'un facteur 2. Le vélo garde ses tours de
 * pédalier par minute.
 */
function toStoredUnits(streams: StravaStreamSet, sportType: string): StravaStreamSet {
  if (!streams.cadence || !usesFootCadenceSportType(sportType)) return streams;

  return { ...streams, cadence: streams.cadence.map((value) => value * 2) };
}

/** Importe les streams d'une activité. Sans objet si Strava n'en a pas (404). */
async function importStreams(
  accessToken: string,
  activityId: number,
  activity: StravaActivity,
): Promise<void> {
  const streams = await getActivityStreams(accessToken, activity.id);
  if (!streams) return;
  await saveActivityStreams(activityId, toStoredUnits(streams, activity.sportType));
}

/**
 * Backfill paginé des activités, de la plus récente à la plus ancienne.
 *
 * Les streams sont récupérés pour les activités **qui n'en ont pas encore en
 * base**, et non pour les seules activités nouvelles : un backfill interrompu par
 * le quota laisse des activités écrites sans leurs séries, que le passage suivant
 * doit compléter. Une activité déjà complète ne consomme aucun appel API.
 *
 * @param options.after ne remonter que les activités postérieures à cette date.
 */
export async function syncRecentActivities(options?: { after?: Date }): Promise<SyncReport> {
  const report: SyncReport = { fetched: 0, created: 0, updated: 0, rateLimited: false };
  const { accessToken, athleteId } = await syncContext();
  const stravaAthleteId = await getStravaAthleteId();

  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await listActivities(accessToken, {
        page,
        perPage: PER_PAGE,
        after: options?.after,
      });
      if (batch.length === 0) break;

      report.fetched += batch.length;

      const owned = batch.filter((activity) => !isForeignActivity(activity, stravaAthleteId));
      if (owned.length !== batch.length) {
        console.error(
          `[strava] ${batch.length - owned.length} activité(s) écartée(s) : l'API les attribue à un autre athlète.`,
        );
      }

      const known = await findKnownStravaIds(owned.map((activity) => activity.id));
      const upserted: Array<{ activityId: number; activity: StravaActivity }> = [];

      for (const activity of owned) {
        const { activityId, merged } = await upsertActivityFromStrava(activity, athleteId);
        // Une activité rapprochée d'un FIT déjà en base n'est pas une création :
        // aucune ligne n'a été ajoutée, celle du fichier a été complétée.
        if (known.has(activity.id) || merged) {
          report.updated += 1;
        } else {
          report.created += 1;
        }
        upserted.push({ activityId, activity });
      }

      const missingStreams = await findActivityIdsWithoutStreams(
        upserted.map((item) => item.activityId),
      );
      for (const { activityId, activity } of upserted) {
        if (!missingStreams.has(activityId)) continue;
        await importStreams(accessToken, activityId, activity);
      }

      // Page incomplète : c'est la dernière, inutile d'en demander une de plus.
      if (batch.length < PER_PAGE) break;
    }
  } catch (error) {
    if (!(error instanceof StravaRateLimitError)) throw error;
    // Arrêt propre : ce qui est déjà importé est acquis, le rapport le signale.
    report.rateLimited = true;
  }

  return report;
}

/**
 * Importe (ou met à jour) une seule activité — point d'entrée du webhook
 * `activity.create` / `activity.update`. Les streams sont systématiquement
 * réimportés : sur une mise à jour Strava, ils peuvent avoir changé.
 *
 * `ownerId` est l'`owner_id` de l'événement. Le payload webhook n'étant **pas
 * signé** par Strava, n'importe qui connaissant l'URL peut en poster un : sans ce
 * contrôle, un événement forgé ferait importer l'activité d'un tiers dans la base
 * de Gwen (et suffirait à épuiser notre quota API). Un `ownerId` qui ne
 * correspond pas à l'athlète connecté fait donc abandonner **avant tout appel à
 * l'API Strava**, silencieusement du point de vue de l'appelant (trace serveur).
 *
 * Les erreurs (quota, auth) remontent à l'appelant, qui décide du retry.
 */
export async function syncSingleActivity(
  stravaActivityId: number,
  ownerId: number,
): Promise<void> {
  const connectedAthleteId = await getStravaAthleteId();
  if (connectedAthleteId === null || connectedAthleteId !== ownerId) {
    console.error(
      `[strava] Événement webhook ignoré pour l'activité ${stravaActivityId} : owner_id ${ownerId} n'est pas celui de l'athlète connecté.`,
    );
    return;
  }

  const { accessToken, athleteId } = await syncContext();

  const activity = await getActivity(accessToken, stravaActivityId);
  if (isForeignActivity(activity, connectedAthleteId)) {
    console.error(
      `[strava] Activité ${stravaActivityId} écartée : l'API l'attribue à un autre athlète.`,
    );
    return;
  }

  const { activityId } = await upsertActivityFromStrava(activity, athleteId);
  await importStreams(accessToken, activityId, activity);
}
