import 'server-only';

/**
 * Publication du plan d'entraînement au calendrier intervals.icu.
 *
 * Le pendant du poller : celui-ci **rapatrie** les séances réalisées, celui-là
 * **pousse** les séances à faire. Ce qui est écrit dans Trainarr par le coach
 * (génération, ajustement, archivage) doit apparaître — ou disparaître — au
 * calendrier, pour que la montre affiche la séance du jour.
 *
 * ## Une resynchronisation complète, jamais un journal d'opérations
 *
 * {@link syncPlanToIntervals} ne sait pas ce qui vient de changer, et n'a pas
 * besoin de le savoir : elle compare l'état voulu (le plan actif) à l'état
 * distant (les events du calendrier) et rend les deux identiques. Deux
 * conséquences : elle est idempotente (la rejouer ne fait rien de plus), et une
 * synchronisation ratée se rattrape à la suivante sans compensation à écrire.
 *
 * ## Trois règles de sûreté, non négociables
 *
 * 1. **Le calendrier de l'athlète n'appartient pas à Trainarr.** Seuls les
 *    events dont le `uid` commence par {@link TRAINARR_UID_PREFIX} sont
 *    touchés : une course, une note, une séance saisie à la main survivent à
 *    toute synchronisation.
 * 2. **Le passé n'est jamais touché** — ni poussé, ni supprimé. Une séance
 *    d'hier est de l'histoire ; la réécrire au calendrier n'aurait aucun effet
 *    utile et pourrait effacer ce que l'athlète y a annoté.
 * 3. **La suppression se fait par `id`**, jamais par `external_id` (réservé aux
 *    applications OAuth, cf. l'en-tête de `client.ts`). Les identifiants
 *    viennent donc toujours du GET qui précède.
 *
 * La synchronisation est un **confort, pas une condition** : elle n'est branchée
 * qu'à travers {@link syncPlanToIntervalsSafely}, qui ne propage rien. Un plan
 * écrit en base reste écrit même si intervals.icu est injoignable.
 */

import { env } from '@/config/env';
import { todayCivilDate } from '@/data/athlete';
import { getActivePlanWithSessions, PLAN_LIMITS, type PlanSessionDto } from '@/data/plans';
// Formateurs de `@/lib/ai/format` : purs, sans `server-only`, et déjà porteurs
// des conventions françaises du projet (allure `m:ss/km`). Les redéclarer ici
// ferait diverger la description d'une séance de ce que le coach en écrit.
import { formatPace } from '@/lib/ai/format';
import { shiftCivilDate } from '@/lib/dates/civil';
import { stepsToIntervalsSyntax } from '@/lib/plan-steps/intervals-syntax';

import {
  deleteCalendarEvents,
  listWorkoutEvents,
  upsertWorkoutEvents,
  type IntervalsEvent,
  type IntervalsEventId,
  type IntervalsWorkoutEvent,
} from './client';
import { planPollerActivation } from './poll-plan';

/**
 * Préfixe de tout `uid` posé par Trainarr.
 *
 * C'est la frontière de propriété du module : ce qui ne le porte pas n'est ni
 * mis à jour, ni supprimé, quelle que soit sa date.
 */
export const TRAINARR_UID_PREFIX = 'trainarr-';

/** Trainarr ne planifie que de la course à pied. */
const WORKOUT_TYPE = 'Run';

/**
 * `uid` d'une séance planifiée.
 *
 * Volontairement dérivé du **plan et du jour**, et non de l'identifiant de la
 * séance en base : un ajustement du coach supprime puis réinsère les séances à
 * venir (cf. `applyPlanUpdate`), donc leurs identifiants changent alors même que
 * la séance du mardi reste la séance du mardi. Un `uid` calé sur l'id ferait
 * disparaître puis réapparaître chaque event du calendrier à chaque instruction ;
 * calé sur le jour, il est **mis à jour sur place** par `upsertOnUid`.
 *
 * L'index départage deux séances tombant le même jour, dans l'ordre stable que
 * le DAL garantit (`scheduledOn` puis `id`). Le `planId` isole les plans entre
 * eux : archiver un plan laisse ses events orphelins, donc supprimables.
 */
export function planSessionUid(planId: number, scheduledOn: string, indexInDay: number): string {
  return `${TRAINARR_UID_PREFIX}p${planId}-${scheduledOn}-${indexInDay}`;
}

