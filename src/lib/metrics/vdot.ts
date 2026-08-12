/**
 * VDOT — VO2max « effectif » déduit d'une performance de course.
 *
 * Source : Daniels J & Gilbert J, *Oxygen Power: Performance Tables for
 * Distance Runners*, 1979. Deux régressions :
 *  - coût en oxygène de la course, en ml/kg/min, à la vitesse v (m/min) :
 *    VO2 = −4.60 + 0.182258·v + 0.000104·v²
 *  - fraction de VO2max soutenable sur une durée t (min) :
 *    pct = 0.8 + 0.1894393·e^(−0.012778·t) + 0.2989558·e^(−0.1932605·t)
 * VDOT = VO2 / pct.
 *
 * **Ce module suppose un effort de course MAXIMAL** (course, test, contre-la-
 * montre) : la seconde régression déduit l'intensité de la seule durée, en
 * postulant que l'athlète a donné tout ce qu'il pouvait tenir sur ce temps.
 * Appliquée à un footing, elle sous-estime massivement la VO2max — c'est
 * `estimateEffectiveVo2max` (`./vo2max`), corrigée par la fréquence cardiaque,
 * qui vaut pour une séance quelconque.
 *
 * La seconde moitié du module inverse ces régressions pour produire la table
 * d'allures d'entraînement E/M/T/I/R à partir d'un chrono de course.
 */

export type EffortInput = { distanceM: number; movingTimeS: number };

/**
 * Bornes de validité du modèle. En deçà, la performance est dominée par la
 * filière anaérobie et la régression de Daniels & Gilbert ne s'applique plus.
 *
 * Partagées avec `./vo2max`, qui écarte les mêmes efforts trop courts pour être
 * représentatifs (échauffement isolé, tour de piste enregistré à part).
 */
export const MIN_EFFORT_DISTANCE_M = 1500;
export const MIN_EFFORT_DURATION_MIN = 4;

/**
 * Garde-fou physiologique : hors de cette plage, le résultat est une aberration.
 * Partagé avec `./vo2max`.
 */
export const MIN_PLAUSIBLE_VO2MAX = 20;
export const MAX_PLAUSIBLE_VO2MAX = 90;

/**
 * Coût en oxygène de la course à la vitesse `velocityMPerMin`, en ml/kg/min.
 * Première régression de Daniels & Gilbert. À la vitesse associée à VO2max
 * (vVO2max), ce coût *est* la VO2max — c'est ce qu'exploite `./vo2max`.
 */
export function oxygenCostAtVelocity(velocityMPerMin: number): number {
  return (
    -4.6 + 0.182258 * velocityMPerMin + 0.000104 * velocityMPerMin * velocityMPerMin
  );
}

/**
 * Fraction de VO2max qu'un coureur peut soutenir pendant `durationMin` minutes.
 * Seconde régression de Daniels & Gilbert — n'a de sens que sur un effort mené
 * jusqu'à épuisement.
 */
export function sustainableFractionOverDuration(durationMin: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * durationMin) +
    0.2989558 * Math.exp(-0.1932605 * durationMin)
  );
}

/**
 * VDOT (Daniels & Gilbert) d'une **performance maximale**. Renvoie `null` si
 * l'effort est hors du domaine de validité du modèle (< 1500 m ou < 4 min), si
 * les entrées sont nulles, négatives ou non finies, ou si le VDOT obtenu sort de
 * la plage plausible.
 */
export function estimateVdot(effort: EffortInput): number | null {
  const { distanceM, movingTimeS } = effort;

  if (!Number.isFinite(distanceM) || distanceM <= 0) return null;
  if (!Number.isFinite(movingTimeS) || movingTimeS <= 0) return null;
  if (distanceM < MIN_EFFORT_DISTANCE_M) return null;

  const durationMin = movingTimeS / 60;
  if (durationMin < MIN_EFFORT_DURATION_MIN) return null;

  const velocityMPerMin = distanceM / durationMin;
  const vdot =
    oxygenCostAtVelocity(velocityMPerMin) / sustainableFractionOverDuration(durationMin);

  if (!Number.isFinite(vdot)) return null;
  if (vdot < MIN_PLAUSIBLE_VO2MAX || vdot > MAX_PLAUSIBLE_VO2MAX) return null;

  return vdot;
}

