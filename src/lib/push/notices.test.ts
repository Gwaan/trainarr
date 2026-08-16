import { beforeEach, describe, expect, it, vi } from 'vitest';

// `./notices` commence par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Les trois déclencheurs, éprouvés sur ce qui coûte cher quand c'est faux : un
 * marqueur brûlé pour rien, une bannière de trop, une bannière qui se contredit.
 *
 * Quatre propriétés, et aucune ne se déduit des autres :
 *
 * 1. **on ne réclame qu'au moment d'envoyer.** Une lecture qui échoue (base,
 *    délai de garde) doit laisser le marqueur libre : le brûler supprimerait le
 *    rappel de toute la journée ;
 * 2. **une proposition se notifie quand elle apparaît**, jamais quand sa valeur
 *    bouge — deux des quatre sont des médianes glissantes qui dérivent d'un
 *    battement d'un jour à l'autre. Sa disparition rend la clé, ce qui rend la
 *    **prochaine** proposition du même genre annonçable ;
 * 3. **un rattrapage d'historique ne notifie rien** : cinquante fichiers par
 *    minute, cinquante bannières aux tags distincts, empilées sur l'écran
 *    verrouillé ;
 * 4. **rien ne se contredit** : une séance déjà courue ne se rappelle pas.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    selectAnalyzedActivity: vi.fn(),
    getAthleteById: vi.fn(),
    selectTodaySession: vi.fn(),
    selectLthrSuggestion: vi.fn(),
    selectMaxHrSuggestion: vi.fn(),
    getPendingPlanRevision: vi.fn(),
    claimNotice: vi.fn(),
    releaseNotice: vi.fn(),
    getPushPreferencesFor: vi.fn(),
    listSubscriptions: vi.fn(),
    selectRestingHrSuggestion: vi.fn(),
    selectWeatherForecast: vi.fn(),
    sendToAthlete: vi.fn(),
  },
}));

vi.mock('@/data/activities', () => ({ selectAnalyzedActivity: mocks.selectAnalyzedActivity }));
vi.mock('@/data/athlete', () => ({ getAthleteById: mocks.getAthleteById }));
vi.mock('@/data/dashboard', () => ({ selectTodaySession: mocks.selectTodaySession }));
vi.mock('@/data/lthr-suggestion', () => ({ selectLthrSuggestion: mocks.selectLthrSuggestion }));
vi.mock('@/data/max-hr-suggestion', () => ({ selectMaxHrSuggestion: mocks.selectMaxHrSuggestion }));
vi.mock('@/data/plan-revisions', () => ({ getPendingPlanRevision: mocks.getPendingPlanRevision }));
vi.mock('@/data/push', () => ({
  claimNotice: mocks.claimNotice,
  releaseNotice: mocks.releaseNotice,
  getPushPreferencesFor: mocks.getPushPreferencesFor,
  listSubscriptions: mocks.listSubscriptions,
}));
vi.mock('@/data/resting-hr-suggestion', () => ({
  selectRestingHrSuggestion: mocks.selectRestingHrSuggestion,
}));
vi.mock('@/data/weather-forecast', () => ({ selectWeatherForecast: mocks.selectWeatherForecast }));
vi.mock('./send', () => ({ sendToAthlete: mocks.sendToAthlete }));

const {
  notifyActivityAnalyzed,
  releaseSuggestionNotices,
  runDailySessionNotice,
  runSuggestionNotices,
} = await import('./notices');

const ATHLETE_ID = 1;

/** 8 h à Paris le 16 août : dans la fenêtre du rappel (7 h → 13 h). */
const MORNING = new Date('2026-08-16T06:00:00.000Z');

const SESSION = {
  id: 7,
  scheduledOn: '2026-08-16',
  kind: 'VMA courte · piste',
  title: '6 × 800 m',
  targetPaceSecPerKm: 245,
  warmup: null,
  recovery: null,
  cooldown: null,
  volumeM: 9_600,
  durationS: 3_600,
  completed: false,
};

