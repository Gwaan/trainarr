import { describe, expect, it } from 'vitest';

import type { Vo2maxCorrectionDto } from '@/data/vo2max-correction';

import { toCorrectionFactorSettings } from './correction-factor-values';

const TODAY = '2026-08-17';

function correction(overrides: Partial<Vo2maxCorrectionDto> = {}): Vo2maxCorrectionDto {
  return {
    factor: 1.11,
    source: 'race',
    manualFactor: null,
    automaticFactor: 1.11,
    unavailable: null,
    calibratedOnRaceId: 3,
    races: [
      {
        id: 3,
        racedOn: '2026-04-12',
        name: '10 km de Bordeaux',
        distanceM: 10_000,
        timeS: 2_700,
        activityId: 42,
        timeVo2max: 45.3,
        hrVo2max: 40.8,
        factor: 1.11,
        status: 'eligible',
      },
    ],
    ...overrides,
  };
}

describe('toCorrectionFactorSettings', () => {
  it('laisse le champ vide en mode automatique', () => {
    // Le pré-remplir avec le facteur calculé le figerait au premier
    // enregistrement : l'athlète perdrait l'automatique sans l'avoir demandé.
    const settings = toCorrectionFactorSettings(correction(), TODAY);

    expect(settings.manual).toBe('');
    expect(settings.automatic).toBe('×1,11');
    expect(settings.automaticNote).toContain('10 km de Bordeaux');
    expect(settings.automaticNote).toContain('12 avril');
  });

  it('relit le facteur imposé, virgule française', () => {
    expect(
      toCorrectionFactorSettings(
        correction({ manualFactor: 1.128, source: 'manual', factor: 1.128 }),
        TODAY,
      ).manual,
    ).toBe('1,128');
  });

  it('montre toujours ce que le manuel remplace', () => {
    const settings = toCorrectionFactorSettings(
      correction({ manualFactor: 1.05, source: 'manual', factor: 1.05 }),
      TODAY,
    );

    expect(settings.automatic).toBe('×1,11');
    expect(settings.automaticNote).toContain('10 km de Bordeaux');
  });

  it.each([
    ['no-race', 'Aucune course déclarée'],
    ['no-race-with-heart-rate', 'aucune fréquence cardiaque'],
    ['no-usable-race', 'écart crédible'],
  ] as const)('dit pourquoi le calcul ne recale rien (%s)', (unavailable, needle) => {
    const settings = toCorrectionFactorSettings(
      correction({
        factor: 1,
        source: 'default',
        automaticFactor: 1,
        unavailable,
        calibratedOnRaceId: null,
        races: [],
      }),
      TODAY,
    );

    expect(settings.automatic).toBe('×1');
    expect(settings.automaticNote).toContain(needle);
  });

  it('nomme par sa distance une course déclarée sans intitulé', () => {
    const settings = toCorrectionFactorSettings(
      correction({
        races: [{ ...correction().races[0], name: null }],
      }),
      TODAY,
    );

    expect(settings.automaticNote).toContain('10,0 km');
  });
});
