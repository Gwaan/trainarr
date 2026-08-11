/**
 * Contrat de sortie du coach pour un plan d'entraînement : schéma Zod, JSON
 * Schema, mapping vers le DAL et règles métier.
 *
 * Module **pur** — ni base, ni réseau, ni `server-only` : c'est ce qui le rend
 * testable exhaustivement, et c'est là que vit tout ce qui peut mal tourner
 * entre le modèle et la table `planned_sessions`.
 *
 * ## Trois barrières, et ce que chacune garantit
 *
 * 1. **La grammaire** (`planJsonSchema`, converti en GBNF par llama.cpp) : le
 *    modèle ne *peut pas* écrire un token hors schéma. Elle garantit la forme.
 * 2. **Zod** (`planOutputSchema`) : re-valide côté application, parce que rien
 *    ne dit qu'un provider tiers honore `response_format`.
 * 3. **{@link validatePlanBusinessRules}** : la forme ne dit rien du *sens*. Un
 *    JSON parfaitement valide peut placer deux séances le même jour, oublier la
 *    sortie longue, ou compter 11 semaines quand on en demandait 12. Ces
 *    violations-là se corrigent en le disant au modèle, pas en le contraignant.
 *
 * ## La semaine est implicite
 *
 * Aucun numéro de semaine dans la sortie : l'index du tableau `weeks` fait foi.
 * Demander à un petit modèle de compter jusqu'à 12 sans se tromper est un pari
 * perdu ; ne pas le lui demander coûte zéro.
 */

import { z } from 'zod';

import type { NewPlanSessionInput } from '@/data/plans';
import { shiftCivilDate } from '@/lib/dates/civil';

import { formatIsoDay } from './format';

/**
 * Bornes de la sortie du modèle.
 *
 * Source unique du schéma Zod **et** du JSON Schema : les deux partent d'ici,
 * donc ils ne peuvent pas diverger. Elles sont volontairement plus étroites que
 * `PLAN_LIMITS` (côté DAL) — une allure cible de 30 s/km ou une séance de 12 h
 * sont des hallucinations, pas des saisies.
 *
 * `weeksPerPlan.max` à 52 : au-delà, la génération ne tiendrait de toute façon
 * pas dans les 32 k de contexte du modèle cible.
 */
export const PLAN_OUTPUT_BOUNDS = {
  weeksPerPlan: { min: 1, max: 52 },
  sessionsPerWeek: { min: 1, max: 7 },
  day: { min: 1, max: 7 },
  targetPaceSecPerKm: { min: 150, max: 900 },
  distanceKm: { min: 0.5, max: 80 },
  durationMin: { min: 5, max: 600 },
  weeklyTimeMinutes: { min: 30, max: 1_800 },
  kindChars: 60,
  titleChars: 140,
  noteChars: 200,
  summaryChars: 1_500,
} as const;

/*
 * Schémas Zod.
 */

const planSessionSchema = z.object({
  /** Jour ISO : 1 = lundi … 7 = dimanche. */
  day: z.number().int().min(PLAN_OUTPUT_BOUNDS.day.min).max(PLAN_OUTPUT_BOUNDS.day.max),
  kind: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.kindChars),
  title: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.titleChars),
  warmup: z.string().max(PLAN_OUTPUT_BOUNDS.noteChars).optional(),
  recovery: z.string().max(PLAN_OUTPUT_BOUNDS.noteChars).optional(),
  cooldown: z.string().max(PLAN_OUTPUT_BOUNDS.noteChars).optional(),
  targetPaceSecPerKm: z
    .number()
    .int()
    .min(PLAN_OUTPUT_BOUNDS.targetPaceSecPerKm.min)
    .max(PLAN_OUTPUT_BOUNDS.targetPaceSecPerKm.max)
    .optional(),
  distanceKm: z
    .number()
    .min(PLAN_OUTPUT_BOUNDS.distanceKm.min)
    .max(PLAN_OUTPUT_BOUNDS.distanceKm.max)
    .optional(),
  durationMin: z
    .number()
    .min(PLAN_OUTPUT_BOUNDS.durationMin.min)
    .max(PLAN_OUTPUT_BOUNDS.durationMin.max)
    .optional(),
});

const planWeekSchema = z.object({
  sessions: z
    .array(planSessionSchema)
    .min(PLAN_OUTPUT_BOUNDS.sessionsPerWeek.min)
    .max(PLAN_OUTPUT_BOUNDS.sessionsPerWeek.max),
});

