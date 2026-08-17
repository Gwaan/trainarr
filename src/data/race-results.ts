import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';

import { isCivilDate } from '@/lib/dates/civil';

import { getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import { activities, raceResults } from './db/schema';

/**
 * Les **courses déclarées** — lecture, écriture, suppression.
 *
 * Une course est une déclaration de l'athlète : une distance officielle, un
 * chrono officiel, une date, éventuellement un nom d'épreuve, éventuellement la
 * séance qui l'a enregistrée. Elle sert deux choses, dans cet ordre
 * d'importance décroissante pour le code et croissante pour l'usage :
 *
 *  1. **calibrer le facteur correctif de la VO₂max effective**
 *     (`lib/metrics/vo2max-correction.ts`, consommé par `./vo2max-correction`) ;
 *  2. exister — un historique de courses n'était nulle part dans l'application.
 *
 * ## Ce que la déclaration ne recopie pas
 *
 * `distance_m` et `time_s` sont **saisis**, pré-remplis depuis l'activité mais
 * jamais réécrits depuis elle : le chrono officiel est celui de la puce, la
 * distance celle du parcours homologué. C'est aussi ce couple qui fait foi pour
 * le calcul (cf. l'en-tête de la table dans `./db/schema`).
 *
 * De l'activité liée ne viennent que **la FC moyenne et le dénivelé**, lus à
 * chaque lecture — jamais copiés. C'est la règle générale du dépôt : ce qui
 * dépend d'une mesure se recalcule, ce qui est saisi se garde.
 *
 * ## Cloisonnement
 *
 * Toute lecture et toute écriture sont bornées par l'athlète de la session.
 * L'identifiant d'une course comme celui d'une activité viennent du client :
 * ils ne prouvent rien, et chaque appel les confronte à l'athlète avant de
 * toucher quoi que ce soit. Un refus ne dit jamais si la ressource existe.
 */

/**
 * Une course, telle que les écrans la lisent.
 *
 * Les trois dernières lignes ne sont pas des colonnes de `race_results` : elles
 * viennent de l'activité liée, par jointure, et valent `null` quand il n'y en a
 * pas. Elles sont là parce que la calibration en dépend et qu'un second aller
 * en base pour les chercher n'apporterait rien.
 */
export type RaceResultDto = {
  id: number;
  /** Jour civil `YYYY-MM-DD`. */
  racedOn: string;
  /** Nom de l'épreuve, `null` si l'athlète n'en a pas donné. */
  name: string | null;
  /** Distance officielle, en mètres. */
  distanceM: number;
  /** Chrono officiel, en secondes. */
  timeS: number;
  /** La séance qui l'a enregistrée, `null` si la course a été courue sans montre. */
  activityId: number | null;
  /** FC moyenne de la séance liée. `null` = la course ne calibre pas. */
  avgHrBpm: number | null;
  /** Dénivelé de la séance liée — `null` = inconnu, jamais « plat ». */
  elevationGainM: number | null;
  elevationLossM: number | null;
};

/** Ce que le formulaire de déclaration soumet. */
export type RaceResultInput = {
  /** Jour civil `YYYY-MM-DD`. */
  racedOn: string;
  name: string | null;
  distanceM: number;
  timeS: number;
  /** L'activité d'où part la déclaration, `null` pour une course sans montre. */
  activityId: number | null;
};

/**
 * Bornes de la saisie.
 *
 * Source unique : la Server Action construit son schéma Zod dessus, et le DAL
 * les re-vérifie — une action n'est pas la seule porte d'entrée possible.
 *
 * Elles ne jugent **pas** la performance, seulement le fait que la saisie
 * décrive une course à pied : la crédibilité de ce que la course implique pour
 * la VO₂max est tranchée bien plus loin, par les bornes du facteur correctif
 * (`lib/metrics/vo2max-correction.ts`). D'où leur largeur assumée — 400 m est la
 * plus courte distance de référence du dépôt, 500 km couvre les formats les
 * plus longs, 48 h le temps qu'on y passe.
 *
 * La vitesse moyenne est bornée en plus, parce que ni la distance ni le temps
 * pris isolément n'attrapent un 400 m saisi en 40 heures. 0,4 m/s, c'est
 * 41 min/km — plus lent que la marche, donc plus lent que le dernier finisher
 * d'un 100 miles ; 12 m/s dépasse tout record du monde, sprint compris.
 */
export const RACE_RESULT_LIMITS = {
  distanceM: { min: 400, max: 500_000 },
  timeS: { min: 30, max: 48 * 3_600 },
  speedMPerS: { min: 0.4, max: 12 },
  nameMaxChars: 120,
} as const;

/** Champs du formulaire, dans l'ordre où la validation les regarde. */
export type RaceResultField = 'racedOn' | 'distanceM' | 'timeS' | 'name';

/** Une valeur de la course est hors bornes. `field` désigne le champ fautif. */
export class InvalidRaceResultError extends Error {
  constructor(
    readonly field: RaceResultField,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidRaceResultError';
  }
}

/**
 * L'activité visée n'existe pas, ou n'appartient pas à l'athlète.
 *
 * Un seul message pour les deux cas : dire « elle existe mais elle n'est pas à
 * toi » renseignerait sur le contenu du compte d'un autre.
 */
export class RaceActivityNotFoundError extends Error {
  constructor() {
    super("Cette séance n'existe pas.");
    this.name = 'RaceActivityNotFoundError';
  }
}

/**
 * L'écriture s'est exécutée sans toucher aucune ligne.
 *
 * Le cas est étroit et il n'est pas impossible : le `DO UPDATE` de
 * {@link saveRaceResult} est reborné à l'athlète de la session, et une ligne en
 * conflit qui n'y répondrait pas laisserait l'instruction sans effet — un
 * `INSERT … ON CONFLICT DO UPDATE … WHERE` qui ne matche pas ne lève pas, il ne
 * fait rien. Annoncer « Course enregistrée » sur une écriture qui n'a rien écrit
 * serait le pire des deux mondes : l'athlète repartirait convaincue que sa
 * déclaration calibre sa VO₂max.
 */
export class RaceResultNotSavedError extends Error {
  constructor() {
    super("La course n'a pas été enregistrée.");
    this.name = 'RaceResultNotSavedError';
  }
}

/**
 * Vérifie la saisie et rend la course normalisée. Pure, exportée pour les tests.
 *
 * @throws {InvalidRaceResultError} au premier défaut.
 */
export function validateRaceResult(input: RaceResultInput): RaceResultInput {
  if (!isCivilDate(input.racedOn)) {
    throw new InvalidRaceResultError('racedOn', 'Date de la course attendue au format AAAA-MM-JJ.');
  }

  const distanceM = Math.round(input.distanceM);
  const { distanceM: distanceBounds, timeS: timeBounds, speedMPerS } = RACE_RESULT_LIMITS;
  if (
    !Number.isFinite(distanceM) ||
    distanceM < distanceBounds.min ||
    distanceM > distanceBounds.max
  ) {
    throw new InvalidRaceResultError(
      'distanceM',
      `Distance attendue entre ${distanceBounds.min / 1_000} et ${distanceBounds.max / 1_000} km.`,
    );
  }

  const timeS = Math.round(input.timeS);
  if (!Number.isFinite(timeS) || timeS < timeBounds.min || timeS > timeBounds.max) {
    throw new InvalidRaceResultError(
      'timeS',
      'Chrono attendu entre 30 secondes et 48 heures.',
    );
  }

  const speed = distanceM / timeS;
  if (speed < speedMPerS.min || speed > speedMPerS.max) {
    throw new InvalidRaceResultError(
      'timeS',
      'Ce couple distance / chrono ne décrit pas une course — vérifie les deux valeurs.',
    );
  }

  const name = input.name === null ? null : input.name.trim();
  if (name !== null && name.length > RACE_RESULT_LIMITS.nameMaxChars) {
    throw new InvalidRaceResultError(
      'name',
      `Nom de l'épreuve trop long (${RACE_RESULT_LIMITS.nameMaxChars} caractères au plus).`,
    );
  }

  return {
    racedOn: input.racedOn,
    // Un nom vidé est une absence de nom, pas une chaîne vide : la colonne est
    // nullable, et deux façons de dire « rien » finiraient par s'afficher
    // différemment.
    name: name === null || name === '' ? null : name,
    distanceM,
    timeS,
    activityId: input.activityId,
  };
}

/** Les colonnes que toute lecture rend — la course, plus ce que la séance apporte. */
const RACE_RESULT_COLUMNS = {
  id: raceResults.id,
  racedOn: raceResults.racedOn,
  name: raceResults.name,
  distanceM: raceResults.distanceM,
  timeS: raceResults.timeS,
  activityId: raceResults.activityId,
  avgHrBpm: activities.avgHrBpm,
  elevationGainM: activities.elevationGainM,
  elevationLossM: activities.elevationLossM,
} as const;

/**
 * Les courses d'un athlète, **de la plus récente à la plus ancienne**.
 *
 * Il n'y a pas de lecture dédiée à « la plus récente » : c'est la première ligne
 * de celle-ci, et l'index `race_results_athlete_raced_on_idx` la sert dans le
 * même parcours. Une requête de plus n'aurait fait que dupliquer un tri.
 *
 * Reçoit son athlète en paramètre : le calcul du facteur correctif l'appelle
 * depuis un service qui l'a déjà résolu.
 *
 * `LEFT JOIN` — une course sans activité reste une course. La condition
 * d'appartenance est **portée par la jointure** plutôt que supposée : une ligne
 * qui pointerait vers l'activité d'un autre (impossible à créer par les
 * écritures ci-dessous, mais on ne le suppose pas) rendrait `null` sur la FC
 * plutôt que de la lire.
 */
export async function listRaceResults(athleteId: number): Promise<RaceResultDto[]> {
  return db
    .select(RACE_RESULT_COLUMNS)
    .from(raceResults)
    .leftJoin(
      activities,
      and(eq(activities.id, raceResults.activityId), eq(activities.athleteId, athleteId)),
    )
    .where(eq(raceResults.athleteId, athleteId))
    // `id` en second critère : deux courses le même jour (un cross le matin,
    // une course sur route l'après-midi) doivent sortir dans un ordre stable.
    .orderBy(desc(raceResults.racedOn), desc(raceResults.id));
}

/**
 * La course déclarée sur une activité, `null` s'il n'y en a pas — ou si
 * l'activité n'est pas celle de l'athlète (même réponse dans les deux cas).
 */
export async function getRaceResultForActivity(
  activityId: number,
): Promise<RaceResultDto | null> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return null;

  const rows = await db
    .select(RACE_RESULT_COLUMNS)
    .from(raceResults)
    .leftJoin(
      activities,
      and(eq(activities.id, raceResults.activityId), eq(activities.athleteId, athleteId)),
    )
    .where(
      and(eq(raceResults.activityId, activityId), eq(raceResults.athleteId, athleteId)),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Déclare une course — ou corrige celle qui est déjà déclarée sur la même
 * activité.
 *
 * `ON CONFLICT (activity_id)` : l'index unique du schéma fait de la déclaration
 * depuis une séance un geste **idempotent**, et c'est lui qui porte la garantie
 * — pas une lecture préalable, qui laisserait passer deux soumissions
 * concurrentes. Deux courses sans activité, elles, ne se collisionnent pas
 * (plusieurs `NULL` sont permis dans un index unique) : rien ne distingue deux
 * épreuves courues sans montre, et rien ne doit donc les fusionner.
 *
 * La clause `WHERE` du `DO UPDATE` reborne l'écriture à l'athlète de la session.
 * Elle est théoriquement redondante — la ligne en conflit pointe sur une
 * activité dont l'appartenance vient d'être vérifiée — mais un anti-IDOR qui
 * repose sur un raisonnement à deux étapes n'en est pas un.
 *
 * **Et une défense qui refuse doit se voir.** Quand ce `WHERE` exclut la ligne
 * en conflit, Postgres ne lève pas : l'instruction s'exécute et n'écrit rien.
 * D'où le `returning()`, dont le vide vaut échec — sans lui, l'action renvoyait
 * « Course enregistrée » sur une déclaration qui n'existe pas.
 *
 * @throws {InvalidRaceResultError} si la saisie est hors bornes.
 * @throws {RaceActivityNotFoundError} si l'activité n'est pas celle de l'athlète.
 * @throws {RaceResultNotSavedError} si l'écriture n'a touché aucune ligne.
 */
export async function saveRaceResult(input: RaceResultInput): Promise<void> {
  const race = validateRaceResult(input);

  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new RaceActivityNotFoundError();

  if (race.activityId !== null) {
    const owned = await db
      .select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.id, race.activityId), eq(activities.athleteId, athleteId)))
      .limit(1);

    if (owned.length === 0) throw new RaceActivityNotFoundError();
  }

  const written = await db
    .insert(raceResults)
    .values({
      athleteId,
      racedOn: race.racedOn,
      name: race.name,
      distanceM: race.distanceM,
      timeS: race.timeS,
      activityId: race.activityId,
    })
    .onConflictDoUpdate({
      target: raceResults.activityId,
      where: eq(raceResults.athleteId, athleteId),
      set: {
        racedOn: sql`excluded.raced_on`,
        name: sql`excluded.name`,
        distanceM: sql`excluded.distance_m`,
        timeS: sql`excluded.time_s`,
        updatedAt: new Date(),
      },
    })
    // La seule preuve qu'une ligne a bougé : un `DO UPDATE` dont le `WHERE`
    // exclut la ligne en conflit s'exécute sans rien écrire, et sans lever.
    .returning({ id: raceResults.id });

  if (written.length === 0) throw new RaceResultNotSavedError();
}

/**
 * Retire une course.
 *
 * Silencieux : un identifiant qui n'existe pas et un identifiant qui appartient
 * à quelqu'un d'autre produisent le même résultat, sans rien dire de l'un ni de
 * l'autre. C'est la clause `WHERE` qui porte le cloisonnement.
 */
export async function deleteRaceResult(id: number): Promise<void> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return;

  await db
    .delete(raceResults)
    .where(and(eq(raceResults.id, id), eq(raceResults.athleteId, athleteId)));
}
