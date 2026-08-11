import 'server-only';

/**
 * Génération et modification d'un plan d'entraînement par le coach IA.
 *
 * Le service orchestre, il ne décide pas : la fenêtre du plan est arithmétique
 * ({@link planWindow}), le contrat de sortie appartient à `plan-schema.ts`, et
 * l'écriture appartient au DAL. Ce qui vit ici, ce sont les prompts et la boucle
 * de correction.
 *
 * ## La boucle de correction, et pourquoi elle est bornée
 *
 * La grammaire garantit la forme, pas le sens : le modèle peut rendre un JSON
 * impeccable qui compte onze semaines au lieu de douze. On lui renvoie alors la
 * liste des violations, en français, et on regénère — au plus
 * {@link MAX_ATTEMPTS} fois au total.
 *
 * La même boucle rattrape les sorties **hors schéma**. Les invariants croisés
 * d'une étape (exactement une mesure, allure ou zone cardiaque mais pas les
 * deux, bornes d'allure ordonnées) ne s'expriment pas dans la grammaire GBNF :
 * ils tombent en Zod, et une seule étape fautive sur les deux cent cinquante
 * d'un plan de douze semaines suffirait à tout perdre. Le message de reprise
 * porte alors les chemins des champs en défaut, comme il porte ailleurs les
 * violations métier.
 *
 * Chaque rejet est **journalisé** côté serveur, avec sa nature et le détail
 * renvoyé au modèle : l'UI, elle, ne dira jamais qu'« un plan valide n'a pas pu
 * être produit », et sans cette trace un échec en production n'est pas
 * diagnosticable.
 *
 * ## Budget de contexte
 *
 * 32 k de contexte, partagés entre le prompt et la **sortie** — et un plan de
 * douze semaines fait déjà plusieurs milliers de tokens à écrire.
 *
 * Le poste le plus lourd est la méthodologie ({@link COACH_RULES}, ~1 500
 * tokens), et c'est le seul qui vaut son prix : sans elle, le modèle produit un
 * plan bien formé et sans logique d'entraînement. Tout le reste est compté au
 * plus juste — le contexte de l'athlète tient en ~120 tokens, les consignes de
 * la demande en une dizaine de lignes, et le retry n'ajoute que les violations,
 * jamais la sortie fautive (la renvoyer doublerait la facture pour rien). Le
 * prompt de modification y ajoute les séances à venir avec leur déroulé, soit
 * ~40 tokens par séance de qualité.
 */

import { after } from 'next/server';
import type { z } from 'zod';

import { isCivilDate, todayCivilDate } from '@/data/athlete';
import { getTrainingSnapshot, type TrainingSnapshotDto } from '@/data/coach-context';
import { reconcilePlanSessions } from '@/data/plan-reconciliation';
import {
  InvalidPlanError,
  PLAN_LIMITS,
  PlanNotFoundError,
  applyPlanUpdate,
  createPlanWithSessions,
  getActivePlanWithSessions,
  type PlanDto,
  type PlanSessionDto,
  type PlanSettingsPatch,
} from '@/data/plans';
import { civilDaysBetween, isoDayIndex, shiftCivilDate } from '@/lib/dates/civil';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';

import { requireAi } from './availability';
import { chatCompletionJson, type ChatMessage } from './client';
import { AiInvalidOutputError, type AiOutputIssue } from './errors';
import {
  formatCivilDate,
  formatDistanceKm,
  formatDuration,
  formatIsoDay,
  formatPace,
  formatPlanSteps,
  formatTrainingSnapshot,
} from './format';
import {
  PLAN_OUTPUT_BOUNDS,
  mapPlanWeeksToSessions,
  planJsonSchema,
  planOutputSchema,
  planUpdateJsonSchema,
  planUpdateOutputSchema,
  validatePlanBusinessRules,
  type PlanExpectations,
  type PlanUpdateOutput,
  type PlanWeekOutput,
} from './plan-schema';

/** Ce que le formulaire de création soumet au coach. */
export type PlanRequest = {
  goalType: 'race' | 'free';
  goalText: string;
  /** Date civile de la course, exigée par `goalType: 'race'`. */
  raceDate?: string;
  /** Durée voulue, exigée par `goalType: 'free'` (une course la déduit de sa date). */
  weeks?: number;
  sessionsPerWeek: number;
  weeklyTimeMinutes?: number;
  /** Jour ISO de la sortie longue : 1 = lundi … 7 = dimanche. */
  longRunDay: number;
  /**
   * Premier jour du programme, choisi par l'athlète. Absent : le prochain lundi
   * ({@link nextPlanStart}). Un lundi dans les deux cas — cf. {@link planStart}.
   */
  startsOn?: string;
};

/** La fenêtre calendaire que le plan couvrira. */
export type PlanWindow = { startsOn: string; weeks: number };

/**
 * Sous ce nombre de semaines, un plan de course ne se périodise pas : il ne
 * reste plus de place pour un développement suivi d'un affûtage.
 */
export const MIN_RACE_PLAN_WEEKS = 3;

