import 'server-only';

import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';

import { shiftCivilDate } from '@/lib/dates/civil';
import {
  RESTING_HR_WINDOW_DAYS,
  restingHrSuggestionBpm,
} from '@/lib/metrics/resting-hr';

import {
  ATHLETE_PROFILE_LIMITS,
  AthleteNotFoundError,
  getCurrentAthlete,
  todayCivilDate,
} from './athlete';
import { db } from './db/client';
import { athlete, wellnessDays, type Athlete } from './db/schema';

/**
 * Proposition de FC de repos — la lecture, et les deux réponses possibles.
 *
 * ## Le pendant de la FC max, avec ses différences physiologiques
 *
 * Même principe que `./max-hr-suggestion.ts` : l'application **propose**,
 * l'athlète tranche, rien ne s'applique tout seul. Deux choses changent, et
 * elles changent tout :
 *
 * 1. **La candidate est une médiane**, celle des {@link RESTING_HR_WINDOW_DAYS}
 *    derniers jours mesurés, jamais une valeur isolée. Une FC max se dépasse — le
 *    maximum observé *est* l'information ; une FC de repos se constate nuit après
 *    nuit, et la plus basse est presque toujours une anomalie de mesure.
 * 2. **Elle se propose dans les deux sens.** La FC de repos baisse quand la forme
 *    monte, remonte quand elle redescend : ne proposer qu'à la baisse laisserait
 *    une dérive s'installer sans un mot.
 *
 * Les seuils et la médiane vivent dans `src/lib/metrics/resting-hr.ts`, purs et
 * testés. Ce module ne fait que lire, comparer au profil, et écrire.
 *
 * ## Ce que ce n'est pas
 *
 * **Pas une table.** Comme la proposition de FC max, elle se déduit à la lecture
 * de ce qui est déjà en base : les journées de `wellness_days`, la FC de repos du
 * profil, et la dernière valeur refusée. Rien à créer, rien à périmer.
 *
 * ## Le refus
 *
 * `athlete.resting_hr_suggestion_dismissed_bpm` est **une valeur**, pas un
 * seuil : « j'ai déjà écarté 52 ». Tant que la médiane reste à moins de deux
 * battements de cette valeur, rien ne se repropose ; qu'elle s'en écarte, et la
 * proposition revient. Un seuil directionnel — la mécanique de la FC max —
 * n'aurait pas convenu : la valeur bouge dans les deux sens, et « tout ce qui est
 * au-dessous de 52 est écarté » aurait enterré toutes les vraies baisses.
 */

/** Ce que l'écran a besoin de savoir d'une proposition, et rien de plus. */
export type RestingHrSuggestionDto = {
  /** La médiane observée, en battements par minute. */
  bpm: number;
  /** Nuits mesurées dans la fenêtre — la carte source sa valeur, sinon elle se refuse. */
  measuredNights: number;
  /** FC de repos actuelle du profil, `null` s'il n'en porte pas encore. */
  profileBpm: number | null;
};

/**
 * La proposition affichée ne correspond plus à celle que le serveur calcule.
 *
 * Cas normal (un relevé bien-être est arrivé entre l'affichage et le clic, deux
 * onglets ouverts), pas une panne. C'est aussi ce qui rend inopérant un appel
 * direct à l'action avec une valeur choisie : la valeur écrite est toujours celle
 * que le serveur a calculée.
 */
export class StaleRestingHrSuggestionError extends Error {
  constructor() {
    super("Cette proposition de FC de repos n'est plus d'actualité.");
    this.name = 'StaleRestingHrSuggestionError';
  }
}

/**
 * Les FC de repos mesurées dans la fenêtre d'un athlète désigné.
 *
 * Seules les journées qui portent une mesure sont lues (`IS NOT NULL`) : une nuit
 * sans ceinture n'est pas une FC de repos de zéro, et la faire entrer dans la
 * médiane la ferait s'effondrer.
 */
async function listRecentRestingHr(athleteId: number, today: string): Promise<number[]> {
  const from = shiftCivilDate(today, -(RESTING_HR_WINDOW_DAYS - 1));

  const rows = await db
    .select({ restingHrBpm: wellnessDays.restingHrBpm })
    .from(wellnessDays)
    .where(
      and(
        eq(wellnessDays.athleteId, athleteId),
        gte(wellnessDays.day, from),
        lte(wellnessDays.day, today),
        isNotNull(wellnessDays.restingHrBpm),
      ),
    );

  const values: number[] = [];
  for (const row of rows) {
    // `isNotNull` filtre déjà en base ; le typage, lui, ne le sait pas.
    if (row.restingHrBpm === null) continue;
    values.push(row.restingHrBpm);
  }
  return values;
}

