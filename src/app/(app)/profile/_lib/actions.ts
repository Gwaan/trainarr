'use server';

/**
 * Server Actions du profil athlète.
 *
 * Minces par construction : valider → déléguer au DAL → revalider. Aucune
 * logique métier ici (bornes, unicité, écriture) — elle vit dans
 * `src/data/athlete.ts`, qui les re-vérifie quel que soit l'appelant.
 *
 * Rappel de sécurité : une Server Action exportée est un endpoint public,
 * appelable par POST direct sans passer par le formulaire. Tout ce qui arrive
 * ici vient du client et n'est donc jamais fiable.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  ATHLETE_PROFILE_LIMITS,
  AthleteAlreadyExistsError,
  AthleteNotFoundError,
  createAthlete,
  getCurrentAthleteId,
  hasAthlete,
  InvalidAthleteProfileError,
  isCivilDate,
  todayCivilDate,
  updateAthleteProfile,
  type AthleteProfileInput,
} from '@/data/athlete';
import { ATHLETE_SEXES } from '@/data/db/schema';
import { recoverPendingImports, type RecoveryReport } from '@/lib/fit/recover';

export type ProfileFormState = {
  status: 'idle' | 'success' | 'error';
  fieldErrors?: Partial<Record<keyof AthleteProfileInput, string>>;
  message?: string;
};

/*
 * Validation.
 *
 * Un champ facultatif laissé vide vaut `null` : le formulaire envoie toujours
 * ses champs, une chaîne vide est donc « non renseigné », jamais « zéro ».
 */

const { maxHrBpm, restingHrBpm, weightKg } = ATHLETE_PROFILE_LIMITS;

/**
 * Champ numérique facultatif, borné, avec un seul message par champ.
 *
 * La virgule décimale est acceptée (« 62,5 ») : l'UI est française, et selon la
 * plateforme le clavier numérique d'iOS ne propose que la virgule.
 */
function boundedNumber(
  bounds: { min: number; max: number },
  options: { integer: boolean; message: string },
) {
  return z
    .string()
    .trim()
    .transform((value) => value.replace(',', '.'))
    .transform((value) => (value === '' ? null : value))
    .refine((value) => {
      if (value === null) return true;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return false;
      if (options.integer && !Number.isInteger(parsed)) return false;
      return parsed >= bounds.min && parsed <= bounds.max;
    }, options.message)
    .transform((value) => (value === null ? null : Number(value)));
}

const profileSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, 'Le nom est requis.')
      .max(
        ATHLETE_PROFILE_LIMITS.displayNameMaxChars,
        `Le nom ne peut pas dépasser ${ATHLETE_PROFILE_LIMITS.displayNameMaxChars} caractères.`,
      ),
    sex: z
      .union([z.literal(''), z.enum(ATHLETE_SEXES)], {
        error: 'Sexe biologique : « femme », « homme », ou non renseigné.',
      })
      .transform((value) => (value === '' ? null : value)),
    maxHrBpm: boundedNumber(maxHrBpm, {
      integer: true,
      message: `FC max entre ${maxHrBpm.min} et ${maxHrBpm.max}.`,
    }),
    restingHrBpm: boundedNumber(restingHrBpm, {
      integer: true,
      message: `FC de repos entre ${restingHrBpm.min} et ${restingHrBpm.max}.`,
    }),
    weightKg: boundedNumber(weightKg, {
      integer: false,
      message: `Poids entre ${weightKg.min} et ${weightKg.max} kg.`,
    }),
    birthDate: z
      .string()
      .trim()
      .transform((value) => (value === '' ? null : value))
      .refine(
        (value) =>
          value === null ||
          (isCivilDate(value) &&
            value > ATHLETE_PROFILE_LIMITS.birthDateAfter &&
            value <= todayCivilDate()),
        'Date de naissance : une date passée, au format AAAA-MM-JJ, postérieure à 1900.',
      ),
  })
  .superRefine((profile, ctx) => {
    // Contrôle croisé : une FC de repos au-dessus de la FC max rendrait la
    // réserve cardiaque négative.
    if (
      profile.maxHrBpm !== null &&
      profile.restingHrBpm !== null &&
      profile.restingHrBpm >= profile.maxHrBpm
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['restingHrBpm'],
        message: 'La FC de repos doit être inférieure à la FC max.',
      });
    }
  });

