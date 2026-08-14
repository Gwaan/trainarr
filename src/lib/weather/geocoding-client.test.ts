import { describe, expect, it } from 'vitest';

import { WeatherMalformedError, WeatherRejectedError, type FetchLike } from './client';
import { buildGeocodingUrl, searchPlaces, type SearchPlacesParams } from './geocoding-client';

/**
 * Réponse **réelle** du géocodage Open-Meteo, recopiée depuis un appel du
 * 2026-08-14 :
 * `geocoding-api.open-meteo.com/v1/search?name=Bordeaux&count=5&language=fr`.
 * C'est elle qui vérifie que le schéma épouse la vraie forme, et pas l'inverse.
 *
 * Trois traits de la vraie réponse valent d'être remarqués — aucun n'aurait été
 * deviné :
 *
 * - **cinq « Bordeaux » sont rendus**, dans trois pays : sans région ni pays à
 *   l'écran, un choix serait un tirage au sort ;
 * - **la hiérarchie administrative est facultative** : le troisième résultat n'a
 *   pas d'`admin2`, et d'autres lieux n'ont pas d'`admin1` du tout (vérifié sur
 *   Singapour, repris en test plus bas) ;
 * - **le service en dit beaucoup trop** : altitude, fuseau, population,
 *   identifiants administratifs et **130 codes postaux** pour la seule ville de
 *   Bordeaux. Le schéma n'en garde rien.
 *
 * Seule liberté prise avec la réponse réelle : la liste `postcodes` du premier
 * résultat est tronquée à cinq entrées. C'est un champ que le schéma écarte, sa
 * longueur ne prouve rien — et 130 codes postaux rendraient cette fixture
 * illisible.
 */
const REAL_BODY = {
  results: [
    {
      id: 3031582,
      name: 'Bordeaux',
      latitude: 44.84124,
      longitude: -0.58046,
      elevation: 20.0,
      feature_code: 'PPLA',
      country_code: 'FR',
      admin1_id: 11071620,
      admin2_id: 3015948,
      admin3_id: 3031580,
      admin4_id: 6455058,
      timezone: 'Europe/Paris',
      population: 265328,
      postcodes: ['33100', '33200', '33800', '33000', '33300'],
      country_id: 3017382,
      country: 'France',
      admin1: 'Nouvelle-Aquitaine',
      admin2: 'Gironde',
      admin3: 'Bordeaux',
      admin4: 'Bordeaux',
    },
    {
      id: 3031579,
      name: 'Bordeaux-en-Gâtinais',
      latitude: 48.0987,
      longitude: 2.52687,
      elevation: 86.0,
      feature_code: 'PPL',
      country_code: 'FR',
      admin1_id: 3027939,
      admin2_id: 2997857,
      admin3_id: 2987002,
      admin4_id: 6449149,
      timezone: 'Europe/Paris',
      population: 128,
      postcodes: ['45340'],
      country_id: 3017382,
      country: 'France',
      admin1: 'Centre-Val de Loire',
      admin2: 'Loiret',
      admin3: 'Pithiviers',
      admin4: 'Bordeaux-en-Gâtinais',
    },
    {
      id: 2401493,
      name: 'Bordeaux',
      latitude: -1.66964,
      longitude: 13.62738,
      elevation: 371.0,
      feature_code: 'PPL',
      country_code: 'GA',
      admin1_id: 2400454,
      timezone: 'Africa/Libreville',
      country_id: 2400553,
      country: 'Gabon',
      admin1: 'Haut-Ogooué',
    },
    {
      id: 2401494,
      name: 'Bordeaux',
      latitude: -0.82841,
      longitude: 10.18358,
      elevation: 26.0,
      feature_code: 'PPL',
      country_code: 'GA',
      admin1_id: 2397842,
      timezone: 'Africa/Libreville',
      country_id: 2400553,
      country: 'Gabon',
      admin1: 'Moyen-Ogooué',
    },
    {
      id: 4531191,
      name: 'Bordeaux',
      latitude: 35.11426,
      longitude: -94.87356,
      elevation: 157.0,
      feature_code: 'PPL',
      country_code: 'US',
      admin1_id: 4544379,
      admin2_id: 4540759,
      timezone: 'America/Chicago',
      country_id: 6252001,
      country: 'États-Unis',
      admin1: 'Oklahoma',
      admin2: 'Comté de Le Flore',
    },
  ],
  generationtime_ms: 0.48840046,
};

/**
 * Réponse **réelle** d'une recherche sans résultat (`name=zzzzqqqxx`, HTTP 200) :
 * le service **omet** `results` au lieu de rendre une liste vide.
 */
