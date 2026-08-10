import 'server-only';

import { asc, eq } from 'drizzle-orm';

import { toCivilDate } from '@/lib/dates/civil';

import { db } from './db/client';
import { isUniqueViolation } from './db/errors';
import { ATHLETE_SEXES, athlete, type Athlete, type AthleteSex } from './db/schema';

/**
 * DTO du profil athlète exposé à l'UI.
 *
 * Déclaré explicitement (pas de `typeof row`) : ajouter une colonne au schéma ne
 * doit jamais l'élargir en silence. Il porte exactement les champs que le
 * formulaire de profil pré-remplit en édition — et **pas** l'identifiant
 * interne, qui ne franchit pas la frontière client (cf. `getAthleteId`).
 */
export type AthleteProfileDto = {
  displayName: string;
  sex: AthleteSex | null;
  maxHrBpm: number | null;
  restingHrBpm: number | null;
  weightKg: number | null;
  /** Date civile `YYYY-MM-DD`. */
  birthDate: string | null;
};

/**
 * Le profil tel que l'onboarding et l'édition le soumettent.
 *
 * Mêmes champs que le DTO : ce que l'UI affiche est exactement ce qu'elle peut
 * modifier. Tous les champs physiologiques sont facultatifs — un profil
 * incomplet vaut mieux qu'une valeur inventée (les métriques concernées se
 * déclarent « non calculables »).
 */
export type AthleteProfileInput = {
  displayName: string;
  sex: AthleteSex | null;
  maxHrBpm: number | null;
  restingHrBpm: number | null;
  weightKg: number | null;
  /** Date civile `YYYY-MM-DD`. */
  birthDate: string | null;
};

/**
 * Bornes physiologiques du profil.
 *
 * Source unique : la Server Action construit son schéma Zod dessus, et le DAL
 * les re-vérifie (défense en profondeur — une action n'est pas la seule porte
 * d'entrée possible du DAL).
 */
export const ATHLETE_PROFILE_LIMITS = {
  displayNameMaxChars: 100,
  maxHrBpm: { min: 100, max: 230 },
  restingHrBpm: { min: 25, max: 100 },
  weightKg: { min: 30, max: 200 },
  /** Date de naissance strictement postérieure : au-delà, c'est une saisie erronée. */
  birthDateAfter: '1900-01-01',
} as const;

/*
 * Erreurs métier — nommées, pour que l'appelant (Server Action) distingue le cas
 * attendu de la panne, sans jamais inspecter un message.
 */

/** Une valeur du profil est hors bornes. `field` désigne le champ fautif. */
export class InvalidAthleteProfileError extends Error {
  constructor(
    readonly field: keyof AthleteProfileInput,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidAthleteProfileError';
  }
}

/** Création demandée alors qu'un athlète est déjà enregistré (mono-utilisateur). */
export class AthleteAlreadyExistsError extends Error {
  constructor() {
    super('Un athlète est déjà enregistré : le profil se modifie, il ne se recrée pas.');
    this.name = 'AthleteAlreadyExistsError';
  }
}

/** Modification demandée alors qu'aucun athlète n'existe (onboarding non fait). */
export class AthleteNotFoundError extends Error {
  constructor() {
    super("Aucun athlète enregistré : le profil doit d'abord être créé.");
    this.name = 'AthleteNotFoundError';
  }
}

export function toAthleteProfileDto(row: Athlete): AthleteProfileDto {
  return {
    displayName: row.displayName,
    sex: row.sex,
    maxHrBpm: row.maxHrBpm,
    restingHrBpm: row.restingHrBpm,
    weightKg: row.weightKg,
    birthDate: row.birthDate,
  };
}

/*
 * Validation (défense en profondeur).
 *
 * La Server Action valide déjà l'entrée avec Zod pour rendre des messages par
 * champ ; ces contrôles-là existent pour que le DAL ne puisse pas écrire une
 * valeur aberrante, quel que soit son appelant.
 */

/**
 * Aujourd'hui dans le fuseau de l'athlète — une date de naissance est civile,
 * pas un instant. Exportée pour que la validation Zod de la Server Action borne
 * la date exactement comme le DAL.
 */
