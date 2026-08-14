import 'server-only';

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type { WellnessReading } from '@/lib/intervals/wellness-client';

import { db } from './db/client';
import { athlete, wellnessDays } from './db/schema';

/**
 * Le relevé bien-être : écritures du service, lectures d'écran et de coach.
 *
 * ## D'où viennent ces mesures
 *
 * De la **montre**, jamais de l'application : HRV nocturne, FC de repos,
 * sommeil, et le poids de la balance. HealthFit les pousse vers intervals.icu,
 * d'où le relevé quotidien (`src/lib/intervals/wellness-service.ts`) les
 * rapatrie. Trainarr ne les calcule pas, ne les corrige pas, et n'en dérive
 * aucune métrique physio — il les stocke, les montre et les donne à lire.
 *
 * ## Ce que ce module n'écrit pas
 *
 * **`athlete.weight_kg` n'est jamais touché.** C'est une décision, pas un
 * oubli : le poids du profil reste saisi à la main. Il pèse dans ce que
 * l'application calcule, et une balance qui le réécrirait sans accord serait
 * exactement ce qu'on refuse pour les fréquences cardiaques — dont
 * l'application **propose** la mise à jour au lieu de l'appliquer (cf.
 * `./max-hr-suggestion.ts` et `./resting-hr-suggestion.ts`). Le poids rapatrié
 * vit dans `wellness_days`, s'affiche en tendance, et s'arrête là.
 *
 * ## Cloisonnement
 *
 * Comme partout : **l'athlète est un paramètre**. Le relevé tourne dans le
 * service de fond, hors requête — il n'y a pas de session à interroger — et les
 * lectures d'écran reçoivent l'athlète que leur appelant a déjà résolu depuis la
 * session.
 */

/**
 * Profondeur de la lecture qui alimente la tuile du tableau de bord.
 *
 * Trente jours : au-delà, une mesure n'est plus « la dernière », c'est une
 * archive. Une FC de repos vieille de trois mois affichée comme valeur courante
 * dirait quelque chose de faux même datée ; mieux vaut annoncer l'absence.
 */
export const WELLNESS_LATEST_WINDOW_DAYS = 30;

/** Une mesure, et le jour où elle a été prise. */
export type WellnessMeasureDto = {
  value: number;
  /** Jour civil `YYYY-MM-DD` de la mesure. */
  day: string;
};

/**
 * Ce que la tuile du tableau de bord affiche : la dernière valeur connue de
 * chaque mesure, chacune avec sa date.
 *
 * Trois champs indépendamment `null`, et c'est le cœur du contrat : une nuit
 * sans ceinture cardiaque donne un sommeil sans HRV, et l'écran doit pouvoir
 * dire « pas de HRV » sans rien laisser en blanc.
 */
export type WellnessSummaryDto = {
  /** Jour de la lecture : c'est lui qui décide si une mesure date d'aujourd'hui. */
  today: string;
  restingHr: WellnessMeasureDto | null;
  hrv: WellnessMeasureDto | null;
  sleep: WellnessMeasureDto | null;
};

/** Une journée de relevé, telle que les tendances et le coach la lisent. */
export type WellnessDayDto = {
  /** Jour civil `YYYY-MM-DD`. */
  day: string;
  restingHrBpm: number | null;
  /** Variabilité cardiaque nocturne (rMSSD), en millisecondes. */
  hrvRmssdMs: number | null;
  sleepTimeS: number | null;
  /** Score de sommeil de la montre, sur 100 — ce n'est pas un calcul de Trainarr. */
  sleepScore: number | null;
  avgSleepingHrBpm: number | null;
  weightKg: number | null;
};

/*
 * Écriture du relevé.
 */

/**
 * Enregistre (ou complète) les journées rapatriées d'un athlète **désigné**.
 *
 * **Une valeur connue n'est jamais remplacée par un trou.** L'écriture est un
 * `ON CONFLICT … DO UPDATE` où chaque colonne vaut `coalesce(nouvelle,
 * ancienne)` : un second passage qui ne rapporterait plus le sommeil d'avant-hier
 * (mesure retirée côté amont, réponse partielle) laisse en place ce qui avait été
 * écrit. C'est la seule politique compatible avec le fait qu'une journée **se
 * complète après coup** — la montre synchronise en retard, et les mesures d'un
 * même jour n'arrivent pas ensemble.
 *
 * Rend le nombre de journées écrites, tel que le journal du service l'annonce.
 */
