'use server';

/**
 * Server Action du bloc « Correction d'altitude » : enregistrer les trois
 * réglages qui décident si — et de combien — le dénivelé corrige la distance
 * dans l'estimation de VO₂max.
 *
 * Mince par construction : vérifier la session → valider (Zod) → déléguer au DAL
 * → revalider. Aucune écriture n'est faite avant que les trois valeurs ne soient
 * jugées bonnes, et le DAL les revérifie de son côté (défense en profondeur).
 *
 * C'est un endpoint public appelable par POST direct. Aucun identifiant de
 * ressource à falsifier : le DAL n'écrit que sur l'athlète de la session, et
 * refuse s'il n'y en a pas.
 *
 * **Ce qu'elle renvoie est sérialisé vers le client** : un statut, un message,
 * des erreurs par champ. Jamais une trace d'exécution.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { AthleteNotFoundError } from '@/data/athlete';
import {
  InvalidElevationCorrectionError,
  saveElevationCorrection,
} from '@/data/elevation-correction';
import { getSession } from '@/data/session';
import { SESSION_REQUIRED_MESSAGE } from '@/lib/auth/messages';
import { ASCENT_COEF_BOUNDS, DESCENT_COEF_BOUNDS } from '@/lib/metrics';

import {
  ELEVATION_CORRECTION_ENABLED_FIELD,
  type ElevationCorrectionFormState,
} from './elevation-correction-state';

/** Un `FormData` ne porte que des chaînes ou des fichiers ; un fichier n'est pas une valeur. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Un coefficient tel qu'il revient du navigateur.
 *
 * Une chaîne convertie puis vérifiée, et non `z.coerce.number()` : celui-ci
 * transforme une valeur absente en zéro, c'est-à-dire en « ne rien corriger »,
 * un réglage parfaitement valide qu'on aurait enregistré à la place d'un champ
 * vidé par accident.
 *
 * **La virgule est acceptée** : un clavier français en produit une, et refuser
 * « 2,5 » pour cause de séparateur serait une brimade — pas une validation.
 */
const coefficient = (label: string, bounds: { min: number; max: number }) =>
  z
    .string()
    .trim()
    .min(1, `${label} : valeur manquante.`)
    .transform((value) => Number(value.replace(',', '.')))
    .refine(
      (value) => Number.isFinite(value) && value >= bounds.min && value <= bounds.max,
      `${label} : nombre attendu entre ${bounds.min} et ${bounds.max}.`,
    );

const schema = z.object({
  ascentCoefM: coefficient('Mètres ajoutés par mètre monté', ASCENT_COEF_BOUNDS),
  descentCoefM: coefficient('Mètres ajoutés par mètre descendu', DESCENT_COEF_BOUNDS),
});

const SAVED_MESSAGE =
  'Réglage enregistré. Les VO₂max sont relues avec, sur toutes tes séances — rien n’est à rattraper.';
const GENERIC_FAILURE = "Le réglage n'a pas été enregistré.";

/** Enregistre les trois réglages. Compatible `useActionState`. */
export async function saveElevationCorrectionAction(
  _previous: ElevationCorrectionFormState,
  formData: FormData,
): Promise<ElevationCorrectionFormState> {
  // Dans le corps de l'action, avant toute validation : ni le proxy ni la page
  // ne la protègent, elle s'appelle en POST direct. Le refus est le même pour
  // une entrée valide et pour une entrée absurde.
  if ((await getSession()) === null) {
    return { status: 'error', message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = schema.safeParse({
    ascentCoefM: textField(formData, 'ascentCoefM'),
    descentCoefM: textField(formData, 'descentCoefM'),
  });
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    return {
      status: 'error',
      message: 'Un des coefficients n’est pas exploitable.',
      fieldErrors: {
        ascentCoefM: fieldErrors.ascentCoefM?.[0],
        descentCoefM: fieldErrors.descentCoefM?.[0],
      },
    };
  }

  // Une case décochée n'apparaît pas dans le `FormData` : c'est sa présence qui
  // vaut « oui ».
  const enabled = formData.get(ELEVATION_CORRECTION_ENABLED_FIELD) !== null;

  try {
    await saveElevationCorrection({ enabled, ...parsed.data });
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/', 'layout');
  return { status: 'success', message: SAVED_MESSAGE };
}

/**
 * Traduit une erreur du DAL en état de formulaire. Aucune trace d'exécution ne
 * franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 */
function failure(error: unknown): ElevationCorrectionFormState {
  if (error instanceof InvalidElevationCorrectionError) {
    return {
      status: 'error',
      message: error.message,
      fieldErrors: { [error.field]: error.message },
    };
  }
  if (error instanceof AthleteNotFoundError) {
    return {
      status: 'error',
      message: "Aucun profil enregistré : crée-le d'abord, puis reviens ici.",
    };
  }

  console.error('[profile] enregistrement de la correction d’altitude impossible :', error);
  return { status: 'error', message: `${GENERIC_FAILURE} Réessaie.` };
}
