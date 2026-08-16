import { describe, expect, it } from 'vitest';

import type { AnalyzedActivityDto } from '@/data/activities';
import type { PlannedSessionDto } from '@/data/dashboard';
import type { DailyForecast } from '@/lib/weather/forecast-plan';

import {
  activityAnalyzedPayload,
  dailySessionPayload,
  SUGGESTION_KINDS,
  suggestionsPayload,
  type SuggestionNotice,
} from './messages';

/**
 * Ce que disent les bannières — et surtout ce qu'elles ne disent pas.
 *
 * Quatre propriétés, et elles ne se déduisent pas les unes des autres :
 *
 * 1. **rien n'est inventé** : une mesure absente est une phrase en moins, jamais
 *    un tiret, jamais une valeur par défaut, jamais une « fenêtre sèche »
 *    déduite d'un cumul de journée ;
 * 2. **le libellé dit ce que la mesure est** : le cumul de pluie est annoncé
 *    comme un cumul de journée, pas comme la pluie pendant la séance ;
 * 3. **le titre ne promet que ce qui existe** : l'analyse est prête à
 *    l'ingestion, le verdict du coach non ;
 * 4. **la clé de déduplication porte le genre**, ni la valeur ni la date — une
 *    proposition en attente ne renotifie jamais, pas même quand sa médiane
 *    glissante dérive d'un battement.
 */

const SESSION: PlannedSessionDto = {
  id: 7,
  scheduledOn: '2026-08-16',
  kind: 'VMA courte · piste',
  title: '6 × 800 m',
  targetPaceSecPerKm: 245,
  warmup: '20 min footing',
  recovery: '2 min trot',
  cooldown: '10 min souple',
  volumeM: 9_600,
  durationS: 3_600,
  completed: false,
};

const FORECAST: DailyForecast = {
  date: '2026-08-16',
  weatherCode: 3,
  temperatureMaxC: 25,
  temperatureMinC: 14,
  apparentTemperatureMaxC: 27,
  apparentTemperatureMinC: 13,
  precipitationSumMm: 0.9,
  precipitationProbabilityMaxPct: 62,
  windSpeedMaxKmh: 13,
};

/** Une prévision dont il ne reste rien : toutes les mesures ont manqué. */
const EMPTY_FORECAST: DailyForecast = {
  date: '2026-08-16',
  weatherCode: null,
  temperatureMaxC: null,
  temperatureMinC: null,
  apparentTemperatureMaxC: null,
  apparentTemperatureMinC: null,
  precipitationSumMm: null,
  precipitationProbabilityMaxPct: null,
  windSpeedMaxKmh: null,
};

const ACTIVITY: AnalyzedActivityDto = {
  id: 42,
  name: 'Footing du matin',
  startedAt: new Date('2026-08-16T05:30:00.000Z'),
  distanceM: 10_200,
  movingTimeS: 2_910,
  avgPaceSecPerKm: 285,
  plannedSession: null,
};