const NO_FORECAST = { status: null, fetchedAt: null, location: { source: 'derived' }, days: [] };

const SEND_REPORT = { delivered: 1, removed: 0, skipped: null };

const ACTIVITY = {
  id: 42,
  name: 'Footing du matin',
  startedAt: new Date('2026-08-16T05:30:00.000Z'),
  distanceM: 10_200,
  movingTimeS: 2_910,
  avgPaceSecPerKm: 285,
  plannedSession: null,
};

const MAX_HR = { bpm: 191, activityId: 3, activityName: '10 km', activityStartedAt: MORNING };
const RESTING_HR = { bpm: 44, measuredNights: 14, profileBpm: 48 };
const LTHR = { bpm: 172, source: 'blocks', blocksBpm: 172, sessionCount: 4, timeTrialBpm: null, profileBpm: 168 };
const REVISION = {
  id: 12,
  planId: 3,
  source: 'review',
  direction: 'decrease',
  reason: 'charge en hausse',
  weeks: 3,
  before: { volumeKm: 42, intensityKm: 9 },
  after: { volumeKm: 36, intensityKm: 6 },
  createdAt: '2026-08-16T04:00:00.000Z',
};

/** Le dernier `payload` remis à l'envoi — ce que l'écran verrouillé affichera. */
function lastPayload(): { title: string; body: string; tag: string } {
  const call = mocks.sendToAthlete.mock.calls.at(-1);
  if (call === undefined) throw new Error('Aucun envoi.');
  return call[1] as { title: string; body: string; tag: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectTodaySession.mockResolvedValue(SESSION);
  mocks.selectWeatherForecast.mockResolvedValue(NO_FORECAST);
  mocks.claimNotice.mockResolvedValue(true);
  mocks.releaseNotice.mockResolvedValue(undefined);
  mocks.sendToAthlete.mockResolvedValue(SEND_REPORT);

  mocks.listSubscriptions.mockResolvedValue([{ id: 1 }]);
  mocks.getPushPreferencesFor.mockResolvedValue({
    dailySession: true,
    activityAnalyzed: true,
    suggestions: true,
  });
  mocks.selectAnalyzedActivity.mockResolvedValue(ACTIVITY);

  mocks.getAthleteById.mockResolvedValue({ id: ATHLETE_ID, maxHrBpm: 188 });
  mocks.selectMaxHrSuggestion.mockResolvedValue(null);
  mocks.selectRestingHrSuggestion.mockResolvedValue(null);
  mocks.selectLthrSuggestion.mockResolvedValue(null);
  mocks.getPendingPlanRevision.mockResolvedValue(null);
});

