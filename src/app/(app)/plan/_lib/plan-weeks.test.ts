import { describe, expect, it } from 'vitest';

import type { PlanSessionDto } from '@/data/plans';

import { groupPlanWeeks, planEndsOn, planSessionState } from './plan-weeks';

/** Séance minimale : seuls la date et le rapprochement pilotent le regroupement. */
function session(
  id: number,
  scheduledOn: string,
  overrides: Partial<PlanSessionDto> = {},
): PlanSessionDto {
  return {
    id,
    scheduledOn,
    kind: 'Endurance',
    title: 'Footing',
    warmup: null,
    recovery: null,
    cooldown: null,
    targetPaceSecPerKm: null,
    volumeM: null,
    durationS: null,
    completedActivityId: null,
    ...overrides,
  };
}

describe('planEndsOn', () => {
  it('rend le dernier jour couvert, semaines pleines', () => {
    // 4 semaines depuis un lundi : le dimanche de la quatrième.
    expect(planEndsOn({ startsOn: '2026-08-17', weeks: 4 })).toBe('2026-09-13');
    expect(planEndsOn({ startsOn: '2026-08-17', weeks: 1 })).toBe('2026-08-23');
  });
});

describe('planSessionState', () => {
  const today = '2026-08-20';

  it('reconnaît une séance réalisée, quelle que soit sa date', () => {
    expect(
      planSessionState({ scheduledOn: '2026-08-18', completedActivityId: 42 }, today),
    ).toBe('completed');
    expect(
      planSessionState({ scheduledOn: '2026-08-20', completedActivityId: 42 }, today),
    ).toBe('completed');
  });

  it('distingue le jour même, le passé non réalisé et le futur', () => {
    expect(
      planSessionState({ scheduledOn: '2026-08-20', completedActivityId: null }, today),
    ).toBe('today');
    expect(
      planSessionState({ scheduledOn: '2026-08-19', completedActivityId: null }, today),
    ).toBe('missed');
    expect(
      planSessionState({ scheduledOn: '2026-08-21', completedActivityId: null }, today),
    ).toBe('upcoming');
  });
});

describe('groupPlanWeeks', () => {
  const plan = { startsOn: '2026-08-17', weeks: 3 };

  it('rend autant de semaines que le plan en compte, même vides', () => {
    const weeks = groupPlanWeeks(plan, [session(1, '2026-08-19')], '2026-08-20');

    expect(weeks.map((week) => week.number)).toEqual([1, 2, 3]);
    expect(weeks.map((week) => week.startsOn)).toEqual([
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
    expect(weeks[1].sessions).toEqual([]);
    expect(weeks[1].totalVolumeM).toBeNull();
  });

  it('range chaque séance dans la semaine du plan qui la contient', () => {
    const weeks = groupPlanWeeks(
      plan,
      [
        session(1, '2026-08-23'), // dimanche de la semaine 1
        session(2, '2026-08-24'), // lundi de la semaine 2
        session(3, '2026-08-31'), // lundi de la semaine 3
      ],
      '2026-08-20',
    );

    expect(weeks.map((week) => week.sessions.map((item) => item.id))).toEqual([
      [1],
      [2],
      [3],
    ]);
  });

  it('additionne les volumes annoncés, et seulement eux', () => {
    const weeks = groupPlanWeeks(
      plan,
      [
        session(1, '2026-08-18', { volumeM: 8_000 }),
        session(2, '2026-08-20', { volumeM: 12_500 }),
        session(3, '2026-08-22'),
      ],
      '2026-08-20',
    );

    expect(weeks[0].totalVolumeM).toBe(20_500);
  });

  it('situe chaque semaine par rapport au jour courant', () => {
    const weeks = groupPlanWeeks(plan, [], '2026-08-26');

    expect(weeks.map((week) => week.status)).toEqual(['past', 'current', 'upcoming']);
  });

  it('compte la semaine en cours dès son premier et jusqu’à son dernier jour', () => {
    expect(groupPlanWeeks(plan, [], '2026-08-17')[0].status).toBe('current');
    expect(groupPlanWeeks(plan, [], '2026-08-23')[0].status).toBe('current');
    expect(groupPlanWeeks(plan, [], '2026-08-24')[0].status).toBe('past');
  });

  it('étiquette chaque semaine par son intervalle de dates', () => {
    const weeks = groupPlanWeeks(plan, [], '2026-08-20');

    expect(weeks[0].label).toBe('17–23 août');
    expect(weeks[2].label).toBe('31 août – 6 sept.');
  });
});
