import 'server-only';

/**
 * Publication du plan d'entraînement au calendrier intervals.icu.
 *
 * Le pendant du poller : celui-ci **rapatrie** les séances réalisées, celui-là
 * **pousse** les séances à faire. Ce qui est écrit dans Trainarr par le coach
 * (génération, ajustement, archivage) doit apparaître — ou disparaître — au
 * calendrier, pour que la montre affiche la séance du jour.
 *
 * ## Le marqueur est `external_id`, pas `uid` (fait vérifié)
 *
 * Une synchronisation ne peut agir que si elle sait reconnaître ses propres
 * events. Ce rôle revenait au `uid` : c'était un bug, constaté en production et
 * confirmé contre l'API le 2026-08-11 — **intervals.icu ignore le `uid` envoyé
 * par le client** et lui substitue un UUID serveur (posté
 * `uid: "trainarr-p3-…"`, l'event créé porte `uid: "bc3b5987-…"`). Aucun event
 * ne portait donc jamais notre marque : l'archivage d'un plan ne supprimait
 * rien, et les séances restaient au calendrier. `external_id`, lui, est
 * conservé tel quel et ressort intact au listing — c'est la seule clé
 * applicative utilisable avec une clé API.
 *
 * ## Remplacement complet, jamais un upsert
 *
 * Chaque synchronisation lit les events WORKOUT de la fenêtre, republie
 * **l'intégralité** des séances voulues, puis supprime **tous** les events
 * marqués que ce listing avait vus. Y compris les séances qui n'ont pas changé :
 * c'est plus d'écritures, mais cela ne repose sur aucune sémantique d'upsert non
 * documentée. `upsertOnUid` a été retiré : portant sur un `uid` que le serveur
 * réécrit, il n'aurait jamais pu matcher, et chaque resynchronisation aurait
 * dupliqué les séances.
 *
 * ## Créer d'abord, supprimer ensuite
 *
 * L'ordre inverse — purger puis republier — ouvre une fenêtre pendant laquelle
 * le calendrier est vide. Si la création échoue (délai de garde de 30 s sur près
 * de cent events, 5xx), il le reste jusqu'à la prochaine écriture de plan, qui
 * peut n'arriver que des semaines plus tard : l'athlète n'a plus rien à la
 * montre, et rien ne le lui dit.
 *
 * L'ordre retenu — lister, créer, supprimer ce que le listing avait vu — évite
 * cela sans rien risquer, parce que les identifiants à supprimer sont **figés
 * avant** la création : les events créés reçoivent des ids serveur frais, par
 * construction absents de la liste mémorisée. Une suppression ne peut donc
 * jamais emporter une séance qu'on vient de publier.
 *
 * Les deux modes de panne, et leur rattrapage :
 *
 * - **La création échoue** → aucune suppression n'a été émise, l'ancien
 *   calendrier reste intact. Il est périmé, mais complet : la montre affiche le
 *   plan précédent plutôt que rien. La synchronisation suivante le remplace.
 * - **La suppression échoue** → les séances voulues sont publiées, les anciennes
 *   sont toujours là : des doublons, visibles au calendrier. La synchronisation
 *   suivante les purge **tous les deux**, parce qu'elle décide ce qu'elle
 *   supprime sur le seul préfixe des events qu'elle vient de lister — jamais par
 *   comparaison avec ce qu'elle s'apprête à écrire, et sans supposer qu'un
 *   `external_id` soit unique. C'est ce qui rend la convergence indépendante du
 *   nombre d'échecs qui précèdent.
 *
 * La synchronisation reste donc idempotente — la rejouer converge vers le même
 * calendrier — et une synchronisation ratée se rattrape à la suivante, sans
 * compensation à écrire. Une seule limite, imposée par la règle 2 ci-dessous :
 * un doublon dont la date est passée sort de la fenêtre et y reste. Le passé
 * n'est pas réécrit, fût-il faux.
 *
 * **Limite connue, à nettoyer une fois à la main** : les events créés par les
 * versions antérieures ne portent pas d'`external_id` — leur marqueur partait
 * dans `uid`, que le serveur a écrasé. Ils ressortent donc avec
 * `external_id: null`, indiscernables d'une séance saisie par l'athlète, et
 * resteront invisibles pour la synchronisation. Il faut les supprimer depuis
 * intervals.icu ; ensuite le problème ne se repose plus.
 *
 * ## Trois règles de sûreté, non négociables
 *
 * 1. **Le calendrier de l'athlète n'appartient pas à Trainarr.** Seuls les
 *    events dont l'`external_id` commence par
 *    {@link TRAINARR_EXTERNAL_ID_PREFIX} sont touchés : une course, une note,
 *    une séance saisie à la main — `external_id` nul ou d'un autre préfixe —
 *    survivent à toute synchronisation.
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

import {
  getAthleteProfileById,
  getCurrentAthleteId,
  getIntervalsCredentialsById,
  todayCivilDate,
} from '@/data/athlete';
import { getActivePlanWithSessions, PLAN_LIMITS, type PlanSessionDto } from '@/data/plans';
// Formateurs de `@/lib/ai/format` : purs, sans `server-only`, et déjà porteurs
// des conventions françaises du projet (allure `m:ss/km`). Les redéclarer ici
// ferait diverger la description d'une séance de ce que le coach en écrit.
import { formatPace } from '@/lib/ai/format';
import { SecretDecryptionError, SecretKeyUnavailableError } from '@/lib/crypto/secret-box';
import { shiftCivilDate } from '@/lib/dates/civil';
import { canPrescribeHeartRate } from '@/lib/metrics/hr-targets';
import { hrZoneAnchor } from '@/lib/metrics/hr-zones';
import { stepsToIntervalsSyntax, type HrReference } from '@/lib/plan-steps/intervals-syntax';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import {
  createWorkoutEvents,
  deleteCalendarEvents,
  fetchRunMaxHr,
  listWorkoutEvents,
  type IntervalsEvent,
  type IntervalsEventId,
  type IntervalsWorkoutEvent,
} from './client';
import { planPollerActivation } from './poll-plan';

/**
 * Préfixe de tout `external_id` posé par Trainarr.
 *
 * C'est la frontière de propriété du module : ce qui ne le porte pas n'est ni
 * republié, ni supprimé, quelle que soit sa date.
 */
