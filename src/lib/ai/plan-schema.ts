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
import type { TrainingPaces } from '@/lib/metrics/vdot';
import { PLAN_STEP_BOUNDS, PLAN_STEP_ROLES, planSessionStepsSchema } from '@/lib/plan-steps/schema';

import { formatIsoDay, formatNumber, formatPace, formatPaceRange } from './format';

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

/**
 * Le déroulé d'une séance **tel que le modèle l'écrit**, puis normalisé vers le
 * contrat du projet ({@link planSessionStepsSchema}).
 *
 * Deux formes pour une même donnée, et c'est délibéré :
 *
 * - côté modèle, un champ sans valeur est **absent** — c'est le style du reste
 *   de ce fichier (cf. `targetPaceSecPerKm`), celui que la conversion GBNF de
 *   llama.cpp traduit sans surprise, et celui qui évite de faire écrire sept
 *   `null` par étape à un petit modèle ;
 * - côté application, toutes les clés sont présentes, à `null` quand elles ne
 *   portent rien.
 *
 * La transformation fait ce passage-là (plus l'arrondi des entiers, pour les
 * providers qui ne respectent pas `response_format`) et **normalise l'allure
 * quand l'intention est sans ambiguïté** : une seule borne fournie = allure
 * unique (les deux bornes égales), bornes inversées = plage remise à l'endroit.
 * Constaté en prod : un modèle local écrit spontanément une borne unique sur
 * quasiment chaque étape — la grammaire ne peut pas exiger « les deux bornes
 * ensemble », et rejeter cette forme faisait échouer des générations entières
 * pour une pure convention. Les **vrais** invariants (exclusivité
 * distance/durée, exclusivité allure/zone, bornes et tailles) restent vérifiés
 * par le `pipe` en sortie, à la source : une ambiguïté réelle est toujours
 * rejetée.
 */
const planStepOutputSchema = z
  .object({
    role: z.enum(PLAN_STEP_ROLES),
    distanceM: z.number().optional(),
    durationS: z.number().optional(),
    paceMinSecPerKm: z.number().optional(),
    paceMaxSecPerKm: z.number().optional(),
    hrZone: z.number().optional(),
    note: z.string().optional(),
  })
  .transform((step) => {
    const roundedMin =
      step.paceMinSecPerKm === undefined ? null : Math.round(step.paceMinSecPerKm);
    const roundedMax =
      step.paceMaxSecPerKm === undefined ? null : Math.round(step.paceMaxSecPerKm);
    // Une seule borne → allure unique ; deux bornes inversées → plage remise à
    // l'endroit. Aucun cas ambigu n'est décidé ici.
    const single = roundedMin ?? roundedMax;
    const paceMinSecPerKm =
      roundedMin === null || roundedMax === null ? single : Math.min(roundedMin, roundedMax);
    const paceMaxSecPerKm =
      roundedMin === null || roundedMax === null ? single : Math.max(roundedMin, roundedMax);

    return {
      role: step.role,
      distanceM: step.distanceM ?? null,
      durationS: step.durationS === undefined ? null : Math.round(step.durationS),
      paceMinSecPerKm,
      paceMaxSecPerKm,
      hrZone: step.hrZone === undefined ? null : Math.round(step.hrZone),
      note: trimmedOrNull(step.note),
    };
  });

const planSessionStepsOutputSchema = z
  .array(
    z.object({
      // Facultatif : la très grande majorité des blocs ne se répètent pas, et
      // `repeat: 1` partout est du bruit que le modèle finit par mal recopier.
      repeat: z.number().optional(),
      steps: z.array(planStepOutputSchema),
    }),
  )
  .transform((blocks) =>
    blocks.map((block) => ({
      repeat: block.repeat === undefined ? 1 : Math.round(block.repeat),
      steps: block.steps,
    })),
  )
  .pipe(planSessionStepsSchema);

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
  /** Déroulé structuré. Absent sur une séance qui n'en appelle pas (footing simple). */
  steps: planSessionStepsOutputSchema.optional(),
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

/**
 * Une étape du déroulé. Même style que le reste du fichier : les champs qui
 * peuvent manquer sont simplement hors de `required` — pas de `type: [..., 'null']`,
 * que la conversion GBNF traduit mal et qui ferait écrire des `null` au modèle.
 *
 * Les exclusions (une mesure, une cible) ne sont pas exprimables en JSON Schema
 * sans `oneOf` ; elles sont laissées à Zod, qui les tient depuis
 * `lib/plan-steps/schema`. La grammaire borne, elle ne prouve pas.
 */
const stepJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    role: {
      type: 'string',
      enum: [...PLAN_STEP_ROLES],
      description: 'warmup = échauffement, run = effort, recover = récupération, cooldown = retour au calme',
    },
    distanceM: {
      type: 'number',
      minimum: PLAN_STEP_BOUNDS.distanceM.min,
      maximum: PLAN_STEP_BOUNDS.distanceM.max,
      description: 'mètres — exclusif de durationS',
    },
    durationS: {
      type: 'integer',
      minimum: PLAN_STEP_BOUNDS.durationS.min,
      maximum: PLAN_STEP_BOUNDS.durationS.max,
      description: 'secondes — exclusif de distanceM',
    },
    paceMinSecPerKm: {
      type: 'integer',
      minimum: PLAN_STEP_BOUNDS.paceSecPerKm.min,
      maximum: PLAN_STEP_BOUNDS.paceSecPerKm.max,
      description: 'borne rapide de l’allure, en s/km — va avec paceMaxSecPerKm',
    },
    paceMaxSecPerKm: {
      type: 'integer',
      minimum: PLAN_STEP_BOUNDS.paceSecPerKm.min,
      maximum: PLAN_STEP_BOUNDS.paceSecPerKm.max,
      description: 'borne lente de l’allure, en s/km',
    },
    hrZone: {
      type: 'integer',
      minimum: PLAN_STEP_BOUNDS.hrZone.min,
      maximum: PLAN_STEP_BOUNDS.hrZone.max,
      description: 'zone cardiaque 1 à 5 — exclusive d’une allure',
    },
    note: { type: 'string', maxLength: PLAN_STEP_BOUNDS.noteChars },
  },
} as const;

