import 'server-only';

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { decryptStoredSecret, encryptStoredSecret } from '@/lib/crypto/app-secret';
import { SecretDecryptionError, SecretKeyUnavailableError } from '@/lib/crypto/secret-box';
import { isCivilDate, toCivilDate } from '@/lib/dates/civil';
import type { IntervalsAccount } from '@/lib/intervals/poll-plan';

/**
 * Réexport : la validation d'une date civile vit désormais dans
 * `@/lib/dates/civil` (des modules purs en ont besoin, et ne peuvent pas
 * importer un module `server-only`). Elle reste importable d'ici, où tous ses
 * appelants la cherchent.
 */
export { isCivilDate };

import { db } from './db/client';
import { isUniqueViolation } from './db/errors';
import { ATHLETE_SEXES, athlete, type Athlete, type AthleteSex } from './db/schema';
import { getSession } from './session';

/**
 * DTO du profil athlète exposé à l'UI.
 *
 * Déclaré explicitement (pas de `typeof row`) : ajouter une colonne au schéma ne
 * doit jamais l'élargir en silence. Il porte exactement les champs que le
 * formulaire de profil pré-remplit en édition — et **pas** l'identifiant
 * interne, qui ne franchit pas la frontière client (cf. `getCurrentAthleteId`).
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

/** Création demandée alors que le compte connecté a déjà un athlète. */
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

/**
 * Création demandée hors session.
 *
 * Ce n'est pas un contrôle d'accès (il n'y en a pas encore, cf. `proxy.ts`),
 * c'est une **impossibilité de modélisation** : un athlète appartient à un
 * compte, et sans session il n'y a pas de compte à inscrire dans `user_id`.
 * Créer la ligne quand même produirait exactement l'orphelin que la réclamation
 * existe pour rattraper.
 */
export class AthleteOwnerRequiredError extends Error {
  constructor() {
    super("Aucune session : un athlète appartient à un compte, il ne s'en crée pas sans.");
    this.name = 'AthleteOwnerRequiredError';
  }
}