const planWeeksSchema = z
  .array(planWeekSchema)
  .min(PLAN_OUTPUT_BOUNDS.weeksPerPlan.min)
  .max(PLAN_OUTPUT_BOUNDS.weeksPerPlan.max);

/** Ce que le modèle produit pour une **création** de plan. */
export const planOutputSchema = z.object({
  summary: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.summaryChars),
  weeks: planWeeksSchema,
});

/**
 * Réglages qu'une instruction peut faire bouger. Tous facultatifs : le modèle
 * ne renvoie que ce que l'instruction change réellement.
 */
const planSettingsPatchSchema = z.object({
  sessionsPerWeek: z
    .number()
    .int()
    .min(PLAN_OUTPUT_BOUNDS.sessionsPerWeek.min)
    .max(PLAN_OUTPUT_BOUNDS.sessionsPerWeek.max)
    .optional(),
  longRunDay: z
    .number()
    .int()
    .min(PLAN_OUTPUT_BOUNDS.day.min)
    .max(PLAN_OUTPUT_BOUNDS.day.max)
    .optional(),
  weeklyTimeMinutes: z
    .number()
    .int()
    .min(PLAN_OUTPUT_BOUNDS.weeklyTimeMinutes.min)
    .max(PLAN_OUTPUT_BOUNDS.weeklyTimeMinutes.max)
    .optional(),
});

/** Ce que le modèle produit pour une **modification** : les mêmes semaines, plus les réglages. */
export const planUpdateOutputSchema = z.object({
  summary: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.summaryChars),
  settings: planSettingsPatchSchema.optional(),
  weeks: planWeeksSchema,
});

export type PlanSessionOutput = z.infer<typeof planSessionSchema>;
export type PlanWeekOutput = z.infer<typeof planWeekSchema>;
export type PlanOutput = z.infer<typeof planOutputSchema>;
export type PlanUpdateOutput = z.infer<typeof planUpdateOutputSchema>;
export type PlanSettingsOutput = z.infer<typeof planSettingsPatchSchema>;

/*
 * JSON Schema, écrit à la main.
 *
 * Volontairement pas dérivé du Zod : la dérivation demanderait une dépendance de
 * plus, et produirait des constructions que la conversion en GBNF de llama.cpp
 * ne traduit pas toujours (cf. l'en-tête de `client.ts`). `additionalProperties:
 * false` partout — sans lui, la grammaire autorise des champs inventés, que le
 * modèle s'empresse d'inventer.
 *
 * Les champs facultatifs restent hors de `required` : llama.cpp les gère
 * nativement, et les rendre obligatoires forcerait le modèle à remplir un
 * échauffement pour un footing qui n'en a pas.
 */

const sessionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['day', 'kind', 'title'],
  properties: {
    day: {
      type: 'integer',
      minimum: PLAN_OUTPUT_BOUNDS.day.min,
      maximum: PLAN_OUTPUT_BOUNDS.day.max,
      description: '1 = lundi, 7 = dimanche',
    },
    kind: { type: 'string', minLength: 1, maxLength: PLAN_OUTPUT_BOUNDS.kindChars },
    title: { type: 'string', minLength: 1, maxLength: PLAN_OUTPUT_BOUNDS.titleChars },
    warmup: { type: 'string', maxLength: PLAN_OUTPUT_BOUNDS.noteChars },
    recovery: { type: 'string', maxLength: PLAN_OUTPUT_BOUNDS.noteChars },
    cooldown: { type: 'string', maxLength: PLAN_OUTPUT_BOUNDS.noteChars },
    targetPaceSecPerKm: {
      type: 'integer',
      minimum: PLAN_OUTPUT_BOUNDS.targetPaceSecPerKm.min,
      maximum: PLAN_OUTPUT_BOUNDS.targetPaceSecPerKm.max,
    },
    distanceKm: {
      type: 'number',
      minimum: PLAN_OUTPUT_BOUNDS.distanceKm.min,
      maximum: PLAN_OUTPUT_BOUNDS.distanceKm.max,
    },
    durationMin: {
      type: 'number',
      minimum: PLAN_OUTPUT_BOUNDS.durationMin.min,
      maximum: PLAN_OUTPUT_BOUNDS.durationMin.max,
    },
  },
} as const;

