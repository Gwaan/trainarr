'use server';

/**
 * Server Actions des écrans d'identité.
 *
 * Minces par construction : valider (Zod) → déléguer à better-auth → rediriger.
 * Aucune règle d'accès ici — l'ouverture de l'inscription est décidée dans
 * `src/lib/auth/`, au plus près de l'écriture, parce qu'une Server Action
 * exportée est un endpoint public appelable sans passer par le formulaire.
 *
 * Ce que ces actions renvoient est sérialisé vers le client : un statut, des
 * erreurs par champ, un message. Jamais un utilisateur, jamais une session,
 * jamais une trace d'exécution.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { isAPIError } from 'better-auth/api';
import { z } from 'zod';

import {
  AUTH_NAME_MAX_LENGTH,
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  SIGN_UP_CLOSED_CODE,
  SIGN_UP_CLOSED_MESSAGE,
  authUnavailableMessage,
  getAuth,
} from '@/lib/auth';
import { invitationTokenSchema } from '@/lib/auth/invitation-token';
import {
  INVITATION_UNUSABLE_MESSAGE,
  InvitationUnusableError,
  consumeInvitation,
} from '@/data/invitations';

import type { AuthField, AuthFormState } from './form-state';


/**
 * Message d'échec de connexion — **volontairement identique** que l'e-mail soit
 * inconnu, le mot de passe faux, ou le compte inexistant. Distinguer les cas
 * dirait à un inconnu quels comptes existent sur cette installation.
 */
const SIGN_IN_FAILED_MESSAGE = 'E-mail ou mot de passe incorrect.';

/** Repli quand la création échoue sans raison exploitable côté client. */
const SIGN_UP_FAILED_MESSAGE = "Le compte n'a pas pu être créé. Réessaie.";

/** Un `FormData` ne porte que des chaînes ou des fichiers ; un fichier n'est pas une valeur. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * À la connexion, le format de l'e-mail n'est pas validé : seule sa présence
 * l'est. Un « ce n'est pas un e-mail » n'aiderait personne et donnerait un
 * retour plus fin que le refus générique qui suit.
 */
const signInSchema = z.object({
  email: z.string().trim().min(1, 'Renseigne ton e-mail.').max(254),
  password: z.string().min(1, 'Renseigne ton mot de passe.').max(AUTH_PASSWORD_MAX_LENGTH),
});

/**
 * Le message des deux saisies qui doivent coïncider. Il se pose sur la
 * confirmation, jamais sur le mot de passe : c'est la seconde frappe qu'on
 * corrige, et signaler la première laisserait croire qu'elle est mauvaise.
 */
const PASSWORD_MISMATCH_MESSAGE =
  'Les deux saisies diffèrent — retape ton mot de passe.';

/**
 * À la création, au contraire, tout est dit : c'est le seul moment où ces
 * valeurs se choisissent, et une erreur de frappe y enferme dehors.
 *
 * D'où la confirmation, **vérifiée ici** : le formulaire peut la contrôler pour
 * aider, il ne fait pas autorité — cette action est appelable sans lui. Sans ce
 * second passage, une frappe de travers donne un compte dont le mot de passe
 * n'est connu de personne, sans récupération par e-mail pour le rattraper.
 */
const newAccountFields = {
  name: z
    .string()
    .trim()
    .min(1, 'Renseigne un nom.')
    .max(AUTH_NAME_MAX_LENGTH, `Nom trop long (${AUTH_NAME_MAX_LENGTH} caractères max).`),
  email: z.email({ error: 'Adresse e-mail invalide.' }).max(254, 'Adresse e-mail trop longue.'),
  password: z
    .string()
    .min(AUTH_PASSWORD_MIN_LENGTH, `Mot de passe : ${AUTH_PASSWORD_MIN_LENGTH} caractères minimum.`)
    .max(AUTH_PASSWORD_MAX_LENGTH, `Mot de passe : ${AUTH_PASSWORD_MAX_LENGTH} caractères maximum.`),
  passwordConfirm: z.string().max(AUTH_PASSWORD_MAX_LENGTH),
} as const;

