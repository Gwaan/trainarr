import { describe, expect, it } from 'vitest';

import { SUSTAINED_HR_WINDOW_S, sustainedMaxHrBpm } from './sustained-hr';

/** Axe des temps dense à 1 Hz, de la longueur d'un flux donné. */
function seconds(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/** `count` échantillons à la même fréquence — de quoi composer un profil. */
function hold(bpm: number, count: number): number[] {
  return Array.from({ length: count }, () => bpm);
}

describe('sustainedMaxHrBpm', () => {
  it('vaut la fenêtre la plus haute tenue cinq secondes', () => {
    // Un plateau de huit secondes à 192 : largement de quoi loger une fenêtre.
    const hr = [...hold(150, 20), ...hold(192, 8), ...hold(150, 20)];

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(192);
  });

  it('rejette un pic isolé — le maximum brut n’est pas la FC soutenue', () => {
    const hr = [...hold(180, 30), 221, ...hold(180, 30)];

    expect(Math.max(...hr)).toBe(221);
    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(180);
  });

  it('rejette aussi un artefact de deux échantillons consécutifs', () => {
    const hr = [...hold(180, 30), 218, 220, ...hold(180, 30)];

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(180);
  });

  it('accepte un plateau qui dure exactement la fenêtre', () => {
    // Six échantillons à 1 Hz couvrent exactement cinq secondes (0 → 5).
    const hr = [...hold(150, 10), ...hold(190, 6), ...hold(150, 10)];

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(190);
  });

  it('refuse un plateau plus court que la fenêtre', () => {
    // Cinq échantillons ne couvrent que quatre secondes.
    const hr = [...hold(150, 10), ...hold(190, 5), ...hold(150, 10)];

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(150);
  });

  it('ne fait pas enjamber un trou à une fenêtre', () => {
    // Trois secondes à 195, une pause de trois minutes, trois secondes à 195 :
    // six échantillons hauts, mais jamais cinq secondes d’affilée.
    const hr = [...hold(150, 20), ...hold(195, 3), ...hold(195, 3), ...hold(150, 20)];
    const time = [
      ...seconds(23),
      ...[0, 1, 2].map((offset) => 203 + offset),
      ...Array.from({ length: 20 }, (_, index) => 206 + index),
    ];

    expect(time).toHaveLength(hr.length);
    expect(sustainedMaxHrBpm(hr, time)).toBe(150);
  });

  it('tient compte des trous relativement au pas de la série', () => {
    // Ceinture en mode économie : une mesure toutes les 30 s. Deux mesures
    // consécutives couvrent bien plus que la fenêtre, et rien n’est un trou
    // (le plafond vaut trois fois le pas médian, soit 90 s).
    const hr = [150, 150, 188, 188, 150];
    const time = [0, 30, 60, 90, 120];

    expect(sustainedMaxHrBpm(hr, time)).toBe(188);
  });

  it('saute les index où le capteur n’a rien dit, sans décaler l’axe', () => {
    // Canal clairsemé : la moitié des points sont muets. Les mesures présentes
    // couvrent tout de même une fenêtre continue à 186 (t=4 → t=10), et c'est
    // bien l'axe des temps qui la mesure, pas le nombre d'échantillons.
    const hr = [150, null, 150, null, 186, null, 186, null, 186, null, 186, null, 150];

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(186);
  });

  it('rend null sur un flux plus court que la fenêtre', () => {
    const hr = hold(190, 4);

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(null);
  });

  it('rend null sur un flux vide', () => {
    expect(sustainedMaxHrBpm([], [])).toBe(null);
  });

  it('rend null quand le canal cardiaque est entièrement muet', () => {
    expect(sustainedMaxHrBpm([null, null, null, null, null, null], seconds(6))).toBe(null);
  });

  it('rend null sur un point unique — un instant n’a pas de durée', () => {
    expect(sustainedMaxHrBpm([195], [0])).toBe(null);
  });

  it('écarte les fréquences non mesurées écrites en zéro', () => {
    const hr = [...hold(0, 10), ...hold(178, 10)];

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(178);
  });

  it('écarte un instant qui recule plutôt que de mesurer une durée négative', () => {
    // L’échantillon à t=2 revient en arrière : il est ignoré, la fenêtre reste
    // établie sur les instants croissants.
    const hr = [188, 188, 210, 188, 188, 188, 188];
    const time = [0, 1, 0, 2, 3, 4, 5];

    expect(sustainedMaxHrBpm(hr, time)).toBe(188);
  });

  it('ignore les valeurs non finies', () => {
    const hr = [...hold(175, 10), Number.NaN, ...hold(175, 10)];

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(175);
  });

  it('supporte un axe plus court que le canal — la longueur commune fait foi', () => {
    const hr = hold(180, 20);

    expect(sustainedMaxHrBpm(hr, seconds(3))).toBe(null);
    expect(sustainedMaxHrBpm(hr, seconds(10))).toBe(180);
  });

  it('retient la plus haute des fenêtres soutenues, pas la dernière', () => {
    const hr = [...hold(196, 8), ...hold(150, 10), ...hold(184, 8)];

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(196);
  });

  it('arrondit à l’entier — la colonne du schéma est entière', () => {
    const hr = hold(187.4, 8);

    expect(sustainedMaxHrBpm(hr, seconds(hr.length))).toBe(187);
  });

  it('expose la fenêtre retenue', () => {
    expect(SUSTAINED_HR_WINDOW_S).toBe(5);
  });
});
