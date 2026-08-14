import 'server-only';

import { and, desc, eq, gt, gte, isNotNull, lt, lte } from 'drizzle-orm';

import { ActivityNotFoundError } from './activities';
import { ATHLETE_PROFILE_LIMITS, AthleteNotFoundError, getCurrentAthlete } from './athlete';
import { db } from './db/client';
import { activities, athlete, type Athlete } from './db/schema';

/**
 * Proposition de FC max — la lecture, et les deux réponses possibles.
 *
 * ## Ce que c'est
 *
 * L'ingestion mesure, séance par séance, la plus haute fréquence **tenue cinq
 * secondes** (`activities.sustained_max_hr_bpm`, cf.
 * `src/lib/metrics/sustained-hr.ts`). Quand l'une d'elles dépasse la FC max du
 * profil, l'application le **propose** : l'athlète accepte ou écarte. Jamais de
 * mise à jour silencieuse — la FC max de profil pilote le TRIMP, les zones et la
 * VO₂max, et tout se recalcule rétroactivement depuis elle.
 *
 * ## Ce que ce n'est pas
 *
 * **Pas une table.** Une proposition n'a pas de cycle de vie propre : elle se
 * déduit à la lecture de ce qui est déjà en base — la plus haute FC soutenue de
 * l'athlète, la FC max de son profil, et le seuil de refus qu'il a posé. Rien à
 * créer, rien à périmer, rien à nettoyer quand une activité est supprimée.
 *
 * **Jamais une proposition à la baisse.** Ne pas atteindre sa FC max ne prouve
 * pas qu'elle a baissé : une saison entière peut se courir sans jamais y
 * revenir. Seul un dépassement est une information.
 *
 * ## Le refus
 *
 * `athlete.max_hr_suggestion_dismissed_bpm` est un **seuil** : « tout ce qui est
 * supérieur ou égal à cette valeur a déjà été écarté ». La proposition suivante
 * est donc la plus haute valeur **strictement inférieure** au seuil. C'est ce
 * qui empêche un unique artefact à 215 d'enterrer la vraie pointe à 192 — et
 * donc de désactiver la fonction pour toujours.
 *
 * ## Cloisonnement
 *
 * Comme partout : les lectures d'écran résolvent l'athlète depuis la session
 * ({@link getMaxHrSuggestion}) et ne rendent rien s'il n'y en a pas ; l'écriture
 * de l'ingestion tourne hors requête et reçoit son athlète en paramètre
 * ({@link recordSustainedMaxHr}).
 */

/** Ce que l'écran a besoin de savoir d'une proposition, et rien de plus. */
export type MaxHrSuggestionDto = {
  /** La fréquence observée, en battements par minute. */
  bpm: number;
  /**
   * L'activité d'où elle sort — une proposition inexplicable serait refusée par
   * principe, donc l'écran la source (date, nom, lien).
   */
  activityId: number;
  activityName: string;
  activityStartedAt: Date;
};

/**
 * La proposition affichée ne correspond plus à celle que le serveur calcule.
 *
 * Cas normal (un import est arrivé entre l'affichage et le clic, deux onglets
 * ouverts), pas une panne : l'écran redemande la lecture et repropose. Cette
 * erreur est aussi ce qui rend inopérant un appel direct à l'action avec une
 * valeur choisie — la valeur acceptée est toujours celle que le serveur a
 * calculée, jamais celle que le client annonce.
 */
export class StaleMaxHrSuggestionError extends Error {
  constructor() {
    super("Cette proposition de FC max n'est plus d'actualité.");
    this.name = 'StaleMaxHrSuggestionError';
  }
}

/** La FC max acceptée ne peut pas être écrite telle quelle dans le profil. */
export class UnusableMaxHrSuggestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableMaxHrSuggestionError';
  }
}

/*
 * Écriture de l'ingestion.
 */

