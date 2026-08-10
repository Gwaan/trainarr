import { describe, expect, it } from 'vitest';

import { isUniqueViolation, uniqueViolationConstraint } from './errors';

/** L'erreur telle que la lève le pilote `postgres`, sans emballage. */
function pgUniqueViolation(constraintName?: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    ...(constraintName === undefined ? {} : { constraint_name: constraintName }),
  });
}

/**
 * Ce que voit réellement le DAL : depuis drizzle-orm 0.45, l'erreur du pilote
 * remonte enveloppée dans un `DrizzleQueryError` qui ne porte ni `code` ni nom
 * de contrainte — seulement une `cause`.
 */
function wrapped(cause: unknown): Error {
  return Object.assign(new Error('Failed query: insert into "activities" ...'), {
    name: 'DrizzleQueryError',
    cause,
  });
}

describe('isUniqueViolation', () => {
  it('reconnaît l’erreur nue du pilote', () => {
    expect(isUniqueViolation(pgUniqueViolation())).toBe(true);
  });

  it('reconnaît l’erreur emballée par drizzle', () => {
    expect(isUniqueViolation(wrapped(pgUniqueViolation()))).toBe(true);
  });

  it('remonte plusieurs niveaux d’emballage', () => {
    expect(isUniqueViolation(wrapped(wrapped(pgUniqueViolation())))).toBe(true);
  });

  it('ignore une panne qui n’est pas une violation d’unicité', () => {
    expect(isUniqueViolation(wrapped(Object.assign(new Error('down'), { code: '08006' })))).toBe(
      false,
    );
  });

  it('ne se noie pas sur une valeur qui n’est pas une erreur', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('s’arrête sur une chaîne de causes cyclique', () => {
    // Une erreur qui se cite elle-même ferait tourner la remontée sans la borne.
    const loop: { cause?: unknown } = {};
    loop.cause = loop;

    expect(isUniqueViolation(loop)).toBe(false);
  });
});

describe('uniqueViolationConstraint', () => {
  it('rend le nom de la contrainte à travers l’emballage', () => {
    expect(uniqueViolationConstraint(wrapped(pgUniqueViolation('athlete_singleton')))).toBe(
      'athlete_singleton',
    );
  });

  it('accepte aussi le champ `constraint` des autres pilotes', () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'activities_fit_file_hash_unique',
    });

    expect(uniqueViolationConstraint(wrapped(error))).toBe('activities_fit_file_hash_unique');
  });

  it('rend `null` quand la violation ne nomme aucune contrainte', () => {
    expect(uniqueViolationConstraint(pgUniqueViolation())).toBeNull();
  });

  it('rend `null` quand l’erreur n’est pas une violation d’unicité', () => {
    expect(uniqueViolationConstraint(new Error('boom'))).toBeNull();
  });
});
