/**
 * Décisions pures de la météo d'activité — aucun réseau, aucune base, aucun
 * système de fichiers.
 *
 * Le client (`./client.ts`) et le service de rattrapage (`./service.ts`) ne font
 * qu'exécuter ce qui se décide ici : quelles coordonnées sont envoyées à
 * Open-Meteo, quelle API interroger, quelle heure retenir, et à quelle cadence
 * rattraper l'historique.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/*
 * Coordonnées : ce qu'on accepte d'envoyer à un tiers.
 */

/**
 * Décimales conservées sur les coordonnées envoyées à Open-Meteo.
 *
 * **Deux décimales ≈ 1,1 km** en latitude (et moins encore en longitude sous nos
 * latitudes). C'est un arbitrage de vie privée, pas d'économie d'octets : le
 * premier point d'une sortie, c'est le pas de la porte. Envoyer une position au
 * mètre près à un service tiers reviendrait à lui donner l'adresse du domicile à
 * chaque séance, alors que la météo ne s'en sert pas.
 *
 * La précision perdue est de toute façon rendue par l'API : vérifié contre le
 * service réel, une demande sur `48.85 / 2.35` est ramenée à `48.84 / 2.36` par
 * la grille de prévision, et à `48.822495 / 2.2881355` par la grille ERA5 de
 * l'archive — soit une maille d'une dizaine de kilomètres. Un chiffre de plus
 * n'aurait donc jamais changé une seule mesure.
 */
export const COORDINATE_DECIMALS = 2;

const COORDINATE_FACTOR = 10 ** COORDINATE_DECIMALS;

/** Un point, tel qu'il part sur le réseau. */
export type Coordinates = {
  latitudeDeg: number;
  longitudeDeg: number;
};

/** Une coordonnée ramenée à {@link COORDINATE_DECIMALS} décimales. */
export function roundCoordinate(degrees: number): number {
  return Math.round(degrees * COORDINATE_FACTOR) / COORDINATE_FACTOR;
}

/**
 * Le point à envoyer, ou `null` si celui de l'activité n'en est pas un.
 *
 * Un fichier FIT peut porter un point de garde (`0/0`, au large du golfe de
 * Guinée) ou une valeur hors bornes quand le GPS n'avait pas encore accroché :
 * ce n'est pas une position, et Open-Meteo répondrait très sérieusement la météo
 * de l'Atlantique. Mieux vaut « pas de coordonnées » qu'une météo inventée.
 */
export function toRequestCoordinates(latitudeDeg: number, longitudeDeg: number): Coordinates | null {
  if (!Number.isFinite(latitudeDeg) || !Number.isFinite(longitudeDeg)) return null;
  if (latitudeDeg < -90 || latitudeDeg > 90) return null;
  if (longitudeDeg < -180 || longitudeDeg > 180) return null;
  if (latitudeDeg === 0 && longitudeDeg === 0) return null;

  return {
    latitudeDeg: roundCoordinate(latitudeDeg),
    longitudeDeg: roundCoordinate(longitudeDeg),
  };
}

/**
 * Premier point exploitable d'un flux `latlng`, dans l'ordre du fichier.
 *
 * C'est là que la séance a commencé — et un flux GPS est clairsemé par nature
 * (cf. `.claude/rules/data-import.md`), ses premiers points peuvent être `null`
 * le temps que la montre accroche.
 */
export function firstFixedPoint(
  points: readonly (readonly [number, number] | null)[],
): Coordinates | null {
  for (const point of points) {
    if (point === null) continue;
    const coordinates = toRequestCoordinates(point[0], point[1]);
    if (coordinates !== null) return coordinates;
  }
  return null;
}

/*
 * Quelle API interroger.
 */

/**
 * Les deux points d'entrée d'Open-Meteo, qui ne couvrent pas la même chose.
 *
 * - `forecast` : l'API de prévision, dont le paramètre `past_days` remonte
 *   jusqu'à **92 jours** en arrière, **sans latence** — c'est elle, et elle
 *   seule, qui connaît la séance d'hier ;
 * - `archive` : la réanalyse ERA5, depuis 1940, **avec 5 jours de latence**.
 */
export const WEATHER_SOURCES = ['forecast', 'archive'] as const;

export type WeatherSource = (typeof WEATHER_SOURCES)[number];

