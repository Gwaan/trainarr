import 'server-only';

/**
 * Le relevé bien-être quotidien : **un appel par compte et par jour**.
 *
 * ## Où il tourne, et pourquoi là
 *
 * Dans la boucle de rapatriement intervals.icu (`src/lib/fit/service.ts`), qui
 * énumère déjà, à chaque cycle, les comptes ayant une clé API — avec leur
 * identifiant d'athlète normalisé et leur clé déchiffrée. Ouvrir une troisième
 * boucle pour poser une question par jour aurait coûté un ordonnanceur de plus
 * pour rien.
 *
 * **Écart assumé avec `.claude/rules/data-import.md`**, qui écrit du poller « il
 * ne parse rien et ne touche jamais à la base » : cette phrase porte sur les
 * **fichiers FIT**, dont la séparation stricte (le poller écrit des fichiers, le
 * watcher parle à la base) est ce qui rend l'ingestion reprenable après un
 * redémarrage. Le bien-être n'est pas un fichier : il n'y a rien à ingérer, rien
 * à dédupliquer par empreinte, et le faire transiter par un fichier déposé sur
 * disque n'apporterait aucune des propriétés que ce détour existe pour donner.
 * L'écriture ici est directe, idempotente par clé `(athlète, jour)`, et son seul
 * état est une date sur `athlete`.
 *
 * ## La règle du rendez-vous
 *
 * Même mécanique que le relevé météo du matin : un **marqueur** (la date civile
 * du dernier passage de {@link WELLNESS_READING_HOUR} révolu) mémorisé sur
 * l'athlète. Le relevé est dû dès que le marqueur mémorisé n'est plus celui de
 * l'instant — ce qui donne le rendez-vous quotidien *et* son rattrapage après un
 * déploiement, sans code de rattrapage.
 *
 * Une différence, et elle simplifie tout : **le marqueur n'est posé qu'en cas de
 * succès**. Un échec est donc redû au cycle suivant (une minute), sans compteur
 * de tentatives à borner ni table d'état à tenir — et sans risque d'inonder les
 * journaux, puisque l'appelant ne journalise l'échec qu'une fois par journée.
 *
 * ## Ce que ce relevé ne fait jamais
 *
 * - **Lever.** Il rend ce qu'il a fait ; c'est l'appelant qui journalise.
 * - **Déduire son athlète.** Il tourne hors requête : son athlète est un
 *   paramètre, comme partout ailleurs dans les services de fond.
 * - **Écrire une charge.** Les `ctl`/`atl`/`rampRate` d'intervals.icu ne sont
 *   même pas lus (cf. `./wellness-client.ts`).
 */

import { getWellnessReadingDay, saveWellnessDays, setWellnessReadingDay } from '@/data/wellness';

import { IntervalsAbortError, IntervalsRateLimitError, type FetchLike } from './client';
import { fetchWellness } from './wellness-client';
import {
  isWellnessReadingDue,
  WELLNESS_READING_HOUR,
  wellnessReadingMarker,
  wellnessWindow,
} from './wellness-plan';

/** Les identifiants d'un compte, tels qu'un relevé les consomme. */
export type WellnessCredentials = {
  /** Identifiant tel que l'API intervals.icu l'attend (`i123456`, ou `0`). */
  intervalsAthleteId: string;
  apiKey: string;
};

export type WellnessReadingOptions = {
  /** Annulation de l'appel en vol (arrêt du service). */
  signal?: AbortSignal;
  /** Horloge, pour décider si le relevé est dû. Injectable pour les tests. */
  now?: Date;
  /** `fetch` injectable — les tests n'ouvrent aucune connexion. */
  fetchImpl?: FetchLike;
  /** Base de l'API, pour les tests. */
  baseUrl?: string;
};

/** Ce qu'un relevé a donné, de quoi en faire une ligne de journal. */
export type WellnessReadingReport = {
  status: 'saved' | 'failed';
  /** Marqueur du jour relevé, date civile. */
  readingDay: string;
  /** Journées écrites — zéro hors succès. */
  days: number;
  /** Motif de l'échec, `null` autrement. */
  reason: string | null;
  /** Délai demandé par l'API (429), à faire respecter par la boucle appelante. */
  retryAfterS: number | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Relève et enregistre le bien-être d'un athlète, si le relevé du jour est dû.
 * **Ne lève jamais.**
 *
 * Rend `null` quand il n'y avait rien à faire — cas très majoritaire, une fois
 * par cycle et par compte — ou quand l'arrêt du service a coupé l'appel : une
 * tentative interrompue n'écrit rien, et le relevé reste dû au prochain
 * démarrage.
 *
 * L'écriture précède la pose du marqueur, et jamais l'inverse : un incident
 * entre les deux fait refaire le relevé au cycle suivant, ce qui est sans
 * conséquence (la fenêtre est idempotente), là où un marqueur posé d'avance
 * ferait perdre la journée.
 */
export async function runDailyWellness(
  athleteId: number,
  credentials: WellnessCredentials,
  options: WellnessReadingOptions = {},
): Promise<WellnessReadingReport | null> {
  const now = options.now ?? new Date();
  const readingDay = wellnessReadingMarker(now);
  const window = wellnessWindow(now);

  try {
    // La lecture du marqueur est dans le `try` comme le reste : une base
    // momentanément injoignable est un échec de relevé, pas une exception qui
    // remonterait dans la boucle de rapatriement.
    if (!isWellnessReadingDue(await getWellnessReadingDay(athleteId), now)) return null;

    const readings = await fetchWellness({
      athleteId: credentials.intervalsAthleteId,
      apiKey: credentials.apiKey,
      oldest: window.oldest,
      newest: window.newest,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });

    const days = await saveWellnessDays(athleteId, readings, now);
    await setWellnessReadingDay(athleteId, readingDay);

    return { status: 'saved', readingDay, days, reason: null, retryAfterS: null };
  } catch (error) {
    // Arrêt **demandé** (pas un délai de garde écoulé) : sortie propre, rien
    // n'est écrit et rien n'est journalisé. Le silence se déduit de l'intention
    // de l'appelant, jamais du seul type de l'erreur — cf.
    // `.claude/rules/data-import.md`.
    if (error instanceof IntervalsAbortError && !error.timedOut) return null;

    return {
      status: 'failed',
      readingDay,
      days: 0,
      reason: errorMessage(error),
      retryAfterS: error instanceof IntervalsRateLimitError ? error.retryAfterS : null,
    };
  }
}

/** Ligne de démarrage : ce que le service annonce de ce rendez-vous. */
export function wellnessStartupLine(): string {
  return `relevé bien-être : une lecture par compte et par jour à ${WELLNESS_READING_HOUR} h locales (HRV, FC de repos, sommeil, poids), rattrapée au premier cycle si l'heure a été manquée`;
}