/* -------------------------------------------------------------------------- */
/*  Allures d'entraînement (méthode Daniels)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Distances de référence sur lesquelles un chrono sert d'ancre.
 * Semi et marathon aux distances officielles World Athletics.
 */
export const REFERENCE_DISTANCES = {
  '5k': 5_000,
  '10k': 10_000,
  half: 21_097.5,
  marathon: 42_195,
} as const;

export type ReferenceDistance = keyof typeof REFERENCE_DISTANCES;

/**
 * Chrono rejeté : hors du domaine où la vitesse décrit une course à pied.
 * Erreur nommée plutôt que `null` — contrairement à `estimateVdot` qui digère
 * des séances quelconques, ici la saisie est explicite et une valeur aberrante
 * est une faute de frappe à signaler, pas une donnée manquante.
 */
export class InvalidRacePerformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRacePerformanceError';
  }
}

/**
 * Bornes de vitesse moyenne admises pour un chrono de course, en m/s. Larges à
 * dessein : il s'agit d'attraper la saisie qui ne décrit pas une course (un
 * 5 km en 8 min, un 5 km en 2 h), pas de juger le niveau — c'est la plage de
 * VDOT plausible, appliquée plus bas, qui tranche la plausibilité physiologique.
 *
 * Repères : 8 m/s dépasse le record du monde du 5 000 m (≈ 6,6 m/s) ; 1,6 m/s,
 * c'est 10:25/km, l'allure d'une marche soutenue — soit un marathon en 7 h 20 ou
 * un semi en 3 h 40.
 *
 * **Le plancher valait 2 m/s** : il refusait un marathon au-delà de 5 h 51 et un
 * semi au-delà de 2 h 55, deux chronos de finisher parfaitement réels. Le
 * commentaire qui le justifiait était faux par-dessus le marché — 2 m/s, c'est
 * 8:20/km, plus **rapide** qu'une marche rapide, pas plus lent.
 *
 * Ces bornes sont aujourd'hui plus larges que celle du VDOT sur toutes les
 * distances usuelles (elle refuse déjà un marathon au-delà de ~6 h 36, un semi
 * au-delà de ~3 h 15). Elles restent en tête parce qu'elles nomment la faute —
 * « ce chrono n'est pas une course » — là où l'autre n'en nomme que la
 * conséquence.
 */
export const MIN_RACE_SPEED_M_PER_S = 1.6;
export const MAX_RACE_SPEED_M_PER_S = 8;

