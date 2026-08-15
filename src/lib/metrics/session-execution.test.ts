import { describe, expect, it } from 'vitest';

import type { HrZoneAnchor } from './hr-zones';
import {
  executionSummary,
  locateRepetitions,
  sessionExecution,
  windowCoverage,
  type ExecutionStreams,
  type SessionExecutionInput,
} from './session-execution';
import type { PlanSessionSteps, PlanStep } from '../plan-steps/schema';

/** Étape complète : toutes les clés du contrat, `null` par défaut. */
function step(partial: Partial<PlanStep> & Pick<PlanStep, 'role'>): PlanStep {
  return {
    role: partial.role,
    distanceM: partial.distanceM ?? null,
    durationS: partial.durationS ?? null,
    paceMinSecPerKm: partial.paceMinSecPerKm ?? null,
    paceMaxSecPerKm: partial.paceMaxSecPerKm ?? null,
    hrZone: partial.hrZone ?? null,
    hrPercentMin: partial.hrPercentMin ?? null,
    hrPercentMax: partial.hrPercentMax ?? null,
    note: partial.note ?? null,
  };
}

const MAX_HR_ANCHOR: HrZoneAnchor = { kind: 'max-hr', bpm: 190 };

/**
 * Trace à 1 Hz construite segment par segment : chaque segment couvre
 * `distanceM` en `durationS` secondes, à vitesse constante.
 */
function trace(
  segments: readonly { distanceM: number; durationS: number }[],
): ExecutionStreams {
  const time: number[] = [0];
  const distance: number[] = [0];

  for (const segment of segments) {
    const speed = segment.distanceM / segment.durationS;
    const startS = time[time.length - 1];
    const startM = distance[distance.length - 1];

    for (let second = 1; second <= segment.durationS; second += 1) {
      time.push(startS + second);
      distance.push(startM + speed * second);
    }
  }

  return { distance, time };
}

/** Séance de 6 × 800 m (récup 200 m), échauffement et retour au calme de 1 km. */
function intervalSteps(paceBand = { min: 240, max: 250 }): PlanSessionSteps {
  return [
    { repeat: 1, steps: [step({ role: 'warmup', distanceM: 1000 })] },
    {
      repeat: 6,
      steps: [
        step({
          role: 'run',
          distanceM: 800,
          paceMinSecPerKm: paceBand.min,
          paceMaxSecPerKm: paceBand.max,
        }),
        step({ role: 'recover', distanceM: 200 }),
      ],
    },
    { repeat: 1, steps: [step({ role: 'cooldown', distanceM: 1000 })] },
  ];
}

/** Les six répétitions courues en 200, 200, 205, 195, 230 et 200 secondes. */
const REPETITION_DURATIONS_S = [200, 200, 205, 195, 230, 200] as const;

function intervalTrace(): ExecutionStreams {
  return trace([
    { distanceM: 1000, durationS: 333 },
    ...REPETITION_DURATIONS_S.flatMap((durationS) => [
      { distanceM: 800, durationS },
      { distanceM: 200, durationS: 100 },
    ]),
    { distanceM: 1000, durationS: 333 },
  ]);
}

/** Footing de 8 km prescrit en zone 2, sans cible d'allure. */
function easySteps(): PlanSessionSteps {
  return [{ repeat: 1, steps: [step({ role: 'run', distanceM: 8000, hrZone: 2 })] }];
}

function input(overrides: Partial<SessionExecutionInput> = {}): SessionExecutionInput {
  return {
    steps: null,
    targetPaceSecPerKm: null,
    volumeM: null,
    durationS: null,
    hrAnchor: MAX_HR_ANCHOR,
    actual: {
      distanceM: 8_120,
      movingTimeS: 2_800,
      avgPaceSecPerKm: 345,
      avgHrBpm: 140,
    },
    streams: null,
    ...overrides,
  };
}

