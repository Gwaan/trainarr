import 'server-only';

/**
 * Révision automatique du plan : toutes les quelques séances réalisées, le coach
 * relit le plan au vu des résultats et le réadapte **si nécessaire**.
 *
 * ## Ce que la révision écrit, et sur quoi
 *
 * Elle s'applique au **plan actif directement**, pas à un brouillon. C'est le
 * contraire de la génération, et c'est délibéré : une proposition attend une
 * décision de l'athlète, or ce qu'on veut ici est un suivi continu — un plan qui
 * se corrige tout seul entre deux séances. Une proposition muette qui attendrait
 * un clic ne réadapterait rien ; et l'athlète garde de toute façon la main, la
 * page du plan lui montrant la date de la dernière révision et son résumé
 * portant la raison invoquée.
 *
 * Le reste du chemin est celui de l'ajustement par instruction : mêmes règles
 * métier (portée `adjustment`), mêmes allures imposées par le chrono du plan,
 * même écriture transactionnelle, mêmes effets de bord. Une révision n'est pas
 * un second moteur de planification, c'est un déclencheur.
 *
 * ## Cadence, et pourquoi un compte de séances
 *
 * Le marqueur est un **nombre de séances réalisées** déjà relues
 * (`plans.reviewed_session_count`), pas une date : ce qui donne matière à
 * réviser, c'est de l'entraînement réalisé, pas du temps écoulé. Une semaine
 * d'arrêt ne déclenche donc rien — les séances manquées, elles, seront au bilan
 * de la prochaine révision.
 *
 * ## Un seul review à la fois, et jamais par-dessus l'athlète
 *
 * Une génération dure des minutes ; l'import, lui, peut enchaîner des dizaines
 * de fichiers (rapatriement intervals.icu). Le verrou en mémoire
 * ({@link PlanReviewState}) garantit qu'un seul review tourne : un déclenchement
 * pendant ce temps est simplement ignoré, le prochain import retentera. Il vit
 * sur `globalThis`, pour être le même quel que soit le bundle qui déclenche
 * (cf. {@link REVIEW_STATE_KEY}) — mais ce n'est pas un verrou de base, il ne
 * protège que de la concurrence interne au process.
 *
 * Il ne protège donc pas de tout : un ajustement demandé depuis la page du plan
 * (`updatePlanFromInstruction`) ne le prend pas, et rien ne le protège d'un
 * second processus. D'où le
 * **contrôle de fraîcheur** : la révision retient l'`updatedAt` du plan au
 * moment du bilan et le relit juste avant d'écrire — s'il a bougé, elle
 * abandonne (marqueur intact, le prochain palier repartira de l'état à jour).
 * Reste la fenêtre entre cette relecture et la transaction, de l'ordre de la
 * milliseconde contre des minutes de génération : elle est assumée, la corriger
 * demanderait un verrou en base pour un mono-utilisateur.
 *
 * ## Échouer sans boucler
 *
 * Le marqueur est ce qui empêche de rejuger deux fois le même passé ; ne pas
 * l'avancer sur un échec **déterministe** (sortie hors schéma trois fois de
 * suite, plan produit hors fenêtre) laisserait le seuil franchi pour toujours,
 * et chaque fichier importé relancerait trois générations. Deux réponses, selon
 * la nature de l'échec :
 *
 * - **non transitoire** ({@link AiInvalidOutputError}, {@link InvalidPlanError})
 *   — le marqueur avance quand même, la révision est abandonnée en le disant :
 *   redemander la même chose au même modèle donnerait la même sortie ;
 * - **transitoire** (coach injoignable, réponse HTTP cassée, base indisponible)
 *   — le marqueur reste, mais un {@link REVIEW_COOLDOWN_MS} en mémoire interdit
 *   une nouvelle tentative avant une demi-heure. Sans lui, un backfill de
 *   plusieurs centaines de fichiers ferait tourner le modèle en continu.
 *
 * ## Le silence est un bug
 *
 * Chaque étape significative se journalise en `[plan/review]` : déclenchement,
 * décision (avec sa raison), échec. Une révision qui ne dit rien ne serait
 * distinguable ni d'un service en panne, ni d'un seuil jamais atteint.
 */