/**
 * Fractions de VDOT définissant chaque créneau d'entraînement **dont la
 * fraction publiée ne dépend pas du niveau**, en pourcentage de VO2max. `fast`
 * est la borne haute d'intensité (donc l'allure la plus rapide), `slow` la
 * borne basse. Le créneau R fait exception et vit dans
 * {@link repetitionFractionsAtVdot}.
 *
 * Sources des créneaux publiés (E 59-74 %, M 75-84 %, T 83-88 %, I 95-100 %,
 * R ≥ 105 %) :
 *  - https://www.brenoamelo.com/blog/jack-daniels-vdot-explained
 *  - https://therunninggenie.com/vdot-calculator
 *
 * **Le chevauchement M/T est voulu** : `marathon.fast` (84 %) est plus intense
 * que `threshold.slow` (83 %), les deux créneaux se recouvrent donc sur un point
 * de pourcentage. Ce n'est pas une coquille mais l'héritage fidèle des bandes
 * publiées (M 75-84 %, T 83-88 %), qui se recouvrent elles aussi : l'allure
 * marathon d'un coureur et son seuil ne sont pas séparés par une frontière
 * nette. Les resserrer inventerait une limite que Daniels ne pose pas — le test
 * d'ordonnancement fige ce recouvrement pour qu'un futur resserrement soit un
 * choix conscient.
 *
 * **Calibrage** : ces créneaux publiés décrivent des intensités
 * physiologiques, pas la colonne d'allures des tables. Reproduits tels quels,
 * ils ratent la table sur E (borne rapide à 74 % → 5:51/km pour VDOT 40, là où
 * la table imprime 6:07/km). Les bornes ci-dessous sont donc calées sur les
 * allures publiées elles-mêmes, vérifiées sur deux lignes de la table
 * (VDOT 40 et VDOT 50, cf. `vdot.test.ts`) :
 *  - E : la colonne E vaut 9:50-10:52/mi à VDOT 40 et 8:14-9:07/mi à VDOT 50,
 *    soit 70,0 % et 61,6-61,7 % aux deux niveaux — d'où 62-70 %.
 *  - M/T/I : les créneaux publiés encadrent les allures de la table
 *    (allure marathon ≈ 81 %, T ≈ 88 %, I ≈ 98 %).
 *
 * Ces quatre créneaux ont depuis été vérifiés ligne à ligne de VDOT 30 à
 * VDOT 50 : ils reproduisent la table à ±0,2 s/km sur E, T et I. Le cinquième,
 * R, dérive avec le niveau — cf. {@link repetitionFractionsAtVdot}.
 *
 * Conformément à la règle du projet, ce sont les pourcentages qui ont été
 * ajustés à la table, jamais les régressions de Daniels & Gilbert.
 */
export const VDOT_ZONE_FRACTIONS = {
  easy: { slow: 0.62, fast: 0.7 },
  marathon: { slow: 0.75, fast: 0.84 },
  threshold: { slow: 0.83, fast: 0.88 },
  interval: { slow: 0.95, fast: 1.0 },
} as const;

/**
 * Fractions de VO2max donnant l'allure R publiée, relevées sur les temps au
 * 400 m de la table. Ce sont les trois points de contrôle du calibrage.
 */
export const REPETITION_FRACTION_ANCHORS = [
  { vdot: 30, fraction: 1.046 }, // 400 m en 2:14 → 5:35/km
  { vdot: 40, fraction: 1.05 }, //  400 m en 1:46 → 4:25/km
  { vdot: 50, fraction: 1.072 }, // 400 m en 1:27 → 3:38/km
] as const;

/**
 * Demi-largeur de la bande R, en fraction de VO2max. La bande garde l'amplitude
 * des créneaux publiés (5 points de pourcentage, comme l'ancien 105-110 %) :
 * c'est son centre qui dérivait avec le niveau, pas son ouverture.
 */
export const REPETITION_HALF_WIDTH = 0.025;

/**
 * Bande R (répétitions) du `vdot` donné — **le seul créneau dont la fraction
 * publiée dépend du niveau**.
 *
 * Les quatre autres créneaux se laissent décrire par une bande fixe de
 * pourcentages ({@link VDOT_ZONE_FRACTIONS}), vérifiée à ±0,2 s/km contre la
 * table de VDOT 30 à 50. R, non : mesurée sur les temps au 400 m imprimés, sa
 * fraction implicite monte avec le niveau — **104,6 % à VDOT 30** (2:14 →
 * 5:35/km), **105,0 % à VDOT 40** (1:46 → 4:25/km), **107,2 % à VDOT 50**
 * (1:27 → 3:38/km). Ce n'est pas une anomalie de la table : R n'est pas une
 * intensité aérobie mais une allure de piste courte, où la part anaérobie —
 * donc l'écart au modèle purement aérobie de Daniels & Gilbert — grandit avec
 * la vitesse.
 *
 * **Ce que corrige cette dépendance.** Avec l'ancienne bande fixe 105-110 %, le
 * *milieu* de bande — c'est lui qui est affiché et imposé comme cible de séance
 * (`zoneMidPace`, `src/lib/ai/plan-schema.ts`) — sortait 7 s/km trop rapide à
 * VDOT 30 (5:28 au lieu de 5:35) et 5 s/km trop rapide à VDOT 40 (4:20 au lieu
 * de 4:25), pour tomber juste à VDOT 50. Les tests n'ancraient la table qu'à
 * VDOT 40 et 50 : le bas de la table, seul concerné, n'était surveillé par
 * personne.
 *
 * **Forme retenue** : fraction centrale interpolée linéairement entre les trois
 * fractions publiées ({@link REPETITION_FRACTION_ANCHORS}), **clampée** hors de
 * [30, 50] — prolonger la pente 40 → 50 donnerait 111,6 % à VDOT 70, une
 * extrapolation que rien ne mesure — et bande de demi-largeur constante
 * {@link REPETITION_HALF_WIDTH} autour. La fraction croît avec le VDOT, donc
 * les deux bornes d'allure accélèrent quand le coureur progresse.
 */
