import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { FitnessTestCandidateDto } from '@/data/fitness-test';
import type { TrainingSnapshotDto } from '@/data/coach-context';
import { InvalidPlanError, type PlanDto, type PlanSessionDto } from '@/data/plans';

import { maybeApplyFitnessTest, resetFitnessTestState } from './fitness-test-service';

/*
 * Ce que ce fichier prouve : la **plomberie** du test chronométré. Les règles
 * qui décident du sort du chrono vivent dans `lib/metrics/fitness-test.ts` et
 * s'y testent sans base ; la phrase que l'athlète lit vit dans
 * `fitness-test-note.ts` et s'y teste aussi. Restent les trois choses que ce
 * module seul porte, et qui sont exactement celles qui se cassent en silence :
 *
 * 1. **chaque verdict laisse une trace** — une note écrite, quoi qu'il arrive ;
 * 2. **un test ne s'évalue qu'une fois** — un réimport ne réécrit pas la note
 *    par un verdict qui la contredit ;
 * 3. **le contrôle de fraîcheur** — le plan a-t-il bougé pendant les minutes de
 *    reconstruction ?
 */

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { dal } = vi.hoisted(() => ({
  dal: {
    getFitnessTestCandidate: vi.fn(),
    recordFitnessTest: vi.fn(),
    getTrainingSnapshot: vi.fn(),
    getActivePlanWithSessions: vi.fn(),
    applyPlanUpdate: vi.fn(),
    depositPlanRevision: vi.fn(),
    getPlanUpdatedAt: vi.fn(),
    reconcilePlanSessions: vi.fn(),
    todayCivilDate: vi.fn(),
    recordTimeTrialLthr: vi.fn(),
  },
}));

const { rewriteRemainingPlan } = vi.hoisted(() => ({ rewriteRemainingPlan: vi.fn() }));
const { syncPlanToIntervalsSafely } = vi.hoisted(() => ({ syncPlanToIntervalsSafely: vi.fn() }));

vi.mock('@/lib/intervals/push-plan', () => ({ syncPlanToIntervalsSafely }));
vi.mock('@/data/coach-context', () => ({ getTrainingSnapshot: dal.getTrainingSnapshot }));
vi.mock('@/data/fitness-test', () => ({
  getFitnessTestCandidate: dal.getFitnessTestCandidate,
  recordFitnessTest: dal.recordFitnessTest,
}));
vi.mock('@/data/lthr-suggestion', () => ({ recordTimeTrialLthr: dal.recordTimeTrialLthr }));
vi.mock('@/data/plan-reconciliation', () => ({ reconcilePlanSessions: dal.reconcilePlanSessions }));
vi.mock('@/data/plan-review', () => ({ getPlanUpdatedAt: dal.getPlanUpdatedAt }));
vi.mock('@/data/plan-revisions', async () => {
  // `toPlanRevisionSessions` est du vrai code — c'est lui qui normalise ce que
  // le service dépose. Seul le dépôt lui-même est remplacé.
  const actual =
    await vi.importActual<typeof import('@/data/plan-revisions')>('@/data/plan-revisions');
  return { ...actual, depositPlanRevision: dal.depositPlanRevision };
});
vi.mock('@/data/athlete', async () => {
  // `isCivilDate` est du vrai code — il valide le payload de la proposition.
  const actual = await vi.importActual<typeof import('@/data/athlete')>('@/data/athlete');
  return { ...actual, todayCivilDate: dal.todayCivilDate };
});
vi.mock('@/data/plans', async () => {
  // Les erreurs et les bornes sont du vrai code métier : seules les fonctions
  // qui touchent la base sont remplacées.
  const actual = await vi.importActual<typeof import('@/data/plans')>('@/data/plans');
  return {
    ...actual,
    getActivePlanWithSessions: dal.getActivePlanWithSessions,
    applyPlanUpdate: dal.applyPlanUpdate,
  };
});
vi.mock('./plan-service', async () => {
  // La reconstruction appelle le modèle une fois par créneau de qualité : c'est
  // la seule étape lente, et elle est éprouvée chez elle. Tout le reste du
  // module — fenêtre restante, volumes prescrits — est du vrai code.
  const actual = await vi.importActual<typeof import('./plan-service')>('./plan-service');
  return { ...actual, rewriteRemainingPlan };
});