/**
 * La proposition d'un athlète **déjà lu**, `null` s'il n'y en a pas.
 *
 * Lecture primitive, comme `selectMaxHrSuggestion` : le tableau de bord tient
 * déjà la ligne du profil et n'a aucune raison de la relire ; les réglages
 * passent par {@link getRestingHrSuggestion}. Une seule logique, deux points
 * d'entrée — les deux écrans montrent forcément la même proposition.
 */
export async function selectRestingHrSuggestion(
  profile: Athlete,
  today: string = todayCivilDate(),
): Promise<RestingHrSuggestionDto | null> {
  const values = await listRecentRestingHr(profile.id, today);

  const bpm = restingHrSuggestionBpm({
    values,
    profileBpm: profile.restingHrBpm,
    maxHrBpm: profile.maxHrBpm,
    dismissedBpm: profile.restingHrSuggestionDismissedBpm,
    bounds: ATHLETE_PROFILE_LIMITS.restingHrBpm,
  });
  if (bpm === null) return null;

  return { bpm, measuredNights: values.length, profileBpm: profile.restingHrBpm };
}

/**
 * La proposition de l'athlète connecté, `null` s'il n'y en a pas — ou s'il n'y a
 * ni session ni athlète.
 */
export async function getRestingHrSuggestion(): Promise<RestingHrSuggestionDto | null> {
  const profile = await getCurrentAthlete();
  return profile === null ? null : selectRestingHrSuggestion(profile);
}

/*
 * Les deux réponses.
 */

/**
 * Relit la proposition courante et vérifie qu'elle vaut bien `bpm`.
 *
 * Le contrôle anti-rejeu de ces deux écritures : la valeur qui arrive du
 * navigateur ne sert qu'à confirmer qu'on parle de la même proposition, elle
 * n'est jamais celle qu'on écrit.
 */
async function requireCurrentSuggestion(bpm: number): Promise<Athlete> {
  const profile = await getCurrentAthlete();
  if (profile === null) throw new AthleteNotFoundError();

  const suggestion = await selectRestingHrSuggestion(profile);
  if (suggestion === null || suggestion.bpm !== bpm) throw new StaleRestingHrSuggestionError();

  return profile;
}

/**
 * Accepte la proposition : la FC de repos du profil devient la médiane observée.
 *
 * Tout ce qui en dépend — TRIMP de Karvonen, et donc CTL, ATL, TSB — se recalcule
 * à la lecture depuis le profil : il n'y a rien à réécrire dans l'historique.
 *
 * La valeur refusée n'est pas effacée : « 52, j'en veux pas » reste vrai après
 * avoir accepté 47, et la médiane devra de toute façon s'écarter du profil pour
 * qu'une nouvelle proposition ait lieu.
 *
 * Aucun contrôle croisé supplémentaire avec la FC max ici : la sélection ne
 * propose que des valeurs strictement inférieures à la FC max du profil (cf.
 * `restingHrSuggestionBpm`), et la proposition vient d'être relue juste
 * au-dessus — une réserve cardiaque négative est donc déjà impossible.
 *
 * @throws {AthleteNotFoundError} sans athlète.
 * @throws {StaleRestingHrSuggestionError} si la proposition a changé depuis
 * l'affichage.
 */
export async function acceptRestingHrSuggestion(bpm: number): Promise<void> {
  const profile = await requireCurrentSuggestion(bpm);

  await db
    .update(athlete)
    .set({ restingHrBpm: bpm, updatedAt: new Date() })
    .where(eq(athlete.id, profile.id));
}

/**
 * Écarte la proposition : cette valeur-là ne sera plus proposée tant que la
 * médiane ne s'en éloignera pas.
 *
 * @throws {AthleteNotFoundError} sans athlète.
 * @throws {StaleRestingHrSuggestionError} si la proposition a changé depuis
 * l'affichage.
 */
export async function dismissRestingHrSuggestion(bpm: number): Promise<void> {
  const profile = await requireCurrentSuggestion(bpm);

  await db
    .update(athlete)
    .set({ restingHrSuggestionDismissedBpm: bpm, updatedAt: new Date() })
    .where(eq(athlete.id, profile.id));
}
