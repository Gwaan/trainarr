import 'server-only';

import { eq } from 'drizzle-orm';

// Les modules de calcul directement, et non le tonneau `@/lib/metrics` : ce
// module est chargé par des tests qui doublent le tonneau entier, et une
// fonction lue au chargement y disparaîtrait (même raison que
// `./elevation-correction`).
import {
  NEUTRAL_VO2MAX_CORRECTION_FACTOR,
  VO2MAX_CORRECTION_FACTOR_BOUNDS,
  computeVo2maxCorrection,
  isPlausibleCorrectionFactor,
  type RaceCalibrationStatus,
  type Vo2maxCorrectionUnavailable,
} from '@/lib/metrics/vo2max-correction';

import { AthleteNotFoundError, getAthleteById, getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import { athlete, type Athlete } from './db/schema';
import { listRaceResults, type RaceResultDto } from './race-results';

/**
 * Le **facteur correctif de la VO₂max effective** : sa valeur, son origine, et
 * de quoi l'expliquer.
 *
 * Il compose deux choses que rien d'autre ne réunit :
 *
 *  - les **courses déclarées** (`./race-results`), avec la FC et le dénivelé de
 *    leur séance ;
 *  - le **profil** — FC max, réglage de correction d'altitude, et le facteur
 *    manuel qui prime sur le calcul (`athlete.vo2max_correction_factor`,
 *    `NULL` = automatique, comme le champ vide de Runalyze).
 *
 * Le calcul lui-même est pur et vit dans `lib/metrics/vo2max-correction.ts`,
 * qui porte la source et la justification des bornes.
 *
 * ## Rien n'est persisté du côté du résultat
 *
 * Le facteur se recalcule à chaque lecture, comme la VO₂max elle-même :
 * déclarer une course, corriger un chrono ou changer sa FC max relit
 * rétroactivement tout l'historique. Une colonne « facteur courant » serait
 * fausse dès la première de ces trois actions.
 *
 * ## Un seul point d'entrée, pour que les écrans ne se contredisent pas
 *
 * Le détail d'une séance, l'agrégat sur 30 jours, la page « Progression » et le
 * contexte du coach lisent **cette** fonction. Deux chemins de calcul
 * différents, et la tuile de forme n'aurait plus été la moyenne des valeurs
 * affichées par les séances qui l'alimentent — c'est exactement la contrainte
 * qu'a respectée la correction d'altitude avant lui.
 */

/** Une course, avec ce qu'elle dit du facteur. Le DTO de l'historique. */
export type RaceCalibrationDto = {
  id: number;
  /** Jour civil `YYYY-MM-DD`. */
  racedOn: string;
  name: string | null;
  distanceM: number;
  timeS: number;
  /** La séance liée, pour pouvoir l'ouvrir depuis l'historique. */
  activityId: number | null;
  /**
   * VO₂max déduite du chrono officiel (Daniels & Gilbert), **corrigée du même
   * dénivelé** que sa jumelle : c'est ce qui fait sortir le terrain du rapport.
   */
  timeVo2max: number | null;
  /** VO₂max déduite de la FC (méthode Runalyze), **non recalée**. */
  hrVo2max: number | null;
  /** Le rapport des deux, `null` quand l'un des termes manque. */
  factor: number | null;
  status: RaceCalibrationStatus;
};

export type Vo2maxCorrectionDto = {
  /** Ce qui multiplie effectivement chaque VO₂max effective. */
  factor: number;
  source: 'manual' | 'race' | 'default';
  /** La valeur imposée au profil, `null` en mode automatique. */
  manualFactor: number | null;
  /** Ce que les courses donnent, même quand un facteur manuel les remplace. */
  automaticFactor: number;
  /** Renseigné exactement quand aucune course ne calibre. */
  unavailable: Vo2maxCorrectionUnavailable | null;
  /** La course qui porte le maximum, `null` sans calibration. */
  calibratedOnRaceId: number | null;
  /** Toutes les courses, de la plus récente à la plus ancienne. */
  races: RaceCalibrationDto[];
};

export { VO2MAX_CORRECTION_FACTOR_BOUNDS };

/** Aucun athlète : le neutre, sans course et sans réglage. */
export const NEUTRAL_VO2MAX_CORRECTION: Vo2maxCorrectionDto = {
  factor: NEUTRAL_VO2MAX_CORRECTION_FACTOR,
  source: 'default',
  manualFactor: null,
  automaticFactor: NEUTRAL_VO2MAX_CORRECTION_FACTOR,
  unavailable: 'no-race',
  calibratedOnRaceId: null,
  races: [],
};

/** Le facteur manuel saisi est hors bornes. */
export class InvalidCorrectionFactorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCorrectionFactorError';
  }
}

/**
 * Nombre de décimales conservées sur le facteur manuel.
 *
 * Trois : le facteur mesuré sur l'athlète de référence vaut 1,128, et un
 * centième y déplacerait la VO₂max d'un tiers de point — assez pour se voir.
 * Au-delà de trois, le chiffre saisi ne se relirait plus tel quel dans le champ
 * pour un effet indétectable.
 */
const FACTOR_DECIMALS = 3;