export const TRAINARR_EXTERNAL_ID_PREFIX = 'trainarr-';

/** Trainarr ne planifie que de la course à pied. */
const WORKOUT_TYPE = 'Run';

/**
 * `external_id` d'une séance planifiée.
 *
 * Seul le **préfixe** porte une décision : c'est lui qui dit « cet event est à
 * Trainarr », et donc supprimable. Le reste est descriptif, pour qui lit
 * l'event dans intervals.icu — de quel plan, de quel jour, et le rang de la
 * séance dans la journée, dans l'ordre stable que le DAL garantit
 * (`scheduledOn` puis `id`).
 *
 * Volontairement dérivé du **plan et du jour**, et non de l'identifiant de la
 * séance en base : un ajustement du coach supprime puis réinsère les séances à
 * venir (cf. `applyPlanUpdate`), donc leurs identifiants changent alors même que
 * la séance du mardi reste la séance du mardi. Ce n'est plus ce qui porte
 * l'idempotence — le remplacement complet s'en charge — mais un marqueur stable
 * reste lisible quand on compare deux synchronisations.
 */
export function planSessionExternalId(
  planId: number,
  scheduledOn: string,
  indexInDay: number,
): string {
  return `${TRAINARR_EXTERNAL_ID_PREFIX}p${planId}-${scheduledOn}-${indexInDay}`;
}