describe('runDailySessionNotice', () => {
  it('envoie le rappel de la séance du jour dans sa fenêtre', async () => {
    const report = await runDailySessionNotice(ATHLETE_ID, MORNING);

    expect(report?.marker).toBe('2026-08-16');
    expect(mocks.claimNotice).toHaveBeenCalledWith(ATHLETE_ID, 'daily-session', '2026-08-16');
    expect(lastPayload().title).toBe('Séance du jour : 6 × 800 m');
  });

  /*
   * Le défaut que cet ordre corrige : la réclamation venait avant la lecture de
   * la météo. Un blip Postgres et le marqueur du jour était pris pour un message
   * qui n'a jamais existé — plus aucun rappel ce jour-là, jusqu'à demain.
   */
  it('ne réclame rien quand la lecture de la météo échoue', async () => {
    mocks.selectWeatherForecast.mockRejectedValue(new Error('base injoignable'));

    await expect(runDailySessionNotice(ATHLETE_ID, MORNING)).rejects.toThrow('base injoignable');

    expect(mocks.claimNotice).not.toHaveBeenCalled();
    expect(mocks.sendToAthlete).not.toHaveBeenCalled();
  });

  it('réclame après avoir composé le message, jamais avant', async () => {
    await runDailySessionNotice(ATHLETE_ID, MORNING);

    expect(mocks.selectWeatherForecast.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimNotice.mock.invocationCallOrder[0] ?? 0,
    );
  });

  /*
   * Sortie à 5 h 30, fichier importé à 6 h 05 : à 7 h, « Séance du jour »
   * contredirait la bannière « Séance analysée » partie une heure plus tôt.
   */
  it('se tait — sans rien réclamer — quand la séance a déjà été courue', async () => {
    mocks.selectTodaySession.mockResolvedValue({ ...SESSION, completed: true });

    await expect(runDailySessionNotice(ATHLETE_ID, MORNING)).resolves.toBeNull();

    // Le marqueur reste libre : un plan republié à 9 h qui pose une **autre**
    // séance, elle non courue, doit encore pouvoir se rappeler.
    expect(mocks.claimNotice).not.toHaveBeenCalled();
    expect(mocks.sendToAthlete).not.toHaveBeenCalled();
  });

  it('ne réclame rien une journée de repos, ni hors de la fenêtre', async () => {
    mocks.selectTodaySession.mockResolvedValue(null);
    await expect(runDailySessionNotice(ATHLETE_ID, MORNING)).resolves.toBeNull();

    mocks.selectTodaySession.mockResolvedValue(SESSION);
    // 23 h à Paris : la journée est passée, rappeler ne ferait que culpabiliser.
    await expect(
      runDailySessionNotice(ATHLETE_ID, new Date('2026-08-16T21:00:00.000Z')),
    ).resolves.toBeNull();

    expect(mocks.claimNotice).not.toHaveBeenCalled();
  });

  it('n’envoie rien quand la matinée a déjà été réclamée', async () => {
    mocks.claimNotice.mockResolvedValue(false);

    await expect(runDailySessionNotice(ATHLETE_ID, MORNING)).resolves.toBeNull();
    expect(mocks.sendToAthlete).not.toHaveBeenCalled();
  });
});

describe('notifyActivityAnalyzed', () => {
  it('annonce la séance qui vient d’être importée', async () => {
    await notifyActivityAnalyzed(42, ATHLETE_ID, new Date('2026-08-16T06:05:00.000Z'));

    expect(mocks.claimNotice).toHaveBeenCalledWith(ATHLETE_ID, 'activity-analyzed', '42');
    expect(lastPayload().title).toBe('Séance analysée : Footing du matin');
  });

  /*
   * Le scénario réel : les notifications et la clé intervals.icu se règlent sur
   * la même page. Activer les unes puis coller l'autre déclenche le rattrapage
   * intégral — 50 fichiers par minute, 50 bannières aux tags tous distincts.
   */
  it('n’annonce pas une séance d’un rattrapage d’historique', async () => {
    mocks.selectAnalyzedActivity.mockResolvedValue({
      ...ACTIVITY,
      startedAt: new Date('2019-04-07T07:00:00.000Z'),
    });

    await notifyActivityAnalyzed(42, ATHLETE_ID, MORNING);

    expect(mocks.claimNotice).not.toHaveBeenCalled();
    expect(mocks.sendToAthlete).not.toHaveBeenCalled();
  });

  /* La fenêtre est généreuse : un iPhone qui synchronise le lendemain compte. */
  it('annonce encore une sortie de la veille, plus une d’avant-hier', async () => {
    mocks.selectAnalyzedActivity.mockResolvedValue({
      ...ACTIVITY,
      startedAt: new Date('2026-08-15T06:00:00.000Z'),
    });
    await notifyActivityAnalyzed(42, ATHLETE_ID, MORNING);
    expect(mocks.sendToAthlete).toHaveBeenCalledTimes(1);

    mocks.selectAnalyzedActivity.mockResolvedValue({
      ...ACTIVITY,
      startedAt: new Date('2026-08-13T06:00:00.000Z'),
    });
    await notifyActivityAnalyzed(42, ATHLETE_ID, MORNING);
    expect(mocks.sendToAthlete).toHaveBeenCalledTimes(1);
  });

  it('ne réclame rien tant qu’aucun appareil n’est abonné', async () => {
    mocks.listSubscriptions.mockResolvedValue([]);

    await notifyActivityAnalyzed(42, ATHLETE_ID, MORNING);

    expect(mocks.claimNotice).not.toHaveBeenCalled();
  });

  it('respecte la catégorie désactivée sans rien réclamer', async () => {
    mocks.getPushPreferencesFor.mockResolvedValue({
      dailySession: true,
      activityAnalyzed: false,
      suggestions: true,
    });

    await notifyActivityAnalyzed(42, ATHLETE_ID, MORNING);

    expect(mocks.claimNotice).not.toHaveBeenCalled();
  });

  /* L'invariant : une bannière ratée ne peut pas coûter un import. */
  it('ne lève jamais, quoi qu’il arrive', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.selectAnalyzedActivity.mockRejectedValue(new Error('base injoignable'));

    await expect(notifyActivityAnalyzed(42, ATHLETE_ID, MORNING)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('base injoignable'));

    logged.mockRestore();
  });
});

