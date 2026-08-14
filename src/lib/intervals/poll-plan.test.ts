import { describe, expect, it } from 'vitest';

import {
  BACKFILL_OLDEST_MS,
  DOWNLOAD_SPACING_MS,
  downloadSpacingMs,
  inboxFileName,
  isSafeActivityId,
  MAX_DOWNLOADS_PER_CYCLE,
  MAX_SLEEP_MS,
  mergeRetryAfterS,
  nextPollDelayMs,
  normalizeAthleteId,
  OWNER_ATHLETE_ID,
  planAccountsToPoll,
  planPoll,
  planPollerActivation,
  planPollWindow,
  pollCycleSummary,
  purgeExpiredWithoutFile,
  shouldLogOnce,
  WITHOUT_FILE_TTL_MS,
  type IntervalsAccount,
  type PollCandidate,
  type PollCycleOutcome,
} from './poll-plan';

function activity(id: string, source: string | null = 'UPLOAD'): PollCandidate {
  return { id, source };
}

function context(existing: string[] = [], withoutFile: string[] = []) {
  return {
    existingNames: new Set(existing),
    knownWithoutFile: new Map(withoutFile.map((id) => [id, Date.now()])),
  };
}

describe('inboxFileName', () => {
  it("dérive un nom déterministe de l'identifiant d'activité", () => {
    expect(inboxFileName('i900')).toBe('intervals-i900.fit');
  });
});

describe('isSafeActivityId', () => {
  it('accepte un identifiant intervals.icu', () => {
    expect(isSafeActivityId('i123456789')).toBe(true);
  });

  it('refuse tout ce qui pourrait sortir du répertoire', () => {
    expect(isSafeActivityId('../../etc/passwd')).toBe(false);
    expect(isSafeActivityId('i900/x')).toBe(false);
    expect(isSafeActivityId('')).toBe(false);
    expect(isSafeActivityId('i900\n')).toBe(false);
  });
});

describe('planPoll', () => {
  it('retient une activité inconnue', () => {
    const plan = planPoll([activity('i900')], context());

    expect(plan.toDownload).toEqual([{ activityId: 'i900', fileName: 'intervals-i900.fit' }]);
    expect(plan.invalidIds).toEqual([]);
  });

  it("ignore une activité dont le fichier est déjà rapatrié", () => {
    // `existingNames` fusionne l'inbox, `processed/` et `failed/` : que le
    // fichier attende son tour, ait été ingéré ou ait échoué, il ne doit pas
    // être retéléchargé.
    const plan = planPoll([activity('i900')], context(['intervals-i900.fit']));

    expect(plan.toDownload).toEqual([]);
  });

  it("ne confond pas un fichier en cours d'écriture avec un fichier rapatrié", () => {
    // Un `.part` laissé par un téléchargement interrompu ne porte pas le nom
    // final : l'activité doit être retentée au cycle suivant.
    const plan = planPoll([activity('i900')], context(['intervals-i900.fit.part']));

    expect(plan.toDownload).toEqual([{ activityId: 'i900', fileName: 'intervals-i900.fit' }]);
  });

  it("ignore une activité déjà connue sans fichier — une seule tentative par session", () => {
    const plan = planPoll([activity('i901')], context([], ['i901']));

    expect(plan.toDownload).toEqual([]);
  });

  it('ignore les activités Strava, dont le fichier original est hors service', () => {
    const plan = planPoll([activity('i902', 'STRAVA')], context());

    expect(plan.toDownload).toEqual([]);
  });

  it('écarte un identifiant qui ne compose pas un nom de fichier sûr', () => {
    const plan = planPoll([activity('../evil'), activity('i903')], context());

    expect(plan.invalidIds).toEqual(['../evil']);
    expect(plan.toDownload).toEqual([{ activityId: 'i903', fileName: 'intervals-i903.fit' }]);
  });

  it('ne télécharge pas deux fois une activité listée en double', () => {
    const plan = planPoll([activity('i904'), activity('i904')], context());

    expect(plan.toDownload).toHaveLength(1);
  });

  it("conserve l'ordre de la liste fournie", () => {
    const plan = planPoll([activity('i905'), activity('i906'), activity('i907')], context());

    expect(plan.toDownload.map((item) => item.activityId)).toEqual(['i905', 'i906', 'i907']);
    expect(plan.remaining).toBe(0);
  });

  it('plafonne un cycle et annonce ce qui reste', () => {
    // Un backfill d'historique désigne des centaines d'activités d'un coup : le
    // cycle en prend une tranche, les suivants reprennent la suite.
    const activities = Array.from({ length: MAX_DOWNLOADS_PER_CYCLE + 12 }, (_, index) =>
      activity(`i${index}`),
    );

    const plan = planPoll(activities, context());

    expect(plan.toDownload).toHaveLength(MAX_DOWNLOADS_PER_CYCLE);
    expect(plan.remaining).toBe(12);
  });

  it('reporte les plus anciennes, jamais les plus récentes', () => {
    // L'API liste du plus récent au plus ancien : la séance du jour ne doit pas
    // attendre la fin du backfill pour être ingérée.
    const activities = Array.from({ length: MAX_DOWNLOADS_PER_CYCLE + 1 }, (_, index) =>
      activity(`i${index}`),
    );

    const plan = planPoll(activities, context());

    expect(plan.toDownload[0]?.activityId).toBe('i0');
    expect(plan.toDownload.map((item) => item.activityId)).not.toContain(
      `i${MAX_DOWNLOADS_PER_CYCLE}`,
    );
  });

  it('ne compte dans le reste que les activités réellement éligibles', () => {
    // Déjà rapatriées ou sans fichier : elles ne sont pas « du travail en
    // attente », sinon la fenêtre historique ne se refermerait jamais.
    const activities = Array.from({ length: MAX_DOWNLOADS_PER_CYCLE + 5 }, (_, index) =>
      activity(`i${index}`),
    );
    const existing = activities
      .slice(MAX_DOWNLOADS_PER_CYCLE)
      .map((item) => inboxFileName(item.id));

    const plan = planPoll(activities, context(existing));

    expect(plan.toDownload).toHaveLength(MAX_DOWNLOADS_PER_CYCLE);
    expect(plan.remaining).toBe(0);
  });
});

