/**
 * Décisions pures de la météo **prévue** — aucun réseau, aucune base.
 *
 * Le pendant de `./plan.ts`, qui décide de la météo relevée des séances
 * effectuées. Ce qui se décide ici : quand le relevé du matin est dû, d'où
 * l'athlète part habituellement, jusqu'où la prévision porte, et ce qu'un écran
 * doit dire d'un jour qui n'en a pas.
 *
 * ## Une prévision n'est pas une observation
 *
 * C'est la distinction dont tout le reste découle. Une observation est
 * **immuable** et attachée à une activité : elle se relève une fois, elle ne
 * change plus. Une prévision est **périssable** et attachée à un jour : celle
 * d'après-demain écrite ce matin ne vaut plus rien demain matin. Les deux ne
 * partagent donc ni table, ni cadence, ni statut — les confondre finirait par
 * faire écraser une mesure par une estimation.
 */

import { APP_TIME_ZONE } from '@/config/time';
import { shiftCivilDate, toCivilDate } from '@/lib/dates/civil';

import type { Coordinates } from './plan';

/*
 * Le relevé du matin.
 */

/**
 * Heure locale du relevé quotidien, dans le fuseau de l'application.
 *
 * **Toutes** les prévisions à venir sont réévaluées à cette heure-là, en un seul
 * relevé dont toutes les séances héritent — jamais séance par séance, jamais
 * selon l'âge de chacune. Une prévision rafraîchie à des instants différents
 * selon la case du calendrier donnerait deux réponses contradictoires au même
 * écran.
 *
 * 6 h : après le calcul de nuit des modèles météo, avant une sortie matinale.
 */
export const FORECAST_READING_HOUR = 6;

const localHourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIME_ZONE,
  hour: '2-digit',
  // `hourCycle` explicite : selon la version d'ICU, `hour12: false` rend minuit
  // « 24 » et non « 00 ».
  hourCycle: 'h23',
});

/** Heure locale (0–23) d'un instant, dans le fuseau de l'application. */
function localHour(instant: Date): number {
  return Number(localHourFormatter.format(instant));
}

/**
 * Le **marqueur** du relevé en cours : la date civile du dernier passage de
 * {@link FORECAST_READING_HOUR} révolu.
 *
 * C'est ce repère, et non un âge en heures, qui décide de tout : avant 6 h, le
 * relevé courant est encore celui d'hier ; à 6 h passées, c'est celui
 * d'aujourd'hui. Comparer un marqueur mémorisé à celui de l'instant donne d'un
 * coup le relevé quotidien **et** son rattrapage — une application arrêtée à 6 h
 * (déploiement, redémarrage) revient avec un marqueur en retard et relève au
 * premier cycle, sans qu'aucun code de rattrapage n'ait à exister.
 */
export function forecastReadingMarker(now: Date): string {
  const today = toCivilDate(now);
  return localHour(now) < FORECAST_READING_HOUR ? shiftCivilDate(today, -1) : today;
}

/**
 * État du dernier relevé tenté, tel que la base le mémorise.
 *
 * Une tentative écrit **toujours** sa ligne, succès comme échec : c'est elle qui
 * porte le marqueur, et donc qui empêche de reprendre le même relevé à chaque
 * cycle. Même principe que `activity_weather`.
 */
export type ForecastRunState = {
  /** Marqueur du relevé dont cette ligne rend compte (cf. {@link forecastReadingMarker}). */
  readingDay: string;
  status: WeatherForecastStatus;
  /** Tentatives faites **pour ce marqueur** : le compteur repart à chaque matin. */
  attempts: number;
  lastAttemptAt: Date;
};

/**
 * Espacement des reprises, à l'intérieur d'une même matinée.
 *
 * Fixe, et non croissant comme celui des séances passées ({@link
 * RETRY_DELAYS_MS} dans `./plan.ts`) : la fenêtre utile d'une prévision du matin
 * se compte en heures, pas en jours. Une panne réseau au réveil du container est
 * rattrapée dans le quart d'heure ; passé {@link FORECAST_MAX_ATTEMPTS}, la
 * journée est abandonnée et l'écran le dit, plutôt que d'appeler Open-Meteo
 * toutes les minutes jusqu'au soir.
 */
