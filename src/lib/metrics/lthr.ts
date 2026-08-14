/**
 * **FC seuil** (LTHR, *lactate threshold heart rate*) : la mesurer sur les
 * séances de l'athlète, et décider quand elle vaut d'être proposée.
 *
 * Module **pur** — ni base, ni réseau, ni horloge. Il ne fait que lire des
 * séries et rendre des battements ; l'écriture, la lecture en base et la
 * proposition vivent dans `src/data/lthr-suggestion.ts`.
 *
 * ## Pourquoi cette valeur mérite d'exister
 *
 * Les zones cardiaques du projet étaient ancrées sur un pourcentage de FC max.
 * C'est le modèle des montres grand public, et c'est aussi celui dont
 * Scharhag-Rosenberger et al. (2010, *J Sci Med Sport* — « Differences in
 * adaptations to 1 year of aerobic endurance training : individual patterns of
 * nonresponse ») documentent la limite : à pourcentage de FC max identique, la
 * réponse métabolique (lactate, ventilation) diffère nettement d'un individu à
 * l'autre. Deux coureurs à 190 de FC max peuvent avoir leur seuil à 165 et à
 * 178 : les mêmes zones en % de FC max ne leur prescrivent pas le même effort.
 *
 * Le seuil, lui, est un **repère métabolique individuel**. La revue de Faude,
 * Kindermann & Meyer (2009, *Sports Med* 39(6):469-490 — « Lactate threshold
 * concepts : how valid are they ? ») conclut que les concepts de seuil lactique
 * sont des prédicteurs valides de la performance d'endurance, et qu'ils sont
 * plus pertinents que la VO₂max pour caler l'entraînement. Ancrer les zones
 * dessus, c'est parler de l'athlète plutôt que d'une moyenne de population.
 *
 * ## Les deux sources de mesure, et leur niveau de preuve
 *
 * **1. Les blocs de seuil prescrits** (source principale). Au voisinage du MLSS
 * (*maximal lactate steady state*), la fréquence cardiaque atteint un
 * quasi-état stable : la FC stabilisée sur un bloc de seuil suffisamment long
 * **est** une mesure de terrain du LTHR. C'est la lecture directe de la
 * définition — pas une estimation. Sa faiblesse est le bruit d'un jour donné
 * (chaleur, déshydratation, dérive cardiaque, sommeil), d'où la **médiane sur
 * plusieurs séances** ({@link LTHR_MIN_SESSIONS}) et jamais un bloc isolé.
 *
 * **2. Le contre-la-montre de ~30 min** (source ponctuelle). Le protocole de
 * terrain de référence est celui de Joe Friel : un contre-la-montre d'environ
 * 30 min couru seul, dont on retient la **FC moyenne des 20 dernières minutes**.
 * C'est un standard de praticien, pas un protocole validé en laboratoire : les
 * comparaisons terrain-labo publiées donnent couramment 5 à 10 % d'écart selon
 * le pacing, et un départ trop rapide surestime la valeur. Le test 5 km de
 * Trainarr — couru à fond en 20 à 27 min, et **vérifié maximal** (≥ 95 % de FC
 * max, cf. `./fitness-test`) — est très proche de ce protocole ; on lui applique
 * donc la même règle des 20 dernières minutes ({@link timeTrialLthrBpm}).
 *
 * ## Ce qui est écarté, en connaissance de cause
 *
 * **DFA-alpha1** (Rogers, Giles, Draper et al. 2021, *Front Physiol* — détection
 * des seuils par l'auto-corrélation des intervalles battement à battement) est
 * la méthode non invasive la plus prometteuse aujourd'hui. Elle exige les
 * **intervalles RR**, que nos flux FIT à 1 Hz ne portent pas : le fichier écrit
 * une fréquence moyennée par seconde, pas la série des battements. Ce n'est donc
 * pas une lacune de ce module mais une limite de la donnée d'entrée — et elle le
 * restera tant que l'import ne lira pas les messages `hrv` du FIT.
 *
 * ## La cinétique cardiaque commande tout le reste
 *
 * La fréquence cardiaque ne saute pas à sa valeur d'équilibre : après un
 * changement d'intensité, elle met **deux à trois minutes** à rejoindre son
 * plateau (composante lente de la réponse cardiaque). Mesurer la FC dès le début
 * d'un bloc, c'est donc mesurer une montée en régime, pas un état stable — et
 * sous-estimer le seuil d'autant.
 *
 * Deux conséquences, appliquées partout dans ce module :
 *
 * - un bloc ne se mesure que sur sa **seconde moitié** ({@link blockPlateauHrBpm}) ;
 * - un effort continu ne se mesure qu'après {@link HR_KINETICS_LAG_S} secondes
 *   ({@link timeTrialLthrBpm}).
 */

