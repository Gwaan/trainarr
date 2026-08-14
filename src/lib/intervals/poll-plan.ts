/**
 * Logique de décision du rapatriement intervals.icu — fonctions pures, sans I/O.
 *
 * Le poller (`src/lib/fit/service.ts`) se contente de lister les activités
 * distantes et les fichiers déjà présents, d'appeler {@link planPollWindow} puis
 * {@link planPoll}, et de télécharger ce qu'on lui désigne. Tout ce qui se
 * raisonne (fenêtre interrogée, nom déterministe, activité déjà rapatriée,
 * activité sans fichier, plafond et cadence des cycles) vit ici pour rester
 * testable sans réseau ni système de fichiers.
 *
 * **L'état de la déduplication, c'est le système de fichiers.** Une activité est
 * « déjà rapatriée » si son fichier existe dans le dossier de l'athlète ou dans
 * ses archives (`processed/`, `failed/`) — rien à stocker en base, rien à
 * reconstruire après un redémarrage. Et si un double téléchargement passait
 * malgré tout, l'empreinte SHA-256 en base retombe sur la même activité.
 *
 * **Cet état est propre à chaque compte**, puisque chaque athlète a son dossier
 * (cf. `src/lib/fit/inbox-layout.ts`) : un compte neuf déclenche son backfill
 * complet même si le voisin a déjà rapatrié des années d'historique.
 */

/** Préfixe des fichiers déposés par le poller, qui les distingue de tout autre dépôt. */
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
  /**
   * Activités à télécharger pendant ce cycle, dans l'ordre de la liste fournie,
   * au plus {@link MAX_DOWNLOADS_PER_CYCLE}.
   */
  toDownload: PlannedDownload[];
  /**
   * Activités éligibles laissées de côté par le plafond du cycle. Strictement
   * positif = il reste du travail, le cycle suivant le reprendra.
   */
  remaining: number;
  /**
   * Identifiants écartés parce qu'ils ne composent pas un nom de fichier sûr.
   * Remontés plutôt que tus : c'est le signe d'une API qui a changé.
   */
  invalidIds: string[];
};

/**
 * Nombre maximal de fichiers rapatriés en un cycle.
 *
 * Un backfill d'historique désigne d'un coup plusieurs centaines d'activités,
 * donc autant de `GET /file`. Les enchaîner sans fin martèlerait l'API et
 * retarderait d'autant l'arrêt du service. Le reste est repris au cycle suivant :
 * la déduplication se faisant sur les fichiers déjà déposés, la reprise est
 * automatique et n'a rien à mémoriser.
 */
export const MAX_DOWNLOADS_PER_CYCLE = 50;

/** Quelles activités rapatrier, compte tenu de ce qui est déjà sur le disque. */
export function planPoll(activities: readonly PollCandidate[], context: PollContext): PollPlan {
  const eligible: PlannedDownload[] = [];
  const invalidIds: string[] = [];
  /** Une même activité listée deux fois ne doit pas être téléchargée deux fois. */
  const planned = new Set<string>();

  for (const activity of activities) {
    if (!isSafeActivityId(activity.id)) {
      invalidIds.push(activity.id);
      continue;
    }
    if (activity.source === UNSUPPORTED_SOURCE) continue;
    if (context.knownWithoutFile.has(activity.id)) continue;

    const fileName = inboxFileName(activity.id);
    if (context.existingNames.has(fileName)) continue;
    if (planned.has(fileName)) continue;

    planned.add(fileName);
    eligible.push({ activityId: activity.id, fileName });
  }

  // L'API liste les activités de la plus récente à la plus ancienne : couper la
  // fin du tableau, c'est reporter les plus vieilles. Une séance qui vient
  // d'arriver n'attend donc jamais la fin d'un backfill pour être ingérée.
  return {
    toDownload: eligible.slice(0, MAX_DOWNLOADS_PER_CYCLE),
    remaining: Math.max(0, eligible.length - MAX_DOWNLOADS_PER_CYCLE),
    invalidIds,
  };
}

/*
 * Fenêtre interrogée : backfill intégral ou fenêtre glissante.
 */

/**
 * Borne basse du backfill : antérieure à tout historique intervals.icu (le site
 * a ouvert en 2019), donc « toute l'histoire ». Midi UTC plutôt que minuit pour
 * que la conversion en date locale de l'athlète tombe sur le même jour civil
 * quel que soit son fuseau.
 */
export const BACKFILL_OLDEST_MS = Date.UTC(2000, 0, 1, 12);