describe('sessionExecution — séance simple', () => {
  it('compare la FC moyenne à la bande prescrite, résolue en battements', () => {
    const execution = sessionExecution(input({ steps: easySteps() }));

    // Zone 2 = 65–79 % de FC max, soit 124–150 bpm sur une FC max de 190.
    expect(execution?.rows).toContainEqual({
      metric: 'heart-rate',
      repetition: null,
      band: { min: 124, max: 150 },
      target: null,
      actual: 140,
      delta: 0,
      standing: 'in-band',
    });
  });

  it('dit de quel côté de la bande la FC est tombée, et de combien', () => {
    const over = sessionExecution(
      input({ steps: easySteps(), actual: { ...input().actual, avgHrBpm: 158 } }),
    );
    expect(over?.rows[0]).toMatchObject({ standing: 'over', delta: 8, actual: 158 });

    const under = sessionExecution(
      input({ steps: easySteps(), actual: { ...input().actual, avgHrBpm: 118 } }),
    );
    expect(under?.rows[0]).toMatchObject({ standing: 'under', delta: -6, actual: 118 });
  });

  it('compare l’allure moyenne à la bande que toutes les étapes de course visent', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 1,
        steps: [
          step({ role: 'run', distanceM: 4000, paceMinSecPerKm: 340, paceMaxSecPerKm: 350 }),
          step({ role: 'run', distanceM: 4000, paceMinSecPerKm: 340, paceMaxSecPerKm: 350 }),
        ],
      },
    ];

    const execution = sessionExecution(input({ steps }));

    expect(execution?.rows[0]).toMatchObject({
      metric: 'pace',
      band: { min: 340, max: 350 },
      actual: 345,
      standing: 'in-band',
    });
  });

  it('refuse une cible d’ensemble quand les étapes visent des allures différentes', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 1,
        steps: [
          step({ role: 'run', distanceM: 6000, paceMinSecPerKm: 340, paceMaxSecPerKm: 350 }),
          step({ role: 'run', distanceM: 2000, paceMinSecPerKm: 280, paceMaxSecPerKm: 290 }),
        ],
      },
    ];

    const execution = sessionExecution(input({ steps }));

    expect(execution?.gaps).toEqual(['pace-targets-uneven']);
    expect(execution?.rows.some((row) => row.metric === 'pace')).toBe(false);
  });

  it('compare l’enveloppe des sous-créneaux cardiaques d’un footing progressif', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 1,
        steps: [
          step({ role: 'run', distanceM: 3000, hrZone: 2, hrPercentMin: 65, hrPercentMax: 71 }),
          step({ role: 'run', distanceM: 3000, hrZone: 2, hrPercentMin: 70, hrPercentMax: 75 }),
          step({ role: 'run', distanceM: 2000, hrZone: 2, hrPercentMin: 74, hrPercentMax: 79 }),
        ],
      },
    ];

    const execution = sessionExecution(input({ steps }));

    // 65 % et 79 % de 190 bpm : l'enveloppe des trois sous-créneaux.
    expect(execution?.rows[0]).toMatchObject({
      metric: 'heart-rate',
      band: { min: 124, max: 150 },
      standing: 'in-band',
    });
  });

  it('compare à la valeur unique de la séance quand aucune étape ne porte de bande', () => {
    const execution = sessionExecution(input({ targetPaceSecPerKm: 338, volumeM: 8_000 }));

    expect(execution?.rows).toEqual([
      {
        metric: 'pace',
        repetition: null,
        band: null,
        target: 338,
        actual: 345,
        delta: 7,
        standing: 'no-band',
      },
      {
        metric: 'distance',
        repetition: null,
        band: null,
        target: 8_000,
        actual: 8_120,
        delta: 120,
        standing: 'no-band',
      },
    ]);
  });

  it('compare la valeur affichée, pas la valeur brute', () => {
    // 250,4 s/km s'affiche « 4:10 » : l'annoncer hors d'une bande qui monte à
    // 4:10 ferait mentir l'écran à sa propre légende.
    const execution = sessionExecution(
      input({
        targetPaceSecPerKm: null,
        steps: [
          {
            repeat: 1,
            steps: [
              step({ role: 'run', distanceM: 8000, paceMinSecPerKm: 240, paceMaxSecPerKm: 250 }),
            ],
          },
        ],
        actual: { ...input().actual, avgPaceSecPerKm: 250.4 },
      }),
    );

    expect(execution?.rows[0]).toMatchObject({ actual: 250, standing: 'in-band', delta: 0 });
  });

  it('prend la durée quand rien n’est prescrit en distance', () => {
    const execution = sessionExecution(input({ durationS: 2_700 }));

    expect(execution?.rows).toEqual([
      {
        metric: 'duration',
        repetition: null,
        band: null,
        target: 2_700,
        actual: 2_800,
        delta: 100,
        standing: 'no-band',
      },
    ]);
  });

  it('préfère les totaux du déroulé aux colonnes de la séance', () => {
    const execution = sessionExecution(
      input({ steps: easySteps(), volumeM: 12_000, durationS: 2_700 }),
    );

    const volume = execution?.rows.find((row) => row.metric === 'distance');
    expect(volume?.target).toBe(8_000);
    expect(execution?.rows.some((row) => row.metric === 'duration')).toBe(false);
  });
});