export function todayCivilDate(): string {
  return toCivilDate(new Date());
}

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `true` pour une date civile `YYYY-MM-DD` qui existe réellement au calendrier. */
export function isCivilDate(value: string): boolean {
  if (!CIVIL_DATE_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Le round-trip écarte les dates syntaxiquement correctes mais inexistantes
  // (2026-02-31), que certains parseurs normaliseraient en silence.
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function requireIntegerInRange(
  value: number | null,
  field: keyof AthleteProfileInput,
  bounds: { min: number; max: number },
  label: string,
): void {
  if (value === null) return;
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new InvalidAthleteProfileError(
      field,
      `${label} : entier attendu entre ${bounds.min} et ${bounds.max}.`,
    );
  }
}

/**
 * Vérifie les bornes et retourne l'entrée normalisée (nom détouré des espaces).
 *
 * Fonction pure, exportée pour les tests.
 *
 * @throws {InvalidAthleteProfileError} au premier champ fautif.
 */
export function validateAthleteProfile(input: AthleteProfileInput): AthleteProfileInput {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new InvalidAthleteProfileError('displayName', 'Le nom affiché est requis.');
  }
  if (displayName.length > ATHLETE_PROFILE_LIMITS.displayNameMaxChars) {
    throw new InvalidAthleteProfileError(
      'displayName',
      `Le nom affiché dépasse ${ATHLETE_PROFILE_LIMITS.displayNameMaxChars} caractères.`,
    );
  }

  if (input.sex !== null && !ATHLETE_SEXES.includes(input.sex)) {
    throw new InvalidAthleteProfileError('sex', 'Sexe biologique inattendu.');
  }

  requireIntegerInRange(input.maxHrBpm, 'maxHrBpm', ATHLETE_PROFILE_LIMITS.maxHrBpm, 'FC max');
  requireIntegerInRange(
    input.restingHrBpm,
    'restingHrBpm',
    ATHLETE_PROFILE_LIMITS.restingHrBpm,
    'FC de repos',
  );

  // Une FC de repos supérieure à la FC max rendrait la réserve cardiaque
  // négative : le TRIMP de Karvonen sortirait des valeurs de signe inversé.
  if (
    input.maxHrBpm !== null &&
    input.restingHrBpm !== null &&
    input.restingHrBpm >= input.maxHrBpm
  ) {
    throw new InvalidAthleteProfileError(
      'restingHrBpm',
      'La FC de repos doit être inférieure à la FC max.',
    );
  }

  const { weightKg } = input;
  if (
    weightKg !== null &&
    (!Number.isFinite(weightKg) ||
      weightKg < ATHLETE_PROFILE_LIMITS.weightKg.min ||
      weightKg > ATHLETE_PROFILE_LIMITS.weightKg.max)
  ) {
    throw new InvalidAthleteProfileError(
      'weightKg',
      `Poids : valeur attendue entre ${ATHLETE_PROFILE_LIMITS.weightKg.min} et ${ATHLETE_PROFILE_LIMITS.weightKg.max} kg.`,
    );
  }

  const { birthDate } = input;
  if (birthDate !== null) {
    if (!isCivilDate(birthDate)) {
      throw new InvalidAthleteProfileError('birthDate', 'Date de naissance : format AAAA-MM-JJ attendu.');
    }
    if (birthDate <= ATHLETE_PROFILE_LIMITS.birthDateAfter || birthDate > todayCivilDate()) {
      throw new InvalidAthleteProfileError(
        'birthDate',
        'Date de naissance : elle doit être passée et postérieure à 1900.',
      );
    }
  }

  return {
    displayName,
    sex: input.sex,
    maxHrBpm: input.maxHrBpm,
    restingHrBpm: input.restingHrBpm,
    weightKg: input.weightKg,
    birthDate: input.birthDate,
  };
}

/*
 * Lectures.
 */

/**
 * Profil de l'athlète. Application mono-utilisateur : la première (et unique)
 * ligne de la table. `null` tant que l'onboarding n'a pas eu lieu.
 */
export async function getAthleteProfile(): Promise<AthleteProfileDto | null> {
  const rows = await db.select().from(athlete).orderBy(asc(athlete.id)).limit(1);
  const row = rows[0];
  return row ? toAthleteProfileDto(row) : null;
}

/**
 * Identifiant interne de l'athlète, `null` tant que l'onboarding n'a pas eu lieu.
 *
 * **Usage serveur uniquement** (import FIT : les activités portent une clé
 * étrangère vers l'athlète). Il est volontairement absent de
 * {@link AthleteProfileDto} : un identifiant de base ne franchit pas la
 * frontière client.
 */
export async function getAthleteId(): Promise<number | null> {
  const rows = await db.select({ id: athlete.id }).from(athlete).orderBy(asc(athlete.id)).limit(1);
  return rows[0]?.id ?? null;
}

/** `true` dès qu'un profil existe — ce qui décide entre onboarding et édition. */
export async function hasAthlete(): Promise<boolean> {
  return (await getAthleteId()) !== null;
}

/*
 * Écritures.
 */

/**
 * Crée le profil de l'athlète (onboarding).
 *
 * @throws {InvalidAthleteProfileError} si une valeur est hors bornes.
 * @throws {AthleteAlreadyExistsError} si un profil existe déjà — l'application
 * est mono-utilisateur : la seconde ligne n'aurait aucun sens, et les activités
 * importées pointeraient vers l'un ou l'autre selon l'ordre des requêtes.
 */
export async function createAthlete(input: AthleteProfileInput): Promise<void> {
  const values = validateAthleteProfile(input);

  try {
    // La lecture préalable rend l'erreur attendue sans dépendre d'un code SQL,
    // mais elle ne suffit pas : en READ COMMITTED, deux soumissions simultanées
    // du formulaire d'onboarding lisent toutes les deux une table vide. C'est
    // l'index unique de singleton (`athlete_singleton`, migration 0004) qui
    // ferme la course ; le `catch` ci-dessous en fait le même cas métier.
    await db.transaction(async (tx) => {
      const existing = await tx.select({ id: athlete.id }).from(athlete).limit(1);
      if (existing.length > 0) throw new AthleteAlreadyExistsError();
      await tx.insert(athlete).values(values);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AthleteAlreadyExistsError();
    throw error;
  }
}

/**
 * Met à jour le profil existant.
 *
 * @throws {InvalidAthleteProfileError} si une valeur est hors bornes.
 * @throws {AthleteNotFoundError} si l'onboarding n'a pas encore eu lieu.
 */
export async function updateAthleteProfile(input: AthleteProfileInput): Promise<void> {
  const values = validateAthleteProfile(input);

  const id = await getAthleteId();
  if (id === null) throw new AthleteNotFoundError();

  await db
    .update(athlete)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(athlete.id, id));
}