import { cappedSampleDurationsS, weightedMean } from './series';

/**
 * Durée minimale de plateau réellement mesuré : **quatre minutes**.
 *
 * C'est le plancher commun aux deux sources, et il vient de la cinétique : une
 * fois les deux à trois minutes de montée en régime passées, il faut encore de
 * quoi moyenner sur une durée où la respiration et les micro-variations
 * d'allure se compensent. Quatre minutes de FC pondérées par le temps donnent
 * une valeur stable au battement près ; une minute donnerait le hasard du moment
 * où l'athlète a doublé une voiture.
 */
export const LTHR_PLATEAU_MIN_S = 4 * 60;

/**
 * Longueur minimale d'un bloc de seuil exploitable : **huit minutes**.
 *
 * Conséquence directe de la règle de la seconde moitié : un bloc de huit minutes
 * livre quatre minutes de plateau, soit exactement {@link LTHR_PLATEAU_MIN_S}.
 * Un 3 × 5 min de seuil n'entre donc pas dans le calcul — sa seconde moitié
 * (2 min 30) commence à peine après la fin de la montée en régime, et la FC y
 * monte encore. C'est un refus assumé : mieux vaut ne rien conclure d'une séance
 * que d'y lire un seuil systématiquement trop bas.
 */
export const THRESHOLD_BLOCK_MIN_S = 8 * 60;

/**
 * Le temps que la FC met à rejoindre son plateau après un changement
 * d'intensité : **trois minutes**.
 *
 * Le haut de la fourchette usuelle (2 à 3 min pour atteindre l'état stable à
 * intensité modérée à forte), choisi parce que l'erreur n'est pas symétrique :
 * inclure une portion de montée en régime tire la mesure vers le bas et fait
 * proposer un seuil trop bas, donc des zones trop basses et un entraînement trop
 * facile. Retrancher une minute de trop ne coûte, elle, qu'une minute de
 * moyenne.
 *
 * N'est utilisé que par {@link timeTrialLthrBpm} : la règle de la seconde moitié
 * couvre déjà le cas d'un bloc, et plus largement (4 min sur un bloc de 8).
 */
export const HR_KINETICS_LAG_S = 3 * 60;

/**
 * La fenêtre du protocole de contre-la-montre : les **20 dernières minutes** de
 * l'effort (Friel).
 *
 * Vingt minutes après un départ, la FC est installée et la dérive n'a pas encore
 * pris le dessus. Sur notre test 5 km, l'effort dure 20 à 27 min : la fenêtre
 * couvre donc la quasi-totalité de la course pour un coureur de 20 min, et sa
 * seconde moitié pour un coureur de 27 min — dans les deux cas, ce qui est
 * mesuré est un plateau.
 */
export const TIME_TRIAL_TAIL_S = 20 * 60;

/**
 * Couverture minimale de la fenêtre par des mesures cardiaques réelles : 70 %.
 *
 * Le même seuil, et la même raison, que le découplage (`./decoupling`) : en
 * deçà, la moyenne ne décrit plus la fenêtre mais le fragment où la ceinture a
 * parlé — typiquement un capteur qui décroche en cours de bloc. La couverture se
 * mesure sur le **sous-axe des instants où la FC est mesurée**, plafonné comme
 * partout ailleurs : un canal clairsemé (une mesure toutes les 10 s) couvre bien
 * 100 % de la fenêtre, un décrochage de deux minutes y creuse un trou que
 * personne ne comble.
 */
export const LTHR_MIN_COVERAGE = 0.7;

/**
 * Nombre minimal de **séances** derrière la médiane : trois.
 *
 * Un bloc isolé n'est pas une mesure de seuil, c'est la FC d'un jour : la
 * chaleur, la déshydratation, une nuit courte ou un départ trop rapide déplacent
 * la FC d'un bloc de 5 à 10 bpm sans que le seuil ait bougé. La médiane de trois
 * séances écarte l'extrême de chaque côté — c'est le plus petit échantillon où
 * une valeur aberrante devient minoritaire.
 */
export const LTHR_MIN_SESSIONS = 3;

