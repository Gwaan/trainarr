import { describe, expect, it } from 'vitest';

import type { CalendarActivityDto, CalendarSessionDto } from '@/data/calendar';

import {
  buildCalendarMonth,
  calendarSessionState,
  formatDayLabel,
  formatMonthLabel,
  formatMoveDetail,
  formatWeekLabel,
  formatWeekVolume,
  sessionEmphasis,
  toCalendarActivityView,
  toCalendarSessionView,
  WEEKDAY_HEADERS,
  type CalendarActivityView,
  type CalendarPlanBounds,
} from './calendar-model';

function session(
  id: number,
  date: string,
  overrides: Partial<CalendarSessionDto> = {},
): CalendarSessionDto {
  return {
    id,
    date,
    kind: 'Endurance fondamentale',
    title: 'Footing en endurance',
    steps: null,
    volumeM: null,
    durationS: null,
    completed: false,
    movable: true,
    ...overrides,
  };
}

function activity(
  id: number,
  date: string,
  overrides: Partial<CalendarActivityDto> = {},
): CalendarActivityDto {
  return {
    id,
    date,
    name: 'Sortie improvisée',
    sportType: 'Run',
    distanceM: 10_200,
    movingTimeS: 3_120,
    avgPaceSecPerKm: 306,
    ...overrides,
  };
}

/** Ce que le serveur projette avant de franchir la frontière client. */
function activityView(
  id: number,
  date: string,
  overrides: Partial<CalendarActivityDto> = {},
): CalendarActivityView {
  return toCalendarActivityView(activity(id, date, overrides));
}

/** Août 2026 : plan du 27 juillet au 6 septembre, course le 6 septembre. */
const PLAN: CalendarPlanBounds = {
  startsOn: '2026-07-27',
  endsOn: '2026-09-06',
  raceDate: '2026-09-06',
  longRunDay: 7,
};

const AUGUST = {
  from: '2026-07-27',
  to: '2026-09-06',
  month: '2026-08',
  today: '2026-08-13',
} as const;

describe('sessionEmphasis', () => {
  it('réserve l’accent plein à la course objectif', () => {
    expect(sessionEmphasis('Course')).toBe('race');
  });

  it('range les journées dures ensemble', () => {
    expect(sessionEmphasis('Sortie longue')).toBe('hard');
    expect(sessionEmphasis('Seuil')).toBe('hard');
    expect(sessionEmphasis('VMA')).toBe('hard');
    expect(sessionEmphasis('Répétitions')).toBe('hard');
    expect(sessionEmphasis('Test 5 km')).toBe('hard');
  });

  it('laisse l’endurance en gris', () => {
    expect(sessionEmphasis('Endurance fondamentale')).toBe('normal');
    expect(sessionEmphasis('Récupération')).toBe('normal');
    // Un libellé non reconnu ne s'invente pas une importance.
    expect(sessionEmphasis('Sortie vélo')).toBe('normal');
  });
});

describe('calendarSessionState', () => {
  const today = '2026-08-13';

  it('range une séance courue dans l’histoire, quelle que soit sa date', () => {
    expect(calendarSessionState({ date: '2026-08-10', completed: true }, today)).toBe('completed');
    expect(calendarSessionState({ date: '2026-08-20', completed: true }, today)).toBe('completed');
  });

  it('distingue une séance passée non courue', () => {
    expect(calendarSessionState({ date: '2026-08-12', completed: false }, today)).toBe('missed');
  });

  it('compte la séance du jour parmi celles à venir', () => {
    expect(calendarSessionState({ date: '2026-08-13', completed: false }, today)).toBe('upcoming');
    expect(calendarSessionState({ date: '2026-08-14', completed: false }, today)).toBe('upcoming');
  });
});