/** Le déroulé complet : des blocs d'étapes, sans imbrication possible. */
const stepsJsonSchema = {
  type: 'array',
  minItems: PLAN_STEP_BOUNDS.blocksPerSession.min,
  maxItems: PLAN_STEP_BOUNDS.blocksPerSession.max,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['steps'],
    properties: {
      repeat: {
        type: 'integer',
        minimum: PLAN_STEP_BOUNDS.repeat.min,
        maximum: PLAN_STEP_BOUNDS.repeat.max,
        description: 'nombre de passages du bloc, 1 par défaut',
      },
      steps: {
        type: 'array',
        minItems: PLAN_STEP_BOUNDS.stepsPerBlock.min,
        maxItems: PLAN_STEP_BOUNDS.stepsPerBlock.max,
        items: stepJsonSchema,
      },
    },
  },
} as const;

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
    steps: stepsJsonSchema,
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
 * @param anchor lundi de la première semaine du plan, **toujours un lundi**
 * (c'est l'appelant qui le garantit : `PlanWindow.anchor` à la création,
 * `RemainingPlanWindow.firstWeekStart` à l'ajustement). Le jour ISO de la séance
 * se mappe donc sans ambiguïté : `day = 1` tombe sur l'ancre, `day = 7` six jours
 * plus tard. Sur une première semaine entamée, l'ancre précède le départ réel du
 * plan — c'est `PlanExpectations.firstWeekFromDay` qui interdit alors au modèle
 * d'y placer une séance.
 *
 * Les unités changent de camp au passage : le modèle parle en kilomètres et en
 * minutes (ce qu'un coureur lit), la base stocke des mètres et des secondes.
 */
export function mapPlanWeeksToSessions(
  weeks: readonly PlanWeekOutput[],
  anchor: string,
): NewPlanSessionInput[] {
  const sessions: NewPlanSessionInput[] = [];

  weeks.forEach((week, weekIndex) => {
    for (const session of week.sessions) {
      sessions.push({
        scheduledOn: shiftCivilDate(anchor, weekIndex * 7 + (session.day - 1)),
        kind: session.kind.trim(),
        title: session.title.trim(),
        warmup: trimmedOrNull(session.warmup),
        recovery: trimmedOrNull(session.recovery),
        cooldown: trimmedOrNull(session.cooldown),
        targetPaceSecPerKm: session.targetPaceSecPerKm ?? null,
        volumeM: session.distanceKm === undefined ? null : Math.round(session.distanceKm * 1000),
        durationS: session.durationMin === undefined ? null : Math.round(session.durationMin * 60),
        // Déjà normalisé et validé par le schéma : le DAL le revalide malgré
        // tout (il ne fait confiance à aucun appelant) et en dérive volume et
        // durée quand la séance ne les déclare pas.
        steps: session.steps ?? null,
      });
    }
  });

  return sessions;
}

/*
 * Règles métier.
 */

/**
 * L'objectif d'un plan qui mène à une **course**, pour ce que ça change aux
 * règles de volume : l'affûtage.
 *
 * Seule la distance « marathon » a besoin d'être distinguée — c'est la seule qui
 * réclame trois semaines d'affûtage (Pfitzinger & Douglas, *Advanced Marathoning*
 * ; Daniels donne 2 à 3 semaines), les autres se contentent de deux.
 */
export type PlanRaceGoal = { isMarathon: boolean };

/** Ce que le plan **doit** respecter, au-delà de sa forme. */
export type PlanExpectations = {
  /**
   * Ce que la fenêtre jugée représente — et donc ce qu'il est légitime d'exiger
   * de sa progression.
   *
   * `'creation'` : le plan entier, du premier au dernier jour. Il doit monter.
   *
   * `'adjustment'` : les seules semaines **restantes** d'un plan déjà écrit. Y
   * exiger un pic supérieur à sa première semaine reviendrait à réclamer une
   * montée de volume à cinq semaines d'un marathon, c'est-à-dire l'inverse de ce
   * que le plan complet prévoit. La règle anti-plat est donc désactivée ici ; les
   * autres règles de volume (hausse, semaine allégée, affûtage, sortie longue)
   * gardent tout leur sens sur un tronçon.
   *
   * Champ explicite, et pas une déduction depuis `race` ou `firstWeekFromDay` :
   * une création peut elle aussi porter une course et démarrer en milieu de
   * semaine, rien dans les autres champs ne distingue les deux cas.
   */
  scope: 'creation' | 'adjustment';
  weeks: number;
  sessionsPerWeek: number;
  /** Jour ISO de la sortie longue : 1 = lundi … 7 = dimanche. */
  longRunDay: number;
  /**
   * Jour ISO à partir duquel la **première** semaine est encore ouverte.
   *
   * Vaut 1 quand la première semaine est entière. Elle ne l'est pas dans deux
   * cas : à la modification, on régénère à partir de demain et les jours déjà
   * passés portent des séances réalisées qu'on ne réécrit pas ; à la création,
   * un programme démarré en milieu de semaine laisse les jours qui précèdent
   * hors du plan. Cette semaine-là compte donc *au plus* `sessionsPerWeek`
   * séances — en exiger le compte plein reviendrait à rattraper en trois jours
   * ce qui était étalé sur sept.
   */
  firstWeekFromDay?: number;
  /**
   * L'objectif du plan, quand c'est une course : les dernières semaines sont
   * alors des semaines d'affûtage, jugées à l'envers des autres (le volume doit
   * y **descendre**). `null` ou absent pour un objectif libre — sans échéance, il
   * n'y a rien à affûter.
   */
  race?: PlanRaceGoal | null;
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
 * Ce qui, dans un `kind`, désigne une séance de qualité.
 *
 * Le `kind` est une chaîne libre, mais le prompt en impose le vocabulaire
 * (« Seuil », « VMA », « Répétitions », « Côtes »…) : ces racines couvrent ce
 * vocabulaire et ses variantes courantes. Le doute profite au modèle — un
 * libellé non reconnu n'entraîne aucune violation plutôt qu'une régénération de
 * plusieurs minutes pour une séance peut-être correcte.
 *
 * « Spécifique » n'en fait délibérément pas partie : le prompt encourage la
 * « sortie longue spécifique », qui est une séance d'endurance avec un bloc à
 * allure objectif — la classer en qualité lui réclamerait un déroulé complet
 * qu'elle n'a pas à porter.
 */
const INTENSITY_KIND_ROOTS = [
  'vma',
  'seuil',
  'tempo',
  'fractionn',
  'interval',
  'repetition',
  'cote',
  'piste',
] as const;

const COMBINING_MARKS = /[\u0300-\u036f]/gu;

/** Minuscules sans accents : `Côtes`, `cotes` et `COTES` se reconnaissent pareil. */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase();
}

function isIntensitySession(session: PlanSessionOutput): boolean {
  const kind = normalizeText(session.kind);
  return INTENSITY_KIND_ROOTS.some((root) => kind.includes(root));
}

/**
 * Les façons d'écrire un semi-marathon, qui contiennent toutes « marathon ».
 *
 * `1/2` en fait partie (« 1/2 marathon de Nantes » est une graphie courante des
 * pages d'inscription), et le séparateur admet le trait d'union insécable
 * (U+2011) que produisent les traitements de texte — « semi‑marathon » s'écrit
 * ainsi sans que rien ne le distingue à l'œil.
 */
const HALF_MARATHON_NAMES = /(semi|demi|half|1\/2)[\s‑-]*marathon/g;

/**
 * L'objectif décrit-il un **marathon** ?
 *
 * Utilisé pour la seule durée de l'affûtage (3 semaines au lieu de 2). Le texte
 * de l'objectif est libre : on écarte d'abord les graphies du semi-marathon, qui
 * contiennent toutes le mot « marathon » et vaudraient un affûtage de trop.
 */
export function isMarathonGoal(goalText: string): boolean {
  return normalizeText(goalText).replace(HALF_MARATHON_NAMES, '').includes('marathon');
}

/**
 * Ce qui cloche dans le **déroulé** d'une séance.
 *
 * Deux fautes d'entraîneur, invisibles pour la grammaire comme pour Zod :
 * envoyer un athlète sur des efforts durs sans l'échauffer ni le ramener au
 * calme, et répéter un bloc d'effort sans récupération entre les passages (un
 * « 6 × 800 m » enchaîné sans respirer n'est pas la séance décrite).
 */
function sessionStepViolations(session: PlanSessionOutput, label: string): string[] {
  const violations: string[] = [];
  const where = `${label}, séance du ${formatIsoDay(session.day)} (${session.kind})`;
  const { steps } = session;

  if (isIntensitySession(session)) {
    if (steps === undefined) {
      violations.push(
        `${where} : une séance de qualité exige un déroulé \`steps\` — échauffement, blocs d'effort avec leurs récupérations, retour au calme.`,
      );
    } else {
      const roles = new Set(steps.flatMap((block) => block.steps.map((step) => step.role)));
      if (!roles.has('warmup')) {
        violations.push(
          `${where} : aucun échauffement — commence par une étape \`warmup\` de 10 à 20 min avant les efforts.`,
        );
      }
      if (!roles.has('cooldown')) {
        violations.push(
          `${where} : aucun retour au calme — termine par une étape \`cooldown\` de 5 à 10 min.`,
        );
      }
    }
  }

  // Un seul message par séance : deux blocs fautifs décrivent la même erreur, et
  // la répéter dilue la consigne de reprise.
  const withoutRecovery = steps?.find(
    (block) => block.repeat > 1 && !block.steps.some((step) => step.role === 'recover'),
  );
  if (withoutRecovery !== undefined) {
    violations.push(
      `${where} : le bloc répété ${withoutRecovery.repeat} fois n'a pas de récupération — chaque passage porte son effort ET son étape \`recover\`.`,
    );
  }

  return violations;
}

/**
 * Largeur du corridor de plausibilité des allures, en s/km **autour de l'allure
 * de référence** de l'athlète (son allure d'entraînement récente).
 *
 * Les bornes se déduisent des dérivations que le prompt autorise, en prenant les
 * plus extrêmes : côté rapide, les répétitions courtes descendent à référence
 * − 80 à 100 s/km ; côté lent, la récupération trottée monte à référence + 60 à
 * 120 s/km. Le corridor laisse ~10 à 30 s/km de marge au-delà, de quoi couvrir
 * un arrondi ou une séance de spécificité ancrée sur un objectif un peu plus
 * ambitieux. Tout ce qui en sort n'est plus un choix d'entraîneur mais une
 * aberration : un modèle qui pense en min/mile, ou qui invente une allure sans
 * la dériver de quoi que ce soit.
 *
 * Le prompt le dit déjà — mais une consigne n'est pas une garantie, et une
 * allure de 10:00/km prescrite à une coureuse qui court en 5:24/km est passée en
 * production.
 */
const PACE_CORRIDOR_MARGINS = { faster: 110, slower: 130 } as const;

/**
 * Marges du corridor quand la **table VDOT** existe, en s/km.
 *
 * Elles s'appliquent aux deux extrémités de la table elle-même : rien ne doit
 * être plus rapide que les répétitions (10 s/km de marge, l'arrondi d'un coach
 * qui écrit 3:45 pour 3:52), rien de plus lent que l'endurance — la minute de
 * battement du côté lent couvre les allures d'effort écrites un peu large. Les
 * récupérations, elles, n'ont pas de borne lente du tout ({@link
 * PrescribedPace}) : le prompt les autorise explicitement au-delà de E.max.
 *
 * Bien plus serré que le corridor dérivé de l'allure moyenne, et c'est tout
 * l'intérêt : la table *est* la prescription, le modèle n'a plus à la deviner.
 */
const VDOT_CORRIDOR_MARGINS = { faster: 10, slower: 60 } as const;

/** Les allures admissibles pour une athlète, en s/km, et d'où elles sortent. */
type PaceCorridor = {
  min: number;
  max: number;
  /** Fin de phrase du message de violation : ce qui fonde le corridor. */
  source: string;
};

/**
 * Le corridor de plausibilité, du plus fiable au moins fiable :
 *
 * 1. la table d'allures calculée depuis un chrono de course — elle prescrit ;
 * 2. à défaut, l'allure d'entraînement récente, dont le prompt fait dériver les
 *    autres — elle n'encadre qu'une aberration ;
 * 3. à défaut encore, `null` : le plan cible par zones cardiaques, il n'existe
 *    plus rien à quoi comparer une allure.
 */
function paceCorridor(context: PlanValidationContext): PaceCorridor | null {
  const paces = context.paces ?? null;
  if (paces !== null) {
    return {
      min: paces.repetition.minSecPerKm - VDOT_CORRIDOR_MARGINS.faster,
      max: paces.easy.maxSecPerKm + VDOT_CORRIDOR_MARGINS.slower,
      source:
        `de ta table d'allures calculée (E ${formatPaceRange(paces.easy)}, ` +
        `T ${formatPaceRange(paces.threshold)}, I ${formatPaceRange(paces.interval)}, ` +
        `R ${formatPaceRange(paces.repetition)}), récupérations comprises`,
    };
  }

  const reference = context.referencePaceSecPerKm ?? null;
  if (reference === null) return null;
  return {
    min: reference - PACE_CORRIDOR_MARGINS.faster,
    max: reference + PACE_CORRIDOR_MARGINS.slower,
    source: `dérivée de l'allure récente de l'athlète (${formatPace(reference)})`,
  };
}

/**
 * Ce qui, dans une étape, dispense de la borne **rapide** du corridor.
 *
 * Une ligne droite (« 30 s à 1 min vite », « 6 × 100 m en accélération ») se
 * court naturellement plus vite que les répétitions calibrées sur 200 à 400 m :
 * le prompt débutant en prescrit, et les refuser ferait relancer la génération
 * pour une séance parfaitement écrite. Au-delà de ces durées, une allure plus
 * rapide que R n'est plus une accélération mais une erreur.
 */
const SHORT_STEP_BOUNDS = { durationS: 60, distanceM: 200 } as const;

/**
 * Une allure prescrite par la séance, avec ce qui décide des bornes qui s'y
 * appliquent.
 *
 * Deux dispenses, chacune adossée à ce que le prompt autorise :
 *
 * - une **récupération** est « plus lente que E.max, ou sans cible » — sans
 *   borne lente : un trot à 8:15/km ou une portion marchée est une consigne
 *   valide, pas une aberration. La borne rapide, elle, s'applique toujours (une
 *   récupération à allure VMA n'est pas une récupération) ;
 * - une **étape courte** ({@link SHORT_STEP_BOUNDS}) est dispensée de la borne
 *   rapide, jamais de la lente.
 */
type PrescribedPace = {
  secPerKm: number;
  isRecovery: boolean;
  isShort: boolean;
};

function isShortStep(step: { distanceM: number | null; durationS: number | null }): boolean {
  return (
    (step.durationS !== null && step.durationS <= SHORT_STEP_BOUNDS.durationS) ||
    (step.distanceM !== null && step.distanceM <= SHORT_STEP_BOUNDS.distanceM)
  );
}

/**
 * Toutes les allures que la séance prescrit : sa cible globale d'abord, puis les
 * bornes de chaque étape dans l'ordre du déroulé.
 *
 * La cible de séance ne porte aucune dispense : elle vaut pour la séance
 * entière, où qu'aille son déroulé.
 */
function sessionPrescribedPaces(session: PlanSessionOutput): PrescribedPace[] {
  const paces: PrescribedPace[] = [];
  if (session.targetPaceSecPerKm !== undefined) {
    paces.push({ secPerKm: session.targetPaceSecPerKm, isRecovery: false, isShort: false });
  }

  for (const block of session.steps ?? []) {
    for (const step of block.steps) {
      const flags = { isRecovery: step.role === 'recover', isShort: isShortStep(step) };
      if (step.paceMinSecPerKm !== null) paces.push({ secPerKm: step.paceMinSecPerKm, ...flags });
      if (step.paceMaxSecPerKm !== null) paces.push({ secPerKm: step.paceMaxSecPerKm, ...flags });
    }
  }
  return paces;
}

/** L'allure sort-elle du corridor, dispenses appliquées ? */
function isOutsideCorridor(pace: PrescribedPace, corridor: PaceCorridor): boolean {
  if (!pace.isShort && pace.secPerKm < corridor.min) return true;
  return !pace.isRecovery && pace.secPerKm > corridor.max;
}

/**
 * L'allure aberrante de la séance, s'il y en a une.
 *
 * Un seul message par séance, sur la **première** allure hors corridor : une
 * séance dont les allures dérapent les fait toutes déraper de la même façon, et
 * en lister six mangerait le plafond du message de reprise pour dire une seule
 * chose. Le corridor est rappelé en toutes lettres — le modèle a besoin de
 * savoir dans quoi rentrer, pas seulement qu'il en est sorti.
 */
function sessionPaceViolation(
  session: PlanSessionOutput,
  label: string,
  corridor: PaceCorridor,
): string | null {
  const outlier = sessionPrescribedPaces(session).find((pace) => isOutsideCorridor(pace, corridor));
  if (outlier === undefined) return null;

  return (
    `${label}, séance du ${formatIsoDay(session.day)} (${session.kind}) : allure ${formatPace(outlier.secPerKm)} ` +
    `hors de la fourchette plausible [${formatPace(corridor.min)} – ${formatPace(corridor.max)}] ` +
    `${corridor.source}.`
  );
}

/*
 * Progression du volume.
 *
 * C'est la moitié « entraîneur » de la validation : un plan peut placer ses
 * séances parfaitement et rester un mauvais plan — douze semaines au même
 * volume, ou une hausse de 30 % la semaine avant la course. Le prompt donne ces
 * mêmes chiffres (`COACH_RULES`, section PROGRESSION DU VOLUME) ; ce qui suit est
 * le filet, pas la consigne.
 *
 * Sources des seuils encodés :
 *  - **hausse hebdomadaire** : la « règle des 10 % », doctrine commune (Daniels,
 *    *Daniels' Running Formula* ; Pfitzinger & Douglas, *Advanced Marathoning*).
 *    Le filet tolère 12 % — une consigne à 10 % refusée à 10,4 % ferait relancer
 *    des générations de plusieurs minutes pour un arrondi ;
 *  - **semaine allégée** (« cutback week ») toutes les 3 à 4 semaines, −15 à
 *    −30 % : même littérature, et Lydiard avant elle ;
 *  - **affûtage** : 2 semaines pour un 5-10 km ou un semi, 3 pour un marathon
 *    (Pfitzinger), volume nettement réduit, intensité maintenue ;
 *  - **sortie longue** : 20 à 30 % du volume hebdomadaire chez Daniels — la borne
 *    haute est ouverte ici, cf. {@link longRunMaxShare}.
 *
 * Toutes ces règles ne s'appliquent qu'à la **fenêtre de développement** : ni la
 * première semaine entamée (son volume est amputé de plusieurs jours, le comparer
 * n'a pas de sens), ni les semaines d'affûtage (qui doivent précisément faire
 * l'inverse).
 */

export const VOLUME_RULES = {
  /** Hausse maximale d'une semaine à la suivante. */
  maxWeeklyGrowth: 1.12,
  /** Une semaine « allégée » descend au moins à cette part de la précédente. */
  cutbackRatio: 0.85,
  /** Aucune fenêtre de tant de semaines consécutives ne reste sans semaine allégée. */
  cutbackWindowWeeks: 4,
  /** En deçà, un plan est trop court pour qu'une semaine allégée ait du sens. */
  minWeeksForCutback: 6,
  /**
   * … et il faut aussi assez de semaines de développement : sur quatre semaines
   * de développement suivies d'un affûtage, exiger une semaine allégée
   * reviendrait à en gaspiller le quart pour une récupération que l'affûtage
   * apporte déjà.
   */
  minBuildWeeksForCutback: 5,
  /** En deçà, un plan n'a pas la place de monter : la règle anti-plat ne s'applique pas. */
  minWeeksForPeak: 5,
  /**
   * … et il faut assez de semaines de développement pour que l'anti-plat laisse
   * un choix.
   *
   * L'arithmétique : avec `n` semaines de développement pleines, il y a `n − 1`
   * transitions, chacune plafonnée à ×1,12. Le pic atteignable vaut donc au plus
   * `1,12^(n−1)` fois la première semaine pleine, quand l'anti-plat en réclame
   * 1,10 :
   *
   *     n = 2 → pic ∈ [1,10 ; 1,12]   — 2 % de bande, une seule semaine à placer
   *     n = 3 → pic ∈ [1,10 ; 1,25]
   *     n = 4 → pic ∈ [1,10 ; 1,40]   — trois transitions pour répartir la montée
   *
   * À deux semaines de développement, le modèle doit viser une valeur unique au
   * pour cent près : il échoue, on régénère, et rien de tout cela n'est un
   * mauvais plan. À partir de quatre, la contrainte se répartit et la bande est
   * assez large pour qu'un entraîneur y respire.
   */
  minBuildWeeksForPeak: 4,
  /** Le pic doit dépasser la première semaine pleine d'au moins 10 %. */
  minPeakRatio: 1.1,
  /** La semaine de la course reste sous cette part du pic. */
  raceWeekMaxRatio: 0.65,
  /** Part du volume hebdomadaire que porte la sortie longue. */
  longRunShare: { min: 0.2, max: 0.4 },
} as const;

/** Un marathon n'ouvre sa troisième semaine d'affûtage que si le plan est assez long. */
const MARATHON_TAPER_MIN_PLAN_WEEKS = 8;

/**
 * Nombre de semaines d'affûtage attendues en fin de plan, 0 sans course.
 *
 * Exporté pour être éprouvé : c'est ce compte qui décide quelles semaines sont
 * jugées à l'endroit (le volume monte) et lesquelles le sont à l'envers.
 */
export function taperWeekCount(weeks: number, race: PlanRaceGoal | null | undefined): number {
  if (race === null || race === undefined) return 0;
  const taper = race.isMarathon && weeks >= MARATHON_TAPER_MIN_PLAN_WEEKS ? 3 : 2;
  return Math.min(taper, weeks);
}

/**
 * Volume d'une semaine, en km — `null` dès qu'une séance ne déclare pas sa
 * distance : une somme partielle ferait constater des baisses qui n'existent pas.
 */
function weekVolumeKm(week: PlanWeekOutput): number | null {
  let total = 0;
  for (const session of week.sessions) {
    if (session.distanceKm === undefined) return null;
    total += session.distanceKm;
  }
  return total;
}

/**
 * Part maximale du volume hebdomadaire que la sortie longue peut porter.
 *
 * 40 % en règle générale — mais la borne est arithmétiquement hostile aux petites
 * semaines : sur trois séances, des sorties parfaitement équilibrées en donnent
 * déjà 33 %, et la sortie longue étant *par définition* la plus longue, elle
 * dépasse 40 % sans qu'aucune faute n'ait été commise. Le plafond s'ouvre donc à
 * `1,6 / nombre de séances` — une sortie longue valant 1,6 fois la séance
 * moyenne, ce qui reste un plan sain. Sur 4 séances et plus, c'est bien 40 % qui
 * s'applique.
 */
const LONG_RUN_SESSION_FACTOR = 1.6;

function longRunMaxShare(sessionCount: number): number {
  return Math.max(VOLUME_RULES.longRunShare.max, LONG_RUN_SESSION_FACTOR / sessionCount);
}

/** `36,4 km`, avec la virgule décimale de l'UI française. */
function km(value: number): string {
  return `${formatNumber(value, 1)} km`;
}

/**
 * Un **plancher** annoncé au modèle, arrondi au dixième **supérieur**.
 *
 * L'arrondi au plus proche est ici une faute : « soit 33,4 km au minimum » pour
 * un plancher réel de 33,44 énonce une valeur que la règle qui l'annonce refuse.
 * Le modèle applique le chiffre à la lettre, échoue, on régénère — trois fois,
 * constaté. Le chiffre affiché doit satisfaire la règle.
 */
function kmAtLeast(value: number): string {
  return km(Math.ceil(value * 10) / 10);
}

/** Un **plafond** annoncé au modèle, arrondi au dixième **inférieur** — cf. {@link kmAtLeast}. */
function kmAtMost(value: number): string {
  return km(Math.floor(value * 10) / 10);
}

/**
 * `20,0 %`.
 *
 * Une décimale, pour la même raison que {@link kmAtLeast} : à l'entier près, une
 * hausse de 12,4 % s'affiche « 12 % » dans la phrase même qui interdit de
 * dépasser 12 %, et la consigne se contredit sous les yeux du modèle.
 */
function percent(share: number): string {
  return `${formatNumber(share * 100, 1)} %`;
}

/**
 * Ce qui, dans la progression des volumes hebdomadaires, ne tient pas debout.
 *
 * Une ligne au plus par semaine et par règle ; les fenêtres glissantes, elles,
 * ne rendent que leur premier manquement — quatre fenêtres qui se chevauchent
 * décrivent la même faute, et les lister mangerait le message de reprise.
 */
function volumeViolations(
  weeks: readonly PlanWeekOutput[],
  expected: PlanExpectations,
): string[] {
  const violations: string[] = [];
  const volumes = weeks.map(weekVolumeKm);

  const undeclared = volumes
    .map((volume, index) => (volume === null ? index + 1 : null))
    .filter((week): week is number => week !== null);
  if (undeclared.length > 0) {
    // Une seule ligne pour tout le plan : c'est une convention d'écriture, pas
    // une faute par semaine.
    violations.push(
      `Volumes hebdomadaires invérifiables : chaque séance déclare sa distance \`distanceKm\`, ` +
        `footings et récupérations compris — il en manque semaine ${undeclared.join(', semaine ')}.`,
    );
  }

  // Première semaine pleine : une semaine entamée porte moins de jours, donc
  // moins de kilomètres. La juger, ou juger la suivante par rapport à elle,
  // relèverait une hausse qui n'est que le retour à une semaine entière.
  const firstFull = (expected.firstWeekFromDay ?? 1) > 1 ? 1 : 0;
  const taper = taperWeekCount(weeks.length, expected.race);
  const lastBuild = weeks.length - taper - 1;
  const buildWeeks = lastBuild - firstFull + 1;

  /** Volume de la semaine `index` si elle est jugeable, `null` sinon. */
  const buildVolume = (index: number): number | null =>
    index >= firstFull && index <= lastBuild ? volumes[index] : null;

  // 1. Hausse hebdomadaire.
  for (let index = firstFull + 1; index <= lastBuild; index += 1) {
    const current = buildVolume(index);
    const previous = buildVolume(index - 1);
    if (current === null || previous === null) continue;

    const ceiling = previous * VOLUME_RULES.maxWeeklyGrowth;
    if (current > ceiling) {
      violations.push(
        `Semaine ${index + 1} : ${km(current)} après ${km(previous)}, soit ${percent(current / previous - 1)} ` +
          `de hausse. Le volume ne monte jamais de plus de ${percent(VOLUME_RULES.maxWeeklyGrowth - 1)} ` +
          `d'une semaine à l'autre — ${kmAtMost(ceiling)} au plus ici.`,
      );
    }
  }

  // 2. Semaine allégée : jamais quatre semaines de suite sans respiration.
  if (
    weeks.length >= VOLUME_RULES.minWeeksForCutback &&
    buildWeeks >= VOLUME_RULES.minBuildWeeksForCutback
  ) {
    const window = VOLUME_RULES.cutbackWindowWeeks;
    for (let start = firstFull; start + window - 1 <= lastBuild; start += 1) {
      let eased = false;
      for (let index = Math.max(start, firstFull + 1); index <= start + window - 1; index += 1) {
        const current = buildVolume(index);
        const previous = buildVolume(index - 1);
        // Un volume manquant ne fabrique pas une violation : elle est déjà dite.
        if (current === null || previous === null) eased = true;
        else if (current <= previous * VOLUME_RULES.cutbackRatio) eased = true;
      }
      if (!eased) {
        violations.push(
          `Semaines ${start + 1} à ${start + window} : quatre semaines de suite sans semaine allégée. ` +
            `L'une d'elles doit redescendre à ${percent(VOLUME_RULES.cutbackRatio)} ou moins du volume de la semaine précédente.`,
        );
        break;
      }
    }
  }

  // 3. Anti-plat : un plan qui ne monte pas n'entraîne pas.
  //
  // Réservé à la création : à l'ajustement, la fenêtre jugée n'est que la fin
  // d'un plan déjà écrit, où le volume redescend légitimement (cf.
  // `PlanExpectations.scope`).
  const peak = peakBuildVolume(volumes, firstFull, lastBuild);
  const firstFullVolume = buildVolume(firstFull);
  if (
    expected.scope === 'creation' &&
    weeks.length >= VOLUME_RULES.minWeeksForPeak &&
    buildWeeks >= VOLUME_RULES.minBuildWeeksForPeak &&
    peak !== null &&
    firstFullVolume !== null
  ) {
    const floor = firstFullVolume * VOLUME_RULES.minPeakRatio;
    if (peak < floor) {
      violations.push(
        `Plan trop plat : la semaine la plus chargée hors affûtage (${km(peak)}) doit dépasser ` +
          `d'au moins ${percent(VOLUME_RULES.minPeakRatio - 1)} la première semaine pleine (${km(firstFullVolume)}), ` +
          `soit ${kmAtLeast(floor)} au minimum.`,
      );
    }
  }

  // 4. Affûtage : les dernières semaines descendent, celle de la course le plus.
  for (let index = weeks.length - taper; index < weeks.length; index += 1) {
    const current = volumes[index];
    const previous = index - 1 >= firstFull ? volumes[index - 1] : null;
    if (current === null || previous === null) continue;

    if (current >= previous) {
      violations.push(
        `Semaine ${index + 1} (affûtage) : ${km(current)}, autant ou plus que la semaine ${index} ` +
          `(${km(previous)}) — pendant l'affûtage, le volume baisse strictement chaque semaine.`,
      );
    }
  }

  const raceWeekVolume = taper > 0 ? volumes[weeks.length - 1] : null;
  if (raceWeekVolume !== null && peak !== null) {
    const ceiling = peak * VOLUME_RULES.raceWeekMaxRatio;
    if (raceWeekVolume > ceiling) {
      violations.push(
        `Semaine ${weeks.length} (semaine de course) : ${km(raceWeekVolume)}, soit ${percent(raceWeekVolume / peak)} ` +
          `du pic (${km(peak)}) — elle reste sous ${percent(VOLUME_RULES.raceWeekMaxRatio)} du pic, ${kmAtMost(ceiling)} au plus.`,
      );
    }
  }

  // 5. Poids de la sortie longue dans sa semaine.
  for (let index = firstFull; index <= lastBuild; index += 1) {
    const total = volumes[index];
    if (total === null || total === 0) continue;

    const longRun = weeks[index].sessions.find((session) => session.day === expected.longRunDay);
    // Sortie longue absente : la règle de placement l'a déjà dit.
    if (longRun?.distanceKm === undefined) continue;

    const share = longRun.distanceKm / total;
    const maxShare = longRunMaxShare(weeks[index].sessions.length);
    if (share < VOLUME_RULES.longRunShare.min || share > maxShare) {
      violations.push(
        `Semaine ${index + 1} : la sortie longue fait ${km(longRun.distanceKm)} pour ${km(total)} dans la semaine ` +
          `(${percent(share)}) — elle doit peser entre ${percent(VOLUME_RULES.longRunShare.min)} et ${percent(maxShare)} du volume hebdomadaire.`,
      );
    }
  }

  return violations;
}

/** Le plus gros volume de la fenêtre de développement, `null` si elle est vide. */
function peakBuildVolume(
  volumes: readonly (number | null)[],
  firstFull: number,
  lastBuild: number,
): number | null {
  let peak: number | null = null;
  for (let index = firstFull; index <= lastBuild; index += 1) {
    const volume = volumes[index];
    if (volume === null || volume === undefined) continue;
    if (peak === null || volume > peak) peak = volume;
  }
  return peak;
}

/**
 * Ce à quoi les allures prescrites sont confrontées.
 *
 * Les deux sources sont exclusives dans les faits — quand la table existe, c'est
 * elle qui prescrit — mais l'appelant fournit ce qu'il a : le service passe les
 * deux, le corridor choisit ({@link paceCorridor}).
 */
export type PlanValidationContext = {
  /**
   * Allure d'entraînement récente de l'athlète, en s/km. Le **repli** : sans
   * chrono, c'est d'elle que le prompt fait dériver les allures, et la seule
   * chose à laquelle les comparer.
   */
  referencePaceSecPerKm?: number | null;
  /**
   * Table d'allures calculée depuis le chrono de référence. Quand elle est là,
   * elle remplace tout : le prompt l'impose, la validation la fait respecter.
   */
  paces?: TrainingPaces | null;
};

/**
 * Ce qui, dans le plan proposé, contredit ce qui a été demandé.
 *
 * Retourne des phrases **en français**, telles quelles renvoyées au modèle pour
 * qu'il se corrige (cf. le retry de `plan-service.ts`) : elles sont écrites pour
 * être lues par lui, pas par un développeur. Liste vide = plan conforme.
 *
 * @param context ce à quoi les allures sont confrontées ({@link
 * PlanValidationContext}) : la table VDOT si l'athlète a donné un chrono, son
 * allure récente sinon. Vide, aucune allure n'est jugée — le prompt impose alors
 * de cibler par zones cardiaques, et il n'existe plus rien à quoi comparer.
 */
export function validatePlanBusinessRules(
  weeks: readonly PlanWeekOutput[],
  expected: PlanExpectations,
  context: PlanValidationContext = {},
): string[] {
  const corridor = paceCorridor(context);
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

    // Avant les règles de sortie longue, qui sortent de la semaine par `return` :
    // le déroulé et les allures d'une séance se jugent quelle que soit la place
    // du long run.
    for (const session of week.sessions) {
      violations.push(...sessionStepViolations(session, label));
      if (corridor === null) continue;
      const paceViolation = sessionPaceViolation(session, label, corridor);
      if (paceViolation !== null) violations.push(paceViolation);
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

  // En dernier, et à part : ces règles-là se lisent sur le plan entier, pas sur
  // une semaine isolée.
  violations.push(...volumeViolations(weeks, expected));

  return violations;
}
