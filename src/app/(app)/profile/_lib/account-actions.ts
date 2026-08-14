'use server';

/**
 * Server Actions de la section « Ton compte » : nom d'affichage, mot de passe,
 * déconnexion.
 *
 * Minces par construction : valider (Zod) → déléguer aux API **serveur** de
 * better-auth → rendre un état affichable. Aucune écriture directe en base ici :
 * `auth.api.*` seul sait hacher un mot de passe, révoquer une session et
 * réémettre le cookie.
 *
 * Chacune de ces actions est un endpoint public appelable par POST direct. Ce
 * n'est pas grave : les trois exigent une session (better-auth la vérifie
 * lui-même, `sessionMiddleware` pour `updateUser`, `sensitiveSessionMiddleware`
 * pour `changePassword`) et n'agissent que sur le compte de cette session — il
 * n'y a aucun identifiant de ressource à falsifier.
 *
 * **L'e-mail n'est pas modifiable ici, et ce n'est pas un oubli** : c'est
 * l'identifiant de connexion. Le changer proprement demande de vérifier la
 * nouvelle adresse avant de basculer (sinon une faute de frappe enferme dehors)
 * et d'en garantir l'unicité. better-auth sait le faire (`changeEmail`, avec
 * `sendChangeEmailVerification`), mais aucun envoi d'e-mail n'est configuré sur
 * cette installation. Tant que ce n'est pas le cas, l'adresse ne bouge pas.
 *
 * Ce que ces actions renvoient est sérialisé vers le client : un statut, des
 * erreurs par champ, un message. Jamais de hachage, jamais de jeton, jamais
 * d'objet session — les valeurs de retour de better-auth sont donc ignorées.
 */

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { isAPIError } from 'better-auth/api';
import { z } from 'zod';

import {
  AUTH_NAME_MAX_LENGTH,
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  authUnavailableMessage,
  getAuth,
} from '@/lib/auth';

import type { AccountField, AccountFormState } from './account-state';

/** Le refus opposé quand la session a disparu entre l'affichage et l'envoi. */
const SESSION_LOST_MESSAGE =
  'Ta session a expiré. Reconnecte-toi, puis recommence.';

const NAME_FAILED_MESSAGE = "Le nom n'a pas pu être mis à jour. Réessaie.";
const PASSWORD_FAILED_MESSAGE =
  "Le mot de passe n'a pas pu être changé. Réessaie.";
const SIGN_OUT_FAILED_MESSAGE =
  "La déconnexion a échoué : tu es toujours connectée. Réessaie.";

/**
 * Le message des deux saisies qui doivent coïncider. Il se pose sur la
 * confirmation, jamais sur le mot de passe : c'est la seconde frappe qu'on
 * corrige, et signaler la première laisserait croire qu'elle est mauvaise.
 */
const PASSWORD_MISMATCH_MESSAGE =
  'Les deux saisies diffèrent — retape le nouveau mot de passe.';

/** Un `FormData` ne porte que des chaînes ou des fichiers ; un fichier n'est pas une valeur. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Renseigne un nom.')
    .max(AUTH_NAME_MAX_LENGTH, `Nom trop long (${AUTH_NAME_MAX_LENGTH} caractères max).`),
});

/**
 * Le mot de passe actuel est **exigé**, et c'est le point du dispositif : sans
 * lui, une session ouverte trouvée sur un téléphone déverrouillé suffirait à
 * s'approprier le compte. Sa longueur n'est pas contrôlée au-delà de sa
 * présence — c'est une valeur d'avant, pas une valeur qu'on choisit.
 */
const passwordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'Renseigne ton mot de passe actuel.')
      .max(AUTH_PASSWORD_MAX_LENGTH),
    newPassword: z
      .string()
      .min(
        AUTH_PASSWORD_MIN_LENGTH,
        `Mot de passe : ${AUTH_PASSWORD_MIN_LENGTH} caractères minimum.`,
      )
      .max(
        AUTH_PASSWORD_MAX_LENGTH,
        `Mot de passe : ${AUTH_PASSWORD_MAX_LENGTH} caractères maximum.`,
      ),
    newPasswordConfirm: z.string().max(AUTH_PASSWORD_MAX_LENGTH),
  })
  .superRefine((values, ctx) => {
    if (values.newPasswordConfirm !== values.newPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['newPasswordConfirm'],
        message: PASSWORD_MISMATCH_MESSAGE,
      });
    }
  });

/**
 * Convertit un échec Zod en erreurs par champ — le premier message de chaque
 * champ, les suivants n'apprendraient rien. `fields` dit lesquels l'écran
 * affiche, et rien d'autre ne franchit la frontière.
 */
function fieldErrorsOf(
  error: z.ZodError,
  fields: readonly AccountField[],
): AccountFormState {
  const fieldErrors: NonNullable<AccountFormState['fieldErrors']> = {};
  for (const issue of error.issues) {
    const field = fields.find((candidate) => candidate === issue.path[0]);
    if (field !== undefined && fieldErrors[field] === undefined) {
      fieldErrors[field] = issue.message;
    }
  }
  return { status: 'error', fieldErrors, message: 'Corrige les champs signalés.' };
}

/** `true` quand better-auth a refusé faute de session valide. */
function isUnauthorized(error: unknown): boolean {
  return isAPIError(error) && error.status === 'UNAUTHORIZED';
}

/**
 * Change le nom d'affichage du compte.
 *
 * C'est le nom de l'identité de connexion, distinct du prénom du profil
 * athlète : celui-ci décrit la coureuse et sert aux calculs, celui-là désigne le
 * compte. Les deux se règlent sur la même page, chacun dans sa section.
 */