import { todayCivilDate } from '@/data/athlete';
import { getTrainingSnapshot, type TrainingSnapshotDto } from '@/data/coach-context';
import { reconcilePlanSessions } from '@/data/plan-reconciliation';
import {
  getPlanReview,
  getPlanUpdatedAt,
  markPlanReviewed,
  type PlanReviewDto,
  type PlanReviewOutcomeDto,
  type PlanReviewSessionDto,
} from '@/data/plan-review';
import {
  InvalidPlanError,
  applyPlanUpdate,
  getActivePlanWithSessions,
  type PlanDto,
  type PlanSessionDto,
} from '@/data/plans';
import { shiftCivilDate } from '@/lib/dates/civil';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';
import type { TrainingPaces } from '@/lib/metrics/vdot';

import { getAiAvailability } from './availability';
import type { ChatMessage } from './client';
import { AiInvalidOutputError } from './errors';
import {
  formatCivilDate,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatTrainingSnapshot,
} from './format';
import {
  applyImposedPaces,
  goalPaceSecPerKm,
  mapPlanWeeksToSessions,
  planReviewJsonSchema,
  planReviewOutputSchema,
  resolveWeeklyTimeBudget,
  type PlanReviewOutput,
  type PlanSettingsOutput,
} from './plan-schema';
import {
  estimatePlanChars,
  formatUpcomingPlan,
  generateWithBusinessRules,
  planSettingsPatch,
  planSystemPrompt,
  planTrainingPaces,
  planReferenceRace,
  raceGoalOf,
  remainingPlanWindow,
  type RemainingPlanWindow,
} from './plan-service';

/**
 * Nombre de séances réalisées non encore relues à partir duquel une révision se
 * déclenche.
 *
 * Quatre : c'est la cadence demandée (« toutes les 4-5 séances »), soit une à
 * deux semaines d'entraînement. Moins, et le coach rejugerait le plan sur une
 * poignée de sorties, où le bruit d'une mauvaise nuit pèse autant qu'une
 * tendance ; beaucoup plus, et une dérive s'installerait sans que rien ne bouge.
 */
export const REVIEW_EVERY_SESSIONS = 4;

/**
 * Délai d'attente après un échec **transitoire**, en millisecondes.
 *
 * Une demi-heure : assez pour qu'un `llama-server` en cours de chargement ou un
 * réseau coupé se rétablisse, assez peu pour qu'une révision ne soit pas perdue
 * de vue. Ce qu'il borne, c'est le coût d'un échec pendant un backfill — sans
 * lui, chacun des quelques centaines de fichiers importés relancerait jusqu'à
 * trois générations vouées au même échec.
 */
export const REVIEW_COOLDOWN_MS = 30 * 60 * 1000;

/** L'état de process du service : le verrou, et la garde d'après-échec. */
type PlanReviewState = {
  /** Une révision est-elle en cours ? Verrou de process, cf. l'en-tête. */
  reviewing: boolean;
  /**
   * Instant (epoch ms) avant lequel aucune nouvelle tentative n'est faite, après
   * un échec transitoire. `0` tant qu'il n'y en a pas eu.
   */
  retryNotBefore: number;
};

/**
 * La clé de l'état partagé.
 *
 * Une variable de module ne suffit **pas**, et c'est le même défaut que celui
 * diagnostiqué sur le registre de progression (cf. l'en-tête de `progress.ts`) :
 * en build standalone, le watcher FIT et un route handler n'embarquent pas
 * forcément la même instance de ce fichier. Deux instances, ce sont deux
 * verrous — donc deux révisions simultanées qui se réécriraient le même plan, et
 * un cooldown qu'une moitié du serveur ignorerait. Posé sur `globalThis` via le
 * registre global de symboles, l'état est unique pour le processus.
 */
