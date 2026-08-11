import { describe, expect, it } from 'vitest';

import { PLAN_OUTPUT_BOUNDS, weeklySessionBudgets } from '@/lib/ai/plan-schema';

import { minFundableWeeklyKm, PlanSkeletonInfeasibleError } from './feasibility';

/*
 * Le minimum finançable ne se démontre pas, il se mesure : c'est une propriété
 * de `weeklySessionBudgets`, pas une formule qu'on aurait le droit d'énoncer à
 * côté. Ce fichier confronte donc systématiquement la fonction au balayage de la
 * décomposition qu'elle prétend décrire.
 */

/** La somme d'une décomposition, et ce qu'elle vaut face à sa cible. */
function decomposition(targetKm: number, sessionCount: number, qualityCount: number) {
  const budgets = weeklySessionBudgets(targetKm, sessionCount, qualityCount);
  const sum = budgets.reduce((total, budget) => total + budget.km, 0);
  return {
    budgets,
    sum,
    /** La semaine tombe exactement sur sa cible, sans séance sous le plancher. */
    finances:
      budgets.length > 0 &&
      Math.abs(sum - targetKm) < 1e-9 &&
      budgets.every((budget) => budget.km >= PLAN_OUTPUT_BOUNDS.distanceKm.min - 1e-9),
    /** La bande de ±10 % de `validatePlanBusinessRules`, celle que la revue a mesurée. */
    withinBand: sum <= targetKm * 1.1 + 1e-9 && sum >= targetKm * 0.9 - 1e-9,
  };
}

const SESSION_COUNTS = [1, 2, 3, 4, 5, 6, 7];
const QUALITY_COUNTS = [0, 1, 2, 3];

/** Le balayage de contrôle : de 0,1 à 60 km au dixième, comme la revue l'a fait. */
const SWEEP_TENTHS = 600;

