import 'server-only';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { withInvitationClaim } from '@/lib/auth/invitation-claim';
import {
  generateInvitationToken,
  invitationTokenFingerprint,
} from '@/lib/auth/invitation-token';

import { db } from './db/client';
import { authInvitations, authUsers } from './db/schema';
import { getSession } from './session';

/**
 * Les invitations : émission, liste, révocation, consommation.
 *
 * Une fois le compte d'amorçage créé, c'est la seule façon d'entrer dans
 * l'application — le crochet d'inscription refuse tout le reste
 * (`src/lib/auth/sign-up-guard.ts`).
 *
 * **Le jeton en clair n'existe qu'une fois**, à l'émission, dans la valeur de
 * retour de {@link createInvitation}. La base n'en garde que l'empreinte : il
 * n'est plus jamais relisible, par personne, y compris par celle qui l'a émis.
 * Aucune autre fonction de ce module ne rend ni jeton ni empreinte.
 */

/**
 * Durée de validité d'un lien : **48 heures**.
 *
 * Le lien part par message (SMS, messagerie), et le compromis se joue entre
 * deux échecs concrets :
 *
 * - trop court, il meurt avant d'être lu — un message envoyé le soir, ouvert le
 *   lendemain matin puis remis à « après le boulot », a déjà consommé plus de
 *   douze heures ;
 * - trop long, il traîne dans un fil de conversation, dans une sauvegarde de
 *   messagerie ou dans un historique de navigation, encore actif des semaines
 *   après avoir servi son propos.
 *
 * Deux jours couvrent le premier cas sans concéder le second : c'est le temps
 * qu'il faut pour que la personne invitée soit devant un vrai clavier au moins
 * une fois, week-end compris. Au-delà, ré-émettre un lien coûte deux clics —
 * c'est une opération d'administration, pas une urgence.
 */
export const INVITATION_LIFETIME_HOURS = 48;

/**
 * Le refus opposé à un lien inutilisable — **le même** qu'il soit inconnu, mal
 * formé, expiré, révoqué ou déjà consommé.
 *
 * Distinguer ces cas dirait à un inconnu qu'un lien a existé, et pour quand,
 * exactement comme un message de connexion qui distinguerait « e-mail inconnu »
 * de « mot de passe faux ».
 */
export const INVITATION_UNUSABLE_MESSAGE =
  "Ce lien de création de compte n'est pas valable. Demande-en un nouveau.";

/** Émission, liste ou révocation demandée par autre chose que le compte d'amorçage. */
export class InvitationAdminRequiredError extends Error {
  constructor() {
    super("Les invitations ne s'émettent que depuis le premier compte de l'installation.");
    this.name = 'InvitationAdminRequiredError';
  }
}

/** Le lien présenté n'ouvre rien (cf. {@link INVITATION_UNUSABLE_MESSAGE}). */
export class InvitationUnusableError extends Error {
  constructor() {
    super(INVITATION_UNUSABLE_MESSAGE);
    this.name = 'InvitationUnusableError';
  }
}

/**
 * Une invitation en cours, telle que l'écran d'administration la montre.
 *
 * Ni empreinte, ni jeton, ni identifiant de compte : une échéance et une poignée
 * pour révoquer, rien de plus. L'`id` franchit la frontière client parce qu'il
 * faut bien désigner la ligne à révoquer — ce n'est pas une capacité pour
 * autant, la révocation re-vérifie qui la demande et à qui appartient la ligne.
 */
export type InvitationDto = {
  id: number;
  expiresAt: Date;
};

/**
 * Ce que rend l'émission — **la seule et unique fois** où le jeton est lisible.
 */
export type IssuedInvitation = {
  token: string;
  expiresAt: Date;
};

/**
 * L'identifiant du compte d'amorçage s'il est celui de la session, `null`
 * sinon.
 *
 * `is_first_account` sert de marqueur d'administration plutôt qu'un rôle
 * inventé pour l'occasion : la colonne existe déjà, elle est posée par le
 * crochet d'inscription, et l'index partiel garantit qu'elle ne désigne jamais
 * qu'un seul compte. Un compte invité ne la porte pas.
 */
