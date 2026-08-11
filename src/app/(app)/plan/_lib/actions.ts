'use server';

/**
 * Server Actions de la page « Plan ».
 *
 * Minces par construction : valider → déléguer au service (qui porte la garde
 * IA et les règles d'entraînement) → revalider. Aucune règle métier ici.
 *
 * Rappel de sécurité : une Server Action exportée est un endpoint public,
 * appelable par POST direct sans passer par le formulaire. Tout ce qui arrive
 * ici vient du client et n'est donc jamais fiable — d'où un schéma Zod sur
 * chaque entrée, y compris la confirmation d'archivage, qui est destructive.
 */

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';

import { AthleteNotFoundError, isCivilDate, todayCivilDate } from '@/data/athlete';
import {
  archiveActivePlan,
  InvalidPlanError,
  PlanNotFoundError,
  type PlanInputField,
} from '@/data/plans';
import { AiInvalidOutputError, AiResponseError, AiUnavailableError } from '@/lib/ai/errors';
import {
  MAX_PLAN_WEEKS,
  generatePlan,
  updatePlanFromInstruction,
  type PlanRequest,
} from '@/lib/ai/plan-service';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';

import { ARCHIVE_CONFIRMATION } from './form-options';
import { latestRaceDate } from './plan-window';

/*
 * États retournés aux formulaires. La valeur de retour est sérialisée vers le
 * client : un statut, des erreurs par champ, un message — jamais le plan brut,
 * que la page relit du DAL après revalidation.
 */

/** Champs du formulaire de création, tels que le client les nomme. */
export type PlanFormField =
  | 'goalType'
  | 'goalText'
  | 'raceDate'
  | 'weeks'
  | 'sessionsPerWeek'
  | 'weeklyTimeHours'
  | 'longRunDay';

export type PlanFormState = {
  status: 'idle' | 'success' | 'error';
  fieldErrors?: Partial<Record<PlanFormField, string>>;
  message?: string;
};

export type PlanUpdateState = {
  status: 'idle' | 'success' | 'error';
  fieldErrors?: { instruction?: string };
  message?: string;
};

export type PlanArchiveState = {
  status: 'idle' | 'success' | 'error';
  message?: string;
};

/*
 * Messages — un seul endroit pour la traduction des erreurs typées.
 */

const SUSPENDED = {
  unconfigured:
    "Coach IA non configuré : renseigne AI_BASE_URL dans .env.local pour activer la génération de plans.",
  unreachable:
    "L'API IA ne répond pas : les fonctions du coach sont suspendues. Réessaie dès qu'elle est de nouveau en ligne.",
} as const;

const INVALID_OUTPUT = "Le coach n'a pas réussi à produire un plan valide, réessaie.";
const NO_ACTIVE_PLAN = "Aucun plan actif : recharge la page.";
const NO_PROFILE = "Crée d'abord ton profil : le plan s'appuie sur tes données d'athlète.";
const CORRECT_FIELDS = 'Corrige les champs signalés.';

/** Bornes acceptées par l'action — plus larges que les listes du formulaire. */
const BOUNDS = {
  goalTextMaxChars: 200,
  weeks: { min: 4, max: 16 },
  sessionsPerWeek: { min: 2, max: 6 },
  longRunDay: { min: 1, max: 7 },
  /** Temps hebdomadaire, en minutes : de 1 h à 20 h. */
  weeklyTimeMinutes: { min: 60, max: 1_200 },
  instructionMaxChars: 500,
} as const;

/** Un `FormData` ne porte que des chaînes ou des fichiers : un fichier n'est pas une réponse. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** Choix d'une liste déroulante : un entier borné, transmis sous forme de chaîne. */
function boundedInteger(bounds: { min: number; max: number }, message: string) {
  return z
    .string()
    .trim()
    .refine((value) => {
      const parsed = Number(value);
      return value !== '' && Number.isInteger(parsed) && parsed >= bounds.min && parsed <= bounds.max;
    }, message)
    .transform((value) => Number(value));
}

/**
 * Temps hebdomadaire saisi en **heures** (« 4 », « 4,5 ») et converti en minutes.
 * Vide = non renseigné : le coach choisit alors le volume qu'il juge tenable.
 * La virgule décimale est acceptée — l'UI est française, et le clavier numérique
 * d'iOS ne propose parfois qu'elle.
 */
const weeklyTimeHoursField = z
  .string()
  .trim()
  .transform((value) => value.replace(',', '.'))
  .transform((value) => (value === '' ? null : Number(value)))
  .refine(
    (hours) =>
      hours === null ||
      (Number.isFinite(hours) &&
        hours * 60 >= BOUNDS.weeklyTimeMinutes.min &&
        hours * 60 <= BOUNDS.weeklyTimeMinutes.max),
    'Temps hebdomadaire : entre 1 h et 20 h.',
  )
  .transform((hours) => (hours === null ? null : Math.round(hours * 60)));

