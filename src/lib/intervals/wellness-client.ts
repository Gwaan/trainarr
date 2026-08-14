/**
 * Client HTTP du **relevé bien-être** intervals.icu : HRV, FC de repos,
 * sommeil, poids, jour par jour.
 *
 * Même API, même authentification et mêmes garde-fous que `./client.ts`, dont ce
 * module réutilise l'appel de base ({@link authorizedRequest}) et la lecture de
 * corps validée ({@link parseJsonBody}) plutôt que d'en écrire une seconde
 * version.
 *
 * ## ⚠ Un schéma tiré de la documentation, jamais d'une réponse constatée
 *
 * **C'est le seul module du dépôt dans ce cas, et il faut le savoir en le
 * lisant.** L'endpoint exige une clé API personnelle : il n'a pas pu être appelé
 * pendant l'écriture, et rien de ce qui suit n'a été confronté au service réel.
 * Trois conséquences, assumées :
 *
 * 1. **Tout champ est facultatif** (`nullish`). Un champ absent est une mesure
 *    absente — une nuit sans ceinture, une journée sans pesée — jamais une
 *    réponse malformée. Ce qui n'est pas reconnu est ignoré par le schéma.
 * 2. **Une forme inattendue lève**, avec le nom des champs en défaut
 *    ({@link parseJsonBody}) : au premier vrai appel, le journal dira exactement
 *    quoi corriger ici. Un `safeParse` silencieux aurait rendu une liste vide et
 *    laissé croire à un athlète sans données.
 * 3. **Le nommage est le point le plus incertain.** La documentation donne les
 *    champs de l'objet Wellness en **camelCase** (`restingHR`, `sleepSecs`,
 *    `avgSleepingHR`), là où l'objet Activity du même service est en snake_case
 *    (`start_date_local`). Les deux graphies sont donc acceptées ici pour chaque
 *    champ : c'est la seule tolérance de ce module, et elle ne coûte rien
 *    puisqu'une seule des deux arrivera.
 *
 * ## Ce que ce module ne lit pas, et ne lira jamais
 *
 * L'objet Wellness d'intervals.icu porte aussi `ctl`, `atl`, `rampRate`,
 * `ctlLoad`… — **les charges que le service calcule de son côté**. Elles ne sont
 * ni lues ni stockées : Trainarr calcule les siennes depuis ses propres
 * activités (`lib/metrics/load.ts`), et deux vérités concurrentes sous le même
 * nom sont exactement ce que `CLAUDE.md` interdit.
 *
 * ## Documentation utilisée
 *
 * Spécification OpenAPI : <https://intervals.icu/api/v1/docs>.
 * `GET /api/v1/athlete/{id}/wellness` — « Get wellness records for a date
 * range », paramètres `oldest` et `newest` au même format de **date locale** que
 * la liste des activités (`yyyy-MM-dd`). Chaque enregistrement est daté par son
 * champ `id`, qui vaut la date civile du jour décrit (l'athlète est déjà dans le
 * chemin, l'identifiant n'a donc rien d'autre à porter).
 *
 * Module pur : aucun accès base ni système de fichiers, `fetch` injectable. La
 * clé API ne transite que dans l'en-tête `Authorization`.
 */

import { z } from 'zod';

import { isCivilDate } from '@/lib/dates/civil';

import {
  authorizedRequest,
  IntervalsApiError,
  INTERVALS_BASE_URL,
  parseJsonBody,
  type FetchLike,
} from './client';

/**
 * Les seuls champs du relevé bien-être que Trainarr lit.
 *
 * Chaque mesure est déclarée dans ses deux graphies possibles (cf. l'en-tête) et
 * tolérante par construction : `nullish` partout, aucune borne, aucun refus. Le
 * schéma ne peut donc échouer que sur la **forme** — un objet là où un tableau
 * était attendu, une mesure rendue en chaîne — et c'est exactement ce qu'on veut
 * voir lever.
 */
const wellnessListSchema = z.array(
  z.object({
    /** Date civile du jour décrit, `yyyy-MM-dd`. */
    id: z.union([z.string(), z.number()]).nullish(),
    /** Repli : si l'API datait ses enregistrements autrement que par `id`. */
    date: z.string().nullish(),
    restingHR: z.number().nullish(),
    resting_hr: z.number().nullish(),
    /** rMSSD, en millisecondes. */
    hrv: z.number().nullish(),
    sleepSecs: z.number().nullish(),
    sleep_secs: z.number().nullish(),
    sleepScore: z.number().nullish(),
    sleep_score: z.number().nullish(),
    avgSleepingHR: z.number().nullish(),
    avg_sleeping_hr: z.number().nullish(),
    /** Poids en kilogrammes. */
    weight: z.number().nullish(),
  }),
);

type WellnessRecord = z.infer<typeof wellnessListSchema>[number];

/**
 * Le relevé d'une journée, tel que Trainarr le retient.
 *
 * Toutes les mesures sont `number | null` : `null` est une **absence de
 * mesure**, jamais un zéro. Les unités sont dans les noms, comme partout.
 */