describe('planPollWindow', () => {
  const NOW = Date.parse('2026-08-10T12:00:00Z');

  function window(existing: string[], unfinished = false) {
    return planPollWindow({
      existingNames: new Set(existing),
      unfinished,
      lookbackDays: 30,
      now: NOW,
    });
  }

  it("remonte à tout l'historique quand aucune séance n'a été rapatriée", () => {
    const decision = window([]);

    expect(decision.backfill).toBe(true);
    expect(decision.oldest.getTime()).toBe(BACKFILL_OLDEST_MS);
    expect(decision.oldest.getUTCFullYear()).toBe(2000);
  });

  it('ignore les fichiers déposés par une autre voie que le poller', () => {
    // Un fichier arrivé par une autre voie ne prouve pas qu'intervals.icu a été
    // interrogé : l'historique reste à rapatrier.
    const decision = window(['2026-08-09-run.fit', 'processed', 'intervals-i900.fit.part']);

    expect(decision.backfill).toBe(true);
  });

  it('retombe sur la fenêtre glissante dès la première séance rapatriée', () => {
    // Le nom suffit, où qu'il soit : `existingNames` fusionne l'inbox et ses
    // archives.
    const decision = window(['intervals-i900.fit']);

    expect(decision.backfill).toBe(false);
    expect(decision.oldest.getTime()).toBe(NOW - 30 * 24 * 60 * 60 * 1000);
  });

  it("maintient la fenêtre historique tant qu'un cycle a laissé du travail", () => {
    // Sans cela, les 50 premiers fichiers déposés feraient basculer le cycle
    // suivant sur 30 jours et le reste de l'historique ne serait jamais demandé.
    const decision = window(['intervals-i900.fit'], true);

    expect(decision.backfill).toBe(true);
    expect(decision.oldest.getTime()).toBe(BACKFILL_OLDEST_MS);
  });

  it('ne partage pas la même instance de Date entre deux cycles', () => {
    expect(window([]).oldest).not.toBe(window([]).oldest);
  });
});

