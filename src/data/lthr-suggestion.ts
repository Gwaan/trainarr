import 'server-only';

import { and, eq, gte, isNotNull } from 'drizzle-orm';

import { sessionPaceZone } from '@/lib/ai/plan-schema';
import { fastestSegmentWindow } from '@/lib/metrics/best-segments';
import {
  LTHR_WINDOW_DAYS,
  blockPlateauHrBpm,
  lthrSuggestion,
  timeTrialLthrBpm,
  type LthrCandidate,
} from '@/lib/metrics/lthr';
import { FITNESS_TEST_EFFORT_M } from '@/lib/plan-skeleton';
import { longestEffortDistanceM } from '@/lib/plan-steps/threshold-block';

import { AthleteNotFoundError, getCurrentAthlete } from './athlete';
import { db } from './db/client';
import { activities, activityStreams, athlete, plannedSessions, type Athlete } from './db/schema';
import { numberSeries } from './db/streams';

/**
 * Proposition de **FC seuil** (LTHR) : la mesurer séance après séance, la
 * proposer, et l'écrire quand l'athlète l'accepte.
 *
 * ## Le même motif que la FC max et la FC de repos
 *
 * L'application **propose**, l'athlète tranche, rien ne s'applique tout seul
 * (`./max-hr-suggestion.ts`, `./resting-hr-suggestion.ts`). Ce qui change ici,
 * c'est la **portée** de l'acceptation : la FC seuil ne corrige pas une valeur
 * de profil parmi d'autres, elle **change l'ancrage des zones cardiaques** — de
 * « pourcentage de FC max » à « pourcentage de seuil » (cf.
 * `lib/metrics/hr-zones.ts`). C'est une rupture, et la carte l'annonce comme
 * telle.
 *
 * ## Deux sources, une candidate
 *
 * Chaque séance peut laisser une mesure sur sa propre ligne
 * (`activities.lthr_sample_bpm`), et il y a deux façons d'en produire une :
 *
 * 1. **les blocs de seuil prescrits** ({@link recordThresholdBlockLthr}), écrits
 *    au rapprochement de l'activité à la séance planifiée qu'elle réalise ;
 * 2. **le test chronométré** ({@link recordTimeTrialLthr}), écrit par le service
 *    de test une fois l'effort vérifié maximal.
 *
 * La candidate est la **médiane** des premières dès qu'il y en a assez, le test
 * en source d'amorçage — l'arbitrage et ses raisons vivent dans
 * `lib/metrics/lthr.ts`, pur et testé. Ce module ne fait que lire, comparer au
 * profil, et écrire.
 *
 * ## Ce que ce n'est pas
 *
 * **Pas une table de propositions.** Comme ses deux aînées, la proposition se
 * déduit à la lecture de ce qui est déjà en base : les mesures des séances, la
 * FC seuil du profil, et la dernière valeur refusée. Rien à créer, rien à
 * périmer.
 *
 * ## Cloisonnement
 *
 * Les écritures de mesure tournent **hors requête** (watcher FIT, service de
 * test) et reçoivent donc leur athlète en paramètre ; les lectures d'écran le
 * résolvent depuis la session.
 */

/** Ce que l'écran a besoin de savoir d'une proposition, et rien de plus. */
export type LthrSuggestionDto = LthrCandidate & {
  /** FC seuil actuelle du profil, `null` s'il n'en porte pas encore. */
  profileBpm: number | null;
};

/**
 * La proposition affichée ne correspond plus à celle que le serveur calcule.
 *
 * Cas normal (une séance de seuil est arrivée entre l'affichage et le clic, deux
 * onglets ouverts), pas une panne. C'est aussi ce qui rend inopérant un appel
 * direct à l'action avec une valeur choisie : la valeur écrite est toujours
 * celle que le serveur a calculée.
 */
export class StaleLthrSuggestionError extends Error {
  constructor() {
    super("Cette proposition de FC seuil n'est plus d'actualité.");
    this.name = 'StaleLthrSuggestionError';
  }
}

/*
 * Les mesures — écritures du pipeline d'import.
 */

/** Les trois canaux dont dépend une mesure de seuil, `null` quand l'un manque. */
type ActivitySeries = {
  distance: (number | null)[];
  time: (number | null)[];
  heartrate: (number | null)[];
};

/**
 * Les séries d'une activité **de cet athlète**, `null` dès qu'un canal
 * nécessaire manque.
 *
 * La jointure porte l'appartenance : une activité d'un autre compte ne rend
 * aucune ligne, et le cas ne se distingue pas d'une activité sans séries — c'est
 * voulu.
 */
async function readSeries(activityId: number, athleteId: number): Promise<ActivitySeries | null> {
  const rows = await db
    .select({ type: activityStreams.type, data: activityStreams.data })
    .from(activityStreams)
    .innerJoin(
      activities,
      and(eq(activities.id, activityStreams.activityId), eq(activities.athleteId, athleteId)),
    )
    .where(eq(activityStreams.activityId, activityId));

  const distance = numberSeries(rows, 'distance');
  const time = numberSeries(rows, 'time');
  const heartrate = numberSeries(rows, 'heartrate');
  if (distance === null || time === null || heartrate === null) return null;

  return { distance, time, heartrate };
}