/**
 * Le déroulé d'une séance qui n'en a pas : une étape unique, sur la mesure que
 * le plan déclare — ou `null` quand il n'en déclare aucune.
 *
 * **Ce n'est pas inventer la séance**, c'est en écrire la seule chose qu'elle
 * dise déjà : un footing de 7 km à 7:08/km *est* une étape de course de 7 km à
 * 7:08/km. Rien n'est ajouté (pas d'échauffement fabriqué, pas de fractionné
 * déduit d'un intitulé), rien n'est supposé : sans allure cible, l'étape reste
 * libre.
 *
 * Ce qui le rend nécessaire est un fait constaté à la montre : l'app Companion
 * ne pousse **que** les événements dont la description est en syntaxe workout.
 * Une séance décrite en texte plat s'affiche au calendrier et n'atteint jamais
 * le poignet — c'est ainsi qu'une semaine entière de footings et de sorties
 * longues, correctement synchronisée, restait invisible à l'entraînement.
 *
 * La distance prime sur la durée quand le plan donne les deux : c'est la mesure
 * sur laquelle la séance se court (et celle que `distanceTargetM` porte déjà
 * dans l'event), la durée n'en étant que l'estimation à l'allure prévue.
 *
 * Les bornes du schéma ne sont pas revalidées ici : ces valeurs viennent de la
 * base, où le DAL les a déjà validées, et une séance hors bornes doit être
 * refusée à l'écriture — pas silencieusement dégradée à la publication.
 */
function singleRunSteps(session: PlanSessionDto): PlanSessionSteps | null {
  const measure =
    session.volumeM !== null
      ? { distanceM: session.volumeM, durationS: null }
      : session.durationS !== null
        ? { distanceM: null, durationS: session.durationS }
        : null;

  if (measure === null) return null;

  return [
    {
      repeat: 1,
      steps: [
        {
          role: 'run',
          ...measure,
          // Une allure cible unique, écrite comme une plage de bornes égales :
          // c'est la forme que `stepsToIntervalsSyntax` ramène à `7:08/km Pace`.
          paceMinSecPerKm: session.targetPaceSecPerKm,
          paceMaxSecPerKm: session.targetPaceSecPerKm,
          hrZone: null,
          note: null,
        },
      ],
    },
  ];
}

/**
 * Description de la séance, telle qu'elle s'affiche dans le calendrier.
 *
 * Trois régimes, selon ce que le plan porte :
 *
 * 1. **Séance structurée** (`steps`) : la description est le déroulé écrit dans
 *    la syntaxe native du workout builder d'intervals.icu, et **rien d'autre**.
 *    C'est ce que le service parse pour en faire une séance exécutable, poussée
 *    pas à pas à la montre par l'app Companion. Y ajouter le résumé en texte
 *    plat ne servirait qu'à donner au parseur des lignes à mal interpréter,
 *    alors que les étapes disent déjà l'échauffement, les récupérations, le
 *    retour au calme et les allures.
 * 2. **Séance mesurée mais non détaillée** (distance ou durée, sans `steps`) :
 *    la même syntaxe, réduite à l'étape unique que la séance décrit
 *    (cf. {@link singleRunSteps}). C'est ce qui la fait exister sur la montre.
 *
 *    Le résumé en texte plat **disparaît** alors, échauffement et conseils
 *    compris — il n'est pas conservé en préfixe. Trois raisons, dans cet ordre :
 *    rien ne garantit qu'une ligne non parsable laisse le workout parsable, et
 *    le risque porte précisément sur ce qu'on cherche à réparer ; c'est déjà la
 *    règle du régime 1, et faire cohabiter deux dialectes dans un même champ
 *    selon l'origine de la séance ne se justifierait par rien ; enfin ce qui
 *    disparaît n'est presque rien — l'intitulé et la nature de la séance
 *    restent lisibles au calendrier dans le `name` de l'event, et un footing
 *    sans déroulé n'a par construction ni échauffement ni récupération à
 *    détailler.
 * 3. **Séance sans mesure** : du texte plat assumé — sans distance ni durée, il
 *    n'y a aucune étape à écrire, et fabriquer une syntaxe à partir d'un
 *    intitulé reviendrait à inventer la séance. Ce qui manque au plan ne produit
 *    pas de ligne.
 *
 * @param hr les deux FC max — celle du profil, qui traduit les zones des étapes
 * en battements, et celle du compte intervals.icu, qui les ramène dans le seul
 * dialecte que son parseur accepte (cf. `lib/plan-steps/intervals-syntax`).
 */
