/**
 * Le **sens** d'une réévaluation de plan : plus de charge, moins de charge, ou
 * ni l'un ni l'autre.
 *
 * Module **pur** — ni base, ni réseau, ni `server-only` : c'est un calcul, et
 * c'est ce qui permet de l'éprouver sur des cas limites qu'une base ne
 * produirait qu'au hasard.
 *
 * ## Le sens se calcule, il ne se déclare pas
 *
 * Ni le coach ni le service qui dépose la proposition n'ont le droit d'annoncer
 * « je baisse la charge » : ce serait une intention, pas un fait. Le sens sort
 * de la comparaison entre ce que le plan **prescrit encore** sur la fenêtre
 * réécrite et ce que la réécriture y **mettrait**, sur les deux seules
 * dimensions dont une athlète ressent la différence :
 *
 * - le **volume total** de la fenêtre, en kilomètres ;
 * - le **volume d'intensité** : les kilomètres des séances de qualité (seuil,
 *   VMA, répétitions), reconnues par le même motif que partout ailleurs dans
 *   l'appli ({@link isIntensityKind}) — deux définitions auraient divergé.
 *
 * Le volume tranche en premier, l'intensité départage les réécritures qui ne
 * touchent pas au kilométrage. Une semaine qui garde ses 42 km mais remplace un
 * footing par une séance de seuil est bien une **hausse** de charge, et la
 * masquer en « ajustement » serait le plus trompeur des trois verdicts.
 *
 * ## Pourquoi une bande de neutralité, et pourquoi ±2 %
 *
 * Une réécriture repose les séances sur une grille : les mêmes kilomètres se
 * répartissent autrement, et les volumes déclarés sont des arrondis de coach
 * (« ~12 km » pour 12,4). Sur une fenêtre de 40 km, 2 % font 800 m — moins que
 * l'arrondi d'**une seule** séance. En deçà, la différence ne vient pas d'une
 * décision d'entraînement mais du calcul lui-même, et l'annoncer comme une
 * baisse ferait douter d'un plan qui n'a pas bougé.
 *
 * La bande est **relative** et non absolue : 800 m d'écart ne disent pas la même
 * chose sur une fenêtre de 40 km que sur une fenêtre de 400.
 */

import { isIntensityKind } from '@/lib/ai/plan-schema';

/**
 * Ce que vaut une fenêtre de séances, en kilomètres.
 *
 * En kilomètres et non en mètres : c'est l'unité de la comparaison affichée à
 * l'athlète, et arrondir une fois ici vaut mieux que trois fois plus loin.
 */
export type PlanRevisionTotals = {
  /** Somme des volumes annoncés de la fenêtre. */
  volumeKm: number;
  /** Part de ce volume portée par des séances de qualité. */
  intensityKm: number;
};

/**
 * Le sens d'une révision — calculé, jamais déclaré.
 *
 * `neutral` n'est pas un aveu d'ignorance : c'est le constat qu'une réécriture
 * change la forme des semaines sans changer la charge qu'elles demandent.
 */
export type PlanRevisionDirection = 'increase' | 'decrease' | 'neutral';

/**
 * La largeur de la bande de neutralité, en part du total d'avant (cf. l'en-tête).
 */
export const PLAN_REVISION_NEUTRAL_BAND = 0.02;

/** Trois décimales : le millimètre du kilomètre, de quoi ne pas traîner de bruit flottant. */
function roundKm(meters: number): number {
  return Math.round(meters) / 1_000;
}

/**
 * Les totaux d'un ensemble de séances.
 *
 * Une séance sans volume déclaré ne compte pour rien — ni dans le total, ni dans
 * l'intensité : elle n'est pas « zéro kilomètre », elle est « on ne sait pas », et
 * la compter à zéro ferait passer un plan mal renseigné pour un plan allégé.
 * C'est la même prudence des deux côtés de la comparaison, donc elle ne penche
 * pas.
 */
export function planRevisionTotals(
  sessions: readonly { kind: string; volumeM: number | null }[],
): PlanRevisionTotals {
  let volumeM = 0;
  let intensityM = 0;

  for (const session of sessions) {
    if (session.volumeM === null) continue;
    volumeM += session.volumeM;
    if (isIntensityKind(session.kind)) intensityM += session.volumeM;
  }

  return { volumeKm: roundKm(volumeM), intensityKm: roundKm(intensityM) };
}

/**
 * Le mouvement d'une dimension : `1` en hausse, `-1` en baisse, `0` dans la
 * bande.
 *
 * Le cas « rien avant » n'a pas de variation relative : on le tranche sur le
 * seul fait qu'il y ait quelque chose après. Zéro des deux côtés est neutre — il
 * ne s'est rien passé sur cette dimension-là, ce n'est pas une baisse.
 */
function move(before: number, after: number, band: number): -1 | 0 | 1 {
  if (before === 0) return after > 0 ? 1 : 0;

  const change = (after - before) / before;
  if (change > band) return 1;
  if (change < -band) return -1;
  return 0;
}

/**
 * Le sens d'une révision : le volume décide, l'intensité départage.
 *
 * @param band largeur de la bande de neutralité — paramétrable pour les tests
 * seulement ; l'appli n'utilise que {@link PLAN_REVISION_NEUTRAL_BAND}.
 */
export function planRevisionDirection(
  before: PlanRevisionTotals,
  after: PlanRevisionTotals,
  band: number = PLAN_REVISION_NEUTRAL_BAND,
): PlanRevisionDirection {
  const volume = move(before.volumeKm, after.volumeKm, band);
  if (volume !== 0) return volume > 0 ? 'increase' : 'decrease';

  const intensity = move(before.intensityKm, after.intensityKm, band);
  if (intensity !== 0) return intensity > 0 ? 'increase' : 'decrease';

  return 'neutral';
}
