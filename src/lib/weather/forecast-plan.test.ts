import { describe, expect, it } from 'vitest';

import {
  FORECAST_HORIZON_DAYS,
  FORECAST_MAX_ATTEMPTS,
  FORECAST_RETRY_DELAY_MS,
  forecastAvailability,
  forecastHorizonLastDay,
  forecastReadingMarker,
  habitualStart,
  isForecastReadingDue,
  resolveDayForecast,
  resolveForecastLocation,
  type DailyForecast,
  type ForecastRunState,
} from './forecast-plan';
import type { Coordinates } from './plan';

/**
 * Le rendez-vous du matin.
 *
 * L'heure est locale (`APP_TIME_ZONE`, Europe/Paris) : les instants ci-dessous
 * sont donc écrits en UTC avec le décalage saisonnier appliqué à la main, ce qui
 * éprouve du même coup que le marqueur ne dépend pas du fuseau du process.
 */
describe('forecastReadingMarker', () => {
  it('rend la veille tant que 6 h locales ne sont pas passées', () => {
    // 05 h 59 à Paris, en été (UTC+2).
    expect(forecastReadingMarker(new Date('2026-08-14T03:59:00Z'))).toBe('2026-08-13');
  });

  it('bascule sur le jour même à 6 h locales pile', () => {
    expect(forecastReadingMarker(new Date('2026-08-14T04:00:00Z'))).toBe('2026-08-14');
  });

  it('suit l’heure d’hiver, pas un décalage figé', () => {
    // 05 h 59 puis 06 h 00 à Paris, en hiver (UTC+1).
    expect(forecastReadingMarker(new Date('2026-01-15T04:59:00Z'))).toBe('2026-01-14');
    expect(forecastReadingMarker(new Date('2026-01-15T05:00:00Z'))).toBe('2026-01-15');
  });

  it('reste sur le jour courant tout le reste de la journée', () => {
    expect(forecastReadingMarker(new Date('2026-08-14T21:30:00Z'))).toBe('2026-08-14');
  });
});

function run(overrides: Partial<ForecastRunState> = {}): ForecastRunState {
  return {
    readingDay: '2026-08-14',
    status: 'forecast',
    attempts: 1,
    lastAttemptAt: new Date('2026-08-14T04:00:10Z'),
    ...overrides,
  };
}

describe('isForecastReadingDue', () => {
  it('est dû quand rien n’a jamais été relevé', () => {
    expect(isForecastReadingDue(null, new Date('2026-08-14T09:00:00Z'))).toBe(true);
  });

  it('n’est plus dû une fois le relevé du matin fait', () => {
    expect(isForecastReadingDue(run(), new Date('2026-08-14T12:00:00Z'))).toBe(false);
  });

  it('redevient dû au passage de 6 h le lendemain', () => {
    // 05 h 59 locales : encore la matinée d'hier, rien à faire.
    expect(isForecastReadingDue(run(), new Date('2026-08-15T03:59:00Z'))).toBe(false);
    expect(isForecastReadingDue(run(), new Date('2026-08-15T04:00:00Z'))).toBe(true);
  });

  it('rattrape une heure manquée : le repère reste 6 h, pas l’instant du réveil', () => {
    // L'application était arrêtée à 6 h (déploiement) et revient à 9 h locales :
    // le marqueur mémorisé est celui de la veille, le relevé part aussitôt.
    const missed = run({ readingDay: '2026-08-13' });
    expect(isForecastReadingDue(missed, new Date('2026-08-14T07:00:00Z'))).toBe(true);
  });

  it('ne relève pas deux fois si l’horloge recule', () => {
    const ahead = run({ readingDay: '2026-08-15' });
    expect(isForecastReadingDue(ahead, new Date('2026-08-14T12:00:00Z'))).toBe(false);
  });

  describe('après un échec', () => {
    const failed = run({ status: 'failed', lastAttemptAt: new Date('2026-08-14T04:00:00Z') });

    it('attend le délai de reprise', () => {
      const tooSoon = new Date(failed.lastAttemptAt.getTime() + FORECAST_RETRY_DELAY_MS - 1);
      expect(isForecastReadingDue(failed, tooSoon)).toBe(false);
    });

    it('reprend dans la matinée', () => {
      const due = new Date(failed.lastAttemptAt.getTime() + FORECAST_RETRY_DELAY_MS);
      expect(isForecastReadingDue(failed, due)).toBe(true);
    });

    it('abandonne la journée une fois les tentatives épuisées', () => {
      const exhausted = run({
        status: 'failed',
        attempts: FORECAST_MAX_ATTEMPTS,
        lastAttemptAt: new Date('2026-08-14T04:00:00Z'),
      });
      expect(isForecastReadingDue(exhausted, new Date('2026-08-14T20:00:00Z'))).toBe(false);
      // …mais le lendemain matin, oui.
      expect(isForecastReadingDue(exhausted, new Date('2026-08-15T04:00:00Z'))).toBe(true);
    });
  });

  describe('sans lieu connu', () => {
    const noLocation = run({
      status: 'no-location',
      lastAttemptAt: new Date('2026-08-14T04:00:00Z'),
    });

    it('reprend dans la matinée : le lieu peut apparaître entre-temps', () => {
      // Le lieu se déduit des départs relevés par la météo des séances passées,
      // dont le rattrapage tourne dans la même boucle : sur une installation
      // neuve, il n'a pas encore écrit une seule coordonnée au premier cycle.
      expect(
        isForecastReadingDue(noLocation, new Date('2026-08-14T04:20:00Z')),
      ).toBe(true);
    });

    it('n’insiste pas indéfiniment', () => {
      const exhausted = run({
        status: 'no-location',
        attempts: FORECAST_MAX_ATTEMPTS,
        lastAttemptAt: new Date('2026-08-14T04:00:00Z'),
      });
      expect(isForecastReadingDue(exhausted, new Date('2026-08-14T20:00:00Z'))).toBe(false);
    });
  });

  it('ne reprend pas un refus argumenté du service', () => {
    const unsupported = run({ status: 'unsupported' });
    expect(isForecastReadingDue(unsupported, new Date('2026-08-14T20:00:00Z'))).toBe(false);
  });
});