describe('downloadSpacingMs', () => {
  it('ne fait pas attendre le premier téléchargement du cycle', () => {
    // Une séance qui vient d'arriver ne doit pas payer la politesse due à un
    // backfill.
    expect(downloadSpacingMs(0)).toBe(0);
  });

  it('espace les suivants', () => {
    expect(downloadSpacingMs(1)).toBe(DOWNLOAD_SPACING_MS);
    expect(downloadSpacingMs(MAX_DOWNLOADS_PER_CYCLE - 1)).toBe(DOWNLOAD_SPACING_MS);
  });

  it("garde un cycle plein sous l'ordre de grandeur de la minute", () => {
    // Le plafond du cycle et l'espacement se répondent : 50 fichiers espacés de
    // 500 ms tiennent en une trentaine de secondes de pauses cumulées, pas en
    // plusieurs minutes.
    const total = Array.from({ length: MAX_DOWNLOADS_PER_CYCLE }, (_, index) =>
      downloadSpacingMs(index),
    ).reduce((sum, value) => sum + value, 0);

    expect(total).toBe((MAX_DOWNLOADS_PER_CYCLE - 1) * DOWNLOAD_SPACING_MS);
    expect(total).toBeLessThan(60_000);
  });
});

describe('nextPollDelayMs', () => {
  it("attend l'intervalle de cycle quand rien ne l'allonge", () => {
    expect(nextPollDelayMs(null, 300)).toBe(300_000);
    expect(nextPollDelayMs(30, 300)).toBe(300_000);
  });

  it('respecte un Retry-After plus long que le cycle', () => {
    expect(nextPollDelayMs(900, 300)).toBe(900_000);
  });

  it("plafonne un Retry-After absurde — une date lointaine ne doit pas rendre setTimeout fou", () => {
    // Un `Retry-After` daté de 2099 : au-delà de 2^31−1 ms, `setTimeout` retombe
    // à 1 ms et la boucle martèlerait l'API.
    const secondsUntil2099 = Math.ceil((Date.parse('2099-01-01T00:00:00Z') - Date.now()) / 1000);

    expect(nextPollDelayMs(secondsUntil2099, 300)).toBe(MAX_SLEEP_MS);
    expect(MAX_SLEEP_MS).toBeLessThan(2 ** 31 - 1);
  });

  it('plafonne aussi un intervalle de cycle démesuré', () => {
    expect(nextPollDelayMs(null, 30 * 24 * 60 * 60)).toBe(MAX_SLEEP_MS);
  });

  it('ignore un Retry-After négatif ou incohérent', () => {
    expect(nextPollDelayMs(-10, 300)).toBe(300_000);
  });
});

describe('purgeExpiredWithoutFile', () => {
  it('conserve une entrée récente', () => {
    const now = Date.parse('2026-08-10T12:00:00Z');
    const withoutFile = new Map([['i900', now - 60_000]]);

    purgeExpiredWithoutFile(withoutFile, now);

    expect([...withoutFile.keys()]).toEqual(['i900']);
  });

  it('oublie une entrée plus vieille que le TTL', () => {
    const now = Date.parse('2026-08-10T12:00:00Z');
    const withoutFile = new Map([['i900', now - WITHOUT_FILE_TTL_MS - 1]]);

    purgeExpiredWithoutFile(withoutFile, now);

    expect(withoutFile.size).toBe(0);
  });

  it("rend l'activité de nouveau éligible au téléchargement", () => {
    // Un 404 peut être transitoire : sur un service qui tourne des mois, une
    // séance réelle ne doit pas être perdue pour de bon.
    const now = Date.parse('2026-08-10T12:00:00Z');
    const withoutFile = new Map([['i900', now - WITHOUT_FILE_TTL_MS - 1]]);

    expect(planPoll([activity('i900')], { existingNames: new Set(), knownWithoutFile: withoutFile })
      .toDownload).toEqual([]);

    purgeExpiredWithoutFile(withoutFile, now);

    expect(
      planPoll([activity('i900')], { existingNames: new Set(), knownWithoutFile: withoutFile })
        .toDownload,
    ).toEqual([{ activityId: 'i900', fileName: 'intervals-i900.fit' }]);
  });
});

describe('shouldLogOnce', () => {
  it('ne laisse passer que la première occurrence', () => {
    const seen = new Set<string>();

    expect(shouldLogOnce(seen, 'i900')).toBe(true);
    expect(shouldLogOnce(seen, 'i900')).toBe(false);
    expect(shouldLogOnce(seen, 'i901')).toBe(true);
  });
});

