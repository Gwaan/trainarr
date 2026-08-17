import 'server-only';

import { and, desc, eq, gte, lt, lte } from 'drizzle-orm';

import { civilDaysBetween, isoWeekStart, shiftCivilDate, toCivilDate } from '@/lib/dates/civil';
import { computeLoadSeries, computeTrimp } from '@/lib/metrics';
import type { PlanIntent } from '@/lib/plan-skeleton/intent';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import {
  getAthleteById,
  getCurrentAthlete,
  getCurrentAthleteId,
  todayCivilDate,
} from './athlete';
import { db } from './db/client';
import { activities, type Activity, type Athlete, type AthleteSex } from './db/schema';
import { getActivePlanWithSessions, planEndExclusive, type PlanSessionDto } from './plans';
import { buildDailyTrimp, buildFitness, buildVo2max, isRunning } from './training-metrics';
import { getVo2maxCorrection } from './vo2max-correction';
import { listWellnessDays } from './wellness';

/**
 * Le « R » du RAG du coach : la récupération structurée qui alimente ses
 * prompts.
 *
 * Ce module ne calcule rien de neuf — il rassemble ce que `training-metrics`
 * produit déjà pour le tableau de bord et la page « Progression », et le réduit
 * à des DTOs **minuscules**. Le modèle cible tient dans 6 Go de VRAM avec 32 k
 * de contexte : chaque champ envoyé se paie en tokens, et une série point par
 * point ne rentre pas. On envoie donc des agrégats, jamais des courbes.
 *
 * Règle du projet appliquée à la lettre : **une donnée absente est absente**.
 * Les champs de profil non renseignés ne figurent pas dans le DTO, et rien n'est
 * approximé pour combler un trou — le prompt n'en parlera pas, et le coach ne
 * pourra donc pas l'inventer.
 */

/**
 * Profil physiologique réduit à ce qu'un coach utilise pour calibrer un plan.
 *
 * Champs **facultatifs et omis** quand ils manquent : `maxHrBpm: null` se
 * sérialiserait en « FC max : null » dans un prompt, ce qu'un petit modèle lit
 * volontiers comme une valeur.
 */
export type SnapshotProfileDto = {
  /** Âge révolu au jour de la lecture, dérivé de la date de naissance. */
  ageYears?: number;
  sex?: AthleteSex;
  maxHrBpm?: number;
  restingHrBpm?: number;
  weightKg?: number;
};

/** Volume d'une semaine ISO, **course à pied uniquement**. */
export type SnapshotWeekDto = {
  /** Lundi de la semaine, date civile `YYYY-MM-DD`. */
  startsOn: string;
  distanceKm: number;
  movingTimeS: number;
  /** Nombre de sorties de la semaine. */
  sessions: number;
};

/** Où en est l'athlète aujourd'hui — le contexte commun à toutes les générations. */
export type TrainingSnapshotDto = {
  /** Jour civil de la lecture : le prompt date ce qu'il affirme. */
  today: string;
  profile: SnapshotProfileDto;
  /** Charge du jour, `null` si elle n'est pas calculable (cf. `buildFitnessUnavailable`). */
  fitness: { ctl: number; atl: number; tsb: number } | null;
  /** VO₂max des 30 derniers jours, `null` si aucune course n'est exploitable. */
  vo2max: number | null;
  /** Les {@link SNAPSHOT_WEEKS} dernières semaines, de la plus ancienne à la semaine en cours. */
  weeks: SnapshotWeekDto[];
  /**
   * La plus longue course des {@link LONGEST_SESSION_DAYS} derniers jours, en
   * km — `null` quand l'athlète n'en a couru aucune.
   *
   * C'est l'entrée du **plafond de sortie longue** d'une reprise : le pic d'une
   * séance isolée est le paramètre de charge que Frandsen 2025 (5 205 coureurs)
   * associe au risque, et le plan ne rouvre donc pas une reprise sur une sortie
   * plus longue que ce que l'athlète vient de courir. `null` veut dire « pas de
   * plafond » et non « plafond à zéro » : sans donnée, on n'invente rien.
   */
  longestSessionKm30d: number | null;
  /** Allure moyenne des {@link RECENT_PACE_ACTIVITIES} dernières courses, `null` si aucune. */
  recentAvgPaceSecPerKm: number | null;
};