/**
 * L'athlète du fichier importé. Il est **donné** au service comme à l'ingestion :
 * le watcher FIT tourne hors requête, il n'y a pas de session à interroger.
 */
const ATHLETE_ID = 7;

const SNAPSHOT: TrainingSnapshotDto = {
  today: '2026-09-16',
  profile: { ageYears: 36, sex: 'female', maxHrBpm: 184, restingHrBpm: 48, weightKg: 62 },
  fitness: { ctl: 52.4, atl: 61.2, tsb: -8.8 },
  vo2max: 48.6,
  weeks: [{ startsOn: '2026-09-07', distanceKm: 30.2, movingTimeS: 12_600, sessions: 4 }],
  longestSessionKm30d: 14.2,
  recentAvgPaceSecPerKm: 380,
};

/** Un plan sans échéance de 16 semaines, démarré le lundi 10 août 2026. */
const PLAN: PlanDto = {
  id: 3,
  status: 'active',
  goalType: 'free',
  intent: 'faster',
  returnInjuryHistory: false,
  level: 'intermediate',
  goalText: 'Courir plus vite',
  raceDate: null,
  startsOn: '2026-08-10',
  weeks: 16,
  sessionsPerWeek: 4,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: '5k',
  referenceTimeS: 1_620,
  referenceUpdatedOn: null,
  lastTestNote: null,
  summary: null,
  reviewedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
};

function planSession(overrides: Partial<PlanSessionDto> & { scheduledOn: string }): PlanSessionDto {
  return {
    id: 1,
    kind: 'Endurance',
    title: 'Footing',
    warmup: null,
    recovery: null,
    cooldown: null,
    targetPaceSecPerKm: null,
    volumeM: 10_000,
    durationS: null,
    steps: null,
    completedActivityId: null,
    ...overrides,
  };
}

const ACTIVE = {
  plan: PLAN,
  sessions: [
    planSession({ scheduledOn: '2026-09-16', id: 1, completedActivityId: 42 }),
    planSession({ scheduledOn: '2026-09-20', id: 2 }),
    planSession({ scheduledOn: '2026-09-27', id: 3 }),
  ],
};

/**
 * Le test nominal : couru le mercredi 16 septembre, 37 jours après le départ du
 * plan, 5 km en 25:40 pour une référence de 27:00, FC max au rendez-vous.
 */
function candidate(overrides: Partial<FitnessTestCandidateDto> = {}): FitnessTestCandidateDto {
  return {
    planId: 3,
    activityId: 42,
    planStartsOn: '2026-08-10',
    referenceDistanceM: 5_000,
    referenceTimeS: 1_620,
    referenceUpdatedOn: null,
    testedOn: '2026-09-16',
    activityMaxHrBpm: 181,
    profileMaxHrBpm: 184,
    bestFiveKTimeS: 25 * 60 + 40,
    ...overrides,
  };
}

/** L'`updatedAt` du plan au moment de la lecture — le témoin du contrôle de fraîcheur. */
const PLAN_UPDATED_AT = '2026-09-16T18:00:00.000Z';