/** Les champs du formulaire, dans l'ordre où le rapport d'erreurs les parcourt. */
const PROFILE_FIELDS = [
  'displayName',
  'sex',
  'maxHrBpm',
  'restingHrBpm',
  'weightKg',
  'birthDate',
] as const satisfies readonly (keyof AthleteProfileInput)[];

/** Un `FormData` ne porte que des chaînes ou des fichiers : un fichier n'est pas une valeur de profil. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/*
 * Rapport.
 */

function successMessage(created: boolean, recovery: RecoveryReport | null): string {
  if (!created) return 'Profil mis à jour.';
  if (recovery === null || (recovery.requeued === 0 && !recovery.backfillReopened)) {
    return 'Profil créé.';
  }

  const parts: string[] = [];
  if (recovery.requeued > 0) {
    parts.push(`${recovery.requeued} import${recovery.requeued > 1 ? 's' : ''} relancé${recovery.requeued > 1 ? 's' : ''}`);
  }
  if (recovery.backfillReopened) {
    parts.push('historique en cours de rapatriement');
  }
  return `Profil créé — ${parts.join(', ')}.`;
}

/**
 * Crée le profil (onboarding) ou met à jour celui qui existe.
 *
 * Compatible `useActionState` : `(état précédent, formData) => nouvel état`. La
 * valeur de retour est sérialisée vers le client — elle ne porte donc qu'un
 * statut, des erreurs par champ et un message, jamais l'enregistrement.
 *
 * À la première création, et à elle seule, la reprise des imports est déclenchée :
 * les fichiers refusés faute d'athlète repartent dans la boîte de dépôt. Son
 * échec éventuel n'invalide pas l'onboarding — le watcher rattrapera.
 */
export async function saveProfileAction(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  // TODO(auth) : pas encore de session dans Trainarr (mono-utilisateur, accès
  // réseau restreint). Dès qu'elle existera, vérifier ici l'identité de
  // l'appelant — un contrôle au niveau de la page ne protège pas cette action.

  const parsed = profileSchema.safeParse({
    displayName: textField(formData, 'displayName'),
    sex: textField(formData, 'sex'),
    maxHrBpm: textField(formData, 'maxHrBpm'),
    restingHrBpm: textField(formData, 'restingHrBpm'),
    weightKg: textField(formData, 'weightKg'),
    birthDate: textField(formData, 'birthDate'),
  });

  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    const fieldErrors: NonNullable<ProfileFormState['fieldErrors']> = {};
    for (const field of PROFILE_FIELDS) {
      const message = flat.fieldErrors[field]?.[0];
      if (message !== undefined) fieldErrors[field] = message;
    }
    return { status: 'error', fieldErrors, message: 'Corrige les champs signalés.' };
  }

  const input: AthleteProfileInput = parsed.data;

  let created: boolean;
  /** L'athlète qui vient de naître : c'est *son* dossier de dépôt qu'on reprend. */
  let athleteId: number | null = null;
  try {
    created = !(await hasAthlete());
    if (created) {
      await createAthlete(input);
      athleteId = await getCurrentAthleteId();
    } else {
      await updateAthleteProfile(input);
    }
  } catch (error) {
    return failure(error);
  }

  // Après la création seulement : rien n'attend une mise à jour de profil. Cette
  // fonction ne lève jamais — l'onboarding est déjà acquis.
  const recovery = athleteId === null ? null : await recoverPendingImports(athleteId);

  revalidatePath('/', 'layout');
  return { status: 'success', message: successMessage(created, recovery) };
}

/**
 * Traduit une erreur du DAL en état de formulaire. Aucune trace d'exécution ne
 * franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 */
function failure(error: unknown): ProfileFormState {
  if (error instanceof InvalidAthleteProfileError) {
    const fieldErrors: NonNullable<ProfileFormState['fieldErrors']> = {};
    fieldErrors[error.field] = error.message;
    return { status: 'error', fieldErrors, message: 'Corrige les champs signalés.' };
  }
  if (error instanceof AthleteAlreadyExistsError) {
    return { status: 'error', message: 'Un profil existe déjà — recharge la page pour le modifier.' };
  }
  if (error instanceof AthleteNotFoundError) {
    return { status: 'error', message: 'Aucun profil à modifier — recharge la page.' };
  }

  console.error('[profile] enregistrement impossible :', error);
  return { status: 'error', message: "Enregistrement impossible pour l'instant. Réessaie." };
}