const REVIEW_STATE_KEY: unique symbol = Symbol.for('trainarr.plan-review-state');

/** `globalThis` vu comme le porteur de cet état — la seule façon de le typer sans `any`. */
type GlobalWithReviewState = typeof globalThis & {
  [REVIEW_STATE_KEY]?: PlanReviewState;
};

/** L'état partagé, créé au premier accès quel que soit le bundle appelant. */
function reviewState(): PlanReviewState {
  const store = globalThis as GlobalWithReviewState;

  const existing = store[REVIEW_STATE_KEY];
  if (existing !== undefined) return existing;

  const created: PlanReviewState = { reviewing: false, retryNotBefore: 0 };
  store[REVIEW_STATE_KEY] = created;
  return created;
}

/**
 * Remet le service à son état initial : verrou libre, aucun cooldown.
 *
 * Exportée pour les tests uniquement — l'état survit d'un cas à l'autre (et
 * même d'un module rechargé à l'autre, puisqu'il vit sur `globalThis`), et un
 * cooldown posé par un scénario d'échec ferait sortir les suivants sans rien
 * faire.
 */
export function resetReviewState(): void {
  const state = reviewState();
  state.reviewing = false;
  state.retryNotBefore = 0;
}

/*
 * Le bilan, tel qu'il part au modèle.
 */

/** Le prévu d'une séance : ses mesures cibles, ou le fait qu'elle n'en portait pas. */
function formatPlannedTargets(session: PlanReviewSessionDto): string {
  const parts: string[] = [];
  if (session.volumeM !== null) parts.push(formatDistanceKm(session.volumeM));
  if (session.durationS !== null) parts.push(formatDuration(session.durationS));
  if (session.targetPaceSecPerKm !== null) parts.push(formatPace(session.targetPaceSecPerKm));
  return parts.length === 0 ? 'sans cible chiffrée' : parts.join(' · ');
}

/** Le couru : distance, temps, et les mesures que l'activité portait réellement. */
function formatOutcome(outcome: PlanReviewOutcomeDto): string {
  const parts = [formatDistanceKm(outcome.distanceM), formatDuration(outcome.movingTimeS)];
  if (outcome.avgPaceSecPerKm !== null) parts.push(formatPace(outcome.avgPaceSecPerKm));
  if (outcome.avgHrBpm !== null) parts.push(`FC ${outcome.avgHrBpm} bpm`);
  return parts.join(' · ');
}

/**
 * Une séance du bilan en une ligne : le prévu, puis le couru — ou « MANQUÉE ».
 *
 * Les deux sur la même ligne, dans cet ordre : c'est la comparaison qui est
 * demandée au coach, et un modèle qui lirait deux listes séparées devrait la
 * reconstituer lui-même.
 */
function formatReviewSession(session: PlanReviewSessionDto): string {
  const head = `- ${formatCivilDate(session.scheduledOn)} · ${session.kind} — ${session.title} (prévu : ${formatPlannedTargets(session)})`;
  return session.completed === null
    ? `${head} → MANQUÉE`
    : `${head} → couru : ${formatOutcome(session.completed)}`;
}

/**
 * Les consignes propres à la révision, en surcharge de la méthodologie.
 *
 * L'insistance sur « keep » n'est pas de la précaution rédactionnelle : un
 * modèle à qui l'on demande de juger un plan trouve toujours quelque chose à
 * corriger, et un plan réécrit toutes les quatre séances ne serait plus un plan.
 */