/**
 * Enregistre la FC max soutenue d'une activité **de cet athlète**.
 *
 * `null` est une valeur écrite, pas une absence d'écriture : la colonne suit les
 * séries temporelles dont elle dérive, et un fichier relu qui n'a plus de canal
 * cardiaque doit effacer la mesure qu'un fichier précédent avait laissée. C'est
 * la même politique que `saveActivityStreams` — remplacement, pas complétion —
 * et pour la même raison : cette valeur n'est pas éditable dans l'application,
 * sa seule source est le fichier.
 *
 * **L'athlète est un paramètre** : l'ingestion tourne dans le watcher, hors
 * requête, il n'y a pas de session à interroger.
 *
 * @throws {ActivityNotFoundError} si l'activité n'est pas celle de l'athlète (ou
 * n'existe pas : les deux cas ne se distinguent pas).
 */
export async function recordSustainedMaxHr(
  activityId: number,
  athleteId: number,
  bpm: number | null,
): Promise<void> {
  const updated = await db
    .update(activities)
    .set({ sustainedMaxHrBpm: bpm })
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, athleteId)))
    .returning({ id: activities.id });

  if (updated.length === 0) throw new ActivityNotFoundError();
}

/*
 * Lecture.
 */

/**
 * La proposition d'un athlète **déjà lu**, `null` s'il n'y en a pas.
 *
 * C'est la lecture primitive : le tableau de bord tient déjà la ligne complète
 * de l'athlète (il en a besoin pour tout le reste) et n'a aucune raison de la
 * relire. Les réglages passent par {@link getMaxHrSuggestion}, qui la résout
 * depuis la session. **Une seule logique**, deux points d'entrée : les deux
 * écrans montrent forcément la même proposition.
 *
 * Quatre conditions, toutes nécessaires :
 *
 * 1. la séance porte une FC max soutenue (l'historique importé avant cette
 *    fonctionnalité n'en a pas) ;
 * 2. elle dépasse d'au moins 1 bpm la FC max du profil — ou le profil n'en a pas
 *    encore, auquel cas la première mesure soutenue est exactement ce que ce
 *    champ attend ;
 * 3. elle reste **sous** le seuil de refus, s'il y en a un ;
 * 4. elle tient dans les bornes du profil : proposer une valeur que le
 *    formulaire refuserait serait proposer un clic sans effet.
 */
export async function selectMaxHrSuggestion(
  profile: Athlete,
): Promise<MaxHrSuggestionDto | null> {
  const { min, max } = ATHLETE_PROFILE_LIMITS.maxHrBpm;

  const conditions = [
    eq(activities.athleteId, profile.id),
    isNotNull(activities.sustainedMaxHrBpm),
    gte(activities.sustainedMaxHrBpm, min),
    lte(activities.sustainedMaxHrBpm, max),
  ];
  if (profile.maxHrBpm !== null) {
    conditions.push(gt(activities.sustainedMaxHrBpm, profile.maxHrBpm));
  }
  if (profile.maxHrSuggestionDismissedBpm !== null) {
    conditions.push(lt(activities.sustainedMaxHrBpm, profile.maxHrSuggestionDismissedBpm));
  }

  const rows = await db
    .select({
      id: activities.id,
      name: activities.name,
      startedAt: activities.startedAt,
      sustainedMaxHrBpm: activities.sustainedMaxHrBpm,
    })
    .from(activities)
    .where(and(...conditions))
    // La plus haute d'abord ; à valeur égale, la plus récente — c'est celle dont
    // l'athlète se souvient.
    .orderBy(desc(activities.sustainedMaxHrBpm), desc(activities.startedAt))
    .limit(1);

  const row = rows[0];
  // `isNotNull` l'exclut déjà ; le typage de Drizzle, lui, ne le sait pas.
  if (row === undefined || typeof row.sustainedMaxHrBpm !== 'number') return null;

  // DTO explicite, comme partout : la ligne d'activité porte bien plus que ça.
  return {
    bpm: row.sustainedMaxHrBpm,
    activityId: row.id,
    activityName: row.name,
    activityStartedAt: row.startedAt,
  };
}

