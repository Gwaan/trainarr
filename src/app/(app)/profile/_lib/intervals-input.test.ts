import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { apiKeyOutcome, parseIntervalsFields } from './intervals-input';
import { CLEAR_API_KEY_VALUE } from './intervals-state';

// `intervals-input` importe les bornes du DAL, qui est `server-only`.
vi.mock('server-only', () => ({}));

const KEY = 'k'.repeat(40);

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe('parseIntervalsFields', () => {
  it("détoure l'identifiant et transmet la clé saisie", () => {
    const result = parseIntervalsFields(
      form({ intervalsAthleteId: '  i671024  ', apiKey: `  ${KEY}  ` }),
    );

    expect(result).toEqual({
      ok: true,
      value: { intervalsAthleteId: 'i671024', apiKey: KEY },
    });
  });

  it('ne touche pas à la clé enregistrée quand le champ est laissé vide', () => {
    const result = parseIntervalsFields(form({ intervalsAthleteId: 'i1', apiKey: '' }));

    expect(result.ok).toBe(true);
    // `undefined` et non `null` : un champ de secret vide veut dire « je n'y
    // touche pas », jamais « efface ».
    expect(result.ok && 'apiKey' in result.value).toBe(false);
  });

  it('efface la clé quand la case est cochée', () => {
    const result = parseIntervalsFields(
      form({ intervalsAthleteId: 'i1', apiKey: '', clearApiKey: CLEAR_API_KEY_VALUE }),
    );

    expect(result).toEqual({ ok: true, value: { intervalsAthleteId: 'i1', apiKey: null } });
  });

  it('ignore une valeur de case inattendue plutôt que de prendre un effacement pour acquis', () => {
    const result = parseIntervalsFields(form({ apiKey: '', clearApiKey: 'peut-être' }));

    expect(result.ok && 'apiKey' in result.value).toBe(false);
  });

  it('refuse de deviner entre effacer et remplacer', () => {
    const result = parseIntervalsFields(
      form({ apiKey: KEY, clearApiKey: CLEAR_API_KEY_VALUE }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.fieldErrors.apiKey).toEqual(expect.any(String));
  });

  it('borne la longueur des deux champs', () => {
    const tooLongId = parseIntervalsFields(form({ intervalsAthleteId: 'i'.repeat(65) }));
    const tooLongKey = parseIntervalsFields(form({ apiKey: 'k'.repeat(257) }));

    expect(tooLongId.ok === false && tooLongId.fieldErrors.intervalsAthleteId).toEqual(
      expect.any(String),
    );
    expect(tooLongKey.ok === false && tooLongKey.fieldErrors.apiKey).toEqual(
      expect.any(String),
    );
  });

  it('ne cite jamais la clé reçue dans son message de refus', () => {
    const result = parseIntervalsFields(form({ apiKey: 'k'.repeat(257) }));

    expect(JSON.stringify(result)).not.toContain('kkk');
  });

  it('accepte un formulaire qui ne porte aucun des deux champs', () => {
    // C'est le cas du profil en édition : ses champs intervals.icu vivent
    // ailleurs, et leur absence ne doit pas être une erreur.
    expect(parseIntervalsFields(form())).toEqual({
      ok: true,
      value: { intervalsAthleteId: '' },
    });
  });
});

describe('apiKeyOutcome', () => {
  it.each([
    ['kept', { intervalsAthleteId: 'i1' }],
    ['replaced', { intervalsAthleteId: 'i1', apiKey: KEY }],
    ['cleared', { intervalsAthleteId: 'i1', apiKey: null }],
  ] as const)('rapporte « %s »', (expected, value) => {
    expect(apiKeyOutcome(value)).toBe(expected);
  });
});
