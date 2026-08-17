import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedFitActivity } from './parse';

vi.mock('server-only', () => ({}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    parseFitActivity: vi.fn(),
    upsertActivityFromFit: vi.fn(),
    saveActivityStreams: vi.fn(),
    saveActivityBestSegments: vi.fn(),
    recordActivityElevation: vi.fn(),
    hasActivityStreams: vi.fn(),
    linkActivityToPlannedSession: vi.fn(),
    maybeReviewActivePlan: vi.fn(),
    maybeApplyFitnessTest: vi.fn(),
    recordActivityWeather: vi.fn(),
    recordSustainedMaxHr: vi.fn(),
    recordThresholdBlockLthr: vi.fn(),
    notifyActivityAnalyzed: vi.fn(),
  },
}));

vi.mock('./parse', () => ({
  parseFitActivity: mocks.parseFitActivity,
}));

vi.mock('@/data/activities', () => ({
  upsertActivityFromFit: mocks.upsertActivityFromFit,
  saveActivityStreams: mocks.saveActivityStreams,
  saveActivityBestSegments: mocks.saveActivityBestSegments,
  recordActivityElevation: mocks.recordActivityElevation,
  hasActivityStreams: mocks.hasActivityStreams,
}));

vi.mock('@/data/max-hr-suggestion', () => ({
  recordSustainedMaxHr: mocks.recordSustainedMaxHr,
}));

vi.mock('@/data/lthr-suggestion', () => ({
  recordThresholdBlockLthr: mocks.recordThresholdBlockLthr,
}));

vi.mock('@/data/plan-reconciliation', () => ({
  linkActivityToPlannedSession: mocks.linkActivityToPlannedSession,
}));

vi.mock('@/lib/ai/review-service', () => ({
  maybeReviewActivePlan: mocks.maybeReviewActivePlan,
}));

vi.mock('@/lib/ai/fitness-test-service', () => ({
  maybeApplyFitnessTest: mocks.maybeApplyFitnessTest,
}));

vi.mock('@/lib/weather/service', () => ({
  recordActivityWeather: mocks.recordActivityWeather,
}));

vi.mock('@/lib/push/notices', () => ({
  notifyActivityAnalyzed: mocks.notifyActivityAnalyzed,
}));

const { ingestFitBuffer } = await import('./ingest');

const PARSED: ParsedFitActivity = {
  fileHash: 'b'.repeat(64),
  name: 'Footing',
  sportType: 'Run',
  startedAt: new Date('2026-08-02T06:30:00.000Z'),
  distanceM: 10_000,
  movingTimeS: 3_000,
  elapsedTimeS: 3_120,
  elevationGainM: 120,
  elevationLossM: null,
  avgHrBpm: 149,
  maxHrBpm: 171,
  avgCadenceSpm: 176,
  streams: { time: [0, 1], heartrate: [130, 140] },
  warnings: [],
};

/**
 * Le même fichier relu par un parseur corrigé : les canaux clairsemés que
 * l'ancienne version écartait sont là, avec leurs trous explicites.
 */
const REPARSED: ParsedFitActivity = {
  ...PARSED,
  streams: {
    time: [0, 1],
    heartrate: [130, null],
    cadence: [null, 174],
    latlng: [[48.85, 2.35], null],
  },
};

/**
 * Une séance de 2 000 m à 4 m/s, échantillonnée à 1 Hz : assez longue pour
 * porter le 400 m, le 1 000 m et le mile, trop courte pour le 5 km.
 */
const RUN_2K: ParsedFitActivity = {
  ...PARSED,
  streams: {
    time: Array.from({ length: 501 }, (_, index) => index),
    distance: Array.from({ length: 501 }, (_, index) => index * 4),
  },
};

/**
 * Une séance vallonnée dont la **session ne dit rien du dénivelé** — le cas de
 * la montre de l'athlète. Le flux d'altitude, lui, porte une bosse de 12 m, une
 * redescente de 5 m, et du bruit d'altimètre sous le seuil.
 */
