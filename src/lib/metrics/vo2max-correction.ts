/**
 * Facteur correctif individuel de la VO₂max effective — la calibration de
 * Runalyze sur les **courses déclarées**.
 *
 * ## Méthode, et sa source
 *
 * Relevée dans le code de Runalyze (branche `support/4.3.x`), comme le reste de
 * l'estimation :
 *
 *  - `inc/core/Calculation/JD/VO2maxCorrector.php` /
 *    `src/CoreBundle/Bridge/…/VO2maxCorrectionFactorCalculation`
 *  - `src/CoreBundle/Entity/RaceresultRepository::getEffectiveVO2maxCorrectionFactor()`
 *    → https://github.com/Runalyze/Runalyze/blob/support/4.3.x/src/CoreBundle/Entity/RaceresultRepository.php
 *
 * ```
 * facteur = max( VO2max_par_le_temps / VO2max_par_la_FC )   sur les courses
 * facteur = 1.0                                            s'il n'y en a aucune
 * ```
 *
 *  - **VO₂max par le temps** : {@link estimateVdot} (Daniels & Gilbert, 1979).
 *    Sa seconde régression déduit l'intensité de la seule durée, en postulant un
 *    effort mené jusqu'à épuisement — c'est précisément ce qu'est une course, et
 *    c'est pour ça que le facteur ne se calibre que sur des courses.
 *  - **VO₂max par la FC** : {@link estimateEffectiveVo2max}, sur la **même**
 *    course. Elle est appelée ici **sans facteur correctif**, évidemment : c'est
 *    le dénominateur du rapport qu'on cherche, l'y injecter rendrait le calcul
 *    circulaire.
 *
 * ## La correction d'altitude entre des DEUX côtés du rapport
 *
 * Le dénivelé de la course est passé au numérateur **comme** au dénominateur.
 * C'est la seule façon qu'il s'annule : les deux estimations partent de la même
 * distance équivalente de Greif, le terrain déplace les deux dans le même sens
 * et le rapport n'exprime plus que ce qu'il est censé exprimer — l'écart entre
 * la régression `%FCmax ↔ %vVO2max` de population et celle de l'athlète.
 *
 * Corrigé d'un seul côté (ce que faisait la première version : le dénivelé
 * n'allait qu'au dénominateur), le terrain **entrait** dans le rapport au lieu
 * de s'y annuler, et le biais était systématique. Chiffré sur un trail de
 * 21,1 km en 2 h, D+ 600 / D− 600, FC moyenne 160 pour une FC max de 195 :
 * numérateur 37,8 contre dénominateur 44,3 → **0,853** quand les deux sont
 * corrigés, contre 36,4 / 44,3 → **0,823** quand seul le dénominateur l'est.
 * 3,4 % d'écart, soit ≈ 1,3 point de VO₂max à 40 — et toujours vers le bas :
 * une athlète qui ne déclarerait que du trail se serait retrouvée sous-recalée,
 * exactement le défaut que ce module existe pour corriger. C'est aussi ce que
 * fait Runalyze, dont l'`estimateVO2maxWithElevation` fait face à
 * l'`estimateVO2maxByHeartRateWithElevation`.
 *
 * **Nuance à ne pas perdre** : le seuil de représentativité
 * (`MIN_EFFORT_DISTANCE_M`) juge des deux côtés la distance **réellement
 * courue**, jamais l'équivalente — 1 400 m de côte ne deviennent pas un effort
 * représentatif parce que Greif les compte 2 600.
 *
 * ## Le sens de l'écart
 *
 * Chez un athlète dont la FC tourne haut pour l'effort produit, l'estimation par
 * la FC **sous-lit** la performance et le facteur dépasse 1 ; chez qui a une FC
 * basse, l'inverse. Mesuré sur l'athlète de référence : Trainarr lisait 34,6 là
 * où Runalyze affichait 39 sur la séance du 15/08/2026 — un demi-point venait de
 * la correction d'altitude, **tout le reste (≈ 1,11) est ce facteur**.
 *
 * ## Le maximum, et ce qu'il implique
 *
 * Runalyze retient le **maximum** des rapports, pas leur moyenne : la meilleure
 * course est celle qui dit le mieux ce dont l'athlète est capable, les autres
 * ayant pu être courues en gestion, par 30 °C ou avec un dossard de sortie
 * longue. La conséquence est qu'**une seule course aberrante gouverne tout** :
 * d'où les bornes ci-dessous, et d'où le choix d'**écarter** une course hors
 * bornes plutôt que de ramener son rapport à la borne (cf.
 * {@link VO2MAX_CORRECTION_FACTOR_BOUNDS}).
 *
 * ## Ce que le module refuse de faire
 *
 * Une course sans FC exploitable **ne calibre pas** : il n'y a pas de
 * dénominateur, et on n'en approxime pas un. Elle reste une course — le résultat
 * distingue « aucune course déclarée » de « des courses, mais aucune avec FC »,
 * parce que les deux appellent des réponses différentes à l'écran.
 */