/**
 * Fenêtre des mesures retenues : **90 jours**.
 *
 * Une FC seuil n'est pas une constante : elle monte avec la forme, elle
 * redescend avec le désentraînement, et elle dérive avec la saison. Une médiane
 * calculée sur deux ans décrirait l'athlète d'hier. Trois mois est le compromis
 * du plan lui-même : un cycle en porte une séance de seuil par semaine, ce qui
 * laisse largement de quoi atteindre {@link LTHR_MIN_SESSIONS} tout en ne
 * gardant que des mesures encore valables.
 */
export const LTHR_WINDOW_DAYS = 90;

/**
 * Écart minimal avec la FC seuil du profil pour qu'une proposition ait lieu :
 * **trois battements**.
 *
 * En dessous, on parle du bruit d'une mesure de terrain, pas d'une évolution :
 * les protocoles de terrain eux-mêmes ne prétendent pas à mieux que quelques
 * battements. Trois bpm sur un seuil à 170 déplacent les frontières de zone
 * d'environ 3 bpm — l'ordre de grandeur qui commence à se voir dans une
 * répartition de séance.
 */
export const LTHR_SUGGESTION_DELTA_BPM = 3;

/**
 * Écart minimal avec la **dernière valeur refusée** pour reproposer : deux
 * battements.
 *
 * Même mécanique que la FC de repos (`./resting-hr`), et pour la même raison :
 * une FC seuil bouge dans les deux sens (elle monte avec la forme, elle descend
 * avec le désentraînement ou l'âge), donc un seuil directionnel enterrerait la
 * moitié des propositions légitimes. On mémorise la valeur refusée, et la même —
 * ou presque — ne revient plus.
 */
export const LTHR_REPROPOSE_DELTA_BPM = 2;

/**
 * Bornes de plausibilité d'une FC seuil, en bpm.
 *
 * Ce n'est pas un jugement physiologique mais un filet : hors de ces bornes, la
 * valeur ne vient pas d'un plateau de seuil mais d'un capteur en défaut ou d'une
 * fenêtre mal placée. 100 est en dessous de tout seuil de coureur adulte, 210
 * au-dessus de toute FC max plausible.
 */
export const LTHR_BOUNDS = { min: 100, max: 210 } as const;

/** D'où sort une mesure de FC seuil — la carte le dit, la valeur ne se devine pas. */
export const LTHR_SOURCES = ['threshold-blocks', 'time-trial'] as const;

export type LthrSource = (typeof LTHR_SOURCES)[number];

/**
 * Une fenêtre de l'axe des temps, en secondes depuis le départ. Bornes incluses
 * au sens de la mesure : tout échantillon dont l'instant y tombe compte.
 */
export type TimeWindow = { fromS: number; toS: number };

/**
 * FC moyenne d'une fenêtre, pondérée par la durée réellement représentée par
 * chaque mesure — `null` quand la fenêtre n'est pas mesurable.
 *
 * Trois refus, et aucun repli :
 *
 * - la fenêtre est plus courte que {@link LTHR_PLATEAU_MIN_S} ;
 * - aucune FC n'y est mesurée ;
 * - la couverture tombe sous {@link LTHR_MIN_COVERAGE}.
 *
 * Les durées viennent du **sous-axe des instants où la FC a parlé**, comme dans
 * `computeHrZones` et `computeDecoupling` : une FC écrite un point sur quatre à
 * 1 Hz représente 4 s par mesure, et pondérer sur l'axe complet reviendrait à
 * compter les points.
 */
function windowHrBpm(
  heartrate: readonly (number | null)[],
  time: readonly (number | null)[],
  window: TimeWindow,
): number | null {
  const spanS = window.toS - window.fromS;
  if (!Number.isFinite(spanS) || spanS < LTHR_PLATEAU_MIN_S) return null;

  const beats: number[] = [];
  const instants: number[] = [];

  const count = Math.min(heartrate.length, time.length);
  for (let index = 0; index < count; index += 1) {
    const instant = time[index];
    const bpm = heartrate[index];
    if (instant === null || !Number.isFinite(instant)) continue;
    if (instant < window.fromS || instant > window.toS) continue;
    if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) continue;
    // Axe non monotone : anomalie de fichier, l'échantillon est écarté plutôt
    // que de produire une durée négative.
    if (instants.length > 0 && instant < instants[instants.length - 1]) continue;

    beats.push(bpm);
    instants.push(instant);
  }
  if (beats.length === 0) return null;

  const durations = cappedSampleDurationsS(instants);
  let coveredS = 0;
  for (const duration of durations) coveredS += duration;
  if (coveredS / spanS < LTHR_MIN_COVERAGE) return null;

  const mean = weightedMean(beats, durations, 0, beats.length);
  if (mean === null || !(mean > 0)) return null;

  return Math.round(mean);
}

