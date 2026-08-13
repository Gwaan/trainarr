'use server';

/**
 * Server Action du calendrier : déplacer une séance planifiée d'un jour à
 * l'autre.
 *
 * Mince par construction, sur le modèle exact d'`actions.ts` : valider (Zod) →
 * vérifier l'appartenance → laisser juger le module de règles → déléguer
 * l'écriture au DAL → republier et revalider. Aucune règle d'entraînement ici :
 * elles vivent toutes dans `lib/plan-calendar/move-rules.ts`, qui est pur et
 * testé.
 *
 * Rappel de sécurité : une Server Action exportée est un endpoint public,
 * appelable par POST direct sans passer par l'écran. L'identifiant de séance et
 * la date d'arrivée viennent donc du client et ne sont jamais fiables — d'où le
 * schéma Zod, la vérification d'appartenance au plan actif (anti-IDOR), et les
 * gardes que le DAL rejoue de son côté dans le `WHERE` de son `UPDATE`.
 */

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';

import { todayCivilDate } from '@/data/athlete';
import {
  InvalidPlanError,
  PlanNotFoundError,
  SessionNotMovableError,
  getActivePlanWithSessions,
  rescheduleSession,
  type PlanSessionDto,
  type PlanWithSessions,
} from '@/data/plans';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';
import { judgeSessionMove, type MoveSession } from '@/lib/plan-calendar/move-rules';

import { planEndsOn } from './plan-weeks';

/**
 * État rendu au formulaire. Sérialisé vers le client : un statut, un message, et
 * les avertissements — jamais l'enregistrement DB, que la page relit du DAL
 * après revalidation.
 */
export type SessionMoveState = {
  status: 'idle' | 'success' | 'error';
  message?: string;
  /**
   * Ce que le déplacement casse, en français, quand il a quand même eu lieu.
   * Vide ou absent lorsqu'il ne casse rien.
   */
  warnings?: string[];
};

const NO_ACTIVE_PLAN = 'Aucun plan actif : recharge la page.';
const UNKNOWN_SESSION = "Cette séance n'est pas dans ton plan en cours : recharge la page.";

/** Un `FormData` ne porte que des chaînes ou des fichiers : un fichier n'est pas une réponse. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Identifiant de séance, tel que l'écran le renvoie.
 *
 * Même motif que le `planIdSchema` d'`actions.ts`, et pour la même raison : un
 * entier positif écrit en base 10, jamais coercé — `z.coerce.number()`
 * accepterait `' '`, `'1e3'` ou `'0x1f'`. La vraie garde reste plus bas (la
 * séance doit appartenir au plan actif de l'athlète) ; ceci n'écarte que ce qui
 * n'est même pas un id.
 */
const sessionIdSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,8}$/, 'Séance introuvable.')
  .transform(Number);

/**
 * Jour d'arrivée. La forme seule est vérifiée ici : qu'il soit passé, hors plan
 * ou identique au jour de départ est un **verdict**, pas une faute de saisie, et
 * c'est `judgeSessionMove` qui le rend avec son motif.
 */
const toDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date de destination invalide.');

const moveSchema = z.object({ sessionId: sessionIdSchema, toDate: toDateSchema });

/**
 * Le DTO du plan, réduit à ce que la décision lit.
 *
 * Une traduction, pas un enrichissement : `judgeSessionMove` n'a que faire du
 * titre ou de l'allure cible, et lui passer le DTO entier ferait dépendre un
 * module pur de la forme du DAL.
 */
function toMoveSession(session: PlanSessionDto): MoveSession {
  return {
    id: session.id,
    date: session.scheduledOn,
    kind: session.kind,
    completed: session.completedActivityId !== null,
    volumeM: session.volumeM,
    steps: session.steps,
  };
}

