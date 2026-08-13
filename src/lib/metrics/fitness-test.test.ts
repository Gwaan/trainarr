import { describe, expect, it } from 'vitest';

import {
  fitnessTestVerdict,
  MAXIMAL_EFFORT_HR_SHARE,
  MIN_VDOT_GAIN,
  REFERENCE_UPDATE_MIN_GAP_DAYS,
  type FitnessTestInput,
} from './fitness-test';
import { vdotFromRace } from './vdot';

/**
 * L'athlète du projet : 5 km en 27:00 (VDOT 34,96), FC max 184 bpm au profil.
 * C'est le cas réel qui a fait écrire ce chantier — un chrono de référence qui
 * ne bouge jamais, sur un plan sans course.
 */
const REFERENCE_TIME_S = 27 * 60;
const REFERENCE_VDOT = vdotFromRace(5_000, REFERENCE_TIME_S);
const PROFILE_MAX_HR = 184;

/** Une lecture nominale : test bien mené, cadence respectée, FC au rendez-vous. */
function input(overrides: Partial<FitnessTestInput> = {}): FitnessTestInput {
  return {
    bestFiveKTimeS: 25 * 60 + 40,
    activityMaxHrBpm: 181,
    profileMaxHrBpm: PROFILE_MAX_HR,
    referenceVdot: REFERENCE_VDOT,
    daysSinceReference: 35,
    ...overrides,
  };
}