/** Une sortie comparable, telle que le feedback la met en regard de la séance analysée. */
export type ComparableActivityDto = {
  /** Jour civil de la sortie. */
  date: string;
  distanceM: number;
  movingTimeS: number;
  avgPaceSecPerKm: number | null;
  avgHrBpm: number | null;
  elevationGainM: number | null;
  /** `null` sans FC moyenne ou sans profil complet (le TRIMP de Banister est sexué). */
  trimp: number | null;
};

/**
 * Une séance du plan telle que le **chat** du coach la lit.
 *
 * Volontairement plus pauvre que `PlanSessionDto` : ni `id`, ni allure cible, ni
 * échauffement/récupération séparés. Ce qu'il faut pour répondre à « c'est quoi
 * ma prochaine séance ? », et rien de plus — chaque champ superflu se paie en
 * tokens et donne au modèle une matière de plus à recombiner de travers.
 */
export type UpcomingSessionDto = {
  /** Jour civil `YYYY-MM-DD`. */
  date: string;
  /** Le type de la séance, ex. « VMA courte · piste ». */
  kind: string;
  /** L'intitulé, ex. « 6 × 800 m ». */
  title: string;
  /**
   * Le déroulé **structuré**, tel que la séance le porte — `null` quand elle
   * n'en a pas.
   *
   * Brut et non rendu : le DAL rend des données, la mise en forme des prompts
   * appartient à `lib/ai/format`. Le rendre ici obligerait `src/data/` à
   * importer `src/lib/ai/`, ce qui inverserait le sens des couches. Le type est
   * celui des séances planifiées, porté par un module pur (`lib/plan-steps`) —
   * il ne fait entrer aucun identifiant interne au passage.
   */
  steps: PlanSessionSteps | null;
  volumeM: number | null;
  durationS: number | null;
  /** La séance a-t-elle déjà été courue ? */
  done: boolean;
};

/** L'objectif du plan : ce que l'athlète est venue y chercher, et sa note. */
export type PlanGoalDto = {
  intent: PlanIntent;
  /** Note libre de l'athlète, `null` quand elle n'en a pas écrit. */
  note: string | null;
};

/**
 * Le plan de l'athlète, réduit à ce que le chat en dit.
 *
 * Union discriminée et non `PlanContextDto | null` : l'absence de plan est un
 * **fait à énoncer** (« tu n'as pas de plan en cours »), pas une donnée manquante
 * à taire. C'est la même règle que partout ici — ce qui n'est pas là est dit tel
 * quel, et le modèle n'a donc rien à combler.
 */
export type PlanContextDto =
  | { hasPlan: false }
  | {
      hasPlan: true;
      /**
       * Le jour de la lecture, celui contre lequel la fenêtre a été découpée.
       *
       * Il voyage avec les séances parce qu'il est ce qui les situe : sans lui,
       * une séance non faite du passé récent ne se distingue pas d'une séance à
       * venir, et le formateur ne pourrait pas les rendre différemment.
       */
      today: string;
      goal: PlanGoalDto;
      /** Jour J, pour un objectif « course » uniquement. */
      raceDate: string | null;
      /** Dernier jour **couvert** par le plan, inclus. */
      endsOn: string;
      /** Les séances de la fenêtre, de la plus ancienne à la plus lointaine. */
      upcoming: UpcomingSessionDto[];
    };

/**
 * Le bien-être récent tel que le **chat** du coach le lit.
 *
 * Bloc **distinct** de {@link TrainingSnapshotDto}, et pour exactement la même
 * raison que {@link PlanContextDto} : le snapshot alimente aussi la génération de
 * plan, la revue, le feedback et les tests chronométrés. Y verser ces mesures
 * ferait bouger quatre prompts éprouvés pour le seul besoin du chat.
 *
 * Ce sont des mesures de **montre**, pas de l'application : elle ne les calcule
 * pas, ne les corrige pas, et n'en dérive rien. Le formateur le dit au modèle,
 * qui n'a donc aucune raison d'en tirer une charge ou une forme.
 */
