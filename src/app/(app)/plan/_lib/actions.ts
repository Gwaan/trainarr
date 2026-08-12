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
import {
  resyncPlanToIntervalsOnDemand,
  syncPlanToIntervalsSafely,
} from '@/lib/intervals/push-plan';
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
import { PLAN_INTENTS } from './plan-intent';
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

/** État de la republication manuelle du calendrier intervals.icu. */
export type PlanSyncState = {
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
    intent: z.enum(PLAN_INTENTS, { error: 'Choisis ce que tu viens chercher.' }),
    /**
     * La case « j'ai eu une blessure ces derniers mois ».
     *
     * Une case non cochée n'envoie rien : l'absence vaut « non ». Toute autre
     * valeur qu'`on` est traitée comme un « non » plutôt que refusée — il n'y a
     * pas de saisie à corriger sur une case, et faire échouer le formulaire sur
     * un POST bricolé n'apprendrait rien à personne.
     */
    returnInjuryHistory: z.string().transform((value) => value === 'on'),
    // Le niveau n'a pas de défaut côté serveur : le formulaire en propose un,
    // mais un POST direct qui l'omet est refusé plutôt que rangé d'office parmi
    // les intermédiaires.
    level: z.enum(['beginner', 'intermediate', 'advanced'], {
      error: 'Choisis ton niveau en course.',
    }),
    /** Note libre : facultative depuis que l'intention dit ce que le plan prépare. */
    goalText: z
      .string()
      .trim()
      .max(
        BOUNDS.goalTextMaxChars,
        `La note ne peut pas dépasser ${BOUNDS.goalTextMaxChars} caractères.`,
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

    if (form.intent === 'race') {
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
  // `goalType` n'a plus de champ à lui : il se déduit de l'intention, et c'est
  // donc le sélecteur qui porte le message.
  goalType: 'intent',
  intent: 'intent',
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
 * Revalide sans jamais faire échouer l'action appelante.
 *
 * `revalidatePath` ne se contente pas de marquer le cache : Next re-rend la
 * route côté serveur pour joindre sa charge RSC à la réponse de l'action. Une
 * exception peut donc en sortir — et, survenant **après** une écriture déjà
 * commitée, elle remonterait jusqu'à la frontière d'erreur : écran cassé pour
 * une mutation qui, elle, a réussi. On journalise et on rend la main, la
 * navigation suivante relira la base de toute façon.
 */
function revalidateSafely(paths: readonly string[], context: string): void {
  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error(`[plan] revalidation de ${path} impossible (${context}) :`, error);
    }
  }
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
    intent: textField(formData, 'intent'),
    returnInjuryHistory: textField(formData, 'returnInjuryHistory'),
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
    intent: form.intent,
    // L'antécédent ne veut rien dire hors reprise : le service et le DAL le
    // rangeraient de toute façon à `false`, autant ne pas le transmettre.
    returnInjuryHistory: form.intent === 'return' && form.returnInjuryHistory,
    level: form.level,
    goalText: form.goalText,
    raceDate: form.intent === 'race' ? form.raceDate : undefined,
    weeks: form.intent === 'race' ? undefined : Number(form.weeks),
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
 *
 * Rien ne sort d'ici sous forme d'exception : une Server Action qui lève fait
 * afficher la frontière d'erreur, écran sur lequel l'utilisatrice n'a plus ni
 * message ni bouton pour recommencer.
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

    return {
      status: 'error',
      message: failureMessage(error, 'adoption', "L'adoption n'a pas abouti — réessaie."),
    };
  }

  // À partir d'ici la transaction est commitée : le plan **est** adopté, et plus
  // rien ne doit pouvoir transformer ce fait en échec. Ce qui suit n'est que de
  // la propagation (rapprochement des séances, republication du calendrier), et
  // rendre une erreur inviterait à refaire une adoption déjà faite.
  try {
    // La politique d'un plan devenu actif vit dans le service, pas ici : une
    // adoption produit exactement les mêmes effets qu'un ajustement.
    await afterActivePlanChanged(planId);
  } catch (error) {
    console.error("[plan] suites de l'adoption impossibles :", error);
  }

  // Le tableau de bord affiche la séance du jour : elle vient de changer.
  revalidateSafely(['/plan', '/'], 'adoption');
  return { status: 'success', message: 'Plan adopté.' };
}