export const FORECAST_RETRY_DELAY_MS = 15 * 60 * 1_000;

/** Tentatives au plus pour un matin — la première et trois reprises. */
export const FORECAST_MAX_ATTEMPTS = 4;

/**
 * Les états d'un relevé qui peuvent encore changer dans la matinée.
 *
 * `failed` va de soi : une panne passe. `no-location` mérite un mot, parce
 * qu'il a l'air définitif et ne l'est pas — le lieu se déduit des départs déjà
 * relevés par la météo des séances **passées**, dont le rattrapage tourne dans
 * la même boucle. Sur une installation neuve, le premier cycle ne trouve donc
 * aucune coordonnée alors même que l'athlète a des sorties géolocalisées : les
 * siennes n'ont simplement pas encore été relevées. Sans reprise, l'écran
 * annoncerait toute la journée « aucune sortie géolocalisée » — ce qui serait
 * faux.
 *
 * `unsupported` n'y est pas : Open-Meteo a examiné la demande et l'a refusée,
 * la reposer donnerait le même refus.
 */
const RETRYABLE_FORECAST_STATUSES: readonly WeatherForecastStatus[] = ['failed', 'no-location'];

/**
 * Le relevé du matin est-il dû ?
 *
 * Trois cas, et trois seulement :
 *
 * 1. **jamais relevé** — la première prévision de l'installation ;
 * 2. **marqueur dépassé** — 6 h sont passées depuis le dernier relevé. C'est le
 *    cas nominal *et* le rattrapage : que l'application ait tourné à 6 h ou
 *    qu'elle soit revenue à 9 h ne change rien au verdict ;
 * 3. **même marqueur, dernier essai sans résultat** — la matinée n'est pas
 *    finie, on reprend, un nombre borné de fois (cf.
 *    {@link RETRYABLE_FORECAST_STATUSES}).
 *
 * Un marqueur mémorisé **postérieur** à l'instant courant (horloge reculée) ne
 * déclenche rien : le relevé de ce matin a déjà eu lieu, le refaire ne
 * l'améliorerait pas.
 */
export function isForecastReadingDue(run: ForecastRunState | null, now: Date): boolean {
  if (run === null) return true;

  const marker = forecastReadingMarker(now);
  // Comparaison lexicographique : sur des dates civiles `YYYY-MM-DD` bien
  // formées, elle coïncide avec l'ordre chronologique.
  if (run.readingDay !== marker) return run.readingDay < marker;

  return (
    RETRYABLE_FORECAST_STATUSES.includes(run.status) &&
    run.attempts < FORECAST_MAX_ATTEMPTS &&
    now.getTime() - run.lastAttemptAt.getTime() >= FORECAST_RETRY_DELAY_MS
  );
}

/*
 * Le lieu.
 */

/**
 * Nombre de départs récents consultés pour déduire le lieu habituel.
 *
 * Trente sorties, soit six semaines à cinq séances : assez pour qu'un séjour
 * d'une semaine reste minoritaire, assez peu pour qu'un déménagement soit
 * pris en compte en moins de deux mois.
 */
export const HABITUAL_START_SAMPLE = 30;

/**
 * Écart entre deux départs, en degrés.
 *
 * Aucune correction de latitude : cette distance ne sert **qu'à comparer des
 * écarts entre eux** pour désigner le plus central des départs, jamais à
 * mesurer des kilomètres. Un facteur constant sur la longitude ne changerait
 * pas le classement entre un lieu de vie et un lieu de vacances.
 */