const REVIEW_SYSTEM_LINES = [
  '',
  "RÉVISION DU PLAN — tu relis un plan que l'athlète suit, au vu de ses résultats.",
  "- Si le plan reste adapté, tu ne changes RIEN : `decision` vaut « keep », tu n'écris ni `weeks` ni `settings`, et `reason` dit en une phrase pourquoi le plan tient. C'est la réponse par défaut.",
  "- Tu ne réécris la suite (`decision` vaut « adjust ») que si les résultats l'exigent : séances systématiquement au-dessus ou en-dessous des allures cibles, plusieurs séances manquées, ou fatigue installée (TSB très négatif, allures qui se dégradent à fréquence cardiaque égale). Un écart isolé, une séance manquée, une semaine un peu creuse : ce n'est pas une raison de réécrire un plan.",
  '- `reason` fait une à deux phrases en français : ce que tu constates dans les résultats, et ce que tu en fais.',
  "- En « adjust », tu régénères toutes les semaines restantes, weeks[0] étant la première semaine restante : le passé de l'athlète ne se réécrit pas. Tu réécris chaque séance en entier, `steps` compris — ce que les résultats ne remettent pas en cause, tu le reconduis tel quel.",
  "- En « adjust », si un réglage durable doit changer (nombre de séances, jour de la sortie longue, temps hebdomadaire), reporte-le dans `settings` ; sinon, omets `settings`.",
];

/**
 * Ce que le bilan ne détaille pas, en une ligne — ou rien s'il détaille tout.
 *
 * La ligne précède les séances détaillées : elle décrit un passé plus ancien,
 * et le bilan se lit dans l'ordre chronologique.
 */
function formatOlderSessions(review: PlanReviewDto): string[] {
  const { older } = review;
  if (older === null) return [];
  return [
    `- et ${older.count} séances plus anciennes (${older.completed} réalisées, ${older.missed} manquées), non détaillées.`,
  ];
}

/**
 * Les messages d'une révision. Exportée pour que les tests vérifient ce qui part
 * réellement : le plan restant, le bilan prévu/couru, et l'état de forme.
 */