describe('minFundableWeeklyKm', () => {
  it('coïncide avec le balayage de weeklySessionBudgets : rien n’échoue au-dessus, le seuil échoue', () => {
    for (const sessionCount of SESSION_COUNTS) {
      for (const qualityCount of QUALITY_COUNTS) {
        const minimum = minFundableWeeklyKm(sessionCount, qualityCount);
        const where = `${sessionCount} séances, ${qualityCount} qualité(s)`;
        expect(Number.isFinite(minimum), where).toBe(true);

        let lastFailing = 0;
        for (let tenths = 1; tenths <= SWEEP_TENTHS; tenths += 1) {
          const targetKm = tenths / 10;
          const { finances } = decomposition(targetKm, sessionCount, qualityCount);
          if (!finances) lastFailing = targetKm;
          if (targetKm >= minimum) {
            // La promesse de la fonction : au-dessus du minimum, la semaine
            // tombe exactement sur sa cible.
            expect(finances, `${where}, cible ${targetKm} km`).toBe(true);
          }
        }

        // … et le minimum est bien le plus petit qui la tienne : un dixième plus
        // bas, la décomposition échoue.
        expect(Math.round(minimum * 10) / 10, where).toBe(Math.round((lastFailing + 0.1) * 10) / 10);
      }
    }
  });

  /*
   * Les seuils mesurés par la revue, en deux qualités : la plus grande cible qui
   * sortait de la bande de ±10 %. Ils ne sont pas le minimum finançable — ils
   * lui sont **strictement inférieurs**, parce qu'une semaine peut être remontée
   * par le plancher sans pour autant sortir de la bande. C'est exactement la
   * classe de plans qu'un minimum calé sur la bande laissait passer, et qui
   * cassait ensuite la règle de la semaine allégée (945 plans invalides mesurés
   * sur 444 528 combinaisons).
   */
  const REVIEWED_BAND_THRESHOLDS: Record<number, number> = {
    2: 1.3,
    3: 1.7,
    4: 2.0,
    5: 2.7,
    6: 3.1,
    7: 4.9,
  };

  it('reste au-dessus des seuils de bande relevés par la revue', () => {
    for (const [sessions, threshold] of Object.entries(REVIEWED_BAND_THRESHOLDS)) {
      const sessionCount = Number(sessions);
      const where = `${sessionCount} séances`;

      // Le seuil relevé est bien la plus grande cible hors bande…
      let lastOutOfBand = 0;
      for (let tenths = 1; tenths <= SWEEP_TENTHS; tenths += 1) {
        const targetKm = tenths / 10;
        if (!decomposition(targetKm, sessionCount, 2).withinBand) lastOutOfBand = targetKm;
      }
      expect(Math.round(lastOutOfBand * 10) / 10, where).toBe(threshold);

      // … et le minimum finançable le domine, donc refuse tout ce que la revue
      // refusait, plus les semaines simplement remontées.
      expect(minFundableWeeklyKm(sessionCount, 2), where).toBeGreaterThan(threshold);
    }
  });

  it('n’exige que le plancher du contrat quand la semaine tient en une séance', () => {
    // Une séance unique EST la sortie longue : elle prend toute la cible, aucun
    // plancher ne peut mordre au-dessus de 0,5 km.
    expect(minFundableWeeklyKm(1, 0)).toBe(PLAN_OUTPUT_BOUNDS.distanceKm.min);
    expect(minFundableWeeklyKm(1, 2)).toBe(PLAN_OUTPUT_BOUNDS.distanceKm.min);
  });

  it('ne finance rien sans séance', () => {
    expect(minFundableWeeklyKm(0, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(minFundableWeeklyKm(-3, 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('borne le nombre de créneaux comme weeklySessionBudgets le borne', () => {
    // Trois créneaux sur quatre séances n'en font que deux : une semaine garde
    // toujours un footing à côté de sa sortie longue.
    expect(minFundableWeeklyKm(4, 3)).toBe(minFundableWeeklyKm(4, 2));
    expect(minFundableWeeklyKm(4, 9)).toBe(minFundableWeeklyKm(4, 2));
  });

  it('monte avec le nombre de séances : plus de planchers à payer', () => {
    for (let sessionCount = 2; sessionCount < 7; sessionCount += 1) {
      expect(
        minFundableWeeklyKm(sessionCount + 1, 2),
        `${sessionCount} → ${sessionCount + 1} séances`,
      ).toBeGreaterThanOrEqual(minFundableWeeklyKm(sessionCount, 2));
    }
  });

  it('est déterministe et mémoïsable : deux appels, même chiffre', () => {
    expect(minFundableWeeklyKm(6, 1)).toBe(minFundableWeeklyKm(6, 1));
  });

  /*
   * Le cas qui a ouvert le chantier, reproduit tel quel : débutante, meilleure
   * semaine récente 3 km, aucun budget temps, 6 séances, marathon dans 8
   * semaines → semaine 8, cible 2,9 km, décomposition à 3,5 km (+20,7 %).
   */
  it('refuse la cible de 2,9 km sur 6 séances qui a ouvert le chantier', () => {
    const { sum, finances } = decomposition(2.9, 6, 1);
    expect(sum).toBeCloseTo(3.5, 6);
    expect(finances).toBe(false);
    expect(minFundableWeeklyKm(6, 1)).toBeGreaterThan(2.9);
  });
});

describe('PlanSkeletonInfeasibleError', () => {
  const error = new PlanSkeletonInfeasibleError({
    weeks: [
      { weekNumber: 6, targetKm: 3.4, minimumKm: 3.5, sessionCount: 6, qualitySlotCount: 1 },
      { weekNumber: 8, targetKm: 2.9, minimumKm: 3.5, sessionCount: 6, qualitySlotCount: 1 },
    ],
    requestedSessionsPerWeek: 6,
    fundableSessionsPerWeek: 3,
  });

  it('porte de quoi écrire un message d’UI sans le deviner', () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PlanSkeletonInfeasibleError');
    expect(error.weeks.map((week) => week.weekNumber)).toEqual([6, 8]);
    expect(error.requestedSessionsPerWeek).toBe(6);
    expect(error.fundableSessionsPerWeek).toBe(3);
  });

  it('dit en français ce qui coince, la semaine la plus pauvre en tête', () => {
    expect(error.message).toContain('Semaines 6, 8');
    expect(error.message).toContain('2,9 km');
    expect(error.message).toContain('3,5 km');
    expect(error.message).toContain('3 séances par semaine au plus');
  });

  it('le dit au singulier pour une semaine seule, et sans repli quand rien ne tient', () => {
    const alone = new PlanSkeletonInfeasibleError({
      weeks: [{ weekNumber: 2, targetKm: 0, minimumKm: 1.5, sessionCount: 2, qualitySlotCount: 0 }],
      requestedSessionsPerWeek: 2,
      fundableSessionsPerWeek: 0,
    });
    expect(alone.message).toContain('Semaine 2');
    expect(alone.message).toContain('Aucun nombre de séances ne tient à ce volume.');
  });
});
