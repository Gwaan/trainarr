import { describe, expect, it } from 'vitest';

import {
  capitalize,
  formatCivilFullDate,
  formatClock,
  formatDistance,
  formatDuration,
  formatFullDate,
  formatHeartRate,
  formatLoad,
  formatMonotony,
  formatNumber,
  formatPace,
  formatRelativeDay,
  formatStrain,
  formatVo2max,
  parseCivilDate,
} from './format';

/**
 * Repère d'une date civile : minuit UTC, comme `parseCivilDate`. Construire des
 * dates en heure locale rendrait ces tests dépendants du fuseau du process, or
 * l'affichage doit toujours raisonner dans celui de l'athlète.
 */
const civilDate = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

describe('formatNumber', () => {
  it('arrondit et utilise la virgule décimale', () => {
    expect(formatNumber(52.34, 1)).toBe('52,3');
    expect(formatNumber(52.36, 1)).toBe('52,4');
    expect(formatNumber(67.6)).toBe('68');
  });

  it('utilise le signe moins typographique', () => {
    expect(formatNumber(-8.2)).toBe('−8');
    expect(formatNumber(-0.42, 1)).toBe('−0,4');
  });

  it("n'affiche jamais de « moins zéro »", () => {
    expect(formatNumber(-0.2)).toBe('0');
    expect(formatNumber(-0.04, 1)).toBe('0,0');
  });
});

describe('formatVo2max', () => {
  it('arrondit au dixième', () => {
    expect(formatVo2max(52.349)).toBe('52,3');
    expect(formatVo2max(48)).toBe('48,0');
  });
});

describe('formatLoad', () => {
  it("arrondit à l'entier, symétriquement autour de zéro", () => {
    expect(formatLoad(68.4)).toBe('68');
    expect(formatLoad(67.5)).toBe('68');
    expect(formatLoad(-7.5)).toBe('−8');
    expect(formatLoad(-8.2)).toBe('−8');
  });
});

describe('formatPace', () => {
  it('formate des secondes par kilomètre', () => {
    expect(formatPace(258)).toBe('4:18/km');
    expect(formatPace(312)).toBe('5:12/km');
    expect(formatPace(240)).toBe('4:00/km');
  });

  it('arrondit à la seconde avant découpage', () => {
    expect(formatPace(299.6)).toBe('5:00/km');
    expect(formatPace(59.4)).toBe('0:59/km');
  });
});

describe('formatDistance', () => {
  it('convertit les mètres en kilomètres au dixième', () => {
    expect(formatDistance(18_240)).toBe('18,2 km');
    expect(formatDistance(14_000)).toBe('14,0 km');
    expect(formatDistance(800)).toBe('0,8 km');
  });
});

describe('formatDuration', () => {
  it('affiche les secondes sous la minute', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(0)).toBe('0 s');
  });

  it('affiche les minutes sous une heure', () => {
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(2_880)).toBe('48 min');
  });

  it('affiche heures et minutes sur deux chiffres', () => {
    expect(formatDuration(3_900)).toBe('1 h 05');
    expect(formatDuration(3_600)).toBe('1 h 00');
    expect(formatDuration(7_845)).toBe('2 h 11');
  });

  it('ne produit pas de durée négative', () => {
    expect(formatDuration(-30)).toBe('0 s');
  });
});

describe('formatHeartRate', () => {
  it('arrondit et suffixe en bpm', () => {
    expect(formatHeartRate(148)).toBe('148 bpm');
    expect(formatHeartRate(147.6)).toBe('148 bpm');
  });
});

describe('parseCivilDate', () => {
  it('lit une date civile comme un repère à minuit UTC', () => {
    const date = parseCivilDate('2026-08-09');
    expect(date).not.toBeNull();
    expect(date?.toISOString()).toBe('2026-08-09T00:00:00.000Z');
    // Et l'affichage retombe bien sur le même jour civil, quel que soit le
    // fuseau du process (le fuseau de l'athlète est toujours en avance sur UTC).
    expect(formatFullDate(date!)).toBe('dimanche 9 août');
  });

  it('rejette les formats et les dates invalides', () => {
    expect(parseCivilDate('09/08/2026')).toBeNull();
    expect(parseCivilDate('2026-13-01')).toBeNull();
    expect(parseCivilDate('2026-02-30')).toBeNull();
    expect(parseCivilDate('')).toBeNull();
  });
});