/**
 * Au-delà, le modèle ne produit plus un plan d'un seul tenant (cf.
 * {@link PLAN_OUTPUT_BOUNDS}). Repris ici sous un nom que le formulaire peut
 * importer pour borner son champ date sans connaître le contrat de sortie.
 */
export const MAX_PLAN_WEEKS = PLAN_OUTPUT_BOUNDS.weeksPerPlan.max;

/** Température basse : on veut un plan reproductible, pas de la créativité. */
const PLAN_TEMPERATURE = 0.3;

/**
 * Nombre total de générations tentées, reprises comprises (cf. l'en-tête).
 *
 * Arbitrage : sur un modèle local de 6 Go, chaque tentative coûte des minutes
 * d'attente devant l'écran — mais un abandon en coûte davantage, puisqu'il faut
 * alors tout resoumettre à la main pour repartir de zéro. Deux reprises restent
 * dans l'ordre de grandeur d'une génération lente, et rattrapent le cas
 * fréquent d'un petit modèle qui corrige une faute en en introduisant une autre.
 */
const MAX_ATTEMPTS = 3;

/**
 * Premier jour du plan **par défaut** : le prochain lundi, ou aujourd'hui si
 * l'on est déjà lundi. L'athlète peut lui préférer un lundi plus lointain
 * (`PlanRequest.startsOn`), jamais un autre jour de la semaine.
 *
 * Deux raisons de partir un lundi plutôt que demain : le volume hebdomadaire ne
 * se compare qu'entre semaines pleines, et l'alignement sur la semaine ISO fait
 * coïncider les semaines du plan avec celles des statistiques déjà affichées.
 * Un plan demandé un mardi commence donc dans six jours — la semaine en cours
 * est déjà entamée, la remplir a posteriori n'aurait pas de sens.
 */
export function nextPlanStart(today: string): string {
  const index = isoDayIndex(today);
  return index === 0 ? today : shiftCivilDate(today, 7 - index);
}

/**
 * Premier jour du programme : celui que l'athlète a choisi, sinon le prochain
 * lundi.
 *
 * Un plan démarre **toujours un lundi**, et ce n'est pas une préférence de
 * présentation : le `day` d'une séance produite par le modèle est un jour ISO
 * (1 = lundi), et `mapPlanWeeksToSessions` le pose à `startsOn + (day − 1)`.
 * Partir un mercredi placerait la sortie longue « du dimanche » un mardi, sans
 * que rien ne le signale — un plan faux et muet sur son défaut.
 *
 * @throws {InvalidPlanError} date inexploitable, passée, ou qui n'est pas un
 * lundi.
 */
function planStart(request: PlanRequest, today: string): string {
  const { startsOn } = request;
  if (startsOn === undefined) return nextPlanStart(today);

  if (!isCivilDate(startsOn)) {
    throw new InvalidPlanError('startsOn', 'Début du programme : format AAAA-MM-JJ attendu.');
  }
  if (startsOn < today) {
    throw new InvalidPlanError('startsOn', "Le programme ne peut pas démarrer dans le passé.");
  }
  if (isoDayIndex(startsOn) !== 0) {
    throw new InvalidPlanError('startsOn', 'Le programme démarre un lundi : choisis un lundi.');
  }
  return startsOn;
}

/**
 * Fenêtre du plan, à partir de l'objectif.
 *
 * Pour une course, la durée se **déduit** de la date : le nombre de semaines
 * entamées entre le départ du plan et le jour de la course, celui-ci compris —
 * sans le `+ 1`, une course tombant un lundi sortirait de la fenêtre du plan
 * censé y mener.
 *
 * @throws {InvalidPlanError} date de démarrage inexploitable ({@link planStart}),
 * date de course absente/invalide, course trop proche
 * ({@link MIN_RACE_PLAN_WEEKS}) ou trop lointaine ({@link MAX_PLAN_WEEKS}), ou
 * durée manquante pour un objectif libre.
 */
export function planWindow(request: PlanRequest, today: string): PlanWindow {
  const startsOn = planStart(request, today);

  if (request.goalType === 'race') {
    const { raceDate } = request;
    if (raceDate === undefined || !isCivilDate(raceDate)) {
      throw new InvalidPlanError('raceDate', 'Un objectif « course » exige la date de la course.');
    }

    const weeks = Math.ceil((civilDaysBetween(startsOn, raceDate) + 1) / 7);
    if (weeks < MIN_RACE_PLAN_WEEKS) {
      throw new InvalidPlanError(
        'raceDate',
        `La course est dans moins de ${MIN_RACE_PLAN_WEEKS} semaines : c'est trop court pour périodiser un plan.`,
      );
    }
    // Rabattre silencieusement sur le maximum rendrait un plan qui s'arrête des
    // semaines avant la course qu'il prépare — un plan faux, et muet sur son
    // défaut. La date est refusée, avec la raison.
    if (weeks > MAX_PLAN_WEEKS) {
      throw new InvalidPlanError(
        'raceDate',
        `Course trop lointaine : elle est dans ${weeks} semaines, un plan en couvre ${MAX_PLAN_WEEKS} au plus.`,
      );
    }
    return { startsOn, weeks };
  }

  const { weeks } = request;
  if (weeks === undefined || !Number.isInteger(weeks) || weeks < PLAN_LIMITS.weeks.min) {
    throw new InvalidPlanError('weeks', 'Un objectif libre exige une durée en semaines.');
  }
  // Plafonnée à ce que le modèle peut réellement produire d'un seul tenant.
  return { startsOn, weeks: Math.min(weeks, MAX_PLAN_WEEKS) };
}

