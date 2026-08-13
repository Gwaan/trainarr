/**
 * Ce qu'un déplacement de séance au calendrier a le droit de faire, et ce dont
 * il doit prévenir.
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`, ni horloge (le jour
 * courant est un paramètre), ni aléa. Toute la décision se teste sans rien
 * monter, et c'est voulu — c'est ici que vit la seule logique métier du
 * calendrier, la Server Action ne fait que la porter jusqu'à la base.
 *
 * ## Deux niveaux, qu'il ne faut surtout pas confondre
 *
 * **Ce qui est refusé** ({@link MoveRefusal}) l'est parce que le déplacement
 * produirait un état faux, pas parce qu'il serait discutable :
 *
 * - une séance déjà courue est de l'**histoire**. La déplacer réécrirait ce qui
 *   a eu lieu ;
 * - une date d'origine ou de destination **dans le passé** est refusée à cause
 *   de la synchronisation : `lib/intervals/push-plan.ts` ne pousse ni ne
 *   supprime jamais un event daté d'hier (« le passé n'est jamais touché »,
 *   règle 2 de son en-tête). Un déplacement que la synchro ne propagerait pas
 *   ferait diverger l'appli et le calendrier de la montre **en silence** : la
 *   séance bougerait dans Trainarr et resterait où elle était sur la montre.
 *   Refuser ici est donc la conséquence directe de la conception de la synchro,
 *   pas une prudence de plus ;
 * - une destination **hors des bornes du plan** sortirait la séance de la
 *   fenêtre que le DAL valide (`validatePlanSessions`) : l'écriture échouerait
 *   de toute façon, autant le dire avant ;
 * - une date **invalide ou identique** à l'origine ne décrit aucun déplacement.
 *
 * **Ce qui est seulement signalé** ({@link MoveWarning}) est de l'entraînement,
 * et l'entraînement appartient à l'athlète. Le squelette encode des règles —
 * l'espacement des jours durs, le jour de sortie longue, le plafond de volume
 * d'intensité, la semaine d'un test qui ne porte que le test — et les casser a
 * un coût réel ; mais c'est **son** plan, et un calendrier qui refuse de bouger
 * une séance parce qu'un entraîneur théorique la placerait ailleurs n'est pas un
 * calendrier, c'est une prison. Le déplacement a donc lieu, et l'avertissement
 * dit ce qui est cassé.
 *
 * ## Le vocabulaire vient du squelette, il n'est pas réécrit ici
 *
 * `SESSION_KINDS`, `QUALITY_ZONE_KINDS`, `FITNESS_TEST_KIND`,
 * `qualityEffortCapKm` et `sessionEffortM` sont **importés** de
 * `lib/plan-skeleton/` : ce sont les mêmes libellés et les mêmes plafonds que
 * ceux qui ont écrit le plan. Deux définitions d'un même seuil finiraient par
 * diverger, et l'avertissement parlerait alors d'une règle que le plan
 * n'applique pas.
 */

import { formatCivilDate, formatDistanceKm, formatIsoDay } from '@/lib/ai/format';
import { sessionPaceZone } from '@/lib/ai/plan-schema';
import { civilDaysBetween, isCivilDate, isoDayIndex, isoWeekStart } from '@/lib/dates/civil';
import {
  FITNESS_TEST_KIND,
  QUALITY_ZONE_KINDS,
  SESSION_KINDS,
  qualityEffortCapKm,
  sessionEffortM,
  type QualityZone,
} from '@/lib/plan-skeleton';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

/**
 * Une séance telle que la décision la lit — la sienne comme celles du voisinage.
 *
 * Réduite à ce qui juge : la date, le libellé (qui porte la zone d'allure), le
 * fait qu'elle ait été courue, et de quoi mesurer le volume d'effort. Ni titre,
 * ni durée : rien de ce que l'affichage seul consomme.
 */
