'use server';

/**
 * Server Action du bloc « Facteur correctif de la VO₂max » : imposer un facteur,
 * ou rendre la main au calcul automatique.
 *
 * Mince par construction : vérifier la session → valider (Zod) → déléguer au DAL
 * → revalider. Le DAL revérifie les bornes de son côté (défense en profondeur).
 *
 * C'est un endpoint public appelable par POST direct. Aucun identifiant de
 * ressource à falsifier : le DAL n'écrit que sur l'athlète de la session, et
 * refuse s'il n'y en a pas.
 *
 * **Ce qu'elle renvoie est sérialisé vers le client** : un statut et un message.
 * Jamais une trace d'exécution.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { AthleteNotFoundError } from '@/data/athlete';
import { getSession } from '@/data/session';
import {
  InvalidCorrectionFactorError,
  VO2MAX_CORRECTION_FACTOR_BOUNDS,
  saveManualCorrectionFactor,
} from '@/data/vo2max-correction';
import { SESSION_REQUIRED_MESSAGE } from '@/lib/auth/messages';

import type { CorrectionFactorFormState } from './correction-factor-state';

/** Un `FormData` ne porte que des chaînes ou des fichiers ; un fichier n'est pas une valeur. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Le facteur saisi, ou `null` pour « automatique ».
 *
 * **Un champ vide est un ordre, pas une valeur manquante** : c'est ainsi que
 * Runalyze exprime le mode automatique, et c'est la seule façon de sortir d'un
 * facteur imposé. D'où le `null` explicite plutôt qu'une erreur de validation —
 * et d'où le refus de `z.coerce.number()`, qui aurait transformé ce vide en
 * zéro, c'est-à-dire en un facteur qui annulerait toutes les VO₂max.
 *
 * **La virgule est acceptée** : un clavier français en produit une.
 */
const schema = z.object({
  factor: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Number(value.replace(',', '.'))))
    .refine(
      (value) =>
        value === null ||
        (Number.isFinite(value) &&
          value >= VO2MAX_CORRECTION_FACTOR_BOUNDS.min &&
          value <= VO2MAX_CORRECTION_FACTOR_BOUNDS.max),
      `Facteur attendu entre ${VO2MAX_CORRECTION_FACTOR_BOUNDS.min} et ${VO2MAX_CORRECTION_FACTOR_BOUNDS.max}, ou vide pour le calcul automatique.`,
    ),
});

const SAVED_MESSAGE =
  'Facteur enregistré. Toutes tes VO₂max sont relues avec — rien n’est à rattraper.';
const CLEARED_MESSAGE =
  'Calcul automatique rétabli : le facteur redevient celui de tes courses déclarées.';
const GENERIC_FAILURE = "Le facteur n'a pas été enregistré.";

/** Enregistre le facteur manuel, ou le retire. Compatible `useActionState`. */
export async function saveCorrectionFactorAction(
  _previous: CorrectionFactorFormState,
  formData: FormData,
): Promise<CorrectionFactorFormState> {
  // Dans le corps de l'action, avant toute validation : ni le proxy ni la page
  // ne la protègent, elle s'appelle en POST direct.
  if ((await getSession()) === null) {
    return { status: 'error', message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = schema.safeParse({ factor: textField(formData, 'factor') });
  if (!parsed.success) {
    return {
      status: 'error',
      message: z.flattenError(parsed.error).fieldErrors.factor?.[0] ?? GENERIC_FAILURE,
    };
  }

  try {
    await saveManualCorrectionFactor(parsed.data.factor);
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/', 'layout');
  return {
    status: 'success',
    message: parsed.data.factor === null ? CLEARED_MESSAGE : SAVED_MESSAGE,
  };
}

/**
 * Traduit une erreur du DAL en état de formulaire. Aucune trace d'exécution ne
 * franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 */
function failure(error: unknown): CorrectionFactorFormState {
  if (error instanceof InvalidCorrectionFactorError) {
    return { status: 'error', message: error.message };
  }
  if (error instanceof AthleteNotFoundError) {
    return {
      status: 'error',
      message: "Aucun profil enregistré : crée-le d'abord, puis reviens ici.",
    };
  }

  console.error('[profile] enregistrement du facteur correctif impossible :', error);
  return { status: 'error', message: `${GENERIC_FAILURE} Réessaie.` };
}
