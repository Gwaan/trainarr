import { describe, expect, it } from 'vitest';

import { QUALITY_ZONE_KINDS, FITNESS_TEST_KIND, SESSION_KINDS } from '@/lib/plan-skeleton';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import { judgeSessionMove, type JudgeSessionMoveInput, type MoveSession } from './move-rules';

/**
 * Repères du scénario : le plan couvre quatre semaines de plein août 2026, et
 * « aujourd'hui » est le lundi 3. Toutes les dates des tests s'y rapportent.
 */
const TODAY = '2026-08-03';
const PLAN = { startsOn: '2026-08-03', endsOn: '2026-08-30', longRunDay: 7 } as const;

let nextId = 1;

function session(overrides: Partial<MoveSession> = {}): MoveSession {
  nextId += 1;
  return {
    id: nextId,
    date: '2026-08-05',
    kind: QUALITY_ZONE_KINDS.threshold,
    completed: false,
    volumeM: null,
    steps: null,
    ...overrides,
  };
}

function judge(overrides: Partial<JudgeSessionMoveInput> = {}): ReturnType<typeof judgeSessionMove> {
  return judgeSessionMove({
    session: session(),
    toDate: '2026-08-07',
    today: TODAY,
    plan: PLAN,
    siblings: [],
    ...overrides,
  });
}

/** Un déroulé d'une seule étape courue, en mètres — la forme que `sessionEffortM` compte. */
function effortSteps(distanceM: number): PlanSessionSteps {
  return [
    {
      repeat: 1,
      steps: [
        {
          role: 'run',
          distanceM,
          durationS: null,
          paceMinSecPerKm: null,
          paceMaxSecPerKm: null,
          hrZone: null,
          note: null,
        },
      ],
    },
  ];
}

describe('judgeSessionMove — ce qui est refusé', () => {
  it('refuse une date de destination qui n’existe pas au calendrier', () => {
    const verdict = judge({ toDate: '2026-02-31' });

    expect(verdict).toEqual({
      allowed: false,
      refusal: {
        code: 'invalid-date',
        message: "Date de destination invalide : ce jour n'existe pas au calendrier.",
      },
    });
  });

  it('refuse une séance déjà courue', () => {
    const verdict = judge({ session: session({ completed: true }) });

    expect(verdict).toEqual({
      allowed: false,
      refusal: {
        code: 'already-completed',
        message: 'Cette séance a déjà été courue : elle ne se déplace plus.',
      },
    });
  });

  it('refuse de déplacer une séance dont le jour est passé', () => {
    const verdict = judge({ session: session({ date: '2026-08-02' }) });

    expect(verdict).toEqual({
      allowed: false,
      refusal: {
        code: 'session-in-past',
        message:
          'Cette séance est déjà passée : le calendrier publié ne réécrit jamais le passé.',
      },
    });
  });

  it('refuse un dépôt sur le jour où la séance est déjà posée', () => {
    const verdict = judge({ session: session({ date: '2026-08-07' }), toDate: '2026-08-07' });

    expect(verdict).toEqual({
      allowed: false,
      refusal: { code: 'same-date', message: 'Cette séance est déjà planifiée ce jour-là.' },
    });
  });

  it('refuse une destination passée', () => {
    const verdict = judge({ toDate: '2026-08-02' });

    expect(verdict).toEqual({
      allowed: false,
      refusal: {
        code: 'target-in-past',
        message: "On ne replanifie pas dans le passé : choisis aujourd'hui ou un jour à venir.",
      },
    });
  });

  it("accepte le jour même : aujourd'hui n'est pas le passé", () => {
    const verdict = judge({ session: session({ date: '2026-08-05' }), toDate: TODAY });

    expect(verdict.allowed).toBe(true);
  });

  it('refuse une destination postérieure à la fin du plan', () => {
    const verdict = judge({ toDate: '2026-08-31' });

    expect(verdict).toEqual({
      allowed: false,
      refusal: {
        code: 'outside-plan',
        message:
          'Ton plan court du lundi 3 août 2026 au dimanche 30 août 2026 : cette date en sort.',
      },
    });
  });

  it('refuse une destination antérieure au départ du plan', () => {
    // Un plan qui n'a pas encore commencé : la date visée est à venir, mais elle
    // tombe avant son premier jour. C'est bien la fenêtre du plan qui refuse,
    // pas le passé.
    const verdict = judge({
      session: session({ date: '2026-08-12' }),
      toDate: '2026-08-05',
      plan: { startsOn: '2026-08-10', endsOn: '2026-09-06', longRunDay: 7 },
    });

    expect(verdict).toMatchObject({ allowed: false, refusal: { code: 'outside-plan' } });
  });

  it('accepte les deux bornes du plan, incluses', () => {
    expect(judge({ toDate: PLAN.startsOn }).allowed).toBe(true);
    expect(judge({ toDate: PLAN.endsOn }).allowed).toBe(true);
  });
});

