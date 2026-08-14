import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlanNotFoundError } from '@/data/plans';

import {
  acceptPlanAction,
  createPlanAction,
  rejectPlanAction,
  resyncIntervalsAction,
  type PlanDecisionState,
  type PlanFormState,
} from './actions';
import { earliestPlanStart, latestPlanStart, latestRaceDate } from './plan-window';

vi.mock('server-only', () => ({}));

/**
 * L'action est mince : seule sa validation lui appartient. Ce qu'on éprouve ici,
 * c'est la borne calendaire rendue à l'utilisatrice — une course hors de portée
 * doit être refusée sur son champ, avant les minutes d'attente d'une génération.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    generatePlan: vi.fn(),
    updatePlanFromInstruction: vi.fn(),
    revalidatePath: vi.fn(),
    acceptDraftPlan: vi.fn(),
    discardDraftPlan: vi.fn(),
    reconcilePlanSessions: vi.fn(),
    syncPlanToIntervalsSafely: vi.fn(),
    resyncPlanToIntervalsOnDemand: vi.fn(),
    /** `after` exige un contexte de requête Next : le doublon exécute tout de suite. */
    scheduleAfter: vi.fn(),
    /** Les actions servent une requête : c'est là que l'athlète se résout. */
    getCurrentAthleteId: vi.fn(),
  },
}));