describe('dailySessionPayload', () => {
  it('ouvre le tableau de bord et se remplace d’un jour à l’autre', () => {
    const payload = dailySessionPayload(SESSION, FORECAST);

    expect(payload.url).toBe('/');
    // Même `tag` : sept jours d'absence ne laissent pas sept bannières.
    expect(payload.tag).toBe('daily-session');
  });

  it('annonce la séance dans le titre, ses chiffres et sa météo dans le corps', () => {
    const payload = dailySessionPayload(SESSION, FORECAST);

    expect(payload.title).toBe('Séance du jour : 6 × 800 m');
    expect(payload.body).toBe(
      'VMA courte · piste — @ 4:05/km · 9,6 km · 1 h 00\n' +
        'Couvert · 14 → 25 °C · vent max 13 km/h · pluie du jour 0,9 mm (62 %)',
    );
  });

  /*
   * La règle du projet, appliquée à la lettre : « pluie du jour » est un cumul
   * de journée civile, pas la pluie pendant la séance. Une séance planifiée
   * porte une date, jamais une heure — il n'existe aucune « fenêtre sèche » à
   * annoncer, et ce module n'en fabrique pas.
   */
  it('nomme le cumul de pluie comme un cumul de journée', () => {
    expect(dailySessionPayload(SESSION, FORECAST).body).toContain('pluie du jour');
    expect(dailySessionPayload(SESSION, FORECAST).body).not.toContain('fenêtre');
  });

  it('omet les chiffres que la séance ne porte pas', () => {
    const bare: PlannedSessionDto = {
      ...SESSION,
      targetPaceSecPerKm: null,
      volumeM: null,
      durationS: null,
    };

    // Ni tiret, ni « — » orphelin : le type seul, puis la météo.
    expect(dailySessionPayload(bare, FORECAST).body.split('\n')[0]).toBe('VMA courte · piste');
  });

  it('omet chaque mesure météo absente sans en inventer aucune', () => {
    const windOnly: DailyForecast = { ...EMPTY_FORECAST, windSpeedMaxKmh: 32 };

    expect(dailySessionPayload(SESSION, windOnly).body).toBe(
      'VMA courte · piste — @ 4:05/km · 9,6 km · 1 h 00\nvent max 32 km/h',
    );
  });

  /*
   * Pas de phrase d'absence sur un écran verrouillé : « prévisions pas encore
   * relevées » n'aide personne à s'habiller, alors que l'écran que la bannière
   * ouvre, lui, l'explique.
   */
  it('ne dit rien de la météo quand il n’y en a aucune', () => {
    expect(dailySessionPayload(SESSION, null).body).toBe(
      'VMA courte · piste — @ 4:05/km · 9,6 km · 1 h 00',
    );
    expect(dailySessionPayload(SESSION, EMPTY_FORECAST).body).toBe(
      'VMA courte · piste — @ 4:05/km · 9,6 km · 1 h 00',
    );
  });
});

describe('activityAnalyzedPayload', () => {
  it('mène à la séance et porte son propre tag', () => {
    const payload = activityAnalyzedPayload(ACTIVITY);

    expect(payload.url).toBe('/activities/42');
    expect(payload.tag).toBe('activity-42');
  });

  /*
   * Le point de vigilance de ce déclencheur : la relecture du plan par le coach
   * part **sans être attendue** et dure des minutes. Promettre un verdict ferait
   * ouvrir un écran qui n'a rien de plus à montrer.
   */
  it('parle de l’analyse, jamais de l’avis du coach', () => {
    const payload = activityAnalyzedPayload(ACTIVITY);

    expect(payload.title).toBe('Séance analysée : Footing du matin');
    expect(`${payload.title} ${payload.body}`.toLowerCase()).not.toContain('coach');
  });

  it('donne ce qui est calculé à l’ingestion', () => {
    expect(activityAnalyzedPayload(ACTIVITY).body).toBe('10,2 km · 49 min · 4:45/km');
  });

  it('nomme la séance du plan quand le rapprochement a eu lieu', () => {
    const linked: AnalyzedActivityDto = {
      ...ACTIVITY,
      plannedSession: { kind: 'VMA courte · piste', title: '6 × 800 m' },
    };

    expect(activityAnalyzedPayload(linked).body).toBe(
      '10,2 km · 49 min · 4:45/km\nSéance du plan : VMA courte · piste — 6 × 800 m',
    );
  });

  it('n’annonce pas une distance là où il n’y en a pas', () => {
    const indoor: AnalyzedActivityDto = {
      ...ACTIVITY,
      distanceM: 0,
      avgPaceSecPerKm: null,
    };

    expect(activityAnalyzedPayload(indoor).body).toBe('49 min');
  });
});

describe('SUGGESTION_KINDS', () => {
  /*
   * La propriété centrale de cette catégorie : la clé de déduplication est le
   * **genre**, et rien d'autre. Une proposition qui reste en attente est réclamée
   * une fois et ne renotifie jamais — pas même quand sa médiane glissante dérive
   * d'un battement (14 jours de fenêtre pour la FC de repos, 90 pour la FC
   * seuil) ; c'est sa disparition qui rend la clé, et donc la réapparition d'un
   * genre qui vaut information. Le test de la mécanique complète vit dans
   * `./notices.test.ts`, qui seul voit les réclamations.
   */
  it('énumère les quatre genres, sans recouvrement ni doublon', () => {
    // L'ordre est celui des cartes du tableau de bord : c'est lui que la
    // bannière suivra, puisque le déclencheur parcourt cette liste.
    expect([...SUGGESTION_KINDS]).toEqual(['max-hr', 'resting-hr', 'lthr', 'plan-revision']);
    expect(new Set(SUGGESTION_KINDS).size).toBe(4);
  });
});

