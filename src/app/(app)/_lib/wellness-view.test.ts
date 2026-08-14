import { describe, expect, it } from 'vitest';

import { isWellnessTileEmpty, toWellnessTileView } from './wellness-view';

/** 14 h locales le 13 août 2026 — le « maintenant » de tous ces tests. */
const NOW = new Date('2026-08-13T12:00:00Z');
const TODAY = '2026-08-13';

describe('toWellnessTileView', () => {
  it('formate chaque mesure avec son unité', () => {
    const view = toWellnessTileView(
      {
        today: TODAY,
        restingHr: { value: 47, day: TODAY },
        hrv: { value: 63.4, day: TODAY, variant: 'rmssd' },
        sleep: { value: 25_800, day: TODAY },
      },
      NOW,
    );

    expect(view.restingHr).toEqual({ value: '47', unit: 'bpm', observedOn: null });
    expect(view.hrv).toEqual({ value: '63', unit: 'ms', observedOn: null });
    // La tuile dit **laquelle** des deux HRV elle montre : un SDNN affiché sous
    // « HRV » se comparerait à des repères de rMSSD.
    expect(view.hrvLabel).toBe('HRV (rMSSD)');
    // La durée porte déjà son unité : en ajouter une donnerait « 7 h 10 h ».
    expect(view.sleep).toEqual({ value: '7 h 10', unit: '', observedOn: null });
  });

  it('ne date pas une mesure du jour, et date toutes les autres', () => {
    const view = toWellnessTileView(
      {
        today: TODAY,
        restingHr: { value: 47, day: TODAY },
        hrv: { value: 63, day: '2026-08-12', variant: 'rmssd' },
        sleep: { value: 25_800, day: '2026-08-04' },
      },
      NOW,
    );

    expect(view.restingHr?.observedOn).toBeNull();
    expect(view.hrv?.observedOn).toBe('hier');
    expect(view.sleep?.observedOn).toBe('4 août');
  });

  it('rend une mesure absente comme absente, mesure par mesure', () => {
    // Une nuit sans ceinture donne un sommeil sans HRV : les trois dates sont
    // cherchées séparément, et une absence n'en emporte aucune autre.
    const view = toWellnessTileView(
      {
        today: TODAY,
        restingHr: { value: 47, day: TODAY },
        hrv: null,
        sleep: { value: 25_800, day: TODAY },
      },
      NOW,
    );

    expect(view.hrv).toBeNull();
    // Sans mesure, aucune variante n'est annoncée : la colonne garde son titre
    // pour dire l'absence, elle n'affirme pas une grandeur qu'on n'a pas.
    expect(view.hrvLabel).toBe('HRV');
    expect(view.restingHr).not.toBeNull();
    expect(view.sleep).not.toBeNull();
  });

  it('étiquette la variante que la montre a poussée', () => {
    const view = toWellnessTileView(
      {
        today: TODAY,
        restingHr: null,
        hrv: { value: 45.5, day: TODAY, variant: 'sdnn' },
        sleep: null,
      },
      NOW,
    );

    expect(view.hrvLabel).toBe('HRV (SDNN)');
    expect(view.hrv).toEqual({ value: '46', unit: 'ms', observedOn: null });
  });

  it('n’invente aucun zéro quand tout manque', () => {
    const view = toWellnessTileView(
      { today: TODAY, restingHr: null, hrv: null, sleep: null },
      NOW,
    );

    expect(view).toEqual({ restingHr: null, hrvLabel: 'HRV', hrv: null, sleep: null });
  });
});

describe('isWellnessTileEmpty', () => {
  it('est vraie seulement quand les trois mesures manquent', () => {
    const empty = toWellnessTileView(
      { today: TODAY, restingHr: null, hrv: null, sleep: null },
      NOW,
    );
    const partial = toWellnessTileView(
      { today: TODAY, restingHr: null, hrv: { value: 63, day: TODAY, variant: 'sdnn' }, sleep: null },
      NOW,
    );

    expect(isWellnessTileEmpty(empty)).toBe(true);
    expect(isWellnessTileEmpty(partial)).toBe(false);
  });
});