let logged: MockInstance<typeof console.log>;
let errored: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  // Le verrou vit sur `globalThis` : sans remise à zéro, un scénario d'échec
  // ferait sortir tous les suivants sans rien faire.
  resetFitnessTestState();

  logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  errored = vi.spyOn(console, 'error').mockImplementation(() => {});

  dal.todayCivilDate.mockReturnValue('2026-09-16');
  dal.getFitnessTestCandidate.mockResolvedValue(candidate());
  dal.getTrainingSnapshot.mockResolvedValue(SNAPSHOT);
  dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
  dal.getPlanUpdatedAt.mockResolvedValue(PLAN_UPDATED_AT);
  dal.applyPlanUpdate.mockResolvedValue(undefined);
  dal.depositPlanRevision.mockResolvedValue('deposited');
  dal.recordFitnessTest.mockResolvedValue(true);
  dal.reconcilePlanSessions.mockResolvedValue(0);
  syncPlanToIntervalsSafely.mockResolvedValue(undefined);
  rewriteRemainingPlan.mockResolvedValue({
    weeks: [{ sessions: [{ day: 1, kind: 'Endurance', title: 'Footing', distanceKm: 10 }] }],
    targets: [],
    skeleton: [],
    effectiveSettings: {},
  });
});

afterEach(() => {
  logged.mockRestore();
  errored.mockRestore();
});

/** Le texte de tous les appels à `console.log`, concaténé. */
function logs(): string {
  return logged.mock.calls.map((call) => String(call[0])).join('\n');
}

/** La proposition déposée par le dernier test. */
function deposited() {
  return dal.depositPlanRevision.mock.calls[0][0];
}

/** Les réglages que la proposition écrirait si l'athlète l'acceptait. */
function proposedSettings(): Record<string, unknown> {
  return deposited().payload.settings;
}

describe('maybeApplyFitnessTest — déclenchement', () => {
  it('ne fait rien quand l’activité ne réalise pas un test', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(null);

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordFitnessTest).not.toHaveBeenCalled();
    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
    // Silence complet : c'est le cas de tous les imports sauf une poignée.
    expect(logs()).toBe('');
  });

  it('ne lève jamais, et journalise ce qui a échoué', async () => {
    dal.getFitnessTestCandidate.mockRejectedValue(new Error('base indisponible'));

    await expect(maybeApplyFitnessTest(42, ATHLETE_ID)).resolves.toBeUndefined();

    expect(errored.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'base indisponible',
    );
  });

  it('libère son verrou même après un échec', async () => {
    dal.getFitnessTestCandidate.mockRejectedValueOnce(new Error('base indisponible'));

    await maybeApplyFitnessTest(42, ATHLETE_ID);
    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).toHaveBeenCalledTimes(1);
  });

  it('ne touche à rien quand le chrono de référence est hors du domaine du modèle', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(
      candidate({ referenceDistanceM: 5_000, referenceTimeS: 60 }),
    );

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordFitnessTest).not.toHaveBeenCalled();
    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
  });
});

describe('maybeApplyFitnessTest — un test ne s’évalue qu’une fois', () => {
  /*
   * Le défaut que ce bloc ferme : redéposer le fichier du test (backfill,
   * `processed/` vidé à la main — cas documentés comme inoffensifs) relançait
   * l'évaluation. Le chrono de référence ayant bougé entre-temps, la cadence
   * répondait `too-soon` et la note « nouveau record, allures recalculées »
   * était remplacée par « chrono non retenu, il redeviendra ajustable dans 28
   * jours ». Le plan restait à jour et devenait incompréhensible.
   */
  it('ne réévalue pas un test que la référence en vigueur a déjà pris en compte', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(
      candidate({ referenceTimeS: 1_540, referenceUpdatedOn: '2026-09-16' }),
    );

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordFitnessTest).not.toHaveBeenCalled();
    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
    expect(logs()).toContain('déjà pris en compte');
  });

  it('n’évalue pas non plus un test antérieur à la référence en vigueur', async () => {
    // Un backfill rapatrie du plus récent au plus ancien : le test de septembre
    // a déjà mis la référence à jour quand celui d'août arrive.
    dal.getFitnessTestCandidate.mockResolvedValue(
      candidate({ testedOn: '2026-08-19', referenceUpdatedOn: '2026-09-16' }),
    );

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordFitnessTest).not.toHaveBeenCalled();
    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
  });

  it('évalue bien un test postérieur à la dernière mise à jour', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(
      candidate({ testedOn: '2026-10-21', referenceUpdatedOn: '2026-09-16' }),
    );

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).toHaveBeenCalledTimes(1);
  });
});