export function buildPlanReviewMessages(
  plan: PlanDto,
  upcoming: readonly PlanSessionDto[],
  window: RemainingPlanWindow,
  review: PlanReviewDto,
  snapshot: TrainingSnapshotDto,
  paces: TrainingPaces | null = null,
): ChatMessage[] {
  const system = planSystemPrompt(
    plan.level,
    plan.goalType,
    paces,
    planReferenceRace(plan),
    REVIEW_SYSTEM_LINES,
  );

  const user = [
    formatUpcomingPlan(plan, upcoming, window),
    '',
    'Séances depuis ta dernière révision (prévu, puis réalisé) :',
    ...formatOlderSessions(review),
    ...review.sessions.map(formatReviewSession),
    '',
    `État de l'athlète au ${snapshot.today} :`,
    // Même régime qu'une génération : avec une table, l'allure moyenne des
    // dernières sorties sort du contexte (cf. `SnapshotFormatOptions`).
    formatTrainingSnapshot(snapshot, { withRecentPace: paces === null }),
    '',
    `Décide : « keep » si le plan reste adapté, « adjust » s'il faut réécrire les ${window.weeks} semaines restantes.`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/*
 * Résumé du plan.
 */

/** En-tête du paragraphe de révision dans le résumé du plan (cf. {@link withReviewNote}). */
const REVIEW_NOTE_PREFIX = 'Révision du ';

/**
 * Le résumé du plan, avec la raison de la dernière révision en dernier
 * paragraphe.
 *
 * Le paragraphe précédent de même nature est **remplacé**, jamais empilé : un
 * plan de douze semaines peut être révisé cinq ou six fois, et un résumé qui
 * grossirait à chaque passage finirait par noyer l'approche qu'il décrit.
 *
 * D'où la **normalisation de la raison en une ligne** : un modèle qui rendrait
 * un `reason` en deux paragraphes ferait une note en deux paragraphes, dont le
 * second ne porterait pas le préfixe — la révision suivante ne le reconnaîtrait
 * donc pas, et le laisserait s'empiler indéfiniment.
 *
 * Fonction pure, exportée pour les tests.
 */
export function withReviewNote(summary: string | null, today: string, reason: string): string {
  const note = `${REVIEW_NOTE_PREFIX}${formatCivilDate(today)} : ${reason.replace(/\s+/g, ' ').trim()}`;
  const kept = (summary ?? '')
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith(REVIEW_NOTE_PREFIX));

  return [...kept, note].join('\n\n');
}

/*
 * Révision.
 */

/** Le contexte d'une révision qui va réellement avoir lieu. */
type ReviewContext = {
  plan: PlanDto;
  upcoming: PlanSessionDto[];
  window: RemainingPlanWindow;
  review: PlanReviewDto;
  snapshot: TrainingSnapshotDto;
  paces: TrainingPaces | null;
  /** Jour à partir duquel la planification est réécrite : demain. */
  fromDate: string;
};

/**
 * Ce que la préparation a trouvé : de quoi réviser, ou un plan échu dont il n'y
 * a plus rien à faire — `null` couvrant les cas où il n'y a rien à dire du tout.
 */
type PreparedReview =
  | { kind: 'review'; context: ReviewContext }
  | { kind: 'finished'; planId: number; completedSessionCount: number };

/**
 * Relit le plan actif si assez de séances ont été réalisées depuis la dernière
 * révision, et le réadapte si les résultats l'exigent.
 *
 * **Ne lève jamais et n'est jamais attendue par un appelant** : c'est le
 * pipeline d'import qui la déclenche, en oubliant sa promesse. Un échec est
 * journalisé, et la suite dépend de sa nature (cf. l'en-tête) : le marqueur
 * avance sur un échec déterministe, il reste sur un échec transitoire — assorti
 * alors d'un {@link REVIEW_COOLDOWN_MS} qui empêche l'import suivant de
 * retenter aussitôt.
 *
 * No-op silencieux (aucun journal, il n'y a rien à dire) quand l'IA n'est pas
 * configurée ou joignable, quand il n'y a pas de plan actif, ou quand le seuil
 * de {@link REVIEW_EVERY_SESSIONS} séances n'est pas atteint.
 */
export async function maybeReviewActivePlan(): Promise<void> {
  const state = reviewState();
  if (state.reviewing) {
    console.log('[plan/review] déclenchement ignoré : une révision est déjà en cours.');
    return;
  }

  const now = Date.now();
  if (now < state.retryNotBefore) {
    const minutes = Math.ceil((state.retryNotBefore - now) / 60_000);
    console.log(
      `[plan/review] déclenchement ignoré : échec récent, nouvelle tentative dans ${minutes} min au plus tôt.`,
    );
    return;
  }

  state.reviewing = true;
  try {
    await reviewActivePlan();
  } catch (error) {
    const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
    // Échec transitoire : marqueur inchangé — la révision reste due — mais pas
    // avant la fin du cooldown, sans quoi l'import suivant la redemanderait.
    state.retryNotBefore = Date.now() + REVIEW_COOLDOWN_MS;
    console.error(
      `[plan/review] révision impossible — ${reason} ; nouvelle tentative dans ${Math.round(REVIEW_COOLDOWN_MS / 60_000)} min au plus tôt.`,
    );
  } finally {
    state.reviewing = false;
  }
}

/**
 * L'échec est-il de ceux qu'une nouvelle tentative ne réparerait pas ?
 *
 * Une sortie hors schéma après trois générations, ou un plan produit hors de sa
 * fenêtre, ne tiennent ni au réseau ni à la base : redemander la même chose au
 * même modèle sur les mêmes données donnerait la même sortie. Tout le reste —
 * coach injoignable, réponse HTTP cassée, base indisponible — est traité comme
 * transitoire, qui est le sens conservateur : au pire, on attend une demi-heure.
 */
function isPermanentFailure(error: unknown): boolean {
  return error instanceof AiInvalidOutputError || error instanceof InvalidPlanError;
}

/** Le corps de {@link maybeReviewActivePlan}, une fois le verrou pris. */
async function reviewActivePlan(): Promise<void> {
  const prepared = await prepareReview();
  if (prepared === null) return;

  if (prepared.kind === 'finished') {
    // Le marqueur avance : sans cela, le seuil resterait franchi et chaque
    // import rejouerait ce même constat.
    console.log(
      `[plan/review] plan ${prepared.planId} arrivé à son terme, rien à réviser — marqueur avancé.`,
    );
    await markPlanReviewed(prepared.planId, prepared.completedSessionCount);
    return;
  }

  const { context } = prepared;
  const { plan, review, window } = context;
  console.log(
    `[plan/review] déclenchée sur le plan ${plan.id} : ${review.completedSessionCount - review.reviewedSessionCount} séances réalisées depuis la dernière révision, ${window.weeks} semaines restantes.`,
  );

  try {
    await runReview(context);
  } catch (error) {
    if (!isPermanentFailure(error)) throw error;

    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `[plan/review] révision abandonnée (sortie du modèle inexploitable) — prochaine tentative au palier suivant (${REVIEW_EVERY_SESSIONS} séances) : ${detail}`,
    );
    await markPlanReviewed(plan.id, review.completedSessionCount);
  }
}

