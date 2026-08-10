/**
 * Découplage aérobie (dérive cardiaque), méthode Pa:Hr.
 *
 * Source : Joe Friel, « Aerobic Endurance and Decoupling » (joefrielsblog.com,
 * 2011) et l'implémentation qu'en fait TrainingPeaks sous le nom *Pw:HR* /
 * *Pa:HR*. Le principe : sur un effort régulier, l'effort est coupé en deux
 * moitiés de durée égale ; on compare le rapport « allure sur fréquence
 * cardiaque » de chaque moitié. Si le cœur monte à allure constante — ou si
 * l'allure s'effondre à FC constante — le rendement se dégrade et les deux
 * rapports divergent.
 *
 * ```
 * EF        = vitesse moyenne (m/s) / FC moyenne (bpm)
 * découplage = (EF₁ − EF₂) / EF₁ × 100
 * ```
 *
 * Un découplage **positif** signifie une dérive : la seconde moitié coûte plus
 * cher en battements que la première. Friel retient 5 % comme frontière usuelle
 * de l'endurance aérobie « établie » ; ce module ne fait que le calcul et ne
 * porte aucun jugement — le seuil d'interprétation appartient au coach.
 *
 * ## Deux moitiés de temps en mouvement, pas de temps écoulé
 *
 * La coupure se fait sur le temps réellement enregistré (cf.
 * {@link cappedSampleDurationsS}) : une auto-pause de dix minutes au feu rouge
 * ne doit pas décaler la frontière des moitiés, elle n'est du temps d'effort
 * pour personne.
 */

import { cappedSampleDurationsS, weightedMean } from './series';

export type HalfStats = {
  avgSpeedMps: number;
  avgHrBpm: number;
  /** Facteur d'efficience : m/s par battement par minute. */
  ef: number;
};

export type Decoupling = {
  firstHalf: HalfStats;
  secondHalf: HalfStats;
  /** Positif = dérive (l'efficience se dégrade sur la seconde moitié). */
  decouplingPct: number;
};

/**
 * Sous 20 minutes de temps en mouvement, le découplage ne veut rien dire.
 *
 * La dérive cardiaque est un phénomène de dérive thermique et de déshydratation
 * : elle a besoin de temps pour s'installer. Sur dix minutes, les deux moitiés
 * comparées sont surtout séparées par la montée en régime initiale du cœur, qui
 * produit mécaniquement un « découplage » négatif énorme sans rien dire de
 * l'endurance. Le seuil de 20 min est le plancher usuel des analyses Pa:Hr, qui
 * portent normalement sur des sorties longues en aérobie.
 */
const MIN_MOVING_TIME_S = 20 * 60;

/**
 * Couverture minimale de chaque moitié par des échantillons portant **à la fois**
 * vitesse et FC.
 *
 * En deçà, la moyenne d'une moitié ne décrit plus cette moitié mais le fragment
 * où les deux capteurs ont parlé — typiquement une ceinture qui décroche sur la
 * fin, ce qui produirait un découplage entièrement imaginaire. 70 % laisse passer
 * les canaux clairsemés (une FC écrite un point sur quatre couvre bien 100 % du
 * temps, cf. le sous-axe des mesures) et coupe sur un vrai décrochage.
 */
const MIN_HALF_COVERAGE = 0.7;

type Paired = {
  speeds: number[];
  beats: number[];
  durationsS: number[];
  coveredS: number;
};

/**
 * Découplage aérobie de la séance.
 *
 * Retourne `null` — jamais une valeur approchée — quand le calcul n'a pas de
 * sens : moins de {@link MIN_MOVING_TIME_S} de temps en mouvement, ou une moitié
 * couverte à moins de {@link MIN_HALF_COVERAGE} par des points portant vitesse
 * *et* FC. Les points à l'arrêt (vitesse ≤ 0) et les FC nulles sont écartés :
 * ce ne sont pas des mesures d'effort.
 *
 * La frontière entre les deux moitiés tombe sur un échantillon : les deux
 * moitiés sont égales à un échantillon près, pas à la milliseconde.
 */
