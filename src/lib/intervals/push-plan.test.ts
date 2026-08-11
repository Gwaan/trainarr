import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvCache } from '@/config/env';
import type { PlanDto, PlanSessionDto } from '@/data/plans';

import type { IntervalsEvent } from './client';
import {
  SYNC_HORIZON_DAYS,
  TRAINARR_EXTERNAL_ID_PREFIX,
  buildWorkoutEvents,
  planCalendarReplacement,
  planSessionExternalId,
  syncPlanToIntervals,
  syncPlanToIntervalsSafely,
  syncWindow,
} from './push-plan';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { api } = vi.hoisted(() => ({
  api: {
    listWorkoutEvents: vi.fn(),
    createWorkoutEvents: vi.fn(),
    deleteCalendarEvents: vi.fn(),
  },
}));
const { dal } = vi.hoisted(() => ({ dal: { getActivePlanWithSessions: vi.fn() } }));

vi.mock('./client', () => api);
vi.mock('@/data/plans', async () => {
  // Seule la lecture qui touche la base est remplacée : les bornes du plan
  // (dont dépend l'horizon de synchronisation) restent le vrai code.
  const actual = await vi.importActual<typeof import('@/data/plans')>('@/data/plans');
  return { ...actual, getActivePlanWithSessions: dal.getActivePlanWithSessions };
});

const API_KEY = 'cle-api-de-test';

/** Mardi 11 août 2026 — le plan court jusqu'au 30. */
const TODAY = '2026-08-11';

const PLAN: PlanDto = {
  id: 3,
  status: 'active',
  goalType: 'race',
  level: 'intermediate',
  goalText: '10 km sous 50 min',
  raceDate: '2026-09-13',
  startsOn: '2026-08-03',
  weeks: 6,
  sessionsPerWeek: 3,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: null,
  referenceTimeS: null,
  summary: 'Bloc de 6 semaines.',
  reviewedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
};

function session(overrides: Partial<PlanSessionDto> & { scheduledOn: string }): PlanSessionDto {
  return {
    id: 1,
    kind: 'Footing',
    title: '45 min souple',
    warmup: null,
    recovery: null,
    cooldown: null,
    targetPaceSecPerKm: null,
    volumeM: null,
    durationS: null,
    steps: null,
    completedActivityId: null,
    ...overrides,
  };
}

