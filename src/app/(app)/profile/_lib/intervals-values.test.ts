import { describe, expect, it } from 'vitest';

import type { IntervalsSettingsDto } from '@/data/athlete';

import {
  EMPTY_INTERVALS_FORM_DEFAULTS,
  EMPTY_INTERVALS_FORM_VALUES,
  toIntervalsFormDefaults,
  toIntervalsFormValues,
} from './intervals-values';

/*
 * Aucun `vi.mock('server-only')` ici : ce module ne prend de `@/data/athlete`
 * que des types, effacés à la compilation — rien de `server-only` n'est chargé.
 */

describe('toIntervalsFormDefaults', () => {
  it("rend des valeurs vides quand le compte n'a pas encore d'athlète", () => {
    expect(toIntervalsFormDefaults(null)).toEqual(EMPTY_INTERVALS_FORM_DEFAULTS);
  });

  it("reporte l'identifiant et l'état de la clé", () => {
    const settings: IntervalsSettingsDto = {
      intervalsAthleteId: 'i671024',
      apiKey: 'configured',
    };

    expect(toIntervalsFormDefaults(settings)).toEqual({
      intervalsAthleteId: 'i671024',
      apiKeyState: 'configured',
    });
  });

  it("laisse le champ vide quand aucun identifiant n'est enregistré", () => {
    expect(
      toIntervalsFormDefaults({ intervalsAthleteId: null, apiKey: 'absent' }),
    ).toEqual({ intervalsAthleteId: '', apiKeyState: 'absent' });
  });

  it('conserve l’état « illisible » plutôt que de le confondre avec « absente »', () => {
    expect(
      toIntervalsFormDefaults({ intervalsAthleteId: 'i1', apiKey: 'unreadable' }),
    ).toMatchObject({ apiKeyState: 'unreadable' });
  });
});

describe('toIntervalsFormValues', () => {
  it('ne pré-remplit jamais le champ de clé, même quand une clé est enregistrée', () => {
    const values = toIntervalsFormValues({
      intervalsAthleteId: 'i671024',
      apiKeyState: 'configured',
    });

    expect(values).toEqual({
      intervalsAthleteId: 'i671024',
      apiKey: '',
      clearApiKey: false,
    });
  });

  it('part de champs vides à la création', () => {
    expect(toIntervalsFormValues(EMPTY_INTERVALS_FORM_DEFAULTS)).toEqual(
      EMPTY_INTERVALS_FORM_VALUES,
    );
  });
});