/**
 * Écrit — ou efface — la mesure d'une source sur une activité.
 *
 * **Une source n'efface que la sienne.** Le rapprochement au plan et le service
 * de test passent tous les deux ici, à des moments différents et parfois sur la
 * même activité ; un effacement inconditionnel ferait qu'un réimport, en
 * rejouant le rapprochement, supprimerait la mesure que le test avait écrite.
 * D'où le `WHERE` sur la source dans le cas de l'effacement — et l'absence
 * d'erreur quand aucune ligne n'est touchée : « rien à effacer » est le cas
 * normal.
 */
async function writeSample(
  activityId: number,
  athleteId: number,
  source: 'threshold-blocks' | 'time-trial',
  bpm: number | null,
): Promise<void> {
  const owned = and(eq(activities.id, activityId), eq(activities.athleteId, athleteId));

  if (bpm === null) {
    await db
      .update(activities)
      .set({ lthrSampleBpm: null, lthrSampleSource: null })
      .where(and(owned, eq(activities.lthrSampleSource, source)));
    return;
  }

  await db
    .update(activities)
    .set({ lthrSampleBpm: bpm, lthrSampleSource: source })
    .where(owned);
}

/**
 * Relève ce que cette activité dit du seuil, **si** elle réalise une séance de
 * seuil planifiée.
 *
 * Appelée après le rapprochement au plan, à chaque import : c'est le
 * rapprochement qui sait qu'une séance de seuil a été courue, et lui seul.
 *
 * Trois refus silencieux, tous normaux — l'immense majorité des imports ne
 * mesure aucun seuil :
 *
 * - l'activité n'est rapprochée d'aucune séance planifiée, ou la séance n'est
 *   pas une séance de seuil (`sessionPaceZone`, la même lecture du `kind` que le
 *   reste du projet) ;
 * - la séance n'a pas de déroulé structuré, ou aucun effort mesuré en distance ;
 * - la trace ne permet pas de mesurer un plateau : pas de FC, bloc trop court
 *   une fois couru, couverture insuffisante (cf. `lib/metrics/lthr.ts`).
 *
 * **L'emplacement du bloc est déduit, pas lu** : un fichier FIT ne dit pas où
 * commence une répétition. On retient la portion la plus rapide de la longueur
 * prescrite (`fastestSegmentWindow`), qui sur une séance courue comme prescrit
 * **est** une répétition — et on n'en mesure que la seconde moitié, la première
 * n'étant qu'une montée en régime cardiaque.
 */
export async function recordThresholdBlockLthr(
  activityId: number,
  athleteId: number,
): Promise<void> {
  const sessions = await db
    .select({ kind: plannedSessions.kind, steps: plannedSessions.steps })
    .from(plannedSessions)
    .where(
      and(
        eq(plannedSessions.completedActivityId, activityId),
        eq(plannedSessions.athleteId, athleteId),
      ),
    )
    .limit(1);

  const session = sessions[0];
  if (session === undefined) return;
  if (sessionPaceZone(session.kind) !== 'threshold') return;
  if (session.steps === null) return;

  const blockM = longestEffortDistanceM(session.steps);
  if (blockM === null) return;

  const series = await readSeries(activityId, athleteId);
  if (series === null) {
    await writeSample(activityId, athleteId, 'threshold-blocks', null);
    return;
  }

  const window = fastestSegmentWindow(series.distance, series.time, blockM);
  const bpm =
    window === null ? null : blockPlateauHrBpm(series.heartrate, series.time, window);

  await writeSample(activityId, athleteId, 'threshold-blocks', bpm);
}

/**
 * Relève ce que le **test chronométré** dit du seuil : la FC moyenne des 20
 * dernières minutes de l'effort (protocole Friel, cf. `lib/metrics/lthr.ts`).
 *
 * Appelée par le service de test **une fois l'effort vérifié maximal** — c'est
 * cette vérification (≥ 95 % de la FC max du profil) qui distingue un
 * contre-la-montre d'une séance quelconque, et sans elle la FC relevée ne serait
 * celle d'aucun seuil.
 *
 * L'effort est isolé exactement comme le chrono l'a été : la fenêtre la plus
 * rapide de {@link FITNESS_TEST_EFFORT_M} mètres.
 */
export async function recordTimeTrialLthr(activityId: number, athleteId: number): Promise<void> {
  const series = await readSeries(activityId, athleteId);
  if (series === null) {
    await writeSample(activityId, athleteId, 'time-trial', null);
    return;
  }

  const window = fastestSegmentWindow(series.distance, series.time, FITNESS_TEST_EFFORT_M);
  const bpm =
    window === null ? null : timeTrialLthrBpm(series.heartrate, series.time, window);

  await writeSample(activityId, athleteId, 'time-trial', bpm);
}

/*
 * Lecture.
 */

const DAY_MS = 86_400_000;

