/**
 * Le **placement des séances dans la semaine** : quel jour porte la sortie
 * longue, lesquels portent la qualité, lesquels portent les footings.
 *
 * Module **pur** et strictement déterministe : ni horloge, ni aléa, ni état. À
 * paramètres égaux, la même semaine — c'est ce qui rend un plan reproductible, et
 * ce qui permet de tester la répartition au lieu de la constater.
 *
 * ## La seule règle qui compte : deux jours durs ne se touchent pas
 *
 * Une séance de qualité et une sortie longue le même week-end, ou deux qualités
 * à un jour d'intervalle, ne produisent pas deux entraînements — elles
 * produisent un entraînement et une séance courue fatiguée. L'espacement n'est
 * donc pas une commodité de calendrier, c'est la condition pour que la seconde
 * séance ait lieu.
 *
 * L'algorithme la poursuit sans jamais la nommer : les jours de qualité se
 * posent là où l'**écart minimal entre jours durs est le plus grand**, la sortie
 * longue comprise. Et quand le meilleur placement possible accole quand même
 * deux jours durs — beaucoup de séances sur une semaine amputée —, la règle se
 * relâche d'elle-même plutôt que de faire échouer la semaine. C'est le
 * relâchement en dernier recours : mieux vaut une semaine dense qu'un trou dans
 * le plan.
 *
 * ## Pourquoi le placement s'énumère au lieu de se dérouler
 *
 * Poser les jours durs un par un, chacun au mieux de ce qui est déjà posé, **ne
 * donne pas le meilleur placement** : le pas le plus large peut condamner le
 * suivant. Mesuré sur toute la grille (1 à 7 séances × 7 jours de sortie longue
 * × 7 jours de reprise × 0 à 3 qualités, soit 1 372 cellules) : **22 cellules**
 * où le déroulé glouton accole deux jours durs alors qu'un placement les espaçait
 * tous — 10 à deux créneaux de qualité, 12 à trois. Le cas type est `5 séances,
 * sortie longue mercredi, reprise mercredi, 2 qualités` : le glouton pose
 * `[3, 4, 6]`, une qualité le lendemain de la sortie longue, quand `[3, 5, 7]`
 * espace tout de deux jours.
 *
 * L'espace est minuscule (au plus 35 placements), donc il s'**énumère** : on
 * garde ceux dont l'écart minimal est le plus grand. Restent des ex æquo, et ils
 * ne sont pas anodins — `[2, 4]` et `[1, 3]` derrière une sortie longue du
 * samedi ont exactement les mêmes écarts. On les départage en **rejouant le
 * déroulé glouton à l'intérieur des placements optimaux** : chaque jour se pose
 * au plus loin de ce qui est déjà dur, le plus tôt à écart égal. Ce départage
 * n'est pas arbitraire — c'est celui qui préserve à la lettre ce que le module
 * produisait déjà partout où le glouton avait raison (les 22 cellules ci-dessus
 * sont les seules à bouger). Un départage « le placement le plus tôt » aurait,
 * lui, déplacé 138 cellules dont 25 que `buildPlanSkeleton` produit vraiment —
 * `[2, 4]` deviendrait `[1, 3]` derrière une sortie longue du samedi — sans
 * espacer quoi que ce soit de mieux.
 *
 * Les 293 cellules où deux jours durs se touchent encore le restent, et c'est
 * normal : il n'y existe aucun placement qui les espace (sept séances sur une
 * semaine reprise le vendredi, par exemple). Le test le prouve par force brute,
 * placement par placement.
 *
 * ## Pourquoi l'écart est circulaire
 *
 * Le dimanche et le lundi sont deux jours consécutifs. Ils ne le sont pas dans la
 * même semaine du plan, mais ils le sont dans la vie de l'athlète, et un plan qui
 * pose sa sortie longue le dimanche puis une VMA le lundi enchaîne bien deux jours
 * durs. L'écart se compte donc modulo 7, d'un bout de la semaine à l'autre.
 */

/** Jours d'une semaine ISO : 1 = lundi … 7 = dimanche. */
const DAYS_PER_WEEK = 7;

/** Ce que le placement d'une semaine décide. */
export type SessionDayPlacement = {
  /**
   * Le jour ISO de la sortie longue — `null` quand elle n'a pas lieu.
   *
   * Un seul cas : une première semaine déjà entamée dont le jour de sortie
   * longue est déjà passé. La validation le tolère explicitement (le long run de
   * cette semaine-là a eu lieu, ou pas, mais il n'est plus replanifiable).
   */
  longRunDay: number | null;
  /** Les jours ISO des séances de qualité, croissants. */
  qualityDays: number[];
  /** Les jours ISO des footings, croissants. */
  easyDays: number[];
};