export type WellnessContextDayDto = {
  /** Jour civil `YYYY-MM-DD`. */
  date: string;
  restingHrBpm: number | null;
  /**
   * Variabilité cardiaque nocturne **rMSSD**, en millisecondes — une des deux
   * HRV, celle que le domaine prend pour référence.
   */
  hrvRmssdMs: number | null;
  /**
   * Variabilité cardiaque nocturne **SDNN**, en millisecondes — l'autre.
   *
   * Les deux voyagent séparément jusqu'au prompt, qui écrit la variante à côté
   * de la valeur : un modèle qui verrait « HRV 45 ms » sans savoir laquelle
   * comparerait à des repères de rMSSD. Une seule est renseignée en pratique.
   */
  hrvSdnnMs: number | null;
  sleepTimeS: number | null;
  /** Score de sommeil de la montre, sur 100. */
  sleepScore: number | null;
  weightKg: number | null;
};

export type WellnessContextDto = {
  /** Jour de la lecture : le prompt date ce qu'il affirme. */
  today: string;
  /**
   * Les journées **portant au moins une mesure**, de la plus récente à la plus
   * ancienne. Une journée entièrement muette n'est pas une ligne à écrire — son
   * absence de la liste dit déjà tout, et le formateur nomme séparément les
   * mesures qui manquent sur toute la fenêtre.
   */
  days: WellnessContextDayDto[];
};

/**
 * Fenêtre du bien-être envoyé au chat : 7 jours, aujourd'hui compris.
 *
 * Une semaine, parce que c'est l'horizon d'une question de chat (« je suis
 * cuite, je fais quoi demain ? ») : ce qui compte est la nuit dernière et la
 * tendance des derniers jours. Trente jours tripleraient le bloc pour répondre à
 * une question que personne ne pose au chat — la page « Progression » montre la
 * tendance longue bien mieux qu'une liste.
 */
export const COACH_WELLNESS_DAYS = 7;

/** Quatre semaines : de quoi voir une progression de volume sans noyer le prompt. */
export const SNAPSHOT_WEEKS = 4;

/**
 * Fenêtre des séances envoyées au chat : 10 jours, aujourd'hui compris.
 *
 * Dix, parce que c'est le plus petit nombre qui répond aux deux questions
 * posées : quel que soit le jour où l'athlète demande, la fenêtre couvre la fin
 * de sa semaine **et** le début de la suivante, donc « ma semaine » ne s'arrête
 * jamais au dimanche soir, et au moins un week-end complet y figure — soit au
 * moins une sortie longue à venir. Sept jours laisseraient un lundi sans rien
 * savoir du week-end suivant ; quatorze doubleraient le bloc (une quinzaine à
 * cinq séances, c'est dix lignes de déroulés) pour répondre à une question que
 * personne ne pose au chat.
 */
export const COACH_UPCOMING_DAYS = 10;

/**
 * Jours de passé récent joints à la fenêtre : 3.
 *
 * Ce que le coach ne voit pas, il ne peut pas le relever. Une fenêtre ouverte à
 * aujourd'hui laissait la séance d'**hier** hors du contexte : sautée ou courue,
 * le modèle n'en savait rien, alors que `done` existe précisément pour faire la
 * différence entre le fait et l'à-venir.
 *
 * Trois, parce que c'est le plus petit nombre qui couvre les deux cas qui se
 * présentent : « ma séance d'hier », et un week-end entier passé à la trappe —
 * un lundi, `today − 3` remonte au vendredi, samedi et dimanche compris. Sept
 * jours rouvriraient une semaine complète de déroulés dans un bloc qui pèse déjà
 * trois fois l'état d'entraînement, pour un passé que la page « Plan » montre
 * mieux que le chat ; c'est le même budget de 32 k de contexte qui est en jeu.
 */