describe('maybeApplyFitnessTest — chaque verdict laisse une trace', () => {
  it('écrit une note et ne touche à rien quand l’effort n’était pas maximal', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(candidate({ activityMaxHrBpm: 160 }));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
    const record = dal.recordFitnessTest.mock.calls[0][1];
    expect(record.note).toContain('chrono non retenu');
    // Le chrono de référence ne bouge pas — et `recordFitnessTest` ne sait plus
    // l'écrire de toute façon : la note est tout ce qu'un test inscrit au plan.
    expect(record).toEqual({ note: expect.any(String) });
    // Et la note s'écrit sous l'athlète reçu : sans lui, l'`UPDATE` ne touchait
    // aucune ligne et le verdict se perdait.
    expect(dal.recordFitnessTest.mock.calls[0][2]).toBe(ATHLETE_ID);
  });

  it('écrit une note quand le test n’est pas meilleur, sans rien dégrader', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(candidate({ bestFiveKTimeS: 29 * 60 }));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
    expect(dal.recordFitnessTest.mock.calls[0][1].note).toContain('Rien ne change');
  });

  it('écrit une note quand la cadence de Daniels n’est pas respectée', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(candidate({ testedOn: '2026-08-24' }));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordFitnessTest.mock.calls[0][1].note).toContain('quatre semaines');
    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
  });

  it('écrit une note quand la séance ne porte aucun 5 km mesurable', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(candidate({ bestFiveKTimeS: null }));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordFitnessTest.mock.calls[0][1].note).toContain('chrono non retenu');
  });
});

describe('maybeApplyFitnessTest — la FC seuil du contre-la-montre', () => {
  it('relève la FC seuil d’un test vérifié maximal, sur l’activité qui a fourni le chrono', async () => {
    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordTimeTrialLthr).toHaveBeenCalledWith(42, ATHLETE_ID);
  });

  it('la relève aussi quand le chrono ne progresse pas — l’effort était maximal', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(candidate({ bestFiveKTimeS: 29 * 60 }));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordTimeTrialLthr).toHaveBeenCalledWith(42, ATHLETE_ID);
  });

  it('ne relève rien quand l’effort n’est pas vérifié maximal', async () => {
    // Sans cette validation, la FC relevée ne serait celle d'aucun seuil : c'est
    // elle, et elle seule, qui distingue un contre-la-montre d'une sortie.
    dal.getFitnessTestCandidate.mockResolvedValue(candidate({ activityMaxHrBpm: 160 }));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordTimeTrialLthr).not.toHaveBeenCalled();
  });

  it('ne relève rien quand aucun 5 km n’est mesurable', async () => {
    dal.getFitnessTestCandidate.mockResolvedValue(candidate({ bestFiveKTimeS: null }));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordTimeTrialLthr).not.toHaveBeenCalled();
  });

  it('ne fait pas échouer le traitement du test si la mesure échoue', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dal.recordTimeTrialLthr.mockRejectedValue(new Error('base injoignable'));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('FC seuil'));

    logged.mockRestore();
  });
});

