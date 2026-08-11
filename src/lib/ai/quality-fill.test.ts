import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REFERENCE_DISTANCES, trainingPacesFromRace } from '@/lib/metrics/vdot';
import type { QualitySlot, QualityZone } from '@/lib/plan-skeleton';
import {
  planSessionStepsSchema,
  sessionStepsTotals,
  type PlanSessionSteps,
} from '@/lib/plan-steps/schema';

import type { ChatCompletionJsonOptions, ChatMessage } from './client';
import { AiInvalidOutputError, AiUnavailableError } from './errors';
import {
  applyDerivedMeasures,
  applyImposedPaces,
  sessionStepViolations,
  type PlanSessionOutput,
} from './plan-schema';
import {
  budgetToleranceKm,
  buildQualitySessionMessages,
  fillQualitySlot,
  fillQualitySlots,
  QUALITY_REQUEST_TIMEOUT_MS,
  qualitySessionJsonSchema,
  qualitySessionOutputSchema,
} from './quality-fill';

// Le module est `server-only` : l'import lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Le seul point d'injection du service : l'appel au provider. Le reste — le
 * contrat de sortie, les règles d'étapes, le repli déterministe — est du vrai
 * code, éprouvé tel qu'il tournera.
 */
const { chatCompletionJson } = vi.hoisted(() => ({
  chatCompletionJson:
    vi.fn<(options: ChatCompletionJsonOptions<unknown>) => Promise<unknown>>(),
}));
vi.mock('./client', () => ({ chatCompletionJson }));

const SLOT: QualitySlot = {
  day: 3,
  phase: 'build',
  zone: 'threshold',
  kind: 'Seuil',
  budgetKm: 8,
};

/** La table d'allures d'une coureuse plausible : 45:00 sur 10 km. */
const PACES = trainingPacesFromRace(REFERENCE_DISTANCES['10k'], 45 * 60);

/**
 * Programme les réponses successives du modèle, **telles qu'il les écrit** :
 * chaque charge utile repasse par le schéma Zod de l'appelant, exactement comme
 * le vrai `chatCompletionJson` le fait après avoir lu la réponse HTTP. C'est ce
 * qui permet d'éprouver ce que le contrat accepte, rejette ou écarte.
 */
function respondsWith(...payloads: readonly unknown[]): void {
  for (const payload of payloads) {
    chatCompletionJson.mockImplementationOnce(async (options) => {
      const parsed = options.schema.safeParse(payload);
      if (!parsed.success) {
        throw new AiInvalidOutputError('hors schéma', parsed.error.issues);
      }
      return parsed.data;
    });
  }
}

/** Les messages envoyés lors du n-ième appel (1-based). */
function messagesOfCall(index: number): ChatMessage[] {
  return chatCompletionJson.mock.calls[index - 1][0].messages;
}

/** Un déroulé de 8 km : 1,5 km + 3 × (1,5 km + 300 m) + 1,1 km. */
const VALID_STEPS = [
  { steps: [{ role: 'warmup', distanceM: 1500 }] },
  { repeat: 3, steps: [{ role: 'run', distanceM: 1500 }, { role: 'recover', distanceM: 300 }] },
  { steps: [{ role: 'cooldown', distanceM: 1100 }] },
];

const VALID_OUTPUT = { title: 'Seuil en 3 × 1,5 km', steps: VALID_STEPS };

/** Les mêmes blocs, au double du budget — le déroulé « en durée » d'antan. */
const OVER_BUDGET_OUTPUT = {
  title: 'Seuil en 5 × 2 km',
  steps: [
    { steps: [{ role: 'warmup', distanceM: 2000 }] },
    { repeat: 5, steps: [{ role: 'run', distanceM: 2000 }, { role: 'recover', distanceM: 400 }] },
    { steps: [{ role: 'cooldown', distanceM: 2000 }] },
  ],
};

const totalKm = (steps: PlanSessionSteps): number =>
  (sessionStepsTotals(steps).distanceM ?? 0) / 1000;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  chatCompletionJson.mockReset();
});

