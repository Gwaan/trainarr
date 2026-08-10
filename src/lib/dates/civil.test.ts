import { describe, expect, it } from 'vitest';

import {
  civilDateToMs,
  civilDaysBetween,
  isoDayIndex,
  isoWeekEnd,
  isoWeekNumber,
  isoWeekStart,
  shiftCivilDate,
  toCivilDate,
} from './civil';

describe('toCivilDate', () => {
  it('donne le jour de l’athlète, pas celui du process', () => {
    // 23:30 UTC le 28 mars, c'est déjà le 29 à Paris (00:30 CET).
    expect(toCivilDate(new Date('2026-03-28T23:30:00Z'))).toBe('2026-03-29');
    // Et 22:30 UTC en été, c'est déjà le lendemain (00:30 CEST).
    expect(toCivilDate(new Date('2026-07-14T22:30:00Z'))).toBe('2026-07-15');
    expect(toCivilDate(new Date('2026-07-14T21:30:00Z'))).toBe('2026-07-14');
  });
});

describe('shiftCivilDate', () => {
  it('compte des jours civils, pas des tranches de 24 h', () => {
    // Passage à l'heure d'été (29 mars 2026) : la journée ne fait que 23 h,
    // mais le repère « minuit UTC » ignore le changement d'heure.
    expect(shiftCivilDate('2026-03-28', 1)).toBe('2026-03-29');
    expect(shiftCivilDate('2026-03-29', 1)).toBe('2026-03-30');
    // Retour à l'heure d'hiver (25 octobre 2026), journée de 25 h.
    expect(shiftCivilDate('2026-10-24', 2)).toBe('2026-10-26');
    // Bissextile et changement d'année.
    expect(shiftCivilDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftCivilDate('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('civilDaysBetween', () => {
  it('rend un entier exact malgré les changements d’heure', () => {
    expect(civilDaysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(civilDaysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(civilDaysBetween('2026-08-10', '2026-08-10')).toBe(0);
    expect(civilDaysBetween('2026-08-10', '2026-08-03')).toBe(-7);
  });
});

describe('isoDayIndex', () => {
  it('numérote la semaine du lundi au dimanche', () => {
    expect(isoDayIndex('2026-08-10')).toBe(0); // lundi
    expect(isoDayIndex('2026-08-13')).toBe(3); // jeudi
    expect(isoDayIndex('2026-08-16')).toBe(6); // dimanche
  });
});

describe('isoWeekStart / isoWeekEnd', () => {
  it('borne la semaine ISO du lundi au dimanche, par-dessus le Nouvel An', () => {
    expect(isoWeekStart('2026-08-13')).toBe('2026-08-10');
    expect(isoWeekEnd('2026-08-13')).toBe('2026-08-16');
    // La semaine 1 de 2025 commence le lundi 30 décembre 2024.
    expect(isoWeekStart('2025-01-01')).toBe('2024-12-30');
    expect(isoWeekEnd('2024-12-30')).toBe('2025-01-05');
  });
});

describe('isoWeekNumber', () => {
  it('applique la règle du premier jeudi', () => {
    // 2026 commence un jeudi : le 1er janvier est déjà en semaine 1.
    expect(isoWeekNumber('2026-01-01')).toBe(1);
    // 2021 commence un vendredi : le 1er janvier appartient à la S53 de 2020.
    expect(isoWeekNumber('2021-01-01')).toBe(53);
    // 2026 compte 53 semaines : le 1er janvier 2027 est encore en S53.
    expect(isoWeekNumber('2026-12-31')).toBe(53);
    expect(isoWeekNumber('2027-01-01')).toBe(53);
    // Le 30 décembre 2024 (lundi) ouvre la S1 de 2025.
    expect(isoWeekNumber('2024-12-30')).toBe(1);
  });

  it('donne le même numéro à tous les jours d’une même semaine', () => {
    const monday = '2026-08-10';
    const numbers = [0, 1, 2, 3, 4, 5, 6].map((offset) =>
      isoWeekNumber(shiftCivilDate(monday, offset)),
    );
    expect(new Set(numbers).size).toBe(1);
    expect(numbers[0]).toBe(33);
  });
});

describe('civilDateToMs', () => {
  it('repère la date à minuit UTC', () => {
    expect(civilDateToMs('2026-08-10')).toBe(Date.parse('2026-08-10T00:00:00Z'));
  });
});