export type MoveSession = {
  id: number;
  /** Jour civil `YYYY-MM-DD` où la séance est planifiée aujourd'hui. */
  date: string;
  /** Ex. « Seuil », « Sortie longue », « Test 5 km ». */
  kind: string;
  /** Séance rapprochée d'une activité : elle a eu lieu. */
  completed: boolean;
  /** Volume annoncé en mètres, `null` quand la séance n'en déclare pas. */
  volumeM: number | null;
  /** Déroulé structuré, `null` quand la séance n'en porte pas. */
  steps: PlanSessionSteps | null;
};

/** Pourquoi le déplacement n'a pas lieu. */
export type MoveRefusalCode =
  | 'invalid-date'
  | 'already-completed'
  | 'session-in-past'
  | 'same-date'
  | 'target-in-past'
  | 'outside-plan';

/** Quelle règle du plan le déplacement casse — sans l'empêcher. */
export type MoveWarningCode =
  | 'hard-days-adjacent'
  | 'long-run-day'
  | 'quality-effort-cap'
  | 'test-week';

/**
 * Le motif du refus. `message` est rédigé pour l'athlète : la Server Action le
 * rend tel quel, elle n'a pas de table de traduction à tenir.
 */
export type MoveRefusal = { code: MoveRefusalCode; message: string };

/** Ce dont l'athlète est avertie, une fois le déplacement fait. */
export type MoveWarning = { code: MoveWarningCode; message: string };

export type MoveVerdict =
  | { allowed: false; refusal: MoveRefusal }
  | { allowed: true; warnings: MoveWarning[] };

export type JudgeSessionMoveInput = {
  session: MoveSession;
  /** Jour civil visé. */
  toDate: string;
  /** Jour civil courant — paramètre, pour que la décision reste pure. */
  today: string;
  plan: {
    startsOn: string;
    /** Dernier jour couvert, **inclus**. */
    endsOn: string;
    /** Jour ISO réglé pour la sortie longue : 1 = lundi … 7 = dimanche. */
    longRunDay: number;
  };
  /**
   * Les autres séances du plan, pour juger le voisinage. La séance déplacée y
   * figure ou non — elle en est retirée par son `id` dans les deux cas.
   */
  siblings: readonly MoveSession[];
};

/**
 * L'écart minimal, en jours, entre deux jours durs.
 *
 * **Deux**, c'est-à-dire au moins un jour de repos entre les deux : c'est la
 * règle que `plan-skeleton/days.ts` nomme dans son en-tête (« deux jours durs ne
 * se touchent pas »). Elle n'y existe pas sous forme de constante à importer —
 * l'algorithme de placement **maximise** l'écart minimal au lieu de le comparer
 * à un seuil —, elle est donc écrite ici, une fois, avec sa source.
 */
const MIN_HARD_DAY_GAP_DAYS = 2;

/**
 * Chaque zone de qualité reconnue à son propre nom — la clé **est** la valeur.
 *
 * Cette table n'existe que pour passer de {@link PaceZoneKey} à
 * {@link QualityZone} sans `as` : `satisfies Record<QualityZone, QualityZone>`
 * exige qu'elle les couvre toutes, et l'indexation ci-dessous cesse de compiler
 * si un créneau d'allure apparaît en amont. Les deux sens sont donc gardés par
 * le compilateur, ce qu'un `Object.keys` (qui rend des `string`) ne ferait pas.
 */
const QUALITY_ZONES = {
  threshold: 'threshold',
  interval: 'interval',
  repetition: 'repetition',
  marathon: 'marathon',
} as const satisfies Record<QualityZone, QualityZone>;

/**
 * La zone de qualité d'une séance, `null` si elle n'en est pas une.
 *
 * `sessionPaceZone` fait le classement — c'est la fonction qui décide déjà des
 * allures prescrites, donc celle qui dit ce qu'une séance **est** dans cette
 * appli. Un libellé qu'elle range en `easy` n'est pas une séance de qualité.
 */
function qualitySessionZone(kind: string): QualityZone | null {
  const zone = sessionPaceZone(kind);
  return zone === 'easy' ? null : QUALITY_ZONES[zone];
}

