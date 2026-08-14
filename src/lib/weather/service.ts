import 'server-only';

/**
 * Le service météo : la météo relevée des séances **effectuées**, et le relevé
 * quotidien des **prévisions**.
 *
 * ## Trois chemins, une seule boucle
 *
 * - **Après un import** — `src/lib/fit/ingest.ts` appelle
 *   {@link lookupActivityWeather} pour la séance qu'il vient d'écrire. Un appel,
 *   une séance : la météo est là quand l'athlète ouvre l'activité.
 * - **Le rattrapage** ({@link startWeatherService}) — l'historique importé avant
 *   que la météo n'existe, et les relevés qui ont échoué. Il tourne par petits
 *   lots espacés, indéfiniment, et s'arrête de lui-même quand il n'y a plus rien.
 * - **Les prévisions** (`./forecast-service.ts`) — un relevé par compte et par
 *   jour, à 6 h locales, porté par la **même** boucle. Pas de second
 *   ordonnanceur : le cycle passe déjà toutes les minutes, et il suffit qu'il
 *   demande à chaque tour si le rendez-vous du matin est encore dû. C'est aussi
 *   ce qui donne le rattrapage gratuitement — une application arrêtée à 6 h
 *   relève au premier cycle qui suit son retour.
 *
 * Tous écrivent par le DAL, avec la même règle : **une tentative écrit toujours
 * sa ligne**, succès comme échec. C'est cette ligne qui sort la séance — ou la
 * matinée, pour une prévision — de l'ensemble des candidats : la reprise n'a
 * donc rien à mémoriser, et redémarrer le container ne refait pas le travail
 * déjà fait.
 *
 * ## Ce que ce service ne fait jamais
 *
 * - **Faire échouer un import.** Une séance sans météo reste une séance valide.
 *   {@link lookupActivityWeather} ne lève pas : elle rend l'état qu'elle a écrit,
 *   et journalise ce qui n'a pas marché.
 * - **Marteler Open-Meteo.** Le service est gratuit et sans clé ; ses conditions
 *   non commerciales annoncent 600 appels par minute et 5 000 par heure. Le
 *   rattrapage en fait au plus 20 par minute, espacés d'une seconde, et une
 *   séance qui échoue quatre fois cesse d'être redemandée (cf. `./plan.ts`).
 * - **Emporter le serveur HTTP.** Comme le service d'import, chaque tour attrape
 *   ses erreurs et {@link runForever} rattrape le reste.
 */

import { listAthleteIds } from '@/data/athlete';
import {
  getWeatherLookupTarget,
  listActivitiesAwaitingWeather,
  saveActivityWeather,
  type WeatherLookupOutcome,
  type WeatherLookupTarget,
} from '@/data/activity-weather';

import {
  fetchHourlyWeather,
  WeatherAbortError,
  WeatherRejectedError,
  type FetchLike,
} from './client';
import { FORECAST_HORIZON_DAYS, FORECAST_READING_HOUR } from './forecast-plan';
import { runDailyForecast } from './forecast-service';
import {
  chooseWeatherSource,
  CYCLE_INTERVAL_MS,
  lookupSpacingMs,
  MAX_LOOKUPS_PER_CYCLE,
  weatherSampleInstant,
  type ActivityWeatherStatus,
} from './plan';

/**
 * Délai avant de relancer la boucle sur une erreur qu'aucun de ses gardes
 * n'avait prévue — même valeur et même raison que dans le service d'import.
 */
const LOOP_RESTART_DELAY_MS = 30_000;

function log(message: string): void {
  console.log(`[weather] ${message}`);
}