describe('maybeApplyFitnessTest — un test qui progresse', () => {
  it('propose le chrono et les séances ensemble, sans rien écrire au plan', async () => {
    await maybeApplyFitnessTest(42, ATHLETE_ID);

    // Le plan ne bouge pas : ni le chrono, ni les séances. Les deux moitiés
    // voyagent dans le même payload — les séparer laisserait un plan dont les
    // séances ne viennent pas du chrono qu'il affiche.
    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.depositPlanRevision).toHaveBeenCalledTimes(1);

    const proposal = deposited();
    expect(proposal.source).toBe('fitness-test');
    expect(proposal.planId).toBe(3);
    expect(dal.depositPlanRevision.mock.calls[0][1]).toBe(ATHLETE_ID);

    const settings = proposedSettings();
    expect(settings.referenceDistance).toBe('5k');
    expect(settings.referenceTimeS).toBe(25 * 60 + 40);
    // La date est celle du **test**, pas celle de l'import : c'est l'écart entre
    // deux efforts que la cadence de Daniels borne.
    expect(settings.referenceUpdatedOn).toBe('2026-09-16');
    expect(String(settings.lastTestNote)).toContain('25:40');
    // Et la reconstruction est partie du plan porteur du nouveau chrono.
    expect(rewriteRemainingPlan.mock.calls[0][0].plan.referenceTimeS).toBe(25 * 60 + 40);
  });

  it('fait avancer le marqueur par le dépôt, pour qu’un refus soit définitif', async () => {
    await maybeApplyFitnessTest(42, ATHLETE_ID);

    // Un réimport du même fichier retrouvera `referenceUpdatedOn` au jour du
    // test, et la garde d'entrée l'écartera — même si la proposition a été
    // refusée entre-temps.
    expect(deposited().referenceUpdatedOn).toBe('2026-09-16');
    expect(String(deposited().lastTestNote)).toContain('25:40');
    // Le chrono, lui, n'est pas dans le marqueur : il attend l'acceptation.
    expect(dal.recordFitnessTest).not.toHaveBeenCalled();
  });

  it('calcule le sens de la proposition plutôt que de le déclarer', async () => {
    await maybeApplyFitnessTest(42, ATHLETE_ID);

    const proposal = deposited();
    // Deux séances restantes à 10 km contre une semaine réécrite à 10 km.
    expect(proposal.before).toEqual({ volumeKm: 20, intensityKm: 0 });
    expect(proposal.after).toEqual({ volumeKm: 10, intensityKm: 0 });
    expect(proposal.direction).toBe('decrease');
    expect(proposal.reason).toContain('25:40');
  });

  it('date la référence du jour du test, même importé plus tard', async () => {
    dal.todayCivilDate.mockReturnValue('2026-09-19');
    dal.getFitnessTestCandidate.mockResolvedValue(candidate({ testedOn: '2026-09-16' }));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(proposedSettings().referenceUpdatedOn).toBe('2026-09-16');
  });

  it('reprend la réécriture demain, jamais sur la séance du jour', async () => {
    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(deposited().payload.fromDate).toBe('2026-09-17');
  });

  it('ne publie rien au calendrier tant que la proposition n’est pas acceptée', async () => {
    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.reconcilePlanSessions).not.toHaveBeenCalled();
    expect(syncPlanToIntervalsSafely).not.toHaveBeenCalled();
  });

  it('passe l’athlète reçu à chaque appel du DAL, sans jamais le déduire', async () => {
    await maybeApplyFitnessTest(42, ATHLETE_ID);

    // La chaîne complète d'un test qui améliore le chrono : chacun de ces
    // appels lisait « l'athlète courant » et ne rendait rien dans le watcher.
    expect(dal.getFitnessTestCandidate).toHaveBeenCalledWith(42, ATHLETE_ID);
    expect(dal.getActivePlanWithSessions).toHaveBeenCalledWith(ATHLETE_ID);
    expect(dal.getTrainingSnapshot).toHaveBeenCalledWith(ATHLETE_ID);
    expect(dal.getPlanUpdatedAt).toHaveBeenCalledWith(3, ATHLETE_ID);
    expect(dal.depositPlanRevision).toHaveBeenCalledWith(expect.anything(), ATHLETE_ID);
  });

  it('ne propose rien quand le plan n’est plus le plan actif', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(null);

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
    expect(dal.recordFitnessTest).not.toHaveBeenCalled();
    expect(logs()).toContain('plus le plan actif');
  });

  it('n’écrit que la note quand il ne reste plus une semaine à réécrire', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue({
      ...ACTIVE,
      // Cinq semaines depuis le lundi 10 août : le plan s'est terminé le 13
      // septembre, il n'y a plus rien à recalculer à partir de demain.
      plan: { ...PLAN, weeks: 5 },
    });

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
    // Le chrono seul ne vaut rien : sans les semaines qui en découlent, il
    // décalerait toutes les allures sans réécrire une seule séance.
    expect(dal.recordFitnessTest.mock.calls[0][1]).toEqual({ note: expect.any(String) });
    expect(rewriteRemainingPlan).not.toHaveBeenCalled();
  });

  it('n’écrit que la note quand la reconstruction échoue', async () => {
    rewriteRemainingPlan.mockRejectedValue(new InvalidPlanError('weeks', 'fenêtre invalide'));

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
    expect(dal.recordFitnessTest.mock.calls[0][1]).toEqual({ note: expect.any(String) });
    expect(errored.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'reconstruction impossible',
    );
  });

  it('n’écrit que la note quand le dépôt trouve déjà une proposition', async () => {
    dal.depositPlanRevision.mockResolvedValue('conflict');

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordFitnessTest.mock.calls[0][1]).toEqual({ note: expect.any(String) });
    expect(logs()).toContain("une autre proposition vient d'être déposée");
    // Et les effets de bord ne partent pas sur un plan qui n'a pas changé.
    expect(syncPlanToIntervalsSafely).not.toHaveBeenCalled();
  });
});

