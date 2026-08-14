/**
 * Lecture et validation des deux champs intervals.icu d'un `FormData`.
 *
 * Partagé par les deux Server Actions qui les reçoivent : celle de l'onboarding
 * (`saveProfileAction`, où ils accompagnent la création du profil) et celle du
 * bloc « Import automatique » du profil (`saveIntervalsAction`). Une seule
 * grammaire, donc un seul jeu de messages.
 *
 * Module **pur**, hors `'use server'` : il est testable directement, et il ne
 * peut pas se retrouver exporté comme valeur depuis un fichier d'actions.
 *
 * **La clé ne sort d'ici que vers le DAL** : elle n'entre dans aucun message,
 * dans aucune trace, dans aucune valeur de retour d'action.
 */

import { z } from 'zod';

import { INTERVALS_SETTINGS_LIMITS, type IntervalsSettingsInput } from '@/data/athlete';

import { CLEAR_API_KEY_VALUE, type IntervalsField } from './intervals-state';

/**
 * Refuser les deux gestes à la fois plutôt que d'en choisir un : « effacer » et
 * « remplacer » sont des intentions opposées, en deviner une serait un pari sur
 * un secret.
 */
const CONFLICT_MESSAGE =
  'Choisis : effacer la clé enregistrée, ou en saisir une nouvelle — pas les deux.';

const intervalsSchema = z
  .object({
    intervalsAthleteId: z
      .string()
      .trim()
      .max(
        INTERVALS_SETTINGS_LIMITS.athleteIdMaxChars,
        `Identifiant intervals.icu : ${INTERVALS_SETTINGS_LIMITS.athleteIdMaxChars} caractères maximum.`,
      ),
    apiKey: z
      .string()
      .trim()
      .max(
        INTERVALS_SETTINGS_LIMITS.apiKeyMaxChars,
        // Le message borne, il ne cite évidemment pas la valeur reçue.
        `Clé API : ${INTERVALS_SETTINGS_LIMITS.apiKeyMaxChars} caractères maximum.`,
      ),
    clearApiKey: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.clearApiKey && values.apiKey !== '') {
      ctx.addIssue({ code: 'custom', path: ['apiKey'], message: CONFLICT_MESSAGE });
    }
  });

export type IntervalsFieldErrors = Partial<Record<IntervalsField, string>>;

export type IntervalsParseResult =
  | { ok: true; value: IntervalsSettingsInput }
  | { ok: false; fieldErrors: IntervalsFieldErrors };

/** Un `FormData` ne porte que des chaînes ou des fichiers ; un fichier n'est pas une valeur. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Traduit les champs du formulaire en entrée du DAL.
 *
 * Les trois intentions de `apiKey` sont portées par deux contrôles :
 * - case décochée, champ vide → `undefined` : la clé enregistrée ne bouge pas ;
 * - case cochée → `null` : elle est effacée ;
 * - champ rempli → la nouvelle valeur.
 *
 * Un champ de secret vide est donc « je n'y touche pas », jamais « efface » :
 * sans quoi chaque enregistrement du formulaire perdrait la clé.
 */
export function parseIntervalsFields(formData: FormData): IntervalsParseResult {
  const parsed = intervalsSchema.safeParse({
    intervalsAthleteId: textField(formData, 'intervalsAthleteId'),
    apiKey: textField(formData, 'apiKey'),
    clearApiKey: textField(formData, 'clearApiKey') === CLEAR_API_KEY_VALUE,
  });

  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    const fieldErrors: IntervalsFieldErrors = {};
    for (const field of ['intervalsAthleteId', 'apiKey'] as const) {
      const message = flat.fieldErrors[field]?.[0];
      if (message !== undefined) fieldErrors[field] = message;
    }
    return { ok: false, fieldErrors };
  }

  const { intervalsAthleteId, apiKey, clearApiKey } = parsed.data;

  const value: IntervalsSettingsInput = { intervalsAthleteId };
  if (clearApiKey) value.apiKey = null;
  else if (apiKey !== '') value.apiKey = apiKey;

  return { ok: true, value };
}

/** Ce que l'enregistrement a fait de la clé — le message de succès en dépend. */
export type ApiKeyOutcome = 'kept' | 'replaced' | 'cleared';

export function apiKeyOutcome(value: IntervalsSettingsInput): ApiKeyOutcome {
  if (value.apiKey === undefined) return 'kept';
  return value.apiKey === null ? 'cleared' : 'replaced';
}