/**
 * Vérifie les bornes et rend le facteur normalisé, `null` pour « automatique ».
 * Pure, exportée pour les tests.
 *
 * Défense en profondeur : la Server Action valide déjà avec Zod, mais elle n'est
 * pas la seule porte d'entrée possible du DAL. Les bornes sont celles du module
 * de calcul — source unique.
 *
 * @throws {InvalidCorrectionFactorError} si la valeur n'est pas applicable.
 */
export function validateManualCorrectionFactor(factor: number | null): number | null {
  if (factor === null) return null;

  const rounded = Math.round(factor * 10 ** FACTOR_DECIMALS) / 10 ** FACTOR_DECIMALS;
  if (!isPlausibleCorrectionFactor(rounded)) {
    throw new InvalidCorrectionFactorError(
      `Facteur attendu entre ${VO2MAX_CORRECTION_FACTOR_BOUNDS.min} et ` +
        `${VO2MAX_CORRECTION_FACTOR_BOUNDS.max}, ou vide pour le calcul automatique.`,
    );
  }

  return rounded;
}

/**
 * Le facteur d'un athlète **désigné**, et tout ce qui l'explique.
 *
 * Deux lectures en parallèle : la ligne d'athlète (FC max, correction
 * d'altitude, facteur manuel) et ses courses avec la FC de leur séance. Aucune
 * autre requête — l'historique de courses tient en quelques lignes, et il n'y a
 * pas d'agrégat à faire faire à Postgres sur une table de cette taille.
 */
export async function getVo2maxCorrection(athleteId: number): Promise<Vo2maxCorrectionDto> {
  const [profile, races] = await Promise.all([
    getAthleteById(athleteId),
    listRaceResults(athleteId),
  ]);

  return profile === null
    ? NEUTRAL_VO2MAX_CORRECTION
    : buildVo2maxCorrection(profile, races);
}

/** Le facteur **du compte connecté**. Le neutre sans session ni athlète. */
export async function getCurrentVo2maxCorrection(): Promise<Vo2maxCorrectionDto> {
  const athleteId = await getCurrentAthleteId();
  return athleteId === null ? NEUTRAL_VO2MAX_CORRECTION : getVo2maxCorrection(athleteId);
}

/**
 * Compose le profil et les courses en un DTO. Séparée de la lecture pour être
 * testable sans base, et pour que la frontière client soit décidée en un seul
 * endroit : rien de la ligne d'athlète ne franchit ce point, seul le facteur
 * qu'elle porte.
 */
export function buildVo2maxCorrection(
  profile: Athlete,
  races: readonly RaceResultDto[],
): Vo2maxCorrectionDto {
  const correction = computeVo2maxCorrection({
    races: races.map((race) => ({
      raceId: race.id,
      racedOn: race.racedOn,
      name: race.name,
      distanceM: race.distanceM,
      timeS: race.timeS,
      avgHrBpm: race.avgHrBpm,
      elevation: { gainM: race.elevationGainM, lossM: race.elevationLossM },
    })),
    maxHrBpm: profile.maxHrBpm,
    // Les mêmes coefficients que partout ailleurs : le dénominateur du rapport
    // est une VO₂max effective ordinaire, elle doit être calculée comme celles
    // qu'elle sert à recaler. Le module de calcul les passe **aussi** au
    // numérateur — sans quoi le terrain entrerait dans le rapport au lieu de s'y
    // annuler (cf. `lib/metrics/vo2max-correction.ts`).
    elevationCorrection: profile.vo2maxElevationCorrection
      ? {
          ascentCoefM: profile.vo2maxAscentCoefM,
          descentCoefM: profile.vo2maxDescentCoefM,
        }
      : null,
    manualFactor: profile.vo2maxCorrectionFactor,
  });

  // L'identifiant d'activité n'est pas connu du module de calcul (il ne lui sert
  // à rien) : il est réassocié ici, course par course, dans le même ordre.
  const activityIds = new Map(races.map((race) => [race.id, race.activityId]));

  return {
    factor: correction.factor,
    source: correction.source,
    manualFactor: correction.manualFactor,
    automaticFactor: correction.automatic.factor,
    unavailable: correction.automatic.unavailable,
    calibratedOnRaceId: correction.automatic.calibratedOn?.raceId ?? null,
    races: correction.automatic.races.map((race) => ({
      id: race.raceId,
      racedOn: race.racedOn,
      name: race.name,
      distanceM: race.distanceM,
      timeS: race.timeS,
      activityId: activityIds.get(race.raceId) ?? null,
      timeVo2max: race.timeVo2max,
      hrVo2max: race.hrVo2max,
      factor: race.factor,
      status: race.status,
    })),
  };
}

/**
 * Enregistre le facteur manuel **du compte connecté**. `null` rétablit le
 * calcul automatique.
 *
 * Rien à invalider en base : la VO₂max n'est nulle part persistée, elle se
 * recalcule à la lecture. Le `revalidatePath` de la Server Action suffit.
 *
 * @throws {InvalidCorrectionFactorError} si la valeur est hors bornes.
 * @throws {AthleteNotFoundError} si le compte n'a pas d'athlète.
 */
export async function saveManualCorrectionFactor(factor: number | null): Promise<void> {
  const validated = validateManualCorrectionFactor(factor);

  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  await db
    .update(athlete)
    .set({ vo2maxCorrectionFactor: validated, updatedAt: new Date() })
    .where(eq(athlete.id, athleteId));
}