/**
 * FC de **plateau** d'un bloc d'effort : la moyenne de sa **seconde moitié**.
 *
 * Le début du bloc est écarté par construction, et c'est l'essentiel de la
 * méthode : la FC met deux à trois minutes à rejoindre son plateau (cf.
 * {@link HR_KINETICS_LAG_S}), donc les premières minutes d'un bloc décrivent une
 * montée en régime et non l'intensité tenue. Sur un bloc de huit minutes, la
 * seconde moitié commence à la quatrième — après la fin de la transition, avec
 * une minute de marge.
 *
 * `null` — jamais une valeur approchée — quand le bloc dure moins de
 * {@link THRESHOLD_BLOCK_MIN_S}, quand la FC y manque, ou quand la seconde
 * moitié est trop mal couverte pour qu'une moyenne la décrive.
 */
export function blockPlateauHrBpm(
  heartrate: readonly (number | null)[],
  time: readonly (number | null)[],
  block: TimeWindow,
): number | null {
  const spanS = block.toS - block.fromS;
  if (!Number.isFinite(spanS) || spanS < THRESHOLD_BLOCK_MIN_S) return null;

  return windowHrBpm(heartrate, time, {
    fromS: block.fromS + spanS / 2,
    toS: block.toS,
  });
}

/**
 * FC seuil lue sur un **contre-la-montre** : la moyenne des
 * {@link TIME_TRIAL_TAIL_S} dernières secondes de l'effort (protocole Friel).
 *
 * Deux cas, un seul principe — ne moyenner que du plateau :
 *
 * - l'effort dure **plus** de 20 min : on retient ses 20 dernières minutes,
 *   exactement le protocole. La montée en régime est loin derrière ;
 * - l'effort dure **20 min ou moins** (un 5 km couru vite) : on retient tout,
 *   sauf les {@link HR_KINETICS_LAG_S} premières secondes — sans quoi la montée
 *   en régime initiale, qui pèse alors un sixième de la fenêtre, tirerait la
 *   moyenne vers le bas.
 *
 * `null` si la fenêtre restante n'atteint pas {@link LTHR_PLATEAU_MIN_S} : un
 * effort de six minutes n'a pas de plateau à montrer, il a une accélération.
 *
 * **Marge d'erreur.** Ce n'est pas un test de laboratoire : les comparaisons
 * publiées entre ce protocole de terrain et un seuil déterminé en labo donnent
 * couramment 5 à 10 % d'écart, dépendant surtout du pacing — un départ trop
 * rapide fait dériver la FC et surestime la valeur. C'est pour cette raison que
 * cette source reste **ponctuelle** et cède le pas à la médiane des blocs quand
 * celle-ci existe.
 */
export function timeTrialLthrBpm(
  heartrate: readonly (number | null)[],
  time: readonly (number | null)[],
  effort: TimeWindow,
): number | null {
  const spanS = effort.toS - effort.fromS;
  if (!Number.isFinite(spanS) || spanS <= 0) return null;

  const window =
    spanS > TIME_TRIAL_TAIL_S
      ? { fromS: effort.toS - TIME_TRIAL_TAIL_S, toS: effort.toS }
      : { fromS: effort.fromS + HR_KINETICS_LAG_S, toS: effort.toS };

  return windowHrBpm(heartrate, time, window);
}

/**
 * La médiane, arrondie au battement, des FC de plateau relevées séance après
 * séance.
 *
 * `null` sous {@link LTHR_MIN_SESSIONS} valeurs. La médiane, et non la moyenne :
 * une séance courue par 32 °C ou sur une jambe fatiguée déplace la FC de
 * plusieurs battements, et une moyenne la laisserait peser à part entière.
 *
 * L'arrondi ne concerne que le cas d'un nombre pair de mesures (moyenne des deux
 * valeurs centrales) : une FC s'exprime en battements entiers.
 */
export function medianLthrBpm(values: readonly number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length < LTHR_MIN_SESSIONS) return null;

  const sorted = [...usable].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;

  return Math.round(median);
}