export type WellnessReading = {
  /** Jour civil `YYYY-MM-DD` décrit par ce relevé. */
  day: string;
  restingHrBpm: number | null;
  /** Variabilité cardiaque nocturne (rMSSD), en millisecondes. */
  hrvRmssdMs: number | null;
  sleepTimeS: number | null;
  /** Score de sommeil de la montre, sur 100. */
  sleepScore: number | null;
  avgSleepingHrBpm: number | null;
  weightKg: number | null;
};

/** La première des deux graphies qui porte une valeur — `null` si aucune. */
function pick(...values: readonly (number | null | undefined)[]): number | null {
  for (const value of values) {
    // `Number.isFinite` écarte aussi `NaN` : un JSON peut porter un nombre, pas
    // un `NaN`, mais rien n'oblige à faire confiance à ce qu'on n'a pas vu.
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Entier arrondi, ou `null`.
 *
 * Les deux mesures concernées sont des entiers côté service (des battements par
 * minute, des secondes) : l'arrondi n'est pas une approximation de la mesure,
 * c'est le format dans lequel elle est déjà donnée. Il existe pour que la
 * colonne `integer` ne reçoive jamais un flottant, quoi qu'envoie l'API.
 */
function toInteger(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/** Le jour décrit par un enregistrement, `null` s'il n'est pas exploitable. */
function readDay(record: WellnessRecord): string | null {
  const raw = typeof record.id === 'string' ? record.id : (record.date ?? null);
  if (raw === null) return null;

  // Certains enregistrements pourraient dater à la seconde ; seule la journée
  // nous intéresse, et une date qui n'est pas une date se jette.
  const day = raw.slice(0, 10);
  return isCivilDate(day) ? day : null;
}

/** Un enregistrement de l'API vers son DTO. */
function toWellnessReading(record: WellnessRecord, day: string): WellnessReading {
  return {
    day,
    restingHrBpm: toInteger(pick(record.restingHR, record.resting_hr)),
    hrvRmssdMs: pick(record.hrv),
    sleepTimeS: toInteger(pick(record.sleepSecs, record.sleep_secs)),
    sleepScore: pick(record.sleepScore, record.sleep_score),
    avgSleepingHrBpm: pick(record.avgSleepingHR, record.avg_sleeping_hr),
    weightKg: pick(record.weight),
  };
}

export type FetchWellnessParams = {
  /** Identifiant d'athlète intervals.icu (`i123456`, ou `0` pour le porteur de la clé). */
  athleteId: string;
  apiKey: string;
  /** Bornes **civiles** `YYYY-MM-DD`, incluses, en heure locale de l'athlète. */
  oldest: string;
  newest: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Annulation de l'appel en vol (arrêt du service). Combiné au délai de garde. */
  signal?: AbortSignal;
};

/**
 * Les relevés bien-être de la fenêtre demandée, un par jour renseigné.
 *
 * Les journées **sans aucune mesure** sont rendues telles quelles (tous les
 * champs à `null`) : c'est à l'appelant d'en faire ce qu'il veut, et les écarter
 * ici reviendrait à décider à sa place qu'un jour vide n'existe pas.
 *
 * **Lève** si la réponse porte des enregistrements mais qu'aucun n'a pu être
 * daté : c'est la seule vérification de fond de ce module, et elle existe pour
 * le cas précis où le schéma se révélerait faux au premier vrai appel — mieux
 * vaut un cycle en échec, avec son message dans les journaux, qu'un « aucune
 * donnée bien-être » définitif et silencieux.
 */
export async function fetchWellness(params: FetchWellnessParams): Promise<WellnessReading[]> {
  const url = new URL(
    `/api/v1/athlete/${encodeURIComponent(params.athleteId)}/wellness`,
    params.baseUrl ?? INTERVALS_BASE_URL,
  );
  url.searchParams.set('oldest', params.oldest);
  url.searchParams.set('newest', params.newest);

  const context = 'relevé bien-être intervals.icu';
  const response = await authorizedRequest(
    url.toString(),
    params.apiKey,
    params.fetchImpl ?? globalThis.fetch,
    context,
    { signal: params.signal },
  );

  if (!response.ok) {
    throw new IntervalsApiError(`${context} : HTTP ${response.status}.`, response.status);
  }

  const records = await parseJsonBody(response, context, wellnessListSchema);

  const readings: WellnessReading[] = [];
  for (const record of records) {
    const day = readDay(record);
    if (day === null) continue;
    readings.push(toWellnessReading(record, day));
  }

  if (records.length > 0 && readings.length === 0) {
    throw new IntervalsApiError(
      `${context} : ${records.length} enregistrement(s) reçus, aucun daté — le jour est attendu dans le champ « id » au format AAAA-MM-JJ. Le schéma de ce module doit être corrigé contre la réponse réelle.`,
      response.status,
    );
  }

  return readings;
}