/** La sortie longue, reconnue à son `kind` — celui que l'appli écrit. */
function isLongRun(kind: string): boolean {
  return kind === SESSION_KINDS.longRun;
}

/** Le test chronométré, reconnu à son `kind` — celui que l'appli écrit. */
function isFitnessTest(kind: string): boolean {
  return kind === FITNESS_TEST_KIND;
}

/**
 * Un **jour dur** au sens du placement (`plan-skeleton/days.ts`) : une séance de
 * qualité ou la sortie longue.
 *
 * La course et le test chronométré en sont aussi : `sessionPaceZone` les range
 * en `marathon` (leur `kind` porte « course » ou « test »), et ce sont bien les
 * deux journées les plus dures d'un plan.
 */
function isHardSession(kind: string): boolean {
  return isLongRun(kind) || qualitySessionZone(kind) !== null;
}

function refuse(code: MoveRefusalCode, message: string): MoveVerdict {
  return { allowed: false, refusal: { code, message } };
}

/**
 * Le déplacement est-il permis, et que casse-t-il ?
 *
 * L'ordre des refus n'est pas cosmétique : la date de destination est éprouvée
 * en premier parce que tout ce qui suit la compare, et le statut de la séance
 * avant sa date parce qu'« elle a déjà été courue » explique mieux qu'« elle est
 * passée » — les deux sont vrais, le premier est utile.
 */
export function judgeSessionMove(input: JudgeSessionMoveInput): MoveVerdict {
  const { session, toDate, today, plan } = input;

  if (!isCivilDate(toDate)) {
    return refuse('invalid-date', "Date de destination invalide : ce jour n'existe pas au calendrier.");
  }
  if (session.completed) {
    return refuse('already-completed', 'Cette séance a déjà été courue : elle ne se déplace plus.');
  }
  // Comparaisons lexicographiques : sur des dates civiles `YYYY-MM-DD` bien
  // formées, elles coïncident avec l'ordre chronologique.
  if (session.date < today) {
    return refuse(
      'session-in-past',
      'Cette séance est déjà passée : le calendrier publié ne réécrit jamais le passé.',
    );
  }
  if (toDate === session.date) {
    return refuse('same-date', 'Cette séance est déjà planifiée ce jour-là.');
  }
  if (toDate < today) {
    return refuse(
      'target-in-past',
      "On ne replanifie pas dans le passé : choisis aujourd'hui ou un jour à venir.",
    );
  }
  if (toDate < plan.startsOn || toDate > plan.endsOn) {
    return refuse(
      'outside-plan',
      `Ton plan court du ${formatCivilDate(plan.startsOn)} au ${formatCivilDate(plan.endsOn)} : cette date en sort.`,
    );
  }

  return { allowed: true, warnings: collectWarnings(input) };
}

/**
 * Ce que le plan, tel qu'il sera **après** le déplacement, ne respecte plus.
 *
 * Toutes les règles se jugent sur l'état d'arrivée : c'est le seul qui existera.
 * Et chacune ne se déclenche que si le déplacement en est la cause — poser un
 * footing dans une semaine déjà surchargée n'avertit de rien, parce qu'il n'y
 * ajoute rien.
 */
function collectWarnings(input: JudgeSessionMoveInput): MoveWarning[] {
  const { session, toDate, plan } = input;

  const moved: MoveSession = { ...session, date: toDate };
  // Trié par date : à voisinage égal, l'avertissement doit toujours nommer la
  // même séance d'un appel à l'autre.
  const others = [...input.siblings]
    .filter((sibling) => sibling.id !== session.id)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);

  const warnings: MoveWarning[] = [];
  const movedIsHard = isHardSession(moved.kind);

  if (movedIsHard) {
    const neighbour = others.find(
      (sibling) =>
        isHardSession(sibling.kind) &&
        Math.abs(civilDaysBetween(sibling.date, toDate)) < MIN_HARD_DAY_GAP_DAYS,
    );
    if (neighbour !== undefined) {
      warnings.push({
        code: 'hard-days-adjacent',
        message: `« ${neighbour.kind} » tombe le ${formatCivilDate(neighbour.date)} : le plan ne fait jamais se suivre deux séances dures.`,
      });
    }
  }

  if (isLongRun(moved.kind) && isoDayIndex(toDate) + 1 !== plan.longRunDay) {
    warnings.push({
      code: 'long-run-day',
      message: `Ta sortie longue quitte le ${formatIsoDay(plan.longRunDay)}, le jour que tu as réglé pour elle.`,
    });
  }

  const weekStart = isoWeekStart(toDate);
  const week = [moved, ...others].filter((entry) => isoWeekStart(entry.date) === weekStart);

  const cap = effortCapWarning(moved, week, weekStart);
  if (cap !== null) warnings.push(cap);

  const testWeek = testWeekWarning(moved, week, weekStart, movedIsHard);
  if (testWeek !== null) warnings.push(testWeek);

  return warnings;
}