describe('judgeSessionMove — espacement des jours durs', () => {
  it('avertit quand une autre séance dure tombe la veille', () => {
    const verdict = judge({
      toDate: '2026-08-07',
      siblings: [session({ date: '2026-08-06', kind: QUALITY_ZONE_KINDS.interval })],
    });

    expect(verdict).toEqual({
      allowed: true,
      warnings: [
        {
          code: 'hard-days-adjacent',
          message:
            '« VMA » tombe le jeudi 6 août 2026 : le plan ne fait jamais se suivre deux séances dures.',
        },
      ],
    });
  });

  it('avertit aussi quand la séance dure tombe le lendemain, ou le même jour', () => {
    const nextDay = judge({
      toDate: '2026-08-07',
      siblings: [session({ date: '2026-08-08', kind: SESSION_KINDS.longRun })],
    });
    const sameDay = judge({
      toDate: '2026-08-07',
      siblings: [session({ date: '2026-08-07', kind: SESSION_KINDS.longRun })],
    });

    expect(nextDay).toMatchObject({ allowed: true, warnings: [{ code: 'hard-days-adjacent' }] });
    expect(sameDay).toMatchObject({ allowed: true, warnings: [{ code: 'hard-days-adjacent' }] });
  });

  it("n'avertit pas à deux jours d'écart : un jour de repos suffit", () => {
    const verdict = judge({
      toDate: '2026-08-07',
      siblings: [
        session({ date: '2026-08-05', kind: QUALITY_ZONE_KINDS.interval }),
        session({ date: '2026-08-09', kind: SESSION_KINDS.longRun }),
      ],
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });

  it("n'avertit pas quand ni la séance déplacée ni sa voisine ne sont dures", () => {
    const verdict = judge({
      session: session({ kind: SESSION_KINDS.easy }),
      toDate: '2026-08-07',
      siblings: [session({ date: '2026-08-06', kind: QUALITY_ZONE_KINDS.interval })],
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });

  it('compte une séance dure déjà courue comme un jour dur', () => {
    const verdict = judge({
      toDate: '2026-08-07',
      siblings: [
        session({ date: '2026-08-06', kind: QUALITY_ZONE_KINDS.interval, completed: true }),
      ],
    });

    expect(verdict).toMatchObject({ allowed: true, warnings: [{ code: 'hard-days-adjacent' }] });
  });

  it('ignore la séance déplacée quand elle figure aussi dans le voisinage', () => {
    const moved = session({ date: '2026-08-06' });
    const verdict = judge({ session: moved, toDate: '2026-08-07', siblings: [moved] });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });
});

describe('judgeSessionMove — jour de la sortie longue', () => {
  it('avertit quand la sortie longue quitte le jour réglé', () => {
    const verdict = judge({
      session: session({ kind: SESSION_KINDS.longRun }),
      // Samedi, alors que le plan règle la sortie longue au dimanche.
      toDate: '2026-08-08',
    });

    expect(verdict).toEqual({
      allowed: true,
      warnings: [
        {
          code: 'long-run-day',
          message: 'Ta sortie longue quitte le dimanche, le jour que tu as réglé pour elle.',
        },
      ],
    });
  });

  it("n'avertit pas quand elle reste sur son jour", () => {
    const verdict = judge({
      session: session({ kind: SESSION_KINDS.longRun }),
      // Dimanche 9 août.
      toDate: '2026-08-09',
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });

  it('ne dit rien du jour de sortie longue pour une autre séance', () => {
    const verdict = judge({ session: session({ kind: SESSION_KINDS.easy }), toDate: '2026-08-08' });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });
});

describe('judgeSessionMove — plafond de volume d’intensité', () => {
  /** Séance de seuil de 4 km d'effort : le plafond du seuil est 10 % de la semaine. */
  const threshold = () =>
    session({ kind: QUALITY_ZONE_KINDS.threshold, volumeM: 8_000, steps: effortSteps(4_000) });

  it('avertit quand la semaine d’arrivée ne finance pas l’effort de la séance', () => {
    // Semaine du 10 au 16 août : 8 km (la séance déplacée) + 12 km = 20 km,
    // soit un plafond de 2 km au seuil pour 4 km d'effort.
    const verdict = judge({
      session: threshold(),
      toDate: '2026-08-12',
      siblings: [session({ date: '2026-08-14', kind: SESSION_KINDS.easy, volumeM: 12_000 })],
    });

    expect(verdict).toEqual({
      allowed: true,
      warnings: [
        {
          code: 'quality-effort-cap',
          message:
            "La semaine du lundi 10 août 2026 pèse 20,0 km : cette séance y porterait 4,0 km d'effort (Seuil) pour un plafond de 2,0 km.",
        },
      ],
    });
  });

  it("n'avertit pas quand la semaine est assez grosse pour l'absorber", () => {
    // 8 + 42 = 50 km, plafond de 5 km au seuil : les 4 km passent.
    const verdict = judge({
      session: threshold(),
      toDate: '2026-08-12',
      siblings: [session({ date: '2026-08-14', kind: SESSION_KINDS.easy, volumeM: 42_000 })],
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });

  it('ne compte que les séances de la semaine d’arrivée', () => {
    // Les 42 km sont dans la semaine suivante : ils ne financent rien ici.
    const verdict = judge({
      session: threshold(),
      toDate: '2026-08-12',
      siblings: [session({ date: '2026-08-19', kind: SESSION_KINDS.easy, volumeM: 42_000 })],
    });

    expect(verdict).toMatchObject({ allowed: true, warnings: [{ code: 'quality-effort-cap' }] });
  });

  it('se tait quand la semaine n’annonce aucun volume : un plafond sur zéro ne dit rien', () => {
    const verdict = judge({
      session: session({ kind: QUALITY_ZONE_KINDS.threshold, volumeM: null, steps: effortSteps(4_000) }),
      toDate: '2026-08-12',
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });

  it('se tait pour une zone que rien ne plafonne (spécifique allure course)', () => {
    const verdict = judge({
      session: session({
        kind: QUALITY_ZONE_KINDS.marathon,
        volumeM: 8_000,
        steps: effortSteps(8_000),
      }),
      toDate: '2026-08-12',
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });

  it('se tait quand la séance ne porte pas de déroulé : rien à mesurer', () => {
    const verdict = judge({
      session: session({ kind: QUALITY_ZONE_KINDS.threshold, volumeM: 8_000, steps: null }),
      toDate: '2026-08-12',
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });
});

describe('judgeSessionMove — la semaine d’un test ne porte que le test', () => {
  it('avertit quand une séance dure rejoint la semaine d’un test', () => {
    const verdict = judge({
      session: session({ kind: QUALITY_ZONE_KINDS.threshold }),
      toDate: '2026-08-13',
      siblings: [session({ date: '2026-08-11', kind: FITNESS_TEST_KIND })],
    });

    expect(verdict).toEqual({
      allowed: true,
      warnings: [
        {
          code: 'test-week',
          message:
            'La semaine du lundi 10 août 2026 porte un test chronométré : cette semaine-là ne porte que le test comme séance dure.',
        },
      ],
    });
  });

  it('avertit quand c’est le test qui rejoint une semaine déjà dure', () => {
    const verdict = judge({
      session: session({ kind: FITNESS_TEST_KIND }),
      toDate: '2026-08-11',
      siblings: [session({ date: '2026-08-13', kind: QUALITY_ZONE_KINDS.threshold })],
    });

    expect(verdict).toEqual({
      allowed: true,
      warnings: [
        {
          code: 'test-week',
          message:
            "La semaine du lundi 10 août 2026 porte déjà des séances dures : la semaine d'un test ne porte que le test.",
        },
      ],
    });
  });

  it("ne dit rien d'un footing posé dans la semaine d'un test", () => {
    const verdict = judge({
      session: session({ kind: SESSION_KINDS.easy }),
      toDate: '2026-08-13',
      siblings: [
        session({ date: '2026-08-11', kind: FITNESS_TEST_KIND }),
        session({ date: '2026-08-14', kind: QUALITY_ZONE_KINDS.threshold }),
      ],
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });

  it('ne dit rien quand le test est seul à être dur dans sa semaine', () => {
    const verdict = judge({
      session: session({ kind: FITNESS_TEST_KIND }),
      toDate: '2026-08-11',
      siblings: [session({ date: '2026-08-13', kind: SESSION_KINDS.easy })],
    });

    expect(verdict).toEqual({ allowed: true, warnings: [] });
  });
});

describe('judgeSessionMove — plusieurs règles à la fois', () => {
  it('rend tous les avertissements, sans jamais refuser', () => {
    const verdict = judge({
      session: session({ kind: SESSION_KINDS.longRun, volumeM: 15_000 }),
      // Mardi 11 : ni le dimanche réglé, ni espacé du test de la veille, et
      // dans la semaine de ce test.
      toDate: '2026-08-11',
      siblings: [session({ date: '2026-08-10', kind: FITNESS_TEST_KIND })],
    });

    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.warnings.map((warning) => warning.code)).toEqual([
      'hard-days-adjacent',
      'long-run-day',
      'test-week',
    ]);
  });
});
