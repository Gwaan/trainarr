import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ActivityFullDto, ActivitySplitDto } from '@/data/activities';
import type { ComparableActivityDto, TrainingSnapshotDto } from '@/data/coach-context';
import type { PlanSessionDto } from '@/data/plans';

import { AiUnavailableError } from './errors';
import { buildFeedbackMessages, generateActivityFeedback, sampleSplits } from './feedback-service';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { chatCompletion } = vi.hoisted(() => ({ chatCompletion: vi.fn() }));
const { requireAi } = vi.hoisted(() => ({ requireAi: vi.fn() }));
const { dal } = vi.hoisted(() => ({
  dal: {
    getActivityFull: vi.fn(),
    getActivityFeedback: vi.fn(),
    saveActivityFeedback: vi.fn(),
    getTrainingSnapshot: vi.fn(),
    getComparableActivities: vi.fn(),
    getPlannedSessionForActivity: vi.fn(),
  },
}));

vi.mock('./client', () => ({ chatCompletion }));
vi.mock('./availability', () => ({ requireAi }));
vi.mock('@/config/env', () => ({ env: { AI_MODEL: 'qwen3-8b-q4' } }));
// `ActivityNotFoundError` vit dans ce module (et `@/data/activity-feedback` la
// réexporte) : le mock doit la laisser passer, sinon le service lève une tout
// autre erreur en tentant de l'instancier.
vi.mock('@/data/activities', async () => {
  const actual = await vi.importActual<typeof import('@/data/activities')>('@/data/activities');
  return { ...actual, getActivityFull: dal.getActivityFull };
});
vi.mock('@/data/activity-feedback', async () => {
  const actual =
    await vi.importActual<typeof import('@/data/activity-feedback')>('@/data/activity-feedback');
  return {
    ...actual,
    getActivityFeedback: dal.getActivityFeedback,
    saveActivityFeedback: dal.saveActivityFeedback,
  };
});
vi.mock('@/data/coach-context', () => ({
  getTrainingSnapshot: dal.getTrainingSnapshot,
  getComparableActivities: dal.getComparableActivities,
}));
vi.mock('@/data/plans', () => ({
  getPlannedSessionForActivity: dal.getPlannedSessionForActivity,
}));

function split(km: number, overrides: Partial<ActivitySplitDto> = {}): ActivitySplitDto {
  return {
    km,
    distanceM: 1_000,
    timeS: 300,
    paceSecPerKm: 300,
    avgHrBpm: 150,
    elevationGainM: 12,
    ...overrides,
  };
}

const ACTIVITY: ActivityFullDto = {
  detail: {
    id: 7,
    name: 'Sortie longue du dimanche',
    sportType: 'Run',
    startedAt: new Date('2026-08-09T07:00:00.000Z'),
    distanceM: 18_240,
    movingTimeS: 5_400,
    elapsedTimeS: 5_600,
    elevationGainM: 210,
    avgHrBpm: 148,
    maxHrBpm: 172,
    avgPaceSecPerKm: 296,
    avgCadenceSpm: 174,
  },
  // Les points de courbe et la trace GPS existent — et ne doivent jamais partir.
  charts: {
    points: [
      { timeS: 0, distanceM: 0, paceSecPerKm: 300, hrBpm: 120, altitudeM: 40, cadenceSpm: 170, strideM: 1.1 },
    ],
    latlng: [[45.76, 4.83]],
  },
  splits: [split(1), split(2, { paceSecPerKm: 310, avgHrBpm: 155 })],
  hrZones: [
    { zone: 1, timeS: 600, share: 0.11 },
    { zone: 2, timeS: 3_600, share: 0.67 },
    { zone: 3, timeS: 1_200, share: 0.22 },
    { zone: 4, timeS: 0, share: 0 },
    { zone: 5, timeS: 0, share: 0 },
  ],
  hrAnchor: { kind: 'max-hr', bpm: 188 },
  paceDistribution: null,
  hrDistribution: null,
  decoupling: {
    firstHalf: { avgSpeedMps: 3.4, avgHrBpm: 143, ef: 0.0238 },
    secondHalf: { avgSpeedMps: 3.3, avgHrBpm: 152, ef: 0.0217 },
    decouplingPct: 8.8,
  },
  bestSegments: [{ targetM: 5_000, timeS: 1_440, paceSecPerKm: 288 }],
  trimp: 112.4,
  effectiveVo2max: 48.2,
};

const SNAPSHOT: TrainingSnapshotDto = {
  today: '2026-08-11',
  profile: { ageYears: 36, sex: 'female', maxHrBpm: 188, restingHrBpm: 48, weightKg: 62 },
  fitness: { ctl: 52.4, atl: 61.2, tsb: -8.8 },
  vo2max: 48.6,
  weeks: [{ startsOn: '2026-08-03', distanceKm: 42.1, movingTimeS: 13_500, sessions: 4 }],
  longestSessionKm30d: 14.2,
  recentAvgPaceSecPerKm: 324,
};

const COMPARABLE: ComparableActivityDto = {
  date: '2026-07-26',
  distanceM: 17_500,
  movingTimeS: 5_600,
  avgPaceSecPerKm: 320,
  avgHrBpm: 151,
  elevationGainM: 180,
  trimp: 118.2,
};

const PLANNED: PlanSessionDto = {
  id: 5,
  scheduledOn: '2026-08-09',
  kind: 'Sortie longue',
  title: '18 km en endurance',
  warmup: null,
  recovery: null,
  cooldown: null,
  targetPaceSecPerKm: 310,
  volumeM: 18_000,
  durationS: 5_580,
  steps: null,
  completedActivityId: 7,
};

