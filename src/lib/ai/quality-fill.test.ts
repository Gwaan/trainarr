import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanLevel } from '@/data/db/schema';
import { REFERENCE_DISTANCES, trainingPacesFromRace } from '@/lib/metrics/vdot';
import {
  buildPlanSkeleton,
  type PlanIntent,
  type QualitySlot,
  type QualityZone,
} from '@/lib/plan-skeleton';
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
  weeklyVolumeTargets,
  type PlanRaceGoal,
  type PlanSessionOutput,
} from './plan-schema';
import {
  budgetToleranceKm,
  buildQualitySessionMessages,
  deterministicQualitySession,
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

/**
 * La part du volume hebdomadaire qu'un créneau prend, telle que la décomposition
 * la pose par défaut (`SESSION_BUDGET_SHARES.quality`).
 *
 * Elle sert ici à apparier un budget de créneau à une semaine **plausible** : le
 * plafond de volume d'effort se calcule sur la semaine, et un créneau de 8 km
 * greffé sur une semaine de 12 km n'existe pas — le tester reviendrait à juger
 * le plafond sur une configuration que le squelette ne produit jamais.
 */
const QUALITY_SHARE = 0.16;

const SLOT: QualitySlot = {
  day: 3,
  phase: 'build',
  level: 'intermediate',
  zone: 'threshold',
  kind: 'Seuil',
  budgetKm: 8,
  // 8 km de créneau, c'est une semaine de 50 km — et un plafond de seuil à 5 km
  // (10 %). Le déroulé de référence en porte 4,5 : sous le plafond, mais pas
  // loin, ce qui est exactement ce qu'un créneau bien dimensionné doit être.
  weeklyTargetKm: 8 / QUALITY_SHARE,
};

/** Les trois niveaux du contrat : le prompt doit en dire quelque chose de différent. */
const LEVELS: PlanLevel[] = ['beginner', 'intermediate', 'advanced'];

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

const VALID_OUTPUT = { steps: VALID_STEPS };

/**
 * Ce qui distingue une séance écrite par **l'appli** de celle du modèle.
 *
 * Ce n'est plus le titre : les deux chemins le tirent du même générateur
 * (`plan-skeleton/quality-title`), et c'est précisément ce qu'on voulait. Ce
 * sont les **notes** — le modèle n'a pas le droit d'en écrire (elles sont
 * effacées à l'entrée), le déroulé déterministe en pose une sur chaque étape.
 */
const writtenByApp = (session: PlanSessionOutput): boolean =>
  (session.steps ?? []).every((block) => block.steps.every((step) => step.note !== null));

/** Les mêmes blocs, au double du budget — le déroulé « en durée » d'antan. */
const OVER_BUDGET_OUTPUT = {
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

  /*
   * Le niveau de l'athlète décide du **contenu** de la séance, et il faut le
   * dire au modèle.
   *
   * Régression mesurée après la bascule sur squelette, où cette règle vivait
   * dans le prompt du plan entier et a disparu avec lui : sur un
   * semi en 1 h 45 à 4 séances, une **débutante** recevait 9 séances de seuil à
   * la structure exacte d'une confirmée, et `advanced` produisait un plan
   * strictement identique à `intermediate`. Seul le *nombre* de créneaux
   * distinguait encore les niveaux.
   */
  it('prescrit une forme d’effort par niveau, sans jamais chiffrer', () => {
    const lineFor = (level: PlanLevel): string =>
      buildQualitySessionMessages({ ...SLOT, level })[1].content;

    expect(lineFor('beginner')).toContain('efforts nettement plus courts');
    expect(lineFor('beginner')).toContain('récupération généreuse');
    expect(lineFor('advanced')).toContain('efforts plus longs');
    expect(lineFor('advanced')).toContain('récupération serrée');
    // Trois demandes réellement différentes, et non trois habillages du même
    // texte : c'est ce que le défaut mesuré rendait impossible.
    expect(new Set(LEVELS.map(lineFor)).size).toBe(LEVELS.length);
    // Et toujours un seul nombre dans tout le message : le budget.
    for (const level of LEVELS) {
      expect(lineFor(level).match(/\d+([,.]\d+)?/g), level).toEqual(['8,0']);
    }
  });

  it('interdit les allures et le titre : le modèle n’écrit que des étapes', () => {
    const [system] = buildQualitySessionMessages(SLOT);

    expect(system.content).toContain('aucune allure');
    expect(system.content).toContain('aucun titre');
    // Et l'exemple à recopier n'en porte pas non plus : une clé hors grammaire
    // ferait tomber le créneau au repli.
    expect(system.content).not.toContain('"title"');
  });

  it("porte un exemple JSON dont la somme fait le total annoncé", () => {
    const [system] = buildQualitySessionMessages(SLOT);
    const example = system.content.slice(system.content.indexOf('{"steps"'));
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

  /**
   * Le défaut de production, de bout en bout : « Seuil en 3 × 1,5 km +
   * 1 × 1,0 km » sur un créneau de 5 km dont le déroulé ne portait que **deux**
   * efforts. Le modèle n'écrit plus le titre, donc il ne peut plus le
   * contredire — et un provider qui en enverrait un quand même le verrait
   * écarté comme le reste de ce qu'il n'a pas le droit d'écrire.
   */
  it('écrit un titre qui décrit le déroulé, même si le modèle en dicte un autre', async () => {
    respondsWith({
      title: 'Seuil en 3 × 1,5 km + 1 × 1,0 km',
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1200 }] },
        {
          steps: [
            { role: 'run', distanceM: 1500 },
            { role: 'recover', distanceM: 300 },
            { role: 'run', distanceM: 1000 },
          ],
        },
        { steps: [{ role: 'cooldown', distanceM: 1000 }] },
      ],
    });

    const session = await fillQualitySlot({ ...SLOT, budgetKm: 5 });

    expect(session.title).toBe('Seuil en 1,5 km + 1 km');
    expect(session.distanceKm).toBe(5);
  });

  it("impose le jour et le kind du créneau, quoi que le modèle en dise", async () => {
    // Un déroulé de VMA, pas le seuil de référence : la séance est jugée dans la
    // zone du créneau, et 3 × 1,5 km n'est pas une séance de VMA — son volume
    // d'effort dépasserait ce qu'une semaine de 50 km autorise à cette intensité.
    respondsWith({
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        {
          repeat: 5,
          steps: [{ role: 'run', distanceM: 700 }, { role: 'recover', distanceM: 400 }],
        },
        { steps: [{ role: 'cooldown', distanceM: 1000 }] },
      ],
      day: 1,
      kind: 'Footing',
      distanceKm: 42,
    });

    const session = await fillQualitySlot({ ...SLOT, day: 6, kind: 'VMA', zone: 'interval' });

    expect(session.day).toBe(6);
    expect(session.kind).toBe('VMA');
    expect(session.distanceKm).toBe(8);
  });

  it("ne redemande rien pour un écart que l'appli sait retoucher", async () => {
    // 8,3 km pour 8 km demandés : dans les 5 % (0,4 km). Le modèle a écrit une
    // séance acceptable — c'est l'appli qui fait la monnaie, pas lui.
    respondsWith({
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
  it('écrit la séance lui-même quand toutes les tentatives échouent', async () => {
    respondsWith(OVER_BUDGET_OUTPUT, OVER_BUDGET_OUTPUT);

    const session = await fillQualitySlot(SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    expect(writtenByApp(session)).toBe(true);
    // Le titre, lui, se lit comme celui d'une séance du modèle : c'est le même
    // générateur, et il décrit le déroulé que l'appli vient d'écrire.
    expect(session.title).toMatch(/^Seuil en /);
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
      {
        day: 2,
        phase: 'base',
        level: 'beginner',
        zone: 'repetition',
        kind: 'Répétitions',
        budgetKm: 5,
        weeklyTargetKm: 5 / QUALITY_SHARE,
      },
      {
        day: 4,
        phase: 'build',
        level: 'intermediate',
        zone: 'interval',
        kind: 'VMA',
        budgetKm: 7.5,
        weeklyTargetKm: 7.5 / QUALITY_SHARE,
      },
      {
        day: 5,
        phase: 'specific',
        level: 'advanced',
        zone: 'threshold',
        kind: 'Seuil',
        budgetKm: 10,
        weeklyTargetKm: 10 / QUALITY_SHARE,
      },
      {
        day: 6,
        phase: 'specific',
        level: 'intermediate',
        zone: 'marathon',
        kind: 'Spécifique allure course',
        budgetKm: 12,
        weeklyTargetKm: 12 / QUALITY_SHARE,
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
        steps: [
          { steps: [{ role: 'warmup', durationS: 900 }] },
          { repeat: 3, steps: [{ role: 'run', durationS: 480 }, { role: 'recover', durationS: 120 }] },
          { steps: [{ role: 'cooldown', durationS: 600 }] },
        ],
      },
      { steps: [{ steps: [{ role: 'run', durationS: 480 }] }] },
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
      steps: [{ steps: [{ role: 'run', distanceM: 8000 }] }],
    });

    expect(parsed.success).toBe(false);
  });

  it('refuse un bloc de plus de quatre étapes', () => {
    const parsed = qualitySessionOutputSchema.safeParse({
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
    level: 'intermediate',
    zone: 'marathon',
    kind: 'Spécifique allure course',
    budgetKm: 8,
    weeklyTargetKm: 8 / QUALITY_SHARE,
  };

  const BARE_RUN_OUTPUT = {
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

describe('fillQualitySlot — le plafond de volume d’effort', () => {
  /*
   * Le trou que ces tests ferment : jusqu'ici, **rien** ne bornait ce qu'une
   * séance fait courir à l'allure dure. La structure était vérifiée, le budget
   * total aussi, les allures aussi — mais une séance de seuil de 8 km pouvait en
   * porter 6 d'effort, soit 12 % d'une semaine de 50 km quand la référence en
   * plafonne 10. C'est la seule dimension de la séance dont l'excès mène au
   * surentraînement, et c'était la seule que personne ne regardait.
   *
   * Le créneau de référence ({@link SLOT}) est un seuil de 8 km sur une semaine
   * de 50 : le plafond vaut 5,0 km.
   */

  /** 1 km + 4 × (1,5 km + 100 m) + 600 m = 8 km pile, dont **6 km au seuil**. */
  const OVER_CAP_OUTPUT = {
    steps: [
      { steps: [{ role: 'warmup', distanceM: 1000 }] },
      { repeat: 4, steps: [{ role: 'run', distanceM: 1500 }, { role: 'recover', distanceM: 100 }] },
      { steps: [{ role: 'cooldown', distanceM: 600 }] },
    ],
  };

  it('refuse une séance au-dessus du plafond, budget pourtant tenu', async () => {
    respondsWith(OVER_CAP_OUTPUT, OVER_CAP_OUTPUT);

    const session = await fillQualitySlot(SLOT);

    // 1 000 + 4 × (1 500 + 100) + 600 = 8 000 m : le budget est tenu au mètre
    // près, et la structure est irréprochable. Sans le plafond, cette séance
    // passait — c'est exactement le trou que la règle ferme.
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    expect(writtenByApp(session)).toBe(true);
  });

  it('dit au modèle combien il a écrit, combien il pouvait, et quoi réduire', async () => {
    respondsWith(OVER_CAP_OUTPUT, VALID_OUTPUT);

    const session = await fillQualitySlot(SLOT);

    const reprise = messagesOfCall(2).at(-1)?.content ?? '';
    expect(reprise).toContain("6,0 km à l'allure seuil");
    expect(reprise).toContain('le maximum est 5,0 km pour cette semaine');
    expect(reprise).toContain('réduis le nombre ou la longueur des efforts');
    // Et la séance corrigée est gardée : 3 × 1,5 km, soit 4,5 km au seuil.
    expect(writtenByApp(session)).toBe(false);
  });

  it('accepte une séance pile au plafond', async () => {
    // 1,5 km + 4 × (1,25 km + 100 m) + 1,1 km = 8 km, dont 5,0 km au seuil.
    respondsWith({
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        {
          repeat: 4,
          steps: [{ role: 'run', distanceM: 1250 }, { role: 'recover', distanceM: 100 }],
        },
        { steps: [{ role: 'cooldown', distanceM: 1100 }] },
      ],
    });

    const session = await fillQualitySlot(SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(writtenByApp(session)).toBe(false);
  });

  /*
   * L'enveloppe et les récupérations ne sont pas de l'effort : une séance qui
   * les gonfle reste sous le plafond, même si elle est longue. C'est ce qui
   * distingue « volume d'effort » de « volume ».
   */
  it('ne compte ni l’échauffement, ni les récupérations, ni le retour au calme', async () => {
    // 3 km + 3 × (1 km + 500 m) + 500 m = 8 km, dont **3 km** au seuil : le
    // total est le même que celui de la séance refusée ci-dessus.
    respondsWith({
      steps: [
        { steps: [{ role: 'warmup', distanceM: 3000 }] },
        {
          repeat: 3,
          steps: [{ role: 'run', distanceM: 1000 }, { role: 'recover', distanceM: 500 }],
        },
        { steps: [{ role: 'cooldown', distanceM: 500 }] },
      ],
    });

    const session = await fillQualitySlot(SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(writtenByApp(session)).toBe(false);
  });

  /*
   * La zone `marathon` n'a pas de plafond publié en part du volume hebdomadaire
   * (cf. `plan-skeleton/quality-load.ts`), et on n'en invente pas : la même
   * séance, en spécifique allure course, passe.
   */
  it('ne plafonne pas la zone spécifique allure course', async () => {
    respondsWith(OVER_CAP_OUTPUT);

    const session = await fillQualitySlot({
      ...SLOT,
      zone: 'marathon',
      kind: 'Spécifique allure course',
    });

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(writtenByApp(session)).toBe(false);
  });

  /*
   * Le plafond ne peut pas rendre un créneau infaisable, et c'est structurel :
   * la dernière issue de `fillQualitySlot` est le déroulé déterministe, qui
   * n'est pas soumis à cette validation — il respecte le plafond de son côté
   * (balayage dans `quality-template.test.ts`). Une semaine si maigre que rien
   * ne tiendrait sous le plafond rend donc une séance quand même.
   */
  it('rend toujours une séance, même sur un plafond que rien ne peut tenir', async () => {
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unreachable'));

    const session = await fillQualitySlot({
      ...SLOT,
      zone: 'repetition',
      kind: 'Répétitions',
      budgetKm: 3,
      // Un plafond de 150 m : plus petit que la moindre répétition de la zone.
      weeklyTargetKm: 3,
    });

    expect(session.distanceKm).toBe(3);
    expect(sessionStepViolations(session, 'Séance de qualité')).toEqual([]);
    expect(totalKm(session.steps ?? [])).toBeCloseTo(3, 3);
  });
});

describe("fillQualitySlot — absorption de l'écart au budget", () => {
  /** Les distances du déroulé, bloc par bloc, répétitions non déroulées. */
  const distancesOf = (session: PlanSessionOutput): number[] =>
    (session.steps ?? []).flatMap((block) => block.steps.map((step) => step.distanceM ?? 0));

  it("reporte l'écart sur le retour au calme et retombe au mètre près", async () => {
    // 8,3 km pour 8 km demandés : dans ce que l'appli accepte de retoucher.
    respondsWith({
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
    // annulerait le retour au calme (250 − 350 = −100 m). L'échauffement porte
    // les kilomètres en trop plutôt que les efforts : 4,5 km au seuil restent
    // sous le plafond de la semaine, et c'est bien l'absorption qu'on éprouve
    // ici, pas le plafond.
    respondsWith({
      steps: [
        { steps: [{ role: 'warmup', distanceM: 3000 }] },
        {
          repeat: 3,
          steps: [{ role: 'run', distanceM: 1500 }, { role: 'recover', distanceM: 200 }],
        },
        { steps: [{ role: 'cooldown', distanceM: 250 }] },
      ],
    });

    const session = await fillQualitySlot(SLOT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(writtenByApp(session)).toBe(true);
    expect(totalKm(session.steps ?? [])).toBeCloseTo(8, 3);
  });

  it('ne retouche pas un retour au calme pris dans un bloc répété', async () => {
    // 7,8 km, à retoucher de +200 m — mais le seul `cooldown` est répété deux
    // fois : lui ajouter l'écart l'ajouterait deux fois.
    respondsWith({
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

    expect(writtenByApp(session)).toBe(true);
    expect(totalKm(session.steps ?? [])).toBeCloseTo(8, 3);
  });

  it('ne rend jamais une séance sous la borne basse du contrat', async () => {
    // 200 m rendus sur un créneau de 0,5 km : l'ancienne tolérance (plancher de
    // 300 m) l'acceptait tel quel, sous `PLAN_OUTPUT_BOUNDS.distanceKm.min`.
    respondsWith({
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

        // La semaine suit le budget : c'est le seul appariement que le squelette
        // produise, et le plafond de volume d'effort se calcule dessus.
        const slot: QualitySlot = {
          ...SLOT,
          budgetKm,
          weeklyTargetKm: budgetKm / QUALITY_SHARE,
        };
        const session = await fillQualitySlot(slot);
        const covered = totalKm(session.steps ?? []);
        if (writtenByApp(session)) issues.fallback += 1;
        else issues.kept += 1;

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
    respondsWith(VALID_OUTPUT, {
      steps: [
        { steps: [{ role: 'warmup', distanceM: 1500 }] },
        { repeat: 4, steps: [{ role: 'run', distanceM: 1000 }, { role: 'recover', distanceM: 400 }] },
        { steps: [{ role: 'cooldown', distanceM: 900 }] },
      ],
    });

    const sessions = await fillQualitySlots([SLOT, { ...SLOT, day: 6, kind: 'VMA' }]);

    expect(sessions.map((session) => session.day)).toEqual([3, 6]);
    // Chaque titre décrit **son** déroulé, et rien d'autre.
    expect(sessions.map((session) => session.title)).toEqual([
      'Seuil en 3 × 1,5 km',
      'Seuil en 4 × 1 km',
    ]);
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
  });

  it("ne demande rien quand il n'y a pas de créneau", async () => {
    await expect(fillQualitySlots([])).resolves.toEqual([]);
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });
});

/*
 * ------------------------------------------------------------------------
 * Le gel : « Bloc à l'allure de l'objectif » n'existe que sous une course.
 * ------------------------------------------------------------------------
 *
 * C'est le défaut d'origine du chantier des intentions, mesuré en production :
 * huit séances à l'allure d'une course qui n'existait pas. La grille de qualité
 * le ferme en amont — seule `race` regarde la distance d'objectif
 * (`plan-skeleton/quality.ts`) —, mais le titre, lui, vit **ici**, et c'est lui
 * que l'athlète lit sur sa timeline. Le geler des deux côtés à la fois demande
 * de partir de vrais squelettes plutôt que de créneaux fabriqués à la main : un
 * créneau écrit à la main peut porter n'importe quelle zone, un squelette non.
 *
 * Le balayage passe **même une distance d'objectif** aux intentions sans
 * échéance — ce que le service ne fait pas (il ne la lit que sous `race`), mais
 * c'est le seul chemin par lequel le défaut reviendrait, et il doit rester
 * fermé au niveau de la grille.
 */
describe('l’allure d’objectif ne s’écrit que sous une intention datée', () => {
  const ATHLETE = { recentWeeklyKm: 30, weeklyTimeMinutes: 300, easyPaceSecPerKm: 420 };

  function skeletonFor(
    intent: PlanIntent,
    options: { weeks: number; sessionsPerWeek: number; goalDistanceKm: number | null },
  ) {
    const race: PlanRaceGoal | null = intent === 'race' ? { isMarathon: false } : null;
    return buildPlanSkeleton({
      intent,
      weeks: options.weeks,
      firstWeekFromDay: 1,
      sessionsPerWeek: options.sessionsPerWeek,
      longRunDay: 7,
      level: 'intermediate',
      race,
      raceDay: race === null ? null : 7,
      goalDistanceKm: options.goalDistanceKm,
      targets: weeklyVolumeTargets({
        weeks: options.weeks,
        firstWeekFromDay: 1,
        recentWeeklyKm: ATHLETE.recentWeeklyKm,
        weeklyTimeMinutes: ATHLETE.weeklyTimeMinutes,
        easyPaceSecPerKm: ATHLETE.easyPaceSecPerKm,
        race,
        level: 'intermediate',
      }),
    });
  }

  it('n’ouvre jamais la zone marathon hors course, donc jamais son titre', () => {
    let checked = 0;

    for (const intent of ['faster', 'weight_loss', 'return'] as const) {
      for (const sessionsPerWeek of [3, 4, 5, 6]) {
        for (const weeks of [6, 12, 16]) {
          for (const goalDistanceKm of [null, 10, 21.0975, 42.195]) {
            for (const week of skeletonFor(intent, { weeks, sessionsPerWeek, goalDistanceKm })) {
              for (const slot of week.qualitySlots) {
                checked += 1;
                const where = `${intent}, ${sessionsPerWeek} séances, semaine ${week.weekNumber}`;
                expect(slot.zone, where).not.toBe('marathon');
                // Le titre est désormais écrit depuis le déroulé : ce qui se
                // gèle est le **mot** que seule la zone marathon fait sortir.
                expect(
                  deterministicQualitySession(slot).title.toLowerCase(),
                  where,
                ).not.toContain('objectif');
              }
            }
          }
        }
      }
    }

    // Sans créneau balayé, le test ne prouverait rien.
    expect(checked).toBeGreaterThan(0);
  });

  it('l’écrit bien sous une course, sans quoi ce gel ne mesurerait rien', () => {
    const titles = skeletonFor('race', {
      weeks: 16,
      sessionsPerWeek: 4,
      goalDistanceKm: 21.0975,
    }).flatMap((week) => week.qualitySlots.map((slot) => deterministicQualitySession(slot).title));

    expect(titles.some((title) => title.toLowerCase().includes('objectif'))).toBe(true);
  });
});