/**
 * La révision proprement dite : générer, décider, écrire, avancer le marqueur,
 * puis les effets de bord.
 *
 * L'ordre n'est pas indifférent. Le marqueur avance **dès que l'écriture a
 * réussi** : c'est elle le fait générateur, et une révision déjà inscrite au
 * plan ne doit jamais être remise en jeu par un rapprochement ou une
 * synchronisation ratés (cf. {@link applyReviewEffects}).
 */
async function runReview(context: ReviewContext): Promise<void> {
  const { plan, review } = context;
  const output = await generateReview(context);

  if (output.decision === 'keep') {
    await markPlanReviewed(plan.id, review.completedSessionCount);
    console.log(`[plan/review] plan ${plan.id} conservé — ${output.reason}`);
    return;
  }

  // Le plan a-t-il bougé pendant les minutes de génération ? Un ajustement
  // demandé entre-temps par l'athlète prime sur ce que le modèle vient
  // d'écrire — l'écraser reviendrait à annuler silencieusement sa demande.
  const updatedAt = await getPlanUpdatedAt(plan.id);
  if (updatedAt !== review.updatedAt) {
    console.log(
      `[plan/review] plan ${plan.id} modifié pendant la révision — abandon, le prochain palier repartira de l'état à jour.`,
    );
    return;
  }

  await applyReview(context, output);
  await markPlanReviewed(plan.id, review.completedSessionCount);
  console.log(`[plan/review] plan ${plan.id} ajusté — ${output.reason}`);

  await applyReviewEffects(plan.id);
}

/**
 * Tout ce qu'il faut pour réviser, `null` si la révision n'a pas lieu d'être
 * (pas d'IA, pas de plan actif, seuil non atteint), ou un plan échu.
 */
async function prepareReview(): Promise<PreparedReview | null> {
  const availability = await getAiAvailability();
  if (!availability.available) return null;

  const active = await getActivePlanWithSessions();
  if (active === null) return null;

  const review = await getPlanReview(active.plan.id);
  if (review === null) return null;
  if (review.completedSessionCount - review.reviewedSessionCount < REVIEW_EVERY_SESSIONS) {
    return null;
  }

  // Même reprise qu'un ajustement par instruction : demain. La séance du jour
  // est en cours ou déjà faite, la déplacer serait au mieux inutile.
  const fromDate = shiftCivilDate(todayCivilDate(), 1);
  const window = remainingWindowOrNull(active.plan, fromDate);
  if (window === null) {
    return {
      kind: 'finished',
      planId: active.plan.id,
      completedSessionCount: review.completedSessionCount,
    };
  }

  const upcoming = active.sessions.filter(
    (session) => session.scheduledOn >= fromDate && session.completedActivityId === null,
  );

  return {
    kind: 'review',
    context: {
      plan: active.plan,
      upcoming,
      window,
      review,
      snapshot: await getTrainingSnapshot(),
      // Le chrono déclaré à la création reste l'ancre des allures : une révision
      // réécrit des séances, pas la table qui les calibre.
      paces: planTrainingPaces(active.plan),
      fromDate,
    },
  };
}

