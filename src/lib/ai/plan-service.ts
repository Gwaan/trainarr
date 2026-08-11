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
 * Le poste le plus lourd est la méthodologie ({@link COACH_RULE_LINES}, ~1 500
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
  formatPace,
  formatPlanSteps,
  formatTrainingPaces,
  formatTrainingSnapshot,
} from './format';
import {
  PLAN_OUTPUT_BOUNDS,
  isMarathonGoal,
  mapPlanWeeksToSessions,
  planJsonSchema,
  planOutputSchema,
  planUpdateJsonSchema,
  planUpdateOutputSchema,
  validatePlanBusinessRules,
  type PlanExpectations,
  type PlanRaceGoal,
  type PlanUpdateOutput,
  type PlanValidationContext,
  type PlanWeekOutput,
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
 * l'estimation ») sérialise des semaines conformes à `COACH_RULE_LINES` en JSON
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
 * En deçà de ce nombre de jours restants dans la semaine du départ, la première
 * semaine ne compte **pas** comme une semaine d'entraînement du plan.
 *
 * Arbitrage : un plan de 8 semaines démarré un samedi laisse deux jours dans la
 * semaine en cours. Les compter pour une semaine d'entraînement en volerait une
 * vraie — l'athlète recevrait 7 semaines pleines là où elle en a demandé 8. À
 * partir de quatre jours (un départ du lundi au jeudi), la semaine entamée porte
 * assez de séances pour valoir une semaine du plan, sortie longue du week-end
 * comprise. Pour une course, la durée reste déduite des dates — mais le même
 * seuil décide si cette semaine-là compte dans le minimum
 * ({@link MIN_RACE_PLAN_WEEKS}) : sans lui, un départ un dimanche ferait passer
 * huit jours de préparation pour trois semaines de plan.
 */
const MIN_FIRST_WEEK_DAYS = 4;

/**
 * La semaine du départ vaut-elle une semaine d'entraînement ?
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
 * La dérivation des récupérations trottées depuis l'allure moyenne — la seule
 * ligne de la méthodologie que la table d'allures rend **fausse**.
 *
 * `imposedPacesSection` dit l'inverse (« plus lentes que E.max, ou sans cible »,
 * sans borne), et la validation applique cette version-là. Deux consignes
 * contradictoires dans le même prompt, c'est le modèle qui tranche — donc au
 * hasard. La ligne est retirée quand la table existe ({@link coachRules}).
 */
const RECOVERY_DERIVATION_LINE =
  '  · récupération trottée : référence + 60 à 120 s/km, ou aucune cible.';

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
 *
 * Ligne à ligne, et pas d'un bloc : {@link coachRules} en retire celles que la
 * table d'allures rend fausses.
 */
const COACH_RULE_LINES = [
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
  '',
  'ALLURES CIBLES — dérivées des seules données fournies',
  "- Référence = « Allure moyenne des dernières sorties » du contexte. Ce n'est pas une allure de tempo : c'est l'allure d'entraînement courante de l'athlète, donc à peu près son allure d'endurance, puisque l'essentiel de son volume est couru en endurance. Toutes les allures s'en déduisent, en secondes par kilomètre (un nombre plus petit est plus rapide) :",
  "  · endurance fondamentale et sortie longue : référence + 0 à 15 s/km — la référence EST déjà l'allure d'endurance, ne ralentis pas l'athlète artificiellement ;",
  '  · seuil : référence − 30 à 45 s/km ;',
  '  · VMA : référence − 60 à 80 s/km ;',
  '  · répétitions courtes : référence − 80 à 100 s/km ;',
  RECOVERY_DERIVATION_LINE,
  "- Ces écarts sont des maxima prudents : reste dans le bas de la fourchette si le volume récent est faible, si la charge (TSB) est très négative, ou si l'historique est court.",
  "- La VO2max estimée et les zones FC servent à vérifier la cohérence de ces allures, jamais à en fabriquer une.",
  "- Si l'allure de référence est inconnue, tu ne cibles AUCUNE allure : tu cibles par `hrZone` (endurance et sortie longue Z2, seuil Z4, VMA Z5, récupération Z1) et tu le dis dans le résumé.",
  "- Si l'objectif porte un chiffre (« 10 km sous 50 min » vaut 5:00/km), cette allure objectif est l'ancre des séances de spécificité à l'approche de la course. Confronte-la à l'allure récente : si elle est bien plus rapide que ce que les données soutiennent, le plan reste ancré sur les données et tu le dis honnêtement dans le résumé.",
  "- Tu n'inventes jamais une valeur : ce que les données ne permettent pas d'établir, tu le laisses vide ou tu l'écris dans le résumé. Si la charge d'entraînement n'est pas calculable, tu pars d'un volume délibérément conservateur et tu le dis.",
  '',
  'PROGRESSION DU VOLUME — ces chiffres sont vérifiés séance par séance, un plan qui les enfreint est refusé et à réécrire',
  '- Le volume hebdomadaire est la somme des `distanceKm` de la semaine. TOUTE séance déclare sa distance, footings et récupérations compris : sans elle, la semaine ne se compare à rien.',
  "- D'une semaine à l'autre, le volume n'augmente jamais de plus de 12 %. Vise 5 à 10 % : la marge est un filet, pas une cible. Une baisse est toujours permise.",
  '- Jamais quatre semaines de suite sans semaine allégée : sur toute fenêtre de 4 semaines, au moins une redescend à 85 % ou moins du volume de la semaine précédente (plans de 6 semaines et plus).',
  "- Le plan n'est jamais plat : la semaine la plus chargée hors affûtage dépasse d'au moins 10 % la première semaine pleine (plans de 5 semaines et plus). Douze semaines au même volume ne préparent rien.",
  "- Affûtage avant une course : les 2 dernières semaines (3 pour un marathon, sur un plan de 8 semaines et plus) baissent STRICTEMENT chaque semaine, et la semaine de la course ne dépasse pas 65 % du volume de la semaine la plus chargée. Volume nettement réduit, intensité maintenue — séances plus courtes, mêmes allures.",
  "- La première semaine, quand le plan démarre en cours de semaine, est amputée des jours passés : son volume est plus faible, et ce n'est pas une baisse.",
  "- La spécificité croît vers l'objectif : le travail se rapproche de l'allure de course à mesure que la course approche.",
  '',
  'FORMAT',
  "- Tu travailles EXCLUSIVEMENT en système métrique : distances en mètres et en kilomètres, allures en secondes par kilomètre. Jamais de miles, jamais de min/mile — 10:00/mile n'est pas une allure de ce plan.",
  '- Au niveau de la séance : `distanceKm` en kilomètres, `durationMin` en minutes, `targetPaceSecPerKm` en secondes par kilomètre. Dans `steps` : mètres et secondes.',
  "- Toute séance qui porte un `steps` déclare AUSSI sa distance totale estimée au niveau de la séance (`distanceKm`, échauffement et récupérations comprises) : c'est cette valeur qui sert à comparer le volume des séances entre elles.",
  "- Le résumé (`summary`) fait 3 à 5 phrases : la logique du bloc, la progression prévue, les points de vigilance. Tout en français.",
];

/**
 * La méthodologie telle qu'elle part au modèle.
 *
 * @param hasImposedPaces la table d'allures existe-t-elle ? Si oui, la section
 * « ALLURES IMPOSÉES » suivra et fait foi : les lignes de dérivation qu'elle
 * contredit sont retirées d'ici plutôt que surchargées plus bas — une consigne
 * absente ne se discute pas, une consigne surchargée si.
 */
function coachRules(hasImposedPaces: boolean): string {
  const lines = hasImposedPaces
    ? COACH_RULE_LINES.filter((line) => line !== RECOVERY_DERIVATION_LINE)
    : COACH_RULE_LINES;
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
 * au modèle, à la suite de {@link COACH_RULE_LINES}.
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
 */
function raceGoalOf(goalType: PlanGoalType, goalText: string): PlanRaceGoal | null {
  return goalType === 'race' ? { isMarathon: isMarathonGoal(goalText) } : null;
}

/**
 * Le chrono d'un plan déjà écrit, `undefined` s'il n'en porte pas.
 *
 * Les deux colonnes sont solidaires en base (invariant du DAL) ; le `undefined`
 * ne couvre donc que les plans antérieurs au champ, et non un demi-chrono.
 */
function planReferenceRace(plan: PlanDto): ReferenceRace | undefined {
  if (plan.referenceDistance === null || plan.referenceTimeS === null) return undefined;
  return { distance: plan.referenceDistance, timeS: plan.referenceTimeS };
}

/**
 * La prescription d'allures, telle qu'elle part au modèle — **en surcharge** de
 * la section « ALLURES CIBLES » de la méthodologie.
 *
 * Le renversement est tout l'objet de la manœuvre : sans chrono, le modèle
 * *dérive* des allures d'une moyenne d'entraînement, et le résultat constaté en
 * production allait de l'à-peu-près au délire. Avec un chrono, les cinq créneaux
 * sont **calculés** (Daniels) et le modèle n'a plus qu'à ranger chaque séance
 * dans le bon.
 */
function imposedPacesSection(paces: TrainingPaces, race: ReferenceRace): string {
  return [
    'ALLURES IMPOSÉES — cette section prime sur « ALLURES CIBLES » ci-dessus',
    formatTrainingPaces(paces, race),
    "Tes allures sont CALCULÉES, tu ne les choisis pas : endurance fondamentale et sortie longue dans [E], allure marathon ou allure objectif dans [M], seuil dans [T], VMA dans [I], répétitions courtes dans [R].",
    `Les récupérations trottées sont plus lentes que ${formatPace(paces.easy.maxSecPerKm)} (borne lente de [E]), ou sans cible.`,
    "Toute allure prescrite hors de ces plages est refusée : ne dérive plus rien de l'allure moyenne des dernières sorties, elle ne sert plus qu'à vérifier que le volume est tenable.",
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
 */
function firstWeekLines(request: PlanRequest, window: PlanWindow): string[] {
  if (window.firstWeekFromDay === 1) {
    return [`Chaque semaine compte exactement ${request.sessionsPerWeek} séances.`];
  }

  return [
    `weeks[0] est déjà entamée : elle ne porte de séances qu'à partir du ${formatIsoDay(window.firstWeekFromDay)} (day ≥ ${window.firstWeekFromDay}), et en compte ${request.sessionsPerWeek} au plus.`,
    request.longRunDay < window.firstWeekFromDay
      ? `Elle n'a pas de sortie longue : le ${formatIsoDay(request.longRunDay)} de cette semaine-là est passé.`
      : `Sa sortie longue reste le ${formatIsoDay(request.longRunDay)}.`,
    `Les semaines suivantes comptent exactement ${request.sessionsPerWeek} séances.`,
  ];
}

/**
 * Le message système : méthodologie générale, surcharge de niveau, puis — s'il y
 * a un chrono — la table d'allures qui remplace les règles de dérivation.
 *
 * L'ordre porte la priorité : chaque bloc surcharge le précédent, et le dit.
 */
function systemPrompt(
  level: PlanLevel | null,
  paces: TrainingPaces | null,
  race: ReferenceRace | undefined,
  extra: readonly string[] = [],
): string {
  const imposed = paces === null || race === undefined ? null : imposedPacesSection(paces, race);
  return [
    coachRules(imposed !== null),
    ...(level === null ? [] : ['', LEVEL_RULES[level]]),
    ...(imposed === null ? [] : ['', imposed]),
    ...extra,
  ].join('\n');
}

/** Les messages d'une génération de plan. */
export function buildPlanMessages(
  request: PlanRequest,
  window: PlanWindow,
  snapshot: TrainingSnapshotDto,
  paces: TrainingPaces | null = null,
): ChatMessage[] {
  // Depuis l'ancre : c'est elle qui porte la grille des semaines, `startsOn`
  // pouvant tomber en milieu de première semaine.
  const endsOn = shiftCivilDate(window.anchor, window.weeks * 7 - 1);

  const lines = [
    request.goalType === 'race' && request.raceDate !== undefined
      ? `Objectif : la course « ${request.goalText} », le ${formatCivilDate(request.raceDate)}.`
      : `Objectif : ${request.goalText}.`,
    `Niveau déclaré : ${LEVEL_LABELS[request.level]}.`,
    `Plan à produire : ${window.weeks} semaines, du ${formatCivilDate(window.startsOn)} au ${formatCivilDate(endsOn)}.`,
    `Contraintes : ${formatConstraints(request)}.`,
    '',
    `État de l'athlète au ${snapshot.today} :`,
    formatTrainingSnapshot(snapshot),
    '',
    `Rends les ${window.weeks} semaines dans l'ordre chronologique : weeks[0] est la semaine du ${formatCivilDate(window.anchor)}.`,
    ...firstWeekLines(request, window),
  ];

  return [
    // La méthodologie générale, puis les seules surcharges qui concernent cet
    // athlète : son niveau, et ses allures calculées quand il a donné un chrono.
    { role: 'system', content: systemPrompt(request.level, paces, request.referenceRace) },
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
    // Les plans antérieurs au champ n'en portent pas : rien n'est dit plutôt
    // qu'un niveau supposé, qui orienterait tout l'ajustement.
    ...(plan.level === null ? [] : [`Niveau déclaré : ${LEVEL_LABELS[plan.level]}.`]),
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
  paces: TrainingPaces | null = null,
): ChatMessage[] {
  // Le plan garde le niveau **et le chrono** de sa création : l'ajustement s'y
  // tient. Un plan sans niveau (antérieur au champ) reste sur la seule
  // méthodologie générale.
  const system = systemPrompt(plan.level, paces, planReferenceRace(plan), [
    '',
    "Tu modifies un plan existant : tu ne régénères que les semaines restantes, weeks[0] étant la première semaine restante. Le passé de l'athlète ne se réécrit pas.",
    "Les séances à venir te sont données avec leur déroulé. Tu réécris chaque séance en entier, `steps` compris : ce que l'instruction ne remet pas en cause, tu le reconduis tel quel — la progression déjà calée n'est pas à refaire.",
    "Si l'instruction change une contrainte durable (nombre de séances, jour de la sortie longue, temps hebdomadaire), reporte-la dans `settings` ; sinon, omets `settings`.",
    "Le résumé décrit le plan modifié dans son ensemble, pas la modification.",
  ]);

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
   * Ce à quoi les allures prescrites sont confrontées : la table calculée depuis
   * le chrono de l'athlète quand elle existe, son allure d'entraînement récente
   * sinon (cf. `validatePlanBusinessRules`). Les deux sont fournies des deux
   * côtés — c'est le corridor qui tranche.
   */
  paceContext: PlanValidationContext;
  /**
   * Identifiant de suivi fourni par le client, ou `undefined` : la génération se
   * déroule alors sans streaming ni progression, exactement comme avant.
   */
  progressId?: string;
  /** Taille attendue de la sortie ({@link estimatePlanChars}) — l'échelle du pourcentage. */
  estimatedChars: number;
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

  const { progressId } = options;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Chaque tentative repart de zéro : une reprise réécrit le plan complet,
    // donc le pourcentage recommence — et le front dit « tentative 2/3 » plutôt
    // que de laisser une barre reculer sans explication.
    if (progressId !== undefined) {
      setPlanProgress(progressId, { percent: 0, attempt, maxAttempts: MAX_ATTEMPTS });
    }

    let output: T;
    try {
      output = await chatCompletionJson<T>({
        messages,
        schemaName: options.schemaName,
        jsonSchema: options.jsonSchema,
        schema: options.schema,
        temperature: PLAN_TEMPERATURE,
        // Sa seule présence bascule l'appel en streaming (cf. `client.ts`).
        onProgress:
          progressId === undefined
            ? undefined
            : (receivedChars) => {
                setPlanProgress(progressId, {
                  percent: planProgressPercent(receivedChars, options.estimatedChars),
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

    violations = validatePlanBusinessRules(
      options.weeksOf(output),
      options.expectationsOf(output),
      options.paceContext,
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

  const output = await generateWithBusinessRules({
    messages: buildPlanMessages(request, window, snapshot, paces),
    schemaName: 'training_plan',
    jsonSchema: planJsonSchema,
    schema: planOutputSchema,
    weeksOf: (plan) => plan.weeks,
    expectationsOf: () => ({
      scope: 'creation',
      weeks: window.weeks,
      sessionsPerWeek: request.sessionsPerWeek,
      longRunDay: request.longRunDay,
      // > 1 sur un départ en milieu de semaine : la première semaine est jugée
      // comme une semaine entamée, exactement comme à l'ajustement.
      firstWeekFromDay: window.firstWeekFromDay,
      race: raceGoalOf(request.goalType, request.goalText),
    }),
    paceContext: { referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm, paces },
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

  const output = await generateWithBusinessRules({
    messages: buildPlanUpdateMessages(active.plan, upcoming, window, instruction, paces),
    schemaName: 'training_plan_update',
    jsonSchema: planUpdateJsonSchema,
    schema: planUpdateOutputSchema,
    weeksOf: (plan) => plan.weeks,
    expectationsOf: (plan) => ({
      // Fenêtre restante, pas plan complet : la règle anti-plat n'y a pas
      // d'objet — exiger un pic supérieur à la première semaine restante
      // réclamerait de monter le volume à quelques semaines de la course.
      scope: 'adjustment',
      weeks: window.weeks,
      sessionsPerWeek: plan.settings?.sessionsPerWeek ?? active.plan.sessionsPerWeek,
      longRunDay: plan.settings?.longRunDay ?? active.plan.longRunDay,
      firstWeekFromDay: window.firstWeekFromDay,
      // La fenêtre restante se termine avec le plan, donc avec la course : ses
      // dernières semaines sont bien celles de l'affûtage. Un ajustement demandé
      // à moins de 8 semaines d'un marathon n'en exigera que deux au lieu de
      // trois — la fenêtre est courte, et c'est le sens conservateur.
      race: raceGoalOf(active.plan.goalType, active.plan.goalText),
    }),
    paceContext: { referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm, paces },
    progressId,
    // Les réglages du plan peuvent changer en cours d'ajustement ; l'échelle,
    // elle, se cale sur ceux d'aujourd'hui — c'est une estimation, pas un
    // contrat.
    estimatedChars: estimatePlanChars(window.weeks, active.plan.sessionsPerWeek),
  });

  // Séances et réglages en une seule transaction : un plan ne doit jamais
  // annoncer des contraintes que son calendrier ne suit pas.
  await applyPlanUpdate(active.plan.id, {
    fromDate,
    sessions: mapPlanWeeksToSessions(output.weeks, window.firstWeekStart),
    settings: settingsPatch(active.plan, output),
  });
  await afterActivePlanChanged(active.plan.id);

  const refreshed = await getActivePlanWithSessions();
  if (refreshed === null) throw new PlanNotFoundError();
  return refreshed.plan;
}