describe('suggestionsPayload', () => {
  const MAX_HR: SuggestionNotice = { kind: 'max-hr', bpm: 191, profileBpm: 188 };
  const RESTING_HR: SuggestionNotice = {
    kind: 'resting-hr',
    bpm: 44,
    measuredNights: 14,
    profileBpm: 48,
  };
  const LTHR: SuggestionNotice = { kind: 'lthr', bpm: 172, profileBpm: 168 };
  const REVISION: SuggestionNotice = {
    kind: 'plan-revision',
    id: 12,
    direction: 'decrease',
    weeks: 3,
    before: { volumeKm: 42, intensityKm: 9 },
    after: { volumeKm: 36, intensityKm: 6 },
  };

  it('mène au tableau de bord, où vivent les cartes', () => {
    const payload = suggestionsPayload([MAX_HR], 1);

    expect(payload.url).toBe('/');
    expect(payload.tag).toBe('suggestion');
  });

  it('dit la valeur et ce qu’elle vaudrait contre le profil', () => {
    expect(suggestionsPayload([MAX_HR], 1).title).toBe('Une décision à valider');
    expect(suggestionsPayload([MAX_HR], 1).body).toBe(
      'FC max : 191 bpm tenus en séance (profil : 188 bpm)',
    );
  });

  it('n’oppose rien à un profil qui n’a pas encore de valeur', () => {
    expect(suggestionsPayload([{ ...LTHR, profileBpm: null }], 1).body).toBe(
      'FC seuil : 172 bpm mesurés',
    );
  });

  it('source la médiane de FC de repos par ses nuits', () => {
    expect(suggestionsPayload([RESTING_HR], 1).body).toBe(
      'FC de repos : 44 bpm sur 14 nuits (profil : 48 bpm)',
    );
    expect(suggestionsPayload([{ ...RESTING_HR, measuredNights: 1 }], 1).body).toContain('1 nuit');
  });

  it('dit le sens de la réévaluation et ce qu’elle change', () => {
    expect(suggestionsPayload([REVISION], 1).body).toBe(
      'Plan : moins de charge — 42 → 36 km sur les 3 semaines restantes',
    );
  });

  /*
   * Quatre bannières pour un seul geste à faire, au même endroit, ne valent pas
   * mieux qu'une : elles se disputeraient l'écran verrouillé.
   */
  it('regroupe plusieurs propositions en un seul message', () => {
    const payload = suggestionsPayload([MAX_HR, RESTING_HR, LTHR, REVISION], 4);

    expect(payload.title).toBe('4 décisions à valider');
    expect(payload.body.split('\n')).toHaveLength(4);
  });

  /*
   * Le défaut que le compte total corrige : une seule proposition nouvelle
   * devant quatre cartes annonçait « Une décision à valider », et l'écran ouvert
   * en montrait quatre. On détaille la nouvelle, on compte les autres.
   */
  it('mentionne les propositions déjà en attente sans les redétailler', () => {
    const payload = suggestionsPayload([MAX_HR], 4);

    expect(payload.title).toBe('Une nouvelle décision à valider');
    expect(payload.body).toBe(
      'FC max : 191 bpm tenus en séance (profil : 188 bpm)\n' +
        '3 autres décisions restent en attente.',
    );
  });

  it('accorde la mention au singulier quand il n’en reste qu’une', () => {
    const payload = suggestionsPayload([MAX_HR, LTHR], 3);

    expect(payload.title).toBe('2 nouvelles décisions à valider');
    expect(payload.body.split('\n').at(-1)).toBe('Une autre décision reste en attente.');
  });

  /* Rien d'ancien à distinguer : le mot « nouvelle » ne dirait rien de plus. */
  it('ne parle pas de nouveauté quand la bannière dit tout l’écran', () => {
    expect(suggestionsPayload([MAX_HR, LTHR], 2).title).toBe('2 décisions à valider');
    expect(suggestionsPayload([MAX_HR, LTHR], 2).body.split('\n')).toHaveLength(2);
  });
});