/** Les deux saisies doivent coïncider — même contrôle des deux côtés. */
function checkPasswordConfirm(
  values: { password: string; passwordConfirm: string },
  ctx: z.RefinementCtx,
): void {
  if (values.passwordConfirm !== values.password) {
    ctx.addIssue({
      code: 'custom',
      path: ['passwordConfirm'],
      message: PASSWORD_MISMATCH_MESSAGE,
    });
  }
}

const firstAccountSchema = z.object(newAccountFields).superRefine(checkPasswordConfirm);

/**
 * Mêmes champs, plus le jeton du lien — qui vient d'un champ caché, donc du
 * client, donc validé comme tout le reste. Sa forme seule est contrôlée ici ;
 * c'est la base qui dira s'il ouvre quelque chose.
 */
const invitedAccountSchema = z
  .object({ ...newAccountFields, token: invitationTokenSchema })
  .superRefine(checkPasswordConfirm);

/**
 * Convertit un échec Zod en erreurs par champ — le premier message de chaque
 * champ, les suivants n'apprendraient rien.
 *
 * Le parcours passe par `issues` plutôt que par `flattenError` parce que ce
 * même helper sert deux schémas de formes différentes : `fields` dit lesquels
 * l'écran affiche, et rien d'autre ne franchit la frontière.
 */
function fieldErrorsOf(error: z.ZodError, fields: readonly AuthField[]): AuthFormState {
  const fieldErrors: NonNullable<AuthFormState['fieldErrors']> = {};
  for (const issue of error.issues) {
    const field = fields.find((candidate) => candidate === issue.path[0]);
    if (field !== undefined && fieldErrors[field] === undefined) {
      fieldErrors[field] = issue.message;
    }
  }
  return { status: 'error', fieldErrors, message: 'Corrige les champs signalés.' };
}

/**
 * Connexion par e-mail et mot de passe.
 *
 * La session est ouverte par better-auth, dont le greffon `nextCookies` dépose
 * le cookie depuis cette action. La redirection est **hors** du `try` : Next
 * l'implémente en levant une exception de contrôle, qu'un `catch` avalerait.
 */
export async function signInAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse({
    email: textField(formData, 'email'),
    password: textField(formData, 'password'),
  });
  if (!parsed.success) return fieldErrorsOf(parsed.error, ['email', 'password']);

  const auth = getAuth();
  if (auth === null) {
    return { status: 'error', message: authUnavailableMessage() ?? SIGN_IN_FAILED_MESSAGE };
  }

  try {
    await auth.api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password },
      headers: await headers(),
    });
  } catch (error) {
    // Identifiants refusés : c'est le fonctionnement normal, rien à journaliser.
    // Toute autre panne (base injoignable) l'est, sans sortir d'ici.
    if (!isAPIError(error)) {
      console.error('[auth] échec inattendu de la connexion', error);
    }
    return { status: 'error', message: SIGN_IN_FAILED_MESSAGE };
  }

  redirect('/');
}

/**
 * Création du tout premier compte.
 *
 * L'action ne vérifie pas elle-même que la porte est ouverte : c'est le crochet
 * de `src/lib/auth/` qui refuse, et la base qui tranche en cas d'égalité. Un
 * contrôle de plus ici ne fermerait rien de mieux et donnerait l'illusion que
 * la règle vit à deux endroits.
 */
export async function createFirstAccountAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = firstAccountSchema.safeParse({
    name: textField(formData, 'name'),
    email: textField(formData, 'email'),
    password: textField(formData, 'password'),
    passwordConfirm: textField(formData, 'passwordConfirm'),
  });
  if (!parsed.success) {
    return fieldErrorsOf(parsed.error, ['name', 'email', 'password', 'passwordConfirm']);
  }

  const auth = getAuth();
  if (auth === null) {
    return { status: 'error', message: authUnavailableMessage() ?? SIGN_UP_FAILED_MESSAGE };
  }

  try {
    await auth.api.signUpEmail({
      body: {
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
      },
      headers: await headers(),
    });
  } catch (error) {
    return signUpFailure(error);
  }

  // `autoSignIn` : le compte créé est déjà connecté, inutile de repasser par
  // l'écran de connexion.
  redirect('/');
}

