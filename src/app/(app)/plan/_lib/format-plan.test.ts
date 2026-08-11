import { describe, expect, it } from 'vitest';

import {
  formatCivilDay,
  formatCivilRange,
  formatIsoDay,
  formatSessionDay,
  ISO_DAY_LABELS,
} from './format-plan';

describe('formatIsoDay', () => {
  it('associe le jour ISO à son libellé (1 = lundi)', () => {
    expect(formatIsoDay(1)).toBe('Lundi');
    expect(formatIsoDay(7)).toBe('Dimanche');
    expect(ISO_DAY_LABELS).toHaveLength(7);
  });
});

describe('formatCivilDay', () => {
  it('formate une date civile en jour et mois abrégé', () => {
    expect(formatCivilDay('2026-08-18')).toBe('18 août');
    expect(formatCivilDay('2026-10-12')).toBe('12 oct.');
  });

  it('ne décale pas la date malgré le fuseau du process', () => {
    // Le repère est minuit UTC, formaté en Europe/Paris : le 1er reste le 1er.
    expect(formatCivilDay('2026-01-01')).toBe('1 janv.');
  });
});

describe('formatCivilRange', () => {
  it('mutualise le mois quand les deux bornes le partagent', () => {
    expect(formatCivilRange('2026-08-18', '2026-08-24')).toBe('18–24 août');
  });

  it('répète le mois quand la semaine en chevauche deux', () => {
    expect(formatCivilRange('2026-08-31', '2026-09-06')).toBe('31 août – 6 sept.');
  });

  it("porte les millésimes quand l'intervalle franchit une année", () => {
    expect(formatCivilRange('2026-12-28', '2027-01-03')).toBe(
      '28 déc. 2026 – 3 janv. 2027',
    );
  });
});

describe('formatSessionDay', () => {
  it('rend un jour abrégé capitalisé, sans point abréviatif', () => {
    // 18 août 2026 est un mardi, le 23 un dimanche.
    expect(formatSessionDay('2026-08-18')).toBe('Mar 18');
    expect(formatSessionDay('2026-08-23')).toBe('Dim 23');
  });
});