describe('qualitySessionJsonSchema', () => {
  /** Toutes les clés de `properties`, à tous les niveaux du schéma. */
  function propertyNames(node: unknown): string[] {
    if (Array.isArray(node)) return node.flatMap(propertyNames);
    if (node === null || typeof node !== 'object') return [];

    const record = node as Record<string, unknown>;
    const own =
      typeof record.properties === 'object' && record.properties !== null
        ? Object.keys(record.properties)
        : [];
    return [...own, ...Object.values(record).flatMap(propertyNames)];
  }

  it("ne propose aucun champ de durée, d'allure ou de zone cardiaque", () => {
    const names = propertyNames(qualitySessionJsonSchema);

    expect(names).toContain('distanceM');
    for (const forbidden of ['durationS', 'paceMinSecPerKm', 'paceMaxSecPerKm', 'hrZone', 'note']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("ne propose ni le jour, ni le kind, ni la distance de la séance — l'appli les impose", () => {
    const names = propertyNames(qualitySessionJsonSchema);

    for (const imposed of ['day', 'kind', 'distanceKm', 'durationMin', 'targetPaceSecPerKm']) {
      expect(names).not.toContain(imposed);
    }
  });

  it('exige une distance sur chaque étape : un déroulé chronométré est inexprimable', () => {
    const steps = (qualitySessionJsonSchema.properties as Record<string, Record<string, unknown>>)
      .steps;
    const block = steps.items as Record<string, Record<string, unknown>>;
    const step = (block.properties.steps as Record<string, unknown>).items as Record<
      string,
      unknown
    >;

    expect(step.required).toEqual(['role', 'distanceM']);
    expect(step.additionalProperties).toBe(false);
  });
});

describe('buildQualitySessionMessages', () => {
  it("ne porte qu'un seul nombre : le budget du créneau", () => {
    const [, user] = buildQualitySessionMessages({ ...SLOT, budgetKm: 6.5 });

    expect(user.content).toContain('6,5 km');
    // Ni le jour, ni la phase chiffrée, ni une allure : tout ce qui traîne comme
    // nombre dans un contexte finit recopié dans le déroulé.
    expect(user.content.match(/\d+([,.]\d+)?/g)).toEqual(['6,5']);
  });

  it('décrit la zone et la phase en mots, sans chiffre', () => {
    const [, user] = buildQualitySessionMessages({
      ...SLOT,
      zone: 'interval',
      kind: 'VMA',
      phase: 'specific',
    });

    expect(user.content).toContain('Séance de VMA');
    expect(user.content).toContain('spécificité');
  });

  it('interdit les allures dans le titre comme dans les étapes', () => {
    const [system] = buildQualitySessionMessages(SLOT);

    expect(system.content).toContain('aucune allure');
    expect(system.content).toContain('ni dans le titre');
  });

  it("porte un exemple JSON dont la somme fait le total annoncé", () => {
    const [system] = buildQualitySessionMessages(SLOT);
    const example = system.content.slice(system.content.indexOf('{"title"'));
    const distances = [...example.matchAll(/"distanceM":(\d+)/g)].map((match) => Number(match[1]));

    // 1500 + 3 × (1500 + 300) + 1100 = 8 000 m, le total annoncé.
    expect(distances[0] + 3 * (distances[1] + distances[2]) + distances[3]).toBe(8000);
    expect(system.content).toContain('total demandé de 8 km');
  });
});

describe('fillQualitySlot — sortie conforme', () => {
  it('remplit le créneau avec le titre et le déroulé du modèle', async () => {
    respondsWith(VALID_OUTPUT);

    const session = await fillQualitySlot(SLOT);

    expect(session.title).toBe('Seuil en 3 × 1,5 km');
    expect(session.distanceKm).toBe(8);
    expect(session.steps).toHaveLength(3);
    expect(session.steps?.[1]).toMatchObject({ repeat: 3 });
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
  });

  it("impose le jour et le kind du créneau, quoi que le modèle en dise", async () => {
    respondsWith({ ...VALID_OUTPUT, day: 1, kind: 'Footing', distanceKm: 42 });

    const session = await fillQualitySlot({ ...SLOT, day: 6, kind: 'VMA', zone: 'interval' });

    expect(session.day).toBe(6);
    expect(session.kind).toBe('VMA');
    expect(session.distanceKm).toBe(8);
  });

  it("ne redemande rien pour un écart que l'appli sait retoucher", async () => {
    // 8,3 km pour 8 km demandés : dans les 5 % (0,4 km). Le modèle a écrit une
    // séance acceptable — c'est l'appli qui fait la monnaie, pas lui.
    respondsWith({
      title: 'Seuil en 3 × 1,6 km',
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        {
          repeat: 3,
          steps: [{ role: 'run', distanceM: 1600 }, { role: 'recover', distanceM: 300 }],
        },
        { steps: [{ role: 'cooldown', distanceM: 1100 }] },
      ],
    });

    const session = await fillQualitySlot(SLOT);

    expect(session.title).toBe('Seuil en 3 × 1,6 km');
    expect(session.distanceKm).toBe(8);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
  });
});

describe('budgetToleranceKm', () => {
  it('vaut 5 % du budget au-dessus du plancher', () => {
    expect(budgetToleranceKm(12)).toBeCloseTo(0.6, 9);
  });

  it('ne descend pas sous 300 m : un modèle compose par blocs entiers', () => {
    expect(budgetToleranceKm(3)).toBe(0.3);
  });
});

describe('fillQualitySlot — reprise', () => {
  it('renvoie ses violations au modèle et garde la seconde sortie', async () => {
    respondsWith(OVER_BUDGET_OUTPUT, VALID_OUTPUT);

    const session = await fillQualitySlot(SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    expect(session.title).toBe('Seuil en 3 × 1,5 km');
    expect(session.distanceKm).toBe(8);

    const reprise = messagesOfCall(2).at(-1);
    expect(reprise?.role).toBe('user');
    expect(reprise?.content).toContain('16,0 km au lieu de 8,0 km');
    expect(reprise?.content).toContain('Réécris la séance entière');
  });

  it("reprend un bloc répété sans récupération", async () => {
    respondsWith(
      {
        title: 'Seuil enchaîné',
        steps: [
          { steps: [{ role: 'warmup', distanceM: 1500 }] },
          { repeat: 4, steps: [{ role: 'run', distanceM: 1350 }] },
          { steps: [{ role: 'cooldown', distanceM: 1100 }] },
        ],
      },
      VALID_OUTPUT,
    );

    const session = await fillQualitySlot(SLOT);

    expect(session.title).toBe('Seuil en 3 × 1,5 km');
    expect(messagesOfCall(2).at(-1)?.content).toContain('pas de récupération');
  });
});

describe('fillQualitySlot — repli déterministe', () => {
  /** Le repli est reconnaissable à son titre : l'appli ne recopie pas le modèle. */
  const FALLBACK_TITLES = ['Séance de seuil', 'Séance de VMA', 'Séance de répétitions'];

  it('écrit la séance lui-même quand toutes les tentatives échouent', async () => {
    respondsWith(OVER_BUDGET_OUTPUT, OVER_BUDGET_OUTPUT);

    const session = await fillQualitySlot(SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    expect(FALLBACK_TITLES).toContain(session.title);
    expect(session.day).toBe(3);
    expect(session.kind).toBe('Seuil');
    expect(session.distanceKm).toBe(8);
    expect(sessionStepViolations(session, 'Séance de qualité')).toEqual([]);
    expect(totalKm(session.steps ?? [])).toBeCloseTo(8, 3);
  });

  it('écrit la séance lui-même quand le coach est injoignable', async () => {
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unreachable'));

    const session = await fillQualitySlot(SLOT);

    // Aucune reprise : une panne ne s'arrange pas en redemandant.
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(session.distanceKm).toBe(8);
    expect(sessionStepViolations(session, 'Séance de qualité')).toEqual([]);
  });

  it('ne laisse remonter aucune exception, quelle qu’elle soit', async () => {
    chatCompletionJson.mockRejectedValue(new Error('boom'));

    await expect(fillQualitySlot(SLOT)).resolves.toMatchObject({ day: 3, kind: 'Seuil' });
  });

  it('replie sur un déroulé valide pour chaque zone', async () => {
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unconfigured'));

    const slots: QualitySlot[] = [
      { day: 2, phase: 'base', zone: 'repetition', kind: 'Répétitions', budgetKm: 5 },
      { day: 4, phase: 'build', zone: 'interval', kind: 'VMA', budgetKm: 7.5 },
      { day: 5, phase: 'specific', zone: 'threshold', kind: 'Seuil', budgetKm: 10 },
      {
        day: 6,
        phase: 'specific',
        zone: 'marathon',
        kind: 'Spécifique allure course',
        budgetKm: 12,
      },
    ];

    const sessions = await fillQualitySlots(slots);

    expect(sessions).toHaveLength(4);
    sessions.forEach((session, index) => {
      expect(session.day).toBe(slots[index].day);
      expect(session.kind).toBe(slots[index].kind);
      expect(session.distanceKm).toBe(slots[index].budgetKm);
      expect(sessionStepViolations(session, 'Séance de qualité')).toEqual([]);
    });
  });
});

describe('fillQualitySlot — ce que le modèle ne peut pas écrire', () => {
  it('écarte les durées et les allures qu’un provider hors grammaire enverrait', async () => {
    respondsWith({
      title: 'Seuil bavard',
      steps: [
        {
          steps: [
            { role: 'warmup', distanceM: 1500, durationS: 900, paceMinSecPerKm: 640 },
          ],
        },
        {
          repeat: 3,
          steps: [
            { role: 'run', distanceM: 1500, paceMinSecPerKm: 640, paceMaxSecPerKm: 640 },
            { role: 'recover', distanceM: 300, hrZone: 2, note: 'trot en tempo' },
          ],
        },
        { steps: [{ role: 'cooldown', distanceM: 1100, durationS: 600 }] },
      ],
    });

    const session = await fillQualitySlot(SLOT);
    const steps = (session.steps ?? []).flatMap((block) => block.steps);

    expect(steps).toHaveLength(4);
    for (const step of steps) {
      expect(step.durationS).toBeNull();
      expect(step.paceMinSecPerKm).toBeNull();
      expect(step.paceMaxSecPerKm).toBeNull();
      expect(step.hrZone).toBeNull();
      // Une note « en tempo » déplacerait le créneau d'allure de l'étape
      // (`STEP_NOTE_ZONES`) : le modèle n'en écrit pas.
      expect(step.note).toBeNull();
    }
    expect(session.distanceKm).toBe(8);
  });

  it('rejette une étape mesurée en durée seule, et se replie', async () => {
    respondsWith(
      {
        title: 'Seuil en minutes',
        steps: [
          { steps: [{ role: 'warmup', durationS: 900 }] },
          { repeat: 3, steps: [{ role: 'run', durationS: 480 }, { role: 'recover', durationS: 120 }] },
          { steps: [{ role: 'cooldown', durationS: 600 }] },
        ],
      },
      { title: 'Encore en minutes', steps: [{ steps: [{ role: 'run', durationS: 480 }] }] },
    );

    const session = await fillQualitySlot(SLOT);

    // La sortie n'a même pas passé le schéma : aucune reprise, repli immédiat.
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(session.distanceKm).toBe(8);
    expect((session.steps ?? []).flatMap((block) => block.steps)[0].distanceM).not.toBeNull();
  });
});

describe('fillQualitySlot — le piège à 98,3 %', () => {
  /** Les semaines telles que le post-traitement les reçoit. */
  const weeksOf = (session: PlanSessionOutput) => [{ sessions: [session] }];

  it("traverse applyImposedPaces sans que la distance de la séance change", async () => {
    respondsWith(VALID_OUTPUT);
    const session = await fillQualitySlot(SLOT);

    const [week] = applyImposedPaces(weeksOf(session), PACES);

    expect(week.sessions[0].distanceKm).toBe(session.distanceKm);
    expect(week.sessions[0].distanceKm).toBe(8);
    // Les allures, elles, sont bien posées par l'appli.
    expect(week.sessions[0].targetPaceSecPerKm).toBeGreaterThan(0);
  });

  it('traverse le régime sans table sans que la distance change non plus', async () => {
    respondsWith(VALID_OUTPUT);
    const session = await fillQualitySlot(SLOT);

    const [week] = applyDerivedMeasures(weeksOf(session), 330);

    expect(week.sessions[0].distanceKm).toBe(8);
  });

  it('vaut aussi pour la séance de repli', async () => {
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unreachable'));
    const session = await fillQualitySlot({ ...SLOT, budgetKm: 9.4 });

    const [imposed] = applyImposedPaces(weeksOf(session), PACES);
    const [derived] = applyDerivedMeasures(weeksOf(session), 330);

    expect(imposed.sessions[0].distanceKm).toBe(9.4);
    expect(derived.sessions[0].distanceKm).toBe(9.4);
  });

  it("vaut pour un déroulé que l'appli a ramené au budget", async () => {
    // 8 250 m, soit un déroulé qui tombait entre deux dixièmes : l'absorption le
    // ramène à 8 000 m pile, donc la distance déclarée et la couverture sont
    // encore la même valeur — c'est ce qui neutralise `imposedDistanceKm`.
    respondsWith({
      title: 'Seuil en 3 × 1,55 km',
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        {
          repeat: 3,
          steps: [{ role: 'run', distanceM: 1550 }, { role: 'recover', distanceM: 300 }],
        },
        { steps: [{ role: 'cooldown', distanceM: 1200 }] },
      ],
    });
    const session = await fillQualitySlot(SLOT);

    const [week] = applyImposedPaces(weeksOf(session), PACES);

    expect(session.distanceKm).toBe(8);
    expect(week.sessions[0].distanceKm).toBe(8);
  });
});

describe('qualitySessionOutputSchema — la grammaire, portée aussi par Zod', () => {
  /**
   * `strict` n'est envoyé qu'à llama.cpp : chez tout autre provider, le JSON
   * Schema n'est qu'une suggestion. Ce que la grammaire impose doit donc se
   * retrouver dans le contrat Zod, seule barrière qui tienne quel que soit le
   * provider — une réponse de LLM est une entrée externe comme une autre.
   */
  it('refuse une séance à un seul bloc', () => {
    const parsed = qualitySessionOutputSchema.safeParse({
      title: 'Seuil en un bloc',
      steps: [{ steps: [{ role: 'run', distanceM: 8000 }] }],
    });

    expect(parsed.success).toBe(false);
  });

  it('refuse un bloc de plus de quatre étapes', () => {
    const parsed = qualitySessionOutputSchema.safeParse({
      title: 'Seuil en escalier',
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        {
          steps: [
            { role: 'run', distanceM: 1000 },
            { role: 'recover', distanceM: 200 },
            { role: 'run', distanceM: 1000 },
            { role: 'recover', distanceM: 200 },
            { role: 'run', distanceM: 1000 },
          ],
        },
        { steps: [{ role: 'cooldown', distanceM: 1100 }] },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('accepte la forme que la grammaire décrit', () => {
    expect(qualitySessionOutputSchema.safeParse(VALID_OUTPUT).success).toBe(true);
  });
});

describe("fillQualitySlot — l'enveloppe, quel que soit le kind", () => {
  /**
   * Le `kind` d'un créneau `marathon` est « Spécifique allure course » : aucun
   * motif de `isIntensitySession` ne l'y reconnaît, donc `sessionStepViolations`
   * ne lui réclame pas son enveloppe. Un créneau de qualité en est un par
   * construction — c'est ici que ça se vérifie.
   */
  const MARATHON_SLOT: QualitySlot = {
    day: 6,
    phase: 'specific',
    zone: 'marathon',
    kind: 'Spécifique allure course',
    budgetKm: 8,
  };

  const BARE_RUN_OUTPUT = {
    title: 'Allure course',
    steps: [
      { steps: [{ role: 'run', distanceM: 2000 }] },
      { steps: [{ role: 'run', distanceM: 4000 }] },
      { steps: [{ role: 'run', distanceM: 2000 }] },
    ],
  };

  it("refuse un créneau marathon sans échauffement ni retour au calme", async () => {
    respondsWith(BARE_RUN_OUTPUT, BARE_RUN_OUTPUT);

    const session = await fillQualitySlot(MARATHON_SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    const reprise = messagesOfCall(2).at(-1)?.content ?? '';
    expect(reprise).toContain('aucun échauffement');
    expect(reprise).toContain('aucun retour au calme');

    // Les deux tentatives ayant échoué, c'est l'appli qui écrit — et elle, elle
    // pose toujours l'enveloppe.
    const roles = new Set((session.steps ?? []).flatMap((block) => block.steps.map((s) => s.role)));
    expect(roles.has('warmup')).toBe(true);
    expect(roles.has('cooldown')).toBe(true);
  });
});

describe("fillQualitySlot — absorption de l'écart au budget", () => {
  /** Les distances du déroulé, bloc par bloc, répétitions non déroulées. */
  const distancesOf = (session: PlanSessionOutput): number[] =>
    (session.steps ?? []).flatMap((block) => block.steps.map((step) => step.distanceM ?? 0));

  it("reporte l'écart sur le retour au calme et retombe au mètre près", async () => {
    // 8,3 km pour 8 km demandés : dans ce que l'appli accepte de retoucher.
    respondsWith({
      title: 'Seuil en 3 × 1,6 km',
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        {
          repeat: 3,
          steps: [{ role: 'run', distanceM: 1600 }, { role: 'recover', distanceM: 300 }],
        },
        { steps: [{ role: 'cooldown', distanceM: 1100 }] },
      ],
    });

    const session = await fillQualitySlot(SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    // La structure du modèle est gardée telle quelle…
    expect(session.title).toBe('Seuil en 3 × 1,6 km');
    expect(distancesOf(session).slice(0, 3)).toEqual([1500, 1600, 300]);
    // …et le seul retour au calme paie les 300 m de trop.
    expect(distancesOf(session).at(-1)).toBe(800);
    expect(totalKm(session.steps ?? [])).toBe(8);
    expect(session.distanceKm).toBe(8);
  });

  it("se replie quand l'écart ne tient pas dans le retour au calme", async () => {
    // 8,35 km : l'écart est dans ce que l'appli retoucherait, mais le reporter
    // annulerait le retour au calme (250 − 350 = −100 m).
    respondsWith({
      title: 'Seuil en 3 × 2 km',
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        {
          repeat: 3,
          steps: [{ role: 'run', distanceM: 2000 }, { role: 'recover', distanceM: 200 }],
        },
        { steps: [{ role: 'cooldown', distanceM: 250 }] },
      ],
    });

    const session = await fillQualitySlot(SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(session.title).toBe('Séance de seuil');
    expect(totalKm(session.steps ?? [])).toBeCloseTo(8, 3);
  });

  it('ne retouche pas un retour au calme pris dans un bloc répété', async () => {
    // 7,8 km, à retoucher de +200 m — mais le seul `cooldown` est répété deux
    // fois : lui ajouter l'écart l'ajouterait deux fois.
    respondsWith({
      title: 'Seuil en deux fois',
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        { steps: [{ role: 'run', distanceM: 1500 }] },
        {
          repeat: 2,
          steps: [
            { role: 'run', distanceM: 1200 },
            { role: 'recover', distanceM: 300 },
            { role: 'cooldown', distanceM: 900 },
          ],
        },
      ],
    });

    const session = await fillQualitySlot(SLOT);

    expect(session.title).toBe('Séance de seuil');
    expect(totalKm(session.steps ?? [])).toBeCloseTo(8, 3);
  });

  it('ne rend jamais une séance sous la borne basse du contrat', async () => {
    // 200 m rendus sur un créneau de 0,5 km : l'ancienne tolérance (plancher de
    // 300 m) l'acceptait tel quel, sous `PLAN_OUTPUT_BOUNDS.distanceKm.min`.
    respondsWith({
      title: 'Mini-séance',
      steps: [
        { steps: [{ role: 'warmup', distanceM: 50 }] },
        { steps: [{ role: 'run', distanceM: 100 }] },
        { steps: [{ role: 'cooldown', distanceM: 50 }] },
      ],
    });

    const session = await fillQualitySlot({ ...SLOT, budgetKm: 0.5 });

    expect(session.distanceKm).toBe(0.5);
    expect(totalKm(session.steps ?? [])).toBeCloseTo(0.5, 3);
  });
});

describe('fillQualitySlot — balayage : la couverture vaut toujours le budget', () => {
  /**
   * L'invariant que l'absorption installe, et le seul qui compte pour le plan :
   * **quoi que rende le modèle, la séance écrite couvre le budget de son
   * créneau**. Les mesures consignées sur `BUDGET_TOLERANCE_SHARE` disent
   * pourquoi — un plan reste à zéro violation quand chaque créneau tombe pile,
   * et en compte des milliers dès +50 m.
   *
   * Le balayage couvre les deux issues sans les distinguer : un écart que
   * l'appli retouche et un écart qui la fait se replier doivent rendre la même
   * couverture, au millimètre.
   */
  const BUDGETS_KM = Array.from({ length: 40 }, (_, index) => (index + 1) / 2);

  /** L'écart du modèle, en part du budget : de part et d'autre de la retouche admise. */
  const OFFSET_SHARES = [-0.3, -0.06, -0.05, -0.01, 0, 0.01, 0.05, 0.06, 0.3];

  /** Un déroulé plausible de budget `B` : 25 % + 3 × (10 % + 5 %) + 30 %, plus l'écart. */
  function outputFor(budgetKm: number, offsetShare: number): unknown {
    const budgetM = Math.round(budgetKm * 1_000);
    const round = (share: number): number => Math.round(budgetM * share);

    return {
      title: 'Séance balayée',
      steps: [
        { steps: [{ role: 'warmup', distanceM: round(0.25) }] },
        {
          repeat: 3,
          steps: [
            { role: 'run', distanceM: round(0.1) },
            { role: 'recover', distanceM: round(0.05) },
          ],
        },
        { steps: [{ role: 'cooldown', distanceM: round(0.3) + round(offsetShare) }] },
      ],
    };
  }

  it('couvre le budget au mètre près, écart retouché ou repli', async () => {
    const failures: string[] = [];
    const issues = { kept: 0, fallback: 0 };

    for (const budgetKm of BUDGETS_KM) {
      for (const offsetShare of OFFSET_SHARES) {
        chatCompletionJson.mockReset();
        chatCompletionJson.mockImplementation(async (options) => {
          const parsed = options.schema.safeParse(outputFor(budgetKm, offsetShare));
          if (!parsed.success) throw new AiInvalidOutputError('hors schéma', parsed.error.issues);
          return parsed.data;
        });

        const slot: QualitySlot = { ...SLOT, budgetKm };
        const session = await fillQualitySlot(slot);
        const covered = totalKm(session.steps ?? []);
        if (session.title === 'Séance balayée') issues.kept += 1;
        else issues.fallback += 1;

        if (Math.abs(covered - budgetKm) > 0.001) {
          failures.push(`${budgetKm} km ${offsetShare} → couverture ${covered} km`);
        }
        if (session.distanceKm !== budgetKm) {
          failures.push(`${budgetKm} km ${offsetShare} → déclare ${session.distanceKm} km`);
        }
        if (sessionStepViolations(session, 'Séance de qualité').length > 0) {
          failures.push(`${budgetKm} km ${offsetShare} → déroulé fautif`);
        }
      }
    }

    expect(failures).toEqual([]);
    // Le balayage prouverait n'importe quoi s'il ne passait que par une issue :
    // les deux existent vraiment dans la matrice.
    expect(issues.kept).toBeGreaterThan(0);
    expect(issues.fallback).toBeGreaterThan(0);
  });
});

describe('fillQualitySlot — le repli ne lève jamais', () => {
  it("rend une séance valide même sur une zone que le repli ne connaît pas", async () => {
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unreachable'));

    // Une zone hors contrat ne peut entrer que par un `as` — c'est exactement ce
    // que ce test simule : `qualitySessionTemplate` lève un `TypeError` dessus,
    // et `fillQualitySlot` promet de ne jamais lever.
    const session = await fillQualitySlot({ ...SLOT, zone: 'sprint' as QualityZone });

    expect(planSessionStepsSchema.safeParse(session.steps).success).toBe(true);
    expect(sessionStepViolations(session, 'Séance de qualité')).toEqual([]);
    expect(session.distanceKm).toBe(8);
  });
});

describe('fillQualitySlot — délai de garde', () => {
  it("borne l'attente d'un créneau bien en deçà du délai global", async () => {
    respondsWith(VALID_OUTPUT);

    await fillQualitySlot(SLOT);

    expect(chatCompletionJson.mock.calls[0][0].timeoutMs).toBe(QUALITY_REQUEST_TIMEOUT_MS);
    // Les 5 minutes du délai global (`AI_REQUEST_TIMEOUT_MS`) sont taillées pour
    // un plan entier ; une séance de ~250 tokens n'a rien à y faire.
    expect(QUALITY_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('fillQualitySlots', () => {
  it('remplit les créneaux un par un, dans l’ordre', async () => {
    respondsWith(VALID_OUTPUT, { ...VALID_OUTPUT, title: 'VMA en 8 × 400 m' });

    const sessions = await fillQualitySlots([SLOT, { ...SLOT, day: 6, kind: 'VMA' }]);

    expect(sessions.map((session) => session.day)).toEqual([3, 6]);
    expect(sessions.map((session) => session.title)).toEqual([
      'Seuil en 3 × 1,5 km',
      'VMA en 8 × 400 m',
    ]);
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
  });

  it("ne demande rien quand il n'y a pas de créneau", async () => {
    await expect(fillQualitySlots([])).resolves.toEqual([]);
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });
});