describe('sessionExecution — cibles absentes', () => {
  it('ne produit aucune ligne pour une cible qui n’a pas été prescrite', () => {
    const execution = sessionExecution(
      input({
        steps: [{ repeat: 1, steps: [step({ role: 'run', distanceM: 8000 })] }],
      }),
    );

    expect(execution?.rows.map((row) => row.metric)).toEqual(['distance']);
    expect(execution?.gaps).toEqual([]);
  });

  it('ne rend rien du tout quand la séance ne prescrit rien', () => {
    expect(sessionExecution(input())).toBeNull();
  });

  it('signale une FC prescrite mais non mesurée', () => {
    const execution = sessionExecution(
      input({ steps: easySteps(), actual: { ...input().actual, avgHrBpm: null } }),
    );

    expect(execution?.gaps).toEqual(['heart-rate-not-measured']);
    expect(execution?.rows.some((row) => row.metric === 'heart-rate')).toBe(false);
  });

  it('signale une FC prescrite qu’aucune référence de profil ne résout', () => {
    const execution = sessionExecution(input({ steps: easySteps(), hrAnchor: null }));

    expect(execution?.gaps).toEqual(['heart-rate-not-anchored']);
  });

  it('signale une zone prescrite sans bornes publiées', () => {
    const steps: PlanSessionSteps = [
      { repeat: 1, steps: [step({ role: 'run', distanceM: 8000, hrZone: 4 })] },
    ];

    expect(sessionExecution(input({ steps }))?.gaps).toEqual(['heart-rate-not-anchored']);
  });

  it('signale une allure prescrite mais non mesurée', () => {
    const execution = sessionExecution(
      input({
        targetPaceSecPerKm: 338,
        actual: { ...input().actual, avgPaceSecPerKm: null },
      }),
    );

    expect(execution?.gaps).toEqual(['pace-not-measured']);
  });
});