const planFormSchema = z
  .object({
    goalType: z.enum(['race', 'free'], { error: "Choisis un type d'objectif." }),
    goalText: z
      .string()
      .trim()
      .min(1, 'Décris ton objectif en une phrase.')
      .max(
        BOUNDS.goalTextMaxChars,
        `L'objectif ne peut pas dépasser ${BOUNDS.goalTextMaxChars} caractères.`,
      ),
    // Ces deux-là s'excluent : seul celui qu'impose `goalType` est vérifié.
    raceDate: z.string().trim(),
    weeks: z.string().trim(),
    sessionsPerWeek: boundedInteger(
      BOUNDS.sessionsPerWeek,
      `Entre ${BOUNDS.sessionsPerWeek.min} et ${BOUNDS.sessionsPerWeek.max} séances par semaine.`,
    ),
    weeklyTimeHours: weeklyTimeHoursField,
    longRunDay: boundedInteger(BOUNDS.longRunDay, 'Sortie longue : choisis un jour de la semaine.'),
  })
  .superRefine((form, ctx) => {
    if (form.goalType === 'race') {
      const today = todayCivilDate();

      if (!isCivilDate(form.raceDate)) {
        ctx.addIssue({
          code: 'custom',
          path: ['raceDate'],
          message: 'Date de course : indique le jour de ta course.',
        });
      } else if (form.raceDate <= today) {
        ctx.addIssue({
          code: 'custom',
          path: ['raceDate'],
          message: 'La course doit être à venir.',
        });
      } else if (form.raceDate > latestRaceDate(today)) {
        // Même borne que celle du service, dite ici sur le champ : sans elle,
        // l'utilisatrice attend une génération de plusieurs minutes pour se voir
        // refuser une date que le formulaire pouvait écarter tout de suite.
        ctx.addIssue({
          code: 'custom',
          path: ['raceDate'],
          message: `Course trop lointaine : un plan couvre ${MAX_PLAN_WEEKS} semaines au plus.`,
        });
      }
      return;
    }

    const weeks = Number(form.weeks);
    if (
      form.weeks === '' ||
      !Number.isInteger(weeks) ||
      weeks < BOUNDS.weeks.min ||
      weeks > BOUNDS.weeks.max
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['weeks'],
        message: `Durée du plan : entre ${BOUNDS.weeks.min} et ${BOUNDS.weeks.max} semaines.`,
      });
    }
  });

/** Les champs du formulaire, dans l'ordre où le rapport d'erreurs les parcourt. */
const PLAN_FORM_FIELDS = [
  'goalType',
  'goalText',
  'raceDate',
  'weeks',
  'sessionsPerWeek',
  'weeklyTimeHours',
  'longRunDay',
] as const satisfies readonly PlanFormField[];

/**
 * Champ du DAL → champ du formulaire. `startsOn` et `sessions` n'en ont aucun :
 * ils sont calculés par le service, leur message reste général.
 */
const FIELD_OF_PLAN_INPUT: Partial<Record<PlanInputField, PlanFormField>> = {
  goalType: 'goalType',
  goalText: 'goalText',
  raceDate: 'raceDate',
  weeks: 'weeks',
  sessionsPerWeek: 'sessionsPerWeek',
  weeklyTimeMinutes: 'weeklyTimeHours',
  longRunDay: 'longRunDay',
};

/**
 * Traduit une erreur du service en message affichable. Aucune trace d'exécution
 * ne franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 */
function failureMessage(error: unknown, context: string, fallback: string): string {
  if (error instanceof AiUnavailableError) return SUSPENDED[error.reason];
  if (error instanceof AiInvalidOutputError) return INVALID_OUTPUT;
  if (error instanceof PlanNotFoundError) return NO_ACTIVE_PLAN;
  if (error instanceof AthleteNotFoundError) return NO_PROFILE;
  if (error instanceof AiResponseError) {
    console.error(`[plan] réponse inexploitable du coach (${context}) :`, error);
    return "L'API du coach a répondu de travers. Réessaie dans un instant.";
  }

  console.error(`[plan] ${context} impossible :`, error);
  return fallback;
}

/**
 * Génère un plan complet avec le coach et l'active (le précédent est archivé).
 *
 * Compatible `useActionState` : `(état précédent, formData) => nouvel état`.
 * L'appel peut durer plusieurs minutes sur un modèle local — c'est le
 * formulaire qui le dit à l'utilisatrice, pas cette action.
 */