export const COACH_RECENT_DAYS = 3;

/** Fenêtre de l'allure de référence : les 5 dernières courses. */
export const RECENT_PACE_ACTIVITIES = 5;

/**
 * Fenêtre de la plus longue séance : 30 jours.
 *
 * Un mois, parce que c'est l'horizon sur lequel une sortie longue reste une
 * capacité **actuelle** — au-delà, un 18 km couru il y a deux mois ne dit plus
 * ce que les tendons encaissent aujourd'hui, ce qui est justement la question
 * que pose une reprise.
 */
export const LONGEST_SESSION_DAYS = 30;

/**
 * Écart de distance toléré pour qu'une sortie soit « comparable » : ±25 %.
 * Au-delà, comparer les allures n'a plus de sens (un 5 km et un 20 km ne se
 * courent pas au même régime).
 */
export const COMPARABLE_DISTANCE_TOLERANCE = 0.25;

/*
 * Constructions pures, exportées pour les tests.
 */

/** Âge révolu à la date civile `today`. */
export function ageYearsOn(birthDate: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  // Comparaison `MM-JJ` : l'anniversaire n'est pas encore passé cette année.
  return today.slice(5) < birthDate.slice(5) ? years - 1 : years;
}

/** Profil réduit, les champs non renseignés étant purement et simplement omis. */
export function toSnapshotProfile(profile: Athlete, today: string): SnapshotProfileDto {
  const dto: SnapshotProfileDto = {};
  if (profile.birthDate !== null) dto.ageYears = ageYearsOn(profile.birthDate, today);
  if (profile.sex !== null) dto.sex = profile.sex;
  if (profile.maxHrBpm !== null) dto.maxHrBpm = profile.maxHrBpm;
  if (profile.restingHrBpm !== null) dto.restingHrBpm = profile.restingHrBpm;
  if (profile.weightKg !== null) dto.weightKg = profile.weightKg;
  return dto;
}

/**
 * Les `count` dernières semaines ISO, la dernière étant celle de `today`.
 *
 * Course à pied uniquement : le volume d'entraînement d'un coureur ne compte pas
 * une sortie vélo, et le plan qu'on lui demande de bâtir ne parle que de course.
 * Une semaine sans sortie reste dans la liste, à zéro — c'est une donnée.
 */
export function buildRecentWeeks(
  rows: readonly Activity[],
  today: string,
  count = SNAPSHOT_WEEKS,
): SnapshotWeekDto[] {
  const currentWeekStart = isoWeekStart(today);
  const weeks: SnapshotWeekDto[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    weeks.push({
      startsOn: shiftCivilDate(currentWeekStart, -7 * index),
      distanceKm: 0,
      movingTimeS: 0,
      sessions: 0,
    });
  }

  const firstWeekStart = weeks[0].startsOn;
  for (const row of rows) {
    if (!isRunning(row.sportType)) continue;

    const day = toCivilDate(row.startedAt);
    // Les dates civiles `YYYY-MM-DD` s'ordonnent lexicographiquement.
    if (day < firstWeekStart || day > today) continue;

    const week = weeks[Math.floor(civilDaysBetween(firstWeekStart, day) / 7)];
    if (!week) continue;

    week.distanceKm += row.distanceM / 1000;
    week.movingTimeS += row.movingTimeS;
    week.sessions += 1;
  }

  return weeks;
}

/**
 * Allure moyenne des `limit` dernières courses, en secondes par kilomètre.
 *
 * Distance cumulée sur temps cumulé, et non moyenne des allures : une sortie de
 * 20 km doit peser plus qu'un footing de 5 km dans une allure « de référence ».
 * `null` si aucune de ces sorties n'a de distance ni de temps exploitables.
 */
export function recentRunPace(
  rows: readonly Activity[],
  limit = RECENT_PACE_ACTIVITIES,
): number | null {
  const recent = [...rows]
    .filter((row) => isRunning(row.sportType))
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, limit);

  let distanceM = 0;
  let movingTimeS = 0;
  for (const row of recent) {
    if (row.distanceM <= 0 || row.movingTimeS <= 0) continue;
    distanceM += row.distanceM;
    movingTimeS += row.movingTimeS;
  }

  return distanceM > 0 ? movingTimeS / (distanceM / 1000) : null;
}