/**
 * La fenêtre restante du plan, ou `null` s'il est arrivé à son terme.
 *
 * {@link remainingPlanWindow} en fait une {@link InvalidPlanError} — ce qui est
 * juste pour une instruction de l'athlète, qui mérite un message. Ici, un plan
 * échu n'est pas une anomalie : c'est un plan fini, et il n'y a rien à réviser.
 * Le laisser lever ferait journaliser une erreur à chaque import jusqu'à ce
 * qu'un nouveau plan soit créé.
 */
function remainingWindowOrNull(
  plan: { startsOn: string; weeks: number },
  fromDate: string,
): RemainingPlanWindow | null {
  try {
    return remainingPlanWindow(plan, fromDate);
  } catch (error) {
    // C'est le seul refus de cette fonction — cf. sa documentation.
    if (error instanceof InvalidPlanError) return null;
    throw error;
  }
}

/**
 * Les réglages d'une révision, **budget temps effacé écarté**.
 *
 * `weeklyTimeMinutes: null` veut dire « je n'ai plus de contrainte de temps »
 * (cf. `resolveWeeklyTimeBudget`), et c'est une décision qui appartient à
 * l'athlète : elle n'a de sens que sur le chemin de l'instruction
 * (`updatePlanFromInstruction`), où quelqu'un l'a demandée. Personne ne demande
 * une révision — elle se déclenche toute seule après quelques séances, et rien
 * dans ce qu'elle relit ne peut lui apprendre que le samedi matin s'est libéré.
 *
 * La grammaire GBNF ne propose pas ce `null` (cf. `settingsJsonSchema`), mais un
 * provider qui ne suit pas `response_format` peut l'écrire : ce serait alors le
 * modèle, seul, effaçant en base une contrainte de vie de l'athlète. Les autres
 * réglages passent, eux : réduire le nombre de séances ou déplacer la sortie
 * longue est exactement ce qu'une révision a le droit de conclure.
 *
 * Le champ est **retiré**, pas remis à sa valeur : `undefined` est l'état
 * « l'instruction ne touche pas au budget », celui qui reconduit le budget stocké
 * des deux côtés — validation comme écriture.
 */
function reviewSettings(settings: PlanSettingsOutput | undefined): PlanSettingsOutput | undefined {
  if (settings === undefined || settings.weeklyTimeMinutes !== null) return settings;
  return { sessionsPerWeek: settings.sessionsPerWeek, longRunDay: settings.longRunDay };
}