/**
 * Les mesures de seuil de la fenêtre, séparées par source.
 *
 * Le test retenu est le **plus récent** : contrairement aux blocs, il ne se
 * moyenne pas — c'est une mesure ponctuelle, et la plus récente est la seule qui
 * décrive l'athlète d'aujourd'hui.
 */
async function readSamples(
  athleteId: number,
  now: Date,
): Promise<{ blockValues: number[]; timeTrialBpm: number | null }> {
  const rows = await db
    .select({
      bpm: activities.lthrSampleBpm,
      source: activities.lthrSampleSource,
      startedAt: activities.startedAt,
    })
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        isNotNull(activities.lthrSampleBpm),
        gte(activities.startedAt, new Date(now.getTime() - LTHR_WINDOW_DAYS * DAY_MS)),
      ),
    );

  const blockValues: number[] = [];
  let latestTrial: { bpm: number; startedAt: Date } | null = null;

  for (const row of rows) {
    // `isNotNull` filtre déjà en base ; le typage, lui, ne le sait pas.
    if (row.bpm === null) continue;

    if (row.source === 'threshold-blocks') {
      blockValues.push(row.bpm);
      continue;
    }
    if (row.source === 'time-trial') {
      if (latestTrial === null || row.startedAt > latestTrial.startedAt) {
        latestTrial = { bpm: row.bpm, startedAt: row.startedAt };
      }
    }
  }

  return { blockValues, timeTrialBpm: latestTrial?.bpm ?? null };
}

/**
 * La proposition d'un athlète **déjà lu**, `null` s'il n'y en a pas.
 *
 * Lecture primitive, comme `selectMaxHrSuggestion` : le tableau de bord tient
 * déjà la ligne du profil et n'a aucune raison de la relire ; les réglages
 * passent par {@link getLthrSuggestion}. Une seule logique, deux points
 * d'entrée — les deux écrans montrent forcément la même proposition.
 */
export async function selectLthrSuggestion(
  profile: Athlete,
  now: Date = new Date(),
): Promise<LthrSuggestionDto | null> {
  const { blockValues, timeTrialBpm } = await readSamples(profile.id, now);

  const candidate = lthrSuggestion({
    blockValues,
    timeTrialBpm,
    profileBpm: profile.lthrBpm,
    maxHrBpm: profile.maxHrBpm,
    dismissedBpm: profile.lthrSuggestionDismissedBpm,
  });
  if (candidate === null) return null;

  return { ...candidate, profileBpm: profile.lthrBpm };
}

/**
 * La proposition de l'athlète connecté, `null` s'il n'y en a pas — ou s'il n'y a
 * ni session ni athlète.
 */
export async function getLthrSuggestion(): Promise<LthrSuggestionDto | null> {
  const profile = await getCurrentAthlete();
  return profile === null ? null : selectLthrSuggestion(profile);
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

  const suggestion = await selectLthrSuggestion(profile);
  if (suggestion === null || suggestion.bpm !== bpm) throw new StaleLthrSuggestionError();

  return profile;
}

/**
 * Accepte la proposition : la FC seuil du profil devient la valeur mesurée, et
 * **les zones cardiaques changent d'ancrage**.
 *
 * Rien n'est réécrit dans l'historique — comme pour la FC max et la FC de repos,
 * tout ce qui dépend des zones se recalcule à la lecture depuis le profil. La
 * conséquence est donc immédiate et rétroactive : les répartitions passées se
 * relisent dans le cadre du seuil.
 *
 * La valeur refusée n'est pas effacée : « 168, j'en veux pas » reste vrai après
 * avoir accepté 172, et la candidate devra de toute façon s'écarter du profil
 * pour qu'une nouvelle proposition ait lieu.
 *
 * Aucun contrôle croisé supplémentaire avec la FC max : la sélection ne propose
 * que des valeurs strictement inférieures à la FC max du profil (cf.
 * `lthrSuggestion`), et la proposition vient d'être relue juste au-dessus.
 *
 * @throws {AthleteNotFoundError} sans athlète.
 * @throws {StaleLthrSuggestionError} si la proposition a changé depuis
 * l'affichage.
 */
export async function acceptLthrSuggestion(bpm: number): Promise<void> {
  const profile = await requireCurrentSuggestion(bpm);

  await db
    .update(athlete)
    .set({ lthrBpm: bpm, updatedAt: new Date() })
    .where(eq(athlete.id, profile.id));
}

/**
 * Écarte la proposition : cette valeur-là ne sera plus proposée tant que la
 * mesure ne s'en éloignera pas.
 *
 * @throws {AthleteNotFoundError} sans athlète.
 * @throws {StaleLthrSuggestionError} si la proposition a changé depuis
 * l'affichage.
 */
export async function dismissLthrSuggestion(bpm: number): Promise<void> {
  const profile = await requireCurrentSuggestion(bpm);

  await db
    .update(athlete)
    .set({ lthrSuggestionDismissedBpm: bpm, updatedAt: new Date() })
    .where(eq(athlete.id, profile.id));
}