const REAL_EMPTY_BODY = { generationtime_ms: 0.16319752 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function respondWith(response: Response | (() => Promise<never>)): FetchLike {
  return typeof response === 'function'
    ? () => response()
    : () => Promise.resolve(response.clone());
}

function params(overrides: Partial<SearchPlacesParams> = {}): SearchPlacesParams {
  return {
    name: 'Bordeaux',
    fetchImpl: respondWith(jsonResponse(REAL_BODY)),
    ...overrides,
  };
}

describe('buildGeocodingUrl', () => {
  const url = new URL(buildGeocodingUrl(params()));

  it('interroge le point d’entrée du géocodage', () => {
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
  });

  it('demande cinq propositions, en français', () => {
    expect(url.searchParams.get('name')).toBe('Bordeaux');
    expect(url.searchParams.get('count')).toBe('5');
    expect(url.searchParams.get('language')).toBe('fr');
  });

  it('échappe la saisie plutôt que de la concaténer', () => {
    const url = new URL(buildGeocodingUrl(params({ name: 'Saint-Jean-de-Luz & co' })));
    expect(url.searchParams.get('name')).toBe('Saint-Jean-de-Luz & co');
  });
});

describe('searchPlaces', () => {
  it('lit la réponse réelle du service', async () => {
    const places = await searchPlaces(params());

    expect(places).toHaveLength(5);
    expect(places[0]).toEqual({
      id: 3031582,
      name: 'Bordeaux',
      region: 'Nouvelle-Aquitaine',
      country: 'France',
      // Arrondies à deux décimales, comme toute coordonnée du système.
      coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 },
    });
  });

  it('garde de quoi départager les homonymes, et rien d’autre', async () => {
    const places = await searchPlaces(params());

    expect(places.map((place) => `${place.name} · ${place.region} · ${place.country}`)).toEqual([
      'Bordeaux · Nouvelle-Aquitaine · France',
      'Bordeaux-en-Gâtinais · Centre-Val de Loire · France',
      'Bordeaux · Haut-Ogooué · Gabon',
      'Bordeaux · Moyen-Ogooué · Gabon',
      'Bordeaux · Oklahoma · États-Unis',
    ]);
    // Ni population, ni fuseau, ni codes postaux : ce que le schéma ne nomme pas
    // ne franchit pas le module.
    expect(Object.keys(places[0]).toSorted()).toEqual([
      'coordinates',
      'country',
      'id',
      'name',
      'region',
    ]);
  });

  it('accepte un lieu sans région : elle désambiguïse, elle n’est pas garantie', async () => {
    // Réponse réelle pour `name=Singapour` : aucun `admin1`.
    const singapore = {
      results: [
        {
          id: 1880252,
          name: 'Singapour',
          latitude: 1.28967,
          longitude: 103.85007,
          elevation: 15.0,
          feature_code: 'PPLC',
          country_code: 'SG',
          timezone: 'Asia/Singapore',
          population: 3547809,
          country_id: 1880251,
          country: 'Singapour',
        },
      ],
      generationtime_ms: 0.5,
    };

    const places = await searchPlaces(
      params({ name: 'Singapour', fetchImpl: respondWith(jsonResponse(singapore)) }),
    );

    expect(places[0].region).toBeNull();
    expect(places[0].country).toBe('Singapour');
  });

  it('rend une liste vide quand le service omet « results »', async () => {
    const places = await searchPlaces(
      params({ name: 'zzzzqqqxx', fetchImpl: respondWith(jsonResponse(REAL_EMPTY_BODY)) }),
    );

    expect(places).toEqual([]);
  });

  it('écarte un lieu dont les coordonnées ne sont pas exploitables', async () => {
    const guarded = {
      results: [
        { id: 1, name: 'Île de Garde', latitude: 0, longitude: 0, country: 'Nulle part' },
        REAL_BODY.results[0],
      ],
    };

    const places = await searchPlaces(
      params({ fetchImpl: respondWith(jsonResponse(guarded)) }),
    );

    expect(places.map((place) => place.id)).toEqual([3031582]);
  });

  it('refuse une réponse dont un lieu n’a pas de coordonnées', async () => {
    const broken = { results: [{ id: 1, name: 'Bordeaux', country: 'France' }] };

    await expect(
      searchPlaces(params({ fetchImpl: respondWith(jsonResponse(broken)) })),
    ).rejects.toBeInstanceOf(WeatherMalformedError);
  });

  it('reprend le motif d’un refus du service, tel qu’il est écrit', async () => {
    // Réponse réelle pour `count=500`.
    const refusal = { error: true, reason: 'Parameter count must be between 1 and 100.' };

    await expect(
      searchPlaces(params({ fetchImpl: respondWith(jsonResponse(refusal, 400)) })),
    ).rejects.toThrow(/count must be between 1 and 100/);

    await expect(
      searchPlaces(params({ fetchImpl: respondWith(jsonResponse(refusal, 400)) })),
    ).rejects.toBeInstanceOf(WeatherRejectedError);
  });
});