export async function updateAccountNameAction(
  _previous: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const parsed = nameSchema.safeParse({ name: textField(formData, 'name') });
  if (!parsed.success) return fieldErrorsOf(parsed.error, ['name']);

  const auth = getAuth();
  if (auth === null) {
    return { status: 'error', message: authUnavailableMessage() ?? NAME_FAILED_MESSAGE };
  }

  try {
    // `headers` : c'est le cookie de la requête qui désigne le compte à
    // modifier. Rien dans le corps ne dit *qui* — impossible d'en viser un
    // autre.
    await auth.api.updateUser({
      body: { name: parsed.data.name },
      headers: await headers(),
    });
  } catch (error) {
    if (isUnauthorized(error)) {
      return { status: 'error', message: SESSION_LOST_MESSAGE };
    }
    console.error('[auth] mise à jour du nom impossible', error);
    return { status: 'error', message: NAME_FAILED_MESSAGE };
  }

  revalidatePath('/', 'layout');
  return { status: 'success', message: 'Nom mis à jour.' };
}

/**
 * Change le mot de passe, contre présentation de l'actuel.
 *
 * **`revokeOtherSessions: true`, délibérément.** Un mot de passe qu'on change
 * est un mot de passe qu'on soupçonne : laisser vivre les sessions ouvertes
 * ailleurs viderait l'opération de son sens, puisqu'une session volée survit à
 * la rotation du secret qui l'a créée. better-auth supprime alors *toutes* les
 * sessions du compte, en recrée une pour la requête en cours et en dépose le
 * cookie — l'appareil d'où part le changement reste donc connecté, et lui seul.
 * Les autres appareils de l'utilisatrice se reconnecteront avec le mot de passe
 * qu'elle vient de choisir ; c'est le prix, et il est faible face à l'inverse,
 * qui ne ferme rien.
 */
export async function changeAccountPasswordAction(
  _previous: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const parsed = passwordSchema.safeParse({
    currentPassword: textField(formData, 'currentPassword'),
    newPassword: textField(formData, 'newPassword'),
    newPasswordConfirm: textField(formData, 'newPasswordConfirm'),
  });
  if (!parsed.success) {
    return fieldErrorsOf(parsed.error, [
      'currentPassword',
      'newPassword',
      'newPasswordConfirm',
    ]);
  }

  const auth = getAuth();
  if (auth === null) {
    return { status: 'error', message: authUnavailableMessage() ?? PASSWORD_FAILED_MESSAGE };
  }

  try {
    // La réponse porte un jeton de session et l'utilisateur : rien n'en est lu,
    // et rien n'en sort d'ici.
    await auth.api.changePassword({
      body: {
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        revokeOtherSessions: true,
      },
      headers: await headers(),
    });
  } catch (error) {
    return passwordFailure(error);
  }

  revalidatePath('/', 'layout');
  return {
    status: 'success',
    message:
      'Mot de passe changé. Tes autres appareils devront se reconnecter ; celui-ci reste connecté.',
  };
}

/**
 * Traduit un refus de changement de mot de passe.
 *
 * Un seul cas mérite un message par champ : le mot de passe actuel faux, qui se
 * corrige. Le dire n'apprend rien à personne — il faut déjà une session valide
 * pour arriver jusque-là.
 */
function passwordFailure(error: unknown): AccountFormState {
  if (isAPIError(error) && error.body?.code === 'INVALID_PASSWORD') {
    return {
      status: 'error',
      fieldErrors: { currentPassword: 'Mot de passe actuel incorrect.' },
      message: 'Corrige les champs signalés.',
    };
  }
  if (isUnauthorized(error)) {
    return { status: 'error', message: SESSION_LOST_MESSAGE };
  }
  console.error('[auth] changement de mot de passe impossible', error);
  return { status: 'error', message: PASSWORD_FAILED_MESSAGE };
}

/**
 * Déconnexion.
 *
 * `auth.api.signOut` supprime la ligne de session **et** fait expirer les
 * cookies ; c'est le greffon `nextCookies` — dernier de la chaîne, cf.
 * `src/lib/auth/index.ts` — qui recopie ces `Set-Cookie` dans le magasin de
 * Next depuis une Server Action. Sans lui, la session serait détruite en base
 * mais le navigateur garderait son jeton : l'utilisatrice se croirait sortie.
 *
 * La redirection est **hors** du `try` : Next l'implémente en levant une
 * exception de contrôle, qu'un `catch` avalerait — et l'échec annoncé serait
 * alors celui d'une déconnexion qui a réussi.
 *
 * Sans paramètre, alors qu'elle est branchée sur `useActionState` : ni l'état
 * précédent ni le `FormData` ne disent quoi que ce soit ici — c'est le cookie
 * de la requête qui désigne la session à fermer. React les passe quand même,
 * JavaScript les ignore.
 */
export async function signOutAction(): Promise<AccountFormState> {
  const auth = getAuth();
  if (auth === null) {
    return { status: 'error', message: authUnavailableMessage() ?? SIGN_OUT_FAILED_MESSAGE };
  }

  try {
    await auth.api.signOut({ headers: await headers() });
  } catch (error) {
    // Jamais avalé : une déconnexion qu'on croit faite est pire que pas de
    // bouton du tout.
    console.error('[auth] déconnexion impossible', error);
    return { status: 'error', message: SIGN_OUT_FAILED_MESSAGE };
  }

  revalidatePath('/', 'layout');
  redirect('/login');
}
