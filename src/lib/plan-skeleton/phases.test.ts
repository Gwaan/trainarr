import { describe, expect, it } from 'vitest';

import {
  weeklyVolumeTargets,
  type PlanRaceGoal,
  type WeeklyVolumeTargetKind,
} from '@/lib/ai/plan-schema';

import { PLAN_INTENTS, type PlanIntent } from './intent';
import { planPhases, type PlanPhase } from './phases';

const INTENTS: readonly PlanIntent[] = PLAN_INTENTS;

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
    expect(planPhases({ intent: 'race', weeks: 12, firstWeekFromDay: 1, race: null })).toHaveLength(12);
  });

  it('découpe un plan long en base / développement / spécificité', () => {
    // 12 semaines sans course : la base prend 30 % (4 semaines), le reste se
    // partage à 4 contre 3 (5 puis 3).
    expect(planPhases({ intent: 'race', weeks: 12, firstWeekFromDay: 1, race: null })).toEqual<PlanPhase[]>([
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
    const phases = planPhases({ intent: 'race', weeks: 16, firstWeekFromDay: 1, race: MARATHON });
    expect(phases[15]).toBe('race');
    expect(phases[14]).toBe('taper');
    expect(phases[13]).toBe('taper');
    expect(phases[12]).toBe('specific');
  });

  it('n’affûte pas un plan sans course', () => {
    const phases = planPhases({ intent: 'race', weeks: 20, firstWeekFromDay: 1, race: null });
    expect(phases).not.toContain('taper');
    expect(phases).not.toContain('race');
  });

  it('marque la première semaine entamée, et elle seule', () => {
    const phases = planPhases({ intent: 'race', weeks: 10, firstWeekFromDay: 4, race: null });
    expect(phases[0]).toBe('partial');
    expect(phases.slice(1)).not.toContain('partial');
  });

  it('réduit la base à une semaine sur un plan daté de moins de 8 semaines', () => {
    // 7 semaines dont 2 d'affûtage/course : cinq semaines à se partager, et
    // l'échéance ne laisse pas le temps d'en donner deux à la base.
    const phases = planPhases({ intent: 'race', weeks: 7, firstWeekFromDay: 1, race: TEN_K });
    expect(phases.filter((phase) => phase === 'base')).toHaveLength(1);
    expect(phases[0]).toBe('base');
    expect(phases.slice(1)).toEqual<PlanPhase[]>([
      'build',
      'build',
      'specific',
      'specific',
      'taper',
      'race',
    ]);
  });

  /*
   * Le raccourci ci-dessus suppose une échéance : « c'est du temps perdu » n'a de
   * sens que pour une athlète qui a une date. Sans date, un plan court garde la
   * base que son intention lui donne — sans quoi une reprise de six semaines,
   * dont la base est censée faire la moitié, n'en aurait plus qu'une.
   */
  it('garde sa base à un plan court sans date', () => {
    expect(planPhases({ intent: 'return', weeks: 6, firstWeekFromDay: 1, race: null })).toEqual<
      PlanPhase[]
    >(['base', 'base', 'base', 'build', 'build', 'build']);

    expect(
      planPhases({ intent: 'faster', weeks: 7, firstWeekFromDay: 1, race: null }).filter(
        (phase) => phase === 'base',
      ),
    ).toHaveLength(2);
  });

  /*
   * Les quatre intentions, sur la même durée : c'est le tableau qu'on relit pour
   * savoir ce qu'un plan de seize semaines **est**, selon ce qu'on lui demande.
   */
  describe('la périodisation de chaque intention', () => {
    const shape = (intent: PlanIntent, returnInjuryHistory = false): string =>
      planPhases({ intent, weeks: 16, firstWeekFromDay: 1, race: null, returnInjuryHistory })
        .reduce<[PlanPhase, number][]>((runs, phase) => {
          const last = runs[runs.length - 1];
          if (last !== undefined && last[0] === phase) last[1] += 1;
          else runs.push([phase, 1]);
          return runs;
        }, [])
        .map(([phase, count]) => `${count} ${phase}`)
        .join(' · ');

    it('donne à une préparation de course sa base de 30 % et sa spécificité', () => {
      expect(shape('race')).toBe('5 base · 6 build · 5 specific');
    });

    it('raccourcit la base d’une recherche de vitesse au profit du travail', () => {
      expect(shape('faster')).toBe('4 base · 7 build · 5 specific');
    });

    it('prolonge le développement d’une perte de poids et ne spécifie rien', () => {
      expect(shape('weight_loss')).toBe('6 base · 10 build');
    });

    it('donne à une reprise la moitié du plan en base, 60 % avec un antécédent', () => {
      expect(shape('return')).toBe('8 base · 8 build');
      // OR 7,56 (Relph 2023) : la seule variable du dossier qui déplace
      // franchement un paramètre.
      expect(shape('return', true)).toBe('10 base · 6 build');
    });
  });

  it('garde au moins une semaine à chaque phase présente', () => {
    for (let weeks = 3; weeks <= 52; weeks += 1) {
      const phases = planPhases({ intent: 'race', weeks, firstWeekFromDay: 1, race: null });
      // Sans course, toute la fenêtre est du développement : les trois phases y
      // sont dès qu'il y a la place.
      expect(phases.filter((phase) => phase === 'base').length).toBeGreaterThanOrEqual(1);
      expect(phases.filter((phase) => phase === 'build').length).toBeGreaterThanOrEqual(1);
      expect(phases.filter((phase) => phase === 'specific').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('ne recule jamais dans la progression des phases, quelle que soit l’intention', () => {
    const order: PlanPhase[] = ['partial', 'base', 'build', 'specific', 'taper', 'race'];
    for (let weeks = 3; weeks <= 52; weeks += 1) {
      for (const intent of INTENTS) {
        for (const race of [null, TEN_K, MARATHON]) {
          for (const firstWeekFromDay of [1, 4, 7]) {
            const phases = planPhases({ intent, weeks, firstWeekFromDay, race });
            const ranks = phases.map((phase) => order.indexOf(phase));
            const sorted = [...ranks].sort((left, right) => left - right);
            expect(ranks, `${intent}, ${weeks} semaines`).toEqual(sorted);
          }
        }
      }
    }
  });

  /*
   * La raison d'être de la recopie de segmentation : phases et volumes doivent
   * découper le plan au même endroit, sans quoi une semaine d'affûtage se verrait
   * attribuer une séance de développement.
   */
  it('segmente exactement comme les volumes cibles, quelle que soit l’intention', () => {
    for (let weeks = 1; weeks <= 52; weeks += 1) {
      for (const race of [null, TEN_K, MARATHON]) {
        for (let firstWeekFromDay = 1; firstWeekFromDay <= 7; firstWeekFromDay += 1) {
          const kinds = targetKinds(weeks, firstWeekFromDay, race);
          const where = `${weeks} semaines, départ jour ${firstWeekFromDay}, course ${String(race?.isMarathon)}`;
          // L'intention déplace la frontière base/build/spécifique, jamais celle
          // de l'affûtage ni de la semaine entamée : ce sont ces deux-là que les
          // volumes cibles connaissent aussi, et c'est là que les deux
          // arithmétiques doivent tomber d'accord.
          for (const intent of INTENTS) {
          const phases = planPhases({ intent, weeks, firstWeekFromDay, race });

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
    }
  });
});
