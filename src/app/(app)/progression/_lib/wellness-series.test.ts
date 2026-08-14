import { describe, expect, it } from 'vitest';

import { panelValueAt } from '@/lib/chart/series';

import {
  buildWellnessTrends,
  hasNoWellnessMeasure,
  wellnessSheetOf,
  type WellnessDayLike,
  type WellnessTrends,
} from './wellness-series';

/** Une journée vide, dont chaque test ne renseigne que ce qu'il éprouve. */
function day(date: string, measures: Partial<WellnessDayLike> = {}): WellnessDayLike {
  return {
    day: date,
    restingHrBpm: null,
    hrvRmssdMs: null,
    hrvSdnnMs: null,
    sleepTimeS: null,
    weightKg: null,
    ...measures,
  };
}

function panelOf(trends: WellnessTrends, key: string) {
  const found = trends.charts?.panels.find((panel) => panel.spec.key === key);
  if (found === undefined) throw new Error(`Panneau « ${key} » absent.`);
  return found;
}

function absenceOf(trends: WellnessTrends, key: string): string {
  const found = trends.absences.find((absence) => absence.key === key);
  if (found === undefined) throw new Error(`Absence « ${key} » non annoncée.`);
  return found.message;
}

/** Trois nuits de FC de repos : de quoi tracer, quoi qu'éprouve le test. */
const RESTING_HR_DAYS = [
  day('2026-08-10', { restingHrBpm: 51 }),
  day('2026-08-11', { restingHrBpm: 46 }),
  day('2026-08-12', { restingHrBpm: 48 }),
];

describe('buildWellnessTrends — ce qui se trace', () => {
  it('empile les mesures traçables dans l’ordre du panneau', () => {
    const days = [
      day('2026-08-10', { restingHrBpm: 51, hrvSdnnMs: 44, sleepTimeS: 25_800, weightKg: 61.4 }),
      day('2026-08-12', { restingHrBpm: 48, hrvSdnnMs: 46, sleepTimeS: 24_000, weightKg: 61.2 }),
    ];

    const trends = buildWellnessTrends(days);

    expect(trends.charts?.panels.map((panel) => panel.spec.key)).toEqual([
      'resting-hr',
      'hrv',
      'sleep',
      'weight',
    ]);
    expect(trends.absences).toEqual([]);
  });

  it('projette les journées sur un axe de dates, une abscisse par jour', () => {
    const trends = buildWellnessTrends(RESTING_HR_DAYS);

    // Croissantes : c'est ce dont dépend la recherche du point sous le curseur.
    expect(trends.charts?.xs).toEqual([
      Date.UTC(2026, 7, 10),
      Date.UTC(2026, 7, 11),
      Date.UTC(2026, 7, 12),
    ]);
  });

  it('formate chaque mesure dans son unité, valeur du curseur comprise', () => {
    const days = [
      day('2026-08-10', { hrvRmssdMs: 63.4, sleepTimeS: 25_800, weightKg: 61.44 }),
      day('2026-08-12', { hrvRmssdMs: 58, sleepTimeS: 24_000, weightKg: 61.2 }),
    ];
    const trends = buildWellnessTrends(days);

    expect(panelValueAt(panelOf(trends, 'hrv'), 0)).toBe('63 ms');
    expect(panelValueAt(panelOf(trends, 'sleep'), 0)).toBe('7 h 10');
    expect(panelValueAt(panelOf(trends, 'weight'), 0)).toBe('61,4 kg');
  });

  it('ne comble jamais une nuit sans mesure : le curseur y dit l’absence', () => {
    const trends = buildWellnessTrends([
      day('2026-08-10', { restingHrBpm: 48 }),
      day('2026-08-11'),
      day('2026-08-12', { restingHrBpm: 47 }),
    ]);
    const panel = panelOf(trends, 'resting-hr');

    // Ni report de la veille, ni interpolation : la journée muette n'a pas de
    // valeur, et la courbe s'y coupe.
    expect(panel.values).toEqual([48, null, 47]);
    expect(panelValueAt(panel, 1)).toBe('—');
    expect(panel.line).toContain('M');
    expect(panel.line.match(/M/g)).toHaveLength(2);
  });

  it('donne à chaque panneau l’amplitude de sa période', () => {
    expect(panelOf(buildWellnessTrends(RESTING_HR_DAYS), 'resting-hr').rangeLabel).toBe(
      '46 – 51 bpm',
    );
  });
});