/**
 * Le lieu habituel.
 *
 * La propriété qui compte n'est pas « la médiane est le milieu » mais sa
 * **résistance** : une sortie en déplacement ne doit pas déménager la prévision.
 */
describe('habitualStart', () => {
  const home: Coordinates = { latitudeDeg: 48.85, longitudeDeg: 2.35 };
  const away: Coordinates = { latitudeDeg: 45.19, longitudeDeg: 5.72 };

  it('ne rend rien quand aucune sortie n’est géolocalisée', () => {
    expect(habitualStart([])).toBeNull();
  });

  it('rend le point unique quand il n’y en a qu’un', () => {
    expect(habitualStart([home])).toEqual(home);
  });

  it('résiste à une semaine de déplacement', () => {
    const starts = [...Array<Coordinates>(3).fill(away), ...Array<Coordinates>(7).fill(home)];
    expect(habitualStart(starts)).toEqual(home);
  });

  it('résiste que le déplacement soit au nord ou au sud du domicile', () => {
    const north: Coordinates = { latitudeDeg: 59.33, longitudeDeg: 18.06 };
    const starts = [...Array<Coordinates>(4).fill(north), ...Array<Coordinates>(7).fill(home)];
    expect(habitualStart(starts)).toEqual(home);
  });

  it('reste sur le nuage de départs voisins du domicile', () => {
    const starts: Coordinates[] = [
      { latitudeDeg: 48.84, longitudeDeg: 2.34 },
      { latitudeDeg: 48.85, longitudeDeg: 2.35 },
      { latitudeDeg: 48.86, longitudeDeg: 2.36 },
    ];
    expect(habitualStart(starts)).toEqual(home);
  });

  it('rend toujours un départ réellement observé, même sur un partage égal', () => {
    // Deux lieux, deux départs chacun : le médoïde tranche pour le plus récent
    // (les départs arrivent du plus récent au plus ancien) — une médiane
    // composante par composante aurait marié la latitude de l'un à la longitude
    // de l'autre et désigné un point où personne n'a jamais couru.
    const starts = [away, away, home, home];
    expect(habitualStart(starts)).toEqual(away);
    expect([away, home]).toContainEqual(habitualStart(starts));
  });

  it('rend toujours l’un des départs de la liste', () => {
    const starts: Coordinates[] = [
      { latitudeDeg: 48.85, longitudeDeg: 2.35 },
      { latitudeDeg: 43.6, longitudeDeg: 1.44 },
      { latitudeDeg: 45.76, longitudeDeg: 4.83 },
      { latitudeDeg: 48.86, longitudeDeg: 2.34 },
    ];
    expect(starts).toContainEqual(habitualStart(starts));
  });
});

/**
 * Le lieu réglé supplante le lieu déduit.
 *
 * C'est le seul point de cette fonction, et il n'est pas négociable : un réglage
 * qui céderait devant le médoïde des départs ne serait pas un réglage.
 */