/*
 * Prompts. Exportés pour que les tests vérifient ce qui part réellement au
 * modèle — les données chiffrées attendues, et rien d'autre.
 */

/**
 * La méthodologie du coach, commune à la création et à la modification.
 *
 * C'est le cœur de la qualité des plans produits : un petit modèle sait écrire
 * du JSON, il ne sait pas *entraîner*. Le contenu reprend donc les références
 * établies du métier — distribution polarisée (Seiler), typologie des allures
 * (Daniels), progression et affûtage — sous une forme prescriptive et chiffrée,
 * la seule qu'un modèle de cette taille applique fidèlement.
 *
 * Dense par nécessité : ~900 tokens partagés avec la sortie sur les 32 k du
 * modèle cible. Chaque ligne doit changer une décision du plan ; les
 * explications physiologiques, elles, n'en changent aucune et n'y sont pas.
 */
const COACH_RULES = [
  "Tu es un coach de course à pied francophone. Tu appliques les méthodes établies de l'entraînement en endurance (distribution polarisée de Seiler, typologie des allures de Daniels, périodisation), et tu cales chaque plan sur le niveau réel de l'athlète — jamais sur un modèle générique.",
  '',
  'RÉPARTITION DE LA CHARGE',
  "- Distribution polarisée : environ 80 % du volume hebdomadaire en endurance fondamentale (zones FC 1-2, allure de conversation), 20 % au plus en intensité.",
  "- Au plus 2 séances de qualité par semaine — une seule si le volume récent est faible ou l'athlète en reprise. Jamais deux jours de suite : une séance dure est toujours suivie d'un jour facile ou de repos.",
  "- Une seule sortie longue par semaine, le jour imposé par l'athlète, et c'est la plus longue séance de sa semaine (environ 25 à 30 % du volume hebdomadaire).",
  '- Un seul entraînement par jour, `day` valant 1 pour lundi jusqu\'à 7 pour dimanche.',
  '',
  'TYPOLOGIE DES SÉANCES — `kind` est choisi dans ce vocabulaire',
  "- « Endurance fondamentale » : footing à allure de conversation, l'ossature du plan.",
  '- « Sortie longue » : endurance fondamentale, progressive si utile (dernier tiers un peu plus rapide), avec un bloc à allure objectif quand la course approche.',
  "- « Seuil » : allure tenable environ 1 h, en continu 20 à 40 min ou en blocs de 8 à 15 min séparés de 1 à 3 min de trot. Développe l'endurance à haute intensité.",
  "- « VMA » : intervalles de 3 à 5 min à environ l'allure 5 km, récupération trottée de durée voisine de l'effort, 4 à 6 répétitions. Développe la puissance aérobie.",
  "- « Répétitions » : 200 à 400 m plus rapides que l'allure 5 km, récupération complète (2 à 3 fois la durée de l'effort). Travaille la vitesse et l'économie de course, pas la filière aérobie — jamais en volume.",
  '- « Récupération » : footing court très souple, ou repos.',
  '',
  'DÉROULÉ STRUCTURÉ (`steps`) — obligatoire pour toute séance de qualité',
  "- Une séance de qualité s'écrit : échauffement progressif de 10 à 20 min, puis le corps de séance en blocs répétés, puis un retour au calme de 5 à 10 min.",
  '- `steps` est une suite de blocs. Un bloc = `repeat` (1 par défaut) × la liste `steps` de ses étapes. Un bloc ne contient pas de bloc : « 6 × (400 m + récup 90 s) » est un bloc de deux étapes répété 6 fois.',
  "- Tout bloc répété contient la récupération de l'effort (`role: 'recover'`) : sans elle, la séance décrite n'est pas celle qui sera courue.",
  "- Une étape porte : `role` ('warmup', 'run', 'recover', 'cooldown'), exactement UNE mesure (`distanceM` en mètres OU `durationS` en secondes, jamais les deux), et AU PLUS une cible (`paceMinSecPerKm` avec `paceMaxSecPerKm`, en secondes par kilomètre, OU `hrZone` de 1 à 5, jamais les deux). Un footing peut n'avoir aucune cible.",
  "- Une séance d'endurance simple se réduit à un bloc d'une étape ; elle peut aussi n'avoir aucun `steps`.",
  '',
  'ALLURES CIBLES — dérivées des seules données fournies',
  "- Référence = « Allure moyenne des dernières sorties » du contexte. Ce n'est pas une allure de tempo : c'est l'allure d'entraînement courante de l'athlète, donc à peu près son allure d'endurance, puisque l'essentiel de son volume est couru en endurance. Toutes les allures s'en déduisent, en secondes par kilomètre (un nombre plus petit est plus rapide) :",
  "  · endurance fondamentale et sortie longue : référence + 0 à 15 s/km — la référence EST déjà l'allure d'endurance, ne ralentis pas l'athlète artificiellement ;",
  '  · seuil : référence − 30 à 45 s/km ;',
  '  · VMA : référence − 60 à 80 s/km ;',
  '  · répétitions courtes : référence − 80 à 100 s/km ;',
  '  · récupération trottée : référence + 60 à 120 s/km, ou aucune cible.',
  "- Ces écarts sont des maxima prudents : reste dans le bas de la fourchette si le volume récent est faible, si la charge (TSB) est très négative, ou si l'historique est court.",
  "- La VO2max estimée et les zones FC servent à vérifier la cohérence de ces allures, jamais à en fabriquer une.",
  "- Si l'allure de référence est inconnue, tu ne cibles AUCUNE allure : tu cibles par `hrZone` (endurance et sortie longue Z2, seuil Z4, VMA Z5, récupération Z1) et tu le dis dans le résumé.",
  "- Si l'objectif porte un chiffre (« 10 km sous 50 min » vaut 5:00/km), cette allure objectif est l'ancre des séances de spécificité à l'approche de la course. Confronte-la à l'allure récente : si elle est bien plus rapide que ce que les données soutiennent, le plan reste ancré sur les données et tu le dis honnêtement dans le résumé.",
  "- Tu n'inventes jamais une valeur : ce que les données ne permettent pas d'établir, tu le laisses vide ou tu l'écris dans le résumé. Si la charge d'entraînement n'est pas calculable, tu pars d'un volume délibérément conservateur et tu le dis.",
  '',
  'PROGRESSION',
  "- Le volume hebdomadaire n'augmente jamais de plus de 10 % d'une semaine à l'autre.",
  '- Une semaine allégée (−20 à −30 % de volume) toutes les 3 à 4 semaines.',
  "- La spécificité croît vers l'objectif : le travail se rapproche de l'allure de course à mesure que la course approche.",
  "- Affûtage avant une course : environ 7 à 10 jours pour un 5 ou 10 km, 10 à 14 jours pour un semi-marathon, 2 à 3 semaines pour un marathon. Volume nettement réduit, intensité maintenue — séances plus courtes, mêmes allures.",
  '',
  'FORMAT',
  "- Tu travailles EXCLUSIVEMENT en système métrique : distances en mètres et en kilomètres, allures en secondes par kilomètre. Jamais de miles, jamais de min/mile — 10:00/mile n'est pas une allure de ce plan.",
  '- Au niveau de la séance : `distanceKm` en kilomètres, `durationMin` en minutes, `targetPaceSecPerKm` en secondes par kilomètre. Dans `steps` : mètres et secondes.',
  "- Toute séance qui porte un `steps` déclare AUSSI sa distance totale estimée au niveau de la séance (`distanceKm`, échauffement et récupérations comprises) : c'est cette valeur qui sert à comparer le volume des séances entre elles.",
  "- Le résumé (`summary`) fait 3 à 5 phrases : la logique du bloc, la progression prévue, les points de vigilance. Tout en français.",
].join('\n');