/**
 * La plus longue course des `days` derniers jours, en km — `null` s'il n'y en a
 * aucune.
 *
 * Course à pied uniquement, comme partout ailleurs dans ce module : une sortie
 * vélo de 40 km ne dit rien de ce qu'une sortie longue à pied coûtera. La
 * fenêtre est fermée des deux côtés — rien après `today`, rien avant `today −
 * days` — et une distance nulle n'est pas une séance : elle ne peut donc pas
 * devenir un plafond de zéro kilomètre.
 */
export function longestRunKm(
  rows: readonly Activity[],
  today: string,
  days = LONGEST_SESSION_DAYS,
): number | null {
  const from = shiftCivilDate(today, -days);
  let longestM = 0;

  for (const row of rows) {
    if (!isRunning(row.sportType)) continue;
    const day = toCivilDate(row.startedAt);
    // Les dates civiles `YYYY-MM-DD` s'ordonnent lexicographiquement.
    if (day < from || day > today) continue;
    if (row.distanceM > longestM) longestM = row.distanceM;
  }

  return longestM > 0 ? longestM / 1000 : null;
}

/** DTO d'une sortie comparable. Le TRIMP est recalculé : il n'est pas stocké. */
export function toComparableActivityDto(row: Activity, profile: Athlete): ComparableActivityDto {
  return {
    date: toCivilDate(row.startedAt),
    distanceM: row.distanceM,
    movingTimeS: row.movingTimeS,
    avgPaceSecPerKm: row.avgPaceSecPerKm,
    avgHrBpm: row.avgHrBpm,
    elevationGainM: row.elevationGainM,
    trimp:
      profile.sex === null
        ? null
        : computeTrimp({
            movingTimeS: row.movingTimeS,
            avgHrBpm: row.avgHrBpm,
            restingHrBpm: profile.restingHrBpm,
            maxHrBpm: profile.maxHrBpm,
            sex: profile.sex,
          }),
  };
}

/**
 * Séance planifiée réduite à ce que le chat en lit, déroulé compris tel quel.
 *
 * `done` est le seul champ dérivé : `completedActivityId` est un identifiant
 * interne, il ne franchit pas la frontière — mais le fait qu'une séance ait été
 * courue, lui, est exactement ce qui empêche le coach d'annoncer comme « à
 * venir » ce que l'athlète vient de faire.
 */
export function toUpcomingSessionDto(session: PlanSessionDto): UpcomingSessionDto {
  return {
    date: session.scheduledOn,
    kind: session.kind,
    title: session.title,
    steps: session.steps,
    volumeM: session.volumeM,
    durationS: session.durationS,
    done: session.completedActivityId !== null,
  };
}

/**
 * Les séances de la fenêtre `[today − {@link COACH_RECENT_DAYS}, today + days)`,
 * dans l'ordre du calendrier.
 *
 * Fenêtre fermée des deux côtés, comme {@link longestRunKm} : rien au-delà de
 * l'horizon, donc rien qui laisse croire au modèle qu'il connaît la suite du
 * plan, et seulement quelques jours de passé — assez pour que le coach voie une
 * séance sautée, pas assez pour que le bloc devienne un journal.
 */
export function buildUpcomingSessions(
  sessions: readonly PlanSessionDto[],
  today: string,
  days = COACH_UPCOMING_DAYS,
): UpcomingSessionDto[] {
  const from = shiftCivilDate(today, -COACH_RECENT_DAYS);
  const endExclusive = shiftCivilDate(today, days);

  return sessions
    // Les dates civiles `YYYY-MM-DD` s'ordonnent lexicographiquement.
    .filter((session) => session.scheduledOn >= from && session.scheduledOn < endExclusive)
    .sort((a, b) => a.scheduledOn.localeCompare(b.scheduledOn))
    .map(toUpcomingSessionDto);
}