/**
 * Description de la séance, telle qu'elle s'affiche dans le calendrier.
 *
 * Deux régimes, selon ce que le plan porte :
 *
 * 1. **Séance structurée** (`steps`) : la description est le déroulé écrit dans
 *    la syntaxe native du workout builder d'intervals.icu, et **rien d'autre**.
 *    C'est ce que le service parse pour en faire une séance exécutable, poussée
 *    pas à pas à la montre par l'app Companion. Y ajouter le résumé en texte
 *    plat ne servirait qu'à donner au parseur des lignes à mal interpréter,
 *    alors que les étapes disent déjà l'échauffement, les récupérations, le
 *    retour au calme et les allures.
 * 2. **Séance en texte libre** (plans écrits avant les étapes structurées) : du
 *    texte plat assumé — fabriquer une syntaxe à partir d'un intitulé
 *    reviendrait à inventer la séance. Ce qui manque au plan ne produit pas de
 *    ligne.
 */
function describeSession(session: PlanSessionDto): string {
  if (session.steps !== null) return stepsToIntervalsSyntax(session.steps);

  const lines: string[] = [];

  if (session.warmup !== null) lines.push(`Échauffement : ${session.warmup}`);
  lines.push(`Séance : ${session.title}`);
  if (session.recovery !== null) lines.push(`Récupération : ${session.recovery}`);
  if (session.cooldown !== null) lines.push(`Retour au calme : ${session.cooldown}`);
  if (session.targetPaceSecPerKm !== null) {
    lines.push(`Allure cible : ${formatPace(session.targetPaceSecPerKm)}`);
  }

  return lines.join('\n');
}

/**
 * Les séances données, en events prêts à publier — fonction pure.
 *
 * `sessions` est supposé trié comme le DAL le rend (`scheduledOn` croissant,
 * puis `id`) : c'est cet ordre qui donne son index à une deuxième séance du même
 * jour, et donc la stabilité de son `uid`.
 */
export function buildWorkoutEvents(
  planId: number,
  sessions: readonly PlanSessionDto[],
): IntervalsWorkoutEvent[] {
  const countPerDay = new Map<string, number>();
  const events: IntervalsWorkoutEvent[] = [];

  for (const session of sessions) {
    const indexInDay = countPerDay.get(session.scheduledOn) ?? 0;
    countPerDay.set(session.scheduledOn, indexInDay + 1);

    const event: IntervalsWorkoutEvent = {
      uid: planSessionUid(planId, session.scheduledOn, indexInDay),
      startDate: session.scheduledOn,
      type: WORKOUT_TYPE,
      // Même composition que la ligne du plan dans l'UI : la nature de la
      // séance, puis son intitulé.
      name: `${session.kind} — ${session.title}`,
      description: describeSession(session),
    };

    // Aucune valeur inventée : un champ que le plan ne donne pas n'est pas
    // envoyé, plutôt qu'envoyé à zéro.
    if (session.durationS !== null) event.timeTargetS = session.durationS;
    if (session.volumeM !== null) event.distanceTargetM = session.volumeM;
    if (session.targetPaceSecPerKm !== null) event.target = 'PACE';

    events.push(event);
  }

  return events;
}

/**
 * Profondeur de la fenêtre interrogée, en jours : la plus longue durée qu'un
 * plan puisse couvrir, plus une semaine de marge.
 *
 * Elle est **fixe**, et pas déduite de la fin du plan actif : c'est ce qui
 * permet de retrouver les events d'un plan précédent plus long que l'actuel (ou
 * d'un plan archivé) pour les supprimer. Une fenêtre calée sur le plan courant
 * les laisserait au calendrier pour toujours.
 */
export const SYNC_HORIZON_DAYS = PLAN_LIMITS.weeks.max * 7 + 7;

/** Fenêtre à interroger : d'aujourd'hui à l'horizon. Le passé en est exclu. */
export function syncWindow(today: string): { oldest: string; newest: string } {
  return { oldest: today, newest: shiftCivilDate(today, SYNC_HORIZON_DAYS) };
}

/** Ce que la synchronisation doit faire pour rendre le calendrier conforme. */
export type CalendarDiff = {
  /** Séances à publier — création et mise à jour confondues (`upsertOnUid`). */
  toUpsert: IntervalsWorkoutEvent[];
  /** Events Trainarr qui ne correspondent plus à aucune séance du plan. */
  toDeleteIds: IntervalsEventId[];
};

/**
 * Le diff entre les séances voulues et les events déjà présents — fonction pure,
 * cœur testable de la synchronisation.
 *
 * Toutes les séances voulues sont republiées, sans chercher lesquelles ont
 * changé : le GET ne rend ni la description ni les cibles, comparer exigerait
 * une lecture complète de chaque event pour économiser un unique appel groupé.
 *
 * Côté suppression, deux conditions cumulatives : le `uid` porte le préfixe
 * Trainarr **et** il ne correspond à aucune séance voulue. Tout le reste — un
 * event sans `uid`, un `uid` étranger — est laissé intact.
 *
 * Un même `uid` Trainarr vu deux fois n'est gardé qu'une fois : `upsertOnUid`
 * est censé l'empêcher, mais rien ne le garantit côté API, et laisser deux
 * exemplaires en place casserait la convergence — le doublon survivrait à
 * chaque resynchronisation, et l'athlète verrait la séance en double au
 * calendrier pour toujours.
 */