import { type ActivityElevation, type ElevationCorrection } from './elevation-correction';
import { estimateVdot } from './vdot';
import { NEUTRAL_VO2MAX_CORRECTION_FACTOR, estimateEffectiveVo2max } from './vo2max';

export { NEUTRAL_VO2MAX_CORRECTION_FACTOR };

/**
 * Bornes du facteur, **choisies ici** — Runalyze n'en pose aucune.
 *
 * Ce ne sont pas des bornes physiologiques mais des bornes de **crédibilité**
 * du recalage. Le facteur corrige l'écart entre la régression de population
 * `%FCmax ↔ %vVO2max` et la relation propre à l'athlète. Ordre de grandeur de
 * cet écart, calculé sur la formule elle-même :
 *
 *  - un décalage individuel de **5 points de %FCmax** (déjà large) déplace la
 *    fraction de vitesse de `exp(0.05 / 0.68725) = 1,076`, soit ≈ **9,4 %** sur
 *    la VO₂max une fois passé le coût en oxygène (mesuré à 300 m/min) ;
 *  - une FC max de profil fausse de **5 bpm** sur 195 en ajoute ≈ **4 %**.
 *
 * Un biais individuel réel tient donc dans ±15 % environ ; le 1,128 mesuré sur
 * l'athlète de référence s'y range confortablement. Les bornes retenues,
 * **[0.70, 1.40]**, laissent le double de cette marge — elles ne jugent pas un
 * coureur, elles attrapent une donnée qui n'en décrit pas un. Elles sont
 * symétriques *multiplicativement* (1 / 1,4 = 0,714 ≈ 0,70), comme il se doit
 * pour un rapport : un facteur et son inverse doivent être également suspects.
 *
 * Ce qu'elles attrapent en pratique, et qui n'est pas théorique : une course
 * dont la ceinture a lu 120 bpm au lieu de 170 (10 km en 45:00 → rapport 0,55),
 * ou un chrono qui ne décrit pas l'effort couru. Ce qu'elles ne peuvent pas
 * attraper — un chrono optimiste de cinq minutes — n'a pas à l'être : c'est une
 * déclaration de l'athlète, pas une mesure.
 *
 * **Hors bornes ⇒ la course est écartée du maximum, pas ramenée à la borne.**
 * Avec la sémantique du maximum, ramener un rapport de 3,0 à 1,40 le laisserait
 * dominer toutes les courses saines ; l'écarter rend la main aux autres. Et une
 * course écartée est **dite** telle quelle dans le résultat, jamais tue.
 */
export const VO2MAX_CORRECTION_FACTOR_BOUNDS = { min: 0.7, max: 1.4 } as const;

/** Le facteur est-il dans la plage crédible ? */
export function isPlausibleCorrectionFactor(factor: number): boolean {
  return (
    Number.isFinite(factor) &&
    factor >= VO2MAX_CORRECTION_FACTOR_BOUNDS.min &&
    factor <= VO2MAX_CORRECTION_FACTOR_BOUNDS.max
  );
}

/** Une course déclarée, réduite à ce qui décide de sa contribution. */
export type RaceCalibrationInput = {
  /** Identifiant de la course — opaque ici, il sert à désigner celle qui calibre. */
  raceId: number;
  /** Jour civil `YYYY-MM-DD` de l'épreuve. */
  racedOn: string;
  /** Nom de l'épreuve, `null` si l'athlète n'en a pas saisi. */
  name: string | null;
  /** Distance **officielle**, en mètres — celle qui fait foi. */
  distanceM: number;
  /** Chrono **officiel**, en secondes — celui qui fait foi. */
  timeS: number;
  /**
   * FC moyenne de la course, lue sur l'activité liée. `null` = pas de montre,
   * ou pas de ceinture : la course ne calibre pas.
   */
  avgHrBpm: number | null;
  /**
   * Dénivelé de l'activité liée. `null` (ou absent) = inconnu, la correction
   * d'altitude ne s'applique alors pas — ce qui n'est pas un terrain plat.
   *
   * Il sert **aux deux** estimations comparées : c'est ainsi qu'il quitte leur
   * rapport (cf. l'en-tête du module).
   */
  elevation?: ActivityElevation | null;
};