const CONTEXT = {
  activity: ACTIVITY,
  snapshot: SNAPSHOT,
  comparables: [COMPARABLE],
  plannedSession: PLANNED,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAi.mockResolvedValue(undefined);
  dal.getActivityFull.mockResolvedValue(ACTIVITY);
  dal.getTrainingSnapshot.mockResolvedValue(SNAPSHOT);
  dal.getComparableActivities.mockResolvedValue([COMPARABLE]);
  dal.getPlannedSessionForActivity.mockResolvedValue(PLANNED);
  dal.saveActivityFeedback.mockResolvedValue(undefined);
  dal.getActivityFeedback.mockResolvedValue({
    content: '### Ce qui s’est bien passé\n- …',
    model: 'qwen3-8b-q4',
    createdAt: '2026-08-11T09:00:00.000Z',
  });
  chatCompletion.mockResolvedValue('  ### Ce qui s’est bien passé\n- …  ');
});

describe('sampleSplits', () => {
  it('laisse les splits intacts sous le plafond', () => {
    const splits = [split(1), split(2)];
    expect(sampleSplits(splits, 30)).toEqual(splits);
  });

  it('échantillonne au-delà du plafond en gardant le premier et le dernier km', () => {
    const splits = Array.from({ length: 43 }, (_, index) => split(index + 1));
    const sampled = sampleSplits(splits, 30);

    expect(sampled.length).toBeLessThanOrEqual(30);
    expect(sampled[0].km).toBe(1);
    expect(sampled[sampled.length - 1].km).toBe(43);
  });
});

describe('buildFeedbackMessages', () => {
  const messages = buildFeedbackMessages(CONTEXT);
  const user = messages[1].content;

  it('impose la structure et interdit d’inventer, dans le message système', () => {
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain("### Ce qui s'est bien passé");
    expect(messages[0].content).toContain("### Points d'attention");
    expect(messages[0].content).toContain('### Pour la suite');
    expect(messages[0].content).toContain("ne s'invente jamais");
  });

  it('porte les agrégats de la séance', () => {
    expect(user).toContain('« Sortie longue du dimanche »');
    expect(user).toContain('18,2 km');
    expect(user).toContain('1 h 30');
    expect(user).toContain('4:56/km');
    expect(user).toContain('FC moyenne 148 bpm (max 172 bpm)');
    expect(user).toContain('TRIMP 112');
    expect(user).toContain('VO2max effective de la séance 48,2');
    expect(user).toContain('- km 2 · 5:10/km · 155 bpm · +12 m');
    expect(user).toContain('Z2 1 h 00 (67 %)');
    expect(user).toContain('Découplage aérobie (Pa:HR) : +8,8 %');
    expect(user).toContain('5,0 km en 24 min (4:48/km)');
  });

  it('met le prévu en regard du réalisé', () => {
    expect(user).toContain('Séance prévue au plan ce jour-là : Sortie longue — 18 km en endurance');
    expect(user).toContain('18,0 km · 1 h 33 · 5:10/km');
  });

  it('situe la séance parmi les sorties comparables et dans l’état de forme', () => {
    expect(user).toContain('il y a 16 jours · 17,5 km · 5:20/km · 151 bpm');
    expect(user).toContain('CTL 52 · ATL 61 · TSB -9');
  });

  it('n’envoie ni points de courbe ni trace GPS', () => {
    expect(user).not.toContain('45.76');
    expect(user).not.toContain('strideM');
    expect(user).not.toContain('latlng');
    // Un prompt de feedback tient largement sous les 8 k tokens visés.
    expect(user.length).toBeLessThan(4_000);
  });

  it('ne dit pas un mot des données absentes', () => {
    const bare = buildFeedbackMessages({
      activity: {
        ...ACTIVITY,
        detail: { ...ACTIVITY.detail, avgHrBpm: null, maxHrBpm: null, avgCadenceSpm: null, elevationGainM: null },
        splits: [],
        hrZones: null,
        decoupling: null,
        bestSegments: [],
        trimp: null,
        effectiveVo2max: null,
      },
      snapshot: SNAPSHOT,
      comparables: [],
      plannedSession: null,
    })[1].content;

    expect(bare).not.toContain('FC moyenne');
    expect(bare).not.toContain('Temps par zone de FC');
    expect(bare).not.toContain('Splits');
    expect(bare).not.toContain('Dénivelé');
    expect(bare).not.toContain('TRIMP');
    expect(bare).not.toContain('Découplage');
    expect(bare).not.toContain('Séance prévue');
    expect(bare).not.toContain('null');
  });
});

describe('generateActivityFeedback', () => {
  it('rassemble le contexte, enregistre le texte détouré et rend le DTO', async () => {
    const feedback = await generateActivityFeedback(7);

    expect(dal.getComparableActivities).toHaveBeenCalledWith(7);
    expect(dal.saveActivityFeedback).toHaveBeenCalledWith(
      7,
      '### Ce qui s’est bien passé\n- …',
      'qwen3-8b-q4',
    );
    expect(feedback.model).toBe('qwen3-8b-q4');
  });

  it("échoue proprement quand l'activité n'existe pas, sans appeler le modèle", async () => {
    dal.getActivityFull.mockResolvedValue(null);

    await expect(generateActivityFeedback(7)).rejects.toThrow(/Aucune activité ne correspond/);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('propage une indisponibilité du coach sans rien lire', async () => {
    requireAi.mockRejectedValue(new AiUnavailableError('unreachable'));

    await expect(generateActivityFeedback(7)).rejects.toThrow(AiUnavailableError);
    expect(dal.getActivityFull).not.toHaveBeenCalled();
    expect(dal.saveActivityFeedback).not.toHaveBeenCalled();
  });
});