describe('sessionExecution — séance à blocs', () => {
  it('localise une répétition par fenêtre disjointe et les rend dans l’ordre du chrono', () => {
    const execution = sessionExecution(
      input({ steps: intervalSteps(), streams: intervalTrace() }),
    );

    expect(execution?.repeats).toEqual({ count: 6, distanceM: 800 });
    expect(
      execution?.rows
        .filter((row) => row.repetition !== null)
        .map((row) => [row.repetition, row.actual, row.standing, row.delta]),
    ).toEqual([
      [1, 250, 'in-band', 0],
      [2, 250, 'in-band', 0],
      [3, 256, 'over', 6],
      [4, 244, 'in-band', 0],
      [5, 288, 'over', 38],
      [6, 250, 'in-band', 0],
    ]);
  });

  it('ne produit aucune allure de séance : la moyenne d’un fractionné ne vise rien', () => {
    const execution = sessionExecution(
      input({ steps: intervalSteps(), streams: intervalTrace() }),
    );

    expect(execution?.rows.filter((row) => row.repetition === null).map((row) => row.metric)).toEqual(
      ['distance'],
    );
  });

  it('résume les répétitions dans la bande', () => {
    const execution = sessionExecution(
      input({ steps: intervalSteps(), streams: intervalTrace() }),
    );

    expect(execution === null ? null : executionSummary(execution)).toEqual({
      scope: 'repetitions',
      total: 6,
      inBand: 4,
    });
  });

  it('refuse de comparer sans flux', () => {
    const execution = sessionExecution(input({ steps: intervalSteps(), streams: null }));

    expect(execution?.gaps).toEqual(['streams-missing']);
    expect(execution?.rows.some((row) => row.repetition !== null)).toBe(false);
  });

  it('refuse quand les blocs ne se placent pas tous dans la trace', () => {
    const short = trace([{ distanceM: 2_000, durationS: 500 }]);
    const execution = sessionExecution(input({ steps: intervalSteps(), streams: short }));

    expect(execution?.gaps).toEqual(['repetitions-not-located']);
  });

  it('refuse des blocs prescrits en durée', () => {
    const steps: PlanSessionSteps = [
      { repeat: 1, steps: [step({ role: 'warmup', distanceM: 1000 })] },
      {
        repeat: 4,
        steps: [
          step({ role: 'run', durationS: 180, paceMinSecPerKm: 240, paceMaxSecPerKm: 250 }),
          step({ role: 'recover', durationS: 90 }),
        ],
      },
    ];

    expect(sessionExecution(input({ steps, streams: intervalTrace() }))?.gaps).toEqual([
      'repetitions-in-duration',
    ]);
  });

  it('refuse des blocs de longueurs différentes', () => {
    const steps: PlanSessionSteps = [
      { repeat: 1, steps: [step({ role: 'warmup', distanceM: 1000 })] },
      {
        repeat: 1,
        steps: [
          step({ role: 'run', distanceM: 2000, paceMinSecPerKm: 240, paceMaxSecPerKm: 250 }),
          step({ role: 'recover', distanceM: 400 }),
          step({ role: 'run', distanceM: 1000, paceMinSecPerKm: 240, paceMaxSecPerKm: 250 }),
        ],
      },
    ];

    expect(sessionExecution(input({ steps, streams: intervalTrace() }))?.gaps).toEqual([
      'repetitions-uneven',
    ]);
  });

  it('refuse une fenêtre que le capteur a trop peu couverte', () => {
    const streams = intervalTrace();
    const distance = [...streams.distance];
    // Le capteur de distance décroche sur la totalité de la deuxième
    // répétition, qui reste la plus rapide de la trace par ses deux bornes.
    for (let index = 640; index < 830; index += 1) distance[index] = null;

    const execution = sessionExecution(
      input({ steps: intervalSteps(), streams: { distance, time: streams.time } }),
    );

    expect(execution?.gaps).toEqual(['repetitions-coverage']);
    expect(execution?.rows.some((row) => row.repetition !== null)).toBe(false);
  });

  it('compare un bloc unique sans le confondre avec la séance entière', () => {
    const steps: PlanSessionSteps = [
      { repeat: 1, steps: [step({ role: 'warmup', distanceM: 1000 })] },
      {
        repeat: 1,
        steps: [
          step({ role: 'run', distanceM: 3000, paceMinSecPerKm: 250, paceMaxSecPerKm: 260 }),
        ],
      },
      { repeat: 1, steps: [step({ role: 'cooldown', distanceM: 1000 })] },
    ];
    const streams = trace([
      { distanceM: 1000, durationS: 333 },
      { distanceM: 3000, durationS: 780 },
      { distanceM: 1000, durationS: 333 },
    ]);

    const execution = sessionExecution(input({ steps, streams }));

    expect(execution?.repeats).toEqual({ count: 1, distanceM: 3000 });
    expect(execution?.rows[0]).toMatchObject({ repetition: 1, actual: 260, standing: 'in-band' });
  });

  it('compare l’allure moyenne quand la séance n’est que de la course', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 1,
        steps: [step({ role: 'run', distanceM: 8000, paceMinSecPerKm: 340, paceMaxSecPerKm: 350 })],
      },
    ];

    const execution = sessionExecution(input({ steps, streams: intervalTrace() }));

    expect(execution?.repeats).toBeNull();
    expect(execution?.rows[0]).toMatchObject({ metric: 'pace', repetition: null, actual: 345 });
  });
});

