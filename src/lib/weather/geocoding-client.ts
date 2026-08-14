/**
 * Client HTTP Open-Meteo : **chercher un lieu par son nom**.
 *
 * Le troisième et dernier client de la famille météo, sur le même transport que
 * les deux autres (`requestOpenMeteoJson` dans `./client.ts`) : mêmes délais de
 * garde, mêmes erreurs typées, même grammaire de refus.
 *
 * Il ne sert qu'à **une** chose : traduire « Bordeaux » en un couple de
 * coordonnées que l'athlète peut régler comme lieu de ses prévisions. La météo
 * des séances **faites**, elle, ne passe jamais par ici — elle est relevée aux
 * coordonnées GPS réelles de la sortie.
 *
 * ## Ce qui a été vérifié contre le service réel
 *
 * Appel réel du 2026-08-14 :
 * `https://geocoding-api.open-meteo.com/v1/search?name=Bordeaux&count=5&language=fr`.
 * La réponse de ce jour-là est recopiée telle quelle en fixture dans
 * `./geocoding-client.test.ts` : c'est **elle** qui vérifie le schéma, jamais
 * l'inverse.
 *
 * - **Pas de clé API**, comme les deux autres points d'entrée. Aucun en-tête
 *   d'authentification ne part d'ici, il n'y a donc aucun secret à protéger.
 * - **`results` est absent quand rien ne correspond** — et non une liste vide :
 *   `{"generationtime_ms":0.16}` pour `name=zzzzqqqxx` (HTTP 200). D'où un champ
 *   *optionnel* dans le schéma, et une liste vide rendue à l'appelant. Deviné
 *   autrement, « aucun résultat » serait devenu « réponse malformée ».
 * - **`admin1` et `country` manquent parfois** : vérifié sur Singapour, qui n'a
 *   pas de région. Ils désambiguïsent, ils ne sont pas garantis.
 * - **Une saisie d'une seule lettre ne rend rien** (HTTP 200 sans `results`) :
 *   le service exige au moins {@link GEOCODING_MIN_QUERY_CHARS} caractères.
 * - **Erreurs** — même forme que les autres endpoints : HTTP 400 et un corps
 *   `{"error": true, "reason": "…"}` (vérifié sur un `name` absent et un `count`
 *   hors bornes).
 *
 * ## Ce qu'on garde d'un résultat, et rien de plus
 *
 * Le service rend une quinzaine de champs par lieu (population, fuseau,
 * altitude, codes postaux, hiérarchie administrative sur quatre niveaux…). Trois
 * suffisent à la tâche : **le nom** (ce qui s'affiche), **la région et le pays**
 * (ce qui distingue les homonymes — cinq « Bordeaux » sont rendus, en France, au
 * Gabon et en Oklahoma), et **les coordonnées** (ce qui part à Open-Meteo).
 * L'identifiant vient en plus, et pour une seule raison : deux homonymes peuvent
 * partager nom, région et pays, il faut donc une clé stable pour les distinguer
 * dans une liste de choix.
 *
 * Module pur : aucun accès base, `fetch` injectable.
 */

import { z } from 'zod';

import { requestOpenMeteoJson, WeatherMalformedError, type OpenMeteoRequestOptions } from './client';
import { toRequestCoordinates, type Coordinates } from './plan';

/** Point d'entrée du géocodage — un sous-domaine distinct des deux autres. */
export const GEOCODING_BASE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/**
 * Nombre de propositions demandées.
 *
 * Cinq : assez pour départager les homonymes courants (« Bordeaux » en rend
 * cinq, dont trois hors de France), assez peu pour qu'une liste de choix reste
 * lisible sur un téléphone.
 */
export const GEOCODING_RESULT_LIMIT = 5;

/**
 * Longueur minimale d'une recherche.
 *
 * Ce n'est pas une prudence d'appelant, c'est le comportement du service :
 * `name=a` rend une réponse vide (vérifié). Autant le dire à la saisie plutôt
 * que de faire un appel pour rien.
 */
export const GEOCODING_MIN_QUERY_CHARS = 2;