describe('normalizeAthleteId', () => {
  it("retient l'identifiant nominal tel quel", () => {
    expect(normalizeAthleteId('i123456')).toEqual({ ok: true, athleteId: 'i123456' });
  });

  it('ajoute le préfixe « i » oublié', () => {
    expect(normalizeAthleteId('123456')).toEqual({ ok: true, athleteId: 'i123456' });
  });

  it('ignore les espaces autour de la valeur', () => {
    expect(normalizeAthleteId('  i123456 ')).toEqual({ ok: true, athleteId: 'i123456' });
    expect(normalizeAthleteId('\t123456\n')).toEqual({ ok: true, athleteId: 'i123456' });
  });

  it("retombe sur le propriétaire de la clé quand rien n'est donné", () => {
    expect(normalizeAthleteId(undefined)).toEqual({ ok: true, athleteId: OWNER_ATHLETE_ID });
    expect(normalizeAthleteId('')).toEqual({ ok: true, athleteId: OWNER_ATHLETE_ID });
    expect(normalizeAthleteId('   ')).toEqual({ ok: true, athleteId: OWNER_ATHLETE_ID });
  });

  it('accepte les deux graphies du raccourci « propriétaire de la clé »', () => {
    expect(normalizeAthleteId('0')).toEqual({ ok: true, athleteId: '0' });
    // L'API attend la forme nue : `i0` est normalisé, pas transmis tel quel.
    expect(normalizeAthleteId('i0')).toEqual({ ok: true, athleteId: '0' });
  });

  it('refuse une valeur illisible sans lever', () => {
    const result = normalizeAthleteId('https://intervals.icu/athlete/i123456');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('identifiant intervals.icu illisible');
    // La valeur fautive est échappée : elle vient d'une saisie et part dans les
    // journaux.
    expect(result.reason).toContain('"https://intervals.icu/athlete/i123456"');
  });
});

describe('planPollerActivation', () => {
  it('active le poller avec la seule clé API', () => {
    expect(planPollerActivation({ athleteId: undefined, apiKey: 'cle' })).toEqual({
      active: true,
      athleteId: OWNER_ATHLETE_ID,
      apiKey: 'cle',
    });
  });

  it("respecte l'identifiant d'athlète quand il est donné", () => {
    expect(planPollerActivation({ athleteId: 'i123456', apiKey: '  cle  ' })).toEqual({
      active: true,
      athleteId: 'i123456',
      // La clé est rendue détourée : le poller n'a pas à s'en soucier.
      apiKey: 'cle',
    });
  });

  it('nomme la clé manquante', () => {
    const activation = planPollerActivation({ athleteId: 'i123456', apiKey: undefined });

    expect(activation.active).toBe(false);
    if (activation.active) return;
    expect(activation.reason).toBe('aucune clé API intervals.icu enregistrée');
  });

  it('traite une clé vide comme absente', () => {
    expect(planPollerActivation({ athleteId: 'i1', apiKey: '   ' }).active).toBe(false);
  });

  it("écarte ce compte seul quand l'identifiant est illisible", () => {
    const activation = planPollerActivation({ athleteId: 'athlète-de-gwen', apiKey: 'cle' });

    expect(activation.active).toBe(false);
    if (activation.active) return;
    expect(activation.reason).toContain('identifiant intervals.icu illisible');
    // Le motif part dans les journaux : la clé n'y figure jamais.
    expect(activation.reason).not.toContain('cle');
  });
});