/**
 * Le sort d'une course dans la calibration.
 *
 * - `eligible` : les deux VO₂max sont calculables et leur rapport est crédible.
 *   La course entre dans le maximum (elle ne le remporte pas forcément).
 * - `no-heart-rate` : aucune FC moyenne — pas de dénominateur, rien à inventer.
 * - `not-computable` : une des deux estimations a refusé de se prononcer
 *   (effort trop court, FC max de profil absente, rapport de FC aberrant,
 *   VO₂max hors de [20, 90]…).
 * - `out-of-bounds` : le rapport est calculé mais sort de
 *   {@link VO2MAX_CORRECTION_FACTOR_BOUNDS} — la course est écartée, et son
 *   rapport reste lisible pour qu'on puisse comprendre pourquoi.
 */
export type RaceCalibrationStatus =
  | 'eligible'
  | 'no-heart-rate'
  | 'not-computable'
  | 'out-of-bounds';

/** Une course, et ce qu'elle dit du facteur — de quoi l'expliquer à l'écran. */
export type RaceCalibration = {
  raceId: number;
  racedOn: string;
  name: string | null;
  distanceM: number;
  timeS: number;
  /**
   * VO₂max déduite du chrono (Daniels & Gilbert), **correction d'altitude
   * comprise** comme sa jumelle. `null` hors domaine.
   */
  timeVo2max: number | null;
  /**
   * VO₂max déduite de la FC (méthode Runalyze), **non recalée** et corrigée du
   * même dénivelé que {@link RaceCalibration.timeVo2max}.
   */
  hrVo2max: number | null;
  /** Le rapport des deux, `null` quand l'un des termes manque. */
  factor: number | null;
  status: RaceCalibrationStatus;
};

/**
 * Pourquoi le facteur automatique vaut 1. Trois causes, trois phrases
 * différentes à l'écran — « déclare une course » et « ta course n'a pas de FC »
 * n'appellent pas le même geste.
 */
export type Vo2maxCorrectionUnavailable =
  | 'no-race'
  | 'no-race-with-heart-rate'
  | 'no-usable-race';

/** Le facteur calibré sur les courses, et tout ce qui permet de le justifier. */
export type AutomaticVo2maxCorrection = {
  /** Le maximum des rapports crédibles, ou 1 s'il n'y en a aucun. */
  factor: number;
  /** La course qui a produit ce maximum, `null` quand le facteur est neutre. */
  calibratedOn: RaceCalibration | null;
  /** Renseigné **exactement quand** `calibratedOn` est `null`. */
  unavailable: Vo2maxCorrectionUnavailable | null;
  /** Toutes les courses évaluées, dans l'ordre reçu, avec leur verdict. */
  races: RaceCalibration[];
};

/** Ce qui s'applique réellement, et d'où ça vient. */
export type Vo2maxCorrection = {
  /** Le facteur appliqué à chaque VO₂max effective. */
  factor: number;
  /**
   * - `manual` : l'athlète a imposé une valeur, elle prime (comme chez
   *   Runalyze, dont le champ vide vaut « automatique ») ;
   * - `race` : le maximum calibré sur une course ;
   * - `default` : le neutre, faute de course exploitable.
   */
  source: 'manual' | 'race' | 'default';
  /** La valeur imposée, `null` en mode automatique. */
  manualFactor: number | null;
  /**
   * Le calcul automatique, **toujours présent** — même quand un facteur manuel
   * le remplace : sans lui, l'écran de réglage ne pourrait pas montrer ce que
   * l'athlète est en train d'écraser.
   */
  automatic: AutomaticVo2maxCorrection;
};

export type Vo2maxCorrectionInput = {
  races: readonly RaceCalibrationInput[];
  /** FC max du profil — sans elle, aucune course ne produit de dénominateur. */
  maxHrBpm: number | null;
  /** Les coefficients de Greif, `null` si la correction d'altitude est coupée. */
  elevationCorrection?: ElevationCorrection | null;
  /** Le facteur imposé au profil, `null` = automatique. */
  manualFactor?: number | null;
};

/**
 * Le facteur correctif à appliquer, et de quoi l'expliquer.
 *
 * Déterministe et pure. Les courses sont évaluées une à une (le résultat les
 * rend toutes, avec leur verdict), puis le **maximum** des rapports crédibles
 * l'emporte — ou le neutre, faute de candidat. Un facteur manuel exploitable
 * prend le pas sur tout ça sans effacer le calcul, qui reste lisible.
 */