/** Ce que les mesures disent du seuil, avant toute question de proposition. */
export type LthrCandidate = {
  /** La valeur retenue, en battements par minute. */
  bpm: number;
  /** D'où elle vient — la carte le dit, l'athlète n'a pas à le deviner. */
  source: LthrSource;
  /** La médiane des blocs, `null` quand il n'y a pas assez de séances. */
  blocksBpm: number | null;
  /** Nombre de séances de seuil derrière cette médiane. */
  sessionCount: number;
  /** Le dernier contre-la-montre exploitable, `null` s'il n'y en a pas. */
  timeTrialBpm: number | null;
};

export type LthrCandidateInput = {
  /** Une FC de plateau par séance de seuil de la fenêtre, dans n'importe quel ordre. */
  blockValues: readonly number[];
  /** La FC seuil du test le plus récent, `null` s'il n'y en a pas eu. */
  timeTrialBpm: number | null;
};

/**
 * Ce que les mesures disent du seuil, `null` quand elles n'en disent rien.
 *
 * **La médiane des blocs prime sur le test** dès qu'elle existe, et l'ordre
 * n'est pas arbitraire : la médiane est une mesure répétée en état stable, le
 * test est une extrapolation ponctuelle d'un protocole de terrain dont la marge
 * est de 5 à 10 % (cf. {@link timeTrialLthrBpm}). Le test reste la source
 * d'amorçage — c'est souvent la première mesure disponible d'un athlète qui
 * démarre — et il est rendu dans les deux cas, pour que la carte puisse dire
 * qu'il concorde ou non.
 */
export function lthrCandidate(input: LthrCandidateInput): LthrCandidate | null {
  const blocksBpm = medianLthrBpm(input.blockValues);
  const sessionCount = input.blockValues.filter(
    (value) => Number.isFinite(value) && value > 0,
  ).length;
  const timeTrialBpm =
    input.timeTrialBpm !== null &&
    Number.isFinite(input.timeTrialBpm) &&
    input.timeTrialBpm > 0
      ? Math.round(input.timeTrialBpm)
      : null;

  if (blocksBpm !== null) {
    return { bpm: blocksBpm, source: 'threshold-blocks', blocksBpm, sessionCount, timeTrialBpm };
  }
  if (timeTrialBpm !== null) {
    return { bpm: timeTrialBpm, source: 'time-trial', blocksBpm: null, sessionCount, timeTrialBpm };
  }
  return null;
}

export type LthrSuggestionInput = LthrCandidateInput & {
  /** FC seuil du profil, `null` tant qu'aucune n'a été adoptée. */
  profileBpm: number | null;
  /** FC max du profil, `null` si absente — plafond d'une valeur acceptable. */
  maxHrBpm: number | null;
  /** Dernière valeur écartée par l'athlète, `null` si aucune ne l'a été. */
  dismissedBpm: number | null;
};

/**
 * La FC seuil à **proposer**, `null` quand il n'y a rien à proposer.
 *
 * Cinq conditions, toutes nécessaires :
 *
 * 1. les mesures donnent une candidate ({@link lthrCandidate}) ;
 * 2. elle tient dans {@link LTHR_BOUNDS} ;
 * 3. elle reste **strictement sous** la FC max du profil, s'il y en a une : un
 *    seuil au-dessus de la FC max n'est pas un seuil, c'est une mesure fausse —
 *    et il rendrait la zone 5 inatteignable ;
 * 4. elle s'écarte d'au moins {@link LTHR_SUGGESTION_DELTA_BPM} de la FC seuil du
 *    profil — **dans un sens ou dans l'autre**, un seuil montant avec la forme et
 *    redescendant avec le désentraînement — ou le profil n'en porte pas encore ;
 * 5. elle s'écarte d'au moins {@link LTHR_REPROPOSE_DELTA_BPM} de la dernière
 *    valeur refusée, s'il y en a une.
 */
export function lthrSuggestion(input: LthrSuggestionInput): LthrCandidate | null {
  const candidate = lthrCandidate(input);
  if (candidate === null) return null;

  const { bpm } = candidate;
  if (bpm < LTHR_BOUNDS.min || bpm > LTHR_BOUNDS.max) return null;
  if (input.maxHrBpm !== null && bpm >= input.maxHrBpm) return null;

  if (
    input.profileBpm !== null &&
    Math.abs(bpm - input.profileBpm) < LTHR_SUGGESTION_DELTA_BPM
  ) {
    return null;
  }

  if (
    input.dismissedBpm !== null &&
    Math.abs(bpm - input.dismissedBpm) < LTHR_REPROPOSE_DELTA_BPM
  ) {
    return null;
  }

  return candidate;
}
