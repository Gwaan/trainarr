import 'server-only';

import { eq } from 'drizzle-orm';

// Le module de calcul directement, et non le tonneau `@/lib/metrics` : ce
// module est chargé par des tests qui doublent le tonneau entier, et une
// constante lue au chargement y disparaîtrait.
import {
  ASCENT_COEF_BOUNDS,
  DEFAULT_ASCENT_COEF_M,
  DEFAULT_DESCENT_COEF_M,
  DESCENT_COEF_BOUNDS,
  type ElevationCorrection,
} from '@/lib/metrics/elevation-correction';

import { AthleteNotFoundError, getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import { athlete } from './db/schema';

/**
 * Le réglage de **correction d'altitude** de la VO₂max — lecture et écriture.
 *
 * Trois colonnes de `athlete`, alignées sur l'écran « Paramètres › Calculs » de
 * Runalyze : la correction est-elle active (oui par défaut, comme chez lui), et
 * les deux coefficients de la formule de Peter Greif (`+2` par mètre monté, `−1`
 * par mètre descendu). Le calcul lui-même vit dans
 * `src/lib/metrics/elevation-correction.ts`, qui porte la source.
 *
 * **Un réglage, pas une mesure** : les trois colonnes sont `NOT NULL` avec un
 * défaut, il y a donc toujours une réponse — d'où un DTO sans `null`, et une
 * lecture qui rend les défauts plutôt que rien quand le compte n'a pas encore
 * d'athlète.
 *
 * **Rien n'est persisté du côté du résultat** : changer un coefficient relit
 * rétroactivement tout l'historique, puisque la VO₂max se recalcule à chaque
 * lecture. C'est exactement pourquoi ces trois-là vivent sur le profil et le
 * dénivelé sur l'activité.
 */

/** Les trois réglages, tels que le panneau de profil les affiche et les soumet. */
export type ElevationCorrectionSettings = {
  enabled: boolean;
  ascentCoefM: number;
  descentCoefM: number;
};

/** Les défauts de Runalyze — ce que voit un compte qui n'a rien réglé. */
export const DEFAULT_ELEVATION_CORRECTION: ElevationCorrectionSettings = {
  enabled: true,
  ascentCoefM: DEFAULT_ASCENT_COEF_M,
  descentCoefM: DEFAULT_DESCENT_COEF_M,
};

/** Un coefficient est hors bornes. `field` désigne le champ fautif. */
export class InvalidElevationCorrectionError extends Error {
  constructor(
    readonly field: 'ascentCoefM' | 'descentCoefM',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidElevationCorrectionError';
  }
}

/**
 * Nombre de décimales conservées sur un coefficient.
 *
 * Deux : c'est un réglage qu'on tourne, pas une constante physique. Au-delà, le
 * chiffre saisi ne se relirait plus dans le champ tel qu'il a été tapé, pour un
 * effet indétectable — un centième de mètre par mètre monté déplace la VO₂max
 * d'un millième de point sur la séance de référence.
 */
const COEF_DECIMALS = 2;

function roundCoef(value: number): number {
  const factor = 10 ** COEF_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Vérifie les bornes et rend le réglage normalisé. Fonction pure, exportée pour
 * les tests.
 *
 * Défense en profondeur : la Server Action valide déjà avec Zod pour rendre un
 * message par champ, mais elle n'est pas la seule porte d'entrée possible du
 * DAL. Les bornes sont celles du module de calcul — source unique.
 *
 * @throws {InvalidElevationCorrectionError} au premier défaut.
 */
export function validateElevationCorrection(
  input: ElevationCorrectionSettings,
): ElevationCorrectionSettings {
  const ascentCoefM = roundCoef(input.ascentCoefM);
  if (
    !Number.isFinite(ascentCoefM) ||
    ascentCoefM < ASCENT_COEF_BOUNDS.min ||
    ascentCoefM > ASCENT_COEF_BOUNDS.max
  ) {
    throw new InvalidElevationCorrectionError(
      'ascentCoefM',
      `Mètres ajoutés par mètre monté : nombre attendu entre ${ASCENT_COEF_BOUNDS.min} et ${ASCENT_COEF_BOUNDS.max}.`,
    );
  }

  const descentCoefM = roundCoef(input.descentCoefM);
  if (
    !Number.isFinite(descentCoefM) ||
    descentCoefM < DESCENT_COEF_BOUNDS.min ||
    descentCoefM > DESCENT_COEF_BOUNDS.max
  ) {
    throw new InvalidElevationCorrectionError(
      'descentCoefM',
      `Mètres ajoutés par mètre descendu : nombre attendu entre ${DESCENT_COEF_BOUNDS.min} et ${DESCENT_COEF_BOUNDS.max} (une descente raccourcit, le nombre est donc négatif ou nul).`,
    );
  }

  return { enabled: input.enabled, ascentCoefM, descentCoefM };
}

/**
 * Les coefficients **à appliquer** pour un athlète désigné, `null` quand il a
 * désactivé la correction.
 *
 * Rend directement ce qu'attend `estimateEffectiveVo2max` : `null` y veut dire
 * « pas de correction », et c'est le seul contrat que l'appelant a à connaître.
 *
 * Reçoit son athlète en paramètre : le détail d'une séance le résout depuis la
 * session, mais rien n'interdit à un service de fond d'en avoir besoin.
 */
export async function getElevationCorrection(
  athleteId: number,
): Promise<ElevationCorrection | null> {
  const settings = await readSettings(athleteId);
  return settings.enabled
    ? { ascentCoefM: settings.ascentCoefM, descentCoefM: settings.descentCoefM }
    : null;
}

/**
 * Le réglage **du compte connecté**, tel que le panneau de profil l'affiche.
 * Les défauts de Runalyze sans session ni athlète : un formulaire vide n'aurait
 * rien à montrer, et ces défauts sont ce que le calcul appliquerait.
 */
export async function getElevationCorrectionSettings(): Promise<ElevationCorrectionSettings> {
  const athleteId = await getCurrentAthleteId();
  return athleteId === null ? DEFAULT_ELEVATION_CORRECTION : readSettings(athleteId);
}

async function readSettings(athleteId: number): Promise<ElevationCorrectionSettings> {
  const rows = await db
    .select({
      enabled: athlete.vo2maxElevationCorrection,
      ascentCoefM: athlete.vo2maxAscentCoefM,
      descentCoefM: athlete.vo2maxDescentCoefM,
    })
    .from(athlete)
    .where(eq(athlete.id, athleteId))
    .limit(1);

  return rows[0] ?? DEFAULT_ELEVATION_CORRECTION;
}

/**
 * Enregistre le réglage **du compte connecté**.
 *
 * Rien à invalider en base : la VO₂max n'est nulle part persistée, elle se
 * recalcule à la lecture. Le `revalidatePath` de la Server Action suffit à faire
 * relire les écrans.
 *
 * @throws {InvalidElevationCorrectionError} si un coefficient est hors bornes.
 * @throws {AthleteNotFoundError} si le compte n'a pas d'athlète.
 */
export async function saveElevationCorrection(
  input: ElevationCorrectionSettings,
): Promise<void> {
  const settings = validateElevationCorrection(input);

  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  await db
    .update(athlete)
    .set({
      vo2maxElevationCorrection: settings.enabled,
      vo2maxAscentCoefM: settings.ascentCoefM,
      vo2maxDescentCoefM: settings.descentCoefM,
      updatedAt: new Date(),
    })
    .where(eq(athlete.id, athleteId));
}
