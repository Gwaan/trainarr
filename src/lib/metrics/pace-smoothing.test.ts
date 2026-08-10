import { describe, expect, it } from 'vitest';

import { smoothPace } from './pace-smoothing';

/** Série 1 Hz de `count` secondes, vitesse donnée par une fonction du temps. */
function series(count: number, speedAt: (second: number) => number) {
  const time: number[] = [];
  const velocity: number[] = [];
  for (let second = 0; second < count; second += 1) {
    time.push(second);
    velocity.push(speedAt(second));
  }
  return { time, velocity };
}

describe('smoothPace', () => {
  it('rend une allure constante sur une vitesse constante', () => {
    const { time, velocity } = series(120, () => 3);
    const paces = smoothPace(velocity, time);

    expect(paces).toHaveLength(120);
    for (const pace of paces) {
      expect(pace).toBeCloseTo(1000 / 3, 6);
    }
  });

  it('gomme le bruit alterné du GPS', () => {
    // ±0,5 m/s d'un point au suivant autour de 3 m/s : brut, l'allure oscille
    // entre 4:46/km et 6:40/km — illisible.
    const { time, velocity } = series(120, (second) => (second % 2 === 0 ? 3.5 : 2.5));
    const paces = smoothPace(velocity, time);

    const middle = paces[60];
    expect(middle).not.toBeNull();
    expect(Math.abs((middle ?? 0) - 1000 / 3)).toBeLessThan(5);
  });

  it('préserve une accélération réelle de 20 s', () => {
    const { time, velocity } = series(180, (second) => (second >= 60 && second < 80 ? 5 : 3));
    const paces = smoothPace(velocity, time);

    // Au cœur de la relance, la fenêtre de 15 s tient entièrement dedans.
    expect(paces[70]).toBeCloseTo(200, 6);
    // Loin de la relance, l'allure de fond est intacte.
    expect(paces[10]).toBeCloseTo(1000 / 3, 6);
    expect(paces[150]).toBeCloseTo(1000 / 3, 6);
  });

  it('déclare l’allure non définie à l’arrêt', () => {
    const { time, velocity } = series(120, (second) => (second < 60 ? 3 : 0.05));
    const paces = smoothPace(velocity, time);

    expect(paces[10]).not.toBeNull();
    expect(paces[100]).toBeNull();
  });

  it('borne l’arrêt à 0,5 m/s exactement', () => {
    const { time, velocity } = series(60, () => 0.5);
    expect(smoothPace(velocity, time)[30]).toBeCloseTo(2000, 6);

    const slower = series(60, () => 0.49);
    expect(smoothPace(slower.velocity, slower.time)[30]).toBeNull();
  });

  it('dérive la fenêtre du pas temporel réel, pas d’un nombre de points', () => {
    // Échantillonnage à 5 s (enregistrement « intelligent ») : marche de 2 à
    // 4 m/s à t = 50 s. Une fenêtre de 15 *points* couvrirait 75 s et traînerait
    // l'ancienne vitesse jusqu'au bout ; une fenêtre de 15 *secondes* non.
    const time: number[] = [];
    const velocity: number[] = [];
    for (let second = 0; second <= 95; second += 5) {
      time.push(second);
      velocity.push(second < 50 ? 2 : 4);
    }

    const paces = smoothPace(velocity, time);
    expect(paces[paces.length - 1]).toBeCloseTo(250, 6);
    expect(paces[0]).toBeCloseTo(500, 6);
  });

  it('ne laisse pas un trou d’enregistrement dicter l’allure', () => {
    // Course à 3 m/s, auto-pause de 300 s, puis la montre reprend alors que
    // l'athlète marche encore (0,6 m/s) avant de relancer à 3 m/s.
    // Sans plafond, ce point de reprise pesait (401 − 100) / 2 = 150,5 s dans
    // une fenêtre de 15 s : les secondes de course qui le suivent s'affichaient
    // à 1 310 s/km, soit 21:50/km — une allure de marche.
    const time: number[] = [];
    const velocity: number[] = [];
    for (let second = 0; second <= 100; second += 1) {
      time.push(second);
      velocity.push(3);
    }
    time.push(400);
    velocity.push(0.6);
    for (let second = 401; second <= 500; second += 1) {
      time.push(second);
      velocity.push(3);
    }

    const paces = smoothPace(velocity, time);
    const justAfterPause = paces[time.indexOf(404)];

    expect(justAfterPause).not.toBeNull();
    expect(justAfterPause).toBeLessThan(420);
    // Une fois le point de reprise sorti de la fenêtre, l'allure est intacte.
    expect(paces[time.indexOf(420)]).toBeCloseTo(1000 / 3, 6);
  });

  it('ne laisse aucun échantillon peser plus que la fenêtre qu’il traverse', () => {
    // Pas de 6 s : la durée d'un échantillon (6 s) déborde du demi-tour de
    // fenêtre. Pondérer par la durée entière donnait le même poids aux trois
    // points de la fenêtre (250 s/km) ; ne compter que la portion réellement
    // couverte recentre la moyenne sur le point courant.
    const time: number[] = [];
    const velocity: number[] = [];
    for (let second = 0; second <= 60; second += 6) {
      time.push(second);
      velocity.push(second === 30 ? 6 : 3);
    }

    const paces = smoothPace(velocity, time);
    expect(paces[5]).toBeCloseTo(1000 / 4.2, 6);
  });

  it('ne rend rien pour les positions sans temps associé', () => {
    expect(smoothPace([3, 3, 3], [0, 1])).toEqual([1000 / 3, 1000 / 3, null]);
    expect(smoothPace([], [])).toEqual([]);
  });
});