/**
 * `true` si au moins une activité a déjà été rapatriée — les `.part` d'un
 * téléchargement interrompu ne comptent pas, ils ne prouvent aucun dépôt abouti.
 */
function hasRepatriatedFile(existingNames: ReadonlySet<string>): boolean {
  for (const name of existingNames) {
    if (name.startsWith(FILE_PREFIX) && name.endsWith(FILE_EXTENSION)) return true;
  }
  return false;
}

export type PollWindowContext = {
  /** Mêmes noms que {@link PollContext.existingNames} : inbox + `processed/` + `failed/`. */
  existingNames: ReadonlySet<string>;
  /**
   * Un cycle précédent a laissé des activités de côté (plafond atteint, quota,
   * panne). Tant que c'est vrai, la fenêtre historique est maintenue : sans
   * cela, les 50 premiers fichiers déposés feraient basculer le cycle suivant
   * sur la fenêtre glissante et le reste de l'historique ne serait jamais
   * demandé.
   */
  unfinished: boolean;
  /** Profondeur de la fenêtre glissante, en jours. */
  lookbackDays: number;
  /** Instant de référence, en millisecondes. */
  now: number;
};

export type PollWindow = {
  /** Borne basse à passer à l'API. */
  oldest: Date;
  /** `true` si cette fenêtre couvre tout l'historique. */
  backfill: boolean;
};

/**
 * Quelle fenêtre interroger à ce cycle.
 *
 * Au tout premier passage — aucun `intervals-*.fit` dans la boîte ni dans ses
 * archives — on demande **tout l'historique** : le rapatriement est un import
 * initial autant qu'un filet, et une installation neuve doit récupérer les
 * séances antérieures. Ensuite, la fenêtre glissante habituelle suffit.
 *
 * Un backfill relancé par accident (quelqu'un vide `processed/` à la main) est
 * inoffensif : les fichiers sont retéléchargés, mais l'empreinte SHA-256 en base
 * les ramène sur les mêmes activités — aucun doublon, seulement du trafic.
 */
export function planPollWindow(context: PollWindowContext): PollWindow {
  if (context.unfinished || !hasRepatriatedFile(context.existingNames)) {
    return { oldest: new Date(BACKFILL_OLDEST_MS), backfill: true };
  }
  return {
    oldest: new Date(context.now - context.lookbackDays * 24 * 60 * 60 * 1000),
    backfill: false,
  };
}

/** Espacement entre deux téléchargements consécutifs d'un même cycle. */
export const DOWNLOAD_SPACING_MS = 500;

/**
 * Pause observée **avant** un téléchargement, en millisecondes : nulle pour le
 * premier du cycle, {@link DOWNLOAD_SPACING_MS} pour les suivants.
 *
 * Une nouvelle séance ne doit pas attendre une demi-seconde pour rien, mais un
 * backfill ne doit pas non plus tirer cinquante fichiers d'affilée à pleine
 * vitesse : intervals.icu est un service gratuit tenu par une personne.
 */