describe('fitnessTestVerdict', () => {
  it('met le chrono à jour quand le test est meilleur', () => {
    const verdict = fitnessTestVerdict(input());

    expect(verdict.outcome).toBe('improved');
    if (verdict.outcome !== 'improved') return;
    expect(verdict.timeS).toBe(25 * 60 + 40);
    expect(verdict.vdot).toBeGreaterThan(REFERENCE_VDOT);
    expect(verdict.gain).toBeGreaterThanOrEqual(MIN_VDOT_GAIN);
  });

  /*
   * L'asymétrie, et c'est le cœur du module : elle est l'**inverse** de celle
   * des volumes. Un test moins bon ne dégrade rien — Daniels ne baisse pas un
   * VDOT sur une contre-performance isolée.
   */
  it('ne dégrade jamais le chrono sur un test moins bon', () => {
    const verdict = fitnessTestVerdict(input({ bestFiveKTimeS: 29 * 60 }));

    expect(verdict.outcome).toBe('not-improved');
    if (verdict.outcome !== 'not-improved') return;
    // Le chrono couru est **rendu** : l'athlète doit pouvoir le lire, même si
    // rien ne bouge.
    expect(verdict.timeS).toBe(29 * 60);
    expect(verdict.vdot).toBeLessThan(REFERENCE_VDOT);
  });

  it('ignore une progression sous le bruit de mesure', () => {
    // 27:00 → 26:50 : dix secondes, soit ~0,26 point de VDOT, moins que ce
    // qu'une erreur de trace de 1 % suffit à produire.
    const verdict = fitnessTestVerdict(input({ bestFiveKTimeS: 26 * 60 + 50 }));

    expect(verdict.outcome).toBe('not-improved');
    if (verdict.outcome !== 'not-improved') return;
    expect(verdict.vdot - REFERENCE_VDOT).toBeLessThan(MIN_VDOT_GAIN);
    expect(verdict.vdot).toBeGreaterThan(REFERENCE_VDOT);
  });

  it('accepte dès que le gain dépasse le seuil, et pas avant', () => {
    // Autour de 27:00, un point de VDOT vaut 38 s : 27:00 − 38 s passe le seuil,
    // 27:00 − 37 s ne le passe pas.
    expect(fitnessTestVerdict(input({ bestFiveKTimeS: REFERENCE_TIME_S - 38 })).outcome).toBe(
      'improved',
    );
    expect(fitnessTestVerdict(input({ bestFiveKTimeS: REFERENCE_TIME_S - 37 })).outcome).toBe(
      'not-improved',
    );
  });

  /*
   * Le seuil est posé **au-dessus** du bruit de trace, et c'est tout son objet :
   * un demi-point — la valeur d'origine — était franchi dès 1,2 % de sur-lecture
   * de distance, si bien qu'une montre qui mesure long systématiquement aurait
   * fabriqué un `improved` à chaque fenêtre de cadence et fait accélérer les
   * allures sans le moindre progrès.
   */
  it('ne se laisse pas franchir par une erreur de trace ordinaire', () => {
    // La montre lit 5 000 m là où l'athlète en a couru moins : le meilleur
    // « 5 km » de la séance est donc atteint plus tôt, et le chrono est meilleur
    // d'autant. À 27:00 réels, 1 % de sur-lecture donne 26:44.
    const overRead = (share: number): number => REFERENCE_TIME_S / (1 + share);

    expect(fitnessTestVerdict(input({ bestFiveKTimeS: overRead(0.01) })).outcome).toBe(
      'not-improved',
    );
    expect(fitnessTestVerdict(input({ bestFiveKTimeS: overRead(0.02) })).outcome).toBe(
      'not-improved',
    );
    // Il faut 2,4 % d'erreur pour le franchir — au-delà de ce qu'une trace GPS
    // produit sur un parcours ordinaire.
    expect(fitnessTestVerdict(input({ bestFiveKTimeS: overRead(0.024) })).outcome).toBe('improved');
  });

  describe('validation de l’effort maximal', () => {
    it('refuse un effort qui n’approche pas la FC max du profil', () => {
      // 165 bpm sur 184 : 89,7 %, l'allure d'une séance de seuil appuyée.
      const verdict = fitnessTestVerdict(input({ activityMaxHrBpm: 165 }));

      expect(verdict.outcome).toBe('not-maximal');
      if (verdict.outcome !== 'not-maximal') return;
      expect(verdict.reason).toContain('165 bpm');
    });

    it('accepte tout juste au seuil, et refuse tout juste en dessous', () => {
      const required = PROFILE_MAX_HR * MAXIMAL_EFFORT_HR_SHARE;
      expect(fitnessTestVerdict(input({ activityMaxHrBpm: Math.ceil(required) })).outcome).toBe(
        'improved',
      );
      expect(fitnessTestVerdict(input({ activityMaxHrBpm: Math.floor(required) - 1 })).outcome).toBe(
        'not-maximal',
      );
    });

    it('ne conclut rien sans fréquence cardiaque, ni sur la séance ni au profil', () => {
      expect(fitnessTestVerdict(input({ activityMaxHrBpm: null })).outcome).toBe('not-maximal');
      expect(fitnessTestVerdict(input({ profileMaxHrBpm: null })).outcome).toBe('not-maximal');
      // Et le motif dit lequel des deux manque : un journal qui dirait
      // seulement « refusé » ne servirait à rien.
      const noProfile = fitnessTestVerdict(input({ profileMaxHrBpm: null }));
      expect(noProfile.outcome === 'not-maximal' && noProfile.reason).toContain('FC max au profil');
    });
  });

  describe('cadence', () => {
    it('refuse une mise à jour trop rapprochée de la précédente', () => {
      const verdict = fitnessTestVerdict(input({ daysSinceReference: 20 }));

      expect(verdict.outcome).toBe('too-soon');
      if (verdict.outcome !== 'too-soon') return;
      expect(verdict.daysToWait).toBe(REFERENCE_UPDATE_MIN_GAP_DAYS - 20);
    });

    it('tranche la cadence avant tout le reste', () => {
      // Un test trop tôt **et** sans FC : c'est la cadence qui répond, parce
      // qu'il n'y a pas lieu de discuter d'un chrono qu'on n'aurait pas retenu
      // de toute façon.
      const verdict = fitnessTestVerdict(
        input({ daysSinceReference: 3, activityMaxHrBpm: null }),
      );
      expect(verdict.outcome).toBe('too-soon');
    });

    it('accepte exactement au plancher', () => {
      expect(
        fitnessTestVerdict(input({ daysSinceReference: REFERENCE_UPDATE_MIN_GAP_DAYS })).outcome,
      ).toBe('improved');
    });
  });

  describe('mesure inexploitable', () => {
    it('refuse une séance sans 5 km continu', () => {
      const verdict = fitnessTestVerdict(input({ bestFiveKTimeS: null }));

      expect(verdict.outcome).toBe('unmeasurable');
      if (verdict.outcome !== 'unmeasurable') return;
      expect(verdict.reason).toContain('5 km');
    });

    it('refuse un chrono hors du domaine de validité du modèle', () => {
      // 5 km en 3 min : plus rapide que le record du monde, donc un VDOT
      // aberrant que `estimateVdot` refuse de rendre.
      expect(fitnessTestVerdict(input({ bestFiveKTimeS: 180 })).outcome).toBe('unmeasurable');
      // 5 km en 1 h 30 : le VDOT sort de la plage plausible par le bas.
      expect(fitnessTestVerdict(input({ bestFiveKTimeS: 5_400 })).outcome).toBe('unmeasurable');
    });
  });
});