export function diffCalendarEvents(
  desired: readonly IntervalsWorkoutEvent[],
  existing: readonly Pick<IntervalsEvent, 'id' | 'uid'>[],
): CalendarDiff {
  const desiredUids = new Set(desired.map((event) => event.uid));
  const keptUids = new Set<string>();
  const toDeleteIds: IntervalsEventId[] = [];

  for (const event of existing) {
    const { uid } = event;
    if (uid === null || !uid.startsWith(TRAINARR_UID_PREFIX)) continue;
    if (desiredUids.has(uid) && !keptUids.has(uid)) {
      keptUids.add(uid);
      continue;
    }
    toDeleteIds.push(event.id);
  }

  return { toUpsert: [...desired], toDeleteIds };
}

/** Ce qu'une synchronisation a fait, ou pourquoi elle n'a rien fait. */
export type PushReport =
  /** Pas de clé API (ou identifiant d'athlète illisible) : rien n'est tenté. */
  | { status: 'unconfigured'; reason: string }
  | { status: 'synced'; pushed: number; deleted: number };

/**
 * Aligne le calendrier intervals.icu sur le plan actif de l'athlète.
 *
 * Sans plan actif — archivage — le plan voulu est vide : toutes les séances
 * Trainarr encore à venir sont alors supprimées, et rien n'est publié.
 *
 * @throws {IntervalsApiError} et ses sous-classes si l'API refuse ou ne répond
 * pas. Les appelants applicatifs passent par {@link syncPlanToIntervalsSafely}.
 */
export async function syncPlanToIntervals(): Promise<PushReport> {
  // Même configuration que le poller : la clé API suffit, l'identifiant
  // d'athlète est facultatif (`0` = le porteur de la clé).
  const activation = planPollerActivation({
    athleteId: env.INTERVALS_ATHLETE_ID,
    apiKey: env.INTERVALS_API_KEY,
  });
  if (!activation.active) return { status: 'unconfigured', reason: activation.reason };

  const today = todayCivilDate();
  const active = await getActivePlanWithSessions();
  const desired =
    active === null
      ? []
      : buildWorkoutEvents(
          active.plan.id,
          // Comparaison lexicographique : sur des dates civiles `YYYY-MM-DD`,
          // elle coïncide avec l'ordre chronologique.
          active.sessions.filter((session) => session.scheduledOn >= today),
        );

  const range = syncWindow(today);
  const credentials = { athleteId: activation.athleteId, apiKey: activation.apiKey };

  const existing = await listWorkoutEvents({ ...credentials, ...range });
  const diff = diffCalendarEvents(desired, existing);

  // Suppression d'abord : une séance déplacée libère ainsi son ancien jour avant
  // que la nouvelle n'y soit publiée.
  if (diff.toDeleteIds.length > 0) {
    await deleteCalendarEvents({ ...credentials, ids: diff.toDeleteIds });
  }

  const pushed =
    diff.toUpsert.length === 0
      ? []
      : await upsertWorkoutEvents({ ...credentials, events: diff.toUpsert });

  return { status: 'synced', pushed: pushed.length, deleted: diff.toDeleteIds.length };
}

/**
 * La même synchronisation, en best-effort : elle ne lève jamais.
 *
 * C'est la forme sous laquelle l'application l'appelle, après chaque écriture de
 * plan. Faire échouer une génération de plusieurs minutes — ou un archivage —
 * parce qu'intervals.icu ne répond pas serait une régression pour l'athlète :
 * son plan est écrit, il est valide, et la prochaine écriture resynchronisera le
 * calendrier de toute façon.
 *
 * L'échec est journalisé, jamais tu : un calendrier qui ne se met plus à jour
 * doit avoir laissé une trace. La non-configuration l'est au même titre — c'est
 * un calendrier qui ne se remplira jamais, et rien d'autre ne le dirait sur ce
 * canal. Une ligne par synchronisation tentée, sans déduplication entre appels :
 * il n'y en a qu'à l'écriture d'un plan, et une ligne répétée reste préférable à
 * un service muet.
 */
export async function syncPlanToIntervalsSafely(context: string): Promise<void> {
  try {
    const report = await syncPlanToIntervals();
    if (report.status === 'unconfigured') {
      console.error(
        `[plan/intervals] ${context} : calendrier non synchronisé — ${report.reason}.`,
      );
      return;
    }
    if (report.pushed > 0 || report.deleted > 0) {
      console.log(
        `[plan/intervals] ${context} : calendrier synchronisé (publiées : ${report.pushed}, supprimées : ${report.deleted}).`,
      );
    }
  } catch (error) {
    console.error(`[plan/intervals] ${context} : calendrier non synchronisé —`, error);
  }
}
