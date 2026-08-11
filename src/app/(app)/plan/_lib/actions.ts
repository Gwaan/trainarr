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
  acceptDraftPlan,
  archiveActivePlan,
  ConcurrentDraftError,
  discardDraftPlan,
  InvalidPlanError,
  PlanNotFoundError,
  type PlanInputField,
} from '@/data/plans';
import { AiInvalidOutputError, AiResponseError, AiUnavailableError } from '@/lib/ai/errors';
import {
  MAX_PLAN_WEEKS,
  MIN_RACE_PLAN_WEEKS,
  afterActivePlanChanged,
  generatePlan,
  updatePlanFromInstruction,
  type PlanRequest,
} from '@/lib/ai/plan-service';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';
import {
  InvalidRacePerformanceError,
  REFERENCE_DISTANCES,
  vdotFromRace,
  type ReferenceDistance,
} from '@/lib/metrics/vdot';

import {
  ARCHIVE_CONFIRMATION,
  PLAN_FORM_FIELDS,
  asReferenceDistance,
  parseRaceTimeSeconds,
  type PlanFormField,
} from './form-options';
import {
  MAX_PLAN_START_LEAD_WEEKS,
  earliestPlanStart,
  earliestRaceDate,
  latestPlanStart,
  latestRaceDate,
} from './plan-window';

/*
 * États retournés aux formulaires. La valeur de retour est sérialisée vers le
 * client : un statut, des erreurs par champ, un message — jamais le plan brut,
 * que la page relit du DAL après revalidation.
 */

/**
 * Champs du formulaire de création — déclarés dans `form-options.ts`
 * (`PLAN_FORM_FIELDS`), qu'un fichier `'use server'` ne peut pas héberger.
 * Réexportés ici parce que c'est la Server Action qui fait autorité sur ce que
 * l'UI a le droit d'attendre ; un type ne franchit aucune frontière au runtime.
 */
export type { PlanFormField };

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

