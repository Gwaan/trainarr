import { describe, expect, it } from 'vitest';

import { computeHrZones, hrZoneAnchor, hrZoneOf, type HrZoneAnchor } from './hr-zones';

/** L'ancrage historique : une FC max de 200, sans FC seuil adoptée. */
const MAX_HR: HrZoneAnchor = { kind: 'max-hr', bpm: 200 };

/** Série 1 Hz de `count` secondes, FC donnée par une fonction du temps. */
function series(count: number, hrAt: (second: number) => number) {
  const time: number[] = [];
  const hr: number[] = [];
  for (let second = 0; second < count; second += 1) {
    time.push(second);
    hr.push(hrAt(second));
  }
  return { time, hr };
}

describe('computeHrZones', () => {
  it('rend les cinq zones, y compris celles à zéro', () => {
    const { time, hr } = series(100, () => 150);
    const zones = computeHrZones(hr, time, MAX_HR);

    expect(zones.map((zone) => zone.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(zones.filter((zone) => zone.timeS > 0)).toHaveLength(1);
  });

  it('classe chaque frontière dans la zone supérieure', () => {
    // 120 = 60 %, 140 = 70 %, 160 = 80 %, 180 = 90 % de 200.
    const boundaries: Array<[number, number]> = [
      [119, 1],
      [120, 2],
      [139, 2],
      [140, 3],
      [159, 3],
      [160, 4],
      [179, 4],
      [180, 5],
      [200, 5],
    ];

    for (const [beats, expected] of boundaries) {
      const { time, hr } = series(10, () => beats);
      const zones = computeHrZones(hr, time, MAX_HR);
      const occupied = zones.filter((zone) => zone.timeS > 0);

      expect(occupied).toHaveLength(1);
      expect(occupied[0].zone).toBe(expected);
    }
  });

  it('compte les échantillons sous 50 % de FC max en zone 1', () => {
    const { time, hr } = series(60, () => 80); // 40 % de FC max
    const zones = computeHrZones(hr, time, MAX_HR);

    expect(zones[0].timeS).toBe(59);
    expect(zones[0].share).toBe(1);
  });

  it('pondère par le pas temporel réel, pas par le nombre de points', () => {
    // Enregistrement « intelligent » : 10 s de zone 5 échantillonnées à 1 Hz
    // (11 points), puis 60 s de zone 2 échantillonnées toutes les 3 s
    // (20 points). Compter les points donnerait 35 % de zone 5 ; le temps dit
    // 16 %. Aucun pas ne dépasse le plafond : rien n'est écarté.
    const time: number[] = [];
    const hr: number[] = [];
    for (let second = 0; second <= 10; second += 1) {
      time.push(second);
      hr.push(190);
    }
    for (let second = 13; second <= 70; second += 3) {
      time.push(second);
      hr.push(130);
    }

    const zones = computeHrZones(hr, time, MAX_HR);
    const zone2 = zones[1];
    const zone5 = zones[4];

    expect(zone5.timeS).toBe(11.5);
    expect(zone2.timeS).toBe(58.5);
    expect(zone5.timeS + zone2.timeS).toBe(70);
    expect(zone2.share + zone5.share).toBeCloseTo(1, 12);
  });

  it('ne compte pas une pause d’enregistrement comme du temps en zone', () => {
    // 10 min à 150 bpm (zone 3), 20 min d'auto-pause sans le moindre point,
    // 10 min à 110 bpm (zone 1). Le total mesuré est de 20 min ; la règle du
    // point milieu seule attribuait la moitié du trou à chaque bord et le
    // panneau annonçait 40:00 (2 399 s).
    const time: number[] = [];
    const hr: number[] = [];
    for (let second = 0; second < 600; second += 1) {
      time.push(second);
      hr.push(150);
    }
    for (let second = 1800; second < 2400; second += 1) {
      time.push(second);
      hr.push(110);
    }

    const zones = computeHrZones(hr, time, MAX_HR);
    const total = zones.reduce((sum, zone) => sum + zone.timeS, 0);

    expect(total).toBe(1203);
    expect(zones[0].timeS).toBe(601.5);
    expect(zones[2].timeS).toBe(601.5);
  });

  it('rend des parts qui somment à 1', () => {
    const { time, hr } = series(600, (second) => 100 + (second % 100));
    const zones = computeHrZones(hr, time, MAX_HR);

    const total = zones.reduce((sum, zone) => sum + zone.share, 0);
    expect(total).toBeCloseTo(1, 12);

    for (const zone of zones) {
      expect(zone.share).toBeGreaterThanOrEqual(0);
      expect(zone.share).toBeLessThanOrEqual(1);
    }
  });

  it('compte le temps couvert par une FC clairsemée, pas le nombre de mesures', () => {
    // 601 points à 1 Hz, FC écrite un record sur 4 (Apple Watch). Les durées se
    // déduisent du sous-axe des mesures (pas de 4 s) : le panneau doit annoncer
    // la séance entière, pas son quart.
    const time: number[] = [];
    const hr: (number | null)[] = [];
    for (let second = 0; second <= 600; second += 1) {
      time.push(second);
      hr.push(second % 4 === 0 ? 150 : null);
    }

    const zones = computeHrZones(hr, time, MAX_HR);
    const total = zones.reduce((sum, zone) => sum + zone.timeS, 0);

    // 151 mesures espacées de 4 s : 149 × 4 s à l'intérieur + 2 s à chaque
    // bord (demi-pas), soit exactement les 600 s de la séance.
    expect(total).toBe(600);
    expect(zones[2].share).toBe(1);
  });

  it('ne compte pas le temps où la ceinture a décroché', () => {
    // 5 min de FC à 1 Hz, 10 min de silence complet, 5 min de FC : le trou
    // dépasse le plafond du sous-axe et n'est attribué à personne.
    const time: number[] = [];
    const hr: (number | null)[] = [];
    for (let second = 0; second < 1200; second += 1) {
      time.push(second);
      hr.push(second < 300 || second >= 900 ? 150 : null);
    }

    const zones = computeHrZones(hr, time, MAX_HR);
    const total = zones.reduce((sum, zone) => sum + zone.timeS, 0);

    expect(total).toBeGreaterThan(595);
    expect(total).toBeLessThan(605);
  });

  it('ne calcule rien quand la FC ne parle jamais', () => {
    expect(computeHrZones([null, null, null], [0, 1, 2], MAX_HR)).toEqual([]);
  });

  it('ne calcule rien sans données exploitables', () => {
    const { time, hr } = series(100, () => 150);

    expect(computeHrZones(hr, time, { kind: 'max-hr', bpm: 0 })).toEqual([]);
    expect(computeHrZones(hr, time, { kind: 'max-hr', bpm: Number.NaN })).toEqual([]);
    expect(computeHrZones([], [], MAX_HR)).toEqual([]);
    // Un instant unique n'a pas de durée.
    expect(computeHrZones([150], [0], MAX_HR)).toEqual([]);
  });
});

describe('hrZoneOf', () => {
  it('applique les mêmes bornes que le découpage complet', () => {
    // 120 = 60 %, 140 = 70 %, 160 = 80 %, 180 = 90 % de 200.
    expect(hrZoneOf(119, MAX_HR)).toBe(1);
    expect(hrZoneOf(120, MAX_HR)).toBe(2);
    expect(hrZoneOf(140, MAX_HR)).toBe(3);
    expect(hrZoneOf(160, MAX_HR)).toBe(4);
    expect(hrZoneOf(180, MAX_HR)).toBe(5);
    // Au-delà de la FC max renseignée, on reste en Z5 : pas de sixième zone.
    expect(hrZoneOf(210, MAX_HR)).toBe(5);
  });

  it('ne devine aucune zone sans FC max exploitable', () => {
    expect(hrZoneOf(150, null)).toBeNull();
    expect(hrZoneOf(150, { kind: 'max-hr', bpm: 0 })).toBeNull();
    expect(hrZoneOf(0, MAX_HR)).toBeNull();
  });
});

/** L'ancrage de l'athlète qui a adopté une FC seuil de 170. */
const LTHR: HrZoneAnchor = { kind: 'lthr', bpm: 170 };

describe('hrZoneAnchor', () => {
  it('fait primer la FC seuil dès qu’elle existe — c’est tout l’objet de son adoption', () => {
    expect(hrZoneAnchor(200, 170)).toEqual({ kind: 'lthr', bpm: 170 });
  });

  it('retombe sur la FC max sans FC seuil — le comportement d’avant, à la ligne près', () => {
    expect(hrZoneAnchor(200, null)).toEqual({ kind: 'max-hr', bpm: 200 });
  });

  it('ne rend aucun ancrage sans référence exploitable', () => {
    expect(hrZoneAnchor(null, null)).toBeNull();
    expect(hrZoneAnchor(0, 0)).toBeNull();
    expect(hrZoneAnchor(Number.NaN, Number.NaN)).toBeNull();
    // Une FC seuil absurde ne bloque pas la FC max : c'est un ancrage qu'on
    // choisit, pas un drapeau qui désactive tout.
    expect(hrZoneAnchor(200, Number.NaN)).toEqual({ kind: 'max-hr', bpm: 200 });
  });
});

describe('zones ancrées sur la FC seuil', () => {
  it('applique les frontières de Friel : 85, 90, 95 et 100 % du seuil', () => {
    // Sur un seuil de 170 : 144,5 = 85 %, 153 = 90 %, 161,5 = 95 %, 170 = 100 %.
    const boundaries: Array<[number, number]> = [
      [144, 1],
      [145, 2],
      [152, 2],
      [153, 3],
      [161, 3],
      [162, 4],
      [169, 4],
      [170, 5],
      [185, 5],
    ];

    for (const [beats, expected] of boundaries) {
      expect(hrZoneOf(beats, LTHR), `${beats} bpm`).toBe(expected);
    }
  });

  it('classe la même fréquence différemment selon l’ancrage — c’est le fond du sujet', () => {
    // 160 bpm : 80 % d'une FC max de 200 (Z4 « seuil » de la table générique),
    // mais seulement 94 % d'un seuil mesuré à 170 (Z3, endurance active). Deux
    // coureurs de même FC max et de seuils différents ne courent pas la même
    // chose au même pourcentage.
    expect(hrZoneOf(160, MAX_HR)).toBe(4);
    expect(hrZoneOf(160, LTHR)).toBe(3);
  });

  it('répartit tout le temps enregistré, comme l’autre ancrage', () => {
    const { time, hr } = series(600, (second) => 130 + (second % 60));
    const zones = computeHrZones(hr, time, LTHR);

    expect(zones.map((zone) => zone.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(zones.reduce((sum, zone) => sum + zone.share, 0)).toBeCloseTo(1, 12);
  });

  it('ne déplace pas les zones de qui n’a pas adopté de seuil', () => {
    const { time, hr } = series(300, () => 150);

    expect(computeHrZones(hr, time, MAX_HR)).toEqual(
      computeHrZones(hr, time, { kind: 'max-hr', bpm: 200 }),
    );
  });
});
