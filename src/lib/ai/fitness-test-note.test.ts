import { describe, expect, it } from 'vitest';

import type { FitnessTestVerdict } from '@/lib/metrics/fitness-test';

import { fitnessTestNote } from './fitness-test-note';

const TESTED_ON = '2026-09-12';

/**
 * Le garde-fou de tout le chantier : **aucun recalcul silencieux**, et aucun
 * refus muet. Chaque verdict laisse une phrase que l'athlète peut lire sur la
 * page de son plan.
 */
describe('fitnessTestNote', () => {
  const VERDICTS: FitnessTestVerdict[] = [
    { outcome: 'improved', timeS: 1_540, vdot: 37.1, gain: 2.2 },
    { outcome: 'not-improved', timeS: 1_740, vdot: 32.4 },
    { outcome: 'not-maximal', reason: 'FC max atteinte 165 bpm, sous les 175 bpm attendus' },
    { outcome: 'too-soon', daysToWait: 8 },
    { outcome: 'unmeasurable', reason: 'aucun 5 km continu mesurable' },
  ];

  it('écrit une phrase datée pour chaque verdict, sans exception', () => {
    for (const verdict of VERDICTS) {
      const note = fitnessTestNote(verdict, TESTED_ON, null);
      expect(note, verdict.outcome).toContain('Test du');
      expect(note, verdict.outcome).toContain('septembre 2026');
      expect(note.length, verdict.outcome).toBeGreaterThan(40);
    }
  });

  it('annonce le chrono, le gain d’allure et la proposition quand le test améliore', () => {
    const note = fitnessTestNote(VERDICTS[0], TESTED_ON, {
      fromSecPerKm: 343,
      toSecPerKm: 312,
    });

    expect(note).toContain('25:40 sur 5 km');
    expect(note).toContain('VDOT de 37,1');
    expect(note).toContain('5:43/km à 5:12/km');
    expect(note).toContain('31 s/km de moins');
    // Au conditionnel : rien n'est appliqué tant que l'athlète n'a pas accepté
    // la réévaluation. Une note au passé décrirait un plan qui n'a pas changé.
    expect(note).toContain('passerait de');
    expect(note).toContain('le coach te propose de réécrire la fin du plan');
    expect(note).toContain('à accepter depuis la page du plan');
    expect(note).not.toContain('est réécrite');
  });

  it('reste lisible quand l’allure de seuil n’est pas calculable', () => {
    const note = fitnessTestNote(VERDICTS[0], TESTED_ON, null);

    expect(note).toContain('Tes allures peuvent être recalculées');
    expect(note).not.toContain('undefined');
  });

  /*
   * Le point le plus important à dire à l'athlète : un test moins bon ne
   * dégrade rien, et c'est **elle** qui garde la main si le niveau se confirme.
   */
  it('explique qu’une contre-performance ne dégrade rien, et qui décide', () => {
    const note = fitnessTestNote(VERDICTS[1], TESTED_ON, null);

    expect(note).toContain('29:00 sur 5 km');
    expect(note).toContain('Rien ne change');
    expect(note).toContain('réglages du plan');
  });

  it('dit le motif d’un refus, jamais un « non » sec', () => {
    expect(fitnessTestNote(VERDICTS[2], TESTED_ON, null)).toContain('165 bpm');
    expect(fitnessTestNote(VERDICTS[3], TESTED_ON, null)).toContain('8 jours');
    expect(fitnessTestNote(VERDICTS[4], TESTED_ON, null)).toContain('5 km continu');
  });

  it('accorde le singulier du dernier jour d’attente', () => {
    expect(fitnessTestNote({ outcome: 'too-soon', daysToWait: 1 }, TESTED_ON, null)).toContain(
      'dans 1 jour.',
    );
  });
});