const HILLY: ParsedFitActivity = {
  ...PARSED,
  elevationGainM: null,
  elevationLossM: null,
  streams: {
    time: [0, 1, 2, 3, 4, 5],
    altitude: [100, 100.4, 99.6, 112, 111.7, 107],
  },
};

/** Une séance dont le flux cardiaque tient un plateau, pic de capteur compris. */
const SUSTAINED: ParsedFitActivity = {
  ...PARSED,
  streams: {
    time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    heartrate: [160, 214, 160, 191, 191, 191, 191, 191, 191, 191, 191],
  },
};

const BUFFER = Buffer.from('fit');

/**
 * L'athlète à qui appartient le fichier. Il est **donné** à l'ingestion : elle
 * ne le déduit plus d'une session, qui n'existe pas dans le service de fond.
 */
const ATHLETE_ID = 1;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseFitActivity.mockReturnValue(PARSED);
  mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'created' });
  mocks.saveActivityStreams.mockResolvedValue(undefined);
  mocks.saveActivityBestSegments.mockResolvedValue(undefined);
  mocks.recordActivityElevation.mockResolvedValue(undefined);
  mocks.hasActivityStreams.mockResolvedValue(false);
  mocks.linkActivityToPlannedSession.mockResolvedValue(true);
  mocks.maybeReviewActivePlan.mockResolvedValue(undefined);
  mocks.maybeApplyFitnessTest.mockResolvedValue(undefined);
  mocks.recordActivityWeather.mockResolvedValue(undefined);
  mocks.recordSustainedMaxHr.mockResolvedValue(undefined);
  mocks.recordThresholdBlockLthr.mockResolvedValue(undefined);
  mocks.notifyActivityAnalyzed.mockResolvedValue(undefined);
});