/** Les contraintes déclarées par l'athlète, en une ligne lisible. */
function formatConstraints(request: {
  sessionsPerWeek: number;
  weeklyTimeMinutes?: number | null;
  longRunDay: number;
}): string {
  const parts = [
    `${request.sessionsPerWeek} séances par semaine`,
    `sortie longue le ${formatIsoDay(request.longRunDay)}`,
  ];
  if (request.weeklyTimeMinutes !== undefined && request.weeklyTimeMinutes !== null) {
    parts.push(`${formatDuration(request.weeklyTimeMinutes * 60)} d'entraînement par semaine au plus`);
  }
  return parts.join(' · ');
}

/** Les messages d'une génération de plan. */
export function buildPlanMessages(
  request: PlanRequest,
  window: PlanWindow,
  snapshot: TrainingSnapshotDto,
): ChatMessage[] {
  const endsOn = shiftCivilDate(window.startsOn, window.weeks * 7 - 1);

  const lines = [
    request.goalType === 'race' && request.raceDate !== undefined
      ? `Objectif : la course « ${request.goalText} », le ${formatCivilDate(request.raceDate)}.`
      : `Objectif : ${request.goalText}.`,
    `Plan à produire : ${window.weeks} semaines, du ${formatCivilDate(window.startsOn)} au ${formatCivilDate(endsOn)}.`,
    `Contraintes : ${formatConstraints(request)}.`,
    '',
    `État de l'athlète au ${snapshot.today} :`,
    formatTrainingSnapshot(snapshot),
    '',
    `Rends les ${window.weeks} semaines dans l'ordre chronologique : weeks[0] est la semaine du ${formatCivilDate(window.startsOn)}. Chaque semaine compte exactement ${request.sessionsPerWeek} séances.`,
  ];

  return [
    { role: 'system', content: COACH_RULES },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * Une séance à venir, en une ligne compacte (~25 tokens), plus une seconde
 * ligne pour son déroulé quand elle en porte un.
 *
 * Le déroulé n'est pas un détail d'affichage ici : sans lui, le modèle réécrit
 * « Seuil — 3 × 8 min » à l'aveugle et perd l'échauffement, les récupérations et
 * les allures déjà calées. Avec lui, il ajuste ce qui existe.
 */
function formatUpcomingSession(session: PlanSessionDto, weekStart: string): string {
  const day = formatIsoDay(civilDaysBetween(weekStart, session.scheduledOn) + 1);
  const details: string[] = [];
  if (session.volumeM !== null) details.push(formatDistanceKm(session.volumeM));
  if (session.durationS !== null) details.push(formatDuration(session.durationS));
  if (session.targetPaceSecPerKm !== null) details.push(formatPace(session.targetPaceSecPerKm));

  const suffix = details.length > 0 ? ` (${details.join(' · ')})` : '';
  const line = `- ${day} : ${session.kind} — ${session.title}${suffix}`;
  return session.steps === null ? line : `${line}\n  déroulé : ${formatPlanSteps(session.steps)}`;
}

/**
 * Le plan en cours, condensé : ses réglages et ses seules séances à venir,
 * groupées par semaine.
 *
 * Ni les séances passées ni les séances réalisées : elles ne sont pas
 * replanifiables, et les envoyer coûterait la moitié du budget de contexte pour
 * une information que le modèle n'a pas le droit d'utiliser.
 */
export function formatUpcomingPlan(
  plan: PlanDto,
  upcoming: readonly PlanSessionDto[],
  window: RemainingPlanWindow,
): string {
  const lines: string[] = [];

  for (let index = 0; index < window.weeks; index += 1) {
    const weekStart = shiftCivilDate(window.firstWeekStart, index * 7);
    const weekEnd = shiftCivilDate(weekStart, 6);
    const sessions = upcoming.filter(
      (session) => session.scheduledOn >= weekStart && session.scheduledOn <= weekEnd,
    );

    const partial = index === 0 && window.firstWeekFromDay > 1;
    lines.push(
      `Semaine ${index + 1} (du ${formatCivilDate(weekStart)}${partial ? `, déjà entamée : à replanifier à partir du ${formatIsoDay(window.firstWeekFromDay)}` : ''}) :`,
    );
    if (sessions.length === 0) {
      lines.push('- aucune séance planifiée');
      continue;
    }
    for (const session of sessions) lines.push(formatUpcomingSession(session, weekStart));
  }

  const header = [
    `Plan en cours : « ${plan.goalText} »${plan.raceDate === null ? '' : `, course le ${formatCivilDate(plan.raceDate)}`}.`,
    `Réglages actuels : ${formatConstraints(plan)}.`,
    `Séances restantes (${window.weeks} semaines) :`,
  ];

  return [...header, ...lines].join('\n');
}

/** Les messages d'une modification par instruction. */
export function buildPlanUpdateMessages(
  plan: PlanDto,
  upcoming: readonly PlanSessionDto[],
  window: RemainingPlanWindow,
  instruction: string,
): ChatMessage[] {
  const system = [
    COACH_RULES,
    '',
    "Tu modifies un plan existant : tu ne régénères que les semaines restantes, weeks[0] étant la première semaine restante. Le passé de l'athlète ne se réécrit pas.",
    "Les séances à venir te sont données avec leur déroulé. Tu réécris chaque séance en entier, `steps` compris : ce que l'instruction ne remet pas en cause, tu le reconduis tel quel — la progression déjà calée n'est pas à refaire.",
    "Si l'instruction change une contrainte durable (nombre de séances, jour de la sortie longue, temps hebdomadaire), reporte-la dans `settings` ; sinon, omets `settings`.",
    "Le résumé décrit le plan modifié dans son ensemble, pas la modification.",
  ].join('\n');

  const user = [
    formatUpcomingPlan(plan, upcoming, window),
    '',
    `Instruction de l'athlète : « ${instruction.trim()} »`,
    '',
    `Rends les ${window.weeks} semaines restantes dans l'ordre chronologique, en appliquant l'instruction.`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Le message de reprise : les violations, telles que le modèle doit les corriger.
 *
 * Plafonné comme {@link buildSchemaIssuesMessage}, et pour la même raison : un
 * modèle qui oublie la sortie longue de chaque semaine produit une violation
 * par semaine, et deux reprises non plafonnées (3 tentatives) grossiraient le
 * prompt au point d'exposer la tentative corrective à la troncature — celle-là
 * même qu'elle est censée réparer.
 */
export function buildViolationsMessage(violations: readonly string[]): string {
  const reported = violations.slice(0, MAX_REPORTED_ISSUES);
  const remainder = violations.length - reported.length;
  return [
    'Ce plan ne respecte pas les contraintes demandées :',
    ...reported.map((violation) => `- ${violation}`),
    ...(remainder > 0 ? [`… et ${remainder} autres violations du même ordre.`] : []),
    'Régénère le plan complet en corrigeant ces points, dans le même format.',
  ].join('\n');
}

/**
 * Combien d'anomalies de schéma partent au modèle.
 *
 * Une seule étape mal formée en produit déjà plusieurs (le champ, puis
 * l'invariant croisé), et un modèle qui se trompe de convention sur tout un plan
 * en produirait des centaines — de quoi noyer le budget de contexte pour dire
 * dix fois la même chose. Les premières suffisent à faire comprendre la faute.
 */
const MAX_REPORTED_ISSUES = 10;

/**
 * Le message de reprise sur sortie **hors schéma** : les champs en défaut, avec
 * leur chemin.
 *
 * Même mécanique que {@link buildViolationsMessage}, pour une faute d'une autre
 * nature : là, le plan est bien formé mais mal pensé ; ici, une étape ne
 * respecte pas le contrat (deux mesures, une allure ET une zone, des bornes
 * inversées). Le chemin est ce qui rend la correction possible — « weeks.3…
 * .steps.1 » désigne l'étape à reprendre parmi les deux cent cinquante du plan.
 */
export function buildSchemaIssuesMessage(issues: readonly AiOutputIssue[]): string {
  const listed = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `- ${issue.path.join('.') || '(racine)'} : ${issue.message}`);

  if (issues.length > MAX_REPORTED_ISSUES) {
    listed.push(`- … et ${issues.length - MAX_REPORTED_ISSUES} autres anomalies du même ordre.`);
  }

  return [
    // Aucune anomalie listée : le contenu n'était même pas du JSON (cf.
    // `AiInvalidOutputError`), il n'y a pas de champ à désigner.
    listed.length === 0
      ? "Ta réponse n'était pas du JSON exploitable."
      : 'Ta réponse ne respecte pas le format demandé, ces champs sont en défaut :',
    ...listed,
    'Régénère le plan complet en corrigeant ces points, dans le même format.',
  ].join('\n');
}

/*
 * Génération.
 */

type GenerationOptions<T> = {
  messages: ChatMessage[];
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  /** Les semaines produites, quelle que soit la forme de l'enveloppe. */
  weeksOf: (output: T) => PlanWeekOutput[];
  /**
   * Ce que la sortie doit respecter. Calculé **depuis la sortie** : une
   * modification peut changer les réglages du plan, et c'est alors sur les
   * réglages patchés qu'il faut la juger.
   */
  expectationsOf: (output: T) => PlanExpectations;
  /**
   * Allure d'entraînement récente de l'athlète, en s/km, `null` si inconnue :
   * l'ancre dont le prompt fait dériver toutes les allures prescrites, et la
   * seule référence qui permette d'en juger la plausibilité (cf.
   * `validatePlanBusinessRules`). Vient du snapshot, des deux côtés.
   */
  referencePaceSecPerKm: number | null;
};

/**
 * Ce qu'on soupçonne quand une sortie hors schéma ne porte **aucune** anomalie
 * Zod : le contenu n'était même pas du JSON (cf. {@link AiInvalidOutputError}).
 *
 * Sur llama.cpp, ce n'est presque jamais un modèle qui répond en texte libre —
 * la grammaire GBNF le lui interdit token par token — mais une génération
 * **coupée en plein JSON**. `chatCompletionJson` n'envoie pas de `max_tokens` :
 * le serveur s'arrête donc de lui-même, en butant sur la fin du contexte. C'est
 * la première piste à vérifier en production.
 */
const TRUNCATION_HINT = 'sortie probablement tronquée (contexte plein ?)';

/**
 * Journalise une tentative rejetée, avec ce qui est renvoyé au modèle.
 *
 * L'utilisatrice, elle, ne verra qu'un message générique : sans cette trace, un
 * échec de génération en production n'est rattachable à rien — ni au schéma, ni
 * aux règles d'entraînement, ni à un contexte saturé.
 */
function logRejectedAttempt(
  attempt: number,
  schemaName: string,
  nature: string,
  detail: string,
): void {
  console.error(
    `[plan] tentative ${attempt}/${MAX_ATTEMPTS} (${schemaName}) rejetée — ${nature} :\n${detail}`,
  );
}

/**
 * Génère, vérifie le contrat **et** les règles métier, et reprend en cas de
 * manquement — quel qu'en soit le genre — dans la limite de
 * {@link MAX_ATTEMPTS} tentatives.
 *
 * Les deux échecs se rattrapent de la même façon parce qu'ils ont la même
 * cause : un petit modèle qui a mal lu une consigne. Seul le message de reprise
 * diffère, selon qu'on lui reproche un champ ou une décision d'entraîneur.
 *
 * Les autres erreurs du socle IA remontent immédiatement : un coach injoignable
 * ({@link AiUnavailableError}) ou une réponse HTTP cassée
 * ({@link AiResponseError}) ne s'arrangeront pas en redemandant.
 *
 * @throws {AiInvalidOutputError} si la dernière tentative reste hors schéma (
 * l'erreur d'origine, avec ses anomalies) ou viole encore les règles métier —
 * le message porte alors la liste, pour que l'UI dise ce qui n'a pas pu être
 * respecté plutôt qu'« erreur ».
 */
async function generateWithBusinessRules<T>(options: GenerationOptions<T>): Promise<T> {
  const messages = [...options.messages];
  let violations: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let output: T;
    try {
      output = await chatCompletionJson<T>({
        messages,
        schemaName: options.schemaName,
        jsonSchema: options.jsonSchema,
        schema: options.schema,
        temperature: PLAN_TEMPERATURE,
      });
    } catch (error) {
      if (!(error instanceof AiInvalidOutputError)) throw error;

      const reprise = buildSchemaIssuesMessage(error.issues);
      logRejectedAttempt(
        attempt,
        options.schemaName,
        error.issues.length === 0 ? `sortie hors schéma — ${TRUNCATION_HINT}` : 'sortie hors schéma',
        reprise,
      );

      if (attempt === MAX_ATTEMPTS) {
        console.error(
          `[plan] génération abandonnée après ${MAX_ATTEMPTS} tentatives (${options.schemaName}) : ${error.message}`,
        );
        throw error;
      }
      messages.push({ role: 'user', content: reprise });
      continue;
    }

    violations = validatePlanBusinessRules(
      options.weeksOf(output),
      options.expectationsOf(output),
      options.referencePaceSecPerKm,
    );
    if (violations.length === 0) return output;

    const reprise = buildViolationsMessage(violations);
    logRejectedAttempt(attempt, options.schemaName, 'violations métier', reprise);

    if (attempt < MAX_ATTEMPTS) {
      messages.push({ role: 'user', content: reprise });
    }
  }

  console.error(
    `[plan] génération abandonnée après ${MAX_ATTEMPTS} tentatives (${options.schemaName}) : violations métier non corrigées.`,
  );
  throw new AiInvalidOutputError(
    `Le coach n'est pas parvenu à respecter les contraintes du plan : ${violations.join(' ')}`,
  );
}

/**
 * Les deux effets de bord qui suivent toute écriture de plan : rapprocher les
 * séances des activités déjà en base, et republier le calendrier intervals.icu.
 *
 * Pourquoi le rapprochement : une séance (re)générée sur un jour déjà couru doit
 * s'afficher « réalisée », pas « manquée ». Les sorties du passé, elles, sont en
 * base depuis longtemps — personne ne les réimportera, donc rien d'autre ne
 * posera ce lien.
 *
 * Aucun des deux ne remonte : le plan est écrit et valide. Un rapprochement raté
 * se rattrape au prochain import ou au prochain ajustement, une synchronisation
 * ratée à la prochaine écriture. Les deux sont journalisés — faire échouer une
 * génération de plusieurs minutes pour cela serait pire.
 *
 * Les deux ne sont pas attendus de la même façon, et c'est délibéré :
 *
 * - le **rapprochement** reste dans le fil de la requête, parce que son résultat
 *   conditionne ce que la page re-rendue affiche (« réalisée » plutôt que
 *   « manquée ») ;
 * - la **synchronisation** part en {@link after} : elle n'a aucune influence sur
 *   la réponse, et intervals.icu injoignable au niveau TCP coûte jusqu'à trois
 *   fois trente secondes de délai de garde — autant de spinner pour un plan déjà
 *   écrit en base.
 */
async function afterPlanWritten(planId: number): Promise<void> {
  try {
    await reconcilePlanSessions(planId);
  } catch (error) {
    console.error(`[plan] rapprochement des séances du plan ${planId} impossible :`, error);
  }

  // Le catch vit dans le module de synchronisation : les trois points de
  // branchement (création, ajustement, archivage) partagent la même garde.
  after(() => syncPlanToIntervalsSafely(`plan ${planId}`));
}

/**
 * Écrit un plan d'entraînement complet et l'active (le précédent est archivé).
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable.
 * @throws {InvalidPlanError} si la demande ne définit pas une fenêtre valide.
 * @throws {AiInvalidOutputError} si le plan produit reste hors des contraintes
 * après une reprise.
 */
export async function generatePlan(request: PlanRequest): Promise<PlanDto> {
  await requireAi();

  const window = planWindow(request, todayCivilDate());
  const snapshot = await getTrainingSnapshot();

  const output = await generateWithBusinessRules({
    messages: buildPlanMessages(request, window, snapshot),
    schemaName: 'training_plan',
    jsonSchema: planJsonSchema,
    schema: planOutputSchema,
    weeksOf: (plan) => plan.weeks,
    expectationsOf: () => ({
      weeks: window.weeks,
      sessionsPerWeek: request.sessionsPerWeek,
      longRunDay: request.longRunDay,
    }),
    referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm,
  });

  const plan = await createPlanWithSessions({
    goalType: request.goalType,
    goalText: request.goalText,
    raceDate: request.goalType === 'race' ? (request.raceDate ?? null) : null,
    startsOn: window.startsOn,
    weeks: window.weeks,
    sessionsPerWeek: request.sessionsPerWeek,
    weeklyTimeMinutes: request.weeklyTimeMinutes ?? null,
    longRunDay: request.longRunDay,
    summary: output.summary,
    sessions: mapPlanWeeksToSessions(output.weeks, window.startsOn),
  });

  await afterPlanWritten(plan.id);
  return plan;
}

/*
 * Modification.
 */

/** La part du plan qui reste à écrire, à partir d'une date de reprise. */
export type RemainingPlanWindow = {
  /** Premier jour de la première semaine restante — la base du mapping des jours. */
  firstWeekStart: string;
  /** Nombre de semaines restantes, celle en cours comprise. */
  weeks: number;
  /** Jour ISO à partir duquel la première semaine est encore replanifiable. */
  firstWeekFromDay: number;
};

/**
 * Découpe la partie du plan postérieure à `fromDate`, sur **la grille de semaines
 * du plan** (des blocs de 7 jours à partir de `startsOn`, qui est un lundi pour
 * tout plan généré par le coach — les semaines coïncident donc avec les semaines
 * ISO).
 *
 * @throws {InvalidPlanError} si le plan est terminé : il n'y a plus rien à
 * régénérer, et une instruction ne ressuscite pas un plan échu.
 */
export function remainingPlanWindow(
  plan: { startsOn: string; weeks: number },
  fromDate: string,
): RemainingPlanWindow {
  const offset = civilDaysBetween(plan.startsOn, fromDate);
  // Plan qui n'a pas encore commencé : tout est à venir, rien n'est entamé.
  if (offset <= 0) {
    return { firstWeekStart: plan.startsOn, weeks: plan.weeks, firstWeekFromDay: 1 };
  }

  const weekIndex = Math.floor(offset / 7);
  const weeks = plan.weeks - weekIndex;
  if (weeks <= 0) {
    throw new InvalidPlanError(
      'weeks',
      "Ce plan est arrivé à son terme : il n'y a plus de semaine à régénérer.",
    );
  }

  return {
    firstWeekStart: shiftCivilDate(plan.startsOn, weekIndex * 7),
    weeks,
    firstWeekFromDay: offset - weekIndex * 7 + 1,
  };
}

/** Les réglages que la sortie du modèle fait réellement bouger, et rien d'autre. */
function settingsPatch(plan: PlanDto, output: PlanUpdateOutput): PlanSettingsPatch {
  const patch: PlanSettingsPatch = { summary: output.summary };
  const { settings } = output;
  if (settings === undefined) return patch;

  if (settings.sessionsPerWeek !== undefined && settings.sessionsPerWeek !== plan.sessionsPerWeek) {
    patch.sessionsPerWeek = settings.sessionsPerWeek;
  }
  if (settings.longRunDay !== undefined && settings.longRunDay !== plan.longRunDay) {
    patch.longRunDay = settings.longRunDay;
  }
  if (
    settings.weeklyTimeMinutes !== undefined &&
    settings.weeklyTimeMinutes !== plan.weeklyTimeMinutes
  ) {
    patch.weeklyTimeMinutes = settings.weeklyTimeMinutes;
  }
  return patch;
}

/**
 * Applique une instruction en langage naturel au plan actif (« je pars en
 * déplacement la semaine prochaine », « plutôt 3 séances »).
 *
 * La reprise part de **demain** : la séance du jour est en cours ou déjà faite,
 * la déplacer serait au mieux inutile. Les séances déjà réalisées, elles, sont
 * protégées par le DAL ({@link applyPlanUpdate}) — quoi que dise le modèle, il
 * ne réécrit pas le passé.
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable.
 * @throws {PlanNotFoundError} s'il n'y a pas de plan actif.
 * @throws {InvalidPlanError} si le plan est terminé, ou si les séances produites
 * sortent de sa fenêtre.
 * @throws {AiInvalidOutputError} si la sortie reste hors contraintes après reprise.
 */
export async function updatePlanFromInstruction(instruction: string): Promise<PlanDto> {
  await requireAi();

  const active = await getActivePlanWithSessions();
  if (active === null) throw new PlanNotFoundError();

  const fromDate = shiftCivilDate(todayCivilDate(), 1);
  const window = remainingPlanWindow(active.plan, fromDate);
  const upcoming = active.sessions.filter(
    (session) => session.scheduledOn >= fromDate && session.completedActivityId === null,
  );

  // Le prompt de modification ne porte pas le snapshot (le plan à ajuster suffit
  // au modèle), mais les allures qu'il réécrit se jugent sur les mêmes données
  // que celles d'une génération : le snapshot est chargé pour cette seule
  // référence.
  const snapshot = await getTrainingSnapshot();

  const output = await generateWithBusinessRules({
    messages: buildPlanUpdateMessages(active.plan, upcoming, window, instruction),
    schemaName: 'training_plan_update',
    jsonSchema: planUpdateJsonSchema,
    schema: planUpdateOutputSchema,
    weeksOf: (plan) => plan.weeks,
    expectationsOf: (plan) => ({
      weeks: window.weeks,
      sessionsPerWeek: plan.settings?.sessionsPerWeek ?? active.plan.sessionsPerWeek,
      longRunDay: plan.settings?.longRunDay ?? active.plan.longRunDay,
      firstWeekFromDay: window.firstWeekFromDay,
    }),
    referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm,
  });

  // Séances et réglages en une seule transaction : un plan ne doit jamais
  // annoncer des contraintes que son calendrier ne suit pas.
  await applyPlanUpdate(active.plan.id, {
    fromDate,
    sessions: mapPlanWeeksToSessions(output.weeks, window.firstWeekStart),
    settings: settingsPatch(active.plan, output),
  });
  await afterPlanWritten(active.plan.id);

  const refreshed = await getActivePlanWithSessions();
  if (refreshed === null) throw new PlanNotFoundError();
  return refreshed.plan;
}
