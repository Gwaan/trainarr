import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { AthleteNotFoundError, getAthleteId } from './athlete';
import { db } from './db/client';
import { COACH_MESSAGE_ROLES, coachMessages, type CoachMessage } from './db/schema';

/**
 * Le fil de discussion avec le coach.
 *
 * **Un seul fil, continu** (cf. `coach_messages` dans le schéma) : l'appli est
 * mono-utilisateur, il n'y a donc rien à choisir ni à nommer — ce module ne
 * connaît que quatre gestes : lire la fin du fil, y ajouter un tour de parole, y
 * ajouter un échange entier d'un seul tenant, et tout effacer. Le dernier est la
 * seule façon de repartir de zéro, puisqu'il n'existe pas de « nouvelle
 * conversation » à ouvrir.
 *
 * La lecture rend toujours les messages du plus ancien au plus récent : c'est
 * l'ordre d'affichage, et c'est aussi l'ordre dans lequel une API de complétion
 * attend un historique. Une seule règle à tenir, donc un seul risque de la
 * tenir de travers (cf. {@link listCoachMessages}).
 */

export type CoachMessageRole = (typeof COACH_MESSAGE_ROLES)[number];

/**
 * DTO d'un message.
 *
 * Déclaré explicitement (pas de `typeof row`) : ajouter une colonne au schéma ne
 * doit jamais l'élargir en silence. `athleteId` n'en fait pas partie — mono-
 * utilisateur ou non, un identifiant d'athlète ne franchit pas la frontière
 * client. `id`, lui, y est : il donne à l'UI une clé de liste stable, que le
 * texte ne fournit pas (deux messages identiques sont possibles).
 */
export type CoachMessageDto = {
  id: number;
  role: CoachMessageRole;
  content: string;
  /** Instant d'écriture, sérialisé en ISO-8601 (le DTO traverse la frontière client). */
  createdAt: string;
};

/**
 * Bornes de contenu. Un message vide n'est pas un message ; un message
 * démesuré ferait exploser le contexte du modèle local.
 *
 * Source unique : la Server Action (ou le route handler) construira son schéma
 * Zod dessus, et le DAL les re-vérifie — défense en profondeur, une action n'est
 * pas la seule porte d'entrée possible.
 */
export const COACH_MESSAGE_LIMITS = {
  content: { min: 1, max: 8_000 },
} as const;

/** Nombre de messages relus par défaut. */
export const COACH_HISTORY_LIMIT = 40;

/**
 * Plafond du nombre de messages qu'une lecture peut demander.
 *
 * Le `limit` est une entrée comme une autre : sans borne haute, un appelant
 * ferait remonter tout le fil — et donc tout le fil dans le contexte du modèle.
 * Exporté pour que l'appelant borne exactement comme le DAL.
 */
export const COACH_HISTORY_LIMIT_MAX = 200;

/*
 * Erreurs métier — nommées, pour que l'appelant (route handler, service du
 * coach) distingue le cas attendu de la panne, sans jamais inspecter un message.
 */

/** Le message soumis est hors bornes ou mal formé. `field` désigne le fautif. */
export class InvalidCoachMessageError extends Error {
  constructor(
    readonly field: 'role' | 'content',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidCoachMessageError';
  }
}

/** Le nombre de messages demandé n'est pas un entier de 1 à {@link COACH_HISTORY_LIMIT_MAX}. */
export class InvalidCoachHistoryLimitError extends Error {
  constructor() {
    super(
      `Nombre de messages : entier attendu entre 1 et ${COACH_HISTORY_LIMIT_MAX}.`,
    );
    this.name = 'InvalidCoachHistoryLimitError';
  }
}

function toCoachMessageDto(row: CoachMessage): CoachMessageDto {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

/*
 * Validation (défense en profondeur), fonctions pures exportées pour les tests.
 */

/**
 * Le contenu détouré, s'il tient dans les bornes.
 *
 * Le `trim` précède la validation : un message tout en espaces est un message
 * vide, et l'espace de tête d'un copier-coller n'a rien à faire dans ce qui part
 * au modèle.
 *
 * @throws {InvalidCoachMessageError}
 */
export function validateCoachMessageContent(content: string): string {
  const trimmed = content.trim();

  if (trimmed.length < COACH_MESSAGE_LIMITS.content.min) {
    throw new InvalidCoachMessageError('content', 'Un message vide ne dit rien au coach.');
  }
  if (trimmed.length > COACH_MESSAGE_LIMITS.content.max) {
    throw new InvalidCoachMessageError(
      'content',
      `Message : ${COACH_MESSAGE_LIMITS.content.max} caractères au maximum.`,
    );
  }

  return trimmed;
}

/**
 * Le nombre de messages à relire, borné.
 *
 * @throws {InvalidCoachHistoryLimitError} plutôt que de rabattre en silence sur
 * le défaut : un appelant qui demande 10 000 messages se trompe, et lui en
 * rendre 40 sans le dire masquerait l'erreur.
 */
export function resolveHistoryLimit(limit?: number): number {
  if (limit === undefined) return COACH_HISTORY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > COACH_HISTORY_LIMIT_MAX) {
    throw new InvalidCoachHistoryLimitError();
  }
  return limit;
}

/*
 * Lectures.
 */