/** Snapshot d'un athlète qui n'existe pas encore : tout est absent, rien n'est inventé. */
function emptySnapshot(today: string): TrainingSnapshotDto {
  return {
    today,
    profile: {},
    fitness: null,
    vo2max: null,
    weeks: [],
    longestSessionKm30d: null,
    recentAvgPaceSecPerKm: null,
  };
}

/*
 * Lectures.
 */

/**
 * L'état d'entraînement courant : profil, charge, volume des dernières semaines,
 * VO₂max et allure de référence.
 *
 * Une seule lecture de l'historique, comme le tableau de bord : la CTL est une
 * moyenne mobile sur 42 jours, elle a besoin de tout l'historique, et une ligne
 * d'activité est légère (les séries temporelles vivent dans une autre table).
 *
 * **L'athlète est un paramètre**, et il peut valoir `null` : c'est l'état
 * « pas encore d'athlète », que le snapshot modélise déjà (rien n'est inventé,
 * tout est absent). Les appelants de requête passent celui de leur session ;
 * ceux du suivi de plan, déclenché hors requête par une ingestion, passent
 * l'athlète du fichier importé — il n'est alors jamais `null`.
 */
export async function getTrainingSnapshot(
  athleteId: number | null,
): Promise<TrainingSnapshotDto> {
  const today = todayCivilDate();

  const profile = athleteId === null ? null : await getAthleteById(athleteId);
  if (!profile) return emptySnapshot(today);

  const [rows, vo2maxCorrection] = await Promise.all([
    db
      .select()
      .from(activities)
      .where(eq(activities.athleteId, profile.id))
      .orderBy(desc(activities.startedAt)),
    // Le coach doit lire la **même** VO₂max que les écrans, recalage compris :
    // deux nombres différents pour la même grandeur rendraient ses conseils
    // incompréhensibles à qui les confronte au tableau de bord.
    getVo2maxCorrection(profile.id),
  ]);

  const daily = buildDailyTrimp(rows, profile, today);
  const fitness = buildFitness(daily.length > 0 ? computeLoadSeries(daily) : []);
  const vo2max = buildVo2max(rows, profile, today, vo2maxCorrection.factor);

  return {
    today,
    profile: toSnapshotProfile(profile, today),
    fitness: fitness === null ? null : { ctl: fitness.ctl, atl: fitness.atl, tsb: fitness.tsb },
    vo2max: vo2max === null ? null : vo2max.value,
    weeks: buildRecentWeeks(rows, today),
    longestSessionKm30d: longestRunKm(rows, today),
    recentAvgPaceSecPerKm: recentRunPace(rows),
  };
}

/**
 * Le plan actif réduit aux quelques jours qui entourent aujourd'hui — le
 * contexte que le **chat** du coach n'avait pas, et qu'un petit modèle comblait
 * donc en inventant des séances.
 *
 * Lecture **distincte** de {@link getTrainingSnapshot}, et c'est délibéré : le
 * snapshot alimente aussi la génération de plan, la révision, le feedback et les
 * tests chronométrés. Y verser les séances rendrait le prompt de génération
 * circulaire — le plan décrivant le plan qu'on lui demande d'écrire — et
 * modifierait quatre prompts éprouvés pour le seul besoin du chat.
 *
 * `{ hasPlan: false }` quand il n'y a pas de plan actif (ou pas encore
 * d'athlète) : c'est une réponse, pas un trou.
 */