function event(overrides: Partial<IntervalsEvent> & { id: number }): IntervalsEvent {
  return {
    externalId: null,
    category: 'WORKOUT',
    startDateLocal: null,
    name: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // 9 h UTC : le même jour civil à Paris comme en UTC, la date de test est donc
  // celle qu'on lit.
  vi.setSystemTime(new Date(`${TODAY}T09:00:00.000Z`));
  vi.clearAllMocks();

  resetEnvCache();
  vi.stubEnv('INTERVALS_API_KEY', API_KEY);
  resetEnvCache();

  api.listWorkoutEvents.mockResolvedValue([]);
  api.createWorkoutEvents.mockImplementation(
    async ({ events }: { events: readonly { externalId: string }[] }) =>
      events.map((workout, index) => ({
        id: 1_000 + index,
        externalId: workout.externalId,
        category: 'WORKOUT',
        startDateLocal: null,
        name: null,
      })),
  );
  // L'API rend le nombre d'events réellement supprimés ; par défaut elle
  // supprime tout ce qu'on lui a demandé.
  api.deleteCalendarEvents.mockImplementation(
    async ({ ids }: { ids: readonly unknown[] }) => ids.length,
  );
  dal.getActivePlanWithSessions.mockResolvedValue({ plan: PLAN, sessions: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetEnvCache();
  vi.restoreAllMocks();
});

describe('planSessionExternalId', () => {
  it('porte le préfixe Trainarr, le plan et le jour', () => {
    expect(planSessionExternalId(3, '2026-08-18', 0)).toBe('trainarr-p3-2026-08-18-0');
    expect(
      planSessionExternalId(3, '2026-08-18', 0).startsWith(TRAINARR_EXTERNAL_ID_PREFIX),
    ).toBe(true);
  });

  it('reste stable pour une séance inchangée, quel que soit son id en base', () => {
    // Un ajustement du coach réinsère les séances : leurs id changent, pas leur
    // jour. Le marqueur d'un mardi inchangé reste donc le même d'une
    // synchronisation à l'autre.
    const before = buildWorkoutEvents(3, [session({ id: 11, scheduledOn: '2026-08-18' })]);
    const after = buildWorkoutEvents(3, [session({ id: 87, scheduledOn: '2026-08-18' })]);

    expect(after[0].externalId).toBe(before[0].externalId);
  });
});

describe('buildWorkoutEvents', () => {
  it("compose le nom comme l'UI : nature de la séance puis intitulé", () => {
    const [workout] = buildWorkoutEvents(3, [
      session({ scheduledOn: '2026-08-18', kind: 'VMA courte · piste', title: '6 × 800 m' }),
    ]);

    expect(workout.name).toBe('VMA courte · piste — 6 × 800 m');
    expect(workout.startDate).toBe('2026-08-18');
    expect(workout.type).toBe('Run');
  });

  it("détaille la séance et son allure cible, sans inventer ce qui manque", () => {
    const [workout] = buildWorkoutEvents(3, [
      session({
        scheduledOn: '2026-08-18',
        title: '6 × 800 m',
        warmup: '15 min footing',
        recovery: '400 m trot',
        cooldown: '10 min souple',
        targetPaceSecPerKm: 235,
        durationS: 3_600,
        volumeM: 12_000,
      }),
    ]);

    expect(workout.description).toBe(
      [
        'Échauffement : 15 min footing',
        'Séance : 6 × 800 m',
        'Récupération : 400 m trot',
        'Retour au calme : 10 min souple',
        'Allure cible : 3:55/km',
      ].join('\n'),
    );
    expect(workout.timeTargetS).toBe(3_600);
    expect(workout.distanceTargetM).toBe(12_000);
    expect(workout.target).toBe('PACE');
  });

  it("n'envoie aucune cible quand le plan n'en donne pas", () => {
    const [workout] = buildWorkoutEvents(3, [session({ scheduledOn: '2026-08-18' })]);

    expect(workout.description).toBe('Séance : 45 min souple');
    expect(workout).not.toHaveProperty('timeTargetS');
    expect(workout).not.toHaveProperty('distanceTargetM');
    expect(workout).not.toHaveProperty('target');
  });

  it("publie le déroulé structuré dans la syntaxe native quand la séance en a un", () => {
    // C'est ce qui rend la séance exécutable pas à pas sur la montre : du texte
    // plat s'afficherait au calendrier sans jamais être découpé en étapes.
    const [workout] = buildWorkoutEvents(3, [
      session({
        scheduledOn: '2026-08-18',
        kind: 'VMA courte · piste',
        title: '6 × 800 m',
        warmup: '15 min footing',
        cooldown: '10 min souple',
        targetPaceSecPerKm: 240,
        durationS: 3_600,
        volumeM: 12_000,
        steps: [
          {
            repeat: 1,
            steps: [
              {
                role: 'warmup',
                distanceM: null,
                durationS: 900,
                paceMinSecPerKm: null,
                paceMaxSecPerKm: null,
                hrZone: 2,
                note: null,
              },
            ],
          },
          {
            repeat: 6,
            steps: [
              {
                role: 'run',
                distanceM: 800,
                durationS: null,
                paceMinSecPerKm: 235,
                paceMaxSecPerKm: 245,
                hrZone: null,
                note: null,
              },
              {
                role: 'recover',
                distanceM: null,
                durationS: 90,
                paceMinSecPerKm: null,
                paceMaxSecPerKm: null,
                hrZone: null,
                note: 'trot',
              },
            ],
          },
        ],
      }),
    ]);

    expect(workout.description).toBe(
      [
        '- Echauffement 15m Z2 HR',
        '',
        '6x',
        '- Course 800mtr 3:55-4:05/km Pace',
        '- Recuperation - trot 1m30s',
      ].join('\n'),
    );
    // Les cibles de l'event restent alimentées comme avant : c'est le DAL qui
    // dérive volume et durée des étapes à l'écriture.
    expect(workout.timeTargetS).toBe(3_600);
    expect(workout.distanceTargetM).toBe(12_000);
    expect(workout.target).toBe('PACE');
  });

  it('reste en texte plat pour une séance sans déroulé structuré', () => {
    const [workout] = buildWorkoutEvents(3, [
      session({ scheduledOn: '2026-08-18', title: '45 min souple', warmup: '10 min de marche' }),
    ]);

    expect(workout.description).toBe(
      ['Échauffement : 10 min de marche', 'Séance : 45 min souple'].join('\n'),
    );
  });

  it('distingue deux séances du même jour par leur index', () => {
    const events = buildWorkoutEvents(3, [
      session({ id: 1, scheduledOn: '2026-08-18', title: 'Footing matin' }),
      session({ id: 2, scheduledOn: '2026-08-18', title: 'Côtes le soir' }),
      session({ id: 3, scheduledOn: '2026-08-19' }),
    ]);

    expect(events.map((workout) => workout.externalId)).toEqual([
      'trainarr-p3-2026-08-18-0',
      'trainarr-p3-2026-08-18-1',
      'trainarr-p3-2026-08-19-0',
    ]);
  });
});

describe('syncWindow', () => {
  it("part d'aujourd'hui et couvre le plus long plan possible", () => {
    const range = syncWindow(TODAY);

    expect(range.oldest).toBe(TODAY);
    // 104 semaines (le maximum du DAL) plus une semaine de marge.
    expect(SYNC_HORIZON_DAYS).toBe(735);
    expect(range.newest).toBe('2028-08-15');
  });
});

describe('planCalendarReplacement', () => {
  const desired = buildWorkoutEvents(3, [
    session({ scheduledOn: '2026-08-18' }),
    session({ scheduledOn: '2026-08-20' }),
  ]);

  it('publie toutes les séances voulues quand le calendrier est vide', () => {
    const replacement = planCalendarReplacement(desired, []);

    expect(replacement.toCreate).toEqual(desired);
    expect(replacement.toDeleteIds).toEqual([]);
  });

  it("supprime puis recrée même une séance inchangée", () => {
    // Le remplacement est complet : rien n'est laissé en place au motif que la
    // séance n'a pas bougé. C'est ce qui rend les doublons impossibles, l'API ne
    // sachant pas mettre un event à jour sur une clé à nous.
    const replacement = planCalendarReplacement(desired, [
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
    ]);

    expect(replacement.toDeleteIds).toEqual([4321]);
    expect(replacement.toCreate.map((workout) => workout.externalId)).toContain(
      'trainarr-p3-2026-08-18-0',
    );
  });

  it('supprime tous les events Trainarr de la fenêtre, par id', () => {
    const replacement = planCalendarReplacement(desired, [
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
      // Séance déplacée : son ancien jour n'est plus voulu.
      event({ id: 4322, externalId: 'trainarr-p3-2026-08-19-0' }),
      // Plan précédent, archivé.
      event({ id: 4323, externalId: 'trainarr-p2-2026-08-25-0' }),
    ]);

    expect(replacement.toDeleteIds).toEqual([4321, 4322, 4323]);
  });

  it('purge les deux exemplaires si le même marqueur apparaît en double', () => {
    const replacement = planCalendarReplacement(desired, [
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
      event({ id: 4324, externalId: 'trainarr-p3-2026-08-18-0' }),
    ]);

    expect(replacement.toDeleteIds).toEqual([4321, 4324]);
    expect(replacement.toCreate).toEqual(desired);
  });

  it("ne touche jamais un event que Trainarr n'a pas créé", () => {
    const replacement = planCalendarReplacement(desired, [
      // Séance saisie à la main, ou event d'une version antérieure de Trainarr
      // (le marqueur partait alors dans `uid`, que l'API écrase).
      event({ id: 5001, externalId: null }),
      event({ id: 5002, externalId: 'garmin-abcdef' }),
      event({ id: 5003, externalId: 'TRAINARR-p3-2026-08-30-0' }),
    ]);

    expect(replacement.toDeleteIds).toEqual([]);
  });

  it('supprime tout le futur Trainarr quand plus aucune séance n\'est voulue', () => {
    const replacement = planCalendarReplacement(
      [],
      [
        event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
        event({ id: 4322, externalId: 'trainarr-p3-2026-08-20-0' }),
        event({ id: 5002, externalId: 'course-du-club' }),
      ],
    );

    expect(replacement.toCreate).toEqual([]);
    expect(replacement.toDeleteIds).toEqual([4321, 4322]);
  });
});

describe('syncPlanToIntervals', () => {
  it("ne tente rien sans clé API, et le dit", async () => {
    vi.stubEnv('INTERVALS_API_KEY', '');
    resetEnvCache();

    await expect(syncPlanToIntervals()).resolves.toEqual({
      status: 'unconfigured',
      reason: 'INTERVALS_API_KEY manquante',
    });
    expect(api.listWorkoutEvents).not.toHaveBeenCalled();
    expect(dal.getActivePlanWithSessions).not.toHaveBeenCalled();
  });

  it("interroge l'athlète 0 quand aucun identifiant n'est configuré", async () => {
    await syncPlanToIntervals();

    expect(api.listWorkoutEvents).toHaveBeenCalledWith(
      expect.objectContaining({ athleteId: '0', apiKey: API_KEY, oldest: TODAY }),
    );
  });

  it("ne pousse que les séances d'aujourd'hui et à venir", async () => {
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [
        session({ id: 1, scheduledOn: '2026-08-04' }),
        session({ id: 2, scheduledOn: '2026-08-10' }),
        session({ id: 3, scheduledOn: TODAY }),
        session({ id: 4, scheduledOn: '2026-08-16' }),
      ],
    });

    const report = await syncPlanToIntervals();

    const pushed = api.createWorkoutEvents.mock.calls[0][0].events as { externalId: string }[];
    expect(pushed.map((workout) => workout.externalId)).toEqual([
      'trainarr-p3-2026-08-11-0',
      'trainarr-p3-2026-08-16-0',
    ]);
    expect(report).toEqual({ status: 'synced', pushed: 2, deleted: 0 });
  });

  it('republie tout, puis purge tous ses anciens events — dans cet ordre', async () => {
    const order: string[] = [];
    api.deleteCalendarEvents.mockImplementation(async ({ ids }: { ids: readonly unknown[] }) => {
      order.push('delete');
      return ids.length;
    });
    api.createWorkoutEvents.mockImplementation(async () => {
      order.push('create');
      return [];
    });
    api.listWorkoutEvents.mockResolvedValue([
      // La séance du 18 est inchangée : elle est quand même recréée puis purgée.
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
      event({ id: 4322, externalId: 'trainarr-p3-2026-08-19-0' }),
    ]);
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [session({ scheduledOn: '2026-08-18' })],
    });

    await syncPlanToIntervals();

    expect(api.deleteCalendarEvents).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [4321, 4322] }),
    );
    const created = api.createWorkoutEvents.mock.calls[0][0].events as { externalId: string }[];
    expect(created.map((workout) => workout.externalId)).toEqual(['trainarr-p3-2026-08-18-0']);
    // L'ordre est la garantie : une création ratée laisse l'ancien calendrier
    // en place plutôt qu'un calendrier vide.
    expect(order).toEqual(['create', 'delete']);
  });

  it("ne supprime que les ids vus au listing, jamais ceux qu'elle vient de créer", async () => {
    api.listWorkoutEvents.mockResolvedValue([
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
    ]);
    // Les events créés reçoivent des ids serveur frais — ici 9001 — qui ne
    // figuraient pas au listing.
    api.createWorkoutEvents.mockResolvedValue([
      event({ id: 9001, externalId: 'trainarr-p3-2026-08-18-0' }),
    ]);
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [session({ scheduledOn: '2026-08-18' })],
    });

    await syncPlanToIntervals();

    expect(api.deleteCalendarEvents).toHaveBeenCalledWith(expect.objectContaining({ ids: [4321] }));
  });

  it("n'émet aucune suppression quand la publication échoue", async () => {
    // Le mode de panne à ne jamais laisser revenir : l'ancien calendrier reste
    // intact, périmé mais complet, plutôt que vidé sans rien pour le remplacer.
    api.listWorkoutEvents.mockResolvedValue([
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
    ]);
    api.createWorkoutEvents.mockRejectedValue(new Error('HTTP 502'));
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [session({ scheduledOn: '2026-08-18' })],
    });

    await expect(syncPlanToIntervals()).rejects.toThrow('HTTP 502');
    expect(api.deleteCalendarEvents).not.toHaveBeenCalled();
  });

  it('signale une suppression ratée, une fois les séances publiées', async () => {
    api.listWorkoutEvents.mockResolvedValue([
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
    ]);
    api.deleteCalendarEvents.mockRejectedValue(new Error('HTTP 500'));
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [session({ scheduledOn: '2026-08-18' })],
    });

    await expect(syncPlanToIntervals()).rejects.toThrow('HTTP 500');
    // Les séances voulues sont bien au calendrier : il reste des doublons, pas
    // un trou. Et l'échec ne se perd pas.
    expect(api.createWorkoutEvents).toHaveBeenCalled();
  });

  it('purge les doublons laissés par une suppression ratée', async () => {
    // La synchronisation suivante : deux exemplaires du même marqueur, deux ids,
    // deux suppressions. C'est ce qui rend la convergence indépendante des
    // échecs qui précèdent.
    api.listWorkoutEvents.mockResolvedValue([
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
      event({ id: 9001, externalId: 'trainarr-p3-2026-08-18-0' }),
    ]);
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [session({ scheduledOn: '2026-08-18' })],
    });

    const report = await syncPlanToIntervals();

    expect(api.deleteCalendarEvents).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [4321, 9001] }),
    );
    expect(report).toEqual({ status: 'synced', pushed: 1, deleted: 2 });
  });

  it("rapporte le compte de suppressions rendu par l'API, pas celui qu'on espérait", async () => {
    api.listWorkoutEvents.mockResolvedValue([
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
      event({ id: 4322, externalId: 'trainarr-p3-2026-08-19-0' }),
    ]);
    // Un event déjà disparu côté intervals.icu : l'API n'en supprime qu'un.
    api.deleteCalendarEvents.mockResolvedValue(1);
    dal.getActivePlanWithSessions.mockResolvedValue({ plan: PLAN, sessions: [] });

    const report = await syncPlanToIntervals();

    expect(report).toEqual({ status: 'synced', pushed: 0, deleted: 1 });
  });

  it("laisse intacts les events dont l'external_id n'est pas le nôtre", async () => {
    api.listWorkoutEvents.mockResolvedValue([
      event({ id: 5001, externalId: null }),
      event({ id: 5002, externalId: 'garmin-abcdef' }),
    ]);
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [session({ scheduledOn: '2026-08-18' })],
    });

    const report = await syncPlanToIntervals();

    expect(api.deleteCalendarEvents).not.toHaveBeenCalled();
    expect(report).toEqual({ status: 'synced', pushed: 1, deleted: 0 });
  });

  it("efface les séances à venir quand plus aucun plan n'est actif", async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(null);
    api.listWorkoutEvents.mockResolvedValue([
      event({ id: 4321, externalId: 'trainarr-p3-2026-08-18-0' }),
      event({ id: 5002, externalId: null }),
    ]);

    const report = await syncPlanToIntervals();

    expect(api.deleteCalendarEvents).toHaveBeenCalledWith(expect.objectContaining({ ids: [4321] }));
    // Rien à publier : pas d'appel inutile.
    expect(api.createWorkoutEvents).not.toHaveBeenCalled();
    expect(report).toEqual({ status: 'synced', pushed: 0, deleted: 1 });
  });

  it("n'appelle pas la suppression quand il n'y a rien à supprimer", async () => {
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [session({ scheduledOn: '2026-08-18' })],
    });

    await syncPlanToIntervals();

    expect(api.deleteCalendarEvents).not.toHaveBeenCalled();
  });

  it('propage une panne réseau (la garde est chez son appelant)', async () => {
    api.listWorkoutEvents.mockRejectedValue(new Error('fetch failed'));

    await expect(syncPlanToIntervals()).rejects.toThrow('fetch failed');
  });
});

describe('syncPlanToIntervalsSafely', () => {
  it("n'échoue jamais, et laisse une trace de la panne", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.listWorkoutEvents.mockRejectedValue(new Error('fetch failed'));

    await expect(syncPlanToIntervalsSafely('plan 3')).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });

  it('résume ce qui a changé', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN,
      sessions: [session({ scheduledOn: '2026-08-18' })],
    });

    await syncPlanToIntervalsSafely('plan 3');

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('publiées : 1, supprimées : 0'));
  });

  it("dit pourquoi rien n'est parti quand la synchronisation n'est pas configurée", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('INTERVALS_API_KEY', '');
    resetEnvCache();

    await syncPlanToIntervalsSafely('plan 3');

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('INTERVALS_API_KEY manquante'));
  });

  it('se tait quand le calendrier était déjà à jour', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    dal.getActivePlanWithSessions.mockResolvedValue({ plan: PLAN, sessions: [] });

    await syncPlanToIntervalsSafely('plan 3');

    expect(logged).not.toHaveBeenCalled();
  });
});
