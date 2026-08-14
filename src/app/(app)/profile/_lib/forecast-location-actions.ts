'use server';

/**
 * Server Actions du bloc « Lieu des prévisions météo » : chercher un lieu par
 * son nom, puis l'enregistrer — ou revenir au mode automatique.
 *
 * Minces par construction : vérifier la session → valider (Zod) → déléguer (au
 * client de géocodage pour la recherche, au DAL pour l'écriture) → revalider.
 *
 * **Le géocodage est appelé d'ici, c'est-à-dire du serveur.** Le navigateur ne
 * parle jamais à un tiers : il envoie un nom, il reçoit une liste de lieux.
 * Open-Meteo ne voit donc que l'adresse de l'installation, jamais celle de
 * l'athlète.
 *
 * Ces actions sont des endpoints publics appelables par POST direct. Aucune n'a
 * d'identifiant de ressource à falsifier : le DAL n'écrit que sur l'athlète de
 * la session, et refuse s'il n'y en a pas.
 *
 * **Ce qu'elles renvoient est sérialisé vers le client** : un statut, une liste
 * de lieux publics, un message. Jamais une trace d'exécution, jamais les
 * coordonnées déjà enregistrées d'un autre réglage.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { AthleteNotFoundError } from '@/data/athlete';
import { getSession } from '@/data/session';
import {
  clearForecastLocation,
  FORECAST_LOCATION_LABEL_MAX_CHARS,
  InvalidForecastLocationError,
  saveForecastLocation,
} from '@/data/weather-forecast';
import { SESSION_REQUIRED_MESSAGE } from '@/lib/auth/messages';
import { WeatherApiError } from '@/lib/weather/client';
import { GEOCODING_MIN_QUERY_CHARS, searchPlaces } from '@/lib/weather/geocoding-client';

import {
  CLEAR_FORECAST_LOCATION_VALUE,
  type ForecastLocationFormState,
  type ForecastSearchState,
} from './forecast-location-state';

/** Un `FormData` ne porte que des chaînes ou des fichiers ; un fichier n'est pas une valeur. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * La saisie de recherche.
 *
 * Le minimum de caractères n'est pas une coquetterie : le service ne rend rien
 * en dessous (vérifié), autant le dire plutôt que d'appeler pour rien.
 */
const querySchema = z.object({
  query: z
    .string()
    .trim()
    .min(
      GEOCODING_MIN_QUERY_CHARS,
      `Écris au moins ${GEOCODING_MIN_QUERY_CHARS} caractères du nom du lieu.`,
    )
    .max(120, 'Nom de lieu trop long.'),
});

/**
 * Le lieu choisi, tel qu'il revient du navigateur.
 *
 * Il vient d'une recherche faite juste avant, mais **rien n'est cru sur parole**
 * : les bornes sont revérifiées ici, puis une seconde fois par le DAL, qui les
 * arrondit (cf. `validateForecastLocation`).
 */
const degrees = (bound: number) =>
  // Une chaîne, convertie puis vérifiée — et non `z.coerce.number()`, qui
  // transforme une valeur absente en zéro, c'est-à-dire en un point du golfe de
  // Guinée parfaitement valide.
  z
    .string()
    .trim()
    // `Number('')` vaut zéro : une coordonnée absente doit être refusée avant la
    // conversion, jamais après.
    .min(1, 'Coordonnée manquante.')
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && Math.abs(value) <= bound, 'Coordonnée invalide.');

const placeSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Choisis un lieu dans la liste.')
    .max(FORECAST_LOCATION_LABEL_MAX_CHARS, 'Nom de lieu trop long.'),
  latitudeDeg: degrees(90),
  longitudeDeg: degrees(180),
});

/**
 * Cherche les lieux qui portent un nom. Compatible `useActionState`.
 *
 * Aucune écriture, aucune revalidation : c'est une lecture, son résultat vit
 * dans l'état du formulaire jusqu'à ce qu'un lieu soit choisi.
 */