export async function createPlanAction(
  _previous: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  // TODO(auth) : pas encore de session dans Trainarr (mono-utilisateur, accès
  // réseau restreint). Dès qu'elle existera, vérifier ici l'identité de
  // l'appelant — un contrôle au niveau de la page ne protège pas cette action.

  const parsed = planFormSchema.safeParse({
    goalType: textField(formData, 'goalType'),
    goalText: textField(formData, 'goalText'),
    raceDate: textField(formData, 'raceDate'),
    weeks: textField(formData, 'weeks'),
    sessionsPerWeek: textField(formData, 'sessionsPerWeek'),
    weeklyTimeHours: textField(formData, 'weeklyTimeHours'),
    longRunDay: textField(formData, 'longRunDay'),
  });

  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    const fieldErrors: NonNullable<PlanFormState['fieldErrors']> = {};
    for (const field of PLAN_FORM_FIELDS) {
      const message = flat.fieldErrors[field]?.[0];
      if (message !== undefined) fieldErrors[field] = message;
    }
    return { status: 'error', fieldErrors, message: CORRECT_FIELDS };
  }

  const form = parsed.data;
  const request: PlanRequest = {
    goalType: form.goalType,
    goalText: form.goalText,
    raceDate: form.goalType === 'race' ? form.raceDate : undefined,
    weeks: form.goalType === 'free' ? Number(form.weeks) : undefined,
    sessionsPerWeek: form.sessionsPerWeek,
    weeklyTimeMinutes: form.weeklyTimeHours ?? undefined,
    longRunDay: form.longRunDay,
  };

  try {
    await generatePlan(request);
  } catch (error) {
    if (error instanceof InvalidPlanError) {
      const field = FIELD_OF_PLAN_INPUT[error.field];
      if (field === undefined) return { status: 'error', message: error.message };

      const fieldErrors: NonNullable<PlanFormState['fieldErrors']> = {};
      fieldErrors[field] = error.message;
      return { status: 'error', fieldErrors, message: CORRECT_FIELDS };
    }
    return {
      status: 'error',
      message: failureMessage(error, 'génération du plan', "Le plan n'a pas pu être généré. Réessaie."),
    };
  }

  revalidatePath('/plan');
  // Le tableau de bord affiche la séance du jour : elle vient de changer.
  revalidatePath('/');
  return { status: 'success', message: 'Ton plan est prêt.' };
}

const instructionSchema = z
  .string()
  .trim()
  .min(1, 'Écris ce que tu veux changer.')
  .max(
    BOUNDS.instructionMaxChars,
    `L'instruction ne peut pas dépasser ${BOUNDS.instructionMaxChars} caractères.`,
  );

/**
 * Applique une instruction en langage naturel au plan actif. Les séances déjà
 * réalisées sont protégées par le DAL, quoi que dise le modèle.
 */
export async function updatePlanAction(
  _previous: PlanUpdateState,
  formData: FormData,
): Promise<PlanUpdateState> {
  // TODO(auth) : cf. `createPlanAction`.

  const parsed = instructionSchema.safeParse(textField(formData, 'instruction'));
  if (!parsed.success) {
    return {
      status: 'error',
      fieldErrors: { instruction: parsed.error.issues[0]?.message ?? CORRECT_FIELDS },
      message: CORRECT_FIELDS,
    };
  }

  try {
    await updatePlanFromInstruction(parsed.data);
  } catch (error) {
    if (error instanceof InvalidPlanError) {
      return { status: 'error', message: error.message };
    }
    return {
      status: 'error',
      message: failureMessage(error, 'ajustement du plan', "Le plan n'a pas pu être ajusté. Réessaie."),
    };
  }

  revalidatePath('/plan');
  revalidatePath('/');
  return { status: 'success', message: 'Plan ajusté.' };
}

const archiveSchema = z.literal(ARCHIVE_CONFIRMATION, {
  error: "L'archivage doit être confirmé.",
});

/**
 * Archive le plan actif. L'écran repart alors sur la création d'un nouveau plan ;
 * les séances déjà réalisées restent attachées au plan archivé.
 */
export async function archivePlanAction(
  _previous: PlanArchiveState,
  formData: FormData,
): Promise<PlanArchiveState> {
  // TODO(auth) : cf. `createPlanAction`.

  const parsed = archiveSchema.safeParse(textField(formData, 'confirm'));
  if (!parsed.success) {
    return { status: 'error', message: "L'archivage doit être confirmé." };
  }

  let archived: boolean;
  try {
    archived = await archiveActivePlan();
  } catch (error) {
    console.error('[plan] archivage impossible :', error);
    return { status: 'error', message: "Le plan n'a pas pu être archivé. Réessaie." };
  }

  if (!archived) return { status: 'error', message: NO_ACTIVE_PLAN };

  // Le calendrier intervals.icu porte encore les séances à venir du plan
  // archivé : les y laisser ferait sonner des séances que plus aucun plan ne
  // pilote. Best-effort — l'archivage, lui, est fait, donc la synchronisation
  // part après la réponse (`after`) : l'API injoignable, l'attendre ici tiendrait
  // l'utilisatrice sur un spinner le temps des délais de garde, pour un résultat
  // qui ne change rien à ce qu'elle va voir.
  after(() => syncPlanToIntervalsSafely('archivage du plan'));

  revalidatePath('/plan');
  revalidatePath('/');
  return { status: 'success', message: 'Plan archivé.' };
}
