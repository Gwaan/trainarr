import { describe, expect, it } from 'vitest';

import {
  EASY_HR_ZONE,
  PRESCRIBED_HR_ZONES,
  canPrescribeHeartRate,
  hrZoneTargetBpm,
} from './hr-targets';

describe('EASY_HR_ZONE', () => {
  it("vaut 2 — la convention que PlanStep.hrZone porte pour l'endurance", () => {
    expect(EASY_HR_ZONE).toBe(2);
  });

  it('reste dans les bornes que le schéma des étapes accepte', () => {
    expect(EASY_HR_ZONE).toBeGreaterThanOrEqual(1);
    expect(EASY_HR_ZONE).toBeLessThanOrEqual(5);
  });
});

describe('PRESCRIBED_HR_ZONES', () => {
  it('ancre la zone 2 sur les fractions de Daniels (65-79 % de FC max)', () => {
    expect(PRESCRIBED_HR_ZONES[EASY_HR_ZONE]).toMatchObject({
      minPercentOfMax: 65,
      maxPercentOfMax: 79,
    });
  });

  it('ne déclare aucun autre créneau : rien de prescrit, rien de publié', () => {
    expect(Object.keys(PRESCRIBED_HR_ZONES)).toEqual([String(EASY_HR_ZONE)]);
  });
});

describe('hrZoneTargetBpm', () => {
  it('rend 120-145 bpm pour une FC max de 184 — le cas de référence', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, 184)).toEqual({ minBpm: 120, maxBpm: 145 });
  });

  it("n'est PAS la table générique des montres (Z2 = 60-70 % donnerait 110-129)", () => {
    const target = hrZoneTargetBpm(EASY_HR_ZONE, 184);
    expect(target).not.toEqual({ minBpm: 110, maxBpm: 129 });
    // Le bas de la plage Daniels est au-dessus du haut de la plage générique :
    // les deux tables ne se recouvrent presque pas, l'écart n'est pas un arrondi.
    expect(target?.minBpm).toBeGreaterThan(110);
  });

  it('arrondit les deux bornes à l’entier', () => {
    // 190 × 0,65 = 123,5 → 124 ; 190 × 0,79 = 150,1 → 150.
    expect(hrZoneTargetBpm(EASY_HR_ZONE, 190)).toEqual({ minBpm: 124, maxBpm: 150 });
  });

  it('rend null sans FC max — rien n’est deviné', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, null)).toBeNull();
  });

  it('rend null sur une FC max hors bornes de plausibilité', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, 119)).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, 231)).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, Number.NaN)).toBeNull();
  });

  it('rend null sur une FC max non entière — aucun cardio ne mesure 184,5 bpm', () => {
    // Le JSDoc le promet, et la règle du projet l'impose : une donnée qui n'en
    // est pas une ne se prescrit pas, même dans les bornes de plausibilité.
    expect(hrZoneTargetBpm(EASY_HR_ZONE, 184.5)).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, 183.999)).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, Number.POSITIVE_INFINITY)).toBeNull();
    expect(canPrescribeHeartRate(184.5)).toBe(false);
  });

  it('accepte les bornes elles-mêmes', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, 120)).not.toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, 230)).not.toBeNull();
  });

  it('rend null pour une zone sans créneau déclaré', () => {
    for (const zone of [1, 3, 4, 5]) {
      expect(hrZoneTargetBpm(zone, 184)).toBeNull();
    }
  });
});

describe('canPrescribeHeartRate', () => {
  it('est le seul interrupteur de la fonctionnalité', () => {
    expect(canPrescribeHeartRate(184)).toBe(true);
    expect(canPrescribeHeartRate(null)).toBe(false);
    expect(canPrescribeHeartRate(90)).toBe(false);
  });
});