async function firstAccountUserId(): Promise<string | null> {
  const session = await getSession();
  if (session === null) return null;

  const rows = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(and(eq(authUsers.id, session.userId), eq(authUsers.isFirstAccount, true)))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Le compte connecté peut-il inviter ?
 *
 * Sert à l'affichage : la section d'administration est **absente** pour un
 * compte invité, pas grisée. Ce n'est pas elle qui protège quoi que ce soit —
 * chaque écriture re-vérifie de son côté.
 */
export async function canInvite(): Promise<boolean> {
  return (await firstAccountUserId()) !== null;
}

/** @throws {InvitationAdminRequiredError} si l'appelant n'est pas le compte d'amorçage. */
async function requireFirstAccountUserId(): Promise<string> {
  const userId = await firstAccountUserId();
  if (userId === null) throw new InvitationAdminRequiredError();
  return userId;
}

/**
 * Émet une invitation et rend son jeton en clair — pour la dernière fois.
 *
 * L'échéance est calculée **par la base** (`now() + interval`) et relue de la
 * ligne insérée : l'expiration est vérifiée avec la même horloge à la
 * consommation, et deux containers dont les horloges dérivent ne peuvent pas se
 * contredire.
 *
 * @throws {InvitationAdminRequiredError} si l'appelant n'est pas le compte d'amorçage.
 */
export async function createInvitation(): Promise<IssuedInvitation> {
  const userId = await requireFirstAccountUserId();
  const token = generateInvitationToken();

  const rows = await db
    .insert(authInvitations)
    .values({
      tokenHash: invitationTokenFingerprint(token),
      createdByUserId: userId,
      expiresAt: sql`now() + make_interval(hours => ${INVITATION_LIFETIME_HOURS})`,
    })
    .returning({ expiresAt: authInvitations.expiresAt });

  const expiresAt = rows[0]?.expiresAt;
  if (expiresAt === undefined) {
    throw new Error("L'invitation n'a pas été enregistrée.");
  }

  return { token, expiresAt };
}

/**
 * Les invitations encore ouvertes, de la plus proche échéance à la plus
 * lointaine.
 *
 * Une invitation consommée ou expirée n'est plus « en cours » : elle disparaît
 * de la liste sans être supprimée — la trace de qui a été invité, et par qui,
 * reste en base.
 *
 * @throws {InvitationAdminRequiredError} si l'appelant n'est pas le compte d'amorçage.
 */
export async function listPendingInvitations(): Promise<InvitationDto[]> {
  const userId = await requireFirstAccountUserId();

  const rows = await db
    .select({ id: authInvitations.id, expiresAt: authInvitations.expiresAt })
    .from(authInvitations)
    .where(
      and(
        eq(authInvitations.createdByUserId, userId),
        isNull(authInvitations.consumedAt),
        gt(authInvitations.expiresAt, sql`now()`),
      ),
    )
    .orderBy(authInvitations.expiresAt);

  return rows.map((row) => ({ id: row.id, expiresAt: row.expiresAt }));
}

/**
 * Révoque une invitation non consommée. Rend `false` si elle n'existe pas, ne
 * lui appartient pas, ou a déjà servi — trois cas indistinguables, comme
 * partout ailleurs.
 *
 * Suppression pure : une invitation qui n'a jamais servi n'a rien à raconter.
 * La condition `consumed_at IS NULL` est portée par le `DELETE` lui-même, et
 * pas par une lecture préalable — un lien en cours de consommation ne peut donc
 * pas s'effacer sous les pieds de qui est en train de créer son compte.
 *
 * @throws {InvitationAdminRequiredError} si l'appelant n'est pas le compte d'amorçage.
 */
export async function revokeInvitation(invitationId: number): Promise<boolean> {
  const userId = await requireFirstAccountUserId();

  const deleted = await db
    .delete(authInvitations)
    .where(
      and(
        eq(authInvitations.id, invitationId),
        eq(authInvitations.createdByUserId, userId),
        isNull(authInvitations.consumedAt),
      ),
    )
    .returning({ id: authInvitations.id });

  return deleted.length > 0;
}

/**
 * Ce lien ouvrirait-il quelque chose ?
 *
 * Lecture d'affichage seulement : elle évite de faire remplir quatre champs
 * pour rien à qui arrive avec un lien périmé. Elle ne consomme rien et ne
 * protège rien — {@link consumeInvitation} refait le contrôle, et lui seul fait
 * autorité.
 */
export async function isInvitationUsable(token: string): Promise<boolean> {
  const rows = await db
    .select({ id: authInvitations.id })
    .from(authInvitations)
    .where(usableInvitation(invitationTokenFingerprint(token)))
    .limit(1);

  return rows.length > 0;
}

/** « Ce jeton, pas encore consommé, pas encore expiré » — la seule définition qui vaille. */
function usableInvitation(tokenHash: string) {
  return and(
    eq(authInvitations.tokenHash, tokenHash),
    isNull(authInvitations.consumedAt),
    gt(authInvitations.expiresAt, sql`now()`),
  );
}

/**
 * Consomme une invitation **et** crée le compte, indissociablement.
 *
 * La création du compte est passée en paramètre plutôt qu'appelée d'ici : le
 * DAL n'a pas à connaître better-auth, et surtout, la consommation n'est
 * exportée sous aucune autre forme — il n'existe donc aucun moyen de brûler un
 * jeton sans créer de compte, ni de créer un compte sans brûler le jeton.
 *
 * ## Comment la course est fermée
 *
 * Le verrou est posé par **une seule mise à jour conditionnelle** :
 *
 * ```sql
 * UPDATE auth_invitations SET consumed_at = now()
 *  WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
 *  RETURNING id
 * ```
 *
 * En `READ COMMITTED`, la seconde requête concurrente attend la ligne
 * verrouillée puis **réévalue sa clause** sur la version validée : `consumed_at`
 * n'y est plus nul, elle ne met à jour aucune ligne et repart les mains vides.
 * Deux navigateurs qui soumettent le même lien à la même seconde ne peuvent donc
 * pas créer deux comptes. Un `SELECT` suivi d'un `UPDATE` laisserait passer
 * exactement cette course (c'est le motif de `claimOrphanAthlete`).
 *
 * ## Tout ou rien
 *
 * Le compte n'est pas écrit par nous — better-auth le fait, dans sa propre
 * transaction, à laquelle ce module n'a pas de prise. L'indissociabilité est
 * donc obtenue par compensation : si la création échoue (e-mail déjà pris, base
 * coupée, refus du crochet), l'invitation est **rendue** dans le même souffle et
 * le lien reste utilisable. Le seul cas résiduel — le processus meurt entre la
 * consommation et la libération — laisse un lien brûlé sans compte, ce qui est
 * le sens prudent : un lien perdu se ré-émet, un compte de trop ne se
 * dés-inscrit pas.
 *
 * `consumed_by_user_id` est renseigné **après** : l'identifiant n'existe pas
 * avant que better-auth ne l'ait généré. Son écriture est de la traçabilité, pas
 * de la sécurité — un échec y est journalisé mais ne fait pas échouer l'appel :
 * le compte existe, sa session est ouverte, et annoncer un échec à ce stade
 * serait mentir. L'invitation reste consommée, ce qui est l'essentiel.
 *
 * @throws {InvitationUnusableError} si le lien n'ouvre rien.
 */
export async function consumeInvitation(
  token: string,
  createAccount: () => Promise<{ userId: string }>,
): Promise<void> {
  const claimed = await db
    .update(authInvitations)
    .set({ consumedAt: sql`now()` })
    .where(usableInvitation(invitationTokenFingerprint(token)))
    .returning({ id: authInvitations.id });

  const invitationId = claimed[0]?.id;
  if (invitationId === undefined) throw new InvitationUnusableError();

  let userId: string;
  try {
    // La marque de contexte ne couvre que cet appel-là : c'est elle qui autorise
    // le crochet d'inscription à laisser passer *une* création, et rien d'autre
    // ne s'exécute sous son couvert.
    ({ userId } = await withInvitationClaim(invitationId, createAccount));
  } catch (error) {
    await releaseInvitation(invitationId);
    throw error;
  }

  try {
    await db
      .update(authInvitations)
      .set({ consumedByUserId: userId })
      .where(eq(authInvitations.id, invitationId));
  } catch (error) {
    console.error(
      '[invitations] compte créé, mais son rattachement à l\'invitation a échoué',
      error,
    );
  }
}

/**
 * Rend une invitation consommée à tort, quand la création de compte a échoué.
 *
 * `consumed_by_user_id IS NULL` est la sécurité : on ne rouvre jamais un lien
 * qui a effectivement produit un compte.
 *
 * Un échec de libération est journalisé mais n'écrase pas l'erreur d'origine —
 * celle-ci est ce que l'utilisatrice doit voir ; ici, le lien est simplement
 * perdu (elle en redemandera un).
 */
async function releaseInvitation(invitationId: number): Promise<void> {
  try {
    await db
      .update(authInvitations)
      .set({ consumedAt: null })
      .where(
        and(
          eq(authInvitations.id, invitationId),
          isNull(authInvitations.consumedByUserId),
        ),
      );
  } catch (error) {
    console.error(
      "[invitations] libération impossible après l'échec d'une création de compte",
      error,
    );
  }
}