export type PlaceSessionDaysParams = {
  /** Nombre de séances visé — ramené à ce que les jours disponibles permettent. */
  sessionsPerWeek: number;
  /** Jour ISO de la sortie longue, tel que l'athlète l'a réglé. */
  longRunDay: number;
  /** Nombre de créneaux de qualité à poser. */
  qualityCount: number;
  /**
   * Premier jour ISO disponible : 1 sur une semaine pleine, le jour de reprise
   * sur une première semaine entamée.
   */
  fromDay: number;
  /**
   * Dernier jour ISO disponible : 7 sur une semaine ordinaire, **le jour J** sur
   * la semaine de la course.
   *
   * Le jour J est une borne, pas seulement un jour de plus. Sans elle, mesuré
   * sur un marathon un lundi à 6 séances : la semaine de course portait
   * **5 séances et 23,3 km après la course**, dont une le lendemain du
   * marathon. Étaler des footings sur les jours qui suivent une compétition
   * n'est pas un plan d'affûtage, et c'est ici que ça se corrige — la fenêtre
   * `[fromDay, toDay]` est le seul endroit qui décide de ce qu'une semaine peut
   * porter.
   */
  toDay: number;
};

/** L'écart entre deux jours de la semaine, en jours, la semaine étant refermée sur elle-même. */
function circularDayGap(day: number, other: number): number {
  const gap = Math.abs(day - other);
  return Math.min(gap, DAYS_PER_WEEK - gap);
}

/**
 * L'écart d'un jour candidat au plus proche des jours déjà posés — l'infini
 * quand rien n'est encore posé, puisque tout jour convient alors également.
 */
function gapToPlaced(day: number, placed: readonly number[]): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (const other of placed) {
    smallest = Math.min(smallest, circularDayGap(day, other));
  }
  return smallest;
}

/**
 * Le jour libre le mieux espacé de ceux déjà posés — `null` s'il n'en reste
 * aucun.
 *
 * Ne sert plus qu'aux **footings** : les jours durs, eux, s'énumèrent
 * ({@link bestSpacedQualityDays}). Un footing mal placé ne coûte rien de plus
 * qu'un footing couru sur des jambes fraîches la veille, alors qu'un jour dur
 * mal placé coûte la séance ; le pas à pas suffit ici.
 *
 * Départage par le jour le plus tôt à écart égal, et ce n'est pas arbitraire :
 * c'est le choix qui garde le plus d'options ouvertes pour les footings
 * suivants.
 */
function bestSpacedDay(free: readonly number[], placed: readonly number[]): number | null {
  let best: number | null = null;
  let bestGap = -1;

  for (const day of free) {
    const gap = gapToPlaced(day, placed);
    if (gap > bestGap) {
      best = day;
      bestGap = gap;
    }
  }

  return best;
}

/** Toutes les façons de choisir `count` jours parmi `free`, chacune croissante. */
function dayCombinations(free: readonly number[], count: number): number[][] {
  if (count <= 0) return [[]];
  const combinations: number[][] = [];
  for (let index = 0; index <= free.length - count; index += 1) {
    for (const rest of dayCombinations(free.slice(index + 1), count - 1)) {
      combinations.push([free[index], ...rest]);
    }
  }
  return combinations;
}

/**
 * Le plus petit écart entre deux jours d'un ensemble — l'infini quand il en
 * compte moins de deux, puisqu'il n'y a alors rien à espacer.
 */
function smallestGap(days: readonly number[]): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < days.length; index += 1) {
    for (let other = index + 1; other < days.length; other += 1) {
      smallest = Math.min(smallest, circularDayGap(days[index], days[other]));
    }
  }
  return smallest;
}

/**
 * Les jours de qualité les mieux espacés des jours durs déjà posés et les uns
 * des autres — le meilleur placement possible, pas le meilleur pas à pas
 * (cf. l'en-tête du module).
 *
 * Deux temps : on énumère les placements et on garde ceux d'écart minimal
 * maximal, puis on rejoue le déroulé glouton **à l'intérieur** de ceux-là. Ce
 * second temps rend exactement ce que le glouton seul rendait chaque fois qu'il
 * atteignait l'optimum : à chaque pas, le glouton prend l'écart le plus grand de
 * **tous** les jours libres, donc jamais moins que le meilleur d'un
 * sous-ensemble, et départage par le jour le plus tôt comme ici. Le placement ne
 * change donc que là où le glouton se trompait.
 */