/**
 * Refuse la proposition : elle disparaît, et rien d'autre ne change — ni le plan
 * en cours, ni le calendrier intervals.icu, qui ne l'ont jamais connue.
 *
 * **Idempotent** : le refus vise un état — plus aucune proposition en attente.
 * Si le brouillon a déjà disparu (refusé depuis un autre onglet, remplacé par
 * une nouvelle génération), cet état est atteint, donc l'opération a réussi.
 *
 * Comme {@link acceptPlanAction}, ne lève jamais.
 */
export async function rejectPlanAction(
  _previous: PlanDecisionState,
  formData: FormData,
): Promise<PlanDecisionState> {
  // TODO(auth) : cf. `createPlanAction`.

  // Un identifiant illisible n'est pas un brouillon disparu, c'est une requête
  // qui ne veut rien dire : elle ne peut pas être tenue pour un refus abouti.
  const parsed = planIdSchema.safeParse(textField(formData, 'planId'));
  if (!parsed.success) return { status: 'error', message: NO_DRAFT };

  try {
    await discardDraftPlan(parsed.data);
  } catch (error) {
    if (!(error instanceof PlanNotFoundError)) {
      return {
        status: 'error',
        message: failureMessage(error, 'refus', "Le refus n'a pas abouti — réessaie."),
      };
    }
    // Brouillon déjà parti : on tombe dans la revalidation, qui fera disparaître
    // la carte restée à l'écran.
  }

  // Le tableau de bord n'a jamais vu cette proposition : rien à y revalider.
  revalidateSafely(['/plan'], 'refus');
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

/** Ce que la synchronisation a écrit, en français et sans jargon. */
function syncedMessage(pushed: number, deleted: number): string {
  const published =
    pushed === 0
      ? 'aucune séance à pousser'
      : pushed === 1
        ? '1 séance poussée'
        : `${pushed} séances poussées`;
  const removed =
    deleted === 0 ? '' : deleted === 1 ? ', 1 ancienne retirée' : `, ${deleted} anciennes retirées`;

  return `Calendrier resynchronisé : ${published}${removed}.`;
}

/**
 * Republie le calendrier intervals.icu à partir du plan actif, sur demande.
 *
 * Le seul déclencheur qui ne soit pas un changement de plan : il existe parce
 * qu'un déploiement peut changer le **format** des events poussés sans que rien
 * ne les réécrive (cf. l'en-tête de `resyncPlanToIntervalsOnDemand`).
 *
 * Aucun paramètre, et c'est un choix : l'action ne lit ni état précédent ni
 * champ de formulaire, il n'y a donc rien à valider. `useActionState` l'appelle
 * quand même avec les deux — JavaScript ignore les arguments en trop, et les
 * déclarer pour ne pas s'en servir donnerait à croire qu'ils portent quelque
 * chose. La garde qui compte est ailleurs : l'endpoint étant public, c'est le
 * service qui refuse de tourner sans plan actif ou pendant une
 * resynchronisation déjà en vol.
 *
 * Attendue dans le fil de la requête, contrairement aux synchronisations
 * automatiques : ici l'attente **est** le geste, et un bouton qui rend la main
 * sans rien dire ne vaudrait pas mieux que pas de bouton.
 */
export async function resyncIntervalsAction(): Promise<PlanSyncState> {
  // TODO(auth) : cf. `createPlanAction`.

  const outcome = await resyncPlanToIntervalsOnDemand();

  switch (outcome.status) {
    case 'synced':
      return { status: 'success', message: syncedMessage(outcome.pushed, outcome.deleted) };
    case 'no-plan':
      return { status: 'error', message: NO_ACTIVE_PLAN };
    case 'busy':
      return {
        status: 'error',
        message: 'Une resynchronisation est déjà en cours : laisse-la finir.',
      };
    case 'unconfigured':
      // Le motif exact est déjà journalisé côté serveur : il nomme des variables
      // d'environnement, ce n'est pas ce qu'on met sous les yeux de l'athlète.
      return {
        status: 'error',
        message: "Calendrier non synchronisé : la connexion à intervals.icu n'est pas configurée.",
      };
    case 'failed':
      return {
        status: 'error',
        message: "Le calendrier n'a pas pu être resynchronisé — réessaie dans un instant.",
      };
  }
}