export async function saveWellnessDays(
  athleteId: number,
  readings: readonly WellnessReading[],
  now: Date = new Date(),
): Promise<number> {
  if (readings.length === 0) return 0;

  await db
    .insert(wellnessDays)
    .values(
      readings.map((reading) => ({
        athleteId,
        day: reading.day,
        restingHrBpm: reading.restingHrBpm,
        hrvRmssdMs: reading.hrvRmssdMs,
        sleepTimeS: reading.sleepTimeS,
        sleepScore: reading.sleepScore,
        avgSleepingHrBpm: reading.avgSleepingHrBpm,
        weightKg: reading.weightKg,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [wellnessDays.athleteId, wellnessDays.day],
      set: {
        restingHrBpm: sql`coalesce(excluded.resting_hr_bpm, ${wellnessDays.restingHrBpm})`,
        hrvRmssdMs: sql`coalesce(excluded.hrv_rmssd_ms, ${wellnessDays.hrvRmssdMs})`,
        sleepTimeS: sql`coalesce(excluded.sleep_time_s, ${wellnessDays.sleepTimeS})`,
        sleepScore: sql`coalesce(excluded.sleep_score, ${wellnessDays.sleepScore})`,
        avgSleepingHrBpm: sql`coalesce(excluded.avg_sleeping_hr_bpm, ${wellnessDays.avgSleepingHrBpm})`,
        weightKg: sql`coalesce(excluded.weight_kg, ${wellnessDays.weightKg})`,
        updatedAt: now,
      },
    });

  return readings.length;
}

/**
 * Le marqueur du dernier relevé **abouti** d'un athlète désigné, `null` s'il n'y
 * en a jamais eu (ou si l'athlète n'existe pas).
 */
export async function getWellnessReadingDay(athleteId: number): Promise<string | null> {
  const rows = await db
    .select({ readingDay: athlete.wellnessReadingDay })
    .from(athlete)
    .where(eq(athlete.id, athleteId))
    .limit(1);

  return rows[0]?.readingDay ?? null;
}

/**
 * Pose le marqueur du relevé du jour.
 *
 * Appelé **après** l'écriture des journées, et seulement en cas de succès : un
 * relevé qui n'a rien pu lire ne doit pas immuniser la journée contre une
 * nouvelle tentative.
 */
export async function setWellnessReadingDay(athleteId: number, day: string): Promise<void> {
  await db
    .update(athlete)
    .set({ wellnessReadingDay: day, updatedAt: new Date() })
    .where(eq(athlete.id, athleteId));
}

/*
 * Lectures.
 */

/**
 * Les journées d'un athlète désigné entre deux dates civiles **incluses**, de la
 * plus ancienne à la plus récente.
 *
 * Lecture primitive de ce module : les tendances, le contexte du coach et la
 * proposition de FC de repos s'en servent toutes, avec des fenêtres différentes.
 * Les journées sans aucune mesure sont rendues telles quelles — un jour dont
 * tout est `null` est une information, pas un vide à masquer.
 */
export async function listWellnessDays(
  athleteId: number,
  from: string,
  to: string,
): Promise<WellnessDayDto[]> {
  const rows = await db
    .select({
      day: wellnessDays.day,
      restingHrBpm: wellnessDays.restingHrBpm,
      hrvRmssdMs: wellnessDays.hrvRmssdMs,
      sleepTimeS: wellnessDays.sleepTimeS,
      sleepScore: wellnessDays.sleepScore,
      avgSleepingHrBpm: wellnessDays.avgSleepingHrBpm,
      weightKg: wellnessDays.weightKg,
    })
    .from(wellnessDays)
    .where(
      and(
        eq(wellnessDays.athleteId, athleteId),
        gte(wellnessDays.day, from),
        lte(wellnessDays.day, to),
      ),
    )
    .orderBy(wellnessDays.day);

  return rows;
}

/** Ce qu'une mesure vaut sur une journée — `null` quand elle n'a pas été prise. */
type MeasureReader = (day: WellnessDayDto) => number | null;

/**
 * La dernière valeur d'une mesure, avec son jour. Fonction pure, exportée pour
 * les tests.
 *
 * `days` est attendu **du plus récent au plus ancien** : la première journée qui
 * porte la mesure gagne. Chaque mesure est cherchée séparément, et c'est
 * volontaire — une nuit sans ceinture donne un sommeil sans HRV, et faire dater
 * les trois valeurs du même jour reviendrait à jeter la plus récente des deux
 * autres.
 */
export function latestMeasure(
  days: readonly WellnessDayDto[],
  read: MeasureReader,
): WellnessMeasureDto | null {
  for (const day of days) {
    const value = read(day);
    if (value !== null) return { value, day: day.day };
  }
  return null;
}

/**
 * La dernière valeur connue de chaque mesure d'un athlète **désigné**, sur les
 * {@link WELLNESS_LATEST_WINDOW_DAYS} derniers jours.
 *
 * L'athlète et le jour courant sont des paramètres : l'appelant (le tableau de
 * bord) tient déjà les deux, et deux « aujourd'hui » calculés à quelques
 * millisecondes d'écart pourraient tomber de part et d'autre de minuit.
 */
export async function selectWellnessSummary(
  athleteId: number,
  today: string,
  from: string,
): Promise<WellnessSummaryDto> {
  const rows = await db
    .select({
      day: wellnessDays.day,
      restingHrBpm: wellnessDays.restingHrBpm,
      hrvRmssdMs: wellnessDays.hrvRmssdMs,
      sleepTimeS: wellnessDays.sleepTimeS,
      sleepScore: wellnessDays.sleepScore,
      avgSleepingHrBpm: wellnessDays.avgSleepingHrBpm,
      weightKg: wellnessDays.weightKg,
    })
    .from(wellnessDays)
    .where(
      and(
        eq(wellnessDays.athleteId, athleteId),
        gte(wellnessDays.day, from),
        lte(wellnessDays.day, today),
      ),
    )
    // Du plus récent au plus ancien : `latestMeasure` s'arrête à la première
    // journée qui porte la mesure qu'elle cherche.
    .orderBy(desc(wellnessDays.day));

  return {
    today,
    restingHr: latestMeasure(rows, (day) => day.restingHrBpm),
    hrv: latestMeasure(rows, (day) => day.hrvRmssdMs),
    sleep: latestMeasure(rows, (day) => day.sleepTimeS),
  };
}

/** Une tuile sans athlète : tout est absent, rien n'est inventé. */
export function emptyWellnessSummary(today: string): WellnessSummaryDto {
  return { today, restingHr: null, hrv: null, sleep: null };
}