function bestSpacedQualityDays(
  free: readonly number[],
  hardDays: readonly number[],
  count: number,
): number[] {
  if (count <= 0 || free.length === 0) return [];

  const wanted = Math.min(count, free.length);
  const candidates = dayCombinations(free, wanted);

  let bestGap = -1;
  for (const candidate of candidates) {
    bestGap = Math.max(bestGap, smallestGap([...hardDays, ...candidate]));
  }
  let optimal = candidates.filter(
    (candidate) => smallestGap([...hardDays, ...candidate]) === bestGap,
  );

  const chosen: number[] = [];
  const placed = [...hardDays];
  while (chosen.length < wanted) {
    let bestDay: number | null = null;
    let bestDayGap = -1;
    // Les jours encore possibles sont ceux qu'un placement optimal contient en
    // plus de ce qui est déjà choisi ; les parcourir en ordre croissant fait le
    // départage « le plus tôt » sans le dire deux fois.
    const reachable = [...new Set(optimal.flat())].sort((left, right) => left - right);
    for (const day of reachable) {
      if (chosen.includes(day)) continue;
      const gap = gapToPlaced(day, placed);
      if (gap > bestDayGap) {
        bestDay = day;
        bestDayGap = gap;
      }
    }
    if (bestDay === null) break;

    const day = bestDay;
    chosen.push(day);
    placed.push(day);
    optimal = optimal.filter((candidate) => candidate.includes(day));
  }

  return chosen;
}

/**
 * Les jours de la semaine, répartis entre sortie longue, qualité et footings.
 *
 * L'ordre des trois passes est celui de leur rigidité : la sortie longue est
 * fixée par l'athlète (c'est son week-end, pas une variable d'ajustement), la
 * qualité s'espace de ce qui est déjà dur, les footings remplissent — eux aussi
 * étalés, parce qu'un footing sert autant à récupérer qu'à courir et que trois
 * footings d'affilée suivis de trois jours de repos ne récupèrent rien.
 *
 * Le nombre de séances réellement posées est plafonné par les jours disponibles :
 * une semaine reprise le vendredi ne porte pas six séances, quoi qu'en dise le
 * réglage — et une semaine de course courue le mardi n'en porte pas plus de deux
 * (cf. {@link PlaceSessionDaysParams.toDay}).
 */
export function placeSessionDays(params: PlaceSessionDaysParams): SessionDayPlacement {
  const { sessionsPerWeek, longRunDay, qualityCount, fromDay, toDay } = params;

  const free: number[] = [];
  for (let day = Math.max(1, fromDay); day <= Math.min(DAYS_PER_WEEK, toDay); day += 1) {
    free.push(day);
  }

  const sessionCount = Math.min(Math.max(0, sessionsPerWeek), free.length);
  if (sessionCount === 0) return { longRunDay: null, qualityDays: [], easyDays: [] };

  const takeDay = (day: number): void => {
    free.splice(free.indexOf(day), 1);
  };

  const placedLongRunDay = free.includes(longRunDay) ? longRunDay : null;
  if (placedLongRunDay !== null) takeDay(placedLongRunDay);

  // La sortie longue est un jour dur : la qualité s'espace d'elle comme des
  // autres qualités.
  const hardDays = placedLongRunDay === null ? [] : [placedLongRunDay];
  let remaining = sessionCount - hardDays.length;

  const qualityDays = bestSpacedQualityDays(free, hardDays, Math.min(qualityCount, remaining));
  for (const day of qualityDays) {
    takeDay(day);
    hardDays.push(day);
  }
  remaining -= qualityDays.length;

  // Les footings s'espacent de **tout** ce qui est posé, jours durs compris :
  // ils comblent les trous du calendrier, ils ne s'empilent pas dans l'un d'eux.
  const easyDays: number[] = [];
  const busyDays = [...hardDays];
  for (let placed = 0; placed < remaining; placed += 1) {
    const day = bestSpacedDay(free, busyDays);
    if (day === null) break;
    takeDay(day);
    busyDays.push(day);
    easyDays.push(day);
  }

  return {
    longRunDay: placedLongRunDay,
    qualityDays: qualityDays.sort((left, right) => left - right),
    easyDays: easyDays.sort((left, right) => left - right),
  };
}
