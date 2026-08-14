import 'server-only';

import { APIError } from 'better-auth/api';

import { hasAnyUser } from '@/data/users';

/**
 * La règle d'ouverture de l'inscription, isolée de l'instance better-auth pour
 * être éprouvable seule : c'est la seule chose qui sépare une installation
 * neuve d'une installation ouverte à tous les vents.
 */

/** Refus opposé à toute inscription une fois le premier compte créé. */
export const SIGN_UP_CLOSED_MESSAGE =
  "Les inscriptions sont fermées : un compte existe déjà sur cette installation.";

/** Code porté par le refus, pour que l'appelant le distingue d'une panne. */
export const SIGN_UP_CLOSED_CODE = 'SIGN_UP_CLOSED';

/**
 * Crochet `databaseHooks.user.create.before` de better-auth : il s'exécute juste
 * avant l'insertion d'un compte, quelle que soit la porte d'entrée (formulaire,
 * appel direct à `/api/auth/sign-up/email`).
 *
 * Il refuse dès qu'un compte existe, et marque celui qui passe comme compte
 * d'amorçage.
 *
 * **La lecture ne suffit pas à fermer la course.** Deux inscriptions simultanées
 * sur une base vide voient toutes les deux « aucun compte » : en
 * `READ COMMITTED`, aucune ne voit la ligne encore non validée de l'autre.
 * C'est le `true` posé ici qui tranche — l'index partiel unique
 * `auth_users_first_account_unique` n'accepte qu'une seule ligne portant cette
 * marque, la seconde insertion est rejetée par la base (`23505`) et son
 * inscription échoue. Le perdant reçoit une erreur, jamais un second compte.
 *
 * Rien n'est « consommé » au passage : une inscription qui échoue ne laisse
 * aucune ligne derrière elle, la porte reste donc ouverte. C'est ce qui écarte
 * le risque d'enfermer l'utilisatrice dehors sur une base neuve — un jeton
 * d'amorçage à usage unique, lui, aurait pu se perdre sur un échec.
 *
 * @throws {APIError} 403 tant qu'un compte existe.
 */
export async function guardSignUp(): Promise<{ data: { isFirstAccount: true } }> {
  if (await hasAnyUser()) {
    throw new APIError('FORBIDDEN', {
      message: SIGN_UP_CLOSED_MESSAGE,
      code: SIGN_UP_CLOSED_CODE,
    });
  }
  return { data: { isFirstAccount: true } };
}
