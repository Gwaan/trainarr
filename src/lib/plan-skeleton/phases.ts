/**
 * La **périodisation** d'un plan : quelle phase d'entraînement porte chaque
 * semaine.
 *
 * Module **pur** — ni base, ni réseau, ni `server-only` : c'est du découpage
 * d'entiers, et il se teste tel quel.
 *
 * ## Phase et volume sont deux choses, et il ne faut jamais les confondre
 *
 * `weeklyVolumeTargets` étiquette déjà chaque semaine (`build`, `cutback`,
 * `taper`, `race`, `partial`), mais cette étiquette-là répond à « combien de
 * kilomètres ». La phase répond à « quelle qualité » — et les deux sont
 * orthogonales : une semaine allégée posée au milieu d'un bloc de développement
 * reste une semaine de développement, elle en fait juste moins. Fusionner les
 * deux notions ferait basculer la nature des séances à chaque respiration du
 * plan, ce qui est exactement l'inverse d'une périodisation.
 *
 * ## Pourquoi la segmentation recopie celle des volumes
 *
 * Les bornes ci-dessous (`firstFull`, `taper`, `lastBuild`, et jusqu'à l'ordre
 * dans lequel les tranches s'écrasent) sont celles de {@link
 * weeklyVolumeTargets}, à la ligne près. C'est délibéré : si la fenêtre de
 * développement des phases débordait d'une semaine sur celle des volumes, une
 * semaine d'affûtage se verrait attribuer une séance de développement, ou une
 * semaine de développement se retrouverait sans qualité. Deux arithmétiques pour
 * un même découpage finissent toujours par diverger ; il n'y en a qu'une, elle
 * est recopiée telle quelle et un test la confronte aux `kind` des cibles.
 */

import { taperWeekCount, type PlanRaceGoal } from '@/lib/ai/plan-schema';

/**
 * Ce qu'une semaine du plan est, du point de vue de l'entraînement.
 *
 * - `partial` : la première semaine, déjà entamée. On ne sait pas ce qui y a été
 *   couru avant le départ, donc on n'y programme aucune qualité.
 * - `base` : construction aérobie. La qualité y est neuve et courte (côtes,
 *   lignes droites) — pas de travail long à haute intensité sur un socle qui
 *   n'est pas encore posé.
 * - `build` : développement. C'est là que les qualités propres à la distance
 *   d'objectif se travaillent.
 * - `specific` : spécificité. Les séances se rapprochent de l'allure et des
 *   contraintes de la course visée.
 * - `taper` : affûtage. On garde de l'intensité, on retire du volume.
 * - `race` : la semaine de la course. Ce n'est pas un lieu d'entraînement.
 */
export type PlanPhase = 'partial' | 'base' | 'build' | 'specific' | 'taper' | 'race';

/** Une phase de la fenêtre de développement — ni entamée, ni affûtée, ni courue. */
type DevelopmentPhase = Extract<PlanPhase, 'base' | 'build' | 'specific'>;

export type PlanPhasesParams = {
  /** Nombre de semaines du plan, la première (parfois entamée) comprise. */
  weeks: number;
  /** Jour ISO à partir duquel la première semaine porte des séances : 1 = lundi. */
  firstWeekFromDay: number;
  /** L'objectif, quand c'est une course : elle impose un affûtage et un jour J. */
  race: PlanRaceGoal | null;
};

/**
 * La répartition de la fenêtre de développement entre ses trois phases.
 *
 * 30 / 40 / 30 : le bloc de développement est le plus long parce que c'est celui
 * qui fait progresser, la base et la spécificité l'encadrent à parts égales. Ce
 * sont des ordres de grandeur de la littérature (Lydiard pour la base longue,
 * Daniels et Pfitzinger pour la spécificité terminale), pas des constantes
 * physiologiques : ce qui compte est que les trois existent et se succèdent dans
 * cet ordre.
 */
