import 'server-only';

/**
 * Le relevé de prévisions du matin : **un appel par compte et par jour**.
 *
 * ## La règle, et pourquoi elle est aussi stricte
 *
 * Toutes les prévisions à venir sont réévaluées **en une fois, tous les matins,
 * à la même heure** — 6 h locales (`FORECAST_READING_HOUR`). Pas de
 * rafraîchissement selon l'âge de chaque séance, pas de séances relevées à des
 * instants différents : un seul relevé par jour, dont toutes les séances à venir
 * héritent. Deux prévisions du même jour lues à deux heures différentes
 * donneraient deux réponses au même écran, et l'athlète n'aurait aucun moyen de
 * savoir laquelle croire.
 *
 * Open-Meteo rend **seize jours pour un lieu en une requête** : un appel suffit
 * donc à couvrir tout l'horizon, et il n'y en a jamais un par séance.
 *
 * ## Le rattrapage n'est pas un mécanisme séparé
 *
 * Le repère est l'heure fixe du matin, matérialisée par un **marqueur** (la date
 * civile du dernier passage de 6 h révolu). Le relevé est dû dès que le marqueur
 * mémorisé n'est plus celui de l'instant : que l'application ait tourné à 6 h ou
 * qu'elle soit revenue à 9 h après un déploiement ne change rien au verdict.
 * Sans cela, un déploiement matinal laisserait la journée entière avec les
 * prévisions de la veille.
 *
 * ## Ce que ce relevé ne fait jamais
 *
 * - **Lever.** Il rend ce qu'il a écrit ; c'est l'appelant qui journalise.
 * - **Écraser une observation.** Il n'écrit que dans les tables de prévision.
 *   Une prévision est datée et périssable, une observation est définitive : les
 *   confondre reviendrait à remplacer ce qu'on a mesuré par ce qu'on estime.
 * - **Déduire son athlète.** Il tourne hors requête, donc sans session : son
 *   athlète est un paramètre.
 */

import {
  getForecastRun,
  listRecentStartCoordinates,
  saveForecastReading,
} from '@/data/weather-forecast';

import { WeatherAbortError, WeatherRejectedError, type FetchLike } from './client';
import { fetchDailyForecast } from './forecast-client';
import {
  forecastReadingMarker,
  HABITUAL_START_SAMPLE,
  habitualStart,
  isForecastReadingDue,
  type WeatherForecastStatus,
} from './forecast-plan';

export type ForecastReadingOptions = {
  /** Annulation de l'appel en vol (arrêt du service). */
  signal?: AbortSignal;
  /** Horloge, pour décider si le relevé est dû. Injectable pour les tests. */
  now?: Date;
  /** `fetch` injectable — les tests n'ouvrent aucune connexion. */
  fetchImpl?: FetchLike;
};

/** Ce qu'un relevé a donné, de quoi en faire une ligne de journal. */
export type ForecastReadingReport = {
  status: WeatherForecastStatus;
  /** Marqueur du matin relevé, date civile. */
  readingDay: string;
  /** Jours écrits — zéro hors succès. */
  days: number;
  /** Motif de l'échec, `null` autrement. */
  reason: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Relève et enregistre les prévisions d'un athlète, si le relevé du matin est
 * dû. **Ne lève jamais.**
 *
 * Rend `null` quand il n'y avait rien à faire — cas très majoritaire, une fois
 * par cycle et par athlète — ou quand l'arrêt du service a coupé l'appel : une
 * tentative interrompue n'écrit rien, et le relevé reste dû au prochain
 * démarrage.
 *
 * L'heure du rendez-vous et la règle qui le déclenche vivent dans
 * `./forecast-plan.ts` (`FORECAST_READING_HOUR`, `isForecastReadingDue`).
 */
export async function runDailyForecast(
  athleteId: number,
  options: ForecastReadingOptions = {},
): Promise<ForecastReadingReport | null> {
  const now = options.now ?? new Date();

  const run = await getForecastRun(athleteId);
  if (!isForecastReadingDue(run, now)) return null;

  const readingDay = forecastReadingMarker(now);

  // Une séance à venir n'a pas de GPS : le lieu se déduit des départs récents,
  // par une médiane qui résiste à une sortie en déplacement (cf. `habitualStart`).
  const coordinates = habitualStart(
    await listRecentStartCoordinates(athleteId, HABITUAL_START_SAMPLE),
  );

  if (coordinates === null) {
    // Aucune sortie géolocalisée : il n'y a pas de lieu, donc pas de prévision.
    // Ce n'est pas un échec, mais ça se reprend dans la matinée — le rattrapage
    // de la météo des séances passées, qui tourne dans la même boucle, écrit
    // précisément les départs dont ce lieu se déduit (cf. `isForecastReadingDue`).
    await saveForecastReading(athleteId, readingDay, { status: 'no-location' }, now);
    return { status: 'no-location', readingDay, days: 0, reason: null };
  }

  try {
    const days = await fetchDailyForecast({
      coordinates,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });

    await saveForecastReading(
      athleteId,
      readingDay,
      { status: 'forecast', coordinates, days },
      now,
    );
    return { status: 'forecast', readingDay, days: days.length, reason: null };
  } catch (error) {
    // Arrêt **demandé** (pas un délai de garde écoulé) : sortie propre, rien
    // n'est écrit. Le silence se déduit de l'intention de l'appelant, jamais du
    // seul type de l'erreur — cf. `.claude/rules/data-import.md`.
    if (error instanceof WeatherAbortError && !error.timedOut) return null;

    // Un refus argumenté d'Open-Meteo (4xx) est définitif pour la journée :
    // redemander le même lieu donnerait le même refus. Le reste (réseau, quota,
    // 5xx, réponse illisible) est repris dans la matinée.
    const status = error instanceof WeatherRejectedError ? 'unsupported' : 'failed';
    const reason = errorMessage(error);

    await saveForecastReading(athleteId, readingDay, { status, reason, coordinates }, now);
    return { status, readingDay, days: 0, reason };
  }
}