/**
 * Le volume d'effort de la séance déplacée dépasse-t-il ce que sa **semaine
 * d'arrivée** finance ?
 *
 * Le plafond de Daniels s'exprime en part du volume hebdomadaire
 * ({@link qualityEffortCapKm}) : déplacer une séance de seuil d'une semaine à
 * 45 km vers une semaine de récupération à 25 km n'en change pas le contenu,
 * mais en change la dose relative — et c'est la dose relative qui compte.
 *
 * Rien n'est signalé quand la semaine n'annonce aucun volume : un plafond
 * calculé sur zéro kilomètre n'est pas une règle, c'est une donnée manquante, et
 * ce projet ne fabrique pas de métrique faute de données.
 */
function effortCapWarning(
  moved: MoveSession,
  week: readonly MoveSession[],
  weekStart: string,
): MoveWarning | null {
  const zone = qualitySessionZone(moved.kind);
  if (zone === null || moved.steps === null) return null;

  const weekKm = week.reduce((total, entry) => total + (entry.volumeM ?? 0), 0) / 1_000;
  if (weekKm <= 0) return null;

  const capKm = qualityEffortCapKm(zone, weekKm);
  if (capKm === null) return null;

  const effortM = sessionEffortM(zone, moved.steps);
  if (effortM / 1_000 <= capKm) return null;

  return {
    code: 'quality-effort-cap',
    message: `La semaine du ${formatCivilDate(weekStart)} pèse ${formatDistanceKm(weekKm * 1_000)} : cette séance y porterait ${formatDistanceKm(effortM)} d'effort (${QUALITY_ZONE_KINDS[zone]}) pour un plafond de ${formatDistanceKm(capKm * 1_000)}.`,
  };
}

/**
 * La semaine d'arrivée porte-t-elle un test **et** autre chose de dur ?
 *
 * La règle vient de `plan-skeleton/fitness-test.ts` : la semaine d'un test ne
 * porte que le test comme séance dure. Ce n'est pas de la prudence de principe —
 * un test couru sur des jambes fatiguées produit un VDOT faux, et ce VDOT
 * recalcule ensuite **toutes** les allures du plan.
 *
 * L'avertissement ne se déclenche que si la séance déplacée est elle-même dure :
 * un footing posé dans une semaine de test ne casse rien.
 */
function testWeekWarning(
  moved: MoveSession,
  week: readonly MoveSession[],
  weekStart: string,
  movedIsHard: boolean,
): MoveWarning | null {
  if (!movedIsHard) return null;

  const test = week.find((entry) => isFitnessTest(entry.kind));
  if (test === undefined) return null;

  const otherHard = week.filter((entry) => entry.id !== test.id && isHardSession(entry.kind));
  if (otherHard.length === 0) return null;

  if (moved.id === test.id) {
    return {
      code: 'test-week',
      message: `La semaine du ${formatCivilDate(weekStart)} porte déjà des séances dures : la semaine d'un test ne porte que le test.`,
    };
  }

  return {
    code: 'test-week',
    message: `La semaine du ${formatCivilDate(weekStart)} porte un test chronométré : cette semaine-là ne porte que le test comme séance dure.`,
  };
}
