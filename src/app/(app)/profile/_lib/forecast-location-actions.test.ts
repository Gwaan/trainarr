import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidForecastLocationError } from '@/data/weather-forecast';
import { SESSION_REQUIRED_MESSAGE } from '@/lib/auth/messages';
import { WeatherRejectedError } from '@/lib/weather/client';

import {
  saveForecastLocationAction,
  searchForecastLocationAction,
} from './forecast-location-actions';
import {
  CLEAR_FORECAST_LOCATION_VALUE,
  FORECAST_LOCATION_FORM_IDLE,
  FORECAST_SEARCH_IDLE,
} from './forecast-location-state';

vi.mock('server-only', () => ({}));

/**
 * Les deux actions sont minces : la session, la validation, la traduction du
 * résultat. Le géocodage, le DAL et l'invalidation du cache sont donc simulés —
 * ce qui s'éprouve ici, c'est **ce qu'elles refusent** et **ce qu'elles laissent
 * franchir la frontière**.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSession: vi.fn(),
    searchPlaces: vi.fn(),
    saveForecastLocation: vi.fn(),
    clearForecastLocation: vi.fn(),
    revalidatePath: vi.fn(),
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock('@/data/session', () => ({ getSession: mocks.getSession }));

vi.mock('@/data/weather-forecast', async (importOriginal) => ({
  // Les bornes et les erreurs typées restent les vraies.
  ...(await importOriginal<typeof import('@/data/weather-forecast')>()),
  saveForecastLocation: mocks.saveForecastLocation,
  clearForecastLocation: mocks.clearForecastLocation,
}));

vi.mock('@/lib/weather/geocoding-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/weather/geocoding-client')>()),
  searchPlaces: mocks.searchPlaces,
}));

const BORDEAUX = {
  id: 3031582,
  name: 'Bordeaux',
  region: 'Nouvelle-Aquitaine',
  country: 'France',
  coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 },
};

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ userId: 'user_1' });
  mocks.searchPlaces.mockResolvedValue([BORDEAUX]);
  mocks.saveForecastLocation.mockResolvedValue(undefined);
  mocks.clearForecastLocation.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchForecastLocationAction', () => {
  it('refuse sans session, avant même de valider la saisie', async () => {
    mocks.getSession.mockResolvedValue(null);

    const state = await searchForecastLocationAction(FORECAST_SEARCH_IDLE, form({ query: 'B' }));

    expect(state).toEqual({ status: 'error', message: SESSION_REQUIRED_MESSAGE });
    // Aucun appel sortant : un POST direct ne consomme pas notre quota.
    expect(mocks.searchPlaces).not.toHaveBeenCalled();
  });

  it('n’appelle pas le service pour une saisie trop courte', async () => {
    const state = await searchForecastLocationAction(FORECAST_SEARCH_IDLE, form({ query: 'B' }));

    expect(state.status).toBe('error');
    expect(mocks.searchPlaces).not.toHaveBeenCalled();
  });

  it('rend les lieux réduits à ce que l’écran affiche', async () => {
    const state = await searchForecastLocationAction(
      FORECAST_SEARCH_IDLE,
      form({ query: '  Bordeaux ' }),
    );

    expect(mocks.searchPlaces).toHaveBeenCalledWith({ name: 'Bordeaux' });
    expect(state).toEqual({
      status: 'results',
      query: 'Bordeaux',
      places: [
        {
          id: 3031582,
          name: 'Bordeaux',
          region: 'Nouvelle-Aquitaine',
          country: 'France',
          latitudeDeg: 44.84,
          longitudeDeg: -0.58,
        },
      ],
    });
  });

  it('distingue « aucun lieu de ce nom » d’une panne', async () => {
    mocks.searchPlaces.mockResolvedValue([]);

    const state = await searchForecastLocationAction(
      FORECAST_SEARCH_IDLE,
      form({ query: 'zzzzqqqxx' }),
    );

    expect(state).toEqual({ status: 'empty', query: 'zzzzqqqxx' });
  });

  it('reprend le motif d’un refus du service, sans trace d’exécution', async () => {
    mocks.searchPlaces.mockRejectedValue(
      new WeatherRejectedError('géocodage Open-Meteo : demande refusée — Parameter count.', 400),
    );

    const state = await searchForecastLocationAction(
      FORECAST_SEARCH_IDLE,
      form({ query: 'Bordeaux' }),
    );

    expect(state.status).toBe('error');
    expect(state.message).toContain('Parameter count');
  });

  it('rend un message générique sur une panne inattendue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.searchPlaces.mockRejectedValue(new Error('pool épuisé, fichier /srv/app/x.ts'));

    const state = await searchForecastLocationAction(
      FORECAST_SEARCH_IDLE,
      form({ query: 'Bordeaux' }),
    );

    expect(state.status).toBe('error');
    expect(state.message).not.toContain('/srv/app');
  });
});

describe('saveForecastLocationAction', () => {
  const chosen = { label: 'Bordeaux', latitudeDeg: '44.84', longitudeDeg: '-0.58' };

  it('refuse sans session, sans rien écrire', async () => {
    mocks.getSession.mockResolvedValue(null);

    const state = await saveForecastLocationAction(FORECAST_LOCATION_FORM_IDLE, form(chosen));

    expect(state).toEqual({ status: 'error', message: SESSION_REQUIRED_MESSAGE });
    expect(mocks.saveForecastLocation).not.toHaveBeenCalled();
  });

  it('enregistre le lieu choisi et revalide', async () => {
    const state = await saveForecastLocationAction(FORECAST_LOCATION_FORM_IDLE, form(chosen));

    expect(mocks.saveForecastLocation).toHaveBeenCalledWith({
      label: 'Bordeaux',
      latitudeDeg: 44.84,
      longitudeDeg: -0.58,
    });
    expect(state.status).toBe('success');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('refuse une coordonnée absente plutôt que de la lire comme un zéro', async () => {
    const state = await saveForecastLocationAction(
      FORECAST_LOCATION_FORM_IDLE,
      form({ label: 'Bordeaux', latitudeDeg: '', longitudeDeg: '' }),
    );

    expect(state.status).toBe('error');
    expect(mocks.saveForecastLocation).not.toHaveBeenCalled();
  });

  it('revient au mode automatique sur l’intention d’effacement', async () => {
    const state = await saveForecastLocationAction(
      FORECAST_LOCATION_FORM_IDLE,
      form({ intent: CLEAR_FORECAST_LOCATION_VALUE }),
    );

    expect(mocks.clearForecastLocation).toHaveBeenCalled();
    expect(mocks.saveForecastLocation).not.toHaveBeenCalled();
    expect(state.status).toBe('success');
    expect(state.message).toContain('automatique');
  });

  it('rend le refus du DAL tel qu’il est écrit', async () => {
    mocks.saveForecastLocation.mockRejectedValue(
      new InvalidForecastLocationError('coordinates', 'Coordonnées inexploitables.'),
    );

    const state = await saveForecastLocationAction(FORECAST_LOCATION_FORM_IDLE, form(chosen));

    expect(state).toEqual({ status: 'error', message: 'Coordonnées inexploitables.' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