/** État des deux issues d'une proposition : adoptée, ou refusée. */
export type PlanDecisionState = {
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
const NO_DRAFT = "Cette proposition n'existe plus : recharge la page.";
/** Deux générations lancées en même temps : la base n'en garde qu'une (`plans_draft_per_athlete`). */
const DRAFT_CONFLICT =
  "Une proposition vient d'être écrite par une autre génération : recharge la page pour la voir.";
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

/**
 * Identifiant de suivi de la progression, tiré par le navigateur et posé dans le
 * `FormData` au moment de la soumission (cf. `useGenerationProgress`).
 *
 * Facultatif par construction : un id absent ou mal formé ne fait **pas** échouer
 * une génération de plusieurs minutes pour un confort d'affichage. Le service
 * s'en passe alors — pas de streaming, pas de barre, la bannière d'attente
 * seule.
 */
const progressIdSchema = z.uuid();

function progressIdOf(formData: FormData): string | undefined {
  const parsed = progressIdSchema.safeParse(textField(formData, 'progressId'));
  return parsed.success ? parsed.data : undefined;
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

/** Le chrono lu du formulaire : soit un couple exploitable, soit rien, soit la faute à signaler. */
type ReferenceRaceRead = {
  race: { distance: ReferenceDistance; timeS: number } | null;
  error?: { field: 'referenceDistance' | 'referenceTime'; message: string };
};

/**
 * Lit le chrono de référence : forme du temps, distance connue, et **cohérence
 * physiologique** du couple.
 *
 * Ce dernier point passe par `vdotFromRace`, la fonction même qui calculera la
 * table d'allures : ce qui est accepté ici produira donc toujours une table. Un
 * 5 km en 12 minutes n'est pas une performance, c'est une faute de frappe — et la
 * refuser avant la génération épargne plusieurs minutes d'attente.
 *
 * Le champ est **facultatif** : temps vide = pas de chrono, et la distance seule
 * (que la liste déroulante porte toujours) ne déclare rien.
 */
function readReferenceRace(distance: string, time: string): ReferenceRaceRead {
  if (time.trim() === '') return { race: null };

  const timeS = parseRaceTimeSeconds(time);
  if (timeS === null) {
    return {
      race: null,
      error: {
        field: 'referenceTime',
        message: 'Chrono : écris-le en mm:ss ou hh:mm:ss (par exemple 48:30).',
      },
    };
  }

  const reference = asReferenceDistance(distance);
  if (reference === null) {
    return {
      race: null,
      error: { field: 'referenceDistance', message: 'Choisis la distance de ton chrono.' },
    };
  }

  try {
    vdotFromRace(REFERENCE_DISTANCES[reference], timeS);
  } catch (error) {
    if (error instanceof InvalidRacePerformanceError) {
      return {
        race: null,
        error: {
          field: 'referenceTime',
          message: 'Ce chrono ne ressemble pas à une course — vérifie la saisie.',
        },
      };
    }
    throw error;
  }

  return { race: { distance: reference, timeS } };
}

const planFormSchema = z
  .object({
    goalType: z.enum(['race', 'free'], { error: "Choisis un type d'objectif." }),
    // Le niveau n'a pas de défaut côté serveur : le formulaire en propose un,
    // mais un POST direct qui l'omet est refusé plutôt que rangé d'office parmi
    // les intermédiaires.
    level: z.enum(['beginner', 'intermediate', 'advanced'], {
      error: 'Choisis ton niveau en course.',
    }),
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
    /** Chrono de référence : facultatif, mais c'est lui qui calcule les allures. */
    referenceDistance: z.string().trim(),
    referenceTime: z.string().trim(),
    /** Facultatif : vide = aujourd'hui (le défaut du service). */
    startsOn: z.string().trim(),
    sessionsPerWeek: boundedInteger(
      BOUNDS.sessionsPerWeek,
      `Entre ${BOUNDS.sessionsPerWeek.min} et ${BOUNDS.sessionsPerWeek.max} séances par semaine.`,
    ),
    weeklyTimeHours: weeklyTimeHoursField,
    longRunDay: boundedInteger(BOUNDS.longRunDay, 'Sortie longue : choisis un jour de la semaine.'),
  })
  .superRefine((form, ctx) => {
    const today = todayCivilDate();

    const reference = readReferenceRace(form.referenceDistance, form.referenceTime);
    if (reference.error !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [reference.error.field],
        message: reference.error.message,
      });
    }
    // Date de démarrage : facultative, mais si elle est là c'est elle qui ancre
    // la fenêtre du plan — donc les bornes de la course en dépendent.
    const startsOn = form.startsOn === '' ? earliestPlanStart(today) : form.startsOn;
    let validStart = true;

    if (form.startsOn !== '') {
      if (!isCivilDate(form.startsOn)) {
        validStart = false;
        ctx.addIssue({
          code: 'custom',
          path: ['startsOn'],
          message: 'Début du programme : indique une date valide.',
        });
      } else if (form.startsOn < earliestPlanStart(today)) {
        validStart = false;
        ctx.addIssue({
          code: 'custom',
          path: ['startsOn'],
          message: "Le programme démarre aujourd'hui au plus tôt.",
        });
      } else if (form.startsOn > latestPlanStart(today)) {
        validStart = false;
        ctx.addIssue({
          code: 'custom',
          path: ['startsOn'],
          message: `Démarrage trop lointain : ${MAX_PLAN_START_LEAD_WEEKS} semaines à l'avance au plus, tes données auront changé d'ici là.`,
        });
      }
      // Aucune contrainte sur le jour de la semaine : un départ en milieu de
      // semaine ouvre une première semaine entamée (cf. `planWindow`).
    }

    if (form.goalType === 'race') {
      // La course est jugée sur la fenêtre réelle du plan : tant que la date de
      // démarrage est fautive, il n'y a pas de fenêtre à opposer à la course.
      if (!validStart) return;

      // Le désaccord entre les deux dates se signale sur celle que l'athlète
      // peut déplacer : sa course a lieu le jour qu'elle a, pas un autre.
      const conflictField = form.startsOn === '' ? 'raceDate' : 'startsOn';

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
      } else if (form.raceDate < earliestRaceDate(startsOn)) {
        ctx.addIssue({
          code: 'custom',
          path: [conflictField],
          message: `Il faut au moins ${MIN_RACE_PLAN_WEEKS} semaines entre le début du programme et la course pour le périodiser.`,
        });
      } else if (form.raceDate > latestRaceDate(startsOn)) {
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

/**
 * Champ du DAL → champ du formulaire. `sessions` n'en a aucun : il est calculé
 * par le service, son message reste général.
 */
const FIELD_OF_PLAN_INPUT: Partial<Record<PlanInputField, PlanFormField>> = {
  goalType: 'goalType',
  level: 'level',
  goalText: 'goalText',
  raceDate: 'raceDate',
  weeks: 'weeks',
  startsOn: 'startsOn',
  sessionsPerWeek: 'sessionsPerWeek',
  weeklyTimeMinutes: 'weeklyTimeHours',
  longRunDay: 'longRunDay',
  referenceDistance: 'referenceDistance',
  referenceTimeS: 'referenceTime',
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
  if (error instanceof ConcurrentDraftError) return DRAFT_CONFLICT;
  if (error instanceof AiResponseError) {
    console.error(`[plan] réponse inexploitable du coach (${context}) :`, error);
    return "L'API du coach a répondu de travers. Réessaie dans un instant.";
  }

  console.error(`[plan] ${context} impossible :`, error);
  return fallback;
}

/**
 * Génère un plan complet avec le coach et le soumet à l'athlète : le plan est
 * écrit en **proposition**, rien du plan en cours ne bouge. C'est
 * {@link acceptPlanAction} qui l'active.
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
    level: textField(formData, 'level'),
    goalText: textField(formData, 'goalText'),
    raceDate: textField(formData, 'raceDate'),
    weeks: textField(formData, 'weeks'),
    referenceDistance: textField(formData, 'referenceDistance'),
    referenceTime: textField(formData, 'referenceTime'),
    startsOn: textField(formData, 'startsOn'),
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
    level: form.level,
    goalText: form.goalText,
    raceDate: form.goalType === 'race' ? form.raceDate : undefined,
    weeks: form.goalType === 'free' ? Number(form.weeks) : undefined,
    // Vide : le service repart de son défaut, aujourd'hui.
    startsOn: form.startsOn === '' ? undefined : form.startsOn,
    sessionsPerWeek: form.sessionsPerWeek,
    weeklyTimeMinutes: form.weeklyTimeHours ?? undefined,
    longRunDay: form.longRunDay,
    // Relu après validation : `superRefine` a déjà refusé tout ce qui n'est pas
    // un chrono, il ne reste ici qu'un couple exploitable ou aucun chrono.
    referenceRace: readReferenceRace(form.referenceDistance, form.referenceTime).race ?? undefined,
  };

  try {
    await generatePlan(request, progressIdOf(formData));
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

  // Seule la page du plan change : une proposition ne pilote rien tant qu'elle
  // n'est pas adoptée, le tableau de bord affiche donc toujours la séance du
  // plan en cours.
  revalidatePath('/plan');
  return { status: 'success', message: 'Ta proposition de plan est prête.' };
}

/**
 * Identifiant de la proposition, tel que le formulaire le renvoie.
 *
 * Un `FormData` ne porte que des chaînes : le champ est validé comme un entier
 * positif écrit en base 10, jamais coercé — `z.coerce.number()` accepterait
 * `' '`, `'1e3'` ou `'0x1f'`. La vraie garde reste le DAL, qui exige que l'id
 * désigne un brouillon **de cet athlète** (anti-IDOR) ; ceci n'écarte que ce qui
 * n'est même pas un id.
 */
const planIdSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,8}$/, 'Proposition introuvable.')
  .transform(Number);

/**
 * Adopte la proposition du coach : elle devient le plan actif, et le plan
 * précédent est archivé avec ses séances à venir non réalisées.
 *
 * L'id vient du client comme tout le reste : c'est le DAL qui vérifie qu'il
 * désigne bien un brouillon de l'athlète, dans la transaction qui l'active.
 */
export async function acceptPlanAction(
  _previous: PlanDecisionState,
  formData: FormData,
): Promise<PlanDecisionState> {
  // TODO(auth) : cf. `createPlanAction`.

  const parsed = planIdSchema.safeParse(textField(formData, 'planId'));
  if (!parsed.success) return { status: 'error', message: NO_DRAFT };

  let planId: number;
  try {
    planId = (await acceptDraftPlan(parsed.data)).id;
  } catch (error) {
    if (error instanceof PlanNotFoundError) return { status: 'error', message: NO_DRAFT };

    console.error('[plan] adoption de la proposition impossible :', error);
    return { status: 'error', message: "Le plan n'a pas pu être adopté. Réessaie." };
  }

  // La politique d'un plan devenu actif vit dans le service, pas ici : une
  // adoption produit exactement les mêmes effets qu'un ajustement.
  await afterActivePlanChanged(planId);

  revalidatePath('/plan');
  // Le tableau de bord affiche la séance du jour : elle vient de changer.
  revalidatePath('/');
  return { status: 'success', message: 'Plan adopté.' };
}

/**
 * Refuse la proposition : elle disparaît, et rien d'autre ne change — ni le plan
 * en cours, ni le calendrier intervals.icu, qui ne l'ont jamais connue.
 */
export async function rejectPlanAction(
  _previous: PlanDecisionState,
  formData: FormData,
): Promise<PlanDecisionState> {
  // TODO(auth) : cf. `createPlanAction`.

  const parsed = planIdSchema.safeParse(textField(formData, 'planId'));
  if (!parsed.success) return { status: 'error', message: NO_DRAFT };

  try {
    await discardDraftPlan(parsed.data);
  } catch (error) {
    if (error instanceof PlanNotFoundError) return { status: 'error', message: NO_DRAFT };

    console.error('[plan] refus de la proposition impossible :', error);
    return { status: 'error', message: "La proposition n'a pas pu être écartée. Réessaie." };
  }

  // Le tableau de bord n'a jamais vu cette proposition : rien à y revalider.
  revalidatePath('/plan');
  return { status: 'success', message: 'Proposition écartée.' };
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
    await updatePlanFromInstruction(parsed.data, progressIdOf(formData));
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