export async function searchForecastLocationAction(
  _previous: ForecastSearchState,
  formData: FormData,
): Promise<ForecastSearchState> {
  // Dans le corps de l'action, avant toute validation : ni le proxy ni la page
  // ne la protègent, elle s'appelle en POST direct. Un appel sans session ne
  // fera donc pas d'appel sortant sur notre quota.
  if ((await getSession()) === null) {
    return { status: 'error', message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = querySchema.safeParse({ query: textField(formData, 'query') });
  if (!parsed.success) {
    return { status: 'error', message: z.flattenError(parsed.error).fieldErrors.query?.[0] };
  }

  const { query } = parsed.data;

  try {
    const places = await searchPlaces({ name: query });
    if (places.length === 0) return { status: 'empty', query };

    return {
      status: 'results',
      query,
      // Reconstruit champ par champ : ce qui part au navigateur est ce qui est
      // écrit ici, et rien de ce que le géocodage porterait demain en plus.
      places: places.map((place) => ({
        id: place.id,
        name: place.name,
        region: place.region,
        country: place.country,
        latitudeDeg: place.coordinates.latitudeDeg,
        longitudeDeg: place.coordinates.longitudeDeg,
      })),
    };
  } catch (error) {
    // Les erreurs du client météo sont déjà écrites pour être lues (elles
    // reprennent le motif d'Open-Meteo) ; le reste reste générique.
    if (error instanceof WeatherApiError) {
      return { status: 'error', query, message: `Recherche impossible : ${error.message}` };
    }

    console.error('[profile] géocodage impossible :', error);
    return { status: 'error', query, message: 'Recherche impossible pour l’instant. Réessaie.' };
  }
}

const SAVED_MESSAGE =
  'Lieu enregistré. Les prévisions sont relevées à nouveau dans la minute qui vient.';
const CLEARED_MESSAGE =
  'Mode automatique rétabli : le lieu redevient celui de tes derniers départs. Nouveau relevé dans la minute qui vient.';
const GENERIC_FAILURE = "Le lieu n'a pas été enregistré.";

/**
 * Enregistre le lieu choisi, ou revient au mode automatique. Compatible
 * `useActionState`.
 *
 * Les deux gestes partagent une action parce qu'ils partagent un formulaire et
 * un état : le bouton « revenir au mode automatique » soumet
 * {@link CLEAR_FORECAST_LOCATION_VALUE}, tout le reste est un enregistrement.
 */
export async function saveForecastLocationAction(
  _previous: ForecastLocationFormState,
  formData: FormData,
): Promise<ForecastLocationFormState> {
  if ((await getSession()) === null) {
    return { status: 'error', message: SESSION_REQUIRED_MESSAGE };
  }

  const clearing = textField(formData, 'intent') === CLEAR_FORECAST_LOCATION_VALUE;

  if (!clearing) {
    const parsed = placeSchema.safeParse({
      label: textField(formData, 'label'),
      latitudeDeg: textField(formData, 'latitudeDeg'),
      longitudeDeg: textField(formData, 'longitudeDeg'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'Choisis un lieu dans la liste des résultats.' };
    }

    try {
      await saveForecastLocation(parsed.data);
    } catch (error) {
      return failure(error);
    }
  } else {
    try {
      await clearForecastLocation();
    } catch (error) {
      return failure(error);
    }
  }

  revalidatePath('/', 'layout');
  return { status: 'success', message: clearing ? CLEARED_MESSAGE : SAVED_MESSAGE };
}

/**
 * Traduit une erreur du DAL en état de formulaire. Aucune trace d'exécution ne
 * franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 */
function failure(error: unknown): ForecastLocationFormState {
  if (error instanceof InvalidForecastLocationError) {
    return { status: 'error', message: error.message };
  }
  if (error instanceof AthleteNotFoundError) {
    return {
      status: 'error',
      message: "Aucun profil enregistré : crée-le d'abord, puis reviens ici.",
    };
  }

  console.error('[profile] enregistrement du lieu des prévisions impossible :', error);
  return { status: 'error', message: `${GENERIC_FAILURE} Réessaie.` };
}
