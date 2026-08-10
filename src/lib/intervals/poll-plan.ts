/**
 * Logique de décision du rapatriement intervals.icu — fonctions pures, sans I/O.
 *
 * Le poller (`scripts/fit-watcher.ts`) se contente de lister les activités
 * distantes et les fichiers déjà présents, d'appeler {@link planPoll}, puis de
 * télécharger ce qu'on lui désigne. Tout ce qui se raisonne (nom déterministe,
 * activité déjà rapatriée, activité sans fichier, cadence des cycles) vit ici
 * pour rester testable sans réseau ni système de fichiers.
 *
 * **L'état de la déduplication, c'est le système de fichiers.** Une activité est
 * « déjà rapatriée » si son fichier existe dans la boîte de dépôt ou dans ses
 * archives (`processed/`, `failed/`) — rien à stocker en base, rien à
 * reconstruire après un redémarrage. Et si un double téléchargement passait
 * malgré tout, l'empreinte SHA-256 en base retombe sur la même activité.
 */

/** Préfixe des fichiers déposés par le poller, qui les distingue des dépôts WebDAV. */
const FILE_PREFIX = 'intervals-';

/** Seule extension que le watcher ingère (cf. `src/lib/fit/watch-plan.ts`). */
const FILE_EXTENSION = '.fit';

/**
 * Source d'activité pour laquelle l'endpoint de téléchargement est explicitement
 * hors service (« Strava activities not supported » dans la spec OpenAPI) : on
 * ne l'interroge pas plutôt que de collectionner les 404. Trainarr n'a de toute
 * façon pas de connexion Strava.
 */
const UNSUPPORTED_SOURCE = 'STRAVA';

/**
 * Identifiants acceptés dans un nom de fichier.
 *
 * L'id vient du réseau et sert à construire un chemin : ce filtre est ce qui
 * garantit qu'aucun `/`, `..` ni caractère de contrôle n'y arrive. Les
 * identifiants intervals.icu sont de la forme `i123456789`, la classe reste
 * volontairement un peu plus large.
 */
const SAFE_ACTIVITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `true` si l'identifiant peut sans risque composer un nom de fichier. */
export function isSafeActivityId(activityId: string): boolean {
  return SAFE_ACTIVITY_ID.test(activityId);
}

/**
 * Nom déterministe du fichier rapatrié. Déterministe est le mot important :
 * c'est lui qui rend la déduplication possible sans état.
 */
export function inboxFileName(activityId: string): string {
  return `${FILE_PREFIX}${activityId}${FILE_EXTENSION}`;
}

/** Les champs d'une activité distante dont la décision dépend. */
export type PollCandidate = {
  id: string;
  source: string | null;
};

export type PollContext = {
  /**
   * Noms de fichiers déjà présents dans la boîte de dépôt **et** ses archives
   * (`processed/`, `failed/`), tous dossiers confondus.
   */
  existingNames: ReadonlySet<string>;
  /**
   * Identifiants dont l'API a répondu « pas de fichier », associés à l'instant
   * de cette réponse. Sans cette mémoire, une séance saisie à la main serait
   * redemandée à chaque cycle tant qu'elle reste dans la fenêtre.
   *
   * La carte est purgée par {@link purgeExpiredWithoutFile} : passé
   * {@link WITHOUT_FILE_TTL_MS}, l'activité redevient candidate.
   */
  knownWithoutFile: ReadonlyMap<string, number>;
};

export type PlannedDownload = {
  activityId: string;
  /** Nom sous lequel déposer le fichier dans la boîte d'import. */
  fileName: string;
};

export type PollPlan = {
  /** Activités à télécharger, dans l'ordre de la liste fournie. */
  toDownload: PlannedDownload[];
  /**
   * Identifiants écartés parce qu'ils ne composent pas un nom de fichier sûr.
   * Remontés plutôt que tus : c'est le signe d'une API qui a changé.
   */
  invalidIds: string[];
};

