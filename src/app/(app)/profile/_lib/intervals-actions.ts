'use server';

/**
 * Server Action du bloc « Import automatique » du profil : identifiant
 * intervals.icu et clé API, modifiables à tout moment.
 *
 * Mince par construction : valider (`parseIntervalsFields`) → déléguer au DAL →
 * revalider. Les bornes, le chiffrement et l'écriture vivent dans
 * `src/data/athlete.ts`, qui les re-vérifie quel que soit l'appelant.
 *
 * Cette action est un endpoint public appelable par POST direct. Elle n'a aucun
 * identifiant de ressource à falsifier : `saveIntervalsSettings` n'écrit que sur
 * l'athlète de la session, et refuse s'il n'y en a pas.
 *
 * **Ce qu'elle renvoie est sérialisé vers le client** : un statut, des erreurs
 * par champ, un message. Jamais la clé, ni un fragment, ni une trace
 * d'exécution.
 */

import { revalidatePath } from 'next/cache';

import {
  AthleteNotFoundError,
  InvalidIntervalsSettingsError,
  saveIntervalsSettings,
} from '@/data/athlete';
import { SecretKeyUnavailableError } from '@/lib/crypto/secret-box';

import { apiKeyOutcome, parseIntervalsFields, type ApiKeyOutcome } from './intervals-input';
import type { IntervalsFormState } from './intervals-state';

const SUCCESS_MESSAGES: Record<ApiKeyOutcome, string> = {
  kept: 'Réglages intervals.icu enregistrés.',
  replaced: 'Clé API enregistrée. Le rapatriement automatique repart au prochain cycle.',
  cleared: "Clé API effacée. L'import automatique est arrêté.",
};

/**
 * Enregistre les identifiants intervals.icu de l'athlète connecté.
 *
 * Compatible `useActionState` : `(état précédent, formData) => nouvel état`.
 */
export async function saveIntervalsAction(
  _previous: IntervalsFormState,
  formData: FormData,
): Promise<IntervalsFormState> {
  const parsed = parseIntervalsFields(formData);
  if (!parsed.ok) {
    return {
      status: 'error',
      fieldErrors: parsed.fieldErrors,
      message: 'Corrige les champs signalés.',
    };
  }

  try {
    await saveIntervalsSettings(parsed.value);
  } catch (error) {
    return failure(error);
  }

  revalidatePath('/', 'layout');
  return { status: 'success', message: SUCCESS_MESSAGES[apiKeyOutcome(parsed.value)] };
}

/**
 * Traduit une erreur du DAL en état de formulaire. Aucune trace d'exécution ne
 * franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 */
function failure(error: unknown): IntervalsFormState {
  if (error instanceof InvalidIntervalsSettingsError) {
    const fieldErrors: NonNullable<IntervalsFormState['fieldErrors']> = {};
    fieldErrors[error.field] = error.message;
    return { status: 'error', fieldErrors, message: 'Corrige les champs signalés.' };
  }
  if (error instanceof AthleteNotFoundError) {
    return {
      status: 'error',
      message: "Aucun profil enregistré : crée-le d'abord, puis reviens ici.",
    };
  }
  if (error instanceof SecretKeyUnavailableError) {
    // La clé n'a **pas** été enregistrée — jamais en clair faute de secret.
    // C'est un défaut de configuration du serveur, et le dire est la seule
    // façon qu'il soit corrigé.
    return {
      status: 'error',
      message:
        "La clé n'a pas été enregistrée : cette installation n'a pas de secret de chiffrement valide (BETTER_AUTH_SECRET). Rien n'a été stocké en clair.",
    };
  }

  console.error('[profile] enregistrement des réglages intervals.icu impossible :', error);
  return { status: 'error', message: "Enregistrement impossible pour l'instant. Réessaie." };
}