export function computeVo2maxCorrection(input: Vo2maxCorrectionInput): Vo2maxCorrection {
  const elevationCorrection = input.elevationCorrection ?? null;
  const races = input.races.map((race) =>
    calibrateRace(race, input.maxHrBpm, elevationCorrection),
  );

  const automatic = automaticCorrection(races);
  const manualFactor = usableManualFactor(input.manualFactor);

  return manualFactor === null
    ? {
        factor: automatic.factor,
        source: automatic.calibratedOn === null ? 'default' : 'race',
        manualFactor: null,
        automatic,
      }
    : { factor: manualFactor, source: 'manual', manualFactor, automatic };
}

/**
 * Le facteur manuel **applicable**, `null` quand il n'y en a pas.
 *
 * Une valeur hors bornes retombe sur l'automatique plutôt que d'être appliquée
 * ou ramenée à la borne : le DAL refuse déjà de l'écrire, donc une telle valeur
 * en base n'a pas de sens — mieux vaut le calcul que la donnée douteuse. Rendre
 * `null` la fait aussi apparaître comme « pas de facteur manuel » à l'écran, ce
 * qui est la lecture juste : elle ne s'applique pas.
 */
function usableManualFactor(factor: number | null | undefined): number | null {
  if (typeof factor !== 'number') return null;
  return isPlausibleCorrectionFactor(factor) ? factor : null;
}

/** Le maximum des rapports crédibles, ou le neutre et sa raison. */
function automaticCorrection(races: RaceCalibration[]): AutomaticVo2maxCorrection {
  let best: RaceCalibration | null = null;
  let bestFactor = Number.NEGATIVE_INFINITY;

  for (const race of races) {
    if (race.status !== 'eligible' || race.factor === null) continue;
    if (race.factor > bestFactor) {
      best = race;
      bestFactor = race.factor;
    }
  }

  return best === null
    ? {
        factor: NEUTRAL_VO2MAX_CORRECTION_FACTOR,
        calibratedOn: null,
        unavailable: unavailableReason(races),
        races,
      }
    : { factor: bestFactor, calibratedOn: best, unavailable: null, races };
}

/** Pourquoi aucune course n'a calibré — la cause la plus explicative d'abord. */
function unavailableReason(races: readonly RaceCalibration[]): Vo2maxCorrectionUnavailable {
  if (races.length === 0) return 'no-race';
  if (races.every((race) => race.status === 'no-heart-rate')) return 'no-race-with-heart-rate';
  return 'no-usable-race';
}

/**
 * Les deux VO₂max d'une course et leur rapport.
 *
 * Les **valeurs officielles** (distance, chrono) servent aux deux estimations :
 * elles décrivent la même course, et mélanger le chrono de la puce avec la
 * distance de la montre ferait entrer une erreur de mesure dans un rapport
 * censé n'exprimer qu'un biais cardiaque. De l'activité liée ne viennent que la
 * FC moyenne et le dénivelé — deux mesures qu'aucun bulletin d'arrivée ne porte.
 *
 * **Le dénivelé et ses coefficients vont aux deux estimations**, et c'est ce qui
 * les fait s'annuler dans le rapport — cf. l'en-tête du module, qui chiffre ce
 * que coûtait de ne les donner qu'au dénominateur.
 */
function calibrateRace(
  race: RaceCalibrationInput,
  maxHrBpm: number | null,
  elevationCorrection: ElevationCorrection | null,
): RaceCalibration {
  const identity = {
    raceId: race.raceId,
    racedOn: race.racedOn,
    name: race.name,
    distanceM: race.distanceM,
    timeS: race.timeS,
  };

  // Même terrain qu'au dénominateur : c'est ce qui le fait sortir du rapport.
  const timeVo2max = estimateVdot({
    distanceM: race.distanceM,
    movingTimeS: race.timeS,
    elevation: race.elevation ?? null,
    elevationCorrection,
  });

  if (race.avgHrBpm === null) {
    return { ...identity, timeVo2max, hrVo2max: null, factor: null, status: 'no-heart-rate' };
  }

  // Sans `correctionFactor` : c'est le dénominateur du rapport recherché.
  const hrVo2max = estimateEffectiveVo2max({
    distanceM: race.distanceM,
    movingTimeS: race.timeS,
    avgHrBpm: race.avgHrBpm,
    maxHrBpm,
    elevation: race.elevation ?? null,
    elevationCorrection,
  });

  if (timeVo2max === null || hrVo2max === null) {
    return { ...identity, timeVo2max, hrVo2max, factor: null, status: 'not-computable' };
  }

  const factor = timeVo2max / hrVo2max;

  return {
    ...identity,
    timeVo2max,
    hrVo2max,
    factor,
    status: isPlausibleCorrectionFactor(factor) ? 'eligible' : 'out-of-bounds',
  };
}