export async function getPlanContext(): Promise<PlanContextDto> {
  // Lecture de **requête** uniquement (le chat du coach) : l'athlète vient donc
  // de la session, et c'est ici qu'il se résout.
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return { hasPlan: false };

  const active = await getActivePlanWithSessions(athleteId);
  if (active === null) return { hasPlan: false };

  const { plan, sessions } = active;
  // Une seule lecture de l'horloge : la fenêtre et le jour annoncé au formateur
  // doivent parler du même jour, faute de quoi une séance passée pourrait se
  // rendre comme à venir à cheval sur minuit.
  const today = todayCivilDate();

  return {
    hasPlan: true,
    today,
    goal: {
      intent: plan.intent,
      // La note est facultative depuis le sélecteur d'intention : une chaîne
      // vide n'est pas un objectif, elle ne doit pas se rendre en « Objectif : ».
      note: plan.goalText.trim() === '' ? null : plan.goalText,
    },
    raceDate: plan.raceDate,
    // `planEndExclusive` rend le premier jour **non** couvert ; le prompt parle
    // d'une échéance, donc du dernier jour couvert.
    endsOn: shiftCivilDate(planEndExclusive(plan.startsOn, plan.weeks), -1),
    upcoming: buildUpcomingSessions(sessions, today),
  };
}

/**
 * Le bien-être des {@link COACH_WELLNESS_DAYS} derniers jours, tel que le
 * **chat** le lit.
 *
 * Lecture **de requête** uniquement : l'athlète vient de la session, et une
 * fenêtre vide (`days: []`) est une réponse — « aucune mesure », que le
 * formateur énonce — jamais un trou que le modèle comblerait.
 */
export async function getWellnessContext(): Promise<WellnessContextDto> {
  const today = todayCivilDate();

  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return { today, days: [] };

  const rows = await listWellnessDays(
    athleteId,
    shiftCivilDate(today, -(COACH_WELLNESS_DAYS - 1)),
    today,
  );

  return {
    today,
    days: rows
      // Une journée entièrement muette (la ligne existe, aucune mesure n'est
      // arrivée) ne se rend pas : elle coûterait des tokens pour ne rien dire.
      .filter(
        (row) =>
          row.restingHrBpm !== null ||
          row.hrvRmssdMs !== null ||
          row.hrvSdnnMs !== null ||
          row.sleepTimeS !== null ||
          row.sleepScore !== null ||
          row.weightKg !== null,
      )
      // La plus récente d'abord : c'est la nuit dernière qui répond à la
      // question posée, et le modèle lit le haut de la liste en premier.
      .reverse()
      .map((row) => ({
        date: row.day,
        restingHrBpm: row.restingHrBpm,
        hrvRmssdMs: row.hrvRmssdMs,
        hrvSdnnMs: row.hrvSdnnMs,
        sleepTimeS: row.sleepTimeS,
        sleepScore: row.sleepScore,
        weightKg: row.weightKg,
      })),
  };
}

/**
 * Les `limit` sorties les plus récentes **antérieures** à l'activité donnée, du
 * même sport et de distance voisine (±{@link COMPARABLE_DISTANCE_TOLERANCE}).
 *
 * C'est le point de comparaison qui permet au coach de dire « plus rapide que
 * tes trois dernières sorties du même format » sans rien extrapoler. Liste vide
 * s'il n'y a pas d'athlète, si l'activité n'est pas la sienne (anti-IDOR :
 * même réponse que si elle n'existait pas), ou si rien n'est comparable.
 */
export async function getComparableActivities(
  activityId: number,
  limit = 5,
): Promise<ComparableActivityDto[]> {
  if (limit <= 0) return [];

  // Lecture de **requête** uniquement (le feedback d'activité) : l'athlète vient
  // de la session.
  const profile = await getCurrentAthlete();
  if (!profile) return [];

  const referenceRows = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, profile.id)))
    .limit(1);

  const reference = referenceRows[0];
  if (!reference) return [];

  const rows = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, profile.id),
        eq(activities.sportType, reference.sportType),
        // Antérieures à la séance analysée : le feedback la situe dans son
        // passé, pas dans un historique qui la contiendrait elle-même.
        lt(activities.startedAt, reference.startedAt),
        gte(activities.distanceM, reference.distanceM * (1 - COMPARABLE_DISTANCE_TOLERANCE)),
        lte(activities.distanceM, reference.distanceM * (1 + COMPARABLE_DISTANCE_TOLERANCE)),
      ),
    )
    .orderBy(desc(activities.startedAt))
    .limit(limit);

  return rows.map((row) => toComparableActivityDto(row, profile));
}