describe('maybeApplyFitnessTest — contrôle de fraîcheur', () => {
  /*
   * Le défaut que ce bloc ferme : les deux services — révision et test — ont
   * chacun leur verrou de process, et les deux verrous ne se voient pas. Un
   * import qui lance une révision, puis un second import deux secondes plus tard
   * qui lance un test, et le test écrivait des séances construites sur des
   * réglages que la révision venait de remplacer. La révision, elle, avait déjà
   * ce contrôle : c'est l'asymétrie qui posait problème.
   */
  it('abandonne la proposition quand le plan a changé pendant la reconstruction', async () => {
    dal.getPlanUpdatedAt
      .mockResolvedValueOnce(PLAN_UPDATED_AT)
      .mockResolvedValueOnce('2026-09-16T18:04:00.000Z');

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.depositPlanRevision).not.toHaveBeenCalled();
    expect(logs()).toContain('modifié pendant la reconstruction');
  });

  it('garde la note malgré tout : le résultat d’un test est un fait mesuré', async () => {
    dal.getPlanUpdatedAt
      .mockResolvedValueOnce(PLAN_UPDATED_AT)
      .mockResolvedValueOnce('2026-09-16T18:04:00.000Z');

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    expect(dal.recordFitnessTest).toHaveBeenCalledTimes(1);
    const record = dal.recordFitnessTest.mock.calls[0][1];
    expect(record).toEqual({ note: expect.any(String) });
    expect(String(record.note)).toContain('25:40');
  });

  it('relit l’état au plus près de la transaction, après la reconstruction', async () => {
    const order: string[] = [];
    rewriteRemainingPlan.mockImplementation(async () => {
      order.push('rewrite');
      return {
        weeks: [{ sessions: [{ day: 1, kind: 'Endurance', title: 'Footing', distanceKm: 10 }] }],
        targets: [],
        skeleton: [],
        effectiveSettings: {},
      };
    });
    dal.getPlanUpdatedAt.mockImplementation(async () => {
      order.push('read');
      return PLAN_UPDATED_AT;
    });

    await maybeApplyFitnessTest(42, ATHLETE_ID);

    // Une lecture avant, une après : placer la seconde avant la reconstruction
    // rouvrirait exactement la fenêtre que ce contrôle ferme.
    expect(order).toEqual(['read', 'rewrite', 'read']);
    expect(dal.depositPlanRevision).toHaveBeenCalledTimes(1);
  });
});