const weeksJsonSchema = {
  type: 'array',
  minItems: PLAN_OUTPUT_BOUNDS.weeksPerPlan.min,
  maxItems: PLAN_OUTPUT_BOUNDS.weeksPerPlan.max,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['sessions'],
    properties: {
      sessions: {
        type: 'array',
        minItems: PLAN_OUTPUT_BOUNDS.sessionsPerWeek.min,
        maxItems: PLAN_OUTPUT_BOUNDS.sessionsPerWeek.max,
        items: sessionJsonSchema,
      },
    },
  },
} as const;

const summaryJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: PLAN_OUTPUT_BOUNDS.summaryChars,
} as const;

/** JSON Schema d'une création de plan — le pendant de {@link planOutputSchema}. */
export const planJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'weeks'],
  properties: { summary: summaryJsonSchema, weeks: weeksJsonSchema },
};

/** JSON Schema d'une modification — le pendant de {@link planUpdateOutputSchema}. */
export const planUpdateJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'weeks'],
  properties: {
    summary: summaryJsonSchema,
    settings: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionsPerWeek: {
          type: 'integer',
          minimum: PLAN_OUTPUT_BOUNDS.sessionsPerWeek.min,
          maximum: PLAN_OUTPUT_BOUNDS.sessionsPerWeek.max,
        },
        longRunDay: {
          type: 'integer',
          minimum: PLAN_OUTPUT_BOUNDS.day.min,
          maximum: PLAN_OUTPUT_BOUNDS.day.max,
        },
        weeklyTimeMinutes: {
          type: 'integer',
          minimum: PLAN_OUTPUT_BOUNDS.weeklyTimeMinutes.min,
          maximum: PLAN_OUTPUT_BOUNDS.weeklyTimeMinutes.max,
        },
      },
    },
    weeks: weeksJsonSchema,
  },
};

/*
 * Mapping vers le DAL.
 */