/**
 * La proposition de l'athlète connecté, `null` s'il n'y en a pas — ou s'il n'y a
 * ni session ni athlète.
 */
export async function getMaxHrSuggestion(): Promise<MaxHrSuggestionDto | null> {
  const profile = await getCurrentAthlete();
  return profile === null ? null : selectMaxHrSuggestion(profile);
}

/*
 * Les deux réponses.
 */

/**
 * Relit la proposition courante et vérifie qu'elle vaut bien `bpm`.
 *
 * Le contrôle anti-rejeu de ces deux écritures : la valeur qui arrive du
 * navigateur n'est jamais celle qu'on écrit, elle sert uniquement à confirmer
 * qu'on parle de la même proposition. Un appel direct à l'action avec 230 bpm
 * ne fait donc rien d'autre que lever.
 */
async function requireCurrentSuggestion(bpm: number): Promise<{
  profile: Athlete;
  suggestion: MaxHrSuggestionDto;
}> {
  const profile = await getCurrentAthlete();
  if (profile === null) throw new AthleteNotFoundError();

  const suggestion = await selectMaxHrSuggestion(profile);
  if (suggestion === null || suggestion.bpm !== bpm) throw new StaleMaxHrSuggestionError();

  return { profile, suggestion };
}

/**
 * Accepte la proposition : la FC max du profil devient la valeur observée.
 *
 * Tout le reste — TRIMP, zones, VO₂max, charge — se recalcule à la lecture
 * depuis le profil : il n'y a **rien** à réécrire dans l'historique, et c'est
 * exactement le comportement voulu.
 *
 * Le seuil de refus n'est pas remis à zéro : « 215 et au-dessus, c'est du
 * bruit » reste vrai après avoir accepté 192.
 *
 * @throws {AthleteNotFoundError} sans athlète.
 * @throws {StaleMaxHrSuggestionError} si la proposition a changé depuis
 * l'affichage.
 * @throws {UnusableMaxHrSuggestionError} si la valeur rendrait le profil
 * incohérent (FC de repos supérieure ou égale).
 */
export async function acceptMaxHrSuggestion(bpm: number): Promise<void> {
  const { profile } = await requireCurrentSuggestion(bpm);

  // Le même contrôle croisé que le formulaire de profil : une FC de repos
  // au-dessus de la FC max rendrait la réserve cardiaque négative, et le TRIMP
  // de Karvonen sortirait des valeurs de signe inversé.
  if (profile.restingHrBpm !== null && profile.restingHrBpm >= bpm) {
    throw new UnusableMaxHrSuggestionError(
      'Ta FC de repos est supérieure ou égale à cette valeur : corrige-la d’abord.',
    );
  }

  await db
    .update(athlete)
    .set({ maxHrBpm: bpm, updatedAt: new Date() })
    .where(eq(athlete.id, profile.id));
}

/**
 * Écarte la proposition : plus rien d'égal ou de supérieur à `bpm` ne sera
 * reproposé.
 *
 * La valeur la plus haute **strictement inférieure**, elle, le sera — c'est
 * toute la différence entre un seuil et un simple « déjà vu », et c'est ce qui
 * permet d'écarter un artefact sans perdre la mesure réelle qu'il masquait.
 *
 * @throws {AthleteNotFoundError} sans athlète.
 * @throws {StaleMaxHrSuggestionError} si la proposition a changé depuis
 * l'affichage.
 */
export async function dismissMaxHrSuggestion(bpm: number): Promise<void> {
  const { profile } = await requireCurrentSuggestion(bpm);

  await db
    .update(athlete)
    .set({ maxHrSuggestionDismissedBpm: bpm, updatedAt: new Date() })
    .where(eq(athlete.id, profile.id));
}