function logError(message: string): void {
  console.error(`[weather] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/*
 * Le relevé d'une séance.
 */

export type LookupOptions = {
  /** Annulation de l'appel en vol (arrêt du service). */
  signal?: AbortSignal;
  /** Horloge, pour choisir entre prévision et archive. Injectable pour les tests. */
  now?: Date;
  /** `fetch` injectable — les tests n'ouvrent aucune connexion. */
  fetchImpl?: FetchLike;
};

/**
 * Traduit un échec en ce qu'il faut écrire.
 *
 * Un **refus** d'Open-Meteo (4xx motivé : coordonnées ou date hors de ce qu'il
 * couvre) est définitif — redemander donnerait le même refus. Tout le reste
 * (réseau, quota, 5xx, réponse illisible) est réessayable.
 */
function outcomeForError(error: unknown, target: WeatherLookupTarget): WeatherLookupOutcome {
  const reason = errorMessage(error);
  return {
    status: error instanceof WeatherRejectedError ? 'unsupported' : 'failed',
    reason,
    coordinates: target.coordinates,
  };
}

/**
 * Relève et enregistre la météo d'une séance. **Ne lève jamais.**
 *
 * Rend l'état écrit, ou `null` quand rien n'a été écrit : séance qui n'appartient
 * pas à cet athlète (ou qui n'existe pas), et arrêt du service demandé en cours
 * d'appel — ce dernier n'est pas un échec de la séance, lui faire consommer une
 * tentative serait injuste.
 *
 * L'athlète est un **paramètre**, jamais une déduction : les deux appelants
 * (l'ingestion et le rattrapage) tournent hors requête.
 */
export async function lookupActivityWeather(
  activityId: number,
  athleteId: number,
  options: LookupOptions = {},
): Promise<ActivityWeatherStatus | null> {
  const target = await getWeatherLookupTarget(activityId, athleteId);
  if (target === null) return null;

  return lookupForTarget(target, athleteId, options);
}

/** Même relevé, quand l'appelant a déjà la cible en main (le rattrapage). */
async function lookupForTarget(
  target: WeatherLookupTarget,
  athleteId: number,
  options: LookupOptions,
): Promise<ActivityWeatherStatus | null> {
  const outcome = await resolveOutcome(target, options);
  if (outcome === null) return null;

  const written = await saveActivityWeather(target.activityId, athleteId, outcome);
  return written ? outcome.status : null;
}

/** Ce qu'il y a à écrire, ou `null` si l'arrêt du service a coupé l'appel. */
async function resolveOutcome(
  target: WeatherLookupTarget,
  options: LookupOptions,
): Promise<WeatherLookupOutcome | null> {
  // Un tapis n'a pas de GPS et n'en aura jamais : c'est un état définitif, pas
  // un échec — et surtout pas une séance à redemander à chaque cycle.
  if (target.coordinates === null) return { status: 'no-location' };

  const instant = weatherSampleInstant(target.startedAt, target.elapsedTimeS);
  // Une séance de moins de 80 jours se lit sur l'API de prévision et ses jours
  // antérieurs ; au-delà, sur l'archive. C'est le piège de cette intégration :
  // une sortie d'hier n'est pas encore dans l'archive.
  const source = chooseWeatherSource(instant, options.now ?? new Date());

  try {
    const sample = await fetchHourlyWeather({
      coordinates: target.coordinates,
      instant,
      source,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });

    return { status: 'observed', source, coordinates: target.coordinates, sample };
  } catch (error) {
    // Arrêt **demandé** (pas un délai de garde écoulé) : sortie propre. Le
    // silence se déduit de l'intention de l'appelant, jamais du seul type de
    // l'erreur — cf. `.claude/rules/data-import.md`.
    if (error instanceof WeatherAbortError && !error.timedOut) return null;
    return outcomeForError(error, target);
  }
}

/**
 * Le relevé qui suit un import, tel que `src/lib/fit/ingest.ts` l'appelle.
 *
 * **N'est jamais une condition de l'import** : la séance est en base, elle ne
 * doit pas repartir en `failed/` parce qu'Open-Meteo n'a pas répondu. Ce qui
 * n'aboutit pas est journalisé avec son motif — le rattrapage reprendra — et
 * rien ne remonte à l'appelant. Même politique que le rapprochement au plan.
 */
export async function recordActivityWeather(activityId: number, athleteId: number): Promise<void> {
  try {
    const status = await lookupActivityWeather(activityId, athleteId);
    if (status === 'failed') {
      log(`activité ${activityId} : météo indisponible, reprise par le rattrapage.`);
    }
  } catch (error) {
    logError(`activité ${activityId} : relevé météo impossible — ${errorMessage(error)}`);
  }
}

/*
 * Arrêt.
 */

type StopControls = {
  /** État réel du drapeau d'arrêt — c'est lui, et lui seul, qui autorise le silence. */
  readonly stopping: boolean;
  /** Annulation des appels réseau en vol. */
  readonly signal: AbortSignal;
  /** Attente interruptible. */
  sleep(ms: number): Promise<void>;
  requestStop(): void;
};

/**
 * Le drapeau d'arrêt, les réveils et l'annulation réseau, dans une portée fermée
 * plutôt qu'en variables de module : deux démarrages (rechargement à chaud en
 * développement) partageraient sinon le même état.
 */
function createStopControls(): StopControls {
  let stopping = false;
  const sleepers = new Set<() => void>();
  /**
   * Le drapeau n'est relu qu'entre deux étapes : un appel HTTP suspendu
   * retiendrait la boucle bien au-delà du délai de grâce de Docker.
   */
  const inFlight = new AbortController();

  return {
    get stopping() {
      return stopping;
    },
    get signal() {
      return inFlight.signal;
    },
    sleep(ms: number): Promise<void> {
      if (stopping) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          sleepers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        sleepers.add(done);
      });
    },
    requestStop(): void {
      if (stopping) return;
      stopping = true;
      inFlight.abort();
      for (const wake of [...sleepers]) wake();
    },
  };
}

/*
 * Le rattrapage.
 */

/** Ce qu'un cycle a fait, tous comptes confondus. */
type CycleReport = {
  observed: number;
  withoutLocation: number;
  unsupported: number;
  failed: number;
};

function emptyReport(): CycleReport {
  return { observed: 0, withoutLocation: 0, unsupported: 0, failed: 0 };
}

function countStatus(report: CycleReport, status: ActivityWeatherStatus | null): void {
  if (status === 'observed') report.observed += 1;
  else if (status === 'no-location') report.withoutLocation += 1;
  else if (status === 'unsupported') report.unsupported += 1;
  else if (status === 'failed') report.failed += 1;
}

function totalOf(report: CycleReport): number {
  return report.observed + report.withoutLocation + report.unsupported + report.failed;
}

/** Compte rendu d'un cycle, dans l'ordre où ça intéresse quelqu'un qui lit les logs. */
function cycleSummary(report: CycleReport): string {
  const parts = [`${report.observed} relevée(s)`];
  if (report.withoutLocation > 0) parts.push(`${report.withoutLocation} sans position`);
  if (report.unsupported > 0) parts.push(`${report.unsupported} hors couverture`);
  if (report.failed > 0) parts.push(`${report.failed} en échec`);
  return parts.join(', ');
}

/**
 * Un cycle pour un athlète : au plus {@link MAX_LOOKUPS_PER_CYCLE} séances,
 * espacées de {@link lookupSpacingMs}.
 *
 * Le premier relevé part sans attendre — l'espacement sépare deux appels, il ne
 * retarde pas le cycle.
 */
async function runCycleForAthlete(
  athleteId: number,
  controls: StopControls,
  report: CycleReport,
): Promise<void> {
  const targets = await listActivitiesAwaitingWeather(athleteId, MAX_LOOKUPS_PER_CYCLE);

  for (const [index, target] of targets.entries()) {
    if (controls.stopping) return;

    const spacing = lookupSpacingMs(index);
    if (spacing > 0) await controls.sleep(spacing);
    if (controls.stopping) return;

    const status = await lookupForTarget(target, athleteId, { signal: controls.signal });
    countStatus(report, status);
  }
}

/**
 * Le relevé de prévisions d'un athlète, journalisé.
 *
 * Rien n'est écrit dans le journal quand il n'y avait rien à faire : le
 * rendez-vous est quotidien, mais la question est posée toutes les minutes.
 *
 * Ses erreurs sont attrapées **ici** : une prévision qui ne se relève pas ne
 * doit pas coûter le rattrapage des séances passées du même cycle, qui n'a rien
 * à voir avec elle.
 */
async function runForecastForAthlete(athleteId: number, controls: StopControls): Promise<void> {
  try {
    const report = await runDailyForecast(athleteId, { signal: controls.signal });
    if (report === null) return;

    const day = `prévisions du ${report.readingDay}`;

    if (report.status === 'forecast') {
      log(`${day} : ${report.days} jour(s) relevé(s).`);
      return;
    }
    if (report.status === 'no-location') {
      log(
        `${day} : aucune sortie géolocalisée récente, donc aucun lieu à interroger — pas de prévision.`,
      );
      return;
    }
    logError(`${day} : ${report.reason ?? 'échec sans motif'}`);
  } catch (error) {
    if (controls.stopping) return;
    logError(`prévisions : relevé impossible — ${errorMessage(error)}`);
  }
}

type LoopState = {
  /** Le premier cycle annonce toujours son résultat, même vide : c'est la réponse à « est-ce que ça marche ? ». */
  announcedFirstCycle: boolean;
};

/**
 * La boucle de rattrapage : un tour = un cycle **par athlète**.
 *
 * Aucun athlète n'en fait échouer un autre. Une base injoignable ne dit **rien**
 * du travail restant : elle se journalise comme une panne, jamais comme un
 * service au repos.
 */
async function backfillLoop(controls: StopControls, state: LoopState): Promise<void> {
  while (!controls.stopping) {
    const report = emptyReport();
    let scanned = false;

    try {
      for (const athleteId of await listAthleteIds()) {
        if (controls.stopping) break;
        // Le rendez-vous du matin d'abord : il ne coûte qu'une lecture d'état
        // les 1 439 minutes où il n'est pas dû, et il ne doit pas attendre la
        // fin d'un rattrapage d'historique pour avoir lieu.
        await runForecastForAthlete(athleteId, controls);
        if (controls.stopping) break;
        await runCycleForAthlete(athleteId, controls, report);
      }
      scanned = true;
    } catch (error) {
      // « le cycle », et non « le rattrapage » : ce tour porte aussi le relevé
      // des prévisions, et une base injoignable les emporte tous les deux. Un
      // message qui ne nommerait que le rattrapage laisserait croire que les
      // prévisions, elles, sont à jour.
      if (!controls.stopping) logError(`cycle météo impossible — ${errorMessage(error)}`);
    }

    if (!controls.stopping && scanned) {
      // Un cycle vide se tait pour ne pas noyer les journaux — sauf le premier
      // après un démarrage, qui annonce toujours son résultat.
      if (totalOf(report) > 0) {
        log(`rattrapage : ${cycleSummary(report)}.`);
      } else if (!state.announcedFirstCycle) {
        log('rattrapage : aucune séance en attente de météo.');
      }
      state.announcedFirstCycle = true;
    }

    if (controls.stopping) break;
    await controls.sleep(CYCLE_INTERVAL_MS);
  }
}

/**
 * Dernier recours : ce qui aurait dû tuer la boucle la relance à la place. Rien
 * de la météo ne doit pouvoir faire tomber le serveur HTTP.
 */
async function runForever(loop: () => Promise<void>, controls: StopControls): Promise<void> {
  while (!controls.stopping) {
    try {
      await loop();
      return;
    } catch (error) {
      if (controls.stopping) return;
      logError(
        `rattrapage : erreur inattendue (${errorMessage(error)}) — reprise dans ${LOOP_RESTART_DELAY_MS / 1_000} s.`,
      );
      await controls.sleep(LOOP_RESTART_DELAY_MS);
    }
  }
}

export type WeatherService = {
  /**
   * Demande l'arrêt : le drapeau est levé et les appels en vol annulés
   * **synchroniquement**. La promesse rendue se résout quand la boucle a rendu
   * la main — un confort, pas une garantie (Next appelle `process.exit` dès sa
   * propre fermeture faite). Sans conséquence ici : une tentative interrompue
   * n'écrit rien, et la séance reste candidate au prochain démarrage.
   */
  stop(): Promise<void>;
};

/**
 * Démarre le rattrapage de la météo et rend la main aussitôt.
 *
 * Ne lève jamais : tout ce qui peut mal se passer est journalisé et laisse le
 * serveur HTTP intact.
 */
export function startWeatherService(): WeatherService {
  const controls = createStopControls();

  log(
    `rattrapage météo démarré — Open-Meteo, au plus ${MAX_LOOKUPS_PER_CYCLE} séances par cycle de ${CYCLE_INTERVAL_MS / 1_000} s, espacées de ${lookupSpacingMs(1)} ms.`,
  );
  log(
    `prévisions : un relevé par compte et par jour à ${FORECAST_READING_HOUR} h locales (${FORECAST_HORIZON_DAYS} jours d'horizon), rattrapé au premier cycle si l'heure a été manquée.`,
  );

  const state: LoopState = { announcedFirstCycle: false };
  const running = runForever(() => backfillLoop(controls, state), controls)
    .then(() => {
      log('rattrapage météo arrêté.');
    })
    .catch((error: unknown) => {
      // Filet ultime : `runForever` attrape déjà tout ce qu'il sait nommer.
      logError(`rattrapage météo arrêté sur une erreur imprévue : ${errorMessage(error)}`);
    });

  return {
    stop(): Promise<void> {
      controls.requestStop();
      return running;
    },
  };
}