/**
 * Âge au-delà duquel une séance se lit dans l'archive.
 *
 * Le seuil est **volontairement à l'intérieur des deux couvertures** : la
 * prévision remonte à 92 jours et l'archive accuse 5 jours de retard, donc tout
 * seuil entre 6 et 92 jours est servi par les deux. 80 jours laisse douze jours
 * de marge à la borne haute — l'API calcule sa fenêtre en jours civils et sur
 * son horloge, pas sur la nôtre (vérifié : `start_hour` hors plage est refusé
 * net, avec sa plage autorisée dans le message) — tout en préférant la prévision
 * aussi longtemps que possible : sa grille est plus fine que celle d'ERA5 et sa
 * réponse revient en quelques dizaines de millisecondes là où l'archive en
 * demande plusieurs secondes.
 */
export const FORECAST_MAX_AGE_DAYS = 80;

/** Laquelle des deux APIs connaît cet instant. */
export function chooseWeatherSource(instant: Date, now: Date): WeatherSource {
  const ageDays = (now.getTime() - instant.getTime()) / DAY_MS;
  return ageDays <= FORECAST_MAX_AGE_DAYS ? 'forecast' : 'archive';
}

/*
 * Quelle heure retenir.
 */

/**
 * Durée maximale prise en compte pour placer l'échantillon.
 *
 * `elapsed_time_s` vient d'un fichier ; une valeur aberrante (compteur non
 * arrêté, chronomètre parti en vrille) ne doit pas déplacer la demande de
 * plusieurs jours et faire relever la météo d'une tout autre journée.
 */
export const MAX_SESSION_SPAN_S = 24 * 60 * 60;

/**
 * L'instant dont on veut la météo : le **milieu** de la séance.
 *
 * Ni le départ ni l'arrivée : d'une sortie longue, l'athlète retient les
 * conditions qu'il a eues *pendant*, et le milieu est le seul instant qui ne
 * privilégie aucun des deux bouts. Sur une séance d'une heure, l'écart avec le
 * départ est d'une demi-heure — au plus un échantillon horaire.
 */
export function weatherSampleInstant(startedAt: Date, elapsedTimeS: number): Date {
  const span =
    Number.isFinite(elapsedTimeS) && elapsedTimeS > 0
      ? Math.min(elapsedTimeS, MAX_SESSION_SPAN_S)
      : 0;
  return new Date(startedAt.getTime() + (span / 2) * 1_000);
}

/** Bornes `start_hour` / `end_hour` d'une demande, telles que l'API les attend. */
export type HourWindow = {
  startHour: string;
  endHour: string;
};

/**
 * Un instant au format des paramètres horaires d'Open-Meteo :
 * `YYYY-MM-DDTHH:mm`, **sans fuseau**.
 *
 * L'API interprète ces bornes dans le fuseau de la requête, laissé à son défaut
 * (`GMT`) : la chaîne est donc construite en UTC, et les instants rendus sont
 * lus en UTC (`timeformat=unixtime`). C'est le seul montage qui ne dépend ni du
 * fuseau du serveur ni de celui de la séance.
 */
export function formatHourParam(instant: Date): string {
  return `${instant.toISOString().slice(0, 13)}:00`;
}

/**
 * La fenêtre horaire à demander autour d'un instant : l'heure pleine qui le
 * précède et la suivante.
 *
 * Deux échantillons, pas un : l'instant visé tombe presque toujours entre deux
 * heures pleines, et demander « l'heure du dessous » choisirait par défaut
 * plutôt que par proximité. Deux points, c'est quelques dizaines d'octets de
 * réponse pour un échantillon toujours à moins de trente minutes.
 */
export function hourWindowAround(instant: Date): HourWindow {
  const floored = Math.floor(instant.getTime() / HOUR_MS) * HOUR_MS;
  return {
    startHour: formatHourParam(new Date(floored)),
    endHour: formatHourParam(new Date(floored + HOUR_MS)),
  };
}

/**
 * Index de l'échantillon le plus proche de l'instant visé, `null` si la série
 * est vide.
 *
 * Les instants sont ceux qu'Open-Meteo a rendus (secondes Unix), pas ceux qu'on
 * a demandés : c'est l'API qui décide de la grille, on s'y aligne.
 */