/**
 * Les `limit` derniers messages, rendus en ordre **chronologique croissant**
 * (le plus ancien d'abord) — c'est l'ordre d'affichage et l'ordre d'envoi au
 * modèle. Défaut : {@link COACH_HISTORY_LIMIT}.
 *
 * D'où le tri **décroissant** suivi d'une inversion : c'est la fin du fil qu'on
 * veut, et un `ORDER BY … ASC LIMIT n` rendrait les n messages les plus
 * **anciens** — le coach répondrait alors au début d'une conversation qu'il a
 * quittée depuis longtemps. L'`id` sert de départage : deux messages écrits dans
 * la même seconde (la question et sa réponse peuvent l'être) doivent garder
 * l'ordre où ils ont été écrits, sans quoi la réponse s'afficherait avant la
 * question.
 *
 * Liste vide tant que l'onboarding n'a pas eu lieu : sans athlète, il n'y a pas
 * de fil.
 *
 * @throws {InvalidCoachHistoryLimitError} si `limit` n'est pas dans ses bornes.
 */
export async function listCoachMessages(limit?: number): Promise<CoachMessageDto[]> {
  const size = resolveHistoryLimit(limit);

  const athleteId = await getAthleteId();
  if (athleteId === null) return [];

  const rows = await db
    .select()
    .from(coachMessages)
    .where(eq(coachMessages.athleteId, athleteId))
    .orderBy(desc(coachMessages.createdAt), desc(coachMessages.id))
    .limit(size);

  return rows.map(toCoachMessageDto).reverse();
}

/*
 * Écritures.
 */

/**
 * Ajoute un message au fil et le rend.
 *
 * @throws {InvalidCoachMessageError} si le rôle est inattendu ou le contenu hors
 * bornes — la validation précède l'écriture, rien n'est inséré à moitié.
 * @throws {AthleteNotFoundError} si l'onboarding n'a pas eu lieu.
 */
export async function appendCoachMessage(input: {
  role: CoachMessageRole;
  content: string;
}): Promise<CoachMessageDto> {
  // Le DAL n'est pas la seule porte d'entrée du fil (le service du coach écrit
  // ici lui aussi) : le rôle est re-vérifié même si le typage l'annonce.
  if (!COACH_MESSAGE_ROLES.includes(input.role)) {
    throw new InvalidCoachMessageError('role', 'Rôle de message inattendu.');
  }
  const content = validateCoachMessageContent(input.content);

  const athleteId = await getAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  const inserted = await db
    .insert(coachMessages)
    .values({ athleteId, role: input.role, content })
    .returning();

  const row = inserted[0];
  if (!row) throw new Error("L'insertion du message n'a retourné aucune ligne.");

  return toCoachMessageDto(row);
}

/**
 * Ajoute un échange complet — la question puis la réponse — en **une seule
 * écriture**, et rend les deux tours dans cet ordre.
 *
 * Existe pour une raison et une seule : il n'y a pas de fil valide où la
 * question serait écrite sans sa réponse. Le coach persiste l'échange une fois
 * la génération réussie (cf. `lib/ai/coach-service.ts`) ; deux appels successifs
 * à {@link appendCoachMessage} laisseraient, si le second échouait, une question
 * orpheline — invisible à l'écran jusqu'au rechargement, et relue par le modèle
 * au tour suivant comme un tour de parole à part entière. Un `INSERT` à deux
 * lignes ne peut pas en écrire une seule.
 *
 * Les deux lignes partagent le `created_at` que la base leur donne : c'est l'`id`
 * qui les départage à la relecture (cf. {@link listCoachMessages}), et il suit
 * l'ordre d'insertion.
 *
 * @throws {InvalidCoachMessageError} si l'un des deux contenus est hors bornes —
 * les deux sont validés avant que quoi que ce soit ne parte à la base.
 * @throws {AthleteNotFoundError} si l'onboarding n'a pas eu lieu.
 */
export async function appendCoachExchange(input: {
  question: string;
  answer: string;
}): Promise<{ question: CoachMessageDto; answer: CoachMessageDto }> {
  const question = validateCoachMessageContent(input.question);
  const answer = validateCoachMessageContent(input.answer);

  const athleteId = await getAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  const inserted = await db
    .insert(coachMessages)
    .values([
      { athleteId, role: 'user', content: question },
      { athleteId, role: 'assistant', content: answer },
    ])
    .returning();

  const [questionRow, answerRow] = inserted;
  if (!questionRow || !answerRow) {
    throw new Error("L'insertion de l'échange n'a pas retourné ses deux lignes.");
  }

  return { question: toCoachMessageDto(questionRow), answer: toCoachMessageDto(answerRow) };
}

/**
 * Vide le fil. Idempotent : sans athlète comme sans message, il n'y a rien à
 * supprimer et l'appel réussit — l'appelant efface une conversation, il ne
 * compte pas les lignes.
 *
 * Le `WHERE` porte sur l'athlète et non sur la table entière : le jour où une
 * seconde ligne d'athlète existerait, effacer le fil de l'une ne doit pas
 * emporter celui de l'autre.
 */
export async function clearCoachConversation(): Promise<void> {
  const athleteId = await getAthleteId();
  if (athleteId === null) return;

  await db.delete(coachMessages).where(eq(coachMessages.athleteId, athleteId));
}