/** La génération, sous le même contrôle métier qu'un ajustement. */
function generateReview(context: ReviewContext): Promise<PlanReviewOutput> {
  const { plan, window, snapshot, paces } = context;

  return generateWithBusinessRules({
    messages: buildPlanReviewMessages(
      plan,
      context.upcoming,
      window,
      context.review,
      snapshot,
      paces,
    ),
    schemaName: 'training_plan_review',
    jsonSchema: planReviewJsonSchema,
    schema: planReviewOutputSchema,
    // « keep » ne réécrit aucune semaine : il n'y a rien à juger.
    weeksOf: (output) => (output.decision === 'adjust' ? output.weeks : null),
    expectationsOf: (output) => ({
      // Fenêtre restante, pas plan complet — même portée qu'un ajustement, pour
      // la même raison (cf. `updatePlanFromInstruction`).
      scope: 'adjustment',
      weeks: window.weeks,
      sessionsPerWeek:
        (output.decision === 'adjust' ? output.settings?.sessionsPerWeek : undefined) ??
        plan.sessionsPerWeek,
      longRunDay:
        (output.decision === 'adjust' ? output.settings?.longRunDay : undefined) ??
        plan.longRunDay,
      firstWeekFromDay: window.firstWeekFromDay,
      race: raceGoalOf(plan.goalType, plan.goalText),
    }),
    // « keep » ne porte aucune semaine : il n'y a rien à réécrire. L'allure
    // objectif vient du but du plan, comme à l'ajustement.
    withImposedPaces: (output, table) =>
      output.decision === 'adjust'
        ? {
            ...output,
            weeks: applyImposedPaces(output.weeks, table, goalPaceSecPerKm(plan.goalText)),
          }
        : output,
    // Le budget de vie de l'athlète vaut aussi quand c'est le coach qui reprend
    // la main : une révision n'a pas plus le droit qu'un ajustement de lui
    // planifier trois heures là où elle en a deux. Même mécanique qu'un
    // ajustement, donc : si la révision reporte un budget élargi dans ses
    // réglages, c'est celui-là qui juge ses semaines. « keep » n'en porte
    // aucun — et n'a de toute façon aucune semaine à juger. Un budget *effacé*,
    // lui, est ignoré (cf. `reviewSettings`).
    weeklyTimeBudgetOf: (output) =>
      resolveWeeklyTimeBudget(
        output.decision === 'adjust' ? reviewSettings(output.settings) : undefined,
        plan.weeklyTimeMinutes,
      ),
    paceContext: {
      referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm,
      paces,
      // Pas de `recentWeeklyKm` : le plan en cours fait foi (cf. `plan-service`).
    },
    // Pas de `progressId` : personne ne regarde une révision se dérouler.
    estimatedChars: estimatePlanChars(window.weeks, plan.sessionsPerWeek),
  });
}

/** L'écriture d'une révision qui ajuste : exactement le chemin de l'ajustement. */
async function applyReview(
  context: ReviewContext,
  output: Extract<PlanReviewOutput, { decision: 'adjust' }>,
): Promise<void> {
  const { plan, window, fromDate } = context;

  // Séances et réglages en une seule transaction, comme un ajustement. La raison
  // de la révision part avec, dans le résumé : c'est là que l'athlète la lira.
  await applyPlanUpdate(plan.id, {
    fromDate,
    sessions: mapPlanWeeksToSessions(output.weeks, window.firstWeekStart),
    settings: planSettingsPatch(
      plan,
      reviewSettings(output.settings),
      withReviewNote(plan.summary, context.snapshot.today, output.reason),
    ),
  });
}

/**
 * Les deux effets de bord d'un plan que l'athlète suit, tels qu'une **tâche de
 * fond** doit les mener : rapprocher les séances des activités déjà en base, et
 * republier le calendrier intervals.icu.
 *
 * Même politique que {@link afterActivePlanChanged}, à un détail près qui
 * décide de tout : la synchronisation est **attendue ici**, elle ne part pas en
 * `after()`. Le déclencheur nominal d'une révision est le watcher FIT
 * (`instrumentation` → `startFitService`), qui tourne **hors contexte de
 * requête** ; `after()` y lève `E468` (« `after` was called outside a request
 * scope »). Cette erreur remonterait après une écriture déjà committée : le
 * marqueur ne serait jamais avancé, et chaque fichier importé relancerait une
 * génération qui réécrirait le plan — en boucle. La synchronisation n'y perd
 * rien : il n'y a personne à ne pas faire attendre.
 *
 * Aucun des deux ne remonte, et chacun a sa garde : le plan est écrit, valide,
 * et le marqueur déjà avancé. Un rapprochement raté se rattrape au prochain
 * import, une synchronisation ratée à la prochaine écriture.
 */
async function applyReviewEffects(planId: number): Promise<void> {
  try {
    await reconcilePlanSessions(planId);
  } catch (error) {
    console.error(`[plan/review] rapprochement des séances du plan ${planId} impossible :`, error);
  }

  try {
    // La garde vit déjà dans le module de synchronisation ; celle-ci ne couvre
    // que ce qu'il ne prévoit pas.
    await syncPlanToIntervalsSafely('révision du plan');
  } catch (error) {
    console.error(`[plan/review] synchronisation du calendrier impossible :`, error);
  }
}