export function pickNearestSampleIndex(
  timesEpochS: readonly number[],
  target: Date,
): number | null {
  const targetEpochS = target.getTime() / 1_000;

  let bestIndex: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [index, epochS] of timesEpochS.entries()) {
    const distance = Math.abs(epochS - targetEpochS);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

/*
 * Ce qu'une tentative a donné.
 */

/**
 * État de la météo d'une activité — c'est lui qui dit s'il faut redemander.
 *
 * - `observed` : mesures en base, rien à refaire (la météo d'une sortie passée
 *   ne change plus) ;
 * - `no-location` : l'activité n'a aucune position exploitable. Un tapis n'a pas
 *   de GPS et n'en aura jamais : **définitif**, sans quoi chaque cycle
 *   redemanderait la même séance jusqu'à la fin des temps ;
 * - `unsupported` : Open-Meteo a refusé la demande (coordonnées ou date hors de
 *   ce qu'il couvre). Refus argumenté du service, pas une panne : **définitif** ;
 * - `failed` : panne réseau, quota, 5xx, réponse illisible. **Réessayable**, un
 *   nombre borné de fois (cf. {@link RETRY_DELAYS_MS}).
 */
export const ACTIVITY_WEATHER_STATUSES = [
  'observed',
  'no-location',
  'unsupported',
  'failed',
] as const;

export type ActivityWeatherStatus = (typeof ACTIVITY_WEATHER_STATUSES)[number];

/** `true` si cet état peut encore changer en redemandant. */
export function isRetryableStatus(status: ActivityWeatherStatus): boolean {
  return status === 'failed';
}

/*
 * Cadence du rattrapage.
 */

/**
 * Nombre de séances traitées par cycle.
 *
 * Open-Meteo est gratuit et sans clé ; ses conditions d'utilisation non
 * commerciales annoncent « less than 10'000 API calls per day, 5'000 per hour
 * and 600 per minute ». Vingt relevés par minute, c'est 1 200 par heure — moins
 * du quart de la limite horaire, et de quoi combler un historique de plusieurs
 * centaines de séances en une demi-heure sans que personne n'ait à s'en occuper.
 *
 * Le reste est repris au cycle suivant : ce qui a été écrit (succès **comme**
 * échec) sort de l'ensemble des candidats, la reprise n'a donc rien à mémoriser.
 */
export const MAX_LOOKUPS_PER_CYCLE = 20;

/** Espacement entre deux relevés d'un même cycle — jamais de rafale. */
export const LOOKUP_SPACING_MS = 1_000;

/** Attente avant le relevé n° `index` d'un cycle : rien pour le premier. */
export function lookupSpacingMs(index: number): number {
  return index === 0 ? 0 : LOOKUP_SPACING_MS;
}

/**
 * Intervalle entre deux cycles de rattrapage.
 *
 * Une séance importée reçoit sa météo dans la foulée de l'ingestion : ce cycle
 * n'est pas le chemin nominal, c'est le filet — l'historique importé avant que
 * la météo n'existe, et les relevés qui ont échoué. Une minute suffit largement,
 * et garde le rattrapage sous les vingt appels par minute.
 */
export const CYCLE_INTERVAL_MS = 60_000;

/**
 * Délais avant chaque nouvelle tentative, indexés par le nombre de tentatives
 * déjà faites.
 *
 * Croissants et **en nombre fini** : une panne passagère (réseau du container,
 * Open-Meteo indisponible) est rattrapée dans le quart d'heure, tandis qu'une
 * séance qui échoue quatre fois sur plus d'une journée cesse de consommer un
 * créneau à chaque cycle. C'est le pendant du `WITHOUT_FILE_TTL_MS` du poller
 * intervals : ne jamais marteler pour une donnée qui ne vient pas.
 */
export const RETRY_DELAYS_MS: readonly number[] = [
  15 * 60 * 1_000,
  60 * 60 * 1_000,
  4 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
];

/** Nombre maximal de tentatives avant abandon d'une séance. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * Instant à partir duquel une séance en échec redevient candidate, `null` si
 * elle a épuisé ses tentatives.
 */
export function nextRetryAt(attempts: number, lastAttemptAt: Date): Date | null {
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (delay === undefined) return null;
  return new Date(lastAttemptAt.getTime() + delay);
}