describe('runSuggestionNotices', () => {
  /** Les clés réclamées à ce cycle, dans l'ordre. */
  function claimedKeys(): unknown[] {
    return mocks.claimNotice.mock.calls.map((call) => call[2]);
  }

  /** Les clés rendues à ce cycle — les genres qui n'ont plus de proposition. */
  function releasedKeys(): unknown[] {
    return mocks.releaseNotice.mock.calls.map((call) => call[2]);
  }

  it('annonce une proposition qui apparaît, sous la clé de son genre', async () => {
    mocks.selectRestingHrSuggestion.mockResolvedValue(RESTING_HR);

    const report = await runSuggestionNotices(ATHLETE_ID, MORNING);

    expect(report?.notices).toEqual([
      { kind: 'resting-hr', bpm: 44, measuredNights: 14, profileBpm: 48 },
    ]);
    expect(mocks.claimNotice).toHaveBeenCalledWith(ATHLETE_ID, 'suggestion', 'resting-hr');
    expect(lastPayload().body).toBe('FC de repos : 44 bpm sur 14 nuits (profil : 48 bpm)');
  });

  /*
   * **Le défaut central corrigé.** `RESTING_HR_WINDOW_DAYS` vaut 14 jours,
   * `LTHR_WINDOW_DAYS` 90 : ces médianes bougent d'un battement d'un jour à
   * l'autre sans qu'aucune décision n'ait changé. Avec une clé par valeur, la
   * même carte non traitée produisait une bannière quotidienne.
   */
  it('ne renotifie pas une proposition qui persiste, même si sa médiane dérive', async () => {
    mocks.selectRestingHrSuggestion.mockResolvedValue(RESTING_HR);
    mocks.selectLthrSuggestion.mockResolvedValue(LTHR);
    await runSuggestionNotices(ATHLETE_ID, MORNING);
    expect(mocks.sendToAthlete).toHaveBeenCalledTimes(1);

    // Le lendemain : une nuit de plus dans la fenêtre, une séance de seuil de
    // plus — les deux médianes ont glissé d'un battement.
    mocks.claimNotice.mockResolvedValue(false);
    mocks.selectRestingHrSuggestion.mockResolvedValue({ ...RESTING_HR, bpm: 45 });
    mocks.selectLthrSuggestion.mockResolvedValue({ ...LTHR, bpm: 171 });

    await expect(
      runSuggestionNotices(ATHLETE_ID, new Date('2026-08-17T06:00:00.000Z')),
    ).resolves.toBeNull();

    expect(mocks.claimNotice.mock.calls.slice(2).map((call) => call[2])).toEqual([
      'resting-hr',
      'lthr',
    ]);
    expect(mocks.sendToAthlete).toHaveBeenCalledTimes(1);
  });

  /*
   * L'autre moitié de la sémantique de transition : sans libération, une
   * proposition acceptée aujourd'hui interdirait d'annoncer la suivante.
   */
  it('rend la clé d’une proposition acceptée, et réannonce la suivante', async () => {
    mocks.selectMaxHrSuggestion.mockResolvedValue(MAX_HR);
    await runSuggestionNotices(ATHLETE_ID, MORNING);
    expect(mocks.sendToAthlete).toHaveBeenCalledTimes(1);

    // Acceptée : le profil porte désormais 191, plus rien n'est proposé.
    mocks.selectMaxHrSuggestion.mockResolvedValue(null);
    await expect(runSuggestionNotices(ATHLETE_ID, MORNING)).resolves.toBeNull();
    expect(releasedKeys()).toContain('max-hr');
    expect(mocks.releaseNotice).toHaveBeenCalledWith(ATHLETE_ID, 'suggestion', 'max-hr');

    // Des mois plus tard, une séance monte à 194 : la clé est libre, ça s'annonce.
    mocks.selectMaxHrSuggestion.mockResolvedValue({ ...MAX_HR, bpm: 194 });
    await runSuggestionNotices(ATHLETE_ID, new Date('2026-12-01T07:00:00.000Z'));

    expect(mocks.sendToAthlete).toHaveBeenCalledTimes(2);
    expect(lastPayload().body).toContain('194 bpm');
  });

  /*
   * Le refus mémorise une valeur (`resting_hr_suggestion_dismissed_bpm`) : tant
   * que la médiane en reste proche, plus rien n'est proposé — donc la clé est
   * rendue. Qu'elle s'en écarte, et la proposition revient : c'est une
   * information neuve, elle mérite sa bannière.
   */
  it('réannonce une proposition écartée qui reparaît à une autre valeur', async () => {
    mocks.selectRestingHrSuggestion.mockResolvedValue(RESTING_HR);
    await runSuggestionNotices(ATHLETE_ID, MORNING);

    // Écartée à 44 : plus rien n'est calculé, la clé est rendue.
    mocks.selectRestingHrSuggestion.mockResolvedValue(null);
    await runSuggestionNotices(ATHLETE_ID, MORNING);
    expect(releasedKeys()).toContain('resting-hr');

    // Elle descend à 42, hors de la zone du refus : ça reparle.
    mocks.selectRestingHrSuggestion.mockResolvedValue({ ...RESTING_HR, bpm: 42 });
    await runSuggestionNotices(ATHLETE_ID, MORNING);

    expect(mocks.sendToAthlete).toHaveBeenCalledTimes(2);
    expect(lastPayload().body).toContain('42 bpm');
  });

  it('rend les clés des quatre genres quand il n’y a rien à proposer', async () => {
    await expect(runSuggestionNotices(ATHLETE_ID, MORNING)).resolves.toBeNull();

    expect(releasedKeys()).toEqual(['max-hr', 'resting-hr', 'lthr', 'plan-revision']);
    expect(mocks.claimNotice).not.toHaveBeenCalled();
    expect(mocks.sendToAthlete).not.toHaveBeenCalled();
  });

  it('n’écrit rien du tout quand le compte n’a pas d’athlète', async () => {
    mocks.getAthleteById.mockResolvedValue(null);

    await expect(runSuggestionNotices(ATHLETE_ID, MORNING)).resolves.toBeNull();

    expect(mocks.releaseNotice).not.toHaveBeenCalled();
    expect(mocks.claimNotice).not.toHaveBeenCalled();
  });

  /*
   * Ce que le titre doit refléter : l'écran ouvert montrera les quatre cartes,
   * même si une seule vient d'apparaître.
   */
  it('détaille les nouvelles et compte celles qui attendaient déjà', async () => {
    mocks.selectMaxHrSuggestion.mockResolvedValue(MAX_HR);
    mocks.selectRestingHrSuggestion.mockResolvedValue(RESTING_HR);
    mocks.selectLthrSuggestion.mockResolvedValue(LTHR);
    mocks.getPendingPlanRevision.mockResolvedValue(REVISION);
    // Seule la FC seuil est neuve : les trois autres sont déjà réclamées.
    mocks.claimNotice.mockImplementation((_athleteId: number, _kind: string, key: string) =>
      Promise.resolve(key === 'lthr'),
    );

    const report = await runSuggestionNotices(ATHLETE_ID, MORNING);

    expect(report?.notices).toHaveLength(1);
    expect(lastPayload().title).toBe('Une nouvelle décision à valider');
    expect(lastPayload().body).toBe(
      'FC seuil : 172 bpm mesurés (profil : 168 bpm)\n3 autres décisions restent en attente.',
    );
  });

  /*
   * Sans isolation, une erreur sur la deuxième proposition brûlait le marqueur
   * de la première (déjà réclamé, jamais rendu) et privait les deux suivantes de
   * leur tour : marqueur perdu, rien envoyé.
   */
  it('isole chaque genre : une erreur n’emporte pas les autres', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.selectMaxHrSuggestion.mockResolvedValue(MAX_HR);
    mocks.selectRestingHrSuggestion.mockResolvedValue(RESTING_HR);
    mocks.selectLthrSuggestion.mockResolvedValue(LTHR);
    mocks.claimNotice.mockImplementation((_athleteId: number, _kind: string, key: string) =>
      key === 'resting-hr'
        ? Promise.reject(new Error('base injoignable'))
        : Promise.resolve(true),
    );

    const report = await runSuggestionNotices(ATHLETE_ID, MORNING);

    // Les quatre genres ont eu leur tour, et les deux qui ont abouti partent.
    expect(claimedKeys()).toEqual(['max-hr', 'resting-hr', 'lthr']);
    expect(releasedKeys()).toEqual(['plan-revision']);
    expect(report?.notices.map((notice) => notice.kind)).toEqual(['max-hr', 'lthr']);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('base injoignable'));

    logged.mockRestore();
  });
});