export function repetitionFractionsAtVdot(vdot: number): { slow: number; fast: number } {
  const center = repetitionCenterFraction(vdot);

  return { slow: center - REPETITION_HALF_WIDTH, fast: center + REPETITION_HALF_WIDTH };
}

function repetitionCenterFraction(vdot: number): number {
  const [low, mid, high] = REPETITION_FRACTION_ANCHORS;

  if (vdot <= low.vdot) return low.fraction;
  if (vdot >= high.vdot) return high.fraction;

  const [from, to] = vdot <= mid.vdot ? [low, mid] : [mid, high];

  return (
    from.fraction +
    ((to.fraction - from.fraction) * (vdot - from.vdot)) / (to.vdot - from.vdot)
  );
}

/** Plage d'allure en s/km (`minSecPerKm` = borne rapide). */
export type PaceZone = { minSecPerKm: number; maxSecPerKm: number };

export type TrainingPaces = {
  vdot: number;
  easy: PaceZone;
  marathon: PaceZone;
  threshold: PaceZone;
  interval: PaceZone;
  repetition: PaceZone;
};

/**
 * Vitesse (m/min) dont le coût en oxygène vaut `oxygenCost`. Inverse exact de
 * `oxygenCostAtVelocity` : racine positive de la quadratique
 * 0.000104·v² + 0.182258·v − (4.60 + coût) = 0.
 */