export function computeDecoupling(
  velocity: readonly (number | null)[],
  heartrate: readonly (number | null)[],
  time: readonly (number | null)[],
): Decoupling | null {
  const count = Math.min(velocity.length, heartrate.length, time.length);

  // Axe des instants exploitables. Seul `time` est dense : c'est lui qui porte
  // le temps en mouvement, indépendamment de ce que les capteurs ont dit.
  const at: number[] = [];
  const instants: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const instant = time[index];
    if (instant === null || !Number.isFinite(instant)) continue;

    at.push(index);
    instants.push(instant);
  }

  const durations = cappedSampleDurationsS(instants);
  let movingTimeS = 0;
  for (const duration of durations) movingTimeS += duration;
  if (movingTimeS < MIN_MOVING_TIME_S) return null;

  // Coupure : premier échantillon où le temps en mouvement cumulé atteint la
  // moitié du total.
  const target = movingTimeS / 2;
  let firstMovingS = 0;
  let cut = at.length;
  for (let index = 0; index < at.length; index += 1) {
    firstMovingS += durations[index];
    if (firstMovingS >= target) {
      cut = index + 1;
      break;
    }
  }
  const secondMovingS = movingTimeS - firstMovingS;
  if (firstMovingS <= 0 || secondMovingS <= 0) return null;

  const first = halfStats(velocity, heartrate, instants, at, 0, cut, firstMovingS);
  const second = halfStats(velocity, heartrate, instants, at, cut, at.length, secondMovingS);
  if (first === null || second === null) return null;

  return {
    firstHalf: first,
    secondHalf: second,
    decouplingPct: ((first.ef - second.ef) / first.ef) * 100,
  };
}

/**
 * Moyennes d'une moitié, pondérées par la durée des échantillons appariés.
 *
 * Les durées sont dérivées du **sous-axe des points appariés** et non de l'axe
 * complet, comme dans `computeHrZones` : une FC écrite un point sur quatre
 * représente 4 s par mesure, et pondérer par les durées de l'axe complet
 * reviendrait à compter les points. C'est aussi ce sous-axe qui mesure la
 * couverture — un décrochage de capteur y creuse un trou que le plafond de
 * `cappedSampleDurationsS` refuse d'attribuer à quiconque.
 */
function halfStats(
  velocity: readonly (number | null)[],
  heartrate: readonly (number | null)[],
  instants: readonly number[],
  at: readonly number[],
  from: number,
  to: number,
  movingTimeS: number,
): HalfStats | null {
  const paired = pairedSamples(velocity, heartrate, instants, at, from, to);
  if (paired.coveredS / movingTimeS < MIN_HALF_COVERAGE) return null;

  const avgSpeedMps = weightedMean(paired.speeds, paired.durationsS, 0, paired.speeds.length);
  const avgHrBpm = weightedMean(paired.beats, paired.durationsS, 0, paired.beats.length);
  if (avgSpeedMps === null || avgHrBpm === null) return null;
  if (avgSpeedMps <= 0 || avgHrBpm <= 0) return null;

  return { avgSpeedMps, avgHrBpm, ef: avgSpeedMps / avgHrBpm };
}

/** Points d'une moitié où la vitesse **et** la FC sont mesurées. */
function pairedSamples(
  velocity: readonly (number | null)[],
  heartrate: readonly (number | null)[],
  instants: readonly number[],
  at: readonly number[],
  from: number,
  to: number,
): Paired {
  const speeds: number[] = [];
  const beats: number[] = [];
  const pairedInstants: number[] = [];

  for (let index = from; index < to; index += 1) {
    const speed = velocity[at[index]];
    const bpm = heartrate[at[index]];
    if (speed === null || !Number.isFinite(speed) || speed <= 0) continue;
    if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) continue;

    speeds.push(speed);
    beats.push(bpm);
    pairedInstants.push(instants[index]);
  }

  const durationsS = cappedSampleDurationsS(pairedInstants);
  let coveredS = 0;
  for (const duration of durationsS) coveredS += duration;

  return { speeds, beats, durationsS, coveredS };
}