describe('toCalendarSessionView', () => {
  it('résume avec le volume annoncé et la durée', () => {
    const view = toCalendarSessionView(
      session(1, '2026-08-14', { volumeM: 12_400, durationS: 3_900 }),
      '2026-08-13',
    );
    expect(view.summary).toBe('12,4 km · 1 h 05');
  });

  it('n’invente rien quand la séance n’annonce ni volume ni durée', () => {
    expect(toCalendarSessionView(session(1, '2026-08-14'), '2026-08-13').summary).toBeNull();
  });

  it('recalcule le déplaçable sur la date affichée', () => {
    // Après un déplacement optimiste, le `movable` du DTO parle de l'ancienne
    // date : c'est la date affichée qui fait foi.
    const moved = session(1, '2026-08-10', { movable: true });
    expect(toCalendarSessionView(moved, '2026-08-13').movable).toBe(false);

    const completed = session(2, '2026-08-20', { completed: true, movable: true });
    expect(toCalendarSessionView(completed, '2026-08-13').movable).toBe(false);

    expect(toCalendarSessionView(session(3, '2026-08-13'), '2026-08-13').movable).toBe(true);
  });

  it('annonce la séance par son type et son intitulé', () => {
    const view = toCalendarSessionView(
      session(1, '2026-08-14', { kind: 'Seuil', title: '6 × 800 m' }),
      '2026-08-13',
    );
    expect(view.label).toBe('Seuil, 6 × 800 m');
  });
});

describe('toCalendarActivityView', () => {
  it('résume ce qui a réellement été couru', () => {
    expect(toCalendarActivityView(activity(1, '2026-08-11')).summary).toBe('10,2 km · 52 min');
  });

  it('ne résume rien d’une activité sans distance ni durée', () => {
    expect(
      toCalendarActivityView(activity(1, '2026-08-11', { distanceM: 0, movingTimeS: 0 })).summary,
    ).toBeNull();
  });
});

describe('libellés', () => {
  it('nomme le mois avec sa capitale', () => {
    expect(formatMonthLabel('2026-08')).toBe('Août 2026');
    expect(formatMonthLabel('2026-01')).toBe('Janvier 2026');
  });

  it('nomme un jour en entier', () => {
    expect(formatDayLabel('2026-08-10')).toBe('lundi 10 août');
  });

  it('rédige le détail d’un déplacement à partir de la seule date', () => {
    // Il est figé à la soumission, et la réponse peut arriver après un
    // changement de mois : le libellé ne se cherche pas dans la grille affichée,
    // sans quoi un jour qu'elle ne contient plus rendrait une date ISO brute.
    expect(formatMoveDetail('6 × 800 m', '2026-08-11')).toBe(
      '« 6 × 800 m » est passée au mardi 11 août.',
    );
    expect(formatMoveDetail('Sortie longue', '2027-01-03')).toBe(
      '« Sortie longue » est passée au dimanche 3 janvier.',
    );
    expect(formatMoveDetail('Seuil', '2026-08-12')).not.toContain('2026-08-12');
  });

  it('nomme une semaine par son lundi', () => {
    expect(formatWeekLabel('2026-08-10')).toBe('Semaine du 10 août');
  });

  it('rend les sept en-têtes de colonnes', () => {
    expect(WEEKDAY_HEADERS).toEqual(['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']);
  });

  it('n’affiche un volume de semaine que s’il en existe un', () => {
    expect(formatWeekVolume(42_000)).toBe('42,0 km');
    expect(formatWeekVolume(null)).toBeNull();
  });
});