describe('planAccountsToPoll', () => {
  const API_KEY = 'cle-api-secrete';

  function ready(athleteId: number, intervalsAthleteId: string | null = null): IntervalsAccount {
    return { athleteId, status: 'ready', intervalsAthleteId, apiKey: API_KEY };
  }

  it('rend un compte prêt avec ses deux identifiants normalisés', () => {
    expect(planAccountsToPoll([ready(3, '123456')])).toEqual({
      accounts: [{ athleteId: 3, intervalsAthleteId: 'i123456', apiKey: API_KEY }],
      skipped: [],
    });
  });

  it("interroge l'athlète 0 quand le compte n'a pas d'identifiant intervals.icu", () => {
    expect(planAccountsToPoll([ready(1)]).accounts).toEqual([
      { athleteId: 1, intervalsAthleteId: OWNER_ATHLETE_ID, apiKey: API_KEY },
    ]);
  });

  it('saute la clé illisible et poursuit avec les autres comptes', () => {
    // C'est toute la raison d'être de cette fonction : le secret d'installation
    // a changé pour l'un, les autres n'ont pas à s'arrêter de rapatrier.
    const plan = planAccountsToPoll([
      { athleteId: 1, status: 'unreadable', reason: 'clé API intervals.icu illisible' },
      ready(2, 'i222'),
    ]);

    expect(plan.accounts).toEqual([{ athleteId: 2, intervalsAthleteId: 'i222', apiKey: API_KEY }]);
    expect(plan.skipped).toEqual([{ athleteId: 1, reason: 'clé API intervals.icu illisible' }]);
  });

  it("saute le compte dont l'identifiant intervals.icu est illisible, avec son motif", () => {
    const plan = planAccountsToPoll([ready(4, 'athlète-de-gwen'), ready(5)]);

    expect(plan.accounts.map((account) => account.athleteId)).toEqual([5]);
    expect(plan.skipped[0]?.athleteId).toBe(4);
    expect(plan.skipped[0]?.reason).toContain('identifiant intervals.icu illisible');
  });

  it('ne laisse aucune clé dans un motif de saut', () => {
    const plan = planAccountsToPoll([
      ready(1, 'pas-un-identifiant'),
      { athleteId: 2, status: 'unreadable', reason: 'clé API intervals.icu illisible' },
      { athleteId: 3, status: 'ready', intervalsAthleteId: null, apiKey: '   ' },
    ]);

    expect(plan.accounts).toEqual([]);
    expect(plan.skipped).toHaveLength(3);
    for (const skipped of plan.skipped) {
      expect(skipped.reason).not.toContain(API_KEY);
    }
  });

  it('ne rend rien quand aucun compte n’a de clé — ce n’est pas une panne', () => {
    expect(planAccountsToPoll([])).toEqual({ accounts: [], skipped: [] });
  });
});

describe('mergeRetryAfterS', () => {
  it('retient le délai le plus long demandé', () => {
    // Les comptes partagent le même hôte : un quota atteint sur l'un est une
    // demande de patience adressée au service entier.
    expect(mergeRetryAfterS([null, 30, 120, null])).toBe(120);
  });

  it('ne demande rien quand personne n’a rien demandé', () => {
    expect(mergeRetryAfterS([])).toBeNull();
    expect(mergeRetryAfterS([null, null])).toBeNull();
  });
});

describe('pollCycleSummary', () => {
  function outcome(overrides: Partial<PollCycleOutcome> = {}): PollCycleOutcome {
    return {
      retryAfterS: null,
      listed: 0,
      planned: 0,
      deposited: 0,
      remaining: 0,
      backfill: false,
      ...overrides,
    };
  }

  it('parle toujours au premier cycle, même sans rien à faire', () => {
    const line = pollCycleSummary(1, outcome({ listed: 237 }));

    expect(line).not.toBeNull();
    expect(line).toContain('premier cycle');
    expect(line).toContain('237');
  });

  it('se tait sur un cycle suivant qui ne trouve rien', () => {
    expect(pollCycleSummary(2, outcome({ listed: 237 }))).toBeNull();
  });

  it('parle dès qu’un cycle a du travail', () => {
    const line = pollCycleSummary(9, outcome({ listed: 237, planned: 50, deposited: 50, remaining: 12 }));

    expect(line).toContain('50');
    expect(line).toContain('reste ~12');
  });

  it("situe le premier cycle en échec plutôt que de laisser un silence", () => {
    expect(pollCycleSummary(1, outcome({ listed: null }))).toContain('premier cycle');
  });

  it("ne répète pas les cycles en échec suivants — l'erreur est déjà journalisée", () => {
    expect(pollCycleSummary(2, outcome({ listed: null }))).toBeNull();
  });

  it('distingue backfill et fenêtre glissante', () => {
    expect(pollCycleSummary(1, outcome({ listed: 5, backfill: true }))).toContain(
      'historique complet',
    );
    expect(pollCycleSummary(1, outcome({ listed: 5 }))).toContain('fenêtre glissante');
  });
});
