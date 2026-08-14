import { describe, expect, it } from 'vitest';

import {
  activitiesHref,
  civilMonth,
  monthGridRange,
  parseMonthParam,
  parseViewParam,
  shiftMonth,
} from './calendar-params';

describe('parseViewParam', () => {
  it('reconnaît les deux vues', () => {
    expect(parseViewParam('calendrier')).toBe('calendrier');
    expect(parseViewParam('liste')).toBe('liste');
  });

  it('retombe sur le calendrier pour tout le reste', () => {
    expect(parseViewParam(undefined)).toBe('calendrier');
    expect(parseViewParam('grille')).toBe('calendrier');
    expect(parseViewParam(['liste', 'calendrier'])).toBe('calendrier');
    expect(parseViewParam(42)).toBe('calendrier');
  });
});

describe('civilMonth', () => {
  it('rend le mois d’une date civile', () => {
    expect(civilMonth('2026-08-13')).toBe('2026-08');
  });
});

describe('parseMonthParam', () => {
  const fallback = '2026-08';

  it('accepte un mois bien formé', () => {
    expect(parseMonthParam('2026-01', fallback)).toBe('2026-01');
    expect(parseMonthParam('2025-12', fallback)).toBe('2025-12');
  });

  it('refuse tout ce qui n’est pas un mois', () => {
    expect(parseMonthParam(undefined, fallback)).toBe(fallback);
    expect(parseMonthParam('2026-13', fallback)).toBe(fallback);
    expect(parseMonthParam('2026-00', fallback)).toBe(fallback);
    expect(parseMonthParam('2026-8', fallback)).toBe(fallback);
    expect(parseMonthParam('2026-08-01', fallback)).toBe(fallback);
    expect(parseMonthParam(['2026-01'], fallback)).toBe(fallback);
  });
});

describe('shiftMonth', () => {
  it('avance et recule dans l’année', () => {
    expect(shiftMonth('2026-08', 1)).toBe('2026-09');
    expect(shiftMonth('2026-08', -1)).toBe('2026-07');
  });

  it('franchit les changements d’année dans les deux sens', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-01', -13)).toBe('2024-12');
    expect(shiftMonth('2026-11', 14)).toBe('2028-01');
  });

  it('ne bouge pas à delta nul', () => {
    expect(shiftMonth('2026-02', 0)).toBe('2026-02');
  });
});

describe('monthGridRange', () => {
  it('couvre des semaines ISO entières', () => {
    // Août 2026 commence un samedi et finit un lundi : la grille déborde des
    // deux côtés, du lundi 27 juillet au dimanche 6 septembre.
    expect(monthGridRange('2026-08')).toEqual({ from: '2026-07-27', to: '2026-09-06' });
  });

  it('ne déborde pas quand le mois tombe pile sur des lundis et dimanches', () => {
    // Février 2027 : du lundi 1er au dimanche 28.
    expect(monthGridRange('2027-02')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
  });

  it('compte le 29 février des années bissextiles', () => {
    // 2028 est bissextile : le mois va jusqu'au mardi 29, sa semaine jusqu'au 5 mars.
    expect(monthGridRange('2028-02')).toEqual({ from: '2028-01-31', to: '2028-03-05' });
  });

  it('reste dans les bornes que le DAL accepte', () => {
    for (const month of ['2026-01', '2026-02', '2026-05', '2026-08', '2026-12']) {
      const { from, to } = monthGridRange(month);
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      expect(days % 7).toBe(0);
      expect(days).toBeLessThanOrEqual(42);
    }
  });
});

describe('activitiesHref', () => {
  const current = '2026-08';

  it('ne porte aucun paramètre sur la vue et le mois par défaut', () => {
    expect(activitiesHref({ view: 'calendrier', month: current }, current)).toBe('/activities');
  });

  it('nomme la vue liste', () => {
    expect(activitiesHref({ view: 'liste', month: current }, current)).toBe(
      '/activities?vue=liste',
    );
  });

  it('nomme un autre mois', () => {
    expect(activitiesHref({ view: 'calendrier', month: '2026-09' }, current)).toBe(
      '/activities?mois=2026-09',
    );
  });

  it('conserve le mois quand on bascule vers la liste', () => {
    expect(activitiesHref({ view: 'liste', month: '2026-09' }, current)).toBe(
      '/activities?vue=liste&mois=2026-09',
    );
  });

  it('nomme la page au-delà de la première', () => {
    expect(activitiesHref({ view: 'liste', month: current, page: 4 }, current)).toBe(
      '/activities?vue=liste&page=4',
    );
    expect(activitiesHref({ view: 'liste', month: current, page: 1 }, current)).toBe(
      '/activities?vue=liste',
    );
  });

  it("ne traîne pas un rang de page jusque dans le calendrier", () => {
    // Une page appartient à la liste qu'on quitte : la reporter sur la grille
    // ramènerait ensuite à une page que personne n'a demandée.
    expect(activitiesHref({ view: 'calendrier', month: current, page: 4 }, current)).toBe(
      '/activities',
    );
  });
});