describe('formatRelativeDay', () => {
  const now = civilDate(2026, 8, 9); // dimanche

  it('nomme les jours proches', () => {
    expect(formatRelativeDay(civilDate(2026, 8, 9), now)).toBe("aujourd'hui");
    expect(formatRelativeDay(civilDate(2026, 8, 8), now)).toBe('hier');
    expect(formatRelativeDay(civilDate(2026, 8, 10), now)).toBe('demain');
  });

  it('utilise le nom du jour dans la semaine écoulée', () => {
    expect(formatRelativeDay(civilDate(2026, 8, 5), now)).toBe('mercredi');
    expect(formatRelativeDay(civilDate(2026, 8, 3), now)).toBe('lundi');
  });

  it('bascule sur la date courte au-delà de six jours', () => {
    expect(formatRelativeDay(civilDate(2026, 7, 12), now)).toBe('12 juil.');
  });

  it("précise l'année quand elle diffère", () => {
    expect(formatRelativeDay(civilDate(2025, 11, 3), now)).toBe('3 nov. 2025');
  });

  it("ignore l'heure de la journée", () => {
    // Instants explicites en UTC : le test ne doit pas dépendre du fuseau du
    // process (le container tourne en UTC, la machine de dev à Paris).
    const evening = new Date('2026-08-08T20:00:00Z'); // 22 h à Paris, samedi
    const morning = new Date('2026-08-09T05:00:00Z'); // 7 h à Paris, dimanche
    expect(formatRelativeDay(evening, morning)).toBe('hier');
  });

  it('raisonne dans le fuseau de l\'athlète, pas dans celui du process', () => {
    // 22 h 30 UTC = 0 h 30 à Paris le lendemain. Une séance datée du 10 doit
    // donc s'afficher « aujourd'hui », et non « demain » comme le ferait un
    // calcul en UTC. Régression observée toutes les nuits entre minuit et l'aube.
    const nightInParis = new Date('2026-08-09T22:30:00Z');
    expect(formatRelativeDay(parseCivilDate('2026-08-10')!, nightInParis)).toBe(
      "aujourd'hui",
    );
    expect(formatRelativeDay(parseCivilDate('2026-08-09')!, nightInParis)).toBe('hier');
  });
});

describe('formatFullDate', () => {
  it('rend une date complète en français', () => {
    expect(formatFullDate(civilDate(2026, 8, 9))).toBe('dimanche 9 août');
  });
});

describe('formatCivilFullDate', () => {
  it('tait le millésime dans l’année en cours', () => {
    expect(formatCivilFullDate('2026-08-09', '2026-08-16')).toBe('dimanche 9 août');
  });

  it('millésime dès que l’année diffère — sinon la date ne désigne rien', () => {
    expect(formatCivilFullDate('2024-05-17', '2026-08-16')).toBe('vendredi 17 mai 2024');
  });

  it('ne date rien plutôt que d’inventer un jour', () => {
    expect(formatCivilFullDate('2026-02-30', '2026-08-16')).toBeNull();
    expect(formatCivilFullDate('pas-une-date', '2026-08-16')).toBeNull();
  });
});

describe('formatClock', () => {
  it('rend un chrono exact à la seconde', () => {
    expect(formatClock(2_892)).toBe('48:12');
    expect(formatClock(3_872)).toBe('1:04:32');
    expect(formatClock(-10)).toBe('0:00');
  });
});

describe('formatMonotony et formatStrain', () => {
  it('donne à chacune la précision de son amplitude', () => {
    // La monotonie vit entre 0,5 et 3 : l'entier écraserait deux semaines de
    // nature différente sur le même nombre. La contrainte se lit par centaines.
    expect(formatMonotony(1.84)).toBe('1,8');
    expect(formatStrain(2_449.6)).toBe('2450');
  });
});

describe('capitalize', () => {
  it('met la première lettre en capitale', () => {
    expect(capitalize("aujourd'hui")).toBe("Aujourd'hui");
    expect(capitalize('')).toBe('');
  });
});