describe('buildWellnessTrends — la variante de HRV', () => {
  it('trace la variante majoritaire et l’annonce dans le titre', () => {
    const trends = buildWellnessTrends([
      day('2026-08-10', { hrvSdnnMs: 44 }),
      day('2026-08-11', { hrvSdnnMs: 46 }),
      day('2026-08-12', { hrvRmssdMs: 63 }),
    ]);
    const panel = panelOf(trends, 'hrv');

    expect(panel.spec.title).toBe('HRV (SDNN)');
    // La nuit mesurée dans l'autre grandeur sort de la courbe : elle n'y est ni
    // convertie, ni empilée — ce serait une chute de 46 à 63 sans cause.
    expect(panel.values).toEqual([44, 46, null]);
  });

  it('fait primer le rMSSD quand une journée porte les deux', () => {
    const trends = buildWellnessTrends([
      day('2026-08-10', { hrvRmssdMs: 63, hrvSdnnMs: 44 }),
      day('2026-08-12', { hrvRmssdMs: 61, hrvSdnnMs: 46 }),
    ]);
    const panel = panelOf(trends, 'hrv');

    expect(panel.spec.title).toBe('HRV (rMSSD)');
    expect(panel.values).toEqual([63, 61]);
  });

  it('porte la fiche ⓘ des deux mesures qui en ont une', () => {
    expect(wellnessSheetOf('hrv')).toBe('hrv');
    expect(wellnessSheetOf('resting-hr')).toBe('resting-hr');
    expect(wellnessSheetOf('sleep')).toBeNull();
    expect(wellnessSheetOf('weight')).toBeNull();
  });
});

describe('buildWellnessTrends — ce qui ne se trace pas', () => {
  it('nomme la mesure jamais prise plutôt que de laisser un vide', () => {
    const trends = buildWellnessTrends(RESTING_HR_DAYS);

    expect(absenceOf(trends, 'weight')).toContain('pesée');
    expect(absenceOf(trends, 'hrv')).toContain('Aucune HRV');
    // Aucune HRV mesurée : le titre n'annonce aucune variante qu'on n'aurait pas.
    expect(panelOf(trends, 'resting-hr').spec.key).toBe('resting-hr');
  });

  it('donne la valeur unique plutôt qu’un point isolé qui ferait une droite', () => {
    const trends = buildWellnessTrends([
      day('2026-08-10', { restingHrBpm: 48 }),
      day('2026-08-12', { restingHrBpm: 47, weightKg: 61.4 }),
    ]);

    expect(absenceOf(trends, 'weight')).toBe(
      'Poids : une seule mesure sur la période (61,4 kg) — pas encore de tendance.',
    );
  });

  it('ne rend aucun graphe quand la fenêtre n’a pas deux jours', () => {
    const trends = buildWellnessTrends([day('2026-08-12', { restingHrBpm: 48 })]);

    expect(trends.charts).toBeNull();
    expect(trends.absences).toHaveLength(4);
  });
});

describe('hasNoWellnessMeasure', () => {
  it('est vraie quand aucune des quatre mesures n’existe', () => {
    expect(hasNoWellnessMeasure([day('2026-08-12')])).toBe(true);
    expect(hasNoWellnessMeasure([])).toBe(true);
  });

  it('est fausse dès qu’une seule mesure existe, HRV SDNN comprise', () => {
    expect(hasNoWellnessMeasure([day('2026-08-12', { weightKg: 61 })])).toBe(false);
    expect(hasNoWellnessMeasure([day('2026-08-12', { hrvSdnnMs: 45 })])).toBe(false);
  });
});