/** Un lieu proposé par le géocodage. */
export type GeocodedPlace = {
  /**
   * Identifiant GeoNames du lieu. Ne sert qu'à donner une **clé stable** à une
   * liste de choix — il n'est ni stocké, ni interrogé.
   */
  id: number;
  /** Nom du lieu, dans la langue demandée. */
  name: string;
  /** Région (`admin1`), `null` là où il n'y en a pas — Singapour, par exemple. */
  region: string | null;
  country: string | null;
  /** Coordonnées **déjà arrondies** (cf. `toRequestCoordinates`). */
  coordinates: Coordinates;
};

/**
 * Un lieu, tel que le service le rend — réduit aux champs utiles.
 *
 * Zod écarte tout le reste (population, fuseau, codes postaux, `admin2..4`…) :
 * ce qui n'est pas nommé ici ne franchit pas ce module.
 */
const placeSchema = z.object({
  id: z.number(),
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  /** Vérifié absent sur des lieux réels (Singapour) : optionnel, pas nullable. */
  admin1: z.string().optional(),
  country: z.string().optional(),
});

/**
 * Réponse de recherche.
 *
 * `results` est **optionnel** parce que le service l'omet quand rien ne
 * correspond — c'est la forme réelle, vérifiée, et non une liste vide.
 */
const searchResponseSchema = z.object({
  results: z.array(placeSchema).optional(),
});

export type SearchPlacesParams = OpenMeteoRequestOptions & {
  /** Le nom cherché, tel qu'il a été saisi. */
  name: string;
  /** Nombre de propositions demandées. */
  count?: number;
  /** Surcharge de l'URL de base — les tests, et rien d'autre. */
  baseUrl?: string;
};

/** L'URL d'une recherche, montée telle que la documentation la décrit. */
export function buildGeocodingUrl(params: SearchPlacesParams): string {
  const url = new URL(params.baseUrl ?? GEOCODING_BASE_URL);

  url.searchParams.set('name', params.name);
  url.searchParams.set('count', String(params.count ?? GEOCODING_RESULT_LIMIT));
  // La langue décide des noms rendus (« États-Unis », « Bengale-Occidental ») :
  // c'est celle de l'interface, elle n'est pas laissée à un défaut anglais.
  url.searchParams.set('language', 'fr');

  return url.toString();
}

/**
 * Les lieux qui répondent à un nom, dans l'ordre de pertinence du service.
 *
 * **Rend une liste vide quand rien ne correspond** — ce n'est pas une erreur :
 * une faute de frappe est un cas d'usage, pas une panne, et l'écran a une phrase
 * pour le dire.
 *
 * Les résultats dont les coordonnées ne sont pas exploitables sont **écartés**
 * (cf. `toRequestCoordinates` : hors bornes, ou le point de garde `0/0`). Régler
 * un lieu dont on ne saurait pas relever la météo n'avancerait à rien.
 *
 * @throws {WeatherRejectedError} demande refusée (définitif)
 * @throws {WeatherRateLimitError} quota atteint
 * @throws {WeatherUnavailableError} réseau, délai, 5xx
 * @throws {WeatherMalformedError} réponse illisible ou d'une forme inattendue
 */
export async function searchPlaces(params: SearchPlacesParams): Promise<GeocodedPlace[]> {
  const context = 'géocodage Open-Meteo';

  const { payload, status } = await requestOpenMeteoJson(buildGeocodingUrl(params), context, {
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });

  const parsed = searchResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(racine)').join(', ');
    throw new WeatherMalformedError(
      `${context} : réponse inattendue (champs en défaut : ${fields}).`,
      status,
    );
  }

  const places: GeocodedPlace[] = [];
  for (const result of parsed.data.results ?? []) {
    const coordinates = toRequestCoordinates(result.latitude, result.longitude);
    if (coordinates === null) continue;

    places.push({
      id: result.id,
      name: result.name,
      region: result.admin1 ?? null,
      country: result.country ?? null,
      coordinates,
    });
  }
  return places;
}
