import { describe, expect, it, vi } from 'vitest';

import type { Athlete } from './db/schema';
import type { RaceResultDto } from './race-results';
import {
  InvalidCorrectionFactorError,
  NEUTRAL_VO2MAX_CORRECTION,
  buildVo2maxCorrection,
  validateManualCorrectionFactor,
} from './vo2max-correction';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Ce fichier vérifie **la composition** — ce que le DAL passe au calcul et ce
 * qu'il rend à l'UI —, pas le calcul lui-même, qui a ses tests dans
 * `lib/metrics/vo2max-correction.test.ts`.
 */

const ATHLETE: Athlete = {
  id: 1,
  userId: 'user_1',
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 195,
  restingHrBpm: 48,
  lthrBpm: null,
  lthrSuggestionDismissedBpm: null,
  weightKg: 58,
  birthDate: '1990-05-12',
  intervalsAthleteId: null,
  intervalsApiKeyEncrypted: null,
  maxHrSuggestionDismissedBpm: null,
  restingHrSuggestionDismissedBpm: null,
  forecastLatitudeDeg: null,
  forecastLongitudeDeg: null,
  forecastLocationLabel: null,
  wellnessReadingDay: null,
  vo2maxElevationCorrection: true,
  vo2maxAscentCoefM: 2,
  vo2maxDescentCoefM: -1,
  vo2maxCorrectionFactor: null,
  pushDailySession: true,
  pushActivityAnalyzed: true,
  pushSuggestions: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function race(overrides: Partial<RaceResultDto> = {}): RaceResultDto {
  return {
    id: 3,
    racedOn: '2026-04-12',
    name: '10 km de Bordeaux',
    distanceM: 10_000,
    timeS: 2_700,
    activityId: 42,
    avgHrBpm: 178,
    elevationGainM: null,
    elevationLossM: null,
    ...overrides,
  };
}

describe('buildVo2maxCorrection', () => {
  it('calibre sur la course et rend de quoi l’expliquer', () => {
    const correction = buildVo2maxCorrection(ATHLETE, [race()]);

    expect(correction.source).toBe('race');
    expect(correction.factor).toBeGreaterThan(0.7);
    expect(correction.calibratedOnRaceId).toBe(3);
    expect(correction.unavailable).toBeNull();

    const [entry] = correction.races;
    expect(entry.status).toBe('eligible');
    expect(entry.timeVo2max).not.toBeNull();
    expect(entry.hrVo2max).not.toBeNull();
    // Le facteur affiché **est** le rapport des deux VO₂max affichées.
    expect(entry.factor).toBeCloseTo(entry.timeVo2max! / entry.hrVo2max!, 10);
  });

  it('réassocie l’activité de chaque course : le calcul ne la connaît pas', () => {
    const correction = buildVo2maxCorrection(ATHLETE, [
      race({ id: 3, activityId: 42 }),
      race({ id: 4, racedOn: '2026-02-01', activityId: null, avgHrBpm: null }),
    ]);

    expect(correction.races.map((entry) => [entry.id, entry.activityId])).toEqual([
      [3, 42],
      [4, null],
    ]);
  });

  it('transmet les coefficients de correction d’altitude du profil, aux deux estimations', () => {
    const hilly = race({ elevationGainM: 220, elevationLossM: 220 });

    const [withCorrection] = buildVo2maxCorrection(ATHLETE, [hilly]).races;
    const [withoutCorrection] = buildVo2maxCorrection(
      { ...ATHLETE, vo2maxElevationCorrection: false },
      [hilly],
    ).races;

    // Les coefficients arrivent bien au calcul : la distance équivalente monte
    // (10 000 + 2 × 220 − 220 = 10 220 m), donc les **deux** VO₂max avec.
    expect(withCorrection.timeVo2max!).toBeGreaterThan(withoutCorrection.timeVo2max!);
    expect(withCorrection.hrVo2max!).toBeGreaterThan(withoutCorrection.hrVo2max!);

    // Et le facteur, lui, ne bouge quasiment pas : le terrain entre au numérateur
    // comme au dénominateur, il se simplifie. C'était le bug — corrigé du seul
    // côté du dénominateur, il tirait le facteur vers le bas d'autant plus que la
    // course était vallonnée.
    expect(withCorrection.factor!).toBeCloseTo(withoutCorrection.factor!, 2);
  });

  it('ne corrige pas d’un dénivelé inconnu : `null` n’est pas « plat »', () => {
    const unknown = race({ elevationGainM: null, elevationLossM: null });
    const flat = race({ elevationGainM: 0, elevationLossM: 0 });

    expect(buildVo2maxCorrection(ATHLETE, [unknown]).factor).toBeCloseTo(
      buildVo2maxCorrection(ATHLETE, [flat]).factor,
      10,
    );
  });

  it('distingue « pas de course » de « des courses, mais aucune avec FC »', () => {
    expect(buildVo2maxCorrection(ATHLETE, []).unavailable).toBe('no-race');
    expect(buildVo2maxCorrection(ATHLETE, [race({ avgHrBpm: null })]).unavailable).toBe(
      'no-race-with-heart-rate',
    );
  });

  it('fait primer le facteur manuel sans effacer le calcul', () => {
    const correction = buildVo2maxCorrection(
      { ...ATHLETE, vo2maxCorrectionFactor: 1.12 },
      [race()],
    );

    expect(correction.factor).toBe(1.12);
    expect(correction.source).toBe('manual');
    expect(correction.manualFactor).toBe(1.12);
    // Ce qu'il remplace reste lisible : c'est ce que l'écran de réglage montre.
    expect(correction.automaticFactor).not.toBe(1.12);
    expect(correction.calibratedOnRaceId).toBe(3);
  });

  it('ne laisse échapper aucune colonne de la ligne d’athlète', () => {
    // Le DTO franchit la frontière client : il ne porte que le facteur, jamais
    // le profil qui l'a produit.
    expect(Object.keys(buildVo2maxCorrection(ATHLETE, [race()])).sort()).toEqual([
      'automaticFactor',
      'calibratedOnRaceId',
      'factor',
      'manualFactor',
      'races',
      'source',
      'unavailable',
    ]);
  });
});

describe('NEUTRAL_VO2MAX_CORRECTION', () => {
  it('est le neutre, et dit pourquoi', () => {
    expect(NEUTRAL_VO2MAX_CORRECTION).toEqual({
      factor: 1,
      source: 'default',
      manualFactor: null,
      automaticFactor: 1,
      unavailable: 'no-race',
      calibratedOnRaceId: null,
      races: [],
    });
  });
});

describe('validateManualCorrectionFactor', () => {
  it('accepte `null` : c’est le mode automatique, pas la valeur 1', () => {
    expect(validateManualCorrectionFactor(null)).toBeNull();
  });

  it('accepte 1,0 imposé, qui neutralise volontairement la calibration', () => {
    expect(validateManualCorrectionFactor(1)).toBe(1);
  });

  it('arrondit au millième — un centième déplacerait la VO₂max d’un tiers de point', () => {
    expect(validateManualCorrectionFactor(1.128_49)).toBe(1.128);
  });

  it.each([
    ['au-dessus du plafond', 1.5],
    ['sous le plancher', 0.5],
    ['nul', 0],
    ['négatif', -1.1],
    ['NaN', Number.NaN],
  ])('refuse un facteur %s', (_label, factor) => {
    expect(() => validateManualCorrectionFactor(factor)).toThrowError(
      InvalidCorrectionFactorError,
    );
  });
});