/**
 * Revalide sans jamais faire échouer l'action appelante.
 *
 * Même raison qu'en face (`actions.ts`) : `revalidatePath` re-rend la route côté
 * serveur et peut lever — survenant **après** une écriture commitée, l'exception
 * remonterait jusqu'à la frontière d'erreur, écran cassé pour un déplacement qui,
 * lui, a réussi.
 */
function revalidateSafely(paths: readonly string[], context: string): void {
  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error(`[calendrier] revalidation de ${path} impossible (${context}) :`, error);
    }
  }
}

/**
 * Déplace une séance planifiée au jour demandé.
 *
 * Compatible `useActionState` : `(état précédent, formData) => nouvel état`.
 *
 * Rien ne sort d'ici sous forme d'exception : une Server Action qui lève fait
 * afficher la frontière d'erreur, écran sur lequel l'utilisatrice n'a plus ni
 * message ni bouton pour recommencer. Un refus est une **valeur de retour**.
 */
export async function moveSessionAction(
  _previous: SessionMoveState,
  formData: FormData,
): Promise<SessionMoveState> {
  // TODO(auth) : pas encore de session dans Trainarr (mono-utilisateur, accès
  // réseau restreint). Dès qu'elle existera, vérifier ici l'identité de
  // l'appelant — un contrôle au niveau de la page ne protège pas cette action.

  const parsed = moveSchema.safeParse({
    sessionId: textField(formData, 'sessionId'),
    toDate: textField(formData, 'toDate'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Déplacement invalide.' };
  }

  const { sessionId, toDate } = parsed.data;

  let active: PlanWithSessions | null;
  try {
    active = await getActivePlanWithSessions();
  } catch (error) {
    console.error('[calendrier] lecture du plan actif impossible :', error);
    return { status: 'error', message: "Le plan n'a pas pu être lu. Réessaie." };
  }
  if (active === null) return { status: 'error', message: NO_ACTIVE_PLAN };

  // Anti-IDOR : la séance doit être **dans ce plan-là**. Le DAL le revérifie
  // dans le `WHERE` de son `UPDATE` (défense en profondeur) ; ici, c'est ce qui
  // permet de répondre autre chose qu'une erreur générique.
  const session = active.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) return { status: 'error', message: UNKNOWN_SESSION };

  const verdict = judgeSessionMove({
    session: toMoveSession(session),
    toDate,
    today: todayCivilDate(),
    plan: {
      startsOn: active.plan.startsOn,
      endsOn: planEndsOn(active.plan),
      longRunDay: active.plan.longRunDay,
    },
    siblings: active.sessions.map(toMoveSession),
  });

  if (!verdict.allowed) return { status: 'error', message: verdict.refusal.message };

  try {
    await rescheduleSession(active.plan.id, sessionId, toDate);
  } catch (error) {
    if (error instanceof SessionNotMovableError) {
      return { status: 'error', message: error.message };
    }
    if (error instanceof PlanNotFoundError) return { status: 'error', message: NO_ACTIVE_PLAN };
    if (error instanceof InvalidPlanError) return { status: 'error', message: error.message };

    console.error('[calendrier] déplacement de séance impossible :', error);
    return { status: 'error', message: "La séance n'a pas pu être déplacée. Réessaie." };
  }

  // À partir d'ici l'écriture est commitée : plus rien ne doit transformer ce
  // fait en échec. La republication part donc après la réponse (`after`), comme
  // à l'archivage — l'API injoignable, l'attendre ici tiendrait l'utilisatrice
  // sur un spinner le temps des délais de garde, pour un résultat qui ne change
  // rien à ce qu'elle va voir.
  after(() => syncPlanToIntervalsSafely('déplacement de séance'));

  // Le tableau de bord affiche la séance du jour : elle vient peut-être de
  // changer, dans un sens comme dans l'autre.
  revalidateSafely(['/plan', '/'], 'déplacement de séance');

  const warnings = verdict.warnings.map((warning) => warning.message);
  return {
    status: 'success',
    message: 'Séance déplacée.',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
