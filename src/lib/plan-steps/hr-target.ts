/**
 * La cible cardiaque d'une **étape**, résolue en battements.
 *
 * Le point où les deux façons de prescrire se rejoignent, et il n'y en a qu'un :
 *
 * - le **rang de zone** (`hrZone`), qui désigne un créneau de la table de
 *   prescription (`lib/metrics/hr-targets`) ;
 * - le **sous-créneau** (`hrPercentMin`/`hrPercentMax`), deux bornes explicites
 *   en pourcentage de FC max, qui disent ce qu'un entier ne peut pas dire — « la
 *   même zone, mais son haut ».
 *
 * La bande **prime** quand elle est là : elle est strictement plus précise que
 * le rang qu'elle accompagne, et c'est bien pour ça qu'elle a été écrite. Le
 * rang reste ce qui **nomme** la zone (« Endurance fondamentale ») et ce à quoi
 * l'affichage retombe faute de FC max.
 *
 * Module **pur**, sans `server-only` : il sert à l'affichage d'une séance comme
 * à sa publication vers intervals.icu, et ces deux-là doivent lire la même
 * cible. Une seconde règle de préséance écrite ailleurs finirait par diverger.
 */

import type { HrZoneAnchor } from '@/lib/metrics/hr-zones';
import {
  hrPercentTargetBpm,
  hrZoneTargetBpm,
  type HrPercentBand,
  type HrTargetBpm,
} from '@/lib/metrics/hr-targets';

import type { PlanStep } from './schema';

/**
 * Le sous-créneau d'une étape, `null` quand elle n'en porte pas.
 *
 * `typeof` et non `!== null`, et c'est la raison d'être de cette fonction : les
 * plans écrits avant l'existence de ces deux clés les ont **absentes** de leur
 * `jsonb`, donc à `undefined` une fois relus. Un test `!== null` les prendrait
 * pour des bornes et rendrait `NaN` de battements. Les deux bornes sont exigées
 * ensemble — le schéma l'impose à l'écriture, cette lecture ne le suppose pas.
 */
export function stepHrPercentBand(step: PlanStep): HrPercentBand | null {
  const { hrPercentMin, hrPercentMax } = step;
  if (typeof hrPercentMin !== 'number' || typeof hrPercentMax !== 'number') return null;

  return { minPercentOfMax: hrPercentMin, maxPercentOfMax: hrPercentMax };
}

/**
 * La cible cardiaque de l'étape en battements — `null` quand elle n'en porte
 * pas, ou que rien ne permet de la calculer (aucune référence au profil, zone
 * sans créneau déclaré).
 *
 * @param anchor la référence du **profil** — FC seuil si l'athlète en a adopté
 * une, FC max sinon : c'est elle qui prescrit. La conversion vers un autre
 * référentiel (le pourcentage attendu par intervals.icu) se fait après, et
 * depuis ces battements-là.
 */
export function stepHrTargetBpm(
  step: PlanStep,
  anchor: HrZoneAnchor | null,
): HrTargetBpm | null {
  const band = stepHrPercentBand(step);
  if (band !== null) return hrPercentTargetBpm(band, anchor);

  return step.hrZone === null ? null : hrZoneTargetBpm(step.hrZone, anchor);
}
