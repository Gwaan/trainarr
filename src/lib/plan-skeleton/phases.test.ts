import { describe, expect, it } from 'vitest';

import {
  weeklyVolumeTargets,
  type PlanRaceGoal,
  type WeeklyVolumeTargetKind,
} from '@/lib/ai/plan-schema';

import { planPhases, type PlanPhase } from './phases';

const MARATHON: PlanRaceGoal = { isMarathon: true };
const TEN_K: PlanRaceGoal = { isMarathon: false };

/** Les mêmes paramètres, vus par les volumes — le reste ne change pas la segmentation. */
function targetKinds(
  weeks: number,
  firstWeekFromDay: number,
  race: PlanRaceGoal | null,
): WeeklyVolumeTargetKind[] {
  return weeklyVolumeTargets({
    weeks,
    firstWeekFromDay,
    recentWeeklyKm: 30,
    weeklyTimeMinutes: 300,
    easyPaceSecPerKm: 330,
    race,
    level: 'intermediate',
  }).map((target) => target.kind);
}

describe('planPhases', () => {
  it('rend une phase par semaine', () => {
    expect(planPhases({ weeks: 12, firstWeekFromDay: 1, race: null })).toHaveLength(12);
  });

  it('découpe un plan long en base / développement / spécificité', () => {
    // 12 semaines sans course : la base prend 30 % (4 semaines), le reste se
    // partage à 4 contre 3 (5 puis 3).
    expect(planPhases({ weeks: 12, firstWeekFromDay: 1, race: null })).toEqual<PlanPhase[]>([
      'base',
      'base',
      'base',
      'base',
      'build',
      'build',
      'build',
      'build',
      'build',
      'specific',
      'specific',
      'specific',
    ]);
  });

  it('place la course en dernière semaine et l’affûtage juste avant', () => {
    const phases = planPhases({ weeks: 16, firstWeekFromDay: 1, race: MARATHON });
    expect(phases[15]).toBe('race');
    expect(phases[14]).toBe('taper');
    expect(phases[13]).toBe('taper');
    expect(phases[12]).toBe('specific');
  });

  it('n’affûte pas un plan sans course', () => {
    const phases = planPhases({ weeks: 20, firstWeekFromDay: 1, race: null });
    expect(phases).not.toContain('taper');
    expect(phases).not.toContain('race');
  });

  it('marque la première semaine entamée, et elle seule', () => {
    const phases = planPhases({ weeks: 10, firstWeekFromDay: 4, race: null });
    expect(phases[0]).toBe('partial');
    expect(phases.slice(1)).not.toContain('partial');
  });

  it('réduit la base à une semaine sur un plan de moins de 8 semaines', () => {
    const phases = planPhases({ weeks: 7, firstWeekFromDay: 1, race: null });
    expect(phases.filter((phase) => phase === 'base')).toHaveLength(1);
    expect(phases[0]).toBe('base');
    // Le reste part au développement puis à la spécificité, dans cet ordre.
    expect(phases.slice(1)).toEqual<PlanPhase[]>([
      'build',
      'build',
      'build',
      'specific',
      'specific',
      'specific',
    ]);
  });

  it('garde au moins une semaine à chaque phase présente', () => {
    for (let weeks = 3; weeks <= 52; weeks += 1) {
      const phases = planPhases({ weeks, firstWeekFromDay: 1, race: null });
      // Sans course, toute la fenêtre est du développement : les trois phases y
      // sont dès qu'il y a la place.
      expect(phases.filter((phase) => phase === 'base').length).toBeGreaterThanOrEqual(1);
      expect(phases.filter((phase) => phase === 'build').length).toBeGreaterThanOrEqual(1);
      expect(phases.filter((phase) => phase === 'specific').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('ne recule jamais dans la progression des phases', () => {
    const order: PlanPhase[] = ['partial', 'base', 'build', 'specific', 'taper', 'race'];
    for (let weeks = 3; weeks <= 52; weeks += 1) {
      for (const race of [null, TEN_K, MARATHON]) {
        for (const firstWeekFromDay of [1, 4, 7]) {
          const phases = planPhases({ weeks, firstWeekFromDay, race });
          const ranks = phases.map((phase) => order.indexOf(phase));
          const sorted = [...ranks].sort((left, right) => left - right);
          expect(ranks).toEqual(sorted);
        }
      }
    }
  });

  /*
   * La raison d'être de la recopie de segmentation : phases et volumes doivent
   * découper le plan au même endroit, sans quoi une semaine d'affûtage se verrait
   * attribuer une séance de développement.
   */
  it('segmente exactement comme les volumes cibles', () => {
    for (let weeks = 1; weeks <= 52; weeks += 1) {
      for (const race of [null, TEN_K, MARATHON]) {
        for (let firstWeekFromDay = 1; firstWeekFromDay <= 7; firstWeekFromDay += 1) {
          const phases = planPhases({ weeks, firstWeekFromDay, race });
          const kinds = targetKinds(weeks, firstWeekFromDay, race);
          const where = `${weeks} semaines, départ jour ${firstWeekFromDay}, course ${String(race?.isMarathon)}`;

          phases.forEach((phase, index) => {
            const kind = kinds[index];
            const label = `${where}, semaine ${index + 1}`;
            if (kind === 'partial') expect(phase, label).toBe('partial');
            if (kind === 'race') expect(phase, label).toBe('race');
            if (kind === 'taper') expect(phase, label).toBe('taper');
            // L'inverse aussi : une semaine allégée reste une semaine de
            // développement, la phase ne bouge pas avec le volume.
            if (kind === 'build' || kind === 'cutback') {
              expect(['base', 'build', 'specific'], label).toContain(phase);
            }
          });
        }
      }
    }
  });
});
