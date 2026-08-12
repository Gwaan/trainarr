import { describe, expect, it } from 'vitest';

import {
  PLAN_OUTPUT_BOUNDS,
  SESSION_BUDGET_SHARES,
  VOLUME_RULES,
  weeklySessionBudgets,
} from '@/lib/ai/plan-schema';

import {
  isDevelopmentPhase,
  QUALITY_SHARE,
  weeklyQualityShares,
  type CompositionAnchor,
} from './composition';
import { minFundableWeeklyKm } from './feasibility';
import type { PlanPhase } from './phases';

/** La périodisation d'un plan de seize semaines : 4 base, 6 build, 4 spécifique, affûtage, course. */
const SIXTEEN: PlanPhase[] = [
  'base',
  'base',
  'base',
  'base',
  'build',
  'build',
  'build',
  'build',
  'build',
  'build',
  'specific',
  'specific',
  'specific',
  'specific',
  'taper',
  'race',
];

/** Les dix rangs de développement de ce plan-là — ceux que la rampe traverse. */
const DEVELOPMENT_INDEXES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

describe('weeklyQualityShares', () => {
  it('laisse la base et l’affûtage hors de la rampe', () => {
    const shares = weeklyQualityShares(SIXTEEN);

    for (const index of [0, 1, 2, 3, 14, 15]) {
      expect(shares[index], `semaine ${index + 1}`).toBe(QUALITY_SHARE.outsideRamp);
    }
  });

  it('monte du bas au haut de la rampe sur le développement, sans jamais redescendre', () => {
    const shares = weeklyQualityShares(SIXTEEN);
    const ramp = DEVELOPMENT_INDEXES.map((index) => shares[index]);

    expect(ramp[0]).toBeCloseTo(QUALITY_SHARE.ramp.from, 10);
    expect(ramp[ramp.length - 1]).toBeCloseTo(QUALITY_SHARE.ramp.to, 10);
    for (let index = 1; index < ramp.length; index += 1) {
      expect(ramp[index], `rang ${index}`).toBeGreaterThan(ramp[index - 1]);
    }
  });

  it('rend une part par semaine, et rien du tout sans semaine', () => {
    expect(weeklyQualityShares(SIXTEEN)).toHaveLength(16);
    expect(weeklyQualityShares([])).toEqual([]);
  });

  it('donne le milieu de la rampe à un développement d’une seule semaine', () => {
    // Ni un début ni une fin de progression : le milieu est la seule réponse qui
    // ne soit pas arbitraire, et la plus proche des 16 % historiques.
    const middle = (QUALITY_SHARE.ramp.from + QUALITY_SHARE.ramp.to) / 2;
    expect(weeklyQualityShares(['base', 'build', 'taper'])[1]).toBeCloseTo(middle, 10);
  });

  /*
   * L'ancrage plan-relatif : le cœur du chantier. Une fenêtre reconstruite ne
   * connaît ni la longueur de la rampe ni sa position dedans — et si elle les
   * devinait sur elle-même, la composition se recalerait au bas de la
   * progression à chaque réadaptation.
   */
  describe('ancrage plan-relatif', () => {
    it('rend, sur une fenêtre, exactement ce que la création rend aux mêmes semaines', () => {
      const full = weeklyQualityShares(SIXTEEN);

      // Toutes les fenêtres possibles, de la plus longue à la plus courte.
      for (let windowWeeks = 1; windowWeeks <= SIXTEEN.length; windowWeeks += 1) {
        const offset = SIXTEEN.length - windowWeeks;
        const phases = SIXTEEN.slice(offset);
        const planDevelopmentWeeks = SIXTEEN.filter(isDevelopmentPhase).length;
        const anchor: CompositionAnchor = {
          planDevelopmentWeeks,
          completedDevelopmentWeeks: planDevelopmentWeeks - phases.filter(isDevelopmentPhase).length,
        };

        expect(weeklyQualityShares(phases, anchor), `fenêtre de ${windowWeeks} semaines`).toEqual(
          full.slice(offset),
        );
      }
    });

    it('garde le bon rang quand la fenêtre ramène sa première semaine à `partial`', () => {
      // Le piège de la soustraction : `remainingComposition` démote la première
      // semaine d'une fenêtre entamée, ce qui lui retire son rang de
      // développement. Un décompte du préfixe décalerait toutes les suivantes.
      const full = weeklyQualityShares(SIXTEEN);
      const offset = 6; // la fenêtre ouvre sur une semaine `build`
      const phases: PlanPhase[] = [...SIXTEEN.slice(offset)];
      phases[0] = 'partial';

      const planDevelopmentWeeks = SIXTEEN.filter(isDevelopmentPhase).length;
      const shares = weeklyQualityShares(phases, {
        planDevelopmentWeeks,
        completedDevelopmentWeeks: planDevelopmentWeeks - phases.filter(isDevelopmentPhase).length,
      });

      // La semaine démotée sort de la rampe ; toutes les autres gardent la part
      // que la création leur avait donnée.
      expect(shares[0]).toBe(QUALITY_SHARE.outsideRamp);
      expect(shares.slice(1)).toEqual(full.slice(offset + 1));
    });

    it('sans ancrage, se mesure sur la fenêtre — ce qui est le cas d’une création', () => {
      expect(weeklyQualityShares(SIXTEEN)).toEqual(
        weeklyQualityShares(SIXTEEN, {
          planDevelopmentWeeks: DEVELOPMENT_INDEXES.length,
          completedDevelopmentWeeks: 0,
        }),
      );
    });

    it('borne le rang à la rampe quand l’ancrage est incohérent', () => {
      // Un plan dont la durée enregistrée aurait divergé de sa fenêtre. La part
      // reste dans ses bornes plutôt que d'en sortir — et de là le minimum
      // finançable avec elle.
      const shares = weeklyQualityShares(['build', 'build'], {
        planDevelopmentWeeks: 2,
        completedDevelopmentWeeks: 40,
      });
      expect(shares).toEqual([QUALITY_SHARE.ramp.to, QUALITY_SHARE.ramp.to]);
    });
  });
});