export function downloadSpacingMs(index: number): number {
  return index === 0 ? 0 : DOWNLOAD_SPACING_MS;
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
 * Compte rendu d'un cycle.
 */

/** Ce qu'un cycle de rapatriement a produit, tel que le poller le mesure. */
export type PollCycleOutcome = {
  /** Délai imposé par l'API avant le prochain cycle, en secondes. */
  retryAfterS: number | null;
  /** Activités renvoyées par l'API. `null` si le cycle a échoué avant de lister. */
  listed: number | null;
  /** Activités que ce cycle a entrepris de rapatrier (hors plafond de cycle). */
  planned: number;
  /** Fichiers effectivement déposés dans la boîte d'import. */
  deposited: number;
  /** Activités éligibles laissées au cycle suivant par le plafond. */
  remaining: number;
  /** `true` si la fenêtre interrogée couvrait tout l'historique. */
  backfill: boolean;
};

/**
 * La ligne de journal que ce cycle mérite, ou `null` s'il n'a rien à dire.
 *
 * Deux exigences en tension, arbitrées ici :
 *
 * - un service qui tourne des mois ne doit pas noyer ses journaux d'une ligne
 *   par minute disant « rien de neuf » ;
 * - un athlète qui vient de démarrer le service doit **immédiatement** savoir
 *   s'il fonctionne. Le premier cycle parle donc toujours, même pour dire qu'il
 *   n'a rien trouvé — c'est la réponse à « est-ce que ça marche ? ».
 *
 * Les échecs, eux, sont journalisés à part par le poller au moment du catch : ce
 * qui remonte ici d'un cycle en échec est un complément, pas la seule trace.
 */
export function pollCycleSummary(cycleNumber: number, outcome: PollCycleOutcome): string | null {
  const scope = outcome.backfill ? 'historique complet' : 'fenêtre glissante';

  if (outcome.listed === null) {
    // L'erreur elle-même a déjà été journalisée ; on ne la répète pas, on situe
    // seulement le cycle qui vient d'échouer.
    return cycleNumber === 1 ? 'premier cycle : échec, cf. la ligne précédente.' : null;
  }

  if (cycleNumber === 1) {
    return `premier cycle (${scope}) : ${outcome.listed} activités listées, ${outcome.planned} à rapatrier, ${outcome.deposited} déposées.`;
  }

  if (outcome.planned === 0 && outcome.deposited === 0) return null;

  const rest = outcome.remaining > 0 ? `, reste ~${outcome.remaining} au prochain cycle` : '';
  return `cycle (${scope}) : ${outcome.deposited} déposées sur ${outcome.planned} à rapatrier${rest}.`;
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

/**
 * Identifiant d'athlète à utiliser quand la configuration n'en donne pas.
 *
 * `0` n'est pas un athlète : c'est le raccourci officiel de l'API pour « celui à
 * qui appartient la clé ». Documenté dans le cookbook d'intervals.icu (« Note
 * that the athlete id in the path is '0'. This indicates that the athlete ID
 * that the access_token or API key belongs to should be used. »,
 * <https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090>),
 * où `GET /api/v1/athlete/0/activities` est l'exemple donné. La clé suffit donc
 * à configurer le rapatriement — un identifiant explicite reste accepté.
 */
export const OWNER_ATHLETE_ID = '0';

/** Identifiant nominal : le `i` de l'URL intervals.icu, puis des chiffres. */
const ATHLETE_ID_PATTERN = /^i\d+$/;
/** Même identifiant, saisi sans son préfixe — l'erreur de recopie la plus courante. */
const BARE_ATHLETE_ID_PATTERN = /^\d+$/;

export type AthleteIdResult =
  | { ok: true; athleteId: string }
  | { ok: false; reason: string };

/**
 * Identifiant d'athlète tel que l'API l'attend, à partir de ce que
 * l'utilisatrice a saisi dans ses réglages.
 *
 * Volontairement tolérant : espaces autour de la valeur, préfixe `i` oublié,
 * `0`/`i0` pour désigner le propriétaire de la clé. Un identifiant mal recopié
 * est une faute d'inattention, pas une raison de priver l'athlète de son
 * rapatriement — et encore moins d'empêcher l'application de démarrer, d'où un
 * résultat plutôt qu'une exception.
 */
export function normalizeAthleteId(raw: string | undefined): AthleteIdResult {
  const value = raw?.trim() ?? '';
  if (value === '') return { ok: true, athleteId: OWNER_ATHLETE_ID };
  // `0` comme `i0` : le raccourci « propriétaire de la clé », sous ses deux
  // graphies plausibles. L'API attend la forme nue.
  if (value === '0' || value === 'i0') return { ok: true, athleteId: OWNER_ATHLETE_ID };
  if (ATHLETE_ID_PATTERN.test(value)) return { ok: true, athleteId: value };
  if (BARE_ATHLETE_ID_PATTERN.test(value)) return { ok: true, athleteId: `i${value}` };

  return {
    ok: false,
    // La valeur est échappée : elle vient d'une saisie et part dans les
    // journaux. Ce n'est pas un secret — l'identifiant n'ouvre rien seul.
    reason: `identifiant intervals.icu illisible (${JSON.stringify(value)}) — attendu i123456, 123456, ou vide pour le propriétaire de la clé`,
  };
}

export type PollerActivation =
  /** Les deux valeurs dont le poller a besoin, prêtes à l'emploi. */
  | { active: true; athleteId: string; apiKey: string }
  /** Motif exact, à journaliser tel quel : c'est la réponse à « pourquoi ça ne tourne pas ? ». */
  | { active: false; reason: string };

/**
 * Le rapatriement de ce compte peut-il tourner, et sinon pourquoi.
 *
 * Un seul réglage est indispensable, la clé API. Un identifiant d'athlète
 * illisible écarte ce compte **seul** — l'appli continue de servir, le dossier
 * d'import continue d'être surveillé, et les autres comptes continuent d'être
 * rapatriés.
 *
 * La clé est rendue avec le résultat plutôt que relue par l'appelant : c'est ce
 * qui lui évite d'avoir à re-prouver au typage qu'elle est bien définie. Le
 * motif, lui, ne la cite jamais.
 */
export function planPollerActivation(settings: {
  athleteId: string | undefined;
  apiKey: string | undefined;
}): PollerActivation {
  const apiKey = settings.apiKey?.trim() ?? '';
  if (apiKey === '') {
    return { active: false, reason: 'aucune clé API intervals.icu enregistrée' };
  }

  const athlete = normalizeAthleteId(settings.athleteId);
  if (!athlete.ok) return { active: false, reason: athlete.reason };

  return { active: true, athleteId: athlete.athleteId, apiKey };
}

/*
 * Les comptes à rapatrier.
 *
 * Les identifiants intervals.icu appartiennent désormais à l'athlète, en base :
 * le service ne poll plus « le » compte de l'installation, il fait un cycle par
 * compte qui en a enregistré. Ce qui suit décide, à partir de ce que rend le DAL,
 * lesquels sont exploitables et pourquoi les autres sont sautés.
 */

/**
 * Un compte tel que le DAL le rend (`listIntervalsAccounts` dans
 * `src/data/athlete.ts`) : soit ses identifiants en clair, soit le constat que
 * sa clé ne se déchiffre plus.
 *
 * Le type vit ici, avec la décision qui le consomme : c'est une donnée de
 * poll-plan, et un module pur ne doit pas dépendre du DAL.
 */
export type IntervalsAccount =
  | {
      /** Athlète Trainarr (clé de la table `athlete`) — c'est lui qui nomme le dossier. */
      athleteId: number;
      status: 'ready';
      /** Identifiant côté intervals.icu, tel qu'il a été saisi. */
      intervalsAthleteId: string | null;
      apiKey: string;
    }
  | {
      athleteId: number;
      status: 'unreadable';
      /** Motif à journaliser tel quel — il ne cite jamais la clé. */
      reason: string;
    };

/** Un compte prêt à être rapatrié, ses deux identifiants normalisés. */
export type PollableAccount = {
  /** Athlète Trainarr : le dossier dans lequel déposer, le propriétaire des activités. */
  athleteId: number;
  /** Identifiant tel que l'API intervals.icu l'attend (`i123456`, ou `0`). */
  intervalsAthleteId: string;
  apiKey: string;
};

/** Un compte écarté de ce cycle, avec son motif. */
export type SkippedAccount = { athleteId: number; reason: string };

export type AccountsPlan = {
  accounts: PollableAccount[];
  /**
   * Comptes sautés. Remontés plutôt que tus : une clé devenue illisible est
   * précisément le cas où le silence ferait passer une panne pour un service au
   * repos.
   */
  skipped: SkippedAccount[];
};

/**
 * Quels comptes rapatrier à ce cycle.
 *
 * Un compte sauté n'en fait sauter aucun autre : c'est tout l'objet de cette
 * séparation. Aucun motif ne peut porter la clé — ni celui du DAL, ni celui de
 * {@link planPollerActivation}.
 */
export function planAccountsToPoll(accounts: readonly IntervalsAccount[]): AccountsPlan {
  const plan: AccountsPlan = { accounts: [], skipped: [] };

  for (const account of accounts) {
    if (account.status === 'unreadable') {
      plan.skipped.push({ athleteId: account.athleteId, reason: account.reason });
      continue;
    }

    const activation = planPollerActivation({
      athleteId: account.intervalsAthleteId ?? undefined,
      apiKey: account.apiKey,
    });
    if (!activation.active) {
      plan.skipped.push({ athleteId: account.athleteId, reason: activation.reason });
      continue;
    }

    plan.accounts.push({
      athleteId: account.athleteId,
      intervalsAthleteId: activation.athleteId,
      apiKey: activation.apiKey,
    });
  }

  return plan;
}

/**
 * Le délai le plus long qu'un compte ait demandé à ce tour, `null` si aucun n'a
 * rien demandé.
 *
 * Les comptes partagent le même hôte : un `Retry-After` obtenu sur l'un est une
 * demande de patience adressée au service entier, pas au seul compte qui l'a
 * reçue. On retient donc le maximum plutôt que de repartir aussitôt sur le
 * voisin.
 */
export function mergeRetryAfterS(values: readonly (number | null)[]): number | null {
  let longest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (longest === null || value > longest) longest = value;
  }
  return longest;
}
