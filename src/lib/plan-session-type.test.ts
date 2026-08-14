import { describe, expect, it } from 'vitest';

import { FITNESS_TEST_KIND, QUALITY_ZONE_KINDS, SESSION_KINDS } from '@/lib/plan-skeleton';

import {
  sessionType,
  sessionTypesPresent,
  SESSION_TYPE_LABELS,
  SESSION_TYPE_TOKENS,
  type SessionTypeToken,
} from './plan-session-type';

/**
 * Le contrat de ce module tient en une phrase : **tout `kind` que l'appli écrit
 * a une couleur, et rien d'autre n'en a une**. Les deux moitiés se testent
 * contre les constantes réelles du squelette — recopier les libellés ici
 * laisserait la table diverger le jour où l'une d'elles change.
 */

/** Le type attendu pour chaque `kind` du vocabulaire de l'appli. */
const CANONICAL_KINDS = [
  [SESSION_KINDS.recovery, 'type-recovery'],
  [SESSION_KINDS.easy, 'type-easy'],
  [SESSION_KINDS.longRun, 'type-long'],
  [SESSION_KINDS.race, 'type-event'],
  [QUALITY_ZONE_KINDS.marathon, 'type-specific'],
  [QUALITY_ZONE_KINDS.threshold, 'type-threshold'],
  [QUALITY_ZONE_KINDS.interval, 'type-interval'],
  [QUALITY_ZONE_KINDS.repetition, 'type-repetition'],
  [FITNESS_TEST_KIND, 'type-event'],
] as const satisfies readonly (readonly [string, SessionTypeToken])[];

describe('sessionType', () => {
  it.each(CANONICAL_KINDS)('range « %s » en %s', (kind, token) => {
    expect(sessionType(kind)?.token).toBe(token);
  });

  it('couvre tout le vocabulaire que l\'appli écrit', () => {
    const kinds = [
      ...Object.values(SESSION_KINDS),
      ...Object.values(QUALITY_ZONE_KINDS),
      FITNESS_TEST_KIND,
    ];
    expect(kinds.every((kind) => sessionType(kind) !== null)).toBe(true);
  });

  it('use les huit jetons, et pas un de plus', () => {
    const tokens = new Set(CANONICAL_KINDS.map(([, token]) => token));
    // Les huit jetons du système moins celui que seul un test peut porter :
    // course et test partagent `type-event`, donc huit `kind` pour huit jetons.
    expect([...tokens].sort()).toEqual([...SESSION_TYPE_TOKENS].sort());
  });

  it.each([
    ['VMA courte · piste', 'type-interval'],
    ['VMA longue', 'type-interval'],
    ['Seuil · côtes', 'type-threshold'],
    ['Répétitions courtes', 'type-repetition'],
    ['Sortie longue spécifique', 'type-long'],
    ['Endurance fondamentale · lignes droites', 'type-easy'],
    ['Récupération active', 'type-recovery'],
    ['Test 5 km', 'type-event'],
  ] as const satisfies readonly (readonly [string, SessionTypeToken])[])(
    'tient le suffixe de « %s »',
    (kind, token) => {
      expect(sessionType(kind)?.token).toBe(token);
    },
  );

  it('ne confond pas « Spécifique allure course » avec la course', () => {
    // Le mot « course » est dans les deux libellés : c'est la comparaison par
    // tête, et non par inclusion, qui les sépare.
    expect(sessionType(QUALITY_ZONE_KINDS.marathon)?.token).toBe('type-specific');
    expect(sessionType(SESSION_KINDS.race)?.token).toBe('type-event');
  });

  it('lit un libellé sans accents ni majuscules comme le libellé accentué', () => {
    expect(sessionType('RECUPERATION')?.token).toBe('type-recovery');
    expect(sessionType('  Répétitions  ')?.token).toBe('type-repetition');
  });

  it('rend le nom du type, jamais le kind suffixé', () => {
    expect(sessionType('VMA courte · piste')?.label).toBe(SESSION_TYPE_LABELS['type-interval']);
    expect(sessionType(FITNESS_TEST_KIND)?.label).toBe(SESSION_TYPE_LABELS['type-event']);
  });

  it.each(['Footing', 'Endurance', 'Côtes', 'Fractionné', 'Séance mystère', ''])(
    'rend null sur « %s », qu\'aucune couleur ne doit prétendre nommer',
    (kind) => {
      expect(sessionType(kind)).toBeNull();
    },
  );
});

describe('sessionTypesPresent', () => {
  it('déduplique et range dans l\'ordre du système', () => {
    const types = sessionTypesPresent([
      SESSION_KINDS.race,
      'VMA courte · piste',
      SESSION_KINDS.easy,
      'VMA longue',
      FITNESS_TEST_KIND,
    ]);
    expect(types.map((type) => type.token)).toEqual(['type-easy', 'type-interval', 'type-event']);
  });

  it('ignore les kinds inconnus', () => {
    expect(sessionTypesPresent(['Footing', 'Endurance'])).toEqual([]);
  });

  it('rend une liste vide sur un mois sans séance', () => {
    expect(sessionTypesPresent([])).toEqual([]);
  });
});