const DEVELOPMENT_SHARES = { base: 0.3, build: 0.4, specific: 0.3 } as const;

/**
 * En deçà de ce nombre de semaines, un plan n'a pas de temps à donner à la base.
 *
 * Sur sept semaines, 30 % de base valent deux semaines prises sur les quatre qui
 * font réellement progresser — pour une athlète qui a une échéance, c'est du
 * temps perdu. La base est alors ramenée à une semaine de mise en route, et tout
 * le reste va au développement et à la spécificité.
 */
const SHORT_PLAN_WEEKS = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function repeatPhase(phase: DevelopmentPhase, count: number): DevelopmentPhase[] {
  return Array.from({ length: count }, () => phase);
}

/**
 * La fenêtre de développement découpée en base / build / spécifique, dans
 * l'ordre.
 *
 * Les tout petits comptes sont traités à part, et ce n'est pas de la défense :
 * une seule semaine de développement n'est ni une base ni une spécificité, c'est
 * du développement ; deux semaines se partagent entre développement et
 * spécificité, parce que la spécificité est ce qui manque le plus quand une
 * course approche. Poser une base d'une semaine sur un plan qui n'en compte que
 * deux reviendrait à n'entraîner qu'une semaine sur deux.
 *
 * Au-delà, la répartition est **cumulative** — la base est prélevée d'abord, le
 * reste se partage à 4 contre 3 — plutôt que trois arrondis indépendants qui ne
 * retomberaient pas sur le compte. Chaque phase garde au moins une semaine :
 * c'est ce que les bornes garantissent, et une phase absente au milieu d'une
 * progression est une progression cassée.
 */
function developmentPhases(count: number, isShortPlan: boolean): DevelopmentPhase[] {
  if (count <= 0) return [];
  if (count === 1) return ['build'];
  if (count === 2) return ['build', 'specific'];

  const base = isShortPlan ? 1 : clamp(Math.round(count * DEVELOPMENT_SHARES.base), 1, count - 2);
  const rest = count - base;
  const buildShareOfRest =
    DEVELOPMENT_SHARES.build / (DEVELOPMENT_SHARES.build + DEVELOPMENT_SHARES.specific);
  const build = clamp(Math.round(rest * buildShareOfRest), 1, rest - 1);

  return [
    ...repeatPhase('base', base),
    ...repeatPhase('build', build),
    ...repeatPhase('specific', rest - build),
  ];
}

/**
 * La phase de chaque semaine du plan, dans l'ordre.
 *
 * L'ordre d'écriture est celui de {@link weeklyVolumeTargets} et il compte : la
 * fenêtre de développement se pose d'abord, l'affûtage l'écrase par la fin, la
 * semaine entamée par le début. Sur un plan trop court pour porter à la fois une
 * semaine entamée, du développement et un affûtage, c'est ce dernier passage qui
 * décide — et c'est le bon, puisque c'est celui que les volumes appliqueront.
 */
export function planPhases(params: PlanPhasesParams): PlanPhase[] {
  const { weeks, firstWeekFromDay, race } = params;
  if (weeks <= 0) return [];

  const firstFull = firstWeekFromDay > 1 ? 1 : 0;
  const taper = taperWeekCount(weeks, race);
  const lastBuild = weeks - taper - 1;

  const phases = new Array<PlanPhase>(weeks).fill('build');

  developmentPhases(lastBuild - firstFull + 1, weeks < SHORT_PLAN_WEEKS).forEach(
    (phase, offset) => {
      phases[firstFull + offset] = phase;
    },
  );

  // La course occupe la dernière semaine, l'affûtage celles qui la précèdent.
  const taperFrom = weeks - taper;
  for (let index = Math.max(taperFrom, firstFull); index < weeks; index += 1) {
    phases[index] = index === weeks - 1 ? 'race' : 'taper';
  }

  if (firstFull === 1) phases[0] = 'partial';

  return phases;
}