/** Un identifiant intervals.icu est hors bornes. `field` désigne le champ fautif. */
export class InvalidIntervalsSettingsError extends Error {
  constructor(
    readonly field: 'intervalsAthleteId' | 'apiKey',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidIntervalsSettingsError';
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
 * L'athlète du compte connecté, `null` s'il n'y a pas de session ou pas encore
 * d'athlète.
 *
 * **Remplace `getAthleteId()`**, qui rendait « le premier athlète venu »
 * (`ORDER BY id LIMIT 1`) — acceptable tant que la base n'en portait qu'un,
 * indéfendable dès qu'un second compte peut exister. Tout le DAL passe désormais
 * par ici : un chemin qui n'a pas de session n'a pas d'athlète, il n'en emprunte
 * pas celui du voisin.
 *
 * **Usage serveur uniquement** : l'identifiant est volontairement absent de
 * {@link AthleteProfileDto}, une clé de base ne franchit pas la frontière
 * client.
 *
 * Volontairement **non mémoïsée** (contrairement à `getSession`, qui l'est et
 * porte l'essentiel du coût) : la valeur change au sein d'une même requête —
 * l'onboarding crée l'athlète, la réclamation l'attribue — et un cache la
 * figerait à `null` juste après la création.
 */
export async function getCurrentAthleteId(): Promise<number | null> {
  const session = await getSession();
  if (session === null) return null;

  const owned = await db
    .select({ id: athlete.id })
    .from(athlete)
    .where(eq(athlete.userId, session.userId))
    .limit(1);
  const id = owned[0]?.id;
  if (id !== undefined) return id;

  return claimOrphanAthlete(session.userId);
}

/**
 * Attribue au compte l'athlète sans propriétaire le plus ancien, s'il en existe
 * un. Rend son identifiant, ou `null` s'il n'y avait rien à réclamer.
 *
 * **Pourquoi ce mécanisme existe** : les athlètes antérieurs à
 * l'authentification portent `user_id IS NULL`. Sans réclamation, le compte qui
 * se connecte ne verrait aucun athlète, l'onboarding lui en créerait un neuf et
 * vide, et des années d'entraînement resteraient rattachées à une ligne
 * orpheline devenue invisible dans l'application.
 *
 * **Une seule mise à jour conditionnelle**, et c'est essentiel : le `WHERE
 * user_id IS NULL` est réévalué par Postgres sur la ligne verrouillée
 * (`READ COMMITTED`), si bien que deux réclamations simultanées ne peuvent pas
 * aboutir toutes les deux — la seconde ne touche aucune ligne et repart avec
 * `null`, donc vers l'onboarding. Un `SELECT` suivi d'un `UPDATE` laisserait
 * passer cette course. L'unicité de `athlete.user_id` reste le garde-fou de
 * dernier recours.
 *
 * La sous-requête `min(id)` désigne **une** ligne : plus rien n'interdit
 * plusieurs orphelins depuis la disparition de `athlete_singleton`, et une mise
 * à jour non bornée les attribuerait tous au même compte (violation d'unicité).
 */
async function claimOrphanAthlete(userId: string): Promise<number | null> {
  const claimed = await db
    .update(athlete)
    .set({ userId, updatedAt: new Date() })
    .where(
      and(
        isNull(athlete.userId),
        eq(
          athlete.id,
          sql`(select min(${athlete.id}) from ${athlete} where ${athlete.userId} is null)`,
        ),
      ),
    )
    .returning({ id: athlete.id });

  return claimed[0]?.id ?? null;
}

/**
 * La ligne complète d'un athlète **désigné**, `null` s'il n'existe pas.
 *
 * C'est la lecture primitive : {@link getCurrentAthlete} n'est qu'elle,
 * précédée de la résolution de session. Les chemins qui tournent **hors
 * requête** (ingestion d'un fichier FIT, et tout ce qu'elle déclenche) reçoivent
 * leur athlète en paramètre et passent donc directement par ici — il n'y a pas
 * de session à interroger, et il ne peut pas y en avoir.
 *
 * **Usage serveur uniquement** : elle porte l'identifiant interne et les
 * identifiants intervals.icu, elle ne franchit pas la frontière client — c'est
 * {@link getAthleteProfileById} qui rend le DTO.
 */
export async function getAthleteById(athleteId: number): Promise<Athlete | null> {
  const rows = await db.select().from(athlete).where(eq(athlete.id, athleteId)).limit(1);
  return rows[0] ?? null;
}

/**
 * La ligne complète de l'athlète du compte connecté, `null` s'il n'y en a pas.
 *
 * Elle existe pour les lectures qui ont besoin du profil *et* de son
 * identifiant dans la foulée (tableau de bord, progression) : elles lisaient la
 * table en direct, `ORDER BY id LIMIT 1` — soit exactement le « premier athlète
 * venu » que le cloisonnement par compte interdit.
 */
export async function getCurrentAthlete(): Promise<Athlete | null> {
  const id = await getCurrentAthleteId();
  return id === null ? null : getAthleteById(id);
}

/** Profil d'un athlète **désigné**, `null` s'il n'existe pas. */
export async function getAthleteProfileById(
  athleteId: number,
): Promise<AthleteProfileDto | null> {
  const row = await getAthleteById(athleteId);
  return row ? toAthleteProfileDto(row) : null;
}

/**
 * Profil de l'athlète du compte connecté. `null` tant que l'onboarding n'a pas
 * eu lieu — ou qu'il n'y a personne de connecté.
 */
export async function getAthleteProfile(): Promise<AthleteProfileDto | null> {
  const id = await getCurrentAthleteId();
  return id === null ? null : getAthleteProfileById(id);
}

/** `true` dès que le compte connecté a un athlète — ce qui décide entre onboarding et édition. */
export async function hasAthlete(): Promise<boolean> {
  return (await getCurrentAthleteId()) !== null;
}

/**
 * Tous les athlètes, par identifiant croissant.
 *
 * **Réservée aux services de fond**, qui n'ont pas de session et doivent
 * pourtant travailler pour chaque compte : le rattrapage de la météo passe
 * ensuite athlète par athlète, chaque appel du DAL recevant le sien en
 * paramètre. C'est la même mécanique que {@link listIntervalsAccounts} pour le
 * rapatriement — énumérer les comptes, puis les traiter un à un — et surtout pas
 * un raccourci « le premier athlète venu », qui reste interdit partout.
 */
export async function listAthleteIds(): Promise<number[]> {
  const rows = await db.select({ id: athlete.id }).from(athlete).orderBy(athlete.id);
  return rows.map((row) => row.id);
}

/*
 * Identifiants intervals.icu.
 *
 * Ils vivaient dans l'environnement du serveur (`INTERVALS_ATHLETE_ID`,
 * `INTERVALS_API_KEY`) : une installation, un compte intervals.icu. Ils
 * appartiennent maintenant à l'athlète.
 */

/**
 * Ce que l'UI a le droit de savoir des identifiants intervals.icu.
 *
 * **La clé n'y figure pas, même tronquée, même masquée.** Une clé masquée reste
 * une clé transmise au navigateur, et quatre caractères en clair suffisent à la
 * reconnaître dans une capture d'écran. Ce que le formulaire a besoin de savoir,
 * c'est s'il doit proposer « enregistrer » ou « remplacer » — un état, pas une
 * valeur.
 */
export type IntervalsApiKeyState =
  /** Aucune clé enregistrée. */
  | 'absent'
  /** Une clé est enregistrée et déchiffrable. */
  | 'configured'
  /**
   * Une clé est enregistrée mais ne se déchiffre plus : `BETTER_AUTH_SECRET` a
   * changé depuis. Elle est perdue, pas cassée — la ressaisir suffit. Cet état
   * existe pour que l'UI le dise, plutôt que de laisser le poller échouer en
   * silence.
   */
  | 'unreadable';

export type IntervalsSettingsDto = {
  /** Identifiant intervals.icu (ex. `i123456`), `null` s'il n'est pas renseigné. */
  intervalsAthleteId: string | null;
  apiKey: IntervalsApiKeyState;
};

/** Bornes de saisie — source unique pour la validation Zod de la Server Action. */
export const INTERVALS_SETTINGS_LIMITS = {
  athleteIdMaxChars: 64,
  apiKeyMaxChars: 256,
} as const;

/**
 * Ce que le formulaire soumet.
 *
 * `apiKey` distingue trois intentions, et c'est la seule façon de proposer un
 * champ vide sans effacer la clé enregistrée à chaque enregistrement du
 * formulaire :
 * - `undefined` : ne pas toucher à la clé enregistrée ;
 * - `null` : l'effacer ;
 * - une chaîne : la remplacer.
 */
export type IntervalsSettingsInput = {
  intervalsAthleteId: string | null;
  apiKey?: string | null;
};

/**
 * Les identifiants intervals.icu tels que l'UI peut les voir. `null` si le
 * compte connecté n'a pas d'athlète.
 *
 * Tente le déchiffrement pour distinguer `configured` d'`unreadable` — la valeur
 * déchiffrée, elle, est jetée aussitôt et ne sort pas d'ici.
 */
export async function getIntervalsSettings(): Promise<IntervalsSettingsDto | null> {
  const id = await getCurrentAthleteId();
  if (id === null) return null;

  const rows = await db
    .select({
      intervalsAthleteId: athlete.intervalsAthleteId,
      encrypted: athlete.intervalsApiKeyEncrypted,
    })
    .from(athlete)
    .where(eq(athlete.id, id))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    intervalsAthleteId: row.intervalsAthleteId,
    apiKey: apiKeyState(row.encrypted),
  };
}

function apiKeyState(encrypted: string | null): IntervalsApiKeyState {
  if (encrypted === null) return 'absent';
  try {
    decryptStoredSecret(encrypted);
    return 'configured';
  } catch (error) {
    // Seuls ces deux cas-là sont un état de la donnée ; toute autre panne
    // (mémoire, algorithme indisponible) reste une panne et remonte.
    if (error instanceof SecretDecryptionError || error instanceof SecretKeyUnavailableError) {
      return 'unreadable';
    }
    throw error;
  }
}

/** Ce qu'un appel sortant a besoin de savoir pour parler à intervals.icu. */
export type IntervalsCredentials = {
  intervalsAthleteId: string | null;
  apiKey: string;
};

/**
 * Les identifiants intervals.icu **en clair** d'un athlète **désigné**, pour un
 * appel sortant depuis le serveur. `null` si aucune clé n'est enregistrée.
 *
 * Le seul point du code où la clé existe en clair — elle ne doit jamais être
 * retournée par une Server Action, ni entrer dans une prop de composant.
 *
 * Comme {@link getAthleteById}, c'est la lecture primitive : la publication du
 * calendrier tourne aussi bien dans une requête (l'athlète vient de la session)
 * que derrière une ingestion de fond (l'athlète vient du chemin du fichier), et
 * les deux passent par ici avec leur athlète en paramètre.
 *
 * @throws {SecretDecryptionError} si la clé enregistrée ne se déchiffre plus
 * (« clé illisible, à ressaisir ») — jamais un `null` silencieux, qui ferait
 * passer une clé perdue pour une clé absente.
 * @throws {SecretKeyUnavailableError} si l'installation n'a pas de secret.
 */
export async function getIntervalsCredentialsById(
  athleteId: number,
): Promise<IntervalsCredentials | null> {
  const rows = await db
    .select({
      intervalsAthleteId: athlete.intervalsAthleteId,
      encrypted: athlete.intervalsApiKeyEncrypted,
    })
    .from(athlete)
    .where(eq(athlete.id, athleteId))
    .limit(1);

  const row = rows[0];
  if (row === undefined || row.encrypted === null) return null;

  return {
    intervalsAthleteId: row.intervalsAthleteId,
    apiKey: decryptStoredSecret(row.encrypted),
  };
}


/**
 * Tous les comptes qui ont enregistré une clé API intervals.icu, **sans passer
 * par une session**.
 *
 * C'est la seule lecture du DAL destinée au service de fond : le watcher et le
 * poller tournent dans le process du serveur mais hors requête, il n'y a donc
 * ni cookie, ni session, ni « athlète courant » — et il ne peut pas y en avoir.
 * L'appelant ne demande pas « qui est connecté ? » mais « quels comptes ont
 * quelque chose à rapatrier ? », ce qui est une question légitime pour une
 * boucle de fond et pour elle seule.
 *
 * **À n'appeler que depuis le service de fond.** Aucun chemin servant une
 * requête n'a de raison de lire les identifiants d'un autre compte que celui de
 * sa session ({@link getIntervalsCredentialsById}), et rien de ce que rend cette
 * fonction — la clé en clair, au premier chef — ne doit franchir la frontière
 * client.
 *
 * Une clé qui ne se déchiffre plus n'est **pas** silencieusement omise : elle
 * ressort en `unreadable` avec son motif, à charge du service de sauter ce
 * compte en le disant. L'omettre ferait passer une clé perdue pour une clé
 * jamais saisie, et le rapatriement s'arrêterait sans que rien ne l'explique.
 */
export async function listIntervalsAccounts(): Promise<IntervalsAccount[]> {
  const rows = await db
    .select({
      id: athlete.id,
      intervalsAthleteId: athlete.intervalsAthleteId,
      encrypted: athlete.intervalsApiKeyEncrypted,
    })
    .from(athlete)
    .where(isNotNull(athlete.intervalsApiKeyEncrypted))
    .orderBy(athlete.id);

  return rows.map((row) => toIntervalsAccount(row.id, row.intervalsAthleteId, row.encrypted));
}

function toIntervalsAccount(
  athleteId: number,
  intervalsAthleteId: string | null,
  encrypted: string | null,
): IntervalsAccount {
  // `WHERE intervals_api_key_encrypted IS NOT NULL` l'exclut déjà ; le typage,
  // lui, ne le sait pas — et un compte sans clé n'est pas à rapatrier.
  if (encrypted === null) {
    return { athleteId, status: 'unreadable', reason: 'aucune clé API intervals.icu enregistrée' };
  }

  try {
    return { athleteId, status: 'ready', intervalsAthleteId, apiKey: decryptStoredSecret(encrypted) };
  } catch (error) {
    // Mêmes deux cas que `apiKeyState` : un état de la donnée, pas une panne.
    // Le motif ne cite évidemment ni la clé, ni l'enveloppe chiffrée.
    if (error instanceof SecretDecryptionError) {
      return {
        athleteId,
        status: 'unreadable',
        reason:
          'clé API intervals.icu illisible (BETTER_AUTH_SECRET a changé) — la ressaisir dans les réglages',
      };
    }
    if (error instanceof SecretKeyUnavailableError) {
      return {
        athleteId,
        status: 'unreadable',
        reason: 'clé API intervals.icu indéchiffrable — BETTER_AUTH_SECRET absent ou trop court',
      };
    }
    throw error;
  }
}

/**
 * Vérifie et normalise une saisie d'identifiants intervals.icu. Fonction pure,
 * exportée pour les tests.
 *
 * Une chaîne vide (ou blanche) vaut « pas renseigné » : c'est `null` en base,
 * jamais une chaîne vide qui se ferait passer pour une valeur.
 *
 * @throws {InvalidIntervalsSettingsError} au premier champ fautif.
 */
export function validateIntervalsSettings(input: IntervalsSettingsInput): {
  intervalsAthleteId: string | null;
  apiKey?: string | null;
} {
  const intervalsAthleteId = input.intervalsAthleteId?.trim() ?? '';
  if (intervalsAthleteId.length > INTERVALS_SETTINGS_LIMITS.athleteIdMaxChars) {
    throw new InvalidIntervalsSettingsError(
      'intervalsAthleteId',
      `L'identifiant intervals.icu dépasse ${INTERVALS_SETTINGS_LIMITS.athleteIdMaxChars} caractères.`,
    );
  }

  if (input.apiKey === undefined) {
    return { intervalsAthleteId: intervalsAthleteId === '' ? null : intervalsAthleteId };
  }

  const apiKey = input.apiKey?.trim() ?? '';
  if (apiKey.length > INTERVALS_SETTINGS_LIMITS.apiKeyMaxChars) {
    // Le message ne cite évidemment pas la valeur reçue.
    throw new InvalidIntervalsSettingsError(
      'apiKey',
      `La clé API dépasse ${INTERVALS_SETTINGS_LIMITS.apiKeyMaxChars} caractères.`,
    );
  }

  return {
    intervalsAthleteId: intervalsAthleteId === '' ? null : intervalsAthleteId,
    apiKey: apiKey === '' ? null : apiKey,
  };
}

/**
 * Enregistre les identifiants intervals.icu de l'athlète connecté. La clé est
 * chiffrée ici et n'est jamais écrite en clair.
 *
 * @throws {InvalidIntervalsSettingsError} si une valeur est hors bornes.
 * @throws {AthleteNotFoundError} si le compte n'a pas d'athlète.
 * @throws {SecretKeyUnavailableError} si l'installation n'a pas de secret : la
 * clé n'est alors pas enregistrée du tout, plutôt qu'enregistrée sans protection.
 */
export async function saveIntervalsSettings(input: IntervalsSettingsInput): Promise<void> {
  const values = validateIntervalsSettings(input);

  const id = await getCurrentAthleteId();
  if (id === null) throw new AthleteNotFoundError();

  const encrypted =
    values.apiKey === undefined
      ? {}
      : {
          intervalsApiKeyEncrypted:
            values.apiKey === null ? null : encryptStoredSecret(values.apiKey),
        };

  await db
    .update(athlete)
    .set({
      intervalsAthleteId: values.intervalsAthleteId,
      ...encrypted,
      updatedAt: new Date(),
    })
    .where(eq(athlete.id, id));
}

/*
 * Écritures.
 */

/**
 * Crée le profil de l'athlète du compte connecté (onboarding).
 *
 * La ligne naît **avec son propriétaire** : jamais d'athlète orphelin créé par
 * l'application elle-même — les seuls orphelins légitimes sont ceux d'avant
 * l'authentification, que la réclamation rattrape.
 *
 * @throws {AthleteOwnerRequiredError} hors session : il n'y a pas de compte à
 * inscrire dans `user_id`.
 * @throws {InvalidAthleteProfileError} si une valeur est hors bornes.
 * @throws {AthleteAlreadyExistsError} si ce compte a déjà un athlète — y compris
 * celui qu'il vient de réclamer : son profil se modifie, il ne se recrée pas.
 */
export async function createAthlete(input: AthleteProfileInput): Promise<void> {
  const values = validateAthleteProfile(input);

  const session = await getSession();
  if (session === null) throw new AthleteOwnerRequiredError();

  // Réclamation comprise : si un athlète orphelin traîne, il revient à ce compte
  // et c'est lui qu'il faut modifier — en créer un second enterrerait son
  // historique sous un profil vide.
  if ((await getCurrentAthleteId()) !== null) throw new AthleteAlreadyExistsError();

  try {
    // La lecture préalable rend l'erreur attendue sans dépendre d'un code SQL,
    // mais elle ne suffit pas : en READ COMMITTED, deux soumissions simultanées
    // du formulaire d'onboarding ne voient ni l'une ni l'autre la ligne de sa
    // voisine. C'est l'unicité de `user_id` (migration 0017) qui ferme la
    // course ; le `catch` ci-dessous en fait le même cas métier.
    await db.insert(athlete).values({ ...values, userId: session.userId });
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

  const id = await getCurrentAthleteId();
  if (id === null) throw new AthleteNotFoundError();

  await db
    .update(athlete)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(athlete.id, id));
}