/*
 * Ce que la rampe ne doit pas casser en chemin.
 *
 * La part de qualité entre dans `rest`, donc dans `balanced`, donc dans la part
 * de la sortie longue : les deux ne sont pas indépendantes, et faire monter
 * l'une déplace l'autre. Ce balayage vérifie que le déplacement reste dans ce
 * que `VOLUME_RULES.longRunShare` autorise — arrondis compris, puisque c'est
 * l'arrondi qui a tué le mécanisme essayé avant celui-ci.
 */
describe('la rampe et les bornes de la sortie longue', () => {
  const LONG_RUN_SESSION_FACTOR = 1.6;

  function longRunMaxShare(sessionCount: number): number {
    return Math.max(VOLUME_RULES.longRunShare.max, LONG_RUN_SESSION_FACTOR / sessionCount);
  }

  /** Toute l'amplitude de la rampe, au dixième de point — plus fin que ce qu'elle produit. */
  const SWEPT_SHARES = Array.from(
    { length: 41 },
    (_, step) =>
      QUALITY_SHARE.ramp.from + ((QUALITY_SHARE.ramp.to - QUALITY_SHARE.ramp.from) * step) / 40,
  ).concat(QUALITY_SHARE.outsideRamp);

  /**
   * Le seul coin où la décomposition sort déjà de la fourchette — **avant** la
   * rampe, et indépendamment d'elle.
   *
   * Mesuré : à 4 séances et 2 créneaux de qualité, une cible de 4,2 km donne une
   * sortie longue à 40,5 % et 4,3 km à 41,9 %, pour un plafond de 40 %. La cause
   * est la boucle de relève de `weeklySessionBudgets` — quand le plus gros
   * footing dépasse la sortie longue, celle-ci est remontée à son niveau, y
   * compris au-dessus du plafond que les bornes lui avaient posé. Ce n'est pas la
   * rampe qui l'ouvre : la part historique de 16 % le fait aussi, sur ces deux
   * cibles-là.
   *
   * Ce que la rampe change est l'**étendue** de ce coin, et seulement par le bas :
   * sous 16 %, le budget de qualité d'une si petite semaine s'arrondit à 0,5 km
   * au lieu de 1,0, ce qui laisse davantage au footing unique et déclenche la
   * relève sur 4,7 à 5,3 km également.
   *
   * Mesuré, l'extension va jusqu'à **15,9 %** : 4,7 km est fautive sur toute la
   * tranche 0,140 ≤ part ≤ 0,159 (part 0,15 → sortie longue de 1,9 km, soit
   * 40,43 % pour un plafond à 40 %), 4,9 km jusqu'à 0,153, et 5,1 à 5,3 km à la
   * seule part hors rampe de 0,14. À partir de 0,160, il ne reste que les deux
   * cibles pré-existantes.
   *
   * Le domaine concerné est celui d'une athlète visant **moins de 5,4 km par
   * semaine sur 4 séances** — la corriger demande de durcir `financesTarget`
   * (donc de refuser ces semaines au lieu de les écrire), ce qui déplace le
   * minimum finançable de 2,4 à 5,4 km sur cette configuration et casse la
   * monotonie que `feasibility.test.ts` documente. C'est un chantier à part
   * entière, et il est signalé comme tel plutôt que traité en passant.
   */
  function isKnownPreExistingBreach(sessionsPerWeek: number, quality: number, targetKm: number) {
    return sessionsPerWeek === 4 && quality >= 2 && targetKm <= 5.3;
  }

  it('laisse la sortie longue dans sa fourchette sur tout le domaine', () => {
    const failures: string[] = [];

    for (const sessionsPerWeek of [2, 3, 4, 5, 6, 7]) {
      for (const quality of [0, 1, 2, 3]) {
        for (const qualityShare of SWEPT_SHARES) {
          // De 0,5 à 80 km au dixième : on part du plancher du contrat de sortie,
          // pas d'un volume confortable — c'est en bas que les arrondis mordent.
          for (let tenths = 5; tenths <= 800; tenths += 1) {
            const targetKm = tenths / 10;
            if (isKnownPreExistingBreach(sessionsPerWeek, quality, targetKm)) continue;

            const budgets = weeklySessionBudgets(
              targetKm,
              sessionsPerWeek,
              quality,
              undefined,
              qualityShare,
            );
            const long = budgets.find((budget) => budget.role === 'long');
            if (long === undefined) continue;

            const share = long.km / targetKm;
            const where =
              `${sessionsPerWeek} séances, ${quality} qualité(s), ` +
              `part ${(qualityShare * 100).toFixed(2)} %, cible ${targetKm} km`;

            // Une semaine que le squelette refuserait de toute façon ne prouve
            // rien : c'est `minFundableWeeklyKm` qui la ferme, et il est éprouvé
            // ailleurs. On ne juge que ce qui peut réellement s'écrire.
            if (targetKm < minFundableWeeklyKm(sessionsPerWeek, quality, qualityShare)) continue;

            if (share < VOLUME_RULES.longRunShare.min - 1e-9) {
              failures.push(`${where} → sortie longue à ${(share * 100).toFixed(2)} %, sous 20 %.`);
            }
            if (share > longRunMaxShare(sessionsPerWeek) + 1e-9) {
              failures.push(
                `${where} → sortie longue à ${(share * 100).toFixed(2)} %, ` +
                  `au-dessus de ${(longRunMaxShare(sessionsPerWeek) * 100).toFixed(2)} %.`,
              );
            }
            // Et elle reste la plus longue séance de la semaine, ce que la
            // validation vérifie aussi.
            for (const budget of budgets) {
              if (budget.km > long.km + 1e-9) {
                failures.push(`${where} → une séance de ${budget.km} km dépasse la sortie longue.`);
              }
              if (budget.km < PLAN_OUTPUT_BOUNDS.distanceKm.min - 1e-9) {
                failures.push(`${where} → une séance de ${budget.km} km sous le plancher.`);
              }
            }
            if (failures.length >= 10) break;
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('le coin exclu est bien antérieur à la rampe, et non son fait', () => {
    // La démonstration de l'exclusion ci-dessus : la part historique — celle
    // d'avant ce module — sort déjà de la fourchette sur ces cibles-là. Si ce
    // test se met à passer, c'est que la boucle de relève a été corrigée et que
    // l'exclusion doit disparaître avec elle.
    const breaches = [4.2, 4.3].filter((targetKm) => {
      const budgets = weeklySessionBudgets(targetKm, 4, 2, undefined, SESSION_BUDGET_SHARES.quality);
      const long = budgets.find((budget) => budget.role === 'long');
      return long !== undefined && long.km / targetKm > longRunMaxShare(4) + 1e-9;
    });

    expect(breaches).toEqual([4.2, 4.3]);
  });
});