describe('resolveForecastLocation', () => {
  const home: Coordinates = { latitudeDeg: 48.85, longitudeDeg: 2.35 };
  const bordeaux = { label: 'Bordeaux', coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 } };

  it('préfère le lieu réglé, même quand les départs disent autre chose', () => {
    expect(resolveForecastLocation({ configured: bordeaux, recentStarts: [home, home, home] })).toEqual(
      { source: 'configured', label: 'Bordeaux', coordinates: bordeaux.coordinates },
    );
  });

  it('retombe sur le médoïde des départs quand rien n’est réglé', () => {
    expect(resolveForecastLocation({ configured: null, recentStarts: [home] })).toEqual({
      source: 'derived',
      coordinates: home,
    });
  });

  it('ne rend rien quand il n’y a ni réglage ni départ géolocalisé', () => {
    expect(resolveForecastLocation({ configured: null, recentStarts: [] })).toBeNull();
  });

  it('tient sans départs dès qu’un lieu est réglé — l’appelant peut s’épargner la lecture', () => {
    expect(resolveForecastLocation({ configured: bordeaux, recentStarts: [] })?.source).toBe(
      'configured',
    );
  });
});

describe('forecastHorizonLastDay', () => {
  it('couvre seize jours, aujourd’hui compris', () => {
    expect(FORECAST_HORIZON_DAYS).toBe(16);
    expect(forecastHorizonLastDay('2026-08-14')).toBe('2026-08-29');
  });
});

describe('forecastAvailability', () => {
  const today = '2026-08-14';

  it('affiche la prévision dès qu’elle existe', () => {
    expect(
      forecastAvailability({ status: 'forecast', hasForecast: true, date: today, today }),
    ).toBe('forecast');
  });

  it('ne promet pas de prévision pour un jour passé', () => {
    expect(
      forecastAvailability({
        status: 'forecast',
        hasForecast: false,
        date: '2026-08-13',
        today,
      }),
    ).toBe('past');
  });

  it('dit qu’il n’y a pas de prévision au-delà de l’horizon', () => {
    expect(
      forecastAvailability({
        status: 'forecast',
        hasForecast: false,
        date: '2026-08-30',
        today,
      }),
    ).toBe('beyond-horizon');
  });

  it('couvre le dernier jour de l’horizon, pas un de moins', () => {
    expect(
      forecastAvailability({
        status: 'forecast',
        hasForecast: false,
        date: '2026-08-29',
        today,
      }),
    ).toBe('pending');
  });

  it('l’horizon l’emporte sur l’état du relevé', () => {
    // Le relevé a échoué, mais dans quarante jours il n'y aurait de toute façon
    // rien à afficher : autant dire la vérité la plus durable.
    expect(
      forecastAvailability({ status: 'failed', hasForecast: false, date: '2026-09-25', today }),
    ).toBe('beyond-horizon');
  });

  it('distingue « jamais relevé » d’une panne', () => {
    expect(
      forecastAvailability({ status: null, hasForecast: false, date: '2026-08-16', today }),
    ).toBe('pending');
  });

  it('fait voyager l’état du dernier relevé jusqu’à l’écran', () => {
    for (const status of ['no-location', 'unsupported', 'failed'] as const) {
      expect(
        forecastAvailability({ status, hasForecast: false, date: '2026-08-16', today }),
      ).toBe(status);
    }
  });
});

describe('resolveDayForecast', () => {
  const today = '2026-08-14';
  const day: DailyForecast = {
    date: '2026-08-16',
    weatherCode: 3,
    temperatureMaxC: 24.7,
    temperatureMinC: 14.2,
    apparentTemperatureMaxC: 23.1,
    apparentTemperatureMinC: 13.4,
    precipitationSumMm: 0.9,
    precipitationProbabilityMaxPct: 14,
    windSpeedMaxKmh: 13.5,
  };

  it('rend la journée demandée, et elle seule', () => {
    const resolved = resolveDayForecast({
      status: 'forecast',
      days: [{ ...day, date: '2026-08-15' }, day],
      date: '2026-08-16',
      today,
    });

    expect(resolved.availability).toBe('forecast');
    expect(resolved.day).toEqual(day);
  });

  it('rend la raison, jamais un jour vide, quand la prévision manque', () => {
    const resolved = resolveDayForecast({
      status: 'no-location',
      days: [],
      date: '2026-08-16',
      today,
    });

    expect(resolved).toEqual({ availability: 'no-location', day: null });
  });

  it('ne prend pas la prévision d’un autre jour', () => {
    const resolved = resolveDayForecast({
      status: 'forecast',
      days: [day],
      date: '2026-08-17',
      today,
    });

    expect(resolved.day).toBeNull();
  });
});