function describeSession(session: PlanSessionDto, hr: HrReference | null): string {
  if (session.steps !== null) return stepsToIntervalsSyntax(session.steps, hr);

  const synthesized = singleRunSteps(session);
  if (synthesized !== null) return stepsToIntervalsSyntax(synthesized, hr);

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
 * jour, et donc la stabilité de son `external_id`.
 *
 * @param hr les deux FC max de la publication. Aucune n'est lue depuis la
 * séance : les étapes ne stockent qu'un rang de zone, et c'est ici, à la
 * publication, que la cible se calcule — une FC max corrigée au profil, comme
 * une FC max changée côté intervals.icu, repart donc à la synchronisation
 * suivante sans qu'un seul plan soit réécrit.
 */
export function buildWorkoutEvents(
  planId: number,
  sessions: readonly PlanSessionDto[],
  hr: HrReference | null = null,
): IntervalsWorkoutEvent[] {
  const countPerDay = new Map<string, number>();
  const events: IntervalsWorkoutEvent[] = [];

  for (const session of sessions) {
    const indexInDay = countPerDay.get(session.scheduledOn) ?? 0;
    countPerDay.set(session.scheduledOn, indexInDay + 1);

    const event: IntervalsWorkoutEvent = {
      externalId: planSessionExternalId(planId, session.scheduledOn, indexInDay),
      startDate: session.scheduledOn,
      type: WORKOUT_TYPE,
      // Même composition que la ligne du plan dans l'UI : la nature de la
      // séance, puis son intitulé.
      name: `${session.kind} — ${session.title}`,
      description: describeSession(session, hr),
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
export type CalendarReplacement = {
  /** Séances à créer : toutes celles que le plan veut, sans exception. */
  toCreate: IntervalsWorkoutEvent[];
  /**
   * Events Trainarr vus dans la fenêtre : tous, sans exception — et tels que le
   * listing les a rendus, donc **avant** toute création. C'est ce qui permet de
   * créer avant de supprimer sans jamais effacer ce qu'on vient de publier.
   */
  toDeleteIds: IntervalsEventId[];
};

/**
 * Le remplacement à opérer : ce qu'on republie, ce qu'on efface — fonction pure,
 * cœur testable de la synchronisation.
 *
 * **Toutes** les séances voulues sont recréées, et **tous** les events marqués
 * Trainarr du listing sont supprimés, y compris ceux dont la séance n'a pas
 * bougé. Aucune comparaison n'est tentée : le GET ne rend ni la description ni
 * les cibles, et l'API ne sait pas mettre un event à jour sur une clé à nous
 * (cf. l'en-tête). Décider sur le seul préfixe est ce qui purge aussi les
 * doublons qu'une suppression ratée aurait laissés — deux exemplaires d'un même
 * `external_id` sont deux ids, donc deux suppressions.
 *
 * Une seule condition à la suppression : l'`external_id` porte le préfixe
 * Trainarr. Tout le reste — un event sans `external_id`, un `external_id`
 * étranger — est laissé strictement intact.
 */
export function planCalendarReplacement(
  desired: readonly IntervalsWorkoutEvent[],
  existing: readonly Pick<IntervalsEvent, 'id' | 'externalId'>[],
): CalendarReplacement {
  const toDeleteIds = existing
    .filter((event) => event.externalId?.startsWith(TRAINARR_EXTERNAL_ID_PREFIX) === true)
    .map((event) => event.id);

  return { toCreate: [...desired], toDeleteIds };
}

/** Ce qu'une synchronisation a fait, ou pourquoi elle n'a rien fait. */
export type PushReport =
  /** Pas de clé API (ou identifiant d'athlète illisible) : rien n'est tenté. */
  | { status: 'unconfigured'; reason: string }
  /**
   * Deux chiffres **mesurés**, pas deux intentions : `pushed` est le nombre
   * d'events que l'API confirme avoir créés, `deleted` le compte qu'elle rend
   * pour la suppression (`eventsDeleted`).
   */
  | { status: 'synced'; pushed: number; deleted: number };

/**
 * La FC max du compte intervals.icu, ou `null` si elle n'est pas lisible —
 * **une seule lecture par synchronisation**, pas une par séance.
 *
 * Elle ne prescrit rien : c'est le dénominateur sur lequel intervals.icu résout
 * les cibles en pourcentage, donc le seul moyen d'y faire arriver les battements
 * que le profil Trainarr prescrit (cf. `lib/plan-steps/intervals-syntax`).
 *
 * **Ne lève jamais, et dit toujours pourquoi elle rend `null`.** Un calendrier
 * publié sans cible cardiaque reste un calendrier utile — les distances, les
 * durées et les allures y sont — alors qu'une synchronisation qui échoue en
 * entier laisse la montre sur le plan précédent. Mais le silence serait pire que
 * les deux : sans cette ligne, des footings partiraient sans plage de FC des
 * semaines durant sans que rien ne l'explique.
 */
async function readIntervalsMaxHr(credentials: {
  athleteId: string;
  apiKey: string;
}): Promise<number | null> {
  try {
    const maxHrBpm = await fetchRunMaxHr(credentials);
    if (maxHrBpm === null) {
      console.error(
        "[plan/intervals] FC max absente des réglages sport intervals.icu (profil Run) — séances publiées sans cible de fréquence cardiaque.",
      );
    }
    return maxHrBpm;
  } catch (error) {
    console.error(
      '[plan/intervals] réglages sport intervals.icu illisibles — séances publiées sans cible de fréquence cardiaque :',
      error,
    );
    return null;
  }
}

/**
 * Les identifiants enregistrés, ou le constat que la clé ne se déchiffre plus.
 *
 * `getIntervalsCredentialsById` **lève** quand la clé est illisible, plutôt que
 * de la faire passer pour absente. C'est la bonne conduite pour le DAL et la
 * mauvaise pour ici : une clé perdue n'est pas une panne de synchronisation,
 * c'est une configuration à refaire — donc un `unconfigured` avec son motif, que
 * la resynchronisation manuelle réaffiche à l'athlète.
 */
async function readCredentials(athleteId: number): Promise<
  | { status: 'ready'; intervalsAthleteId: string | null; apiKey: string }
  | { status: 'unreadable'; reason: string }
  | null
> {
  try {
    const credentials = await getIntervalsCredentialsById(athleteId);
    return credentials === null ? null : { status: 'ready', ...credentials };
  } catch (error) {
    if (error instanceof SecretDecryptionError || error instanceof SecretKeyUnavailableError) {
      return {
        status: 'unreadable',
        reason: 'clé API intervals.icu illisible — la ressaisir dans le profil',
      };
    }
    throw error;
  }
}

/**
 * Aligne le calendrier intervals.icu sur le plan actif de l'athlète.
 *
 * Sans plan actif — archivage — le plan voulu est vide : toutes les séances
 * Trainarr encore à venir sont alors supprimées, et rien n'est publié.
 *
 * **L'athlète est un paramètre**, jamais une déduction. La publication a deux
 * déclencheurs : une écriture de plan demandée par l'athlète (Server Action —
 * l'appelant lit l'athlète de sa session) et une écriture décidée par le suivi
 * de plan derrière une ingestion de fond, qui n'a pas de requête et donc pas de
 * session. Lire les identifiants « du compte connecté » ne rendait rien dans le
 * second cas : le calendrier n'était jamais republié, et le journal ne montrait
 * qu'un « aucune clé API enregistrée » trompeur.
 *
 * @throws {IntervalsApiError} et ses sous-classes si l'API refuse ou ne répond
 * pas. Les appelants applicatifs passent par {@link syncPlanToIntervalsSafely}.
 */
export async function syncPlanToIntervals(athleteId: number): Promise<PushReport> {
  // Mêmes identifiants que le poller, et à la même source : ceux de l'athlète,
  // en base. La clé API suffit, l'identifiant d'athlète est facultatif
  // (`0` = le porteur de la clé).
  const stored = await readCredentials(athleteId);
  if (stored === null) {
    return { status: 'unconfigured', reason: 'aucune clé API intervals.icu enregistrée' };
  }
  if (stored.status === 'unreadable') return { status: 'unconfigured', reason: stored.reason };

  const activation = planPollerActivation({
    athleteId: stored.intervalsAthleteId ?? undefined,
    apiKey: stored.apiKey,
  });
  if (!activation.active) return { status: 'unconfigured', reason: activation.reason };

  const today = todayCivilDate();
  const credentials = { athleteId: activation.athleteId, apiKey: activation.apiKey };

  // Le profil est lu à **chaque** synchronisation, et jamais figé dans le plan :
  // c'est ce qui fait suivre une FC max corrigée sur tout le calendrier.
  const [active, profile] = await Promise.all([
    getActivePlanWithSessions(athleteId),
    getAthleteProfileById(athleteId),
  ]);
  const profileMaxHrBpm = profile?.maxHrBpm ?? null;
  // L'ancrage qui **prescrit** : la FC seuil si l'athlète en a adopté une, la FC
  // max sinon. La décision se prend une fois, ici, et descend jusqu'à la
  // sérialisation (cf. `plan-steps/intervals-syntax`).
  const profileAnchor = hrZoneAnchor(profileMaxHrBpm, profile?.lthrBpm ?? null);

  // La FC max distante n'a de sens qu'en dénominateur d'une prescription qui
  // existe : sans FC max exploitable au profil, aucune zone ne se traduit en
  // battements, et l'appel — comme l'avertissement qui l'accompagne — n'aurait
  // rien à dire.
  const intervalsMaxHrBpm =
    active !== null && canPrescribeHeartRate(profileMaxHrBpm)
      ? await readIntervalsMaxHr(credentials)
      : null;

  const desired =
    active === null
      ? []
      : buildWorkoutEvents(
          active.plan.id,
          // Comparaison lexicographique : sur des dates civiles `YYYY-MM-DD`,
          // elle coïncide avec l'ordre chronologique.
          active.sessions.filter((session) => session.scheduledOn >= today),
          { profileAnchor, intervalsMaxHrBpm },
        );

  const range = syncWindow(today);

  const existing = await listWorkoutEvents({ ...credentials, ...range });
  const replacement = planCalendarReplacement(desired, existing);

  // Création d'abord, suppression ensuite (cf. l'en-tête) : si la publication
  // échoue, l'ancien calendrier survit — périmé, mais complet. Les ids purgés
  // sont ceux du listing, arrêtés avant cette création : les events qui viennent
  // de naître portent d'autres ids, ils ne peuvent pas en faire partie.
  const pushed =
    replacement.toCreate.length === 0
      ? []
      : await createWorkoutEvents({ ...credentials, events: replacement.toCreate });

  const deleted =
    replacement.toDeleteIds.length === 0
      ? 0
      : await deleteCalendarEvents({ ...credentials, ids: replacement.toDeleteIds });

  return { status: 'synced', pushed: pushed.length, deleted };
}

/** Ce que rend une synchronisation best-effort : le rapport, ou l'échec absorbé. */
export type SafeSyncOutcome = PushReport | { status: 'failed' };

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
 *
 * Le résultat est **rendu** en plus d'être journalisé : les appels automatiques
 * l'ignorent (ils partent en `after()`), la resynchronisation manuelle en a
 * besoin pour dire à l'athlète ce qui vient de se passer.
 */
export async function syncPlanToIntervalsSafely(
  context: string,
  athleteId: number,
): Promise<SafeSyncOutcome> {
  try {
    const report = await syncPlanToIntervals(athleteId);
    if (report.status === 'unconfigured') {
      console.error(
        `[plan/intervals] ${context} : calendrier non synchronisé — ${report.reason}.`,
      );
      return report;
    }
    if (report.pushed > 0 || report.deleted > 0) {
      console.log(
        `[plan/intervals] ${context} : calendrier synchronisé (publiées : ${report.pushed}, supprimées : ${report.deleted}).`,
      );
    }
    return report;
  } catch (error) {
    console.error(`[plan/intervals] ${context} : calendrier non synchronisé —`, error);
    return { status: 'failed' };
  }
}

/*
 * Resynchronisation demandée à la main.
 *
 * Le calendrier n'est republié qu'aux changements de plan. Quand c'est le
 * **format** des events poussés qui change (une correction livrée par un
 * déploiement), le calendrier reste dans l'ancien format jusqu'au prochain
 * changement de plan — qui peut n'arriver que des semaines plus tard. D'où ce
 * déclencheur, qui ne fait rien d'autre que rejouer la synchronisation : elle
 * est idempotente par construction (cf. l'en-tête).
 */

/** Ce que rend une resynchronisation manuelle. */
export type ManualSyncOutcome =
  | SafeSyncOutcome
  /** Une resynchronisation manuelle est déjà en vol : celle-ci n'est pas partie. */
  | { status: 'busy' }
  /** Aucun plan actif : rien à republier, et surtout rien à purger. */
  | { status: 'no-plan' };

/**
 * La clé du verrou de resynchronisation manuelle.
 *
 * Même raison que pour l'état de révision (`review-service.ts`) et le registre
 * de progression : en build standalone, deux bundles peuvent embarquer deux
 * instances de ce module, donc deux variables de module — donc aucun verrou.
 * Posé sur `globalThis` via le registre global de symboles, il est unique au
 * processus.
 */
const MANUAL_SYNC_KEY: unique symbol = Symbol.for('trainarr.plan-manual-sync');

/** `globalThis` vu comme le porteur du verrou — la seule façon de le typer sans `any`. */
type GlobalWithManualSync = typeof globalThis & {
  [MANUAL_SYNC_KEY]?: { running: boolean };
};

/** Le verrou partagé, créé au premier accès quel que soit le bundle appelant. */
function manualSyncLock(): { running: boolean } {
  const store = globalThis as GlobalWithManualSync;

  const existing = store[MANUAL_SYNC_KEY];
  if (existing !== undefined) return existing;

  const created = { running: false };
  store[MANUAL_SYNC_KEY] = created;
  return created;
}

/**
 * Libère le verrou. Exporté **pour les tests uniquement** : il vit sur
 * `globalThis` et survit donc au rechargement du module d'un cas à l'autre.
 */
export function resetManualSyncLock(): void {
  manualSyncLock().running = false;
}

/**
 * Republie le calendrier à la demande de l'athlète, et dit ce qui s'est passé.
 *
 * Deux gardes, dans cet ordre :
 *
 * 1. **Un seul appel à la fois.** Un double-clic lancerait deux remplacements
 *    concurrents : chacun liste le calendrier avant que l'autre n'ait créé ses
 *    events, et publie donc en double ce que l'autre vient de publier. Le second
 *    appel est refusé net plutôt que mis en file — l'athlète attend devant son
 *    bouton, et la synchronisation en vol fait déjà exactement ce qu'il demande.
 *
 *    Le verrou ne couvre **que** cette porte : les synchronisations automatiques
 *    (adoption, ajustement, révision, archivage) ne le prennent pas. Les faire
 *    renoncer parce qu'une resynchronisation manuelle est en vol perdrait une
 *    republication — celle-ci a pu lister le calendrier avant que le plan ne
 *    soit écrit, et rien ne repasserait derrière.
 * 2. **Un plan actif.** Sans lui, `syncPlanToIntervals` supprime légitimement
 *    toutes les séances Trainarr à venir : c'est ce que fait l'archivage. Ce
 *    n'est pas ce que demande un bouton « resynchroniser », et l'action étant un
 *    endpoint public, un POST direct ne doit pas pouvoir vider le calendrier
 *    sous couvert de le rafraîchir.
 */
export async function resyncPlanToIntervalsOnDemand(): Promise<ManualSyncOutcome> {
  const lock = manualSyncLock();
  if (lock.running) return { status: 'busy' };
  lock.running = true;

  try {
    // Porte de **requête** : l'athlète vient de la session. Pas d'athlète, pas de
    // plan actif — la même réponse que si le plan avait été archivé.
    const athleteId = await getCurrentAthleteId();
    if (athleteId === null) return { status: 'no-plan' };

    if ((await getActivePlanWithSessions(athleteId)) === null) return { status: 'no-plan' };
    return await syncPlanToIntervalsSafely('resynchronisation manuelle', athleteId);
  } finally {
    lock.running = false;
  }
}
