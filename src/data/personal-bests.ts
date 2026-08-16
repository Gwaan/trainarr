import 'server-only';

import { and, asc, count, eq } from 'drizzle-orm';

import { toCivilDate } from '@/lib/dates/civil';

import { getCurrentAthleteId } from './athlete';
import { pendingBestSegmentsWhere } from './db/best-segments-scope';
import { db } from './db/client';
import { activities, activityBestSegments } from './db/schema';

/**
 * Records personnels : le meilleur temps de **tous les temps** sur chacune des
 * distances de référence (400 m, 1 km, mile, 5 km, 10 km, semi).
 *
 * ## Une agrégation, pas un parcours
 *
 * Les meilleurs efforts sont persistés à l'ingestion
 * (`activity_best_segments`), précisément pour que cette lecture existe : un
 * record est ici un `DISTINCT ON (target_m) … ORDER BY target_m, time_s`,
 * c'est-à-dire la première ligne de six intervalles contigus de l'index
 * `activity_best_segments_target_m_time_s_idx`. La même réponse tirée des flux
 * bruts aurait demandé de parser des dizaines de mégaoctets de JSONB à chaque
 * affichage, et de faire lire `activity_streams` à un module d'écran — ce que
 * `progression.ts` et `dashboard.ts` ne font jamais.
 *
 * Deux requêtes, et deux seulement : les records, puis le compte de ce qui reste
 * à rattraper. Aucune boucle, aucun N+1, rien de l'historique en mémoire.
 *
 * ## Pourquoi un compteur d'activités en attente
 *
 * L'historique importé avant cette table n'a pas de segments tant que
 * `pnpm db:backfill:best-segments` n'est pas passé. Annoncer « record du 10 km »
 * alors que la moitié des séances n'a pas été balayée serait un mensonge :
 * `pendingActivities` rend l'état visible, et c'est à l'écran de dire que les
 * records sont **provisoires** tant qu'il n'est pas nul.
 *
 * ## Cloisonnement
 *
 * `activity_best_segments` n'a pas d'`athlete_id` : les deux requêtes joignent
 * (ou filtrent) `activities` sur l'athlète de la session. Sans athlète — donc
 * sans session — rien n'est lu et la réponse est vide, comme partout ailleurs
 * dans le DAL.
 */

export type PersonalBestDto = {
  targetM: number;
  timeS: number;
  paceSecPerKm: number;
  /** Date civile de la séance qui porte le record. */
  achievedOn: string;
  /** Pour pouvoir ouvrir la séance depuis l'écran des records. */
  activityId: number;
};

export type PersonalBestsDto = {
  bests: PersonalBestDto[];
  /**
   * Nombre d'activités de course dont les segments ne sont pas encore
   * persistés : tant qu'il est non nul, les records sont **provisoires** et
   * l'écran doit le dire — un record affiché comme définitif alors que la
   * moitié de l'historique n'a pas été balayée serait un mensonge.
   */
  pendingActivities: number;
};

/** Aucune session, aucun athlète : rien à montrer, et rien qui reste à balayer. */
const NOTHING: PersonalBestsDto = { bests: [], pendingActivities: 0 };

export async function getPersonalBests(): Promise<PersonalBestsDto> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return NOTHING;

  const [bestRows, pendingRows] = await Promise.all([
    /*
     * Un record par cible, en une passe.
     *
     * L'ordre du `DISTINCT ON` est celui de l'index : `target_m` (six valeurs,
     * six intervalles), puis `time_s` croissant — la première ligne de chaque
     * intervalle **est** le record.
     *
     * Le troisième critère, `started_at` croissant, ne départage que les ex
     * æquo au centième de seconde près : dans ce cas le record appartient à la
     * séance qui l'a établi **la première**, et non à une plus récente qui n'a
     * fait que l'égaler. Sans lui, Postgres rendrait l'une ou l'autre selon son
     * plan d'exécution, et la page changerait de séance d'un affichage à
     * l'autre.
     */
    db
      .selectDistinctOn([activityBestSegments.targetM], {
        targetM: activityBestSegments.targetM,
        timeS: activityBestSegments.timeS,
        paceSecPerKm: activityBestSegments.paceSecPerKm,
        activityId: activityBestSegments.activityId,
        startedAt: activities.startedAt,
      })
      .from(activityBestSegments)
      .innerJoin(
        activities,
        and(
          eq(activities.id, activityBestSegments.activityId),
          eq(activities.athleteId, athleteId),
        ),
      )
      .orderBy(
        asc(activityBestSegments.targetM),
        asc(activityBestSegments.timeS),
        asc(activities.startedAt),
      ),
    // Ce qui reste à balayer, sous la définition **partagée avec le script de
    // rattrapage** (cf. `./db/best-segments-scope`) : si les deux divergeaient,
    // ce compteur n'atteindrait jamais zéro.
    db
      .select({ value: count() })
      .from(activities)
      .where(pendingBestSegmentsWhere(athleteId)),
  ]);

  return {
    bests: bestRows.map((row) => ({
      targetM: row.targetM,
      timeS: row.timeS,
      paceSecPerKm: row.paceSecPerKm,
      // Le fuseau de l'appli, comme partout : la date affichée est celle qu'a
      // vécue l'athlète, pas celle de l'instant UTC stocké.
      achievedOn: toCivilDate(row.startedAt),
      activityId: row.activityId,
    })),
    pendingActivities: pendingRows[0]?.value ?? 0,
  };
}