function velocityAtOxygenCost(oxygenCost: number): number {
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.6 - oxygenCost;

  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/**
 * Allure, en s/km **non arrondies**, correspondant à la fraction `fraction` du
 * `vdot` donné. Exposée pour permettre de vérifier les points d'ancrage des
 * tables publiées ; les consommateurs veulent `trainingPacesFromRace`.
 */
export function paceSecPerKmAtVdotFraction(vdot: number, fraction: number): number {
  return 60_000 / velocityAtOxygenCost(fraction * vdot);
}

/** Plage d'allure arrondie à la seconde pour un créneau donné. */
function zoneOf(vdot: number, zone: { slow: number; fast: number }): PaceZone {
  return {
    minSecPerKm: Math.round(paceSecPerKmAtVdotFraction(vdot, zone.fast)),
    maxSecPerKm: Math.round(paceSecPerKmAtVdotFraction(vdot, zone.slow)),
  };
}

/**
 * VDOT d'un chrono de course. Lève `InvalidRacePerformanceError` si la distance
 * ou le temps n'est pas un nombre fini strictement positif, si la vitesse
 * moyenne sort de [`MIN_RACE_SPEED_M_PER_S`, `MAX_RACE_SPEED_M_PER_S`], ou si le
 * VDOT obtenu sort de [`MIN_PLAUSIBLE_VO2MAX`, `MAX_PLAUSIBLE_VO2MAX`].
 *
 * **Mêmes bornes de plausibilité qu'`estimateVdot`**, issue différente : là où
 * une séance quelconque hors plage n'est qu'une donnée inexploitable (`null`),
 * un chrono saisi à la main hors plage est une faute qu'il faut signaler. Sans
 * cette borne, un 5 km en 12 min — plus rapide que le record du monde de trois
 * quarts de minute — passait pour un VDOT 93 et calait toute une table
 * d'allures dessus. En pratique c'est elle, et non le plancher de vitesse, qui
 * décide du sort d'un chrono lent : elle refuse au-delà d'environ 42:40 sur
 * 5 km, 1 h 29 sur 10 km, 3 h 15 sur semi et 6 h 36 sur marathon.
 *
 * **Domaine de fiabilité** : Daniels donne la régression pour la plus juste sur
 * des efforts de 15 à 50 minutes — un 5 km ou un 10 km sont les ancres idéales.
 * Le semi et surtout le marathon restent acceptables, mais leur VDOT dépend
 * davantage de l'endurance et du ravitaillement que de la seule VO2max : à
 * niveau égal, un marathon mal géré sous-estime le coureur.
 */
export function vdotFromRace(distanceM: number, timeS: number): number {
  if (!Number.isFinite(distanceM) || distanceM <= 0) {
    throw new InvalidRacePerformanceError(
      `Distance invalide : ${distanceM} m (attendu un nombre fini > 0).`,
    );
  }
  if (!Number.isFinite(timeS) || timeS <= 0) {
    throw new InvalidRacePerformanceError(
      `Temps invalide : ${timeS} s (attendu un nombre fini > 0).`,
    );
  }

  const speedMPerS = distanceM / timeS;
  if (speedMPerS < MIN_RACE_SPEED_M_PER_S || speedMPerS > MAX_RACE_SPEED_M_PER_S) {
    throw new InvalidRacePerformanceError(
      `Vitesse moyenne implausible : ${speedMPerS.toFixed(2)} m/s pour ${distanceM} m ` +
        `en ${timeS} s (attendu entre ${MIN_RACE_SPEED_M_PER_S} et ` +
        `${MAX_RACE_SPEED_M_PER_S} m/s) — probable erreur de saisie.`,
    );
  }

  const durationMin = timeS / 60;
  const velocityMPerMin = distanceM / durationMin;
  const vdot =
    oxygenCostAtVelocity(velocityMPerMin) / sustainableFractionOverDuration(durationMin);

  if (vdot < MIN_PLAUSIBLE_VO2MAX || vdot > MAX_PLAUSIBLE_VO2MAX) {
    throw new InvalidRacePerformanceError(
      `VDOT implausible : ${vdot.toFixed(1)} pour ${distanceM} m en ${timeS} s ` +
        `(attendu entre ${MIN_PLAUSIBLE_VO2MAX} et ${MAX_PLAUSIBLE_VO2MAX}) — ` +
        `probable erreur de saisie.`,
    );
  }

  return vdot;
}

/**
 * Table d'allures d'entraînement E/M/T/I/R déduite d'un chrono de course.
 * Déterministe et pure. Lève `InvalidRacePerformanceError` aux mêmes conditions
 * que `vdotFromRace`. Les allures sont arrondies à la seconde par kilomètre ;
 * `vdot` est renvoyé sans arrondi.
 */
export function trainingPacesFromRace(distanceM: number, timeS: number): TrainingPaces {
  const vdot = vdotFromRace(distanceM, timeS);

  return {
    vdot,
    easy: zoneOf(vdot, VDOT_ZONE_FRACTIONS.easy),
    marathon: zoneOf(vdot, VDOT_ZONE_FRACTIONS.marathon),
    threshold: zoneOf(vdot, VDOT_ZONE_FRACTIONS.threshold),
    interval: zoneOf(vdot, VDOT_ZONE_FRACTIONS.interval),
    repetition: zoneOf(vdot, repetitionFractionsAtVdot(vdot)),
  };
}