function separation(left: Coordinates, right: Coordinates): number {
  const dLat = left.latitudeDeg - right.latitudeDeg;
  const dLon = left.longitudeDeg - right.longitudeDeg;
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Le point de départ habituel de l'athlète, déduit de ses sorties récentes.
 *
 * **Le départ médian au sens du médoïde** : parmi les trente derniers départs,
 * celui dont la somme des distances à tous les autres est la plus faible. Une
 * séance à venir n'a pas de GPS et il n'était pas question d'ajouter un champ à
 * remplir — le lieu se déduit d'où l'athlète part réellement.
 *
 * Le choix est un choix de **résistance**, et c'est la seule propriété qui
 * compte ici. Tant que la majorité des départs récents est à la maison, un
 * départ de la maison bat n'importe quel départ de vacances : sa somme des
 * distances ne compte que les voyages, celle d'un point de vacances compte tous
 * les jours ordinaires. Une semaine à l'autre bout du pays, une course en
 * déplacement, un séjour professionnel ne déplacent donc rien. Une **moyenne**,
 * elle, aurait glissé de plusieurs dizaines de kilomètres au premier voyage et
 * rendu un point au milieu de nulle part.
 *
 * Deux variantes plus simples ont été écartées :
 *
 * - le **mode** (« le départ le plus fréquent ») : sur une grille au centième de
 *   degré, trois rues voisines tombent dans trois mailles distinctes, et le mode
 *   départage alors des ex æquo à une occurrence — un tirage au sort déguisé ;
 * - la **médiane composante par composante** : sur un nombre pair de départs
 *   exactement partagés entre deux lieux, elle marie la latitude de l'un à la
 *   longitude de l'autre et désigne un point où personne n'a jamais couru. Le
 *   médoïde, lui, **rend toujours un départ réellement observé**.
 *
 * À égalité parfaite, c'est le premier de la liste qui l'emporte : les départs
 * arrivent du plus récent au plus ancien, donc le lieu du moment.
 *
 * @param starts départs récents, **déjà arrondis** (cf. `toRequestCoordinates`),
 *   du plus récent au plus ancien.
 */
export function habitualStart(starts: readonly Coordinates[]): Coordinates | null {
  let best: Coordinates | null = null;
  let bestTotal = Number.POSITIVE_INFINITY;

  for (const candidate of starts) {
    let total = 0;
    for (const other of starts) total += separation(candidate, other);

    if (total >= bestTotal) continue;
    best = candidate;
    bestTotal = total;
  }

  return best;
}

/**
 * Le lieu **réglé** d'un compte : un libellé choisi par l'athlète et les
 * coordonnées que le géocodage lui a données.
 *
 * Les deux voyagent ensemble : les coordonnées sont ce qui part à Open-Meteo, le
 * libellé est ce que l'écran a le droit de dire (« Prévisions : Bordeaux »).
 */
export type ConfiguredForecastLocation = {
  label: string;
  /** Coordonnées **déjà arrondies** (cf. `toRequestCoordinates`). */
  coordinates: Coordinates;
};

/**
 * D'où vient le lieu des prévisions — la seule chose que l'écran ait besoin de
 * savoir pour ne plus laisser l'athlète deviner « c'est quelle ville ? ».
 *
 * - `configured` : l'athlète l'a réglé, et il porte donc un nom ;
 * - `derived` : déduit des départs récents. Il n'a pas de nom — on connaît un
 *   point, pas une ville, et inventer un libellé pour deux coordonnées serait
 *   exactement le genre d'approximation que ce projet s'interdit.
 */
export type ForecastLocation =
  | { source: 'configured'; label: string; coordinates: Coordinates }
  | { source: 'derived'; coordinates: Coordinates };

/**
 * Le lieu à interroger pour un compte : **le réglé, sinon le déduit, sinon
 * rien**.
 *
 * L'ordre n'est pas négociable et c'est tout l'objet de cette fonction : un lieu
 * réglé **supplante** le médoïde des départs, y compris quand l'athlète part
 * habituellement d'ailleurs. C'est le sens d'un réglage — sans quoi il faudrait
 * expliquer pourquoi la ville saisie n'est pas celle affichée.
 *
 * Le mode automatique (aucun réglage) reste le défaut, et le rendu est le même
 * qu'avant : `habitualStart` sur les départs récents, `null` quand il n'y en a
 * aucun (l'appelant en fait un `no-location`, réessayable dans la matinée).
 *
 * @param recentStarts départs récents, déjà arrondis, du plus récent au plus
 *   ancien. Ignorés quand un lieu est réglé — l'appelant peut donc s'épargner
 *   la lecture.
 */
export function resolveForecastLocation(input: {
  configured: ConfiguredForecastLocation | null;
  recentStarts: readonly Coordinates[];
}): ForecastLocation | null {
  if (input.configured !== null) {
    return {
      source: 'configured',
      label: input.configured.label,
      coordinates: input.configured.coordinates,
    };
  }

  const derived = habitualStart(input.recentStarts);
  return derived === null ? null : { source: 'derived', coordinates: derived };
}

/*
 * La portée.
 */

/**
 * Nombre de jours rendus par un relevé, aujourd'hui compris.
 *
 * C'est le maximum d'Open-Meteo (`forecast_days=16`), et un seul appel les rend
 * tous pour un lieu donné — d'où un appel par compte et par jour, jamais un par
 * séance.
 *
 * **Au-delà, il n'y a pas de prévision.** Pas une prévision moins sûre : pas de
 * prévision du tout. L'écran doit le dire.
 */
export const FORECAST_HORIZON_DAYS = 16;

/** Dernier jour civil couvert par un relevé fait le jour `today`. */
export function forecastHorizonLastDay(today: string): string {
  return shiftCivilDate(today, FORECAST_HORIZON_DAYS - 1);
}

/*
 * Ce qu'une tentative a donné.
 */

/**
 * État du dernier relevé de prévisions.
 *
 * Les mêmes familles que celles d'une activité (`ActivityWeatherStatus`), à un
 * mot près : le succès s'appelle ici `forecast` et non `observed`, parce que
 * rien n'a été observé — c'est une estimation, et le vocabulaire doit tenir la
 * distinction jusque dans la base.
 *
 * - `forecast` : prévisions en base pour la journée du marqueur ;
 * - `no-location` : aucune sortie géolocalisée récente, donc aucun lieu à
 *   interroger. **Réessayable** dans la matinée, et pas par excès de prudence :
 *   le lieu se lit dans la météo des séances passées, que le rattrapage écrit
 *   dans la même boucle (cf. {@link RETRYABLE_FORECAST_STATUSES}) ;
 * - `unsupported` : Open-Meteo a refusé la demande (coordonnées hors bornes).
 *   Refus argumenté, définitif pour la journée ;
 * - `failed` : panne réseau, quota, 5xx, réponse illisible. **Réessayable**
 *   dans la matinée (cf. {@link FORECAST_RETRY_DELAY_MS}).
 */
export const WEATHER_FORECAST_STATUSES = [
  'forecast',
  'no-location',
  'unsupported',
  'failed',
] as const;

export type WeatherForecastStatus = (typeof WEATHER_FORECAST_STATUSES)[number];

/*
 * La prévision d'un jour.
 */

/**
 * Ce qu'un relevé retient d'une journée.
 *
 * **Des agrégats de jour civil**, et c'est le seul choix honnête : une séance
 * planifiée porte une date, jamais une heure. Prétendre donner « la température
 * pendant la séance » demanderait une heure que le plan n'écrit pas.
 *
 * Le même type sert au client HTTP et au DAL : ce sont les mêmes valeurs, et
 * aucune n'est sensible — les coordonnées, elles, ne quittent jamais le
 * serveur.
 */
export type DailyForecast = {
  /** Jour civil `YYYY-MM-DD`, dans le fuseau de l'application. */
  date: string;
  /** Code WMO **dominant** de la journée (cf. `./wmo.ts`). */
  weatherCode: number | null;
  temperatureMaxC: number | null;
  temperatureMinC: number | null;
  /** Ressenti : humidité, vent et rayonnement compris. */
  apparentTemperatureMaxC: number | null;
  apparentTemperatureMinC: number | null;
  /** Cumul de précipitations **sur toute la journée**, en mm. */
  precipitationSumMm: number | null;
  /** Probabilité de précipitations la plus forte de la journée, en %. */
  precipitationProbabilityMaxPct: number | null;
  windSpeedMaxKmh: number | null;
};

/*
 * Ce qu'un écran doit dire.
 */

/**
 * Ce qu'il y a à afficher pour un jour donné — une réponse, toujours, jamais un
 * blanc.
 *
 * - `forecast` : la prévision existe, elle s'affiche ;
 * - `past` : le jour est passé. Une prévision n'a plus rien à y faire — c'est la
 *   météo **relevée** de l'activité qui parle (cf. `activity_weather`) ;
 * - `beyond-horizon` : au-delà des seize jours d'Open-Meteo. Il n'y a pas de
 *   prévision, et un blanc se lirait « beau temps » ;
 * - `no-location` / `unsupported` / `failed` : l'état du dernier relevé, tel
 *   qu'il est arrivé jusqu'à l'écran ;
 * - `pending` : aucun relevé n'a encore eu lieu (installation neuve, service qui
 *   vient de démarrer). Ce n'est pas une panne, et ça ne se dit pas pareil.
 */
export type ForecastAvailability =
  | 'forecast'
  | 'past'
  | 'beyond-horizon'
  | 'no-location'
  | 'unsupported'
  | 'failed'
  | 'pending';

/** Les raisons de n'avoir aucune prévision à afficher — tout sauf le succès. */
export type ForecastAbsence = Exclude<ForecastAvailability, 'forecast'>;

export type ForecastAbsenceInput = {
  /** Statut du dernier relevé, `null` si aucun n'a jamais eu lieu. */
  status: WeatherForecastStatus | null;
  /** Jour visé, date civile. */
  date: string;
  /** Jour courant, date civile. */
  today: string;
};

/**
 * Pourquoi un jour n'a pas de prévision — il en a **toujours** une raison, et
 * jamais un blanc.
 *
 * L'ordre des tests est celui de l'information la plus durable : la portée de
 * l'API l'emporte sur l'état du dernier relevé — un jour dans quarante jours
 * n'aura pas de prévision, que le relevé du matin ait réussi ou non.
 */
export function forecastAbsence(input: ForecastAbsenceInput): ForecastAbsence {
  if (input.date < input.today) return 'past';
  if (input.date > forecastHorizonLastDay(input.today)) return 'beyond-horizon';
  if (input.status === null) return 'pending';

  // Le relevé a réussi mais ne couvre pas ce jour : son marqueur date d'avant
  // (Open-Meteo compte ses seize jours depuis *son* aujourd'hui), le prochain
  // relevé le comblera. Rien n'est en panne, il n'y a rien à annoncer d'autre.
  if (input.status === 'forecast') return 'pending';

  return input.status;
}

export type ForecastAvailabilityInput = ForecastAbsenceInput & {
  /** Une prévision est-elle en base pour ce jour ? */
  hasForecast: boolean;
};

/**
 * Ce que l'écran a à dire d'un jour : sa prévision si elle existe, la raison de
 * son absence sinon.
 */
export function forecastAvailability(input: ForecastAvailabilityInput): ForecastAvailability {
  return input.hasForecast ? 'forecast' : forecastAbsence(input);
}

/**
 * La prévision d'un jour, ou la raison de ne pas en avoir — sous une forme dont
 * l'écran n'a plus à se demander si les deux sont cohérents.
 *
 * C'est le seul point d'entrée des composants : ils lisent la journée
 * directement dans la variante `forecast`, sans jamais avoir à retrouver
 * l'accord entre un statut et une liste.
 */
export type ResolvedForecast =
  | { availability: 'forecast'; day: DailyForecast }
  | { availability: ForecastAbsence; day: null };

export function resolveDayForecast(input: {
  status: WeatherForecastStatus | null;
  days: readonly DailyForecast[];
  date: string;
  today: string;
}): ResolvedForecast {
  const day = input.days.find((candidate) => candidate.date === input.date);
  if (day !== undefined) return { availability: 'forecast', day };

  return { availability: forecastAbsence(input), day: null };
}