describe('ingestFitBuffer', () => {
  it('mesure la FC seuil après le rapprochement, jamais avant', async () => {
    // C'est le lien à la séance planifiée qui dit qu'un bloc de seuil a été
    // couru, et de quelle longueur : mesurer avant n'aurait aucun ancrage.
    const order: string[] = [];
    mocks.linkActivityToPlannedSession.mockImplementation(() => {
      order.push('link');
      return Promise.resolve(true);
    });
    mocks.recordThresholdBlockLthr.mockImplementation(() => {
      order.push('lthr');
      return Promise.resolve(undefined);
    });

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.recordThresholdBlockLthr).toHaveBeenCalledWith(42, ATHLETE_ID);
    expect(order).toEqual(['link', 'lthr']);
  });

  it('journalise une mesure de FC seuil en échec sans faire échouer l’import', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.recordThresholdBlockLthr.mockRejectedValue(new Error('base injoignable'));

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toMatchObject({
      status: 'created',
    });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('FC seuil'));

    logged.mockRestore();
  });

  it('importe une nouvelle activité et ses séries', async () => {
    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({ status: 'created', activityId: 42 });

    expect(mocks.parseFitActivity).toHaveBeenCalledWith(BUFFER);
    expect(mocks.upsertActivityFromFit).toHaveBeenCalledWith(PARSED, ATHLETE_ID);
    expect(mocks.saveActivityStreams).toHaveBeenCalledWith(42, ATHLETE_ID, PARSED.streams);
    // Création : la question « a-t-elle déjà des séries ? » ne se pose même pas.
    expect(mocks.hasActivityStreams).not.toHaveBeenCalled();
  });

  it('rapporte `updated` quand le fichier avait déjà été importé', async () => {
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-file' });

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({ status: 'updated', activityId: 42 });
  });

  it('remplace les séries au réimport du même fichier (parseur corrigé)', async () => {
    // Le fichier avait déjà été ingéré : même empreinte, donc `updated`. Les
    // séries doivent malgré tout être réécrites — sinon une correction du
    // parseur resterait sans effet sur l'historique, ce qui était le bug.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-file' });
    mocks.parseFitActivity.mockReturnValue(REPARSED);
    // Même avec des séries en place : le même fichier, relu, les rafraîchit.
    mocks.hasActivityStreams.mockResolvedValue(true);

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({ status: 'updated', activityId: 42 });

    expect(mocks.saveActivityStreams).toHaveBeenCalledWith(42, ATHLETE_ID, REPARSED.streams);
  });

  it('rapporte `merged` et préserve les séries quand la séance en a déjà', async () => {
    // Doublon amont : un autre fichier décrit la séance déjà en base. Il n'est
    // pas une meilleure version d'elle-même — il n'écrase pas des séries saines.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-session' });
    mocks.parseFitActivity.mockReturnValue(REPARSED);
    mocks.hasActivityStreams.mockResolvedValue(true);

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({ status: 'merged', activityId: 42 });

    expect(mocks.hasActivityStreams).toHaveBeenCalledWith(42, ATHLETE_ID);
    expect(mocks.saveActivityStreams).not.toHaveBeenCalled();
    // La FC max soutenue dérive des séries : un fichier dont on n'a pas retenu
    // les séries n'a pas non plus à la décider.
    expect(mocks.recordSustainedMaxHr).not.toHaveBeenCalled();
  });

  it('enregistre la FC max soutenue, après les séries dont elle dérive', async () => {
    mocks.parseFitActivity.mockReturnValue(SUSTAINED);

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    // Huit secondes tenues à 191, précédées d'un pic isolé à 214 : c'est bien la
    // valeur soutenue qui est enregistrée, pas le maximum brut.
    expect(mocks.recordSustainedMaxHr).toHaveBeenCalledWith(42, ATHLETE_ID, 191);
    expect(mocks.saveActivityStreams.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordSustainedMaxHr.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('écrit `null` quand aucune FC max soutenue n’est établie', async () => {
    // Deux points d'une seconde : rien n'a tenu cinq secondes. `null` est une
    // valeur écrite — la colonne suit les séries, elle ne les complète pas.
    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.recordSustainedMaxHr).toHaveBeenCalledWith(42, ATHLETE_ID, null);
  });

  it('enregistre les meilleurs efforts, après les séries dont ils dérivent', async () => {
    mocks.parseFitActivity.mockReturnValue(RUN_2K);

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    // 2 000 m à 4 m/s : le 400 m en 100 s, le 1 000 m en 250 s, le mile en
    // 402,335 s. Le 5 km n'existe pas dans cette séance — pas de ligne à zéro.
    expect(mocks.saveActivityBestSegments).toHaveBeenCalledWith(42, ATHLETE_ID, [
      { targetM: 400, timeS: 100, paceSecPerKm: 250 },
      { targetM: 1000, timeS: 250, paceSecPerKm: 250 },
      { targetM: 1609.34, timeS: 1609.34 / 4, paceSecPerKm: 250 },
    ]);
    // Les flux sont déjà en main : ils sont écrits d'abord, et le calcul les lit
    // sans repasser par la base.
    expect(mocks.saveActivityStreams.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveActivityBestSegments.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('purge les meilleurs efforts hors course à pied, au lieu de passer son chemin', async () => {
    // Un record à l'allure n'a pas de sens à vélo : aucun segment n'est calculé,
    // exactement comme `getActivityFull` n'en lit aucun. Mais l'écriture a bien
    // lieu, avec une liste vide : une activité peut porter des lignes qu'elle ne
    // devrait plus avoir (sport corrigé, réimport sous un autre sport), et
    // l'écran des records ne filtre pas par sport — il les lirait comme des
    // records d'allure que rien ne pourrait faire tomber.
    mocks.parseFitActivity.mockReturnValue({ ...RUN_2K, sportType: 'Ride' });

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.saveActivityBestSegments).toHaveBeenCalledWith(42, ATHLETE_ID, []);
  });

  it('n’enregistre pas les segments d’un doublon dont les séries sont écartées', async () => {
    // Même règle que la FC max soutenue : un fichier dont on n'a pas retenu les
    // séries n'a pas à décider des records de la séance.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-session' });
    mocks.parseFitActivity.mockReturnValue(RUN_2K);
    mocks.hasActivityStreams.mockResolvedValue(true);

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.saveActivityBestSegments).not.toHaveBeenCalled();
  });

  /*
   * L'invariant absolu de ce module, appliqué au dernier post-traitement en
   * date : une séance dont les meilleurs efforts n'ont pas pu s'écrire reste une
   * séance valide, et ne doit pas repartir en `failed/`. Le rattrapage la
   * ramassera.
   */
  it('journalise des meilleurs efforts en échec sans faire échouer l’import', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.parseFitActivity.mockReturnValue(RUN_2K);
    mocks.saveActivityBestSegments.mockRejectedValue(new Error('base injoignable'));

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({
      status: 'created',
      activityId: 42,
    });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('meilleurs efforts'));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('base injoignable'));
    logged.mockRestore();
  });

  /*
   * Le dénivelé : le repli qui rend la donnée que l'appli avait déjà sans
   * l'afficher. Sa règle de complétion vit dans le DAL ; ce qui se vérifie ici,
   * c'est **quand** l'ingestion calcule, et sur quoi.
   */
  it('calcule le dénivelé depuis le flux quand le fichier ne le porte pas', async () => {
    mocks.parseFitActivity.mockReturnValue(HILLY);

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    // Le même filtre anti-bruit que les splits : l'oscillation de 40 cm ne
    // compte pas, la bosse de 12 m et sa redescente de 5 m comptent.
    expect(mocks.recordActivityElevation).toHaveBeenCalledWith(42, ATHLETE_ID, {
      gainM: 12,
      lossM: 5,
    });
  });

  it('ne rebalaie pas le flux quand la session porte déjà les deux sens', async () => {
    // Le DAL garderait de toute façon les valeurs du fichier : autant ne pas
    // parcourir la série. La marque de balayage, elle, est posée quand même —
    // d'où l'appel avec `null`.
    mocks.parseFitActivity.mockReturnValue({ ...HILLY, elevationGainM: 120, elevationLossM: 118 });

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.recordActivityElevation).toHaveBeenCalledWith(42, ATHLETE_ID, null);
  });

  it.each([
    ['sans D−', { elevationGainM: 120, elevationLossM: null }],
    ['sans D+', { elevationGainM: null, elevationLossM: 118 }],
  ])(
    'ne complète pas depuis le flux la paire qu’un appareil a dite à moitié (%s)',
    async (_label, sides) => {
      // D+ et D− entrent **ensemble** dans la formule de Greif : les prendre à
      // deux sources — l'algorithme de la montre d'un côté, notre hystérésis de
      // 1 m de l'autre — donnerait une paire dépareillée. La séance garde donc
      // le sens que le fichier dit, l'autre reste `NULL`, et la correction
      // d'altitude ne s'applique pas : c'est la réponse honnête.
      mocks.parseFitActivity.mockReturnValue({ ...HILLY, ...sides });

      await ingestFitBuffer(BUFFER, ATHLETE_ID);

      expect(mocks.recordActivityElevation).toHaveBeenCalledWith(42, ATHLETE_ID, null);
    },
  );

  it('marque quand même la séance balayée sans flux d’altitude', async () => {
    // Sans cet appel, le rattrapage n'aurait aucun moyen de faire sortir cette
    // séance de son prédicat : le compteur ne redescendrait jamais à zéro.
    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.recordActivityElevation).toHaveBeenCalledWith(42, ATHLETE_ID, null);
  });

  it('n’écrit pas le dénivelé d’un doublon dont les séries sont écartées', async () => {
    // Même règle que la FC max soutenue et les meilleurs efforts : le dénivelé
    // de repli dérive du flux qu'on vient d'écrire. S'il n'a pas été retenu, la
    // valeur affichée doit rester accordée aux séries qui sont en base.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-session' });
    mocks.parseFitActivity.mockReturnValue(HILLY);
    mocks.hasActivityStreams.mockResolvedValue(true);

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.recordActivityElevation).not.toHaveBeenCalled();
  });

  it('journalise un dénivelé en échec sans faire échouer l’import', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.parseFitActivity.mockReturnValue(HILLY);
    mocks.recordActivityElevation.mockRejectedValue(new Error('base injoignable'));

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({
      status: 'created',
      activityId: 42,
    });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('dénivelé'));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('base injoignable'));
    logged.mockRestore();
  });

  it('écrit les séries d’un rapprochement de séance quand l’activité n’en a aucune', async () => {
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-session' });
    mocks.hasActivityStreams.mockResolvedValue(false);

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({ status: 'merged', activityId: 42 });

    expect(mocks.saveActivityStreams).toHaveBeenCalledWith(42, ATHLETE_ID, PARSED.streams);
  });

  it('rapproche l’activité de sa séance planifiée, après les séries', async () => {
    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.linkActivityToPlannedSession).toHaveBeenCalledWith(42, ATHLETE_ID);
    // Les séries d'abord : le rapprochement est un enrichissement de fin de course.
    expect(mocks.saveActivityStreams.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.linkActivityToPlannedSession.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('rapproche aussi un doublon de séance, dont les séries n’ont pas bougé', async () => {
    // L'appel est idempotent : le refaire ne coûte rien, ne pas le faire
    // laisserait une séance « manquée » alors que la sortie est en base.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-session' });
    mocks.hasActivityStreams.mockResolvedValue(true);

    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.linkActivityToPlannedSession).toHaveBeenCalledWith(42, ATHLETE_ID);
  });

  it('journalise un rapprochement en échec sans faire échouer l’import', async () => {
    // L'activité est en base : la perdre dans `failed/` parce que la jointure
    // avec le plan a échoué serait une régression bien pire que le lien manquant.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.linkActivityToPlannedSession.mockRejectedValue(new Error('base indisponible'));

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({ status: 'created', activityId: 42 });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[fit]'));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('base indisponible'));
    logged.mockRestore();
  });

  it('relève la météo après les séries, avec l’athlète du fichier', async () => {
    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.recordActivityWeather).toHaveBeenCalledWith(42, ATHLETE_ID);
    // Les séries d'abord, et ce n'est pas un détail d'ordre : les coordonnées
    // viennent du flux `latlng`, qui n'est en base qu'une fois écrites.
    expect(mocks.saveActivityStreams.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordActivityWeather.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('journalise un relevé météo en échec sans faire échouer l’import', async () => {
    // Une séance sans météo reste une séance valide : elle ne doit pas repartir
    // en `failed/` parce qu'Open-Meteo n'a pas répondu.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.recordActivityWeather.mockRejectedValue(new Error('Open-Meteo injoignable'));

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({
      status: 'created',
      activityId: 42,
    });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('Open-Meteo injoignable'));
    logged.mockRestore();
  });

  /*
   * L'invariant absolu de ce module, et le dernier post-traitement qui ne
   * l'éprouvait pas : une bannière ratée ne renvoie pas le fichier en `failed/`.
   * Le service de notification journalise déjà ses propres motifs et ne lève
   * pas ; ce test verrouille le dernier recours, celui qui fait que même un
   * futur `notifyActivityAnalyzed` moins prudent ne pourrait pas coûter un
   * import.
   */
  it('journalise une notification en échec sans faire échouer l’import', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.notifyActivityAnalyzed.mockRejectedValue(new Error('service de push injoignable'));

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({
      status: 'created',
      activityId: 42,
    });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('service de push injoignable'));
    logged.mockRestore();
  });

  it('notifie en dernier, une fois le rapprochement au plan posé', async () => {
    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    // Notifier avant reviendrait à annoncer « séance hors plan » d'une séance
    // qui vient d'être rattachée : le message lit le lien que pose le
    // rapprochement.
    expect(mocks.linkActivityToPlannedSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.notifyActivityAnalyzed.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('demande une révision du plan, après le rapprochement', async () => {
    await ingestFitBuffer(BUFFER, ATHLETE_ID);

    expect(mocks.maybeReviewActivePlan).toHaveBeenCalledTimes(1);
    // Le rapprochement d'abord : c'est lui qui rend la séance « réalisée », donc
    // qui donne au bilan de la révision son quatrième résultat.
    expect(mocks.linkActivityToPlannedSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.maybeReviewActivePlan.mock.invocationCallOrder[0] ?? 0,
    );
  });

  /*
   * L'ordre n'est pas cosmétique : un test chronométré peut réécrire la fin du
   * plan, et une révision lancée en parallèle relirait un plan en train de
   * changer — l'une des deux écritures écraserait l'autre.
   */
  it('applique le test chronométré avant de demander une révision', async () => {
    let reviewStarted = false;
    mocks.maybeApplyFitnessTest.mockImplementation(async () => {
      expect(reviewStarted).toBe(false);
    });
    mocks.maybeReviewActivePlan.mockImplementation(async () => {
      reviewStarted = true;
    });

    await ingestFitBuffer(BUFFER, ATHLETE_ID);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.maybeApplyFitnessTest).toHaveBeenCalledWith(42, ATHLETE_ID);
    expect(reviewStarted).toBe(true);
  });

  /*
   * Le bug de production : l'athlète s'arrêtait à l'ingestion. Tout ce qu'elle
   * déclenche le déduisait d'une session — inexistante dans le watcher — et ne
   * faisait donc rien, sans le moindre échec visible.
   */
  it('passe l’athlète du fichier à tout ce que l’import déclenche', async () => {
    await ingestFitBuffer(BUFFER, ATHLETE_ID);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.linkActivityToPlannedSession).toHaveBeenCalledWith(42, ATHLETE_ID);
    expect(mocks.recordActivityWeather).toHaveBeenCalledWith(42, ATHLETE_ID);
    expect(mocks.notifyActivityAnalyzed).toHaveBeenCalledWith(42, ATHLETE_ID);
    expect(mocks.maybeApplyFitnessTest).toHaveBeenCalledWith(42, ATHLETE_ID);
    expect(mocks.maybeReviewActivePlan).toHaveBeenCalledWith(ATHLETE_ID);
  });

  it('n’attend jamais la révision du plan', async () => {
    // Une génération dure des minutes : l'import ne peut pas s'y suspendre, sans
    // quoi le watcher (et le rapatriement derrière lui) s'arrêterait sur chaque
    // fichier déposé. La promesse ne se résout jamais ici, l'import doit finir.
    mocks.maybeReviewActivePlan.mockReturnValue(new Promise(() => {}));

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({ status: 'created', activityId: 42 });
  });

  it('journalise une révision en échec sans faire échouer l’import', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.maybeReviewActivePlan.mockRejectedValue(new Error('coach injoignable'));

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).resolves.toEqual({ status: 'created', activityId: 42 });

    // Le rejet est traité hors du fil de l'import : il faut laisser passer un
    // tour de boucle pour l'observer.
    await Promise.resolve();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('[fit] suivi du plan impossible'),
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it('écrit l’activité au compte de l’athlète qu’on lui donne, pas d’un autre', async () => {
    // Le cloisonnement par compte tient à cette ligne : l'ingestion n'a aucun
    // moyen de « retrouver » un athlète, elle écrit pour celui qu'on lui nomme.
    await ingestFitBuffer(BUFFER, 7);

    expect(mocks.upsertActivityFromFit).toHaveBeenCalledWith(PARSED, 7);
  });

  it('laisse remonter l’erreur de parsing sans rien écrire', async () => {
    const failure = new Error('En-tête FIT invalide.');
    mocks.parseFitActivity.mockImplementation(() => {
      throw failure;
    });

    await expect(ingestFitBuffer(BUFFER, ATHLETE_ID)).rejects.toBe(failure);
    expect(mocks.upsertActivityFromFit).not.toHaveBeenCalled();
  });
});