describe('executionSummary', () => {
  it('compte les cibles à bande d’une séance simple', () => {
    const execution = sessionExecution(
      input({
        steps: [
          {
            repeat: 1,
            steps: [
              step({ role: 'warmup', distanceM: 1000, hrZone: 2 }),
              step({ role: 'run', distanceM: 8000, hrZone: 2 }),
            ],
          },
        ],
        actual: { ...input().actual, avgHrBpm: 158 },
      }),
    );

    expect(execution === null ? null : executionSummary(execution)).toEqual({
      scope: 'targets',
      total: 1,
      inBand: 0,
    });
  });

  it('ne résume rien quand aucune ligne ne porte de bande', () => {
    const execution = sessionExecution(input({ volumeM: 8_000 }));

    expect(execution === null ? null : executionSummary(execution)).toBeNull();
  });
});

describe('locateRepetitions', () => {
  it('rend des fenêtres deux à deux disjointes', () => {
    const { distance, time } = intervalTrace();
    const windows = locateRepetitions(distance, time, 800, 6);

    expect(windows).not.toBeNull();
    if (windows === null) return;

    expect(windows).toHaveLength(6);
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index].fromS).toBeGreaterThanOrEqual(windows[index - 1].toS);
    }
  });

  it('rend null quand la trace ne porte pas autant de blocs', () => {
    const { distance, time } = intervalTrace();

    expect(locateRepetitions(distance, time, 800, 40)).toBeNull();
    expect(locateRepetitions(distance, time, 50_000, 1)).toBeNull();
    expect(locateRepetitions([], [], 800, 1)).toBeNull();
  });

  it('refuse un compte ou une longueur absurdes', () => {
    const { distance, time } = intervalTrace();

    expect(locateRepetitions(distance, time, 800, 0)).toBeNull();
    expect(locateRepetitions(distance, time, 0, 1)).toBeNull();
  });
});

describe('windowCoverage', () => {
  it('rend 1 sur une trace dense', () => {
    const { distance, time } = trace([{ distanceM: 1000, durationS: 250 }]);

    expect(windowCoverage(distance, time, { fromS: 10, toS: 110 })).toBeCloseTo(1, 2);
  });

  it('creuse un trou là où le capteur s’est tu', () => {
    const { distance, time } = trace([{ distanceM: 1000, durationS: 250 }]);
    const holed = distance.map((mark, index) => (index >= 20 && index < 100 ? null : mark));

    expect(windowCoverage(holed, time, { fromS: 10, toS: 110 })).toBeLessThan(0.5);
  });

  it('rend 0 sur une fenêtre vide ou absurde', () => {
    const { distance, time } = trace([{ distanceM: 1000, durationS: 250 }]);

    expect(windowCoverage(distance, time, { fromS: 10, toS: 10 })).toBe(0);
    expect(windowCoverage(distance, time, { fromS: 400, toS: 500 })).toBe(0);
  });
});
