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
 * Cette boucle porte aussi le **post-traitement des allures** : quand l'athlète
 * a donné un chrono, la table calculée est appliquée à la sortie entre le parse
 * et la validation métier ({@link applyImposedPaces}) — le modèle n'écrit plus
 * aucune allure, et celles qu'il écrirait quand même sont écrasées. Le pourquoi
 * de ce renversement est en tête de `plan-schema.ts`, avec le constat de
 * production qui l'a imposé.
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
 * Le poste le plus lourd est la méthodologie ({@link coachRules}, ~1 500
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
import type { PlanGoalType, PlanLevel } from '@/data/db/schema';
import { reconcilePlanSessions } from '@/data/plan-reconciliation';
import {
  InvalidPlanError,
  PLAN_LIMITS,
  PlanNotFoundError,
  applyPlanUpdate,
  createDraftPlanWithSessions,
  getActivePlanWithSessions,
  type PlanDto,
  type PlanSessionDto,
  type PlanSettingsPatch,
} from '@/data/plans';
import { civilDaysBetween, isoDayIndex, isoWeekStart, shiftCivilDate } from '@/lib/dates/civil';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';
import {
  InvalidRacePerformanceError,
  REFERENCE_DISTANCES,
  trainingPacesFromRace,
  type ReferenceDistance,
  type TrainingPaces,
} from '@/lib/metrics/vdot';

import { requireAi } from './availability';
import { chatCompletionJson, type ChatMessage } from './client';
import { AiInvalidOutputError, type AiOutputIssue } from './errors';
import { clearPlanProgress, setPlanProgress } from './progress';
import {
  formatCivilDate,
  formatDistanceKm,
  formatDuration,
  formatIsoDay,
  formatNumber,
  formatPace,
  formatPlanSteps,
  formatTrainingPaces,
  formatTrainingSnapshot,
  formatWeeklyVolumeTargets,
} from './format';
import {
  MIN_FIRST_WEEK_DAYS,
  PLAN_OUTPUT_BOUNDS,
  formatPartialWeekTimeBudget,
  goalPaceSecPerKm,
  isIntensitySession,
  isMarathonGoal,
  mapPlanWeeksToSessions,
  planChunkJsonSchema,
  planChunkOutputSchema,
  planJsonSchema,
  planOutputSchema,
  planUpdateChunkJsonSchema,
  planUpdateJsonSchema,
  planUpdateOutputSchema,
  planWeeksPostProcessing,
  resolveWeeklyTimeBudget,
  validatePlanBusinessRules,
  weekVolumeKm,
  weeklyVolumeTargets,
  type PlanChunkOutput,
  type PlanExpectations,
  type PlanRaceGoal,
  type PlanSettingsOutput,
  type PlanValidationContext,
  type PlanWeekOutput,
  type PlanWeeksPostProcessing,
  type WeeklyVolumeTarget,
} from './plan-schema';

/** Ce que le formulaire de création soumet au coach. */
export type PlanRequest = {
  goalType: 'race' | 'free';
  /** Niveau en course déclaré par l'athlète : il choisit la méthodologie appliquée. */
  level: PlanLevel;
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
   * Premier jour du programme, choisi par l'athlète — n'importe quel jour à
   * partir d'aujourd'hui. Absent : aujourd'hui (cf. {@link planStart}).
   */
  startsOn?: string;
  /**
   * Chrono de course récent, s'il y en a un : c'est la donnée qui **calcule** la
   * table d'allures du plan (méthode VDOT), au lieu de la laisser deviner au
   * modèle depuis une allure d'entraînement moyenne.
   */
  referenceRace?: ReferenceRace;
};

/** Un chrono de course : une distance de référence, un temps. */
export type ReferenceRace = { distance: ReferenceDistance; timeS: number };

/**
 * La fenêtre calendaire que le plan couvrira.
 *
 * Deux dates, et elles ne coïncident que sur un départ un lundi : `startsOn` est
 * le jour réel du départ (celui que le DAL stocke, avant lequel aucune séance
 * n'existe), `anchor` est le lundi de sa semaine — la grille sur laquelle les
 * jours ISO produits par le modèle se posent, et celle qui compte les semaines.
 */
export type PlanWindow = {
  /** Premier jour du programme, tel que l'athlète l'a choisi. */
  startsOn: string;
  /** Lundi de la semaine de `startsOn`, base du mapping des jours ISO. */
  anchor: string;
  /** Semaines ISO couvertes depuis l'ancre, la première (parfois entamée) comprise. */
  weeks: number;
  /** Jour ISO à partir duquel la première semaine porte des séances : 1 = lundi. */
  firstWeekFromDay: number;
};

/**
 * Sous ce nombre de semaines, un plan de course ne se périodise pas : il ne
 * reste plus de place pour un développement suivi d'un affûtage.
 *
 * Ce sont des semaines d'entraînement, pas des cases du calendrier : une semaine
 * du départ trop entamée n'en est pas une (cf. {@link firstWeekCountsAsPlanWeek}).
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
 * Plafond de tokens d'une génération de plan — le plus gros poste de sortie de
 * l'application, et de loin.
 *
 * Diagnostic de production : sans `max_tokens` explicite, llama-server applique
 * son `--n-predict` par défaut, bien plus bas que ce que le contexte autorise.
 * Un plan de seize semaines à six séances se faisait donc **couper en plein
 * JSON**, silencieusement — trois tentatives, trois « n'a pas produit du JSON »,
 * sans que rien côté serveur ne signale une troncature. La fenêtre de contexte
 * n'y était pour rien (32 k configurés) ; le plafond de génération, si.
 *
 * Le chiffre : ~3 k de tokens de prompt sur les 32 k du contexte, et le pire
 * plan légitime (16 semaines × 6 séances, `steps` compris) pèse 10 à 12 k tokens
 * de sortie. 24 576 laisse donc le double de la marge nécessaire tout en restant
 * sous le contexte. Ce n'est pas une cible — le modèle s'arrête quand le plan est
 * écrit — mais un garde-fou contre un défaut serveur restrictif.
 */
const PLAN_MAX_OUTPUT_TOKENS = 24_576;

/*
 * Progression affichée.
 *
 * Une génération dure des minutes : l'athlète doit voir avancer quelque chose de
 * **réel**, pas une rotative. La seule mesure disponible à cet instant est le
 * nombre de caractères déjà écrits par le modèle (cf. `onProgress` de
 * `client.ts`) ; il ne devient un pourcentage qu'à condition de savoir combien
 * de caractères la sortie complète en compte. D'où l'estimation ci-dessous.
 */

/**
 * Poids moyen d'une séance dans la sortie JSON, en caractères.
 *
 * Mesuré, pas deviné : la fixture de `plan-service.test.ts` (« calibrage de
 * l'estimation ») sérialise des semaines conformes à la méthodologie en JSON
 * compact — le format que produit une génération contrainte par grammaire — et
 * le test vérifie que l'estimation reste dans ±25 % de leur taille réelle.
 * Refaire la mesure si le schéma de sortie change.
 *
 * Ce qu'elle donne, séance par séance :
 *
 * - séance de qualité, `steps` **obligatoire** (échauffement, blocs répétés avec
 *   récupération, retour au calme, allures aux deux bornes) : **476 à 481** ;
 * - footing ou sortie longue sans `steps`, avec distance, durée et allure
 *   cible : **120 à 123**.
 *
 * La méthodologie plafonne les séances de qualité à 2 par semaine, sur 3 à 5
 * séances : le poids par séance dépend donc du nombre de séances, ce qu'une
 * constante unique ne peut pas rendre. Semaines complètes mesurées, enveloppe
 * comprise, ramenées à la séance :
 *
 *     3 séances (1 qualité) → 742 / 3 ≈ 247
 *     4 séances (2 qualité) → 1219 / 4 ≈ 305
 *     5 séances (2 qualité) → 1341 / 5 ≈ 268
 *
 * D'où **280**, au milieu de cet intervalle — l'écart résiduel va de −8 % à
 * +13 % sur les configurations mesurées, et c'est assumé : l'objectif est une
 * barre plausible, pas une prédiction.
 *
 * Sous-estimer fait plafonner la barre à 99 % avant la fin, surestimer la fait
 * terminer trop bas : les deux se voient, aucun des deux ne ment (le plafond à
 * 99 % garantit qu'on n'annonce jamais « terminé » avant de l'être). Un modèle
 * qui indenterait sa sortie produirait sensiblement plus de caractères et
 * tomberait dans le premier cas.
 */
const CHARS_PER_SESSION = 280;

/**
 * Ce que la sortie coûte en dehors des séances : le résumé (3 à 5 phrases, 449
 * caractères mesurés sur le résumé de la fixture) et l'enveloppe JSON (25).
 * Arrondi au demi-millier supérieur, la marge étant négligeable devant le poids
 * des séances.
 */
const CHARS_OVERHEAD = 500;

/**
 * Taille attendue de la sortie du modèle, en caractères — l'échelle du
 * pourcentage affiché. Exportée pour être éprouvée : une estimation fausse
 * d'un ordre de grandeur donnerait une barre absurde.
 */
export function estimatePlanChars(weeks: number, sessionsPerWeek: number): number {
  return weeks * sessionsPerWeek * CHARS_PER_SESSION + CHARS_OVERHEAD;
}

/**
 * Le pourcentage affiché, **plafonné à 99** : tant que la validation Zod et les
 * règles métier n'ont pas parlé, la génération n'est pas terminée — et une barre
 * à 100 % qui dure encore une minute est pire que pas de barre du tout.
 */
export function planProgressPercent(receivedChars: number, estimatedChars: number): number {
  return Math.min(99, Math.round((100 * receivedChars) / estimatedChars));
}

/**
 * Premier jour du programme : celui que l'athlète a choisi, sinon **aujourd'hui**.
 *
 * N'importe quel jour convient, et c'est le point de la première semaine
 * partielle : le `day` d'une séance produite par le modèle reste un jour ISO
 * (1 = lundi) posé sur `PlanWindow.anchor`, le lundi de la semaine du départ.
 * Un départ un jeudi ne décale donc rien — il retire simplement du lundi au
 * mercredi de la première semaine, que le prompt et
 * {@link validatePlanBusinessRules} traitent comme une semaine entamée.
 *
 * @throws {InvalidPlanError} date inexploitable ou passée.
 */
function planStart(request: PlanRequest, today: string): string {
  const { startsOn } = request;
  if (startsOn === undefined) return today;

  if (!isCivilDate(startsOn)) {
    throw new InvalidPlanError('startsOn', 'Début du programme : format AAAA-MM-JJ attendu.');
  }
  if (startsOn < today) {
    throw new InvalidPlanError('startsOn', "Le programme ne peut pas démarrer dans le passé.");
  }
  return startsOn;
}

/**
 * La semaine du départ vaut-elle une semaine d'entraînement ?
 *
 * Le seuil vit dans `plan-schema.ts` ({@link MIN_FIRST_WEEK_DAYS}), qui l'applique
 * aussi au budget temps d'une semaine entamée : une semaine trop courte pour
 * compter dans le plan l'est aussi pour porter un plafond horaire.
 *
 * Arbitrage : un plan de 8 semaines démarré un samedi laisse deux jours dans la
 * semaine en cours. Les compter pour une semaine d'entraînement en volerait une
 * vraie — l'athlète recevrait 7 semaines pleines là où elle en a demandé 8. Pour
 * une course, la durée reste déduite des dates — mais le même seuil décide si
 * cette semaine-là compte dans le minimum ({@link MIN_RACE_PLAN_WEEKS}) : sans
 * lui, un départ un dimanche ferait passer huit jours de préparation pour trois
 * semaines de plan.
 *
 * Vrai dès qu'il y reste au moins {@link MIN_FIRST_WEEK_DAYS} jours, jour du
 * départ compris — soit un départ du lundi au jeudi. Exporté parce que le
 * formulaire en dépend : `_lib/plan-window.ts` borne son champ « date de
 * course » sur cette même réponse, et deux arithmétiques divergentes
 * proposeraient une date que ce service refuserait ensuite.
 */
export function firstWeekCountsAsPlanWeek(startsOn: string): boolean {
  return 7 - isoDayIndex(startsOn) >= MIN_FIRST_WEEK_DAYS;
}

/**
 * Fenêtre du plan, à partir de l'objectif.
 *
 * Tout se compte depuis l'**ancre** — le lundi de la semaine du départ — pour que
 * les semaines du plan coïncident avec les semaines ISO des statistiques déjà
 * affichées. Un départ en milieu de semaine produit donc une première semaine
 * entamée, qui ne porte des séances qu'à partir du jour du départ.
 *
 * Pour une course, la durée se **déduit** des dates : le nombre de semaines ISO
 * de l'ancre au jour de la course, celui-ci compris — sans le `+ 1`, une course
 * tombant un lundi sortirait de la fenêtre du plan censé y mener.
 *
 * @throws {InvalidPlanError} date de démarrage inexploitable ({@link planStart}),
 * date de course absente/invalide, course trop proche
 * ({@link MIN_RACE_PLAN_WEEKS}) ou trop lointaine ({@link MAX_PLAN_WEEKS}), ou
 * durée manquante pour un objectif libre.
 */
export function planWindow(request: PlanRequest, today: string): PlanWindow {
  const startsOn = planStart(request, today);
  const anchor = isoWeekStart(startsOn);
  const firstWeekFromDay = isoDayIndex(startsOn) + 1;
  const base = { startsOn, anchor, firstWeekFromDay };

  if (request.goalType === 'race') {
    const { raceDate } = request;
    if (raceDate === undefined || !isCivilDate(raceDate)) {
      throw new InvalidPlanError('raceDate', 'Un objectif « course » exige la date de la course.');
    }

    const weeks = Math.ceil((civilDaysBetween(anchor, raceDate) + 1) / 7);
    // La fenêtre garde la semaine entamée (les séances s'y posent), mais le
    // minimum ne la compte que si elle porte de l'entraînement : sinon un départ
    // le dimanche pour une course le lundi suivant ferait un « plan de trois
    // semaines » de huit jours.
    const effectiveWeeks = weeks - (firstWeekCountsAsPlanWeek(startsOn) ? 0 : 1);
    if (effectiveWeeks < MIN_RACE_PLAN_WEEKS) {
      const days = Math.max(civilDaysBetween(startsOn, raceDate), 0);
      throw new InvalidPlanError(
        'raceDate',
        `Le programme ne laisse que ${days} jour${days > 1 ? 's' : ''} avant la course : c'est trop court pour la périodiser (${MIN_RACE_PLAN_WEEKS} semaines au minimum).`,
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
    return { ...base, weeks };
  }

  const { weeks } = request;
  if (weeks === undefined || !Number.isInteger(weeks) || weeks < PLAN_LIMITS.weeks.min) {
    throw new InvalidPlanError('weeks', 'Un objectif libre exige une durée en semaines.');
  }

  // Une semaine entamée trop courte s'ajoute aux semaines demandées plutôt que
  // d'en consommer une (cf. MIN_FIRST_WEEK_DAYS).
  const total = firstWeekCountsAsPlanWeek(startsOn) ? weeks : weeks + 1;
  // Plafonnée à ce que le modèle peut réellement produire d'un seul tenant.
  return { ...base, weeks: Math.min(total, MAX_PLAN_WEEKS) };
}

/*
 * Prompts. Exportés pour que les tests vérifient ce qui part réellement au
 * modèle — les données chiffrées attendues, et rien d'autre.
 */

/**
 * La méthodologie du coach, **hors allures** : tout ce qui vaut avec ou sans
 * table d'allures calculée.
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
const COACH_RULE_HEAD_LINES = [
  "Tu es un coach de course à pied francophone. Tu appliques les méthodes établies de l'entraînement en endurance (distribution polarisée de Seiler, typologie des allures de Daniels, périodisation), et tu cales chaque plan sur le niveau réel de l'athlète — jamais sur un modèle générique.",
  '',
  'RÉPARTITION DE LA CHARGE',
  "- Distribution polarisée : environ 80 % du volume hebdomadaire en endurance fondamentale (zones FC 1-2, allure de conversation), 20 % au plus en intensité.",
  "- Au plus 2 séances de qualité par semaine — une seule si le volume récent est faible ou l'athlète en reprise. Jamais deux jours de suite : une séance dure est toujours suivie d'un jour facile ou de repos.",
  "- Une seule sortie longue par semaine, le jour imposé par l'athlète, et c'est la plus longue séance de sa semaine (20 à 40 % du volume hebdomadaire — le haut de la fourchette quand la semaine ne compte que trois séances).",
  '- Un seul entraînement par jour, `day` valant 1 pour lundi jusqu\'à 7 pour dimanche.',
  '',
  'TYPOLOGIE DES SÉANCES — `kind` est choisi dans ce vocabulaire',
  "- « Endurance fondamentale » : footing à allure de conversation, l'ossature du plan.",
  '- « Sortie longue » : endurance fondamentale, progressive si utile (dernier tiers un peu plus rapide), avec un bloc à allure objectif quand la course approche.',
  "- « Seuil » : allure tenable environ 1 h, en continu 20 à 40 min ou en blocs de 8 à 15 min séparés de 1 à 3 min de trot. Développe l'endurance à haute intensité.",
  "- « VMA » : intervalles de 3 à 5 min à environ l'allure 5 km, récupération trottée de durée voisine de l'effort, 4 à 6 répétitions. Développe la puissance aérobie.",
  "- « Répétitions » : 200 à 400 m plus rapides que l'allure 5 km, récupération complète (2 à 3 fois la durée de l'effort). Travaille la vitesse et l'économie de course, pas la filière aérobie — jamais en volume.",
  // Sans « ou repos » : une séance est une sortie, et le repos c'est l'absence
  // de séance. Le laisser poussait le modèle à écrire une journée de repos comme
  // une séance — donc à lui inventer une distance, la règle de volume exigeant
  // que toute séance déclare la sienne.
  '- « Récupération » : footing court très souple.',
  '',
  'DÉROULÉ STRUCTURÉ (`steps`) — obligatoire pour toute séance de qualité',
  "- Une séance de qualité s'écrit : échauffement progressif de 10 à 20 min, puis le corps de séance en blocs répétés, puis un retour au calme de 5 à 10 min.",
  '- `steps` est une suite de blocs. Un bloc = `repeat` (1 par défaut) × la liste `steps` de ses étapes. Un bloc ne contient pas de bloc : « 6 × (400 m + récup 90 s) » est un bloc de deux étapes répété 6 fois.',
  "- Tout bloc répété contient la récupération de l'effort (`role: 'recover'`) : sans elle, la séance décrite n'est pas celle qui sera courue.",
  "- Une étape porte : `role` ('warmup', 'run', 'recover', 'cooldown'), exactement UNE mesure (`distanceM` en mètres OU `durationS` en secondes, jamais les deux), et AU PLUS une cible (`paceMinSecPerKm` avec `paceMaxSecPerKm`, en secondes par kilomètre, OU `hrZone` de 1 à 5, jamais les deux). Un footing peut n'avoir aucune cible.",
  "- Une séance d'endurance simple se réduit à un bloc d'une étape ; elle peut aussi n'avoir aucun `steps`.",
];

/**
 * La dérivation des allures depuis l'allure moyenne d'entraînement — le
 * **repli**, et lui seul : cette section ne part au modèle que lorsqu'il n'y a
 * pas de table calculée ({@link coachRules}).
 *
 * Ce n'est pas une préférence de rédaction, c'est un constat de production. Tant
 * que les deux sections coexistaient — celle-ci dérivant tout d'une allure
 * d'entraînement lente, la table imposée prescrivant des plages calculées, avec
 * une simple mention de préséance entre elles — le modèle local suivait
 * celle-ci : EF prescrite à 12:00/km sur les trois tentatives quand la table
 * disait 7:57–8:43/km. Un petit modèle ne résout pas une priorité entre deux
 * consignes contradictoires ; il n'en voit donc qu'une.
 */
const DERIVED_PACES_SECTION_LINES = [
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
];

/**
 * Ce que la spécificité veut dire **concrètement** dans une sortie longue, quand
 * le plan mène à une course.
 *
 * La typologie dit déjà « avec un bloc à allure objectif quand la course
 * approche » ; c'est trop vague pour être suivi, et les sorties longues
 * produites sortaient 100 % en endurance. Retour d'utilisation à l'appui :
 * l'athlète comparait avec des plans concurrents qui lui proposaient des
 * passages à ~7:20/km — exactement sa zone M — sur ses sorties longues de
 * préparation semi. La ligne est donc prescriptive et chiffrée, la seule forme
 * qu'un petit modèle applique.
 *
 * La note « allure objectif » n'est pas décorative : c'est elle que
 * {@link applyImposedPaces} reconnaît pour poser sur cette étape-là — au milieu
 * d'une séance qui reste rangée en endurance — l'allure du but chiffré de
 * l'athlète quand il en donne une ({@link goalPaceSecPerKm}), la plage M sinon.
 * Ne pas la changer sans changer `STEP_NOTE_ZONES` dans `plan-schema.ts`.
 */
const RACE_SPECIFIC_LONG_RUN_LINE =
  "- À partir de la moitié du plan, la sortie longue contient un bloc à allure objectif (étape `run` avec note « allure objectif », 10 à 25 % de la distance de la sortie), qui s'allonge de semaine en semaine. L'affûtage le raccourcit sans le supprimer.";

/**
 * La suite de la méthodologie, elle aussi indépendante de la façon dont les
 * allures sont fixées.
 *
 * @param isRace le plan mène-t-il à une course ? Seul ce régime porte la ligne
 * de spécificité de la sortie longue ({@link RACE_SPECIFIC_LONG_RUN_LINE}) : sur
 * un objectif libre, il n'y a pas d'allure objectif à travailler, et prescrire
 * un bloc à une allure qui n'existe pas ferait fabriquer une échéance au modèle.
 */
function coachRuleTailLines(isRace: boolean): string[] {
  return [
    'PROGRESSION DU VOLUME — ces chiffres sont vérifiés séance par séance, un plan qui les enfreint est refusé et à réécrire',
    '- Le volume hebdomadaire est la somme des `distanceKm` de la semaine. TOUTE séance déclare sa distance, footings et récupérations compris : sans elle, la semaine ne se compare à rien.',
    "- D'une semaine à l'autre, le volume n'augmente jamais de plus de 12 %. Vise 5 à 10 % : la marge est un filet, pas une cible. Une baisse est toujours permise.",
    '- Jamais quatre semaines de suite sans semaine allégée : sur toute fenêtre de 4 semaines, au moins une redescend à 85 % ou moins du volume de la semaine précédente (plans de 6 semaines et plus).',
    "- Le plan n'est jamais plat : la semaine la plus chargée hors affûtage dépasse d'au moins 10 % la première semaine pleine (plans de 5 semaines et plus). Douze semaines au même volume ne préparent rien.",
    "- Affûtage avant une course : les 2 dernières semaines (3 pour un marathon, sur un plan de 8 semaines et plus) baissent STRICTEMENT chaque semaine, et la semaine de la course ne dépasse pas 65 % du volume de la semaine la plus chargée. Volume nettement réduit, intensité maintenue — séances plus courtes, mêmes allures.",
    "- La première semaine, quand le plan démarre en cours de semaine, est amputée des jours passés : son volume est plus faible, et ce n'est pas une baisse.",
    // Le défaut constaté : 3 h 30 planifiées pour 2 h déclarées, sans qu'aucune
    // règle ne le voie — les durées n'étaient comparées à rien. Le budget est
    // désormais vérifié semaine par semaine, et il prime sur le volume.
    "- Le temps hebdomadaire déclaré dans les contraintes est une limite DURE, vérifiée semaine par semaine : la somme des `durationMin` d'une semaine (échauffements, récupérations et retours au calme compris) ne le dépasse pas, tolérance de 10 % au plus. Si le volume visé n'y tient pas, c'est le volume qui baisse — pars d'une première semaine plus courte plutôt que de déborder.",
    "- La spécificité croît vers l'objectif : le travail se rapproche de l'allure de course à mesure que la course approche.",
    ...(isRace ? [RACE_SPECIFIC_LONG_RUN_LINE] : []),
    // Vivait dans la section des allures dérivées, dont elle a suivi le sort à
    // l'extraction. Sa moitié utile porte pourtant sur le volume — un plan
    // conservateur quand la charge n'est pas calculable — et vaut donc dans les
    // deux régimes : elle est rattachée ici plutôt que perdue avec la dérivation.
    "- Tu n'inventes jamais une valeur : ce que les données ne permettent pas d'établir, tu le laisses vide ou tu l'écris dans le résumé. Si la charge d'entraînement n'est pas calculable, tu pars d'un volume délibérément conservateur et tu le dis.",
    '',
    'FORMAT',
    "- Tu travailles EXCLUSIVEMENT en système métrique : distances en mètres et en kilomètres, allures en secondes par kilomètre. Jamais de miles, jamais de min/mile — 10:00/mile n'est pas une allure de ce plan.",
    '- Au niveau de la séance : `distanceKm` en kilomètres, `durationMin` en minutes, `targetPaceSecPerKm` en secondes par kilomètre. Dans `steps` : mètres et secondes.',
    // Un exemple plutôt qu'une règle de plus : les reprises constatées en
    // production butent toutes sur la même étape (la récupération d'un bloc
    // répété, écrite avec distance ET durée), alors que l'interdiction est déjà
    // énoncée dans la section DÉROULÉ. Un petit modèle recopie un exemple bien
    // plus fidèlement qu'il n'applique un énoncé abstrait.
    '- Exemple d\'étape de récupération, à recopier tel quel : { "role": "recover", "durationS": 120 } — une mesure, jamais les deux.',
    "- Toute séance qui porte un `steps` déclare AUSSI sa distance totale estimée au niveau de la séance (`distanceKm`, échauffement et récupérations comprises) : c'est cette valeur qui sert à comparer le volume des séances entre elles.",
    "- Le résumé (`summary`) fait 3 à 5 phrases : la logique du bloc, la progression prévue, les points de vigilance. Tout en français.",
    // Diagnostic de production : un plan de 16 semaines rendu en JSON indenté
    // pesait ~40 k caractères et saturait le contexte du serveur, qui coupait la
    // sortie en plein objet. L'indentation n'a aucun lecteur ici — la réponse est
    // parsée, jamais lue — et elle coûte le tiers des caractères d'un plan long.
    '- Réponds en JSON compact, sans indentation ni retours à la ligne — chaque caractère compte.',
  ];
}

/**
 * La méthodologie telle qu'elle part au modèle.
 *
 * @param hasImposedPaces la table d'allures existe-t-elle ? Si oui, la section
 * de dérivation est **entièrement absente** et la table (cf.
 * {@link imposedPacesSection}) est la seule source d'allures du prompt : une
 * consigne absente ne se discute pas, une consigne surchargée si — et c'est
 * exactement ce que le modèle local a tranché de travers en production.
 * @param isRace le plan mène-t-il à une course ? (cf. {@link coachRuleTailLines})
 */
function coachRules(hasImposedPaces: boolean, isRace: boolean): string {
  const tail = coachRuleTailLines(isRace);
  const lines = hasImposedPaces
    ? [...COACH_RULE_HEAD_LINES, '', ...tail]
    : [...COACH_RULE_HEAD_LINES, '', ...DERIVED_PACES_SECTION_LINES, '', ...tail];
  return lines.join('\n');
}

/** Le niveau, tel que les prompts le nomment. */
const LEVEL_LABELS: Record<PlanLevel, string> = {
  beginner: 'débutant',
  intermediate: 'intermédiaire',
  advanced: 'confirmé',
};

/**
 * Ce que le niveau change à la méthodologie — **une seule** de ces sections part
 * au modèle, à la suite de {@link coachRules}.
 *
 * La méthodologie générale reste volontairement générique : elle décrit
 * l'entraînement en endurance, pas un athlète. C'est ici que se prennent les
 * décisions qui dépendent de l'expérience réelle — combien de qualité, quelle
 * longueur de bloc, quelle progression de volume — et les trois sections se
 * lisent comme des surcharges des règles générales, pas comme un rappel.
 *
 * Comptez ~120 tokens : le prix d'un plan qui ne propose pas 3 × 12 min au seuil
 * à quelqu'un qui court depuis six mois.
 */
const LEVEL_RULES: Record<PlanLevel, string> = {
  beginner: [
    "NIVEAU DE L'ATHLÈTE : DÉBUTANT — ces règles priment sur la méthodologie générale.",
    "- La régularité prime sur tout le reste : mieux vaut trois semaines tenues qu'une semaine ambitieuse.",
    "- Le volume hebdomadaire n'augmente que de 5 à 8 % d'une semaine à l'autre, jamais 10 %.",
    "- AU PLUS UNE séance de qualité par semaine, courte et douce : fractionné court type 6 à 8 × 30 s à 1 min vite avec 1 à 2 min de trot. Jamais de bloc de seuil long.",
    "- La sortie longue se court en aisance respiratoire totale ; l'alternance marche/course y est acceptée si l'aisance le demande.",
    '- Échauffement long : 15 à 20 min de footing très souple avant toute séance de qualité.',
    "- L'objectif premier est de finir chaque séance frais, pas fatigué : dans le doute, allège.",
  ].join('\n'),
  intermediate: [
    "NIVEAU DE L'ATHLÈTE : INTERMÉDIAIRE — la méthodologie générale ci-dessus s'applique telle quelle.",
    '- 1 à 2 séances de qualité par semaine selon le volume : une seule si le volume récent est faible, deux quand il est installé.',
    "- Le travail au seuil est introduit avant la VMA longue : à ce stade, c'est lui qui porte la progression.",
    "- Les blocs de seuil restent dans la fourchette générale (8 à 15 min), la VMA dans la sienne (3 à 5 min).",
    "- La sortie longue s'allonge progressivement avant de gagner en intensité.",
  ].join('\n'),
  advanced: [
    "NIVEAU DE L'ATHLÈTE : CONFIRMÉ — ces règles priment sur la méthodologie générale.",
    '- 2 séances de qualité par semaine, 3 ponctuellement sur une semaine de pic si le volume le soutient.',
    '- Blocs de seuil plus longs : 2 à 3 × 8 à 12 min, ou 25 à 40 min en continu.',
    "- VMA structurée : séries complètes de 4 à 6 × 3 à 5 min, récupération calibrée sur la durée de l'effort.",
    "- Séances combinées possibles : sortie longue avec un bloc à allure objectif dans son dernier tiers.",
    "- L'affûtage réduit nettement le volume mais garde une touche d'intensité courte pour rester vif.",
  ].join('\n'),
};

/*
 * Allures imposées.
 */

/**
 * La table d'allures d'un chrono de référence, ou `null` s'il n'y en a pas.
 *
 * Le calcul appartient à `lib/metrics/vdot` ; ici on ne fait que le brancher, et
 * traduire son refus en erreur de champ — le formulaire et le DAL ont déjà écarté
 * un chrono implausible, mais le service n'est pas leur seule porte d'entrée.
 *
 * @throws {InvalidPlanError} si le chrono ne décrit pas une course.
 */
function referenceRacePaces(race: ReferenceRace | undefined): TrainingPaces | null {
  if (race === undefined) return null;

  try {
    return trainingPacesFromRace(REFERENCE_DISTANCES[race.distance], race.timeS);
  } catch (error) {
    if (error instanceof InvalidRacePerformanceError) {
      throw new InvalidPlanError(
        'referenceTimeS',
        'Ce chrono ne ressemble pas à une course — vérifie la saisie.',
      );
    }
    throw error;
  }
}

/**
 * L'objectif du plan tel que les règles de volume le lisent : une course (donc
 * un affûtage à respecter), ou rien.
 *
 * La seule chose que la distance de la course y change est la longueur de
 * l'affûtage, d'où la reconnaissance du seul marathon dans le texte libre de
 * l'objectif ({@link isMarathonGoal}).
 *
 * Exporté pour la révision automatique (`review-service.ts`) : elle juge la
 * suite du plan avec exactement les mêmes attentes qu'un ajustement.
 */
export function raceGoalOf(goalType: PlanGoalType, goalText: string): PlanRaceGoal | null {
  return goalType === 'race' ? { isMarathon: isMarathonGoal(goalText) } : null;
}

/**
 * Le chrono d'un plan déjà écrit, `undefined` s'il n'en porte pas.
 *
 * Les deux colonnes sont solidaires en base (invariant du DAL) ; le `undefined`
 * ne couvre donc que les plans antérieurs au champ, et non un demi-chrono.
 */
export function planReferenceRace(plan: PlanDto): ReferenceRace | undefined {
  if (plan.referenceDistance === null || plan.referenceTimeS === null) return undefined;
  return { distance: plan.referenceDistance, timeS: plan.referenceTimeS };
}

/**
 * La table d'allures d'un plan déjà écrit, `null` s'il n'a pas de chrono.
 *
 * Le raccourci des deux appels ci-dessus, exporté pour la révision automatique :
 * elle réécrit des séances du même plan, donc sous les mêmes allures imposées.
 *
 * @throws {InvalidPlanError} si le chrono stocké ne décrit pas une course.
 */
export function planTrainingPaces(plan: PlanDto): TrainingPaces | null {
  return referenceRacePaces(planReferenceRace(plan));
}

/**
 * La section d'allures du régime **avec table**, telle qu'elle part au modèle —
 * une information, plus une injonction.
 *
 * Le renversement est tout l'objet de la manœuvre. Prescrire la table n'a pas
 * marché : deux déploiements de suite, la table en unique section d'allures, le
 * modèle local a ressorti les mêmes allures absurdes (EF à 12:00/km quand la
 * table disait 5:56–6:32/km) à chaque tentative. Les allures sont donc
 * désormais **posées par l'appli** ({@link applyImposedPaces}), et ce qu'on
 * demande au modèle est de n'en écrire aucune : ce qu'il ne produit pas, il ne
 * peut plus le produire de travers.
 *
 * La table reste dans le prompt, mais pour une autre raison : elle situe le
 * niveau de l'athlète, et c'est ce niveau qui doit décider des distances et des
 * durées. Ce qui a disparu, c'est l'injonction — et avec elle la mention de
 * l'« allure moyenne des dernières sorties », retirée du contexte de ce régime
 * (cf. {@link buildPlanMessages}) : disqualifier une ligne absente ne ferait que
 * la rappeler.
 *
 * Le `kind` devient en revanche **porteur** : c'est lui, et lui seul, qui décide
 * du créneau posé. D'où le rappel du vocabulaire attendu.
 *
 * L'interdiction couvre aussi le **texte libre** : une allure écrite en toutes
 * lettres dans un titre, une consigne, une note ou le résumé s'affiche telle
 * quelle à côté de celle que l'appli a posée — et rien ne garantit que les deux
 * disent la même chose. Le champ n'est pas le seul chemin par lequel une allure
 * fausse atteint l'écran.
 */
function imposedPacesSection(paces: TrainingPaces, race: ReferenceRace): string {
  return [
    "ALLURES — calculées et posées par l'application, tu n'en écris AUCUNE",
    formatTrainingPaces(paces, race),
    "Les allures seront calculées et posées automatiquement selon le type de séance : endurance fondamentale et sortie longue en [E], allure course ou allure objectif en [M], seuil en [T], VMA en [I], répétitions courtes en [R], récupérations sans cible. Cette table est là pour situer le niveau de l'athlète, pas pour être recopiée.",
    "N'écris PAS d'allures : ni `targetPaceSecPerKm` au niveau de la séance, ni `paceMinSecPerKm`/`paceMaxSecPerKm` dans les étapes. Concentre-toi sur la structure : types de séances, distances, durées, répétitions, récupérations.",
    "Tu n'écris pas non plus d'allure en toutes lettres dans les titres, les consignes, les notes ou le résumé — l'affichage les porte déjà.",
    "C'est le `kind` de la séance qui décide de son allure : nomme-le dans le vocabulaire de la typologie (« Endurance fondamentale », « Sortie longue », « Seuil », « VMA », « Répétitions », « Récupération », « Spécifique allure course ») — un libellé hors vocabulaire fera poser une allure d'endurance.",
  ].join('\n');
}

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

/**
 * Ce que le modèle doit savoir d'une **première semaine entamée** : les jours
 * déjà passés n'accueillent rien, la semaine compte donc moins de séances, et sa
 * sortie longue n'a plus d'objet si son jour est derrière nous.
 *
 * Même énoncé qu'à l'ajustement ({@link formatUpcomingPlan}, « déjà entamée »),
 * pour la même raison : c'est la seule chose qui empêche le modèle de remplir un
 * lundi hors du plan — et {@link validatePlanBusinessRules} le lui repasserait
 * alors en violation, au prix d'une génération entière.
 *
 * Le **budget proraté** suit la même logique, et lui manquait : la règle ramène
 * le budget hebdomadaire aux jours restants
 * ({@link formatPartialWeekTimeBudget}), sans que rien ne le dise au modèle — qui
 * produisait donc une semaine entamée à la mesure du budget plein, refusée par un
 * plafond qu'il ne pouvait pas deviner. La ligne n'apparaît que quand le contrôle
 * s'applique réellement : sous {@link MIN_FIRST_WEEK_DAYS} jours restants, il n'y
 * a pas de plafond, donc rien à annoncer.
 */
function firstWeekLines(request: PlanRequest, window: PlanWindow): string[] {
  if (window.firstWeekFromDay === 1) {
    return [`Chaque semaine compte exactement ${request.sessionsPerWeek} séances.`];
  }

  const proratedBudget = formatPartialWeekTimeBudget(
    request.weeklyTimeMinutes ?? null,
    window.firstWeekFromDay,
  );

  return [
    `weeks[0] est déjà entamée : elle ne porte de séances qu'à partir du ${formatIsoDay(window.firstWeekFromDay)} (day ≥ ${window.firstWeekFromDay}), et en compte ${request.sessionsPerWeek} au plus.`,
    request.longRunDay < window.firstWeekFromDay
      ? `Elle n'a pas de sortie longue : le ${formatIsoDay(request.longRunDay)} de cette semaine-là est passé.`
      : `Sa sortie longue reste le ${formatIsoDay(request.longRunDay)}.`,
    ...(proratedBudget === null
      ? []
      : [
          `Le budget de la semaine entamée est ramené à ${proratedBudget} au prorata des jours restants.`,
        ]),
    `Les semaines suivantes comptent exactement ${request.sessionsPerWeek} séances.`,
  ];
}

/**
 * Le message système : méthodologie générale, surcharge de niveau, puis — s'il y
 * a un chrono — la table d'allures qui remplace les règles de dérivation.
 *
 * L'ordre porte la priorité : chaque bloc surcharge le précédent, et le dit.
 *
 * Exporté pour la révision automatique (`review-service.ts`), qui ajoute ses
 * propres consignes en `extra` : un coach qui relit un plan doit le juger avec
 * la méthodologie qui l'a écrit, pas avec une autre.
 *
 * `goalType` ne décide de rien d'autre que de la spécificité attendue des
 * sorties longues ({@link coachRuleTailLines}) : le reste de la méthodologie
 * vaut pour une course comme pour un objectif libre.
 */
export function planSystemPrompt(
  level: PlanLevel | null,
  goalType: PlanGoalType,
  paces: TrainingPaces | null,
  race: ReferenceRace | undefined,
  extra: readonly string[] = [],
): string {
  const imposed = paces === null || race === undefined ? null : imposedPacesSection(paces, race);
  return [
    coachRules(imposed !== null, goalType === 'race'),
    ...(level === null ? [] : ['', LEVEL_RULES[level]]),
    ...(imposed === null ? [] : ['', imposed]),
    ...extra,
  ].join('\n');
}

/**
 * Le **meilleur** volume hebdomadaire réellement couru sur la fenêtre du
 * snapshot, en km — `null` sans historique exploitable.
 *
 * Le maximum, et pas la moyenne : c'est ce que l'athlète a démontré pouvoir
 * faire, et une moyenne tirée vers le bas par une semaine de vacances ferait
 * démarrer le plan sous son niveau. Sert de deux façons, avec le même chiffre
 * des deux côtés : le prompt l'annonce comme plafond de départ, la validation le
 * vérifie ({@link PlanValidationContext.recentWeeklyKm}).
 *
 * **Limite connue** : ce chiffre ne vaut que ce que vaut l'historique importé. Un
 * import FIT partiel — canal de synchronisation cassé, reprise de compte, backfill
 * en cours — fait passer pour « le meilleur volume récent » ce qui n'est que la
 * partie visible, et plafonne le plan sans que rien ne le dise. Le remède est du
 * côté de l'import, pas ici : fabriquer une correction reviendrait à inventer un
 * volume que les données ne portent pas.
 */
function bestRecentWeeklyKm(snapshot: TrainingSnapshotDto): number | null {
  if (snapshot.weeks.length === 0) return null;
  const best = Math.max(...snapshot.weeks.map((week) => week.distanceKm));
  // Quatre semaines à zéro ne disent pas « démarre à zéro », elles disent qu'il
  // n'y a rien à quoi ancrer le départ.
  return best > 0 ? best : null;
}

/**
 * L'allure qui convertit les kilomètres cibles en minutes.
 *
 * La table calculée d'abord (le milieu de son créneau d'endurance), l'allure
 * d'entraînement récente ensuite : c'est la même hiérarchie que partout ailleurs
 * dans ce module, et la même raison — un chrono de course dit mieux ce que
 * l'athlète tient qu'une moyenne de footings. `null` quand ni l'une ni l'autre
 * n'existe, le planificateur applique alors son repli prudent.
 */
function easyPaceSecPerKm(
  snapshot: TrainingSnapshotDto,
  paces: TrainingPaces | null,
): number | null {
  if (paces === null) return snapshot.recentAvgPaceSecPerKm;
  return Math.round((paces.easy.minSecPerKm + paces.easy.maxSecPerKm) / 2);
}

/**
 * Les volumes hebdomadaires cibles d'une **création**, tels que le prompt les
 * annonce et que la validation les vérifie.
 *
 * Fonction pure et déterministe, appelée des deux côtés plutôt que passée de
 * l'un à l'autre : deux chiffrages divergents feraient refuser un plan qui
 * applique la consigne à la lettre — le défaut que ce module passe son temps à
 * éviter.
 */
export function planVolumeTargets(
  request: PlanRequest,
  window: PlanWindow,
  snapshot: TrainingSnapshotDto,
  paces: TrainingPaces | null = null,
): WeeklyVolumeTarget[] {
  return weeklyVolumeTargets({
    weeks: window.weeks,
    firstWeekFromDay: window.firstWeekFromDay,
    recentWeeklyKm: bestRecentWeeklyKm(snapshot),
    weeklyTimeMinutes: request.weeklyTimeMinutes ?? null,
    easyPaceSecPerKm: easyPaceSecPerKm(snapshot, paces),
    race: raceGoalOf(request.goalType, request.goalText),
    level: request.level,
  });
}

/**
 * Ce qu'une génération par tranches ajoute au message d'une tranche : sa place
 * dans le plan, et ce que la précédente a laissé.
 */
export type PlanChunkContext = {
  chunk: PlanChunkSpec;
  /** Le résumé d'une ligne de la tranche précédente, `null` sur la première. */
  continuity: string | null;
};

/**
 * Ce qui, dans le message d'une tranche, remplace la consigne « rends les N
 * semaines » d'une génération d'un seul tenant.
 *
 * Trois choses, et aucune n'est décorative : les **bornes** de la tranche dans
 * la numérotation du plan entier (c'est elle que porteront les violations
 * renvoyées en reprise), la **continuité** avec ce qui précède — sans quoi la
 * tranche 2 rouvre un bloc au lieu de continuer celui-là —, et, sur la
 * dernière, le fait que le résumé porte sur le plan et non sur la tranche.
 */
export function chunkInstructionLines(
  chunk: PlanChunkSpec,
  continuity: string | null,
  weekStart: string,
  scope = 'du plan',
  withSummary = true,
): string[] {
  const first = chunk.fromWeek + 1;
  const last = chunk.fromWeek + chunk.weeks;
  return [
    `Tranche ${chunk.index + 1}/${chunk.count} : rends UNIQUEMENT les semaines ${first} à ${last} ${scope}, dans l'ordre chronologique — weeks[0] est la semaine du ${formatCivilDate(weekStart)}.`,
    ...(continuity === null ? [] : [continuity]),
    ...(withSummary && chunk.index === chunk.count - 1
      ? ['Le résumé (`summary`) porte sur le plan complet, pas sur cette seule tranche.']
      : []),
  ];
}

/**
 * Les messages d'une génération de plan — d'un seul tenant, ou d'une **tranche**
 * quand le plan est trop long pour tenir dans un appel ({@link PlanChunkContext}).
 *
 * Les deux régimes partagent tout ce qui décrit l'athlète et son objectif : ce
 * qui change est ce qu'on demande d'écrire, et les volumes cibles qui
 * l'accompagnent — ceux de la tranche seulement, numérotés dans la numérotation
 * du plan entier.
 */
export function buildPlanMessages(
  request: PlanRequest,
  window: PlanWindow,
  snapshot: TrainingSnapshotDto,
  paces: TrainingPaces | null = null,
  chunkContext: PlanChunkContext | null = null,
): ChatMessage[] {
  // Depuis l'ancre : c'est elle qui porte la grille des semaines, `startsOn`
  // pouvant tomber en milieu de première semaine.
  const endsOn = shiftCivilDate(window.anchor, window.weeks * 7 - 1);
  const targets = planVolumeTargets(request, window, snapshot, paces);
  const chunk = chunkContext?.chunk ?? null;

  const lines = [
    request.goalType === 'race' && request.raceDate !== undefined
      ? `Objectif : la course « ${request.goalText} », le ${formatCivilDate(request.raceDate)}.`
      : `Objectif : ${request.goalText}.`,
    `Niveau déclaré : ${LEVEL_LABELS[request.level]}.`,
    `Plan à produire : ${window.weeks} semaines, du ${formatCivilDate(window.startsOn)} au ${formatCivilDate(endsOn)}.`,
    `Contraintes : ${formatConstraints(request)}.`,
    '',
    `État de l'athlète au ${snapshot.today} :`,
    // Avec une table, l'allure moyenne des dernières sorties sort du contexte :
    // c'est l'ancre parasite constatée en production, et plus aucune allure ne
    // vient du modèle de toute façon (cf. `SnapshotFormatOptions`).
    formatTrainingSnapshot(snapshot, { withRecentPace: paces === null }),
    '',
    ...(chunk === null
      ? [
          `Rends les ${window.weeks} semaines dans l'ordre chronologique : weeks[0] est la semaine du ${formatCivilDate(window.anchor)}.`,
        ]
      : chunkInstructionLines(
          chunk,
          chunkContext?.continuity ?? null,
          shiftCivilDate(window.anchor, chunk.fromWeek * 7),
        )),
    // La première semaine entamée n'existe que dans la première tranche ; les
    // suivantes sont des semaines pleines, et le rappel du compte de séances
    // vaut pour elles.
    ...(chunk === null || chunk.index === 0
      ? firstWeekLines(request, window)
      : [`Chaque semaine compte exactement ${request.sessionsPerWeek} séances.`]),
    // La table des cibles **remplace** l'ancienne ligne « Volume de départ » : ce
    // plafond-là n'était qu'une borne à respecter, celles-ci sont les chiffres à
    // écrire — et la première d'entre elles porte déjà l'ancrage sur le réel.
    formatWeeklyVolumeTargets(
      chunk === null ? targets : targets.slice(chunk.fromWeek, chunk.fromWeek + chunk.weeks),
      chunk === null ? 1 : chunk.fromWeek + 1,
    ),
  ];

  return [
    // La méthodologie générale, puis les seules surcharges qui concernent cet
    // athlète : son niveau, et ses allures calculées quand il a donné un chrono.
    {
      role: 'system',
      content: planSystemPrompt(request.level, request.goalType, paces, request.referenceRace),
    },
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
  firstWeekNumber = 1,
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
      `Semaine ${firstWeekNumber + index} (du ${formatCivilDate(weekStart)}${partial ? `, déjà entamée : à replanifier à partir du ${formatIsoDay(window.firstWeekFromDay)}` : ''}) :`,
    );
    if (sessions.length === 0) {
      lines.push('- aucune séance planifiée');
      continue;
    }
    for (const session of sessions) lines.push(formatUpcomingSession(session, weekStart));
  }

  const header = [
    `Plan en cours : « ${plan.goalText} »${plan.raceDate === null ? '' : `, course le ${formatCivilDate(plan.raceDate)}`}.`,
    // Les plans antérieurs au champ n'en portent pas : rien n'est dit plutôt
    // qu'un niveau supposé, qui orienterait tout l'ajustement.
    ...(plan.level === null ? [] : [`Niveau déclaré : ${LEVEL_LABELS[plan.level]}.`]),
    `Réglages actuels : ${formatConstraints(plan)}.`,
    `Séances restantes (${window.weeks} semaines) :`,
  ];

  return [...header, ...lines].join('\n');
}

/**
 * La part d'une fenêtre restante que **cette tranche** couvre.
 *
 * Ce qui rend le découpage utile côté entrée autant que sortie : sans lui,
 * chaque tranche recevrait les séances des seize semaines à venir — soit
 * exactement le contexte que le découpage cherche à ne pas saturer.
 *
 * Seule la première tranche hérite du jour de reprise : les suivantes commencent
 * un lundi, elles ne sont entamées par rien.
 */
export function chunkWindow(
  window: RemainingPlanWindow,
  chunk: PlanChunkSpec,
): RemainingPlanWindow {
  return {
    firstWeekStart: shiftCivilDate(window.firstWeekStart, chunk.fromWeek * 7),
    weeks: chunk.weeks,
    firstWeekFromDay: chunk.index === 0 ? window.firstWeekFromDay : 1,
  };
}

/** Les messages d'une modification par instruction — d'un seul tenant ou par tranche. */
export function buildPlanUpdateMessages(
  plan: PlanDto,
  upcoming: readonly PlanSessionDto[],
  window: RemainingPlanWindow,
  instruction: string,
  paces: TrainingPaces | null = null,
  chunkContext: PlanChunkContext | null = null,
): ChatMessage[] {
  // Le plan garde le niveau **et le chrono** de sa création : l'ajustement s'y
  // tient. Un plan sans niveau (antérieur au champ) reste sur la seule
  // méthodologie générale.
  const system = planSystemPrompt(plan.level, plan.goalType, paces, planReferenceRace(plan), [
    '',
    "Tu modifies un plan existant : tu ne régénères que les semaines restantes, weeks[0] étant la première semaine restante. Le passé de l'athlète ne se réécrit pas.",
    "Les séances à venir te sont données avec leur déroulé. Tu réécris chaque séance en entier, `steps` compris : ce que l'instruction ne remet pas en cause, tu le reconduis tel quel — la progression déjà calée n'est pas à refaire.",
    "Si l'instruction change une contrainte durable (nombre de séances, jour de la sortie longue, temps hebdomadaire), reporte-la dans `settings` ; sinon, omets `settings`.",
    "Le résumé décrit le plan modifié dans son ensemble, pas la modification.",
  ]);

  const chunk = chunkContext?.chunk ?? null;
  const scope = chunk === null ? window : chunkWindow(window, chunk);
  const user = [
    // Une tranche ne reçoit que ses propres séances : les autres sont écrites, et
    // les envoyer coûterait le contexte que le découpage libère.
    formatUpcomingPlan(plan, upcoming, scope, chunk === null ? 1 : chunk.fromWeek + 1),
    '',
    `Instruction de l'athlète : « ${instruction.trim()} »`,
    '',
    ...(chunk === null
      ? [
          `Rends les ${window.weeks} semaines restantes dans l'ordre chronologique, en appliquant l'instruction.`,
        ]
      : chunkInstructionLines(
          chunk,
          chunkContext?.continuity ?? null,
          scope.firstWeekStart,
          'des semaines restantes',
          false,
        )),
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
export function buildViolationsMessage(
  violations: readonly string[],
  chunk: PlanChunkSpec | null = null,
): string {
  const reported = violations.slice(0, MAX_REPORTED_ISSUES);
  const remainder = violations.length - reported.length;
  return [
    'Ce plan ne respecte pas les contraintes demandées :',
    ...reported.map((violation) => `- ${violation}`),
    ...(remainder > 0 ? [`… et ${remainder} autres violations du même ordre.`] : []),
    // Une tranche ne peut pas régénérer « le plan complet » : elle n'en tient
    // qu'un morceau, et les autres sont déjà écrits. Les numéros de semaine des
    // violations sont ceux du plan entier — d'où le rappel des bornes.
    chunk === null
      ? 'Régénère le plan complet en corrigeant ces points, dans le même format.'
      : `Régénère les ${chunk.weeks} semaines de cette tranche (semaines ${chunk.fromWeek + 1} à ${chunk.fromWeek + chunk.weeks} du plan) en corrigeant ces points, dans le même format.`,
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

export type GenerationOptions<T> = {
  messages: ChatMessage[];
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  /**
   * Les semaines produites, quelle que soit la forme de l'enveloppe — ou `null`
   * quand la sortie n'en porte aucune à juger.
   *
   * Ce second cas n'est pas une commodité : une révision qui conclut « le plan
   * reste adapté » ne réécrit rien, et lui appliquer les règles de volume
   * reviendrait à lui reprocher de ne pas contenir les semaines qu'elle a
   * justement choisi de ne pas toucher.
   */
  weeksOf: (output: T) => PlanWeekOutput[] | null;
  /**
   * Ce que la sortie doit respecter. Calculé **depuis la sortie** : une
   * modification peut changer les réglages du plan, et c'est alors sur les
   * réglages patchés qu'il faut la juger.
   */
  expectationsOf: (output: T) => PlanExpectations;
  /**
   * Ce à quoi les allures prescrites sont confrontées : la table calculée depuis
   * le chrono de l'athlète quand elle existe, son allure d'entraînement récente
   * sinon (cf. `validatePlanBusinessRules`). Les deux sont fournies des deux
   * côtés — c'est le corridor qui tranche.
   *
   * Le budget temps en est **exclu par le type** : il ne se lit pas dans un
   * contexte figé pour toute la génération, mais dans chaque sortie
   * ({@link GenerationOptions.weeklyTimeBudgetOf}). Le poser ici serait sans
   * effet, donc silencieusement faux.
   */
  paceContext: Omit<PlanValidationContext, 'weeklyTimeMinutes'>;
  /**
   * Le budget temps hebdomadaire sur lequel **cette tentative** se juge, en
   * minutes — `null` pour aucun contrôle.
   *
   * Calculé depuis la sortie, comme {@link GenerationOptions.expectationsOf} :
   * une modification ou une révision peut lever ou élargir le budget dans le
   * même mouvement qu'elle réécrit les semaines, et ces semaines-là se jugent
   * sur le budget qu'elles déclarent (cf. `resolveWeeklyTimeBudget`). Une
   * génération, elle, n'a pas de patch : c'est le budget de la requête.
   *
   * Obligatoire, et c'est le point : un futur chemin de génération ne peut pas
   * l'oublier — il devra dire d'où sort son budget, comme
   * {@link GenerationOptions.withPostProcessedWeeks} lui fait dire où sont ses
   * semaines.
   */
  weeklyTimeBudgetOf: (output: T) => number | null;
  /**
   * Rend la sortie dont les semaines sont passées par le post-traitement
   * ({@link planWeeksPostProcessing}).
   *
   * Appelée **entre le parse et la validation métier**, et **toujours** : c'est
   * le post-traitement lui-même qui sait ce qu'il fait selon le régime — écrire
   * les allures et en dériver les mesures quand la table existe, compléter les
   * seules mesures manquantes sinon. L'appelant, lui, ne dit qu'une chose : où
   * sont ses semaines dans son enveloppe. Une révision qui conclut « keep » n'en
   * porte aucune et se rend telle quelle.
   *
   * Ce partage n'est pas cosmétique : quand le choix du régime vivait ici, le
   * chemin sans table n'était branché nulle part et tout plan sans chrono de
   * référence butait sur « Volumes hebdomadaires invérifiables ».
   */
  withPostProcessedWeeks: (output: T, postProcess: PlanWeeksPostProcessing) => T;
  /**
   * L'allure de l'objectif chiffré de l'athlète, en s/km ({@link
   * goalPaceSecPerKm}) — `null` quand son but n'en donne pas.
   *
   * Obligatoire pour la même raison que {@link
   * GenerationOptions.weeklyTimeBudgetOf} : le post-traitement est construit
   * ici, à partir du contexte d'allures et de cette valeur, et un chemin qui
   * l'omettrait poserait la zone M là où l'athlète vise son chrono.
   */
  goalPaceSecPerKm: number | null;
  /**
   * Identifiant de suivi fourni par le client, ou `undefined` : la génération se
   * déroule alors sans streaming ni progression, exactement comme avant.
   */
  progressId?: string;
  /** Taille attendue de la sortie ({@link estimatePlanChars}) — l'échelle du pourcentage. */
  estimatedChars: number;
  /**
   * La tranche en cours, quand la génération est découpée — absent sinon.
   *
   * Ce que ça change : le pourcentage enregistré devient **global**. Une barre
   * qui repartirait de zéro à chaque tranche décrirait l'avancement d'un appel,
   * quand l'athlète attend celui de son plan.
   */
  progressChunk?: { index: number; count: number };
};

/**
 * Ce qu'on soupçonne quand une sortie hors schéma ne porte **aucune** anomalie
 * Zod : le contenu n'était même pas du JSON (cf. {@link AiInvalidOutputError}).
 *
 * Sur llama.cpp, ce n'est presque jamais un modèle qui répond en texte libre —
 * la grammaire GBNF le lui interdit token par token — mais une génération
 * **coupée en plein JSON**. Les deux causes constatées, toutes deux traitées
 * depuis : le plafond de génération du serveur, quand la requête n'en portait
 * pas ({@link PLAN_MAX_OUTPUT_TOKENS}), et le contexte saturé par des milliers
 * de tokens de raisonnement (cf. `client.ts`, « Le mode “thinking” n'est pas
 * demandé »).
 *
 * Le soupçon ne se vérifie plus par déduction : la ligne `[ai] contenu non-JSON
 * reçu` que `client.ts` journalise juste avant celle-ci porte la taille et les
 * deux extrémités du contenu fautif — une sortie coupée net en plein objet ne
 * ressemble ni à un raisonnement fuité ni à un refus en texte libre.
 */
const TRUNCATION_HINT = 'sortie probablement tronquée (plafond de génération ou contexte ?)';

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
 * Journalise si la génération qui démarre est **suivie** ou non.
 *
 * Le pourcentage n'existe que si le formulaire a joint son identifiant de suivi
 * au `FormData` (cf. `useGenerationProgress`), et une modale muette ne dit pas
 * lequel des maillons a lâché : l'identifiant n'est pas parti, l'action l'a
 * écarté (UUID mal formé), ou c'est l'interrogation de la route qui échoue. Les
 * deux premiers cas se lisent maintenant dans les logs du serveur.
 *
 * Huit caractères de l'UUID : de quoi rapprocher la ligne de la requête
 * `/api/plan-progress` correspondante, sans recopier un identifiant entier dans
 * le journal.
 */
function logProgressTracking(progressId: string | undefined): void {
  console.info(
    progressId === undefined
      ? '[plan] génération sans suivi de progression'
      : `[plan] progression suivie (id ${progressId.slice(0, 8)})`,
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
export async function generateWithBusinessRules<T>(options: GenerationOptions<T>): Promise<T> {
  const messages = [...options.messages];
  let violations: string[] = [];

  const postProcess = planWeeksPostProcessing(options.paceContext, options.goalPaceSecPerKm);

  const { progressId, progressChunk } = options;
  /** L'avancement de cet appel, ramené à celui du plan quand il y a des tranches. */
  const globalPercent = (percent: number): number =>
    progressChunk === undefined
      ? percent
      : Math.min(99, Math.round((progressChunk.index * 100 + percent) / progressChunk.count));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Chaque tentative repart de zéro : une reprise réécrit le plan complet,
    // donc le pourcentage recommence — et le front dit « tentative 2/3 » plutôt
    // que de laisser une barre reculer sans explication.
    if (progressId !== undefined) {
      setPlanProgress(progressId, { percent: globalPercent(0), attempt, maxAttempts: MAX_ATTEMPTS });
    }

    let output: T;
    try {
      output = await chatCompletionJson<T>({
        messages,
        schemaName: options.schemaName,
        jsonSchema: options.jsonSchema,
        schema: options.schema,
        temperature: PLAN_TEMPERATURE,
        // Explicite, sinon le serveur coupe la sortie à son propre défaut
        // (cf. {@link PLAN_MAX_OUTPUT_TOKENS}).
        maxTokens: PLAN_MAX_OUTPUT_TOKENS,
        // Sa seule présence bascule l'appel en streaming (cf. `client.ts`).
        onProgress:
          progressId === undefined
            ? undefined
            : (receivedChars) => {
                setPlanProgress(progressId, {
                  percent: globalPercent(
                    planProgressPercent(receivedChars, options.estimatedChars),
                  ),
                  attempt,
                  maxAttempts: MAX_ATTEMPTS,
                });
              },
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

    // Post-traitement, avant toute validation et dans les deux régimes : avec
    // table, l'appli écrit les allures elle-même — le corridor qui suit devient
    // alors trivialement satisfait, c'est voulu ; sans table, elle ne complète
    // que les mesures manquantes, et le corridor juge les allures du modèle.
    output = options.withPostProcessedWeeks(output, postProcess);

    const weeks = options.weeksOf(output);
    // Rien à juger : la sortie ne réécrit aucune semaine (cf. `weeksOf`).
    if (weeks === null) return output;

    violations = validatePlanBusinessRules(weeks, options.expectationsOf(output), {
      ...options.paceContext,
      // Le budget de la sortie, pas celui du contexte : cf. `weeklyTimeBudgetOf`.
      weeklyTimeMinutes: options.weeklyTimeBudgetOf(output),
    });
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

/*
 * Génération par tranches.
 *
 * ## Le constat
 *
 * Un plan de 16 semaines à 6 séances pèse ~13 k tokens de JSON, le prompt ~3 k :
 * le contexte de 16 384 du serveur local est saturé, et la sortie se fait couper
 * en plein objet — trois tentatives, trois échecs, rien d'exploitable. Un plafond
 * de génération plus haut n'y peut rien : ce qui manque, c'est du contexte.
 *
 * ## Le découpage
 *
 * Au-delà de {@link CHUNK_WEEKS} semaines, le plan se génère en appels
 * successifs d'au plus six semaines. Chaque appel reçoit le système habituel,
 * **ses** volumes cibles, et un résumé d'une ligne de la tranche précédente pour
 * la continuité. Les semaines sont ensuite assemblées, post-traitées (allures,
 * durées, distances), puis jugées **globalement** : les règles de progression
 * parlent du plan entier, une tranche prise isolément n'a ni pic ni affûtage.
 *
 * Une violation désigne une semaine ; une semaine appartient à une tranche.
 * Seules les tranches fautives sont donc régénérées, dans la même limite de
 * {@link MAX_ATTEMPTS} tentatives chacune — régénérer les seize semaines parce
 * que la neuvième déborde coûterait tout ce que le découpage fait gagner.
 */

/**
 * Au-delà de ce nombre de semaines, un plan ne se génère plus d'un seul tenant.
 *
 * Six : c'est le plus grand nombre qui laisse la sortie (~6 × 6 × 280 = 10 k
 * caractères, soit ~3 k tokens) et le prompt (~3 k tokens) tenir confortablement
 * dans les 16 k de contexte du serveur cible, marge de reprise comprise. C'est
 * aussi un bloc d'entraînement cohérent : trois semaines de montée, une allégée.
 */
export const CHUNK_WEEKS = 6;

/** Une tranche de génération : sa place dans le plan, et ce qu'elle doit rendre. */
export type PlanChunkSpec = {
  /** Rang de la tranche, à partir de 0. */
  index: number;
  /** Nombre total de tranches du plan. */
  count: number;
  /** Index de la première semaine couverte, à partir de 0. */
  fromWeek: number;
  /** Nombre de semaines de la tranche. */
  weeks: number;
};

/**
 * Le découpage d'une fenêtre de `weeks` semaines en tranches d'au plus
 * {@link CHUNK_WEEKS}.
 *
 * Tranches **équilibrées** plutôt que remplies à ras bord : seize semaines font
 * 6 + 5 + 5, pas 6 + 6 + 4. Le nombre d'appels est le même, mais aucune tranche
 * ne se retrouve à décrire une semaine et demie de plan — un dernier appel
 * famélique paie le même prix de prompt qu'un appel plein pour bien moins de
 * plan écrit.
 */
export function planChunks(weeks: number): PlanChunkSpec[] {
  const count = Math.max(1, Math.ceil(weeks / CHUNK_WEEKS));
  const base = Math.floor(weeks / count);
  const remainder = weeks % count;

  const chunks: PlanChunkSpec[] = [];
  let fromWeek = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    chunks.push({ index, count, fromWeek, weeks: size });
    fromWeek += size;
  }
  return chunks;
}

/** La tranche à laquelle appartient la semaine `weekNumber` (numérotée à partir de 1). */
function chunkOfWeek(chunks: readonly PlanChunkSpec[], weekNumber: number): PlanChunkSpec | null {
  return (
    chunks.find(
      (chunk) => weekNumber > chunk.fromWeek && weekNumber <= chunk.fromWeek + chunk.weeks,
    ) ?? null
  );
}

/**
 * Les semaines qu'une violation désigne — vide quand elle n'en nomme aucune.
 *
 * Les violations sont écrites pour le modèle, en français, et c'est leur seul
 * format : « Semaine 9 : … », « Semaines 5 à 8 : … », « il en manque semaine 3,
 * semaine 7 ». On y relit donc les numéros plutôt que de les faire remonter
 * séparément — le prix à payer pour que ces messages restent des phrases.
 *
 * Une violation qui ne nomme rien (« Plan trop plat », « le plan doit compter
 * exactement N semaines ») parle du plan entier : elle est renvoyée à toutes les
 * tranches, faute de savoir laquelle est en cause.
 */
const VIOLATION_WEEK_PATTERN = /semaines?\s+(\d+)(?:\s*à\s*(\d+))?/gi;

function violationWeeks(violation: string): number[] {
  const weeks: number[] = [];
  for (const match of violation.matchAll(VIOLATION_WEEK_PATTERN)) {
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    for (let week = from; week <= to; week += 1) weeks.push(week);
  }
  return weeks;
}

/** Les violations à renvoyer, tranche par tranche — les tranches saines n'y figurent pas. */
function violationsByChunk(
  violations: readonly string[],
  chunks: readonly PlanChunkSpec[],
): Map<number, string[]> {
  const byChunk = new Map<number, string[]>();
  const add = (index: number, violation: string): void => {
    const own = byChunk.get(index);
    if (own === undefined) byChunk.set(index, [violation]);
    else if (!own.includes(violation)) own.push(violation);
  };

  for (const violation of violations) {
    const weeks = violationWeeks(violation);
    const targets = new Set(
      weeks
        .map((week) => chunkOfWeek(chunks, week)?.index)
        .filter((index): index is number => index !== undefined),
    );
    if (targets.size === 0) {
      for (const chunk of chunks) add(chunk.index, violation);
      continue;
    }
    for (const index of targets) add(index, violation);
  }

  return byChunk;
}

/**
 * Le résumé d'une ligne que la tranche suivante reçoit de la précédente.
 *
 * Deux informations, et pas une de plus : le **volume** de la dernière semaine —
 * sans lui, la tranche suivante repart du volume qu'elle imagine, et la marche
 * entre deux tranches ne respecte plus rien — et les **séances de qualité** qui
 * s'y trouvaient, sans lesquelles le modèle enchaîne trois blocs de seuil
 * identiques d'une tranche à l'autre. Le reste du plan écrit ne remonte pas :
 * c'est précisément ce que le découpage cherche à ne pas repayer en contexte.
 */
function chunkContinuityLine(weeks: readonly PlanWeekOutput[], weekNumber: number): string {
  const last = weeks[weeks.length - 1];
  const volume = weekVolumeKm(last);
  const quality = last.sessions.filter(isIntensitySession).map((session) => session.kind.trim());

  return [
    `Fin de la tranche précédente — semaine ${weekNumber} :`,
    volume === null ? 'volume non déclaré,' : `${formatNumber(volume, 1)} km,`,
    quality.length === 0
      ? 'aucune séance de qualité.'
      : `séances de qualité : ${quality.join(', ')}.`,
  ].join(' ');
}

/** Ce qu'une génération par tranches produit : le plan assemblé, et son résumé. */
export type ChunkedWeeks = { weeks: PlanWeekOutput[]; summary: string | null };

export type ChunkedGenerationOptions = {
  chunks: PlanChunkSpec[];
  /** Les messages d'une tranche, continuité comprise. */
  messagesFor: (chunk: PlanChunkSpec, continuity: string | null) => ChatMessage[];
  /**
   * Les semaines de la **première** tranche, quand l'appelant les a déjà
   * obtenues — un ajustement et une révision les tirent d'une enveloppe qui
   * porte aussi leurs réglages et leur décision, que la tranche suivante n'a
   * plus à produire. Absentes, la première tranche se génère comme les autres.
   */
  firstChunkWeeks?: PlanWeekOutput[] | null;
  /** La dernière tranche porte-t-elle le résumé du plan ? */
  withSummary: boolean;
  /** Nom du schéma, pour la grammaire et les journaux. */
  schemaName: string;
  /** Ce que le plan **assemblé** doit respecter. */
  expectations: PlanExpectations;
  paceContext: Omit<PlanValidationContext, 'weeklyTimeMinutes'>;
  weeklyTimeMinutes: number | null;
  /** L'allure objectif à poser sur les blocs spécifiques ({@link applyImposedPaces}). */
  goalPaceSecPerKm: number | null;
  sessionsPerWeek: number;
  progressId?: string;
};

/**
 * Génère un plan long **tranche par tranche**, l'assemble, le juge en entier, et
 * ne régénère que ce qui cloche.
 *
 * @throws {AiInvalidOutputError} si des violations subsistent alors qu'aucune
 * tranche fautive n'a plus de tentative — l'erreur porte la liste, comme une
 * génération d'un seul tenant.
 */
export async function generateWeeksInChunks(
  options: ChunkedGenerationOptions,
): Promise<ChunkedWeeks> {
  const { chunks } = options;
  const weeksByChunk: PlanWeekOutput[][] = [];
  const attempts = chunks.map(() => 0);
  const lastIndex = chunks.length - 1;
  let summary: string | null = null;

  const generateChunk = async (chunk: PlanChunkSpec, reprise: string | null): Promise<void> => {
    const continuity =
      chunk.index === 0
        ? null
        : chunkContinuityLine(weeksByChunk[chunk.index - 1], chunk.fromWeek);
    const withSummary = options.withSummary && chunk.index === lastIndex;
    const messages = options.messagesFor(chunk, continuity);

    const output = await generateWithBusinessRules<PlanChunkOutput>({
      messages: reprise === null ? messages : [...messages, { role: 'user', content: reprise }],
      schemaName: options.schemaName,
      jsonSchema: planChunkJsonSchema(chunk.weeks, withSummary),
      schema: planChunkOutputSchema,
      // Rien à juger ici : les règles de progression parlent du plan entier, et
      // une tranche n'en est qu'un morceau. La validation a lieu à l'assemblage.
      weeksOf: () => null,
      expectationsOf: () => options.expectations,
      weeklyTimeBudgetOf: () => options.weeklyTimeMinutes,
      withPostProcessedWeeks: (chunkOutput, postProcess) => ({
        ...chunkOutput,
        weeks: postProcess(chunkOutput.weeks),
      }),
      goalPaceSecPerKm: options.goalPaceSecPerKm,
      paceContext: options.paceContext,
      progressId: options.progressId,
      estimatedChars: estimatePlanChars(chunk.weeks, options.sessionsPerWeek),
      progressChunk: { index: chunk.index, count: chunks.length },
    });

    attempts[chunk.index] += 1;
    weeksByChunk[chunk.index] = output.weeks;
    if (withSummary && output.summary !== undefined) summary = output.summary;
  };

  const seeded = options.firstChunkWeeks ?? null;
  if (seeded !== null) {
    weeksByChunk[0] = seeded;
    attempts[0] = 1;
  }

  for (const chunk of chunks) {
    if (chunk.index === 0 && seeded !== null) continue;
    await generateChunk(chunk, null);
  }

  for (;;) {
    const weeks = weeksByChunk.flat();
    const violations = validatePlanBusinessRules(weeks, options.expectations, {
      ...options.paceContext,
      weeklyTimeMinutes: options.weeklyTimeMinutes,
    });
    if (violations.length === 0) return { weeks, summary };

    // Par index croissant, jamais dans l'ordre d'apparition des violations :
    // une tranche tire sa ligne de continuité de la précédente
    // ({@link chunkContinuityLine}), donc régénérer la tranche 2 avant la 1 la
    // calerait sur des semaines qui vont être remplacées dans la foulée.
    const byChunk = [...violationsByChunk(violations, chunks)]
      .filter(([index]) => attempts[index] < MAX_ATTEMPTS)
      .sort(([left], [right]) => left - right);
    if (byChunk.length === 0) {
      console.error(
        `[plan] génération par tranches abandonnée (${options.schemaName}) : violations métier non corrigées.`,
      );
      throw new AiInvalidOutputError(
        `Le coach n'est pas parvenu à respecter les contraintes du plan : ${violations.join(' ')}`,
      );
    }

    for (const [index, own] of byChunk) {
      const chunk = chunks[index];
      const reprise = buildViolationsMessage(own, chunk);
      logRejectedAttempt(
        attempts[index],
        `${options.schemaName} (tranche ${index + 1}/${chunks.length})`,
        'violations métier',
        reprise,
      );
      await generateChunk(chunk, reprise);
    }
  }
}

/**
 * Les deux effets de bord d'un plan **que l'athlète suit** : rapprocher les
 * séances des activités déjà en base, et republier le calendrier intervals.icu.
 *
 * Deux points d'appel, une seule politique — d'où l'export : l'ajustement du
 * plan actif (ici même) et l'adoption d'une proposition (Server Action de la
 * page « Plan »). Une génération, elle, n'y passe pas : elle n'écrit qu'une
 * proposition, que rien ne pilote tant qu'elle n'est pas adoptée.
 *
 * Pourquoi le rapprochement : une séance (re)générée — ou adoptée quelques jours
 * après avoir été proposée — sur un jour déjà couru doit s'afficher
 * « réalisée », pas « manquée ». Les sorties du passé, elles, sont en base
 * depuis longtemps — personne ne les réimportera, donc rien d'autre ne posera ce
 * lien.
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
export async function afterActivePlanChanged(planId: number): Promise<void> {
  try {
    await reconcilePlanSessions(planId);
  } catch (error) {
    console.error(`[plan] rapprochement des séances du plan ${planId} impossible :`, error);
  }

  // Le catch vit dans le module de synchronisation : les trois points de
  // branchement (adoption, ajustement, archivage) partagent la même garde.
  after(() => syncPlanToIntervalsSafely(`plan ${planId}`));
}

/**
 * Écrit un plan d'entraînement complet **en proposition** (`draft`).
 *
 * Le coach propose, il n'impose pas : rien du plan en cours ne bouge ici, et
 * aucun effet de bord n'est déclenché. C'est l'athlète qui tranche depuis la
 * page du plan — adopter la proposition l'active et archive le plan précédent
 * ({@link acceptDraftPlan}), la refuser l'efface sans laisser de trace.
 *
 * @param progressId identifiant de suivi (UUID) généré par le formulaire, ou
 * `undefined`. Fourni, il fait streamer la génération et alimente le registre de
 * progression que lit `GET /api/plan-progress` ; il est effacé quoi qu'il
 * arrive, une entrée oubliée décrirait indéfiniment une génération finie.
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable.
 * @throws {InvalidPlanError} si la demande ne définit pas une fenêtre valide.
 * @throws {AiInvalidOutputError} si le plan produit reste hors des contraintes
 * après une reprise.
 */
export async function generatePlan(request: PlanRequest, progressId?: string): Promise<PlanDto> {
  logProgressTracking(progressId);
  await requireAi();

  const window = planWindow(request, todayCivilDate());
  const snapshot = await getTrainingSnapshot();

  try {
    return await writeGeneratedPlan(request, window, snapshot, progressId);
  } finally {
    // L'écriture en base est incluse dans le suivi : sans cela, la dernière
    // interrogation du formulaire tomberait sur `null` alors que l'attente dure
    // encore, et la barre disparaîtrait juste avant la fin.
    if (progressId !== undefined) clearPlanProgress(progressId);
  }
}

/** Le corps de {@link generatePlan}, isolé pour que l'effacement du suivi tienne en un `finally`. */
async function writeGeneratedPlan(
  request: PlanRequest,
  window: PlanWindow,
  snapshot: TrainingSnapshotDto,
  progressId: string | undefined,
): Promise<PlanDto> {
  const paces = referenceRacePaces(request.referenceRace);
  const chunks = planChunks(window.weeks);

  const expectations: PlanExpectations = {
    scope: 'creation',
    weeks: window.weeks,
    sessionsPerWeek: request.sessionsPerWeek,
    longRunDay: request.longRunDay,
    // > 1 sur un départ en milieu de semaine : la première semaine est jugée
    // comme une semaine entamée, exactement comme à l'ajustement.
    firstWeekFromDay: window.firstWeekFromDay,
    race: raceGoalOf(request.goalType, request.goalText),
    // Les volumes que l'appli a chiffrés, et que le prompt vient d'annoncer.
    weeklyTargets: planVolumeTargets(request, window, snapshot, paces),
  };
  const paceContext = {
    referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm,
    paces,
    // Une création, et elle seule, se juge sur l'historique d'avant-plan.
    recentWeeklyKm: bestRecentWeeklyKm(snapshot),
  };
  // L'allure objectif vient du but que l'athlète a écrit : « 10 km sous 50 min »
  // vaut 5:00/km, et les blocs spécifiques la reçoivent au lieu de la zone M
  // (cf. `goalPaceSecPerKm`).
  const goalPace = goalPaceSecPerKm(request.goalText);

  const output =
    chunks.length > 1
      ? await generateWeeksInChunks({
          chunks,
          messagesFor: (chunk, continuity) =>
            buildPlanMessages(request, window, snapshot, paces, { chunk, continuity }),
          withSummary: true,
          schemaName: 'training_plan_chunk',
          expectations,
          paceContext,
          // Une création ne porte pas de réglages : le budget est celui de la
          // requête, rien dans la sortie ne peut le déplacer.
          weeklyTimeMinutes: request.weeklyTimeMinutes ?? null,
          goalPaceSecPerKm: goalPace,
          sessionsPerWeek: request.sessionsPerWeek,
          progressId,
        })
      : await generateWithBusinessRules({
          messages: buildPlanMessages(request, window, snapshot, paces),
          schemaName: 'training_plan',
          jsonSchema: planJsonSchema,
          schema: planOutputSchema,
          weeksOf: (plan) => plan.weeks,
          expectationsOf: () => expectations,
          withPostProcessedWeeks: (plan, postProcess) => ({
            ...plan,
            weeks: postProcess(plan.weeks),
          }),
          goalPaceSecPerKm: goalPace,
          weeklyTimeBudgetOf: () => request.weeklyTimeMinutes ?? null,
          paceContext,
          progressId,
          estimatedChars: estimatePlanChars(window.weeks, request.sessionsPerWeek),
        });

  return createDraftPlanWithSessions({
    goalType: request.goalType,
    level: request.level,
    goalText: request.goalText,
    raceDate: request.goalType === 'race' ? (request.raceDate ?? null) : null,
    referenceDistance: request.referenceRace?.distance ?? null,
    referenceTimeS: request.referenceRace?.timeS ?? null,
    // Le jour **réel** du départ est ce que le plan stocke ; la grille des jours
    // ISO, elle, se pose sur l'ancre.
    startsOn: window.startsOn,
    weeks: window.weeks,
    sessionsPerWeek: request.sessionsPerWeek,
    weeklyTimeMinutes: request.weeklyTimeMinutes ?? null,
    longRunDay: request.longRunDay,
    summary: output.summary,
    sessions: mapPlanWeeksToSessions(output.weeks, window.anchor),
  });
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
 * du plan** : des blocs de 7 jours à partir de l'ancre, le lundi de la semaine de
 * `startsOn` — les semaines du plan sont des semaines ISO, y compris quand le
 * plan démarre en milieu de semaine.
 *
 * @throws {InvalidPlanError} si le plan est terminé : il n'y a plus rien à
 * régénérer, et une instruction ne ressuscite pas un plan échu.
 */
export function remainingPlanWindow(
  plan: { startsOn: string; weeks: number },
  fromDate: string,
): RemainingPlanWindow {
  const anchor = isoWeekStart(plan.startsOn);
  // Plan qui n'a pas encore commencé : tout est à venir. Sa première semaine
  // reste celle du départ, entamée si le départ n'est pas un lundi.
  if (fromDate <= plan.startsOn) {
    return {
      firstWeekStart: anchor,
      weeks: plan.weeks,
      firstWeekFromDay: isoDayIndex(plan.startsOn) + 1,
    };
  }

  const offset = civilDaysBetween(anchor, fromDate);
  const weekIndex = Math.floor(offset / 7);
  const weeks = plan.weeks - weekIndex;
  if (weeks <= 0) {
    throw new InvalidPlanError(
      'weeks',
      "Ce plan est arrivé à son terme : il n'y a plus de semaine à régénérer.",
    );
  }

  return {
    firstWeekStart: shiftCivilDate(anchor, weekIndex * 7),
    weeks,
    firstWeekFromDay: offset - weekIndex * 7 + 1,
  };
}

/**
 * Les réglages que la sortie du modèle fait réellement bouger, et rien d'autre.
 *
 * Le résumé est passé à part : une modification le tient du modèle, une révision
 * automatique le compose depuis celui du plan (cf. `review-service.ts`).
 * Exporté pour ce second appelant.
 */
export function planSettingsPatch(
  plan: PlanDto,
  settings: PlanSettingsOutput | undefined,
  summary: string | null,
): PlanSettingsPatch {
  const patch: PlanSettingsPatch = { summary };
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
 * @param progressId identifiant de suivi (UUID) généré par le formulaire — même
 * rôle et même cycle de vie qu'à la génération (cf. {@link generatePlan}).
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable.
 * @throws {PlanNotFoundError} s'il n'y a pas de plan actif.
 * @throws {InvalidPlanError} si le plan est terminé, ou si les séances produites
 * sortent de sa fenêtre.
 * @throws {AiInvalidOutputError} si la sortie reste hors contraintes après reprise.
 */
export async function updatePlanFromInstruction(
  instruction: string,
  progressId?: string,
): Promise<PlanDto> {
  logProgressTracking(progressId);
  try {
    return await writeUpdatedPlan(instruction, progressId);
  } finally {
    if (progressId !== undefined) clearPlanProgress(progressId);
  }
}

/** Le corps de {@link updatePlanFromInstruction} — cf. {@link writeGeneratedPlan}. */
async function writeUpdatedPlan(
  instruction: string,
  progressId: string | undefined,
): Promise<PlanDto> {
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
  // Le chrono déclaré à la création reste l'ancre : un ajustement ne réécrit pas
  // les allures que la table impose, il réécrit des séances.
  const paces = referenceRacePaces(planReferenceRace(active.plan));

  const chunks = planChunks(window.weeks);
  const chunked = chunks.length > 1;
  // Fenêtre restante, pas plan complet : la règle anti-plat n'y a pas d'objet —
  // exiger un pic supérieur à la première semaine restante réclamerait de monter
  // le volume à quelques semaines de la course.
  const expectationsOf = (settings: PlanSettingsOutput | undefined): PlanExpectations => ({
    scope: 'adjustment',
    weeks: window.weeks,
    sessionsPerWeek: settings?.sessionsPerWeek ?? active.plan.sessionsPerWeek,
    longRunDay: settings?.longRunDay ?? active.plan.longRunDay,
    firstWeekFromDay: window.firstWeekFromDay,
    // La fenêtre restante se termine avec le plan, donc avec la course : ses
    // dernières semaines sont bien celles de l'affûtage. Un ajustement demandé
    // à moins de 8 semaines d'un marathon n'en exigera que deux au lieu de
    // trois — la fenêtre est courte, et c'est le sens conservateur.
    race: raceGoalOf(active.plan.goalType, active.plan.goalText),
    // Pas de cibles de volume : elles s'ancrent sur l'historique d'avant-plan et
    // sur un départ à chiffrer, deux choses qu'un plan en cours a déjà tranchées.
  });
  const paceContext = {
    referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm,
    paces,
    // Pas de `recentWeeklyKm` : c'est le plan en cours qui fait foi, pas le
    // volume d'avant-plan.
  };
  // L'objectif du plan porte l'allure objectif, comme à la génération : un
  // ajustement réécrit des séances, pas le but qu'elles préparent.
  const goalPace = goalPaceSecPerKm(active.plan.goalText);

  // L'enveloppe — réglages et résumé — vient toujours du premier appel : c'est
  // l'instruction qui la décide, et elle est connue dès la première tranche.
  const output = await generateWithBusinessRules({
    messages: buildPlanUpdateMessages(
      active.plan,
      upcoming,
      window,
      instruction,
      paces,
      chunked ? { chunk: chunks[0], continuity: null } : null,
    ),
    schemaName: 'training_plan_update',
    jsonSchema: chunked ? planUpdateChunkJsonSchema(chunks[0].weeks) : planUpdateJsonSchema,
    schema: planUpdateOutputSchema,
    // Découpé, le premier appel ne rend qu'une tranche : la juger contre les
    // attentes du plan entier la déclarerait fautive sur son seul compte de
    // semaines. La validation a lieu à l'assemblage.
    weeksOf: (plan) => (chunked ? null : plan.weeks),
    expectationsOf: (plan) => expectationsOf(plan.settings),
    withPostProcessedWeeks: (plan, postProcess) => ({
      ...plan,
      weeks: postProcess(plan.weeks),
    }),
    goalPaceSecPerKm: goalPace,
    // Le budget que la sortie déclare, à défaut celui du plan stocké : une
    // instruction qui élargit ou lève la contrainte de temps produit des
    // semaines qui se jugent sur cette contrainte-là, pas sur l'ancienne.
    weeklyTimeBudgetOf: (plan) =>
      resolveWeeklyTimeBudget(plan.settings, active.plan.weeklyTimeMinutes),
    paceContext,
    progressId,
    // Les réglages du plan peuvent changer en cours d'ajustement ; l'échelle,
    // elle, se cale sur ceux d'aujourd'hui — c'est une estimation, pas un
    // contrat.
    estimatedChars: estimatePlanChars(
      chunked ? chunks[0].weeks : window.weeks,
      active.plan.sessionsPerWeek,
    ),
    ...(chunked ? { progressChunk: { index: 0, count: chunks.length } } : {}),
  });

  const weeks = chunked
    ? (
        await generateWeeksInChunks({
          chunks,
          messagesFor: (chunk, continuity) =>
            buildPlanUpdateMessages(active.plan, upcoming, window, instruction, paces, {
              chunk,
              continuity,
            }),
          firstChunkWeeks: output.weeks,
          // Le résumé est déjà écrit : il accompagne l'enveloppe du premier appel.
          withSummary: false,
          schemaName: 'training_plan_update_chunk',
          expectations: expectationsOf(output.settings),
          paceContext,
          weeklyTimeMinutes: resolveWeeklyTimeBudget(
            output.settings,
            active.plan.weeklyTimeMinutes,
          ),
          goalPaceSecPerKm: goalPace,
          sessionsPerWeek: output.settings?.sessionsPerWeek ?? active.plan.sessionsPerWeek,
          progressId,
        })
      ).weeks
    : output.weeks;

  // Séances et réglages en une seule transaction : un plan ne doit jamais
  // annoncer des contraintes que son calendrier ne suit pas.
  await applyPlanUpdate(active.plan.id, {
    fromDate,
    sessions: mapPlanWeeksToSessions(weeks, window.firstWeekStart),
    settings: planSettingsPatch(active.plan, output.settings, output.summary),
  });
  await afterActivePlanChanged(active.plan.id);

  const refreshed = await getActivePlanWithSessions();
  if (refreshed === null) throw new PlanNotFoundError();
  return refreshed.plan;
}