/** Texte détouré, ou `null` s'il ne reste rien — le DAL stocke `null`, pas `''`. */
function trimmedOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Traduit les semaines produites par le modèle en séances datées.
 *
 * @param startsOn premier jour du plan, **toujours un lundi** (c'est l'appelant
 * qui le garantit, cf. `nextPlanStart`). Le jour ISO de la séance se mappe donc
 * sans ambiguïté : `day = 1` tombe sur `startsOn`, `day = 7` six jours plus tard.
 *
 * Les unités changent de camp au passage : le modèle parle en kilomètres et en
 * minutes (ce qu'un coureur lit), la base stocke des mètres et des secondes.
 */
export function mapPlanWeeksToSessions(
  weeks: readonly PlanWeekOutput[],
  startsOn: string,
): NewPlanSessionInput[] {
  const sessions: NewPlanSessionInput[] = [];

  weeks.forEach((week, weekIndex) => {
    for (const session of week.sessions) {
      sessions.push({
        scheduledOn: shiftCivilDate(startsOn, weekIndex * 7 + (session.day - 1)),
        kind: session.kind.trim(),
        title: session.title.trim(),
        warmup: trimmedOrNull(session.warmup),
        recovery: trimmedOrNull(session.recovery),
        cooldown: trimmedOrNull(session.cooldown),
        targetPaceSecPerKm: session.targetPaceSecPerKm ?? null,
        volumeM: session.distanceKm === undefined ? null : Math.round(session.distanceKm * 1000),
        durationS: session.durationMin === undefined ? null : Math.round(session.durationMin * 60),
      });
    }
  });

  return sessions;
}

/*
 * Règles métier.
 */

/** Ce que le plan **doit** respecter, au-delà de sa forme. */
export type PlanExpectations = {
  weeks: number;
  sessionsPerWeek: number;
  /** Jour ISO de la sortie longue : 1 = lundi … 7 = dimanche. */
  longRunDay: number;
  /**
   * Jour ISO à partir duquel la **première** semaine est encore ouverte.
   *
   * Vaut 1 (semaine entière) à la création. À la modification, la première
   * semaine restante est presque toujours entamée : on régénère à partir de
   * demain, les jours déjà passés portent des séances réalisées qu'on ne
   * réécrit pas. Cette semaine-là compte donc *au plus* `sessionsPerWeek`
   * séances — en exiger le compte plein reviendrait à rattraper en trois jours
   * ce qui était étalé sur sept.
   */
  firstWeekFromDay?: number;
};

/**
 * Mesure comparable d'une séance, pour désigner « la plus longue » de la semaine.
 *
 * `null` dès qu'une séance de la semaine ne porte pas la même unité que les
 * autres : mélanger des kilomètres et des minutes produirait un classement
 * arbitraire, et la règle serait déclarée violée au hasard. On préfère alors
 * **ne pas juger** — la grammaire n'oblige pas le modèle à chiffrer ses séances.
 */
function weekSessionMeasures(week: PlanWeekOutput): number[] | null {
  if (week.sessions.every((session) => session.distanceKm !== undefined)) {
    return week.sessions.map((session) => session.distanceKm ?? 0);
  }
  if (week.sessions.every((session) => session.durationMin !== undefined)) {
    return week.sessions.map((session) => session.durationMin ?? 0);
  }
  return null;
}

/**
 * Ce qui, dans le plan proposé, contredit ce qui a été demandé.
 *
 * Retourne des phrases **en français**, telles quelles renvoyées au modèle pour
 * qu'il se corrige (cf. le retry de `plan-service.ts`) : elles sont écrites pour
 * être lues par lui, pas par un développeur. Liste vide = plan conforme.
 */
export function validatePlanBusinessRules(
  weeks: readonly PlanWeekOutput[],
  expected: PlanExpectations,
): string[] {
  const violations: string[] = [];
  const firstWeekFromDay = expected.firstWeekFromDay ?? 1;
  const longRunDayName = formatIsoDay(expected.longRunDay);

  if (weeks.length !== expected.weeks) {
    violations.push(
      `Le plan doit compter exactement ${expected.weeks} semaines, il en compte ${weeks.length}.`,
    );
  }

  weeks.forEach((week, index) => {
    const label = `Semaine ${index + 1}`;
    const isPartial = index === 0 && firstWeekFromDay > 1;
    const days = week.sessions.map((session) => session.day);

    if (isPartial) {
      if (week.sessions.length > expected.sessionsPerWeek) {
        violations.push(
          `${label} (déjà entamée) : ${week.sessions.length} séances, alors que le maximum est ${expected.sessionsPerWeek}.`,
        );
      }
      for (const day of days) {
        if (day < firstWeekFromDay) {
          violations.push(
            `${label} : aucune séance avant ${formatIsoDay(firstWeekFromDay)}, ces jours sont passés — la séance placée le ${formatIsoDay(day)} est à retirer.`,
          );
        }
      }
    } else if (week.sessions.length !== expected.sessionsPerWeek) {
      violations.push(
        `${label} : ${week.sessions.length} séances au lieu des ${expected.sessionsPerWeek} demandées.`,
      );
    }

    const seen = new Set<number>();
    for (const day of days) {
      if (seen.has(day)) {
        violations.push(`${label} : deux séances tombent le ${formatIsoDay(day)}, un seul jour chacune.`);
      }
      seen.add(day);
    }

    // Sur une semaine entamée dont le jour de sortie longue est déjà passé, la
    // règle n'a plus d'objet : le long run de la semaine a eu lieu (ou pas), il
    // n'est plus replanifiable.
    const longRunApplies = !isPartial || expected.longRunDay >= firstWeekFromDay;
    if (longRunApplies && !seen.has(expected.longRunDay)) {
      violations.push(`${label} : aucune séance le ${longRunDayName}, jour de la sortie longue.`);
      return;
    }
    if (!longRunApplies) return;

    const measures = weekSessionMeasures(week);
    if (measures === null) return;

    // La règle est satisfaite dès que la sortie longue est **parmi** les maxima,
    // et pas seulement quand elle est l'unique maximum : 10 km le mercredi et
    // 10 km le dimanche ne contredisent rien. Désigner « la plus longue » comme
    // le premier maximum rencontré déclarerait une violation, et coûterait une
    // régénération de plusieurs minutes pour un plan pourtant conforme.
    const longestMeasure = Math.max(...measures);
    // Le jour de sortie longue est forcément présent : la règle précédente est
    // sortie de la semaine dans le cas contraire.
    const longRunIndex = week.sessions.findIndex((session) => session.day === expected.longRunDay);
    if (measures[longRunIndex] < longestMeasure) {
      const longestDay = week.sessions[measures.indexOf(longestMeasure)].day;
      violations.push(
        `${label} : la séance la plus longue tombe le ${formatIsoDay(longestDay)} et non le ${longRunDayName}, qui doit porter la sortie longue.`,
      );
    }
  });

  return violations;
}