vi.mock('@/data/athlete', async (importOriginal) => ({
  // `todayCivilDate` et les bornes de validation restent le vrai code.
  ...(await importOriginal<typeof import('@/data/athlete')>()),
  getCurrentAthleteId: mocks.getCurrentAthleteId,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/server', () => ({ after: mocks.scheduleAfter }));
vi.mock('@/lib/intervals/push-plan', () => ({
  syncPlanToIntervalsSafely: mocks.syncPlanToIntervalsSafely,
  resyncPlanToIntervalsOnDemand: mocks.resyncPlanToIntervalsOnDemand,
}));
vi.mock('@/data/plan-reconciliation', () => ({
  reconcilePlanSessions: mocks.reconcilePlanSessions,
}));

vi.mock('@/data/plans', async (importOriginal) => ({
  // Les erreurs typées restent le vrai code : c'est sur elles que l'action
  // distingue le cas attendu de la panne.
  ...(await importOriginal<typeof import('@/data/plans')>()),
  acceptDraftPlan: mocks.acceptDraftPlan,
  discardDraftPlan: mocks.discardDraftPlan,
}));

vi.mock('@/lib/ai/plan-service', async (importOriginal) => ({
  // La fenêtre du plan et ses bornes restent le vrai code : la validation de
  // l'action doit rester alignée sur celle du service.
  ...(await importOriginal<typeof import('@/lib/ai/plan-service')>()),
  generatePlan: mocks.generatePlan,
  updatePlanFromInstruction: mocks.updatePlanFromInstruction,
}));

const IDLE: PlanFormState = { status: 'idle' };

/** Aujourd'hui : mardi 11 août 2026 — le plan peut démarrer ce jour-là. */
const TODAY = '2026-08-11';

const VALID_FIELDS: Record<string, string> = {
  intent: 'race',
  level: 'intermediate',
  goalText: '10 km sous 50 min',
  raceDate: '2026-09-13',
  weeks: '',
  referenceDistance: '10k',
  referenceTime: '',
  startsOn: '',
  sessionsPerWeek: '3',
  weeklyTimeHours: '',
  longRunDay: '7',
};

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries({ ...VALID_FIELDS, ...overrides })) {
    data.set(name, value);
  }
  return data;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T09:00:00.000Z`));
  vi.clearAllMocks();
  // `clearAllMocks` efface les appels, pas les implémentations : les doublons
  // qui lèvent (revalidation, `after`) doivent être remis à neuf explicitement.
  mocks.revalidatePath.mockImplementation(() => {});
  mocks.getCurrentAthleteId.mockResolvedValue(7);
  mocks.generatePlan.mockResolvedValue(undefined);
  mocks.acceptDraftPlan.mockResolvedValue({ id: 9 });
  mocks.discardDraftPlan.mockResolvedValue(undefined);
  mocks.reconcilePlanSessions.mockResolvedValue(0);
  mocks.syncPlanToIntervalsSafely.mockResolvedValue({ status: 'synced', pushed: 0, deleted: 0 });
  mocks.resyncPlanToIntervalsOnDemand.mockResolvedValue({
    status: 'synced',
    pushed: 12,
    deleted: 12,
  });
  mocks.scheduleAfter.mockImplementation((task: () => unknown) => {
    void task();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Date de course la plus lointaine acceptée quand le départ reste au défaut. */
const LATEST_RACE = latestRaceDate(earliestPlanStart(TODAY));

describe('createPlanAction — date de course', () => {
  it('accepte la course la plus lointaine que le plan puisse couvrir', async () => {
    const state = await createPlanAction(IDLE, form({ raceDate: LATEST_RACE }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'race', raceDate: LATEST_RACE }),
      undefined,
    );
  });

  it('refuse le lendemain de cette date, sur le champ, sans appeler le coach', async () => {
    const state = await createPlanAction(IDLE, form({ raceDate: '2027-08-16' }));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.raceDate).toContain('Course trop lointaine');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuse toujours une course passée', async () => {
    const state = await createPlanAction(IDLE, form({ raceDate: '2026-08-10' }));

    expect(state.fieldErrors?.raceDate).toContain('à venir');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });
});

describe('createPlanAction — niveau', () => {
  it('transmet le niveau déclaré au service', async () => {
    const state = await createPlanAction(IDLE, form({ level: 'advanced' }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'advanced' }),
      undefined,
    );
  });

  it('refuse un niveau hors des trois, sur le champ, sans appeler le coach', async () => {
    // L'action est un endpoint public : un POST direct peut porter n'importe
    // quoi, et il n'y a pas de repli — un plan calé sur un niveau supposé serait
    // faux sans le dire.
    for (const level of ['expert', '']) {
      const state = await createPlanAction(IDLE, form({ level }));

      expect(state.status).toBe('error');
      expect(state.fieldErrors?.level).toBe('Choisis ton niveau en course.');
    }
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });
});

describe('createPlanAction — date de démarrage', () => {
  it('laisse le service appliquer son défaut quand le champ est vide', async () => {
    const state = await createPlanAction(IDLE, form());

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ startsOn: undefined }),
      undefined,
    );
  });

  it("accepte de démarrer aujourd'hui", async () => {
    const state = await createPlanAction(IDLE, form({ startsOn: TODAY }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ startsOn: TODAY }),
      undefined,
    );
  });

  it('accepte un départ en milieu de semaine', async () => {
    // Jeudi 13 août : le plan ouvre une première semaine entamée, plus aucune
    // raison d'attendre lundi.
    const state = await createPlanAction(IDLE, form({ startsOn: '2026-08-13' }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ startsOn: '2026-08-13' }),
      undefined,
    );
  });

  it('transmet le jour choisi le plus lointain', async () => {
    const startsOn = latestPlanStart(TODAY);
    // La course est repoussée d'autant : les deux dates doivent rester cohérentes.
    const state = await createPlanAction(IDLE, form({ startsOn, raceDate: '2026-11-15' }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ startsOn }),
      undefined,
    );
  });

  it('refuse un démarrage passé, sur le champ, sans appeler le coach', async () => {
    const state = await createPlanAction(IDLE, form({ startsOn: '2026-08-10' }));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.startsOn).toContain("aujourd'hui au plus tôt");
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it('refuse un démarrage au-delà de huit semaines', async () => {
    // Le dernier jour accepté est le 6 octobre : le lendemain est déjà de trop,
    // et neuf semaines à l'avance a fortiori.
    for (const startsOn of ['2026-10-07', '2026-10-13']) {
      const state = await createPlanAction(IDLE, form({ startsOn, raceDate: '2026-12-13' }));

      expect(state.fieldErrors?.startsOn).toContain('Démarrage trop lointain');
    }
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it('refuse une course devenue trop proche du démarrage choisi, sur ce champ-là', async () => {
    // Course le 13 septembre, départ le 31 août : plus que deux semaines.
    const state = await createPlanAction(
      IDLE,
      form({ startsOn: '2026-08-31', raceDate: '2026-09-13' }),
    );

    expect(state.status).toBe('error');
    // Le refus porte sur la date que l'athlète peut déplacer, pas sur sa course.
    expect(state.fieldErrors?.startsOn).toContain('au moins 3 semaines');
    expect(state.fieldErrors?.raceDate).toBeUndefined();
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it("signale l'incohérence sur la course tant qu'aucun démarrage n'est choisi", async () => {
    // Départ implicite aujourd'hui (ancré au lundi 10) : une course le 23 août
    // ne laisse que deux semaines.
    const state = await createPlanAction(IDLE, form({ raceDate: '2026-08-23' }));

    expect(state.fieldErrors?.raceDate).toContain('au moins 3 semaines');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it('accepte une intention sans échéance démarrant plus tard', async () => {
    const state = await createPlanAction(
      IDLE,
      form({ intent: 'faster', weeks: '8', raceDate: '', startsOn: '2026-09-07' }),
    );

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'faster', weeks: 8, startsOn: '2026-09-07' }),
      undefined,
    );
  });
});

/*
 * Le sélecteur d'intention et ses champs conditionnels.
 *
 * L'action est un endpoint public : ce qui arrive ici n'est pas ce que la modale
 * affiche, mais ce qu'un POST veut bien envoyer. D'où les trois cas ci-dessous —
 * une intention inconnue, une case cochée là où elle ne veut rien dire, et une
 * note absente, qui est désormais le cas nominal.
 */
describe("createPlanAction — intention", () => {
  it("transmet l'intention choisie et la durée demandée", async () => {
    const state = await createPlanAction(
      IDLE,
      form({ intent: 'weight_loss', weeks: '12', raceDate: '' }),
    );

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'weight_loss', weeks: 12, returnInjuryHistory: false }),
      undefined,
    );
  });

  it("refuse une intention inconnue sur son champ, sans appeler le coach", async () => {
    const state = await createPlanAction(IDLE, form({ intent: 'sprint' }));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.intent).toContain('Choisis ce que tu viens chercher');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it("transmet l'antécédent de blessure d'une reprise, et l'ignore ailleurs", async () => {
    await createPlanAction(
      IDLE,
      form({ intent: 'return', weeks: '12', raceDate: '', returnInjuryHistory: 'on' }),
    );
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'return', returnInjuryHistory: true }),
      undefined,
    );

    // Cochée sous une autre intention, la case ne veut rien dire : elle ne
    // déplace aucun paramètre du plan, et n'a donc rien à y faire.
    mocks.generatePlan.mockClear();
    await createPlanAction(IDLE, form({ returnInjuryHistory: 'on' }));
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'race', returnInjuryHistory: false }),
      undefined,
    );
  });

  it("accepte une note absente : c'est l'intention qui dit ce que le plan prépare", async () => {
    const state = await createPlanAction(IDLE, form({ goalText: '' }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ goalText: '' }),
      undefined,
    );
  });

  it('refuse une note trop longue, sur son champ', async () => {
    const state = await createPlanAction(IDLE, form({ goalText: 'x'.repeat(201) }));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.goalText).toContain('200 caractères');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });
});

describe('createPlanAction — chrono de référence', () => {
  it('transmet le couple distance/temps au service, en secondes', async () => {
    const state = await createPlanAction(IDLE, form({ referenceTime: '48:30' }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ referenceRace: { distance: '10k', timeS: 2_910 } }),
      undefined,
    );
  });

  it('accepte un chrono en hh:mm:ss', async () => {
    await createPlanAction(
      IDLE,
      form({ referenceDistance: 'half', referenceTime: '1:52:00' }),
    );

    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ referenceRace: { distance: 'half', timeS: 6_720 } }),
      undefined,
    );
  });

  it('laisse passer un chrono absent : le champ est facultatif', async () => {
    const state = await createPlanAction(IDLE, form({ referenceTime: '' }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ referenceRace: undefined }),
      undefined,
    );
  });

  it.each(['48', '48,30', 'quarante', '48:75', '<script>'])(
    'refuse un temps qui n’en est pas un (%s), sur son champ',
    async (referenceTime) => {
      const state = await createPlanAction(IDLE, form({ referenceTime }));

      expect(state.status).toBe('error');
      expect(state.fieldErrors?.referenceTime).toContain('mm:ss');
      expect(mocks.generatePlan).not.toHaveBeenCalled();
    },
  );

  it('refuse un chrono implausible, sans attendre la génération', async () => {
    // 5 km en 12 min : la table d'allures calculée dessus serait une fiction.
    const state = await createPlanAction(
      IDLE,
      form({ referenceDistance: '5k', referenceTime: '12:00' }),
    );

    expect(state.fieldErrors?.referenceTime).toBe(
      'Ce chrono ne ressemble pas à une course — vérifie la saisie.',
    );
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it('refuse une distance inconnue dès qu’un temps est saisi', async () => {
    // L'action est un endpoint public : la liste déroulante ne protège rien.
    const state = await createPlanAction(
      IDLE,
      form({ referenceDistance: '3k', referenceTime: '12:00' }),
    );

    expect(state.fieldErrors?.referenceDistance).toBe('Choisis la distance de ton chrono.');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it('ignore une distance inconnue quand aucun temps n’est saisi', async () => {
    // Sans temps il n'y a pas de chrono : rien à valider, rien à transmettre.
    const state = await createPlanAction(IDLE, form({ referenceDistance: '', referenceTime: '' }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ referenceRace: undefined }),
      undefined,
    );
  });
});

describe('createPlanAction — proposition', () => {
  it('ne revalide que la page du plan : le tableau de bord ne voit pas les propositions', async () => {
    const state = await createPlanAction(IDLE, form());

    expect(state.status).toBe('success');
    expect(mocks.revalidatePath).toHaveBeenCalledExactlyOnceWith('/plan');
  });
});

/** Un `FormData` ne portant que l'identifiant de la proposition. */
function decisionForm(planId: string): FormData {
  const data = new FormData();
  data.set('planId', planId);
  return data;
}

const DECISION_IDLE: PlanDecisionState = { status: 'idle' };

describe('acceptPlanAction', () => {
  it('active la proposition, rapproche ses séances et republie le calendrier', async () => {
    const state = await acceptPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state.status).toBe('success');
    expect(mocks.acceptDraftPlan).toHaveBeenCalledWith(9);
    // Le rapprochement conditionne ce que la page re-rendue affiche : une
    // proposition adoptée quelques jours après sa génération porte des séances
    // déjà courues.
    expect(mocks.reconcilePlanSessions).toHaveBeenCalledWith(9, 7);
    // La synchronisation, elle, part hors du fil de la requête.
    expect(mocks.scheduleAfter).toHaveBeenCalledTimes(1);
    expect(mocks.syncPlanToIntervalsSafely).toHaveBeenCalledWith('plan 9', 7);
    // La séance du jour du tableau de bord vient de changer.
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/plan');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/');
  });

  it.each(['', ' ', '0', '-3', '1.5', '1e3', '0x9', 'neuf', '<script>'])(
    'refuse un identifiant qui n’en est pas un (%s), sans rien écrire',
    async (planId) => {
      // L'action est un endpoint public : ce champ reçoit n'importe quoi.
      const state = await acceptPlanAction(DECISION_IDLE, decisionForm(planId));

      expect(state.status).toBe('error');
      expect(mocks.acceptDraftPlan).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('signale une proposition disparue sans rien revalider', async () => {
    mocks.acceptDraftPlan.mockRejectedValue(new PlanNotFoundError());

    const state = await acceptPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state).toEqual({ status: 'error', message: expect.stringContaining('recharge') });
    expect(mocks.reconcilePlanSessions).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('rend un message générique sur panne, sans laisser fuir la trace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.acceptDraftPlan.mockRejectedValue(new Error('deadlock detected'));

    const state = await acceptPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state.status).toBe('error');
    expect(state.message).not.toContain('deadlock');
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('adopte quand même le plan si le rapprochement échoue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.reconcilePlanSessions.mockRejectedValue(new Error('deadlock detected'));

    // Le plan est actif en base : un rapprochement raté se journalise, il
    // n'annule rien — et la synchronisation part quand même.
    const state = await acceptPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state.status).toBe('success');
    expect(mocks.syncPlanToIntervalsSafely).toHaveBeenCalled();
  });

  it('adopte quand même le plan si les suites de l’adoption lèvent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // `after()` hors contexte de requête, par exemple : une exception ici
    // sortirait de la Server Action et afficherait la frontière d'erreur alors
    // que la transaction est commitée.
    mocks.scheduleAfter.mockImplementation(() => {
      throw new Error('after() was called outside a request scope');
    });

    const state = await acceptPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state).toEqual({ status: 'success', message: 'Plan adopté.' });
    // L'écran doit quand même être rafraîchi : le plan a changé.
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/plan');
  });

  it('adopte quand même le plan si la revalidation lève', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // `revalidatePath` re-rend la route côté serveur : ce rendu peut échouer.
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error('render failed');
    });

    const state = await acceptPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state.status).toBe('success');
  });
});

describe('rejectPlanAction', () => {
  it('écarte la proposition et ne revalide que la page du plan', async () => {
    const state = await rejectPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state.status).toBe('success');
    expect(mocks.discardDraftPlan).toHaveBeenCalledWith(9);
    // Rien d'autre ne bouge : ni rapprochement, ni calendrier, ni tableau de
    // bord — la proposition n'y a jamais figuré.
    expect(mocks.reconcilePlanSessions).not.toHaveBeenCalled();
    expect(mocks.syncPlanToIntervalsSafely).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledExactlyOnceWith('/plan');
  });

  it.each(['', '0', 'neuf'])(
    'refuse un identifiant qui n’en est pas un (%s), sans rien supprimer',
    async (planId) => {
      const state = await rejectPlanAction(DECISION_IDLE, decisionForm(planId));

      expect(state.status).toBe('error');
      expect(mocks.discardDraftPlan).not.toHaveBeenCalled();
    },
  );

  it('tient une proposition déjà disparue pour un refus abouti', async () => {
    // Refusée depuis un autre onglet, ou remplacée par une nouvelle génération :
    // l'état voulu — plus aucune proposition — est atteint. Le signaler comme
    // une panne laisserait la carte à l'écran et l'utilisatrice à cliquer.
    mocks.discardDraftPlan.mockRejectedValue(new PlanNotFoundError());

    const state = await rejectPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state).toEqual({ status: 'success', message: 'Proposition écartée.' });
    expect(mocks.revalidatePath).toHaveBeenCalledExactlyOnceWith('/plan');
  });

  it('rend un message générique sur panne, sans lever ni laisser fuir la trace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.discardDraftPlan.mockRejectedValue(new Error('deadlock detected'));

    const state = await rejectPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state.status).toBe('error');
    expect(state.message).toBe("Le refus n'a pas abouti — réessaie.");
    expect(state.message).not.toContain('deadlock');
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('écarte quand même la proposition si la revalidation lève', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error('render failed');
    });

    const state = await rejectPlanAction(DECISION_IDLE, decisionForm('9'));

    expect(state.status).toBe('success');
    expect(mocks.discardDraftPlan).toHaveBeenCalledWith(9);
  });
});

describe('createPlanAction — suivi de la progression', () => {
  const PROGRESS_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

  it("transmet l'identifiant de suivi au service", async () => {
    const state = await createPlanAction(IDLE, form({ progressId: PROGRESS_ID }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(expect.objectContaining({}), PROGRESS_ID);
  });

  it.each(['', 'pas-un-uuid', '<script>'])(
    'ignore un identifiant mal formé (%s) sans refuser la génération',
    async (progressId) => {
      // Un endpoint public reçoit n'importe quoi dans ce champ. Il ne porte
      // qu'un confort d'affichage : le refuser coûterait une génération de
      // plusieurs minutes pour rien.
      const state = await createPlanAction(IDLE, form({ progressId }));

      expect(state.status).toBe('success');
      expect(mocks.generatePlan).toHaveBeenCalledWith(expect.objectContaining({}), undefined);
    },
  );
});

/*
 * Resynchronisation manuelle du calendrier.
 *
 * L'action ne lit aucun champ : tout ce qui lui appartient est la traduction du
 * résultat du service en une phrase pour l'athlète — et le fait qu'aucune trace
 * technique n'y passe.
 */
describe('resyncIntervalsAction', () => {
  it('republie le calendrier et annonce ce qui est parti', async () => {
    const state = await resyncIntervalsAction();

    expect(mocks.resyncPlanToIntervalsOnDemand).toHaveBeenCalledOnce();
    expect(state).toEqual({
      status: 'success',
      message: 'Calendrier resynchronisé : 12 séances poussées, 12 anciennes retirées.',
    });
  });

  it('accorde le compte au singulier, et tait ce qui vaut zéro', async () => {
    mocks.resyncPlanToIntervalsOnDemand.mockResolvedValue({
      status: 'synced',
      pushed: 1,
      deleted: 0,
    });

    const state = await resyncIntervalsAction();

    expect(state.message).toBe('Calendrier resynchronisé : 1 séance poussée.');
  });

  it("le dit sans mentir quand le plan n'a plus de séance à venir", async () => {
    mocks.resyncPlanToIntervalsOnDemand.mockResolvedValue({
      status: 'synced',
      pushed: 0,
      deleted: 3,
    });

    const state = await resyncIntervalsAction();

    expect(state).toEqual({
      status: 'success',
      message: 'Calendrier resynchronisé : aucune séance à pousser, 3 anciennes retirées.',
    });
  });

  it('renvoie sur la page quand aucun plan actif ne peut être republié', async () => {
    mocks.resyncPlanToIntervalsOnDemand.mockResolvedValue({ status: 'no-plan' });

    const state = await resyncIntervalsAction();

    expect(state).toEqual({ status: 'error', message: 'Aucun plan actif : recharge la page.' });
  });

  it('refuse proprement un second clic pendant la synchronisation en vol', async () => {
    mocks.resyncPlanToIntervalsOnDemand.mockResolvedValue({ status: 'busy' });

    const state = await resyncIntervalsAction();

    expect(state).toEqual({
      status: 'error',
      message: 'Une resynchronisation est déjà en cours : laisse-la finir.',
    });
  });

  it("ne fait pas fuiter le motif technique d'une configuration absente", async () => {
    mocks.resyncPlanToIntervalsOnDemand.mockResolvedValue({
      status: 'unconfigured',
      reason: 'INTERVALS_API_KEY manquante',
    });

    const state = await resyncIntervalsAction();

    expect(state.status).toBe('error');
    expect(state.message).not.toContain('INTERVALS_API_KEY');
    expect(state.message).toContain('intervals.icu');
  });

  it('rend un échec lisible, sans trace, quand la synchronisation a échoué', async () => {
    mocks.resyncPlanToIntervalsOnDemand.mockResolvedValue({ status: 'failed' });

    const state = await resyncIntervalsAction();

    expect(state).toEqual({
      status: 'error',
      message: "Le calendrier n'a pas pu être resynchronisé — réessaie dans un instant.",
    });
  });
});
