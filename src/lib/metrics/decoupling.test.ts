import { describe, expect, it } from 'vitest';

import { computeDecoupling } from './decoupling';

/**
 * Séance à 1 Hz de `count` secondes : `t = 0..count-1`, vitesse et FC données par
 * une fonction du temps.
 */
function run(
  count: number,
  speedAt: (second: number) => number | null,
  hrAt: (second: number) => number | null,
) {
  const time: number[] = [];
  const velocity: (number | null)[] = [];
  const heartrate: (number | null)[] = [];
  for (let second = 0; second < count; second += 1) {
    time.push(second);
    velocity.push(speedAt(second));
    heartrate.push(hrAt(second));
  }
  return { time, velocity, heartrate };
}

const FORTY_MINUTES = 2400;

describe('computeDecoupling', () => {
  it('rend un découplage nul sur un effort parfaitement stable', () => {
    const { time, velocity, heartrate } = run(
      FORTY_MINUTES,
      () => 3,
      () => 150,
    );
    const result = computeDecoupling(velocity, heartrate, time);

    expect(result).not.toBeNull();
    expect(result?.firstHalf.avgSpeedMps).toBeCloseTo(3, 9);
    expect(result?.firstHalf.avgHrBpm).toBeCloseTo(150, 9);
    expect(result?.firstHalf.ef).toBeCloseTo(0.02, 9);
    expect(result?.secondHalf.ef).toBeCloseTo(0.02, 9);
    expect(result?.decouplingPct).toBeCloseTo(0, 9);
  });

  it('rend un découplage positif quand la FC dérive à allure constante', () => {
    // 150 bpm sur la première moitié, 160 sur la seconde : l'efficience passe de
    // 3/150 à 3/160, soit −6,25 %.
    const { time, velocity, heartrate } = run(
      FORTY_MINUTES,
      () => 3,
      (second) => (second < 1200 ? 150 : 160),
    );
    const result = computeDecoupling(velocity, heartrate, time);

    expect(result?.firstHalf.avgHrBpm).toBeCloseTo(150, 9);
    expect(result?.secondHalf.avgHrBpm).toBeCloseTo(160, 9);
    expect(result?.decouplingPct).toBeCloseTo(6.25, 9);
  });

  it('rend un découplage négatif quand l’allure monte à FC constante', () => {
    const { time, velocity, heartrate } = run(
      FORTY_MINUTES,
      (second) => (second < 1200 ? 3 : 3.3),
      () => 150,
    );
    const result = computeDecoupling(velocity, heartrate, time);

    expect(result?.decouplingPct).toBeCloseTo(-10, 9);
  });

  it('coupe sur le temps en mouvement, pas sur le temps écoulé', () => {
    // 20 min à 150 bpm, 30 min d'auto-pause sans le moindre point, 20 min à
    // 156 bpm : la frontière doit tomber sur la pause, et chaque bloc être une
    // moitié. Découpée sur le temps écoulé, elle serait tombée en pleine pause
    // et la première moitié aurait avalé les deux blocs.
    const time: number[] = [];
    const velocity: number[] = [];
    const heartrate: number[] = [];
    for (let second = 0; second < 1200; second += 1) {
      time.push(second);
      velocity.push(3);
      heartrate.push(150);
    }
    for (let second = 3000; second < 4200; second += 1) {
      time.push(second);
      velocity.push(3);
      heartrate.push(156);
    }

    const result = computeDecoupling(velocity, heartrate, time);

    expect(result?.firstHalf.avgHrBpm).toBeCloseTo(150, 9);
    expect(result?.secondHalf.avgHrBpm).toBeCloseTo(156, 9);
    expect(result?.decouplingPct).toBeCloseTo(3.8461538, 6);
  });

  it('accepte une FC clairsemée', () => {
    // Ceinture qui n'écrit qu'un point sur quatre : elle couvre bien toute la
    // séance, la couverture ne doit pas être lue comme 25 %.
    const { time, velocity, heartrate } = run(
      FORTY_MINUTES,
      () => 3,
      (second) => (second % 4 === 0 ? 150 : null),
    );
    const result = computeDecoupling(velocity, heartrate, time);

    expect(result).not.toBeNull();
    expect(result?.firstHalf.avgHrBpm).toBeCloseTo(150, 9);
  });

  it('n’intègre pas les points à l’arrêt dans la vitesse moyenne', () => {
    // 100 s d'arrêt au milieu de la seconde moitié : la vitesse moyenne reste
    // celle de la course, pas une moyenne diluée par des zéros.
    const { time, velocity, heartrate } = run(
      FORTY_MINUTES,
      (second) => (second >= 1300 && second < 1400 ? 0 : 3),
      () => 150,
    );
    const result = computeDecoupling(velocity, heartrate, time);

    expect(result?.secondHalf.avgSpeedMps).toBeCloseTo(3, 9);
  });

  it('tolère un décrochage partiel de la ceinture', () => {
    // FC absente sur les 200 dernières secondes : ~83 % de la seconde moitié
    // reste couverte, au-dessus du seuil.
    const { time, velocity, heartrate } = run(
      FORTY_MINUTES,
      () => 3,
      (second) => (second < 2200 ? 150 : null),
    );

    expect(computeDecoupling(velocity, heartrate, time)).not.toBeNull();
  });

  it('ne calcule rien quand une moitié est trop peu couverte', () => {
    // FC absente à partir de la 1900e seconde : la seconde moitié n'est couverte
    // qu'à ~58 %, la comparer reviendrait à comparer deux durées différentes.
    const { time, velocity, heartrate } = run(
      FORTY_MINUTES,
      () => 3,
      (second) => (second < 1900 ? 150 : null),
    );

    expect(computeDecoupling(velocity, heartrate, time)).toBeNull();
  });

  it('ne calcule rien sous 20 minutes de temps en mouvement', () => {
    const short = run(
      1140, // 19 min
      () => 3,
      () => 150,
    );
    expect(computeDecoupling(short.velocity, short.heartrate, short.time)).toBeNull();

    const long = run(
      1260, // 21 min
      () => 3,
      () => 150,
    );
    expect(computeDecoupling(long.velocity, long.heartrate, long.time)).not.toBeNull();
  });

  it('ne calcule rien sans FC ni sans vitesse', () => {
    const { time, velocity, heartrate } = run(
      FORTY_MINUTES,
      () => 3,
      () => 150,
    );
    const nulls = new Array<number | null>(FORTY_MINUTES).fill(null);

    expect(computeDecoupling(velocity, nulls, time)).toBeNull();
    expect(computeDecoupling(nulls, heartrate, time)).toBeNull();
  });

  it('ne calcule rien sur des séries vides', () => {
    expect(computeDecoupling([], [], [])).toBeNull();
  });
});