describe('buildCalendarMonth', () => {
  const base = { ...AUGUST, plan: PLAN, sessions: [], activities: [] } as const;

  it('découpe la plage en semaines pleines, du lundi au dimanche', () => {
    const weeks = buildCalendarMonth(base);

    expect(weeks).toHaveLength(6);
    expect(weeks[0].startsOn).toBe('2026-07-27');
    expect(weeks[0].endsOn).toBe('2026-08-02');
    expect(weeks[5].endsOn).toBe('2026-09-06');
    for (const week of weeks) expect(week.days).toHaveLength(7);
  });

  it('marque le débord des semaines qui mordent sur les mois voisins', () => {
    const [first] = buildCalendarMonth(base);

    expect(first.days.map((day) => day.inMonth)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('désigne le jour courant et sa semaine', () => {
    const weeks = buildCalendarMonth(base);
    const today = weeks.flatMap((week) => week.days).filter((day) => day.isToday);

    expect(today).toHaveLength(1);
    expect(today[0].date).toBe('2026-08-13');
    expect(weeks.filter((week) => week.isCurrent).map((week) => week.startsOn)).toEqual([
      '2026-08-10',
    ]);
  });

  it('borne les jours que le plan couvre, et nomme le jour J', () => {
    const weeks = buildCalendarMonth({
      ...base,
      plan: { ...PLAN, startsOn: '2026-08-03', endsOn: '2026-08-30' },
    });
    const days = new Map(weeks.flatMap((week) => week.days).map((day) => [day.date, day]));

    expect(days.get('2026-08-02')?.inPlan).toBe(false);
    expect(days.get('2026-08-03')?.inPlan).toBe(true);
    expect(days.get('2026-08-30')?.inPlan).toBe(true);
    expect(days.get('2026-08-31')?.inPlan).toBe(false);
    expect(days.get('2026-09-06')?.isRaceDay).toBe(true);
    expect(days.get('2026-09-05')?.isRaceDay).toBe(false);
  });

  it('n’a ni plan ni jour J quand aucun plan n’est actif', () => {
    const weeks = buildCalendarMonth({ ...base, plan: null });

    expect(weeks.flatMap((week) => week.days).some((day) => day.inPlan)).toBe(false);
    expect(weeks.flatMap((week) => week.days).some((day) => day.isRaceDay)).toBe(false);
  });

  it('range chaque séance dans son jour, dans un ordre stable', () => {
    const weeks = buildCalendarMonth({
      ...base,
      sessions: [
        session(9, '2026-08-12', { kind: 'Seuil', title: '6 × 800 m' }),
        session(4, '2026-08-12', { kind: 'Récupération', title: 'Footing court' }),
        session(7, '2026-08-16', { kind: 'Sortie longue', title: 'Sortie longue' }),
      ],
    });
    const days = new Map(weeks.flatMap((week) => week.days).map((day) => [day.date, day]));

    expect(days.get('2026-08-12')?.sessions.map((entry) => entry.id)).toEqual([4, 9]);
    expect(days.get('2026-08-16')?.sessions.map((entry) => entry.title)).toEqual(['Sortie longue']);
    expect(days.get('2026-08-13')?.sessions).toEqual([]);
  });

  it('totalise le volume annoncé de chaque semaine', () => {
    const weeks = buildCalendarMonth({
      ...base,
      sessions: [
        session(1, '2026-08-10', { volumeM: 10_000 }),
        session(2, '2026-08-12', { volumeM: 8_000 }),
        // Sans volume annoncé : elle ne compte pas, et n'invente pas un zéro.
        session(3, '2026-08-14'),
        session(4, '2026-08-18', { volumeM: 12_000 }),
      ],
    });
    const byStart = new Map(weeks.map((week) => [week.startsOn, week]));

    expect(byStart.get('2026-08-10')?.volumeM).toBe(18_000);
    expect(byStart.get('2026-08-17')?.volumeM).toBe(12_000);
    expect(byStart.get('2026-07-27')?.volumeM).toBeNull();
  });

  it('pose les sorties hors plan à côté des séances', () => {
    const weeks = buildCalendarMonth({
      ...base,
      sessions: [session(1, '2026-08-11')],
      activities: [activityView(50, '2026-08-11'), activityView(51, '2026-08-15')],
    });
    const days = new Map(weeks.flatMap((week) => week.days).map((day) => [day.date, day]));

    expect(days.get('2026-08-11')?.sessions).toHaveLength(1);
    expect(days.get('2026-08-11')?.activities.map((entry) => entry.id)).toEqual([50]);
    expect(days.get('2026-08-15')?.activities.map((entry) => entry.id)).toEqual([51]);
  });

  it('ignore sans bruit ce qui tombe hors de la grille', () => {
    // Un déplacement optimiste peut, le temps d'un aller-retour, poser une
    // séance en dehors de ce que la page a lu.
    const weeks = buildCalendarMonth({
      ...base,
      sessions: [session(1, '2026-10-01')],
      activities: [activityView(50, '2026-05-04')],
    });
    const days = weeks.flatMap((week) => week.days);

    expect(days.some((day) => day.sessions.length > 0)).toBe(false);
    expect(days.some((day) => day.activities.length > 0)).toBe(false);
  });

  it('donne à chaque jour ses libellés d’affichage', () => {
    const [, second] = buildCalendarMonth(base);
    const monday = second.days[0];

    expect(monday.date).toBe('2026-08-03');
    expect(monday.weekdayLabel).toBe('Lun');
    expect(monday.dayNumber).toBe('3');
    expect(monday.label).toBe('lundi 3 août');
    expect(second.label).toBe('Semaine du 3 août');
  });
});