describe('releaseSuggestionNotices', () => {
  /**
   * Le balayage de la catégorie éteinte. Sans lui, une clé réclamée avant
   * l'extinction resterait détenue pour toujours — le genre n'étant plus jamais
   * lu, il ne serait plus jamais absent, donc jamais rendu — et bâillonnerait la
   * proposition suivante après le rallumage.
   */
  it('rend les quatre clés sans rien lire ni envoyer', async () => {
    await releaseSuggestionNotices(ATHLETE_ID);

    expect(mocks.releaseNotice.mock.calls.map((call) => call[2])).toEqual([
      'max-hr',
      'resting-hr',
      'lthr',
      'plan-revision',
    ]);
    expect(mocks.claimNotice).not.toHaveBeenCalled();
    expect(mocks.sendToAthlete).not.toHaveBeenCalled();
    // Éteindre une catégorie ne doit pas coûter la lecture des propositions.
    expect(mocks.selectMaxHrSuggestion).not.toHaveBeenCalled();
  });

  it("poursuit le balayage quand une libération échoue", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.releaseNotice.mockImplementation((_athleteId: number, _kind: string, key: string) =>
      key === 'resting-hr' ? Promise.reject(new Error('base injoignable')) : Promise.resolve(),
    );

    await expect(releaseSuggestionNotices(ATHLETE_ID)).resolves.toBeUndefined();

    expect(mocks.releaseNotice.mock.calls.map((call) => call[2])).toEqual([
      'max-hr',
      'resting-hr',
      'lthr',
      'plan-revision',
    ]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('base injoignable'));

    logged.mockRestore();
  });
});