/**
 * Traduit un échec de création en état de formulaire.
 *
 * Un seul cas mérite son propre message : la porte refermée entre l'affichage
 * de l'écran et l'envoi — c'est notre refus, avec notre texte. Tout le reste
 * (course perdue sur l'index unique, e-mail déjà pris, panne) reste générique.
 */
function signUpFailure(error: unknown): AuthFormState {
  if (isAPIError(error) && error.body?.code === SIGN_UP_CLOSED_CODE) {
    return { status: 'error', message: SIGN_UP_CLOSED_MESSAGE };
  }
  console.error('[auth] échec de la création du premier compte', error);
  return { status: 'error', message: SIGN_UP_FAILED_MESSAGE };
}

/**
 * Création d'un compte sur invitation.
 *
 * C'est la **seule** porte ouverte une fois le compte d'amorçage créé, et elle
 * n'ouvre rien par elle-même : tout se joue dans `consumeInvitation`, qui
 * dépense le jeton en base *puis* appelle la création dans la foulée. Un POST
 * direct sur `/api/auth/sign-up/email`, lui, n'a aucun jeton à dépenser et reste
 * refusé — cette action n'a pas de drapeau global à basculer.
 *
 * Le jeton n'apparaît dans aucune valeur de retour, dans aucun message, et
 * n'est jamais journalisé : les traces d'ici ne portent que l'erreur.
 */
export async function createInvitedAccountAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = invitedAccountSchema.safeParse({
    name: textField(formData, 'name'),
    email: textField(formData, 'email'),
    password: textField(formData, 'password'),
    passwordConfirm: textField(formData, 'passwordConfirm'),
    token: textField(formData, 'token'),
  });
  if (!parsed.success) {
    // Le jeton n'est pas un champ affiché : une forme invalide n'est pas une
    // faute de saisie, c'est un lien qui n'ouvre rien — même message que le
    // reste, aucune distinction.
    if (parsed.error.issues.some((issue) => issue.path[0] === 'token')) {
      return { status: 'error', message: INVITATION_UNUSABLE_MESSAGE };
    }
    return fieldErrorsOf(parsed.error, ['name', 'email', 'password', 'passwordConfirm']);
  }

  const auth = getAuth();
  if (auth === null) {
    return { status: 'error', message: authUnavailableMessage() ?? SIGN_UP_FAILED_MESSAGE };
  }

  const { name, email, password, token } = parsed.data;
  try {
    await consumeInvitation(token, async () => {
      const created = await auth.api.signUpEmail({
        body: { name, email, password },
        headers: await headers(),
      });
      return { userId: created.user.id };
    });
  } catch (error) {
    return invitedSignUpFailure(error);
  }

  // `autoSignIn` : le compte créé est déjà connecté.
  redirect('/');
}

/**
 * Code d'erreur de better-auth pour une adresse déjà prise
 * (`BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`). Recopié plutôt
 * qu'importé : il vit dans `@better-auth/core`, une dépendance transitive dont
 * rien d'autre du projet ne dépend directement.
 */
const USER_ALREADY_EXISTS_CODE = 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL';

/**
 * Traduit un échec de création sur invitation.
 *
 * Deux cas nommés, et rien de plus :
 *
 * - le lien n'ouvre rien — un seul message pour « inconnu », « expiré »,
 *   « révoqué » et « déjà utilisé » ;
 * - l'adresse est déjà prise — le dire est sans risque (il faut déjà détenir un
 *   lien valide pour arriver ici) et c'est la seule façon de sortir de
 *   l'impasse : l'invitation n'a pas été dépensée, une autre adresse passera.
 */
function invitedSignUpFailure(error: unknown): AuthFormState {
  if (error instanceof InvitationUnusableError) {
    return { status: 'error', message: INVITATION_UNUSABLE_MESSAGE };
  }
  if (isAPIError(error) && error.body?.code === USER_ALREADY_EXISTS_CODE) {
    return {
      status: 'error',
      fieldErrors: { email: 'Un compte utilise déjà cette adresse.' },
      message: 'Corrige les champs signalés.',
    };
  }
  console.error("[auth] échec de la création d'un compte sur invitation", error);
  return { status: 'error', message: SIGN_UP_FAILED_MESSAGE };
}