/** Quelles activités rapatrier, compte tenu de ce qui est déjà sur le disque. */
export function planPoll(
  activities: readonly PollCandidate[],
  context: PollContext,
): PollPlan {
  const plan: PollPlan = { toDownload: [], invalidIds: [] };
  /** Une même activité listée deux fois ne doit pas être téléchargée deux fois. */
  const planned = new Set<string>();

  for (const activity of activities) {
    if (!isSafeActivityId(activity.id)) {
      plan.invalidIds.push(activity.id);
      continue;
    }
    if (activity.source === UNSUPPORTED_SOURCE) continue;
    if (context.knownWithoutFile.has(activity.id)) continue;

    const fileName = inboxFileName(activity.id);
    if (context.existingNames.has(fileName)) continue;
    if (planned.has(fileName)) continue;

    planned.add(fileName);
    plan.toDownload.push({ activityId: activity.id, fileName });
  }

  return plan;
}

/*
 * Cadence des cycles.
 */

/**
 * Plafond de toute attente du poller : une heure.
 *
 * Au-delà de 2³¹−1 ms (~24,8 jours), `setTimeout` déborde et Node retombe
 * **à 1 ms** — l'attente censée protéger l'API devient une boucle chaude qui la
 * martèle. Un `Retry-After` daté de 2099, renvoyé par n'importe quel WAF sur le
 * chemin, suffit à provoquer ce basculement. Le plafond est donc appliqué à
 * toute valeur venue du réseau *comme* à l'intervalle configuré : au pire on
 * réessaie une heure plus tôt que demandé, ce qui reste courtois.
 */
export const MAX_SLEEP_MS = 60 * 60 * 1000;

/**
 * Attente avant le prochain cycle, en millisecondes : jamais moins que
 * l'intervalle configuré, jamais moins que le `Retry-After` de l'API, jamais
 * plus que {@link MAX_SLEEP_MS}.
 */
export function nextPollDelayMs(retryAfterS: number | null, pollIntervalS: number): number {
  const requestedS = Math.max(retryAfterS ?? 0, pollIntervalS, 0);
  return Math.min(requestedS * 1000, MAX_SLEEP_MS);
}

/*
 * Mémoires du poller.
 */

/**
 * Durée de validité d'un « pas de fichier ».
 *
 * Un 404 peut être transitoire (fichier encore en cours de traitement chez
 * intervals.icu, incident passager). Mémoriser la réponse pour toute la vie d'un
 * process qui tourne des mois reviendrait à perdre définitivement une séance
 * réelle, sans autre trace qu'une ligne de journal. Passé un jour, on retente.
 */
export const WITHOUT_FILE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Oublie les activités marquées « sans fichier » depuis plus de
 * {@link WITHOUT_FILE_TTL_MS}. Mute la carte en place — elle est la mémoire du
 * poller, pas une valeur de retour.
 */
export function purgeExpiredWithoutFile(withoutFile: Map<string, number>, now: number): void {
  for (const [activityId, seenAt] of withoutFile) {
    if (now - seenAt >= WITHOUT_FILE_TTL_MS) withoutFile.delete(activityId);
  }
}

/**
 * `true` la première fois que cet identifiant est présenté, `false` ensuite.
 *
 * Deux journaux répétés à chaque cycle noieraient le reste : un identifiant
 * illisible ne redeviendra pas lisible, et une séance sans fichier n'a pas
 * besoin d'être signalée à chaque nouvelle tentative. Mute `seen` en place.
 */
export function shouldLogOnce(seen: Set<string>, activityId: string): boolean {
  if (seen.has(activityId)) return false;
  seen.add(activityId);
  return true;
}

/*
 * Activation du poller.
 */

/** Les deux variables d'environnement sans lesquelles le poller ne démarre pas. */
export function missingIntervalsSettings(settings: {
  athleteId: string | undefined;
  apiKey: string | undefined;
}): string[] {
  const missing: string[] = [];
  if (settings.athleteId === undefined) missing.push('INTERVALS_ATHLETE_ID');
  if (settings.apiKey === undefined) missing.push('INTERVALS_API_KEY');
  return missing;
}
