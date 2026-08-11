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

import type { PlanLevel } from '@/data/db/schema';
import type { NewPlanSessionInput } from '@/data/plans';
import { shiftCivilDate } from '@/lib/dates/civil';
import type { PaceZone, TrainingPaces } from '@/lib/metrics/vdot';
import {
  PLAN_STEP_BOUNDS,
  PLAN_STEP_ROLES,
  planSessionStepsSchema,
  type PlanSessionSteps,
  type PlanStep,
} from '@/lib/plan-steps/schema';

import {
  formatDuration,
  formatIsoDay,
  formatNumber,
  formatPace,
  formatPaceRange,
  type SessionBudget,
} from './format';

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
  /** La justification d'une révision : une ou deux phrases, pas un rapport. */
  reasonChars: 400,
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

/**
 * Les bornes d'un tableau — des semaines d'un plan, des séances d'une semaine.
 *
 * Un intervalle plutôt qu'un nombre parce que les deux cas existent : une
 * semaine pleine porte **exactement** le nombre de séances demandé, une première
 * semaine entamée au plus autant (cf. {@link chunkSessionCountBounds}).
 */
type CountBounds = { min: number; max: number };

function planWeekSchemaFor(sessions: CountBounds) {
  return z.object({
    sessions: z.array(planSessionSchema).min(sessions.min).max(sessions.max),
  });
}

function planWeeksSchemaFor(sessions: CountBounds) {
  return z
    .array(planWeekSchemaFor(sessions))
    .min(PLAN_OUTPUT_BOUNDS.weeksPerPlan.min)
    .max(PLAN_OUTPUT_BOUNDS.weeksPerPlan.max);
}

const planWeeksSchema = planWeeksSchemaFor(PLAN_OUTPUT_BOUNDS.sessionsPerWeek);

/** Le contrat d'une création, aux bornes de séances données ({@link planOutputSchemaFor}). */
function planSchemaFor(sessions: CountBounds) {
  return z.object({
    summary: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.summaryChars),
    weeks: planWeeksSchemaFor(sessions),
  });
}

/**
 * Ce que le modèle produit pour une **création** de plan.
 *
 * Aux bornes générales : une génération qui connaît son compte de séances passe
 * par {@link planOutputSchemaFor}.
 */
export const planOutputSchema = planSchemaFor(PLAN_OUTPUT_BOUNDS.sessionsPerWeek);

/** Le contrat d'une tranche, aux bornes de séances données ({@link planChunkOutputSchemaFor}). */
function chunkOutputSchemaFor(sessions: CountBounds) {
  return z.object({
    summary: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.summaryChars).optional(),
    weeks: planWeeksSchemaFor(sessions),
  });
}

/**
 * Ce que le modèle produit pour **une tranche** d'un plan long (cf. la
 * génération par tranches de `plan-service.ts`).
 *
 * Les mêmes semaines, sans enveloppe : une tranche n'est pas un plan, elle n'a
 * ni objectif ni réglages propres. Le `summary` n'y est que parce que la
 * **dernière** tranche le porte — c'est elle qui a vu passer tout le plan, et
 * c'est le seul moment où il peut être écrit en connaissance de cause. Sur les
 * autres tranches, la grammaire ne propose même pas la clé
 * ({@link planChunkJsonSchema}).
 *
 * Aux bornes générales : une tranche qui connaît son compte de séances passe par
 * {@link planChunkOutputSchemaFor}.
 */
export const planChunkOutputSchema = chunkOutputSchemaFor(PLAN_OUTPUT_BOUNDS.sessionsPerWeek);

/**
 * Réglages qu'une instruction peut faire bouger. Tous facultatifs : le modèle
 * ne renvoie que ce que l'instruction change réellement.
 *
 * `weeklyTimeMinutes` y ajoute un troisième état, `null` — cf.
 * {@link resolveWeeklyTimeBudget} : « je n'ai plus de contrainte de temps » n'est
 * pas la même chose que « je n'en parle pas », et le DAL sait déjà effacer la
 * contrainte (`PlanSettingsPatch`). La grammaire, elle, ne propose pas ce `null`
 * (cf. {@link settingsJsonSchema}) : un modèle contraint par GBNF omet la clé.
 * L'accepter ici couvre les providers qui ne suivent pas `response_format` et
 * écrivent `null` — c'est le rôle de cette seconde barrière.
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
    .nullish(),
});

/** Ce que le modèle produit pour une **modification** : les mêmes semaines, plus les réglages. */
export const planUpdateOutputSchema = z.object({
  summary: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.summaryChars),
  settings: planSettingsPatchSchema.optional(),
  weeks: planWeeksSchema,
});

/**
 * Ce que le modèle produit pour une **révision** du plan actif.
 *
 * Union discriminée, et c'est tout l'objet du contrat : une révision qui
 * conclut « rien à changer » ne porte **aucune** semaine, et le type l'impose —
 * `keep` ne se laisse pas accompagner d'un plan réécrit qu'on risquerait
 * d'appliquer par mégarde. `adjust`, lui, a exactement la forme d'un ajustement
 * ({@link planUpdateOutputSchema}), semaines comprises, et suit le même chemin
 * d'écriture.
 *
 * Le `summary` de l'ajustement n'y figure pas : une révision n'est pas demandée
 * par l'athlète, elle survient toute seule après quelques séances — ce qu'elle
 * doit rendre, c'est ce qu'elle a constaté (`reason`), pas une nouvelle
 * présentation du plan. Le service reporte cette raison dans le résumé existant.
 *
 * La grammaire, elle, ne sait pas exprimer cette dépendance : elle autorise
 * `weeks` dans les deux cas, et c'est Zod qui refuse un `adjust` sans semaines —
 * la reprise du modèle est alors la même que pour toute sortie hors schéma.
 */
export const planReviewOutputSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('keep'),
    reason: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.reasonChars),
  }),
  z.object({
    decision: z.literal('adjust'),
    reason: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.reasonChars),
    settings: planSettingsPatchSchema.optional(),
    weeks: planWeeksSchema,
  }),
]);

/**
 * Ce qu'une génération sait du **nombre de séances** de ses semaines — une
 * tranche d'un plan long comme un plan produit d'un seul tenant.
 *
 * ## Pourquoi la grammaire s'en mêle
 *
 * Constaté sur les premiers plans de production : sous message de reprise — donc
 * sous pression de correction — le modèle écrit 7 séances là où 6 étaient
 * demandées. La règle métier le voyait, le disait, et faisait régénérer la
 * tranche : plusieurs minutes perdues pour un compte que la grammaire peut
 * rendre **impossible à écrire**. C'est la même bascule que le nombre de
 * semaines d'une tranche (`minItems` = `maxItems`), d'un cran plus bas.
 *
 * ## Pourquoi la première semaine entamée y échappe
 *
 * Les items d'un tableau JSON Schema sont uniformes : `sessions` est décrit une
 * fois pour toutes les semaines produites, et il n'existe pas de bornes par
 * index que la conversion GBNF de llama.cpp traduise fidèlement. Une génération
 * qui porte la première semaine entamée — laquelle en compte légitimement moins,
 * puisque des jours sont déjà passés — garde donc des bornes **souples**
 * (1 à `sessionsPerWeek`) sur toutes ses semaines, et c'est la règle métier
 * ({@link validatePlanBusinessRules}, compte exact) qui reste le filet — pour
 * celle-là comme pour les providers qui ignorent le schéma.
 */
export type ChunkSessionBounds = {
  /** Le nombre de séances hebdomadaires demandé par l'athlète. */
  sessionsPerWeek: number;
  /** Les semaines produites comprennent-elles la première, déjà entamée ? */
  hasStartedWeek: boolean;
};

/** Les bornes du tableau `sessions`, exactes ou souples — cf. {@link ChunkSessionBounds}. */
function chunkSessionCountBounds(bounds: ChunkSessionBounds | null): CountBounds {
  if (bounds === null) return PLAN_OUTPUT_BOUNDS.sessionsPerWeek;
  return bounds.hasStartedWeek
    ? { min: PLAN_OUTPUT_BOUNDS.sessionsPerWeek.min, max: bounds.sessionsPerWeek }
    : { min: bounds.sessionsPerWeek, max: bounds.sessionsPerWeek };
}

/**
 * Le contrat Zod d'une tranche, **au même resserrement que sa grammaire**
 * ({@link planChunkJsonSchema}).
 *
 * Les deux barrières disent la même chose ou elles ne disent rien : une
 * grammaire qui interdit la septième séance et un Zod qui l'accepte laisserait
 * passer, chez un provider hors grammaire, exactement ce que la grammaire
 * cherche à empêcher.
 */
export function planChunkOutputSchemaFor(bounds: ChunkSessionBounds): z.ZodType<PlanChunkOutput> {
  return chunkOutputSchemaFor(chunkSessionCountBounds(bounds));
}

/**
 * Le contrat Zod d'une création **d'un seul tenant**, au même resserrement que
 * sa grammaire ({@link planJsonSchemaFor}).
 *
 * Même raison que pour une tranche ({@link planChunkOutputSchemaFor}) : les deux
 * barrières disent la même chose ou elles ne disent rien.
 */
export function planOutputSchemaFor(bounds: ChunkSessionBounds): z.ZodType<PlanOutput> {
  return planSchemaFor(chunkSessionCountBounds(bounds));
}

export type PlanSessionOutput = z.infer<typeof planSessionSchema>;
// Depuis la fabrique : les bornes du tableau `sessions` ne changent pas le type
// d'une semaine, seulement ce que le schéma accepte.
export type PlanWeekOutput = z.infer<ReturnType<typeof planWeekSchemaFor>>;
export type PlanOutput = z.infer<typeof planOutputSchema>;
export type PlanChunkOutput = z.infer<typeof planChunkOutputSchema>;
export type PlanUpdateOutput = z.infer<typeof planUpdateOutputSchema>;
export type PlanSettingsOutput = z.infer<typeof planSettingsPatchSchema>;
export type PlanReviewOutput = z.infer<typeof planReviewOutputSchema>;

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

/**
 * Le tableau `weeks`, aux bornes qu'on lui connaît.
 *
 * Fabrique plutôt que constante : une tranche resserre le nombre de semaines
 * (exact) **et** le nombre de séances de chaque semaine (cf.
 * {@link ChunkSessionBounds}), et ce que la grammaire interdit d'écrire n'a plus
 * à être corrigé après coup.
 */
function weeksJsonSchemaFor(
  weeks: CountBounds,
  sessions: CountBounds,
): Record<string, unknown> {
  return {
    type: 'array',
    minItems: weeks.min,
    maxItems: weeks.max,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['sessions'],
      properties: {
        sessions: {
          type: 'array',
          minItems: sessions.min,
          maxItems: sessions.max,
          items: sessionJsonSchema,
        },
      },
    },
  };
}

/**
 * Les bornes générales : celles d'un plan entier, qui ne sait ni combien de
 * semaines ni combien de séances lui seront demandées.
 *
 * Instance **unique** et partagée par les trois schémas de plan entier : la
 * révision reprend à la lettre les semaines d'un ajustement, et l'identité le
 * dit mieux qu'un commentaire.
 */
const weeksJsonSchema = weeksJsonSchemaFor(
  PLAN_OUTPUT_BOUNDS.weeksPerPlan,
  PLAN_OUTPUT_BOUNDS.sessionsPerWeek,
);

const summaryJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: PLAN_OUTPUT_BOUNDS.summaryChars,
} as const;

/** L'enveloppe d'une création, autour du tableau de semaines qu'on lui donne. */
function planJsonSchemaWith(weeks: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'weeks'],
    properties: { summary: summaryJsonSchema, weeks },
  };
}

/**
 * JSON Schema d'une création de plan — le pendant de {@link planOutputSchema}.
 *
 * Aux bornes générales : une génération qui connaît son compte de séances passe
 * par {@link planJsonSchemaFor}.
 */
export const planJsonSchema: Record<string, unknown> = planJsonSchemaWith(weeksJsonSchema);

/**
 * Le même schéma, dont chaque semaine porte **exactement** le nombre de séances
 * demandé — le pendant de {@link planOutputSchemaFor}.
 *
 * C'est le resserrement des tranches ({@link planChunkJsonSchema}) appliqué au
 * format le plus courant : sous les six semaines, le plan se produit d'un seul
 * tenant, et rien n'y empêchait le modèle d'écrire la septième séance qu'il
 * écrit précisément sous message de reprise. Une génération qui porte la
 * première semaine entamée garde des bornes souples, pour la raison
 * d'uniformité rappelée par {@link ChunkSessionBounds}.
 *
 * Le nombre de **semaines**, lui, reste aux bornes générales : la fenêtre du
 * plan n'est pas rappelée ici, et c'est la règle métier qui la vérifie.
 */
export function planJsonSchemaFor(sessions: ChunkSessionBounds): Record<string, unknown> {
  return planJsonSchemaWith(
    weeksJsonSchemaFor(PLAN_OUTPUT_BOUNDS.weeksPerPlan, chunkSessionCountBounds(sessions)),
  );
}

/**
 * JSON Schema d'**une tranche** — le pendant de {@link planChunkOutputSchema},
 * aux bornes de la tranche.
 *
 * Deux resserrements par rapport au schéma d'un plan entier, et les deux
 * comptent sur un petit modèle : le nombre de semaines est **exact** (`minItems`
 * = `maxItems`), donc la grammaire l'empêche d'en écrire une de trop ou de moins
 * — ce que la règle métier ne pouvait que constater après coup, au prix d'une
 * régénération ; et la clé `summary` **n'existe pas** hors de la dernière
 * tranche, plutôt que d'être facultative. Une clé absente de la grammaire ne
 * peut pas être écrite ; une clé facultative, si — et un modèle qui résume
 * chaque tranche paie trois fois le prix d'un résumé qui sera jeté deux fois.
 *
 * Un troisième depuis : le nombre de **séances** de chaque semaine, exact lui
 * aussi dès que la tranche ne porte que des semaines pleines (cf.
 * {@link ChunkSessionBounds}). Un modèle sous grammaire ne peut alors plus en
 * écrire sept quand six sont demandées — ce qu'il faisait précisément sous
 * message de reprise, au prix d'une régénération de plus.
 *
 * @param weeks nombre de semaines attendues dans cette tranche.
 * @param withSummary la tranche porte-t-elle le résumé du plan (la dernière) ?
 * @param sessions le compte de séances à imposer, `null` pour les bornes
 * générales (un provider ou un appelant qui n'a rien à en dire).
 */
export function planChunkJsonSchema(
  weeks: number,
  withSummary: boolean,
  sessions: ChunkSessionBounds | null = null,
): Record<string, unknown> {
  const chunkWeeksJsonSchema = weeksJsonSchemaFor(
    { min: weeks, max: weeks },
    chunkSessionCountBounds(sessions),
  );
  return withSummary
    ? {
        type: 'object',
        additionalProperties: false,
        required: ['weeks', 'summary'],
        properties: { weeks: chunkWeeksJsonSchema, summary: summaryJsonSchema },
      }
    : {
        type: 'object',
        additionalProperties: false,
        required: ['weeks'],
        properties: { weeks: chunkWeeksJsonSchema },
      };
}

/**
 * Les réglages durables, tels que la modification et la révision les rendent.
 *
 * `weeklyTimeMinutes` n'y est qu'un entier, sans `null` : `type: [..., 'null']`
 * se traduit mal en GBNF (cf. l'en-tête de cette section) et ferait écrire des
 * `null` au modèle là où l'omission dit déjà « inchangé ». Zod, lui, accepte le
 * `null` d'un provider hors grammaire ({@link resolveWeeklyTimeBudget}).
 */
const settingsJsonSchema = {
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
} as const;

/** JSON Schema d'une modification — le pendant de {@link planUpdateOutputSchema}. */
export const planUpdateJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'weeks'],
  properties: {
    summary: summaryJsonSchema,
    settings: settingsJsonSchema,
    weeks: weeksJsonSchema,
  },
};

/**
 * Le même schéma, dont `weeks` compte **exactement** `weeks` éléments.
 *
 * Sert aux enveloppes d'un ajustement ou d'une révision découpés en tranches :
 * leur premier appel porte à la fois les réglages (ou la décision) et les
 * semaines de la première tranche, pas celles de toute la fenêtre restante. La
 * grammaire le dit, plutôt que de laisser une règle métier le constater après
 * coup (cf. {@link planChunkJsonSchema}).
 */
function withWeekCount(schema: Record<string, unknown>, weeks: number): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...properties,
      // Le nombre de **séances**, lui, reste aux bornes générales : ces
      // enveloppes-là portent aussi les réglages, dont `sessionsPerWeek` que
      // l'instruction peut justement changer (« passe à 5 séances »). Le figer
      // dans la grammaire interdirait au modèle d'appliquer l'instruction qu'on
      // lui donne.
      weeks: weeksJsonSchemaFor({ min: weeks, max: weeks }, PLAN_OUTPUT_BOUNDS.sessionsPerWeek),
    },
  };
}

/** L'enveloppe d'un ajustement, bornée à la première tranche. */
export function planUpdateChunkJsonSchema(weeks: number): Record<string, unknown> {
  return withWeekCount(planUpdateJsonSchema, weeks);
}

/**
 * JSON Schema d'une révision — le pendant de {@link planReviewOutputSchema}.
 *
 * `weeks` et `settings` restent hors de `required` : c'est ce qui permet à une
 * révision de conclure « keep » sans écrire un plan entier — la contrainte
 * inverse (« adjust exige des semaines ») n'est pas exprimable ici sans `oneOf`,
 * que la conversion GBNF traduit mal, et vit donc dans Zod.
 */
export const planReviewJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason'],
  properties: {
    decision: {
      type: 'string',
      enum: ['keep', 'adjust'],
      description: "keep = le plan reste tel quel, adjust = la suite du plan est réécrite",
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: PLAN_OUTPUT_BOUNDS.reasonChars,
      description: 'ce qui est constaté et ce qui en est fait, en une ou deux phrases',
    },
    settings: settingsJsonSchema,
    weeks: weeksJsonSchema,
  },
};

/**
 * L'enveloppe d'une révision, bornée à la première tranche.
 *
 * `weeks` y reste hors de `required` : une révision qui conclut « keep » n'écrit
 * aucune semaine, et le compte exact ne vaut que pour celle qui ajuste.
 */
export function planReviewChunkJsonSchema(weeks: number): Record<string, unknown> {
  return withWeekCount(planReviewJsonSchema, weeks);
}

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
  /**
   * Les volumes hebdomadaires que l'appli a calculés pour cette fenêtre
   * ({@link weeklyVolumeTargets}), dans l'ordre des semaines — absents quand
   * aucune cible n'a été chiffrée, et la règle ne s'applique alors pas.
   *
   * Ces cibles sont annoncées au modèle dans le prompt : les lui vérifier n'est
   * pas une exigence de plus, c'est celle dont toutes les autres découlent (cf.
   * l'en-tête des volumes cibles).
   */
  weeklyTargets?: readonly WeeklyVolumeTarget[] | null;
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

/** Les cinq créneaux de la table d'allures (Daniels), tels qu'un `kind` en désigne un. */
export type PaceZoneKey = 'easy' | 'marathon' | 'threshold' | 'interval' | 'repetition';

/**
 * Ce qui, dans un `kind`, désigne le créneau d'allure d'une séance.
 *
 * Le `kind` est une chaîne libre, mais le prompt en impose le vocabulaire
 * (« Endurance fondamentale », « Sortie longue », « Seuil », « VMA »,
 * « Répétitions », « Côtes »…) : ces motifs couvrent ce vocabulaire et ses
 * variantes courantes, sur un texte déjà mis en minuscules et désaccentué
 * ({@link normalizeText}).
 *
 * `\bef\b` plutôt que `ef` : la racine seule se retrouve dans « effort » comme
 * dans « bref », et rangerait une séance d'intensité en endurance.
 */
const PACE_ZONE_PATTERNS = {
  easy: /\bef\b|endurance|footing|longue|recup|facile|souple/,
  threshold: /seuil|tempo/,
  interval: /vma|interval|fractionn|piste/,
  repetition: /repetition|cote/,
  marathon: /specifique|allure de course|allure course|allure objectif|marathon/,
} as const satisfies Record<PaceZoneKey, RegExp>;

/**
 * L'ordre de décision : le **premier** créneau dont le motif apparaît l'emporte.
 *
 * L'endurance d'abord, et c'est le sens conservateur : une « sortie longue
 * spécifique » ou une « endurance avec bloc allure marathon » reste une séance
 * d'endurance qui porte un bloc plus rapide, pas une séance d'allure course —
 * lui prescrire M de bout en bout enverrait l'athlète courir 18 km à l'allure de
 * son objectif. Le doute range donc en E, comme le libellé non reconnu.
 */
const PACE_ZONE_ORDER = ['easy', 'threshold', 'interval', 'repetition', 'marathon'] as const;

/**
 * Les créneaux qui font d'une séance une séance de **qualité**, celle qui doit
 * porter un déroulé complet.
 *
 * Ni E ni M n'en sont : le prompt encourage la « sortie longue spécifique », qui
 * est une séance d'endurance avec un bloc à allure objectif — la classer en
 * qualité lui réclamerait un échauffement et un retour au calme qu'elle n'a pas
 * à porter. Le doute profite au modèle : un libellé non reconnu n'entraîne
 * aucune violation plutôt qu'une régénération de plusieurs minutes pour une
 * séance peut-être correcte.
 */
const INTENSITY_ZONES = ['threshold', 'interval', 'repetition'] as const;

/**
 * Le **jour J** : une course, une compétition ou un test se court à l'allure de
 * l'objectif, pas en endurance.
 *
 * Testé **avant** {@link PACE_ZONE_ORDER}, et c'est la seule exception au
 * conservatisme easy-first : « Course », « Compétition » ou « Test 5 km » ne
 * portent aucun motif d'intensité et tomberaient sinon en E — prescrire 6:14/km
 * le jour d'un 10 km n'est pas une prudence, c'est un contresens.
 *
 * `\bcourse\b` isolé pour ne pas attraper « course à pied », et le vocabulaire
 * imposé par le prompt n'en contient qu'un seul porteur (« Spécifique allure
 * course »), déjà rangé en M par ailleurs — le motif ne change donc rien aux
 * libellés attendus.
 */
const RACE_DAY_PATTERN = /\bcourse\b|competition|\btest\b/;

/**
 * Ce qui, dans un `kind`, désigne une séance de **récupération**.
 *
 * Elle se range en E ({@link PACE_ZONE_PATTERNS}) faute de créneau plus lent,
 * mais la doctrine du module veut qu'une récupération soit « plus lente que E.max,
 * ou sans cible » : lui prescrire le milieu de E en ferait un footing. Elle ne
 * reçoit donc aucune cible du tout (cf. {@link imposeSessionPaces}).
 */
const RECOVERY_KIND_PATTERN = /recup/;

const COMBINING_MARKS = /[\u0300-\u036f]/gu;

/** Minuscules sans accents : `Côtes`, `cotes` et `COTES` se reconnaissent pareil. */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase();
}

/**
 * Le créneau d'allure d'une séance, déduit de son seul `kind`.
 *
 * Fonction totale : un libellé que rien ne reconnaît vaut `easy`. C'est ce qui
 * autorise {@link applyImposedPaces} à ne jamais laisser une séance sans allure,
 * et le pire cas est une séance prescrite trop lente — jamais trop rapide. Seul
 * le jour J ({@link RACE_DAY_PATTERN}) passe devant ce conservatisme.
 */
export function sessionPaceZone(kind: string): PaceZoneKey {
  const normalized = normalizeText(kind);
  if (RACE_DAY_PATTERN.test(normalized)) return 'marathon';
  return PACE_ZONE_ORDER.find((zone) => PACE_ZONE_PATTERNS[zone].test(normalized)) ?? 'easy';
}

/**
 * La séance est-elle une séance de **qualité** (seuil, VMA, répétitions) ?
 *
 * Exportée pour le résumé de continuité d'une tranche (`plan-service.ts`) : la
 * tranche suivante doit savoir quelles séances dures la précédente a placées,
 * sous peine d'en enchaîner trois du même type.
 */
export function isIntensitySession(session: PlanSessionOutput): boolean {
  const kind = normalizeText(session.kind);
  return INTENSITY_ZONES.some((zone) => PACE_ZONE_PATTERNS[zone].test(kind));
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
 * Les distances de course qu'un objectif libre peut nommer, en km, **dans
 * l'ordre de décision** — le semi avant le marathon, dont il contient le nom.
 *
 * Rien d'autre : ce sont les quatre distances pour lesquelles un objectif
 * s'écrit couramment avec un chrono. Un « 15 km » ou un trail de 30 km ne
 * donnent pas d'allure objectif, et c'est le sens conservateur — mieux vaut
 * retomber sur la zone M que de deviner.
 */
const GOAL_DISTANCES_KM = [
  [/(semi|demi|half|1\/2)[\s‑-]*marathon|\bsemi\b/, 21.0975],
  [/marathon/, 42.195],
  [/(?<!\d)10\s*km\b/, 10],
  [/(?<!\d)5\s*km\b/, 5],
] as const satisfies readonly (readonly [RegExp, number])[];

/**
 * Les écritures d'un temps de course reconnues dans un objectif, dans l'ordre de
 * décision : « 1h45 » et « 3 h 30 », puis « 50:00 » et « 1:45:00 », puis
 * « 50 min ».
 *
 * Le format à deux-points est ambigu par nature : deux groupes se lisent
 * mm:ss (« 50:00 » est un 10 km, pas 50 heures), trois groupes h:mm:ss.
 */
function goalTimeSeconds(normalized: string): number | null {
  const withHours = /(\d{1,2})\s*h(?:\s*(\d{1,2}))?/.exec(normalized);
  if (withHours !== null) {
    return Number(withHours[1]) * 3600 + Number(withHours[2] ?? 0) * 60;
  }

  const clock = /(?<!\d)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?/.exec(normalized);
  if (clock !== null) {
    const [, first, second, third] = clock;
    return third === undefined
      ? Number(first) * 60 + Number(second)
      : Number(first) * 3600 + Number(second) * 60 + Number(third);
  }

  const minutes = /(\d{1,3})\s*min(?:ute)?s?\b/.exec(normalized);
  return minutes === null ? null : Number(minutes[1]) * 60;
}

/**
 * Les allures entre lesquelles un objectif chiffré reste une allure de course à
 * pied, en s/km.
 *
 * Le filet du parseur, pas un jugement sur l'athlète : « marathon en 45 min »
 * donne 1:04/km, « 5 km en 3 h » 36:00/km. Aucune des deux n'est un objectif —
 * c'est une faute de saisie ou un texte que le parseur a mal découpé, et en
 * rendre l'allure ferait poser des cibles absurdes sur les étapes.
 */
const GOAL_PACE_BOUNDS = { min: 120, max: 900 } as const;

/**
 * L'allure de l'objectif, en s/km, dérivée d'un but chiffré — `null` dès que le
 * texte ne porte pas les deux moitiés (une distance connue **et** un temps), ou
 * que leur quotient ne ressemble pas à une allure de course
 * ({@link GOAL_PACE_BOUNDS}).
 *
 * Le besoin : « allure objectif » ne veut pas dire « zone marathon ». Sur une
 * préparation 10 km, l'allure de la course est 25 à 35 s/km plus rapide que la
 * zone M de la table — un bloc spécifique posé en M ferait travailler l'athlète
 * à côté de son objectif. Quand le but est chiffré, il n'y a rien à deviner :
 * c'est une division ({@link goalPaceZone} décide ensuite si elle est plausible
 * pour cette athlète).
 *
 * Fonction **pure**, exportée pour être éprouvée et pour que le service la
 * calcule une fois par génération.
 *
 * @param goalText le texte libre de l'objectif (« 10 km sous 50 min »,
 * « Marathon de Paris en 3h30 », « reprendre le volume »).
 */
export function goalPaceSecPerKm(goalText: string): number | null {
  const normalized = normalizeText(goalText);

  const distanceKm = GOAL_DISTANCES_KM.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
  if (distanceKm === null) return null;

  const seconds = goalTimeSeconds(normalized);
  if (seconds === null) return null;

  const pace = Math.round(seconds / distanceKm);
  return pace >= GOAL_PACE_BOUNDS.min && pace <= GOAL_PACE_BOUNDS.max ? pace : null;
}

/*
 * Allures imposées — l'appli les pose, le modèle ne les choisit plus.
 *
 * ## Le constat de production
 *
 * Sur deux déploiements successifs, table VDOT en unique section d'allures du
 * prompt, le modèle local a ressorti les mêmes allures absurdes à chaque
 * tentative — EF à 12:00/km, seuil à 11:00/km, VMA à 10:10/km — quand la table
 * prescrivait 5:56–6:32/km en E. Il s'ancrait sur l'« allure moyenne des
 * dernières sorties » du contexte, très lente chez cette athlète, et
 * n'appliquait aucune consigne numérique. Trois tentatives par génération,
 * plusieurs générations : échec systématique.
 *
 * La conclusion tirée est une décision d'architecture, pas un réglage de
 * prompt : **quand la table existe, aucune allure ne vient du modèle**. Il
 * décide de la structure (types de séances, distances, durées, répétitions),
 * l'appli écrit les allures depuis le `kind` — un post-traitement déterministe,
 * pur et testable, appliqué entre le parse de la sortie et la validation métier
 * (cf. `plan-service.ts`). Le corridor de validation reste en place et devient
 * trivialement satisfait : c'est voulu, il continue de couvrir le régime sans
 * table, où le modèle dérive encore ses allures.
 */

/** Le milieu d'un créneau, arrondi à la seconde : la cible d'une séance entière. */
function middleOf(zone: PaceZone): number {
  return Math.round((zone.minSecPerKm + zone.maxSecPerKm) / 2);
}

/**
 * Ce qui, dans la `note` d'une **étape**, désigne un créneau autre que celui de
 * sa séance — dans l'ordre de décision, le plus spécifique d'abord.
 *
 * C'est le pendant, à l'étape, du conservatisme easy-first de
 * {@link PACE_ZONE_ORDER}. Une « sortie longue avec un bloc à allure objectif »
 * — que le prompt encourage explicitement au niveau confirmé — se range en E au
 * niveau séance, et c'est juste : les 18 km ne se courent pas à l'allure de la
 * course. Mais son bloc spécifique, lui, se retrouvait ramené en E avec le
 * reste, ce qui effaçait la séance. Une intention écrite noir sur blanc dans la
 * note d'une étape isolée n'est pas un risque : elle est honorée.
 */
const STEP_NOTE_ZONES = [
  ['marathon', /allure objectif|allure (de )?course|specifique|marathon/],
  ['threshold', /seuil|tempo/],
] as const satisfies readonly (readonly [PaceZoneKey, RegExp])[];

/** Le créneau qu'une note d'étape réclame, `null` si elle n'en nomme aucun. */
function stepNotePaceZone(note: string | null): PaceZoneKey | null {
  if (note === null) return null;
  const normalized = normalizeText(note);
  return STEP_NOTE_ZONES.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

/** Demi-largeur de la plage posée autour d'une allure objectif chiffrée, en s/km. */
const GOAL_PACE_HALF_WIDTH = 8;

/**
 * De combien une allure objectif peut dépasser le bord rapide de la table sans
 * cesser d'être crédible, en s/km.
 *
 * Un objectif se court par définition un peu plus vite que ce que l'athlète tient
 * à l'entraînement, et la borne I de la table n'est pas un mur : dix secondes de
 * marge évitent de rejeter un objectif ambitieux mais tenable.
 */
const GOAL_PACE_MARGIN = 10;

/**
 * La plage à poser sur une étape « allure objectif » quand le but est chiffré —
 * `null` quand il ne l'est pas, ou que l'allure qu'il donne n'est pas plausible
 * pour cette athlète.
 *
 * Ce qu'elle corrige : {@link STEP_NOTE_ZONES} range « allure objectif » en M,
 * ce qui n'est l'allure de la course que sur un marathon. Sur une préparation
 * 10 km, la zone M est 25 à 35 s/km plus lente que l'objectif réel.
 *
 * La **plausibilité** est la garde qui autorise cette substitution : entre le
 * bord rapide des intervalles (moins {@link GOAL_PACE_MARGIN}) et le bord lent de
 * l'endurance, l'allure demandée reste une allure d'entraînement pour cette
 * athlète-là. En dehors — un objectif hors de portée, ou un texte mal découpé —
 * la zone M reprend la main : c'est le comportement d'avant, et il ne prescrit
 * jamais l'impossible.
 *
 * ±{@link GOAL_PACE_HALF_WIDTH} : une allure objectif est un chiffre, pas un
 * créneau, mais une étape porte une plage — seize secondes de large, soit
 * l'ordre de grandeur des créneaux serrés de la table (T fait 12 s).
 */
function goalPaceZone(goalPaceSecPerKm: number | null, paces: TrainingPaces): PaceZone | null {
  if (goalPaceSecPerKm === null) return null;
  if (goalPaceSecPerKm < paces.interval.minSecPerKm - GOAL_PACE_MARGIN) return null;
  if (goalPaceSecPerKm > paces.easy.maxSecPerKm) return null;

  return {
    minSecPerKm: goalPaceSecPerKm - GOAL_PACE_HALF_WIDTH,
    maxSecPerKm: goalPaceSecPerKm + GOAL_PACE_HALF_WIDTH,
  };
}

/**
 * Le créneau de l'**enveloppe** d'une séance — son échauffement et son retour au
 * calme —, `null` quand elle ne doit porter aucune cible.
 *
 * Sur une séance de qualité, c'est l'endurance : les caler sur le créneau de la
 * séance ferait échauffer à allure VMA, et l'information est réelle puisqu'elle
 * dit que l'enveloppe se court plus lentement que le corps.
 *
 * Sur une séance d'**endurance**, c'est `null`, et c'est un choix d'affichage
 * autant que d'entraînement : l'enveloppe s'y court exactement à l'intensité du
 * corps, donc « Échauffement 7:57–8:43 · Course 7:57–8:43 · Retour au calme
 * 7:57–8:43 » répète trois fois la même plage sans rien prescrire de plus. Seul
 * le corps la porte ; l'enveloppe garde sa durée et sa consigne en toutes
 * lettres, qui sont ce qu'elle a d'utile à dire.
 */
function envelopePaceZone(kindZone: PaceZoneKey, paces: TrainingPaces): PaceZone | null {
  return kindZone === 'easy' ? null : paces.easy;
}

/**
 * Le créneau qui s'applique à une **étape**, selon son rôle — `null` quand elle
 * ne doit porter aucune cible.
 *
 * L'échauffement et le retour au calme suivent l'enveloppe de la séance
 * ({@link envelopePaceZone}). La récupération, elle, ne reçoit rien : la
 * prescrire reviendrait à imposer une allure à un trot, alors que le seul
 * contrat qui vaille est « plus lent que l'endurance ».
 *
 * Une étape d'effort suit le créneau de sa séance, sauf si sa note en nomme un
 * autre ({@link STEP_NOTE_ZONES}). `session` à `null` — une séance de
 * récupération — ne cible rien du tout, note comprise : « Récupération » et
 * « allure objectif » ne se contredisent pas à moitié, et c'est le plus lent des
 * deux qui l'emporte.
 *
 * @param goal la plage de l'allure objectif chiffrée ({@link goalPaceZone}) : elle
 * prend la place de la zone M sur les étapes qui réclament l'allure de la course.
 */
function stepPaceZone(
  step: PlanStep,
  session: PaceZone | null,
  envelope: PaceZone | null,
  paces: TrainingPaces,
  goal: PaceZone | null,
): PaceZone | null {
  switch (step.role) {
    case 'run': {
      if (session === null) return null;
      const noted = stepNotePaceZone(step.note);
      if (noted === null) return session;
      // « allure objectif » veut dire l'allure de SA course, que la zone M ne
      // rend que sur un marathon (cf. `goalPaceZone`).
      return noted === 'marathon' && goal !== null ? goal : paces[noted];
    }
    case 'warmup':
    case 'cooldown':
      return envelope;
    case 'recover':
      return null;
  }
}

/**
 * L'étape, allure imposée.
 *
 * Une `hrZone` posée par le modèle est **conservée telle quelle**, et l'étape
 * ressort intacte : une étape ne porte jamais les deux cibles (cf.
 * `lib/plan-steps/schema`), et ce que le modèle a exprimé en fréquence
 * cardiaque n'est pas une allure fautive à corriger.
 */
function imposeStepPace(
  step: PlanStep,
  session: PaceZone | null,
  envelope: PaceZone | null,
  paces: TrainingPaces,
  goal: PaceZone | null,
): PlanStep {
  if (step.hrZone !== null) return step;

  const zone = stepPaceZone(step, session, envelope, paces, goal);
  return {
    ...step,
    paceMinSecPerKm: zone === null ? null : zone.minSecPerKm,
    paceMaxSecPerKm: zone === null ? null : zone.maxSecPerKm,
  };
}

/**
 * Le déroulé ne cible-t-il qu'en **fréquence cardiaque** ?
 *
 * Une séance dont toutes les étapes ciblées portent une `hrZone` a été pensée en
 * zones ; lui coller une « Allure cible 6:14/km » à côté d'étapes en Z2 afficherait
 * deux systèmes de cible pour une seule séance, dont l'un que personne n'a
 * demandé. Elle ne reçoit donc pas de cible de séance.
 */
function targetsHeartRateOnly(steps: PlanSessionSteps | undefined): boolean {
  if (steps === undefined) return false;
  const all = steps.flatMap((block) => block.steps);
  return (
    all.some((step) => step.hrZone !== null) && all.every((step) => step.paceMinSecPerKm === null)
  );
}

/*
 * Durées recalculées — même philosophie que les allures : les chiffres à l'appli.
 *
 * ## Le constat de production
 *
 * « 10 km · 1 h 00 · @ 8:20/km » : les trois chiffres sont affichés côte à côte,
 * et deux d'entre eux se contredisent — 10 km à 8:20/km font 1 h 23. Le modèle
 * n'a pas *calculé* cette heure, il l'a écrite. Aucune règle métier ne pouvait la
 * voir : la durée n'était comparée à rien.
 *
 * Quand la table existe, l'appli pose les allures ; elle a donc tout ce qu'il
 * faut pour poser aussi les durées, et une durée dérivée d'une distance et d'une
 * allure connues n'est pas une invention — c'est une division.
 *
 * Le régime **sans table** fait la même comptabilité avec les allures qu'il a
 * sous la main ({@link applyDerivedMeasures}) : celles que le modèle a écrites,
 * l'allure récente de l'athlète à défaut. Ce n'est pas une métrique fabriquée —
 * la somme d'un déroulé est celle des chiffres du modèle lui-même — et c'est ce
 * qui évite qu'un plan sans chrono de référence reste condamné faute de volumes
 * vérifiables.
 */

/**
 * L'allure qui sert à convertir la distance d'une **étape** en temps, en s/km.
 *
 * Dans l'ordre : l'allure posée sur l'étape (le milieu de sa plage), sinon le
 * créneau de sa séance, sinon l'endurance — `fallback` porte déjà ces deux
 * derniers, une séance sans créneau (récupération) se chronométrant en E.
 *
 * Une étape ciblée en fréquence cardiaque n'a pas d'allure : elle tombe elle
 * aussi sur le repli, qui est la meilleure estimation disponible.
 */
function stepPaceForDuration(step: PlanStep, fallback: number): number {
  if (step.paceMinSecPerKm === null || step.paceMaxSecPerKm === null) return fallback;
  return Math.round((step.paceMinSecPerKm + step.paceMaxSecPerKm) / 2);
}

/**
 * L'allure qui sert à convertir la durée d'une **étape** en distance, en s/km —
 * l'opération inverse de {@link stepPaceForDuration}, et elle n'a pas les mêmes
 * replis.
 *
 * L'allure posée sur l'étape d'abord — c'est le cas courant, l'imposition vient
 * de passer. À défaut (une étape ciblée en fréquence cardiaque, une
 * récupération), seul le **corps de séance** hérite du créneau de sa séance :
 * tout le reste se chronomètre en endurance.
 *
 * Ce n'est pas un détail de repli. Prêter à un trot de 2 min l'allure VMA de la
 * séance qui l'entoure lui compterait 500 m au lieu de 250, et prêter la même à
 * un échauffement en Z2 en compterait deux de trop : ces kilomètres-là
 * gonfleraient le volume hebdomadaire, celui-là même que les cibles surveillent.
 * L'endurance reste généreuse pour une récupération (un trot est plus lent),
 * mais elle est du bon ordre de grandeur — et c'est exactement l'allure à
 * laquelle un échauffement se court ({@link envelopePaceZone}).
 *
 * @param fallback le milieu du créneau de la séance.
 * @param easy le milieu du créneau d'endurance.
 */
function stepPaceForDistance(step: PlanStep, fallback: number, easy: number): number {
  if (step.paceMinSecPerKm !== null && step.paceMaxSecPerKm !== null) {
    return Math.round((step.paceMinSecPerKm + step.paceMaxSecPerKm) / 2);
  }
  return step.role === 'run' ? fallback : easy;
}

/**
 * Ce qu'un déroulé totalise : du temps, la distance qu'il **déclare**, et celle
 * qu'il **couvre** une fois les étapes chronométrées converties.
 *
 * Les trois sont nécessaires, et la distinction entre les deux dernières porte
 * tout le raisonnement de {@link imposedDistanceKm} :
 *
 * - `declaredKm` ne compte que les étapes exprimées en mètres. C'est elle qui
 *   dit si le déroulé décrit toute la séance ou un extrait ({@link
 *   imposedDurationMin}) ;
 * - `coverageKm` y ajoute les étapes exprimées en secondes, divisées par leur
 *   allure ({@link stepPaceForDistance}) : c'est la distance réellement parcourue
 *   par la séance décrite, la seule chose à opposer à un `distanceKm` manquant.
 */
function stepsTotals(
  steps: PlanSessionSteps,
  fallback: number,
  easy: number,
): { seconds: number; declaredKm: number; coverageKm: number } {
  let seconds = 0;
  let meters = 0;
  let coverage = 0;

  for (const block of steps) {
    let blockSeconds = 0;
    let blockMeters = 0;
    let blockCoverage = 0;
    for (const step of block.steps) {
      // Le schéma garantit exactement une mesure par étape.
      blockSeconds +=
        step.durationS ?? ((step.distanceM ?? 0) / 1000) * stepPaceForDuration(step, fallback);
      blockMeters += step.distanceM ?? 0;
      blockCoverage +=
        step.distanceM !== null
          ? step.distanceM / 1000
          : (step.durationS ?? 0) / stepPaceForDistance(step, fallback, easy);
    }
    seconds += blockSeconds * block.repeat;
    meters += blockMeters * block.repeat;
    coverage += blockCoverage * block.repeat;
  }

  return { seconds, declaredKm: meters / 1000, coverageKm: coverage };
}

/** Un volume en kilomètres, arrondi au dixième — la précision qu'un plan écrit. */
function roundKm(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * La distance d'une séance, **dérivée de son déroulé quand le modèle ne l'a pas
 * écrite** — et le drapeau qui dit d'où elle sort.
 *
 * Le défaut que cela corrige, constaté en production sur toutes les générations
 * d'une salve : le modèle n'écrit *jamais* `distanceKm` au niveau de la séance.
 * Sous grammaire GBNF l'ordre des propriétés est contraint — une propriété
 * facultative sautée ne peut plus être rattrapée plus loin dans l'objet — donc
 * la reprise ne rattrape rien non plus : les trois tentatives butaient sur
 * « Volumes hebdomadaires invérifiables », et aucun plan ne sortait.
 *
 * Or la distance n'est pas une invention ici, c'est une division : les allures
 * viennent d'être posées sur chaque étape, et une étape porte exactement une
 * mesure. Un déroulé complet dit donc la distance de sa séance.
 *
 * La valeur du modèle reste **prioritaire quand elle est présente et au moins
 * égale à la couverture du déroulé** : c'est le cas de la sortie longue à
 * déroulé partiel (18 km dont un unique bloc de 3 km à allure objectif), où le
 * déroulé n'est qu'un extrait. En dessous de la couverture, elle contredit le
 * déroulé qu'elle accompagne, et c'est le déroulé qui fait foi.
 */
function imposedDistanceKm(
  declared: number | undefined,
  totals: { coverageKm: number } | null,
): { distanceKm: number | undefined; fromSteps: boolean } {
  if (totals === null || totals.coverageKm <= 0) return { distanceKm: declared, fromSteps: false };
  if (declared !== undefined && declared >= totals.coverageKm) {
    return { distanceKm: declared, fromSteps: false };
  }
  return { distanceKm: roundKm(totals.coverageKm), fromSteps: true };
}

/**
 * La durée d'une séance, en minutes, recalculée depuis son contenu — `undefined`
 * quand rien ne permet de la calculer (ni déroulé, ni distance), auquel cas la
 * valeur du modèle est reconduite telle quelle.
 *
 * Deux calculs, et le **plus grand des deux** quand les deux existent et que le
 * déroulé ne couvre pas toute la distance de la séance :
 *
 * - par le déroulé : la somme des étapes, répétitions comprises — une étape à
 *   durée compte sa durée, une étape à distance sa distance divisée par son
 *   allure ({@link stepPaceForDuration}) ;
 * - par la distance de la séance, courue à l'allure de son créneau.
 *
 * Le défaut que le maximum corrige, constaté en production : le prompt demande
 * désormais des sorties longues dont le `steps` ne décrit **que** le bloc à
 * allure objectif (10 à 25 % de la distance). Une sortie longue de 18 km avec un
 * unique bloc de 3 km s'affichait « 18 km · 18 min », et la semaine tombait à
 * 138 min au lieu de 260 — budget hebdomadaire défait sur la plus grosse séance,
 * `durationS` faux en base. Un déroulé partiel décrit un extrait, pas la séance.
 *
 * Le maximum couvre aussi le cas symétrique du déroulé **entièrement en durée**
 * (« 15 min d'échauffement, 3 × 8 min, 10 min de retour au calme ») sur une
 * séance qui déclare une distance : les étapes n'y couvrent aucun kilomètre, et
 * la distance déclarée est alors la seule mesure du volume réel.
 *
 * Un déroulé qui couvre toute la distance déclarée reste maître de la durée :
 * c'est lui le plus précis, allure par allure.
 *
 * Et quand la distance vient d'être **dérivée du déroulé**
 * ({@link imposedDistanceKm}), le second calcul n'a plus lieu d'être : il
 * repasserait par la même distance, à l'allure moyenne de la séance cette fois,
 * et compterait deux fois les étapes chronométrées. Le déroulé est alors la
 * seule source, et il est complet par construction.
 *
 * @param distanceKm la distance de la séance, telle que {@link imposedDistanceKm}
 * l'a arrêtée.
 * @param fromSteps cette distance sort-elle du déroulé ?
 * @param totals les totaux du déroulé, `null` quand la séance n'en porte pas.
 * @param fallback le milieu du créneau de la séance.
 */
function imposedDurationMin(
  session: PlanSessionOutput,
  distanceKm: number | undefined,
  fromSteps: boolean,
  totals: { seconds: number; declaredKm: number } | null,
  fallback: number,
): number | undefined {
  if (totals === null) {
    if (distanceKm === undefined) return session.durationMin;
    return Math.round((distanceKm * fallback) / 60);
  }

  const bySteps = Math.round(totals.seconds / 60);
  if (fromSteps || distanceKm === undefined || totals.declaredKm >= distanceKm) return bySteps;

  return Math.max(bySteps, Math.round((distanceKm * fallback) / 60));
}

function imposeSessionPaces(
  session: PlanSessionOutput,
  paces: TrainingPaces,
  goal: PaceZone | null,
): PlanSessionOutput {
  const kindZone = sessionPaceZone(session.kind);
  // Une séance de récupération ne porte aucune cible, ni au niveau séance ni sur
  // ses étapes d'effort : le seul contrat qui vaille est « plus lent que E.max ».
  const isRecovery = kindZone === 'easy' && RECOVERY_KIND_PATTERN.test(normalizeText(session.kind));
  const zone = isRecovery ? null : paces[kindZone];
  const envelope = envelopePaceZone(kindZone, paces);

  const steps = session.steps?.map((block) => ({
    repeat: block.repeat,
    steps: block.steps.map((step) => imposeStepPace(step, zone, envelope, paces, goal)),
  }));

  const fallback = middleOf(zone ?? paces.easy);
  // Les totaux se calculent une fois, sur les étapes **allures posées** : c'est
  // d'eux que sortent la distance manquante puis la durée.
  const totals =
    steps === undefined ? null : stepsTotals(steps, fallback, middleOf(paces.easy));
  const { distanceKm, fromSteps } = imposedDistanceKm(session.distanceKm, totals);

  return {
    ...session,
    // Le milieu du créneau : une cible de séance est un chiffre, pas une plage.
    targetPaceSecPerKm: zone === null || targetsHeartRateOnly(steps) ? undefined : middleOf(zone),
    steps,
    distanceKm,
    durationMin: imposedDurationMin(session, distanceKm, fromSteps, totals, fallback),
  };
}

/**
 * Réécrit toutes les allures des semaines produites depuis la table calculée :
 * cible de séance au milieu du créneau de son `kind`, étapes d'effort sur les
 * bornes de ce créneau (ou de celui que leur note réclame), échauffement et
 * retour au calme en endurance sur une séance de qualité et sans cible sur une
 * séance d'endurance ({@link envelopePaceZone}), récupérations sans cible.
 *
 * Deux cas ressortent **sans** cible de séance : les séances de récupération
 * ({@link RECOVERY_KIND_PATTERN}) et celles qui ne ciblent qu'en fréquence
 * cardiaque ({@link targetsHeartRateOnly}).
 *
 * La **durée** de chaque séance est recalculée dans la foulée
 * ({@link imposedDurationMin}) : les allures venant d'être posées, elle se
 * déduit du contenu au lieu d'être écrite par le modèle. Sa **distance** l'est
 * aussi, mais seulement quand le modèle ne l'a pas écrite ou qu'elle contredit
 * le déroulé ({@link imposedDistanceKm}) — sans quoi aucun volume hebdomadaire
 * ne serait vérifiable.
 *
 * Fonction **pure** : les semaines d'entrée ne sont pas touchées, tout est
 * reconstruit. Rien d'autre de la sortie du modèle n'est modifié — ni les
 * répétitions, ni les notes, ni les mesures des étapes.
 *
 * @param goalPaceSecPerKm l'allure de l'objectif chiffré de l'athlète
 * ({@link goalPaceSecPerKm}), quand son but en donne une : les étapes « allure
 * objectif » la reçoivent à la place de la zone M ({@link goalPaceZone}).
 */
export function applyImposedPaces(
  weeks: readonly PlanWeekOutput[],
  paces: TrainingPaces,
  goalPaceSecPerKm: number | null = null,
): PlanWeekOutput[] {
  const goal = goalPaceZone(goalPaceSecPerKm, paces);
  return weeks.map((week) => ({
    sessions: week.sessions.map((session) => imposeSessionPaces(session, paces, goal)),
  }));
}

/*
 * Mesures dérivées — le régime **sans table**.
 *
 * ## Le trou que cela bouche
 *
 * La dérivation de `distanceKm` vivait dans {@link applyImposedPaces}, donc elle
 * ne tournait **que** quand la table VDOT existait. Or le constat de production
 * qui l'a motivée ne dépend pas de la table : le modèle n'écrit jamais
 * `distanceKm` au niveau de la séance, table ou pas. Un plan généré sans chrono
 * de référence restait donc condamné par « Volumes hebdomadaires
 * invérifiables » — trois tentatives, aucun plan.
 *
 * ## Ce qui change, et ce qui ne change surtout pas
 *
 * **Aucune allure n'est écrite ici.** Sans table, il n'y a rien à prescrire que
 * le modèle ne sache mieux : ses allures restent les siennes, et c'est le
 * corridor de plausibilité ({@link paceCorridor}) qui continue de les juger.
 * Seule la **comptabilité** est complétée : la distance manquante et la durée,
 * exactement comme le régime avec table les calcule ({@link imposedDistanceKm},
 * {@link imposedDurationMin}) — même machinerie, seule l'allure de conversion
 * diffère.
 */

/**
 * L'allure de dernier recours pour **estimer** un volume, en s/km.
 *
 * 8:00/km, l'ordre de grandeur d'un footing. Elle ne sert qu'à convertir une
 * mesure en l'autre quand plus rien d'autre n'est connu — ni allure d'étape, ni
 * cible de séance, ni allure récente : une athlète sans historique et sans
 * chrono. Elle n'est **jamais prescrite** : elle ne s'écrit ni sur une étape ni
 * sur une séance, et l'athlète ne la lit nulle part. Estimer un volume pour
 * qu'il soit vérifiable et prescrire une allure sont deux choses différentes ;
 * seule la première se contente d'un ordre de grandeur.
 */
const ESTIMATION_FALLBACK_PACE_SEC_PER_KM = 480;

/**
 * L'allure à laquelle les mesures d'une séance se convertissent, en s/km, du
 * plus fiable au moins fiable : la cible que le modèle a posée sur la séance,
 * l'allure d'entraînement récente de l'athlète, puis le repli
 * ({@link ESTIMATION_FALLBACK_PACE_SEC_PER_KM}).
 *
 * L'allure de l'**étape**, elle, passe avant tout cela — c'est
 * {@link stepPaceForDuration} et {@link stepPaceForDistance} qui la préfèrent,
 * étape par étape, et qui ne retombent sur celle-ci qu'à défaut.
 */
function sessionEstimationPace(
  session: PlanSessionOutput,
  referencePaceSecPerKm: number | null,
): number {
  return (
    session.targetPaceSecPerKm ?? referencePaceSecPerKm ?? ESTIMATION_FALLBACK_PACE_SEC_PER_KM
  );
}

/**
 * Une séance dont les mesures manquantes sont complétées, sans qu'aucune allure
 * ne bouge.
 *
 * Quatre cas, et la ligne qui les sépare est toujours la même : **on complète ce
 * que le modèle n'a pas écrit, et on ne corrige que ce que le modèle se
 * contredit à lui-même.**
 *
 * - **Déroulé présent** : mêmes calculs qu'avec la table
 *   ({@link imposedDistanceKm}, {@link imposedDurationMin}, maximum compris) —
 *   la somme d'un déroulé, ce sont les chiffres du modèle, pas une estimation de
 *   l'appli. Une durée de séance que son propre déroulé dément est donc refaite.
 * - **Sans déroulé, distance seule** : la durée s'en déduit, à l'allure de
 *   conversion ({@link sessionEstimationPace}).
 * - **Sans déroulé, durée seule** (« Footing 45 min ») : la conversion se fait
 *   dans l'autre sens, et c'est la durée du modèle qui reste maîtresse — la
 *   reconvertir depuis la distance qu'on vient d'en tirer serait un aller-retour
 *   sans information.
 * - **Sans déroulé, les deux mesures écrites** : rien ne bouge. Sans table,
 *   l'appli ne prescrit aucune allure ; réécrire cette durée-là depuis l'allure
 *   moyenne récente de l'athlète ferait juger le plan du coach sur une
 *   estimation de l'appli — et un budget temps refusé sur cette estimation
 *   rouvrirait exactement la classe de blocage qu'on ferme ici.
 *
 * Quand rien n'est dérivable — ni déroulé, ni distance, ni durée — la séance
 * ressort telle quelle, et la règle « Volumes hebdomadaires invérifiables » a
 * toujours quelque chose à reprocher au modèle. C'est le seul cas où elle en a.
 */
function deriveSessionMeasures(
  session: PlanSessionOutput,
  referencePaceSecPerKm: number | null,
): PlanSessionOutput {
  const pace = sessionEstimationPace(session, referencePaceSecPerKm);
  // Les mêmes totaux que le régime avec table, à ceci près qu'une seule allure y
  // sert de repli : sans table, il n'y a pas de créneau d'endurance distinct du
  // créneau de la séance.
  const totals = session.steps === undefined ? null : stepsTotals(session.steps, pace, pace);
  if (totals === null && session.distanceKm !== undefined && session.durationMin !== undefined) {
    return session;
  }

  const { distanceKm, fromSteps } = imposedDistanceKm(session.distanceKm, totals);
  if (distanceKm === undefined) {
    if (session.durationMin === undefined) return session;
    return { ...session, distanceKm: roundKm((session.durationMin * 60) / pace) };
  }

  return {
    ...session,
    distanceKm,
    durationMin: imposedDurationMin(session, distanceKm, fromSteps, totals, pace),
  };
}

/**
 * Complète les mesures des semaines produites **sans table d'allures** : la
 * distance que le modèle n'a pas écrite, la durée que son contenu contredit.
 *
 * Fonction **pure**, et volontairement sourde à tout le reste de la sortie : ni
 * les allures, ni les notes, ni les mesures des étapes ne sont touchées — les
 * prescriptions du modèle sont ce qu'il a de propre dans ce régime.
 *
 * @param referencePaceSecPerKm l'allure d'entraînement récente de l'athlète,
 * `null` quand elle n'en a pas — cf. {@link sessionEstimationPace} pour l'ordre
 * des replis.
 */
export function applyDerivedMeasures(
  weeks: readonly PlanWeekOutput[],
  referencePaceSecPerKm: number | null,
): PlanWeekOutput[] {
  return weeks.map((week) => ({
    sessions: week.sessions.map((session) => deriveSessionMeasures(session, referencePaceSecPerKm)),
  }));
}

/**
 * Le post-traitement d'un lot de semaines, entre le parse de la sortie et la
 * validation métier.
 */
export type PlanWeeksPostProcessing = (weeks: readonly PlanWeekOutput[]) => PlanWeekOutput[];

/**
 * Le post-traitement qui s'applique, **quel que soit le régime** — c'est la
 * fonction qui décide, et elle est seule à le faire.
 *
 * Avec table, l'appli écrit les allures et en dérive les mesures
 * ({@link applyImposedPaces}) ; sans table, elle ne complète que la comptabilité
 * ({@link applyDerivedMeasures}). Les deux chemins passent par ici : c'est ce
 * qui garantit qu'aucun appelant ne peut oublier le second en n'ayant traité que
 * le premier — le trou exact que ce module avait.
 */
export function planWeeksPostProcessing(
  context: Pick<PlanValidationContext, 'paces' | 'referencePaceSecPerKm'>,
  goalPaceSecPerKm: number | null,
): PlanWeeksPostProcessing {
  const paces = context.paces ?? null;
  if (paces !== null) return (weeks) => applyImposedPaces(weeks, paces, goalPaceSecPerKm);

  const reference = context.referencePaceSecPerKm ?? null;
  return (weeks) => applyDerivedMeasures(weeks, reference);
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
 * l'inverse). Deux exceptions, adossées à la vie de l'athlète plutôt qu'à sa
 * progression : le **budget temps** ({@link weeklyTimeViolations}), qui vaut sur
 * toutes les semaines, et l'**ancrage du départ** sur son volume réel, qui ne
 * concerne que la première semaine pleine d'une création.
 *
 * ## Budget temps contre anti-plat : aucune contradiction, et pourquoi
 *
 * La question se pose dès qu'un budget serré plafonne le volume plus bas que la
 * progression ne le voudrait : à 8:20/km, 2 h par semaine ne portent que ~14 km,
 * et une athlète qui court déjà 13,6 km n'a presque plus de marge. L'anti-plat
 * exige alors un pic à 110 % de la première semaine pleine — soit 15 km, hors
 * budget.
 *
 * Les deux règles restent pourtant satisfaisables **ensemble**, et sans qu'aucune
 * ne cède, parce qu'elles ne mordent pas sur la même chose : le budget est un
 * plafond **absolu**, l'anti-plat une contrainte **relative** à une première
 * semaine que le modèle choisit librement. Un plan qui ne rentre pas descend son
 * départ (13 → 14,5 → 12 → 13,4 → 14,9 → 13 tient dans 2 h et monte de 14,6 %),
 * ce qui est de toute façon la bonne réponse d'entraîneur : quand le temps
 * manque, c'est le volume de départ qui s'ajuste, pas la progression qui
 * disparaît. L'arbitrage est donc **explicitement de ne pas arbitrer** — faire
 * céder l'anti-plat au budget autoriserait douze semaines plates chez une
 * athlète pressée, exactement ce que la règle interdit.
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
  /**
   * Tolérance sur le **temps hebdomadaire déclaré** par l'athlète.
   *
   * 10 %, comme partout ailleurs dans ce module : le budget est une contrainte
   * de vie (« deux heures par semaine »), pas un chronomètre, et refuser 2 h 05
   * pour 2 h 00 ferait relancer des générations de plusieurs minutes. Au-delà,
   * ce n'est plus un arrondi : constaté en production, 3 h 30 planifiées pour
   * 2 h déclarées — un plan que l'athlète ne peut pas suivre.
   */
  weeklyTimeTolerance: 1.1,
  /**
   * Ce qu'une **première semaine pleine** peut dépasser le meilleur volume
   * hebdomadaire réellement couru récemment.
   *
   * Constaté en production : 25 km/semaine proposés à une athlète dont les
   * quatre dernières semaines font 9 à 13,6 km. Un plan ne démarre pas sur une
   * ambition, il démarre là où l'athlète est.
   *
   * Deux bornes, la plus permissive l'emportant : +20 % est la marche
   * raisonnable d'une reprise ; le `+3 km` évite d'étrangler les tout petits
   * volumes — à 4 km/semaine, +20 % ne laisse que 800 m de latitude, soit moins
   * qu'une séance, et aucun plan de trois séances ne rentrerait dedans.
   */
  startFromRecent: { ratio: 1.2, bonusKm: 3 },
  /**
   * Écart toléré entre le volume d'une semaine et la **cible** que l'appli a
   * calculée pour elle ({@link weeklyVolumeTargets}), quand il y en a une.
   *
   * 10 %, comme partout ailleurs dans ce module. La cible n'est pas une commande
   * au kilomètre près : elle donne l'échelle de la semaine, et le modèle garde la
   * main sur la répartition entre ses séances. Mais au-delà de 10 %, ce n'est
   * plus une répartition — c'est un autre plan que celui qui a été chiffré, et
   * dont plus rien ne garantit qu'il tient dans le budget ni qu'il progresse.
   */
  targetTolerance: 0.1,
} as const;

/**
 * Le volume maximal d'une première semaine pleine, au vu du volume réellement
 * couru récemment ({@link VOLUME_RULES.startFromRecent}).
 */
export function firstFullWeekMaxKm(recentWeeklyKm: number): number {
  return Math.max(
    recentWeeklyKm * VOLUME_RULES.startFromRecent.ratio,
    recentWeeklyKm + VOLUME_RULES.startFromRecent.bonusKm,
  );
}

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
 *
 * Exportée pour le résumé de continuité d'une tranche (`plan-service.ts`) : ce
 * qu'on dit à la tranche suivante du volume de la précédente doit être compté
 * exactement comme la règle le comptera.
 */
export function weekVolumeKm(week: PlanWeekOutput): number | null {
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

/** Une durée hebdomadaire en toutes lettres : `2 h 00`, `45 min`. */
function hours(minutes: number): string {
  return formatDuration(Math.round(minutes) * 60);
}

/**
 * Une durée **constatée**, arrondie à la minute supérieure — le pendant de
 * {@link kmAtLeast} pour le temps.
 *
 * L'arrondi va ici du côté de la violation : « 2 h 12 d'entraînement, 2 h 12 au
 * plus » se lirait comme une règle qui se contredit, alors que le total réel
 * (132,4 min) dépasse bien le plafond (132 min).
 */
function hoursAtLeast(minutes: number): string {
  return formatDuration(Math.ceil(minutes) * 60);
}

/** Un **plafond** de temps annoncé au modèle, arrondi à la minute inférieure — cf. {@link kmAtMost}. */
function hoursAtMost(minutes: number): string {
  return formatDuration(Math.floor(minutes) * 60);
}

/**
 * Durée totale d'une semaine, en minutes — `null` dès qu'une séance ne déclare
 * pas la sienne.
 *
 * Même prudence que {@link weekVolumeKm} : une somme partielle ferait constater
 * un budget respecté qui ne l'est pas. Le contrôle du budget temps ne s'applique
 * donc **pas** à une semaine dont une seule séance manque de durée — le régime
 * avec table d'allures les pose toutes ({@link imposedDurationMin}), le régime
 * sans table dépend de ce que le modèle a bien voulu écrire.
 */
function weekDurationMin(week: PlanWeekOutput): number | null {
  let total = 0;
  for (const session of week.sessions) {
    if (session.durationMin === undefined) return null;
    total += session.durationMin;
  }
  return total;
}

/*
 * Volumes hebdomadaires cibles — « le modèle structure, l'appli chiffre ».
 *
 * ## Pourquoi l'appli calcule les volumes
 *
 * Constat de production, sur un plan de 16 semaines à 6 séances : quand la
 * génération passe entière, le modèle ignore le budget temps sur onze semaines
 * d'affilée — montée linéaire de 5 h 32 à 6 h 22 pour 5 h déclarées. Ce n'est
 * pas une consigne mal formulée : la progression d'un volume hebdomadaire sous
 * quatre contraintes simultanées (hausse plafonnée, semaine allégée périodique,
 * pic minimum, budget de vie) est un problème d'arithmétique, et un modèle de
 * 6 Go ne résout pas un problème d'arithmétique sur seize lignes.
 *
 * L'appli le résout donc à sa place, une fois, exactement : {@link
 * weeklyVolumeTargets} produit une cible par semaine qui satisfait **par
 * construction** toutes les règles de {@link volumeViolations}, et le prompt les
 * annonce. Il ne reste au modèle que ce qu'il sait faire — répartir un volume
 * donné en séances, choisir leur nature, écrire leur déroulé.
 *
 * Les règles de progression restent en place et vérifiées : c'est de la défense
 * en profondeur.
 *
 * ## Ce que « conforme aux cibles » garantit, et ce qu'il ne garantit pas
 *
 * Un plan qui écrit les cibles **exactement** — au chiffre imprimé par le prompt
 * près — passe toutes les règles, et un test l'éprouve sur tout l'éventail des
 * configurations, à la fois sur les cibles nues et sur les valeurs telles que
 * `formatWeeklyVolumeTargets` les imprime.
 *
 * Rester dans la bande de ±10 % de chaque cible, en revanche, ne garantit rien :
 * la tolérance juge chaque semaine isolément, là où la hausse et la semaine
 * allégée jugent deux semaines l'une contre l'autre. Une montée visée à 8 %
 * contre un plafond de 12 % ne laisse qu'environ 1,8 % de jeu relatif entre deux
 * semaines voisines, et une allégée posée à 0,85 × exactement n'en laisse aucun.
 * D'où la consigne portée par le prompt à côté des cibles : viser le chiffre, pas
 * la bande.
 */

/** Ce qu'une semaine du plan est, du point de vue du volume. */
export type WeeklyVolumeTargetKind = 'build' | 'cutback' | 'taper' | 'race' | 'partial';

/** La cible d'une semaine : un volume, le temps qu'il coûte, et son rôle. */
export type WeeklyVolumeTarget = {
  /** Volume visé, en kilomètres, au dixième. */
  targetKm: number;
  /** Ce que ce volume coûte en temps, en minutes — toujours sous le budget déclaré. */
  targetMinutes: number;
  kind: WeeklyVolumeTargetKind;
};

/** Ce dont le planificateur a besoin pour chiffrer un plan entier. */
export type WeeklyVolumeTargetsParams = {
  /** Nombre de semaines du plan, la première (parfois entamée) comprise. */
  weeks: number;
  /** Jour ISO à partir duquel la première semaine porte des séances : 1 = lundi. */
  firstWeekFromDay: number;
  /** Le **meilleur** volume hebdomadaire réellement couru récemment, `null` sans historique. */
  recentWeeklyKm: number | null;
  /** Budget temps hebdomadaire déclaré, en minutes — `null` quand il n'y en a pas. */
  weeklyTimeMinutes: number | null;
  /**
   * Allure d'endurance de l'athlète, en s/km : le taux de change entre les
   * kilomètres et les minutes. `null` quand rien ne la donne (cf.
   * {@link VOLUME_TARGET_RULES.fallbackEasyPaceSecPerKm}).
   */
  easyPaceSecPerKm: number | null;
  /** L'objectif, quand c'est une course : elle impose un affûtage. */
  race: PlanRaceGoal | null;
  level: PlanLevel;
};

/**
 * Ce que le planificateur décide, là où {@link VOLUME_RULES} ne fait que
 * refuser.
 *
 * La distinction est celle d'un plancher et d'une cible : `VOLUME_RULES` dit ce
 * qui est inacceptable (une hausse de plus de 12 %), ces chiffres-ci disent ce
 * qu'on vise (7 à 9 % selon le niveau). Viser la limite reviendrait à faire
 * dépendre chaque plan d'un arrondi.
 */
export const VOLUME_TARGET_RULES = {
  /**
   * Hausse visée d'une semaine de développement à la suivante, par niveau.
   *
   * Un débutant progresse de 5 à 8 % (règle de niveau du prompt), les autres de
   * 6 à 10 %. Le haut de chaque fourchette : la semaine allégée périodique reprend
   * de toute façon une bonne part de la montée — sur un cycle de quatre semaines,
   * 1,07³ × 0,85 ne fait que +4,2 % net.
   */
  weeklyGrowth: { beginner: 1.07, intermediate: 1.08, advanced: 1.09 },
  /** Une semaine allégée toutes les quatre semaines de développement : la quatrième. */
  cutbackEvery: 4,
  /**
   * Part du budget temps que les cibles consomment.
   *
   * 95 %, quand la règle tolère 110 % : la marge n'est pas pour le confort, elle
   * absorbe l'écart entre le temps qu'une cible annonce (des kilomètres à
   * l'allure d'endurance) et celui que le plan écrit réellement (échauffements,
   * récupérations, séances de qualité). Le budget est une contrainte de vie : il
   * se tient par en dessous.
   */
  timeBudgetShare: 0.95,
  /**
   * Réserve de montée gardée sous le plafond du budget quand l'anti-plat
   * s'applique.
   *
   * C'est la résolution du conflit entre les deux contraintes : le budget
   * plafonne le volume, l'anti-plat exige un pic 10 % au-dessus de la première
   * semaine pleine. Partir *au* plafond rendrait les deux inconciliables — le
   * plan serait plat, donc refusé. On part donc 15 % plus bas, et c'est la montée
   * qui consomme la marge. Un plan qui monte vaut mieux qu'un plan qui démarre
   * haut et n'entraîne pas.
   */
  peakHeadroom: 1.15,
  /**
   * Sans historique exploitable, le volume de départ d'une première semaine
   * pleine, par niveau, en km.
   *
   * Des ordres de grandeur assumés, et volontairement bas : se tromper vers le
   * bas coûte deux semaines de montée, se tromper vers le haut blesse. La montée
   * corrige vite, et une révision recalera le plan sur les premières sorties
   * réelles.
   */
  defaultStartKm: { beginner: 12, intermediate: 24, advanced: 32 },
  /**
   * Sans allure connue, l'allure d'endurance supposée : 8:00/km.
   *
   * Lente à dessein — c'est le sens prudent. Une allure lente compte plus de
   * minutes au kilomètre, donc le budget temps plafonne le volume plus tôt : le
   * plan sort plus court que nécessaire, jamais plus long que possible.
   */
  fallbackEasyPaceSecPerKm: 480,
} as const;

/**
 * L'affûtage, en parts du dernier volume de développement — une par semaine
 * d'affûtage, strictement décroissantes.
 *
 * Rapportées à la **dernière semaine de développement** et non au pic : quand
 * celle-ci est une semaine allégée, un affûtage calé sur le pic pourrait
 * commencer *au-dessus* d'elle, ce que la règle d'affûtage (« le volume baisse
 * strictement chaque semaine ») refuse. La semaine de course reste sous 55 % de
 * cette base, donc sous les 65 % du pic qu'exige {@link VOLUME_RULES}.
 */
function taperFactors(weeks: number): number[] {
  if (weeks <= 1) return [0.55];
  if (weeks === 2) return [0.75, 0.55];
  return [0.8, 0.65, 0.5];
}

/**
 * Un volume arrondi au dixième **strictement inférieur** : aucune cible ne se
 * pose jamais pile sur un plafond.
 *
 * Les deux raisons de ne pas se contenter d'un `Math.floor`, et la seconde est
 * la vraie :
 *
 * - `72 × 0,85` vaut 61,199999999999996 en flottant, dont le produit par 10 se
 *   réarrondit à 612 : `Math.floor` rendrait 61,2, soit *au-dessus* de la valeur
 *   qu'il devait plafonner ;
 * - même juste, une cible posée à l'égalité (36,0 km pour un plafond de 36,0)
 *   ne laisse rien à la somme qui la vérifiera. Un volume hebdomadaire est une
 *   somme de flottants — six séances à un décimale ne retombent pas exactement
 *   sur leur total — et un cheveu au-dessus suffit à faire refuser une semaine
 *   parfaitement conforme. Constaté sur le test exhaustif, sur les semaines
 *   allégées qui tombaient pile à 85 %.
 *
 * Un dixième de kilomètre de marge : invisible dans un plan, définitif pour une
 * inégalité.
 */
function floorKm(value: number): number {
  return Math.floor((value - 1e-9) * 10) / 10;
}

/**
 * Les volumes hebdomadaires cibles d'un plan entier, une entrée par semaine.
 *
 * L'algorithme, dans l'ordre :
 *
 * 1. **Le départ.** Le plus petit de deux plafonds : l'ancrage sur le réel
 *    ({@link firstFullWeekMaxKm} — au plus 1,2 × la meilleure semaine récente, ou
 *    +3 km), et ce que le budget temps permet une fois la réserve de montée
 *    gardée ({@link VOLUME_TARGET_RULES.peakHeadroom}). Sans historique, un
 *    départ prudent par niveau.
 * 2. **La montée.** Chaque semaine de développement vaut la précédente × la
 *    hausse du niveau, **plafonnée au budget** : c'est le budget qui contraint la
 *    montée, jamais l'inverse. Toutes les quatre semaines, une semaine allégée à
 *    85 % de la précédente — mais seulement là où la règle l'exige, un bloc court
 *    n'a pas de respiration à s'offrir.
 * 3. **L'affûtage** ({@link taperFactors}), quand le plan mène à une course.
 * 4. **La première semaine entamée**, au prorata des jours qui y restent.
 *
 * Tous les arrondis vont vers le bas : chaque cible est un chiffre que la
 * validation vérifiera, et un dixième de kilomètre de trop suffit à faire
 * dépasser un plafond.
 */
export function weeklyVolumeTargets(params: WeeklyVolumeTargetsParams): WeeklyVolumeTarget[] {
  const { weeks, firstWeekFromDay, level } = params;
  if (weeks <= 0) return [];

  const paceMinPerKm = (params.easyPaceSecPerKm ?? VOLUME_TARGET_RULES.fallbackEasyPaceSecPerKm) / 60;
  const firstFull = firstWeekFromDay > 1 ? 1 : 0;
  const taper = taperWeekCount(weeks, params.race);
  const lastBuild = weeks - taper - 1;
  const buildWeeks = lastBuild - firstFull + 1;

  // Les mêmes conditions que les règles correspondantes : hors d'elles, la règle
  // ne s'applique pas, et la satisfaire coûterait des semaines pour rien.
  const eases =
    weeks >= VOLUME_RULES.minWeeksForCutback && buildWeeks >= VOLUME_RULES.minBuildWeeksForCutback;
  const mustClimb =
    weeks >= VOLUME_RULES.minWeeksForPeak && buildWeeks >= VOLUME_RULES.minBuildWeeksForPeak;

  const budgetKm =
    params.weeklyTimeMinutes === null || params.weeklyTimeMinutes <= 0
      ? null
      : (params.weeklyTimeMinutes * VOLUME_TARGET_RULES.timeBudgetShare) / paceMinPerKm;

  const anchorKm =
    params.recentWeeklyKm !== null && params.recentWeeklyKm > 0
      ? firstFullWeekMaxKm(params.recentWeeklyKm)
      : VOLUME_TARGET_RULES.defaultStartKm[level];

  const start = floorKm(
    budgetKm === null
      ? anchorKm
      : Math.min(anchorKm, budgetKm / (mustClimb ? VOLUME_TARGET_RULES.peakHeadroom : 1)),
  );

  const kilometers = new Array<number>(weeks).fill(start);
  const kinds = new Array<WeeklyVolumeTargetKind>(weeks).fill('build');

  for (let index = firstFull + 1; index <= lastBuild; index += 1) {
    const previous = kilometers[index - 1];
    const isCutback =
      eases && (index - firstFull) % VOLUME_TARGET_RULES.cutbackEvery === VOLUME_TARGET_RULES.cutbackEvery - 1;
    if (isCutback) {
      kilometers[index] = floorKm(previous * VOLUME_RULES.cutbackRatio);
      kinds[index] = 'cutback';
      continue;
    }
    const raised = previous * VOLUME_TARGET_RULES.weeklyGrowth[level];
    kilometers[index] = floorKm(budgetKm === null ? raised : Math.min(raised, budgetKm));
  }

  // L'affûtage se cale sur la dernière semaine de développement — ou sur le
  // départ quand le plan est trop court pour en compter une.
  const taperFrom = weeks - taper;
  const base = lastBuild >= firstFull ? kilometers[lastBuild] : start;
  const factors = taperFactors(taper);
  for (let index = Math.max(taperFrom, firstFull); index < weeks; index += 1) {
    kilometers[index] = floorKm(base * factors[index - taperFrom]);
    kinds[index] = index === weeks - 1 ? 'race' : 'taper';
  }

  const remainingDays = remainingWeekDays(firstWeekFromDay);
  if (firstFull === 1) {
    kilometers[0] = floorKm((start * remainingDays) / 7);
    kinds[0] = 'partial';
  }

  return kilometers.map((targetKm, index) => {
    // Le budget d'une semaine entamée est celui de ses jours restants — la même
    // arithmétique que la règle qui le vérifiera ({@link partialWeekTimeBudget}).
    const share = index === 0 && firstFull === 1 ? remainingDays / 7 : 1;
    const budgetMinutes =
      params.weeklyTimeMinutes === null
        ? null
        : Math.floor(params.weeklyTimeMinutes * VOLUME_TARGET_RULES.timeBudgetShare * share);
    const minutes = Math.round(targetKm * paceMinPerKm);

    return {
      targetKm,
      targetMinutes: budgetMinutes === null ? minutes : Math.min(minutes, budgetMinutes),
      kind: kinds[index],
    };
  });
}

/*
 * Décomposition d'une cible hebdomadaire entre les séances — le même
 * raisonnement, un cran plus bas.
 *
 * Les volumes cibles ont réglé la question « combien la semaine 7 doit-elle
 * peser ». Les premiers plans de production montrent que la suivante n'est pas
 * réglée pour autant : cibles de 27 à 37 km, semaines écrites de 44 à 70,
 * convergence en plusieurs reprises. Le modèle ne désobéit pas — il n'arrive pas
 * à poser « 27 km sur 6 séances dont une sortie longue de 20 à 40 % et une
 * séance de qualité ». C'est une division, pas un jugement d'entraîneur : elle
 * se calcule ici, une fois, et le prompt en donne le résultat.
 *
 * La décomposition reste **indicative** : aucune règle ne la vérifie séance par
 * séance, et le modèle garde la main sur la répartition — c'est la bande de
 * ±10 % autour de la cible hebdomadaire qui juge, comme avant. Ce qu'elle change
 * est le point de départ du modèle : une arithmétique faite plutôt qu'une
 * arithmétique à faire.
 */

/** Ce que la décomposition pose sur chaque type de séance, en part du volume hebdomadaire. */
export const SESSION_BUDGET_SHARES = {
  /**
   * La sortie longue : 30 %, le milieu de la fourchette 28-32 % qu'un plan
   * équilibré lui donne — et une part que {@link VOLUME_RULES.longRunShare}
   * accepte partout (20 à 40 %), quelle que soit la semaine.
   */
  longRun: 0.3,
  /**
   * Une séance de qualité, **échauffement et récupérations comprises** : 16 %.
   *
   * Le milieu de 15-18 %. C'est le total de la séance qui compte ici, pas son
   * corps : le contrat demande au modèle de déclarer la distance totale d'une
   * séance à déroulé, et une VMA de 5 km de corps en fait 9 avec son enveloppe.
   */
  quality: 0.16,
} as const;

/** Un budget de séance, au demi-kilomètre — jamais sous la plus petite distance du contrat. */
function halfKm(value: number): number {
  return Math.max(PLAN_OUTPUT_BOUNDS.distanceKm.min, Math.round(value * 2) / 2);
}

/** Un kilométrage au dixième : la précision des cibles, et celle qui les fait tomber juste. */
function tenthKm(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * La cible d'une semaine, répartie entre ses séances — sortie longue en tête,
 * puis les séances de qualité, puis les footings.
 *
 * L'arithmétique, dans l'ordre :
 *
 * 1. chaque séance de qualité prend {@link SESSION_BUDGET_SHARES.quality} ;
 * 2. la sortie longue prend {@link SESSION_BUDGET_SHARES.longRun} du volume,
 *    **relevée** quand le partage égal du reste ferait un footing plus long
 *    qu'elle — au rapport de 1,6 que la règle retient déjà
 *    ({@link longRunMaxShare}) —, et **plafonnée** à ce que cette même règle
 *    laisse à une semaine de ce nombre de séances ;
 * 3. **ce qui reste** se partage entre les footings — pas leur part théorique :
 *    c'est ce qui fait tomber la somme sur la cible.
 *
 * Les arrondis, et pourquoi ils ne tombent pas au même endroit : la sortie
 * longue et les séances de qualité s'arrondissent au demi-kilomètre — ce sont
 * les séances qu'un coureur lit, « 4,5 km » vaut mieux que « 4,4 km » —, les
 * footings au dixième, parce qu'ils sont les derniers servis et que la somme
 * doit retomber sur la cible. Une aide au calcul dont les chiffres ne font pas
 * leur total ne sert à rien : le modèle recopierait un plan systématiquement
 * sous la cible.
 *
 * Ce sont bien les **footings** qui absorbent, et pas la dernière séance, parce
 * que le prompt imprime un chiffre par *groupe* de séances : un footing
 * rallongé de 0,7 km serait invisible dans « 4 footings ~3,5 km », alors que
 * les répartir tous laisse au plus un dixième d'écart entre le groupe et la
 * somme réelle.
 *
 * Fonction **pure**, appelée pour écrire le prompt et éprouvée telle quelle.
 *
 * @param targetKm la cible hebdomadaire, telle que {@link weeklyVolumeTargets}
 * la chiffre et que le prompt l'annonce.
 * @param hasQuality le nombre de séances de qualité attendues (0, 1 ou 2) —
 * ramené à `sessionsPerWeek − 2` s'il n'y a pas la place : une semaine garde
 * toujours un footing à côté de sa sortie longue, c'est la distribution
 * polarisée.
 * @param longRunShare la part visée par la sortie longue, pour les cas où
 * l'appelant en sait plus que le réglage par défaut.
 */
export function weeklySessionBudgets(
  targetKm: number,
  sessionsPerWeek: number,
  hasQuality: number,
  longRunShare: number = SESSION_BUDGET_SHARES.longRun,
): SessionBudget[] {
  if (targetKm <= 0 || sessionsPerWeek <= 0) return [];
  // Une séance unique EST la sortie longue : il n'y a rien à répartir.
  if (sessionsPerWeek === 1) return [{ role: 'long', km: tenthKm(targetKm) }];

  const quality = Math.min(Math.max(0, Math.trunc(hasQuality)), sessionsPerWeek - 2);
  const easyCount = sessionsPerWeek - 1 - quality;

  const rest = 1 - quality * SESSION_BUDGET_SHARES.quality;
  // La sortie longue est la plus longue séance de la semaine : sur peu de
  // séances, le partage égal du reste la dépasserait.
  const balanced = (rest * LONG_RUN_SESSION_FACTOR) / (easyCount + LONG_RUN_SESSION_FACTOR);
  const share = Math.min(Math.max(longRunShare, balanced), longRunMaxShare(sessionsPerWeek));

  // La fourchette de la règle, arrondie du côté qui la satisfait (cf. `kmAtMost`) :
  // l'arrondi au demi-kilomètre ne peut pas faire sortir la sortie longue de ce
  // qui lui est permis.
  const floor = Math.ceil(targetKm * VOLUME_RULES.longRunShare.min * 10) / 10;
  const ceiling = Math.floor(targetKm * longRunMaxShare(sessionsPerWeek) * 10) / 10;
  const longKm = Math.min(Math.max(halfKm(targetKm * share), floor), ceiling);

  const qualityKm = halfKm(targetKm * SESSION_BUDGET_SHARES.quality);
  const budgets: SessionBudget[] = [
    { role: 'long', km: longKm },
    ...Array.from({ length: quality }, () => ({ role: 'quality' as const, km: qualityKm })),
  ];

  // Les footings se partagent ce qui reste, au dixième — le dernier prend le
  // reliquat de la division, qui ne peut valoir qu'un dixième de kilomètre.
  let remaining = tenthKm(targetKm - longKm - quality * qualityKm);
  for (let index = 0; index < easyCount; index += 1) {
    const km =
      index === easyCount - 1
        ? Math.max(PLAN_OUTPUT_BOUNDS.distanceKm.min, tenthKm(remaining))
        : Math.max(PLAN_OUTPUT_BOUNDS.distanceKm.min, tenthKm(remaining / (easyCount - index)));
    budgets.push({ role: 'easy', km });
    remaining = tenthKm(remaining - km);
  }

  return budgets;
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
  context: PlanValidationContext,
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

  // 0. Les cibles de volume, quand l'appli en a chiffré : la règle dont toutes
  // les suivantes découlent, puisque les cibles les satisfont par construction.
  const targets = expected.weeklyTargets ?? null;
  if (targets !== null) {
    const tolerance = VOLUME_RULES.targetTolerance;
    volumes.forEach((volume, index) => {
      const target = targets[index];
      if (volume === null || target === undefined) return;

      const floor = target.targetKm * (1 - tolerance);
      const ceiling = target.targetKm * (1 + tolerance);
      if (volume >= floor && volume <= ceiling) return;

      violations.push(
        `Semaine ${index + 1} : ${km(volume)} pour une cible de ${km(target.targetKm)} — ` +
          `chaque semaine reste à ${percent(tolerance)} près de sa cible, soit entre ` +
          `${kmAtLeast(floor)} et ${kmAtMost(ceiling)}.`,
      );
    });
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

  // 4. Ancrage de la première semaine pleine sur le volume réellement couru.
  //
  // Créations uniquement : à l'ajustement comme à la révision, c'est le plan en
  // cours qui fait foi, pas l'historique d'avant-plan — un athlète six semaines
  // dans un bloc court légitimement plus que ce que ses semaines d'avant
  // disaient, et lui opposer ce passé-là ferait reculer son plan.
  const recentWeeklyKm = context.recentWeeklyKm ?? null;
  if (
    expected.scope === 'creation' &&
    recentWeeklyKm !== null &&
    recentWeeklyKm > 0 &&
    firstFullVolume !== null
  ) {
    const ceiling = firstFullWeekMaxKm(recentWeeklyKm);
    if (firstFullVolume > ceiling) {
      violations.push(
        `Semaine ${firstFull + 1} : ${km(firstFullVolume)} pour une première semaine pleine — ` +
          `ta meilleure semaine récente fait ${km(recentWeeklyKm)} ; la première semaine pleine ` +
          `reste sous ${kmAtMost(ceiling)}.`,
      );
    }
  }

  // 5. Affûtage : les dernières semaines descendent, celle de la course le plus.
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

  // 6. Poids de la sortie longue dans sa semaine.
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

  violations.push(...weeklyTimeViolations(weeks, expected, context));

  return violations;
}

/**
 * En deçà de ce nombre de jours restants, une **première semaine entamée** est
 * trop courte pour être traitée comme une semaine d'entraînement.
 *
 * Le seuil est partagé par tous ceux qui ont à juger une semaine entamée :
 * `firstWeekCountsAsPlanWeek` (`plan-service.ts`) décide avec lui si la semaine
 * du départ compte comme une semaine du plan, et le budget temps s'il y a un
 * plafond à y contrôler ({@link partialWeekTimeBudget}). Deux seuils divergents
 * produiraient des semaines comptées d'un côté et exemptées de l'autre.
 *
 * Quatre jours, soit un départ (ou une reprise) du lundi au jeudi : la semaine
 * porte alors assez de séances pour valoir une semaine, sortie longue du week-end
 * comprise.
 */
export const MIN_FIRST_WEEK_DAYS = 4;

/** Jours qu'il reste dans une semaine reprise le jour ISO `firstWeekFromDay`. */
function remainingWeekDays(firstWeekFromDay: number): number {
  return 8 - firstWeekFromDay;
}

/**
 * Le budget temps d'une **première semaine entamée**, en minutes, au prorata des
 * jours qui y restent — `null` quand il n'y a rien à contrôler.
 *
 * Deux raisons de rendre `null`, et la seconde est le correctif : pas de budget
 * déclaré, ou une semaine de moins de {@link MIN_FIRST_WEEK_DAYS} jours. Constaté
 * en production : un ajustement lancé un samedi reprend le dimanche
 * (`firstWeekFromDay = 7`), et 2 h de budget se prorataient en 17 min — alors que
 * la règle de sortie longue exige une sortie longue ce dimanche-là. Aucune
 * semaine ne pouvait satisfaire les deux, et les trois tentatives étaient perdues
 * d'avance. En dessous du seuil, le prorata devient plus petit qu'une séance
 * normale : la contrainte n'a plus de sens, elle ne s'applique pas.
 *
 * Exportée pour que le prompt annonce **exactement** le plafond que la règle
 * vérifiera (cf. {@link formatPartialWeekTimeBudget}) : deux arithmétiques
 * feraient refuser un plan qui applique la consigne à la lettre.
 *
 * @param weeklyTimeMinutes le budget hebdomadaire déclaré, `null` s'il n'y en a pas.
 * @param firstWeekFromDay le jour ISO à partir duquel la semaine porte des séances.
 */
export function partialWeekTimeBudget(
  weeklyTimeMinutes: number | null,
  firstWeekFromDay: number,
): number | null {
  if (weeklyTimeMinutes === null || weeklyTimeMinutes <= 0) return null;

  const remainingDays = remainingWeekDays(firstWeekFromDay);
  if (remainingDays < MIN_FIRST_WEEK_DAYS) return null;

  return (weeklyTimeMinutes * remainingDays) / 7;
}

/**
 * Ce même plafond **tel qu'il s'écrit dans un prompt**, arrondi du côté
 * satisfiable ({@link hoursAtMost}) — `null` quand il n'y a rien à annoncer.
 *
 * Sans cette ligne, la consigne était muette : le modèle recevait un budget
 * hebdomadaire, produisait une semaine entamée à sa mesure, et se faisait refuser
 * par un plafond qu'il n'avait aucun moyen de deviner.
 */
export function formatPartialWeekTimeBudget(
  weeklyTimeMinutes: number | null,
  firstWeekFromDay: number,
): string | null {
  const budget = partialWeekTimeBudget(weeklyTimeMinutes, firstWeekFromDay);
  return budget === null ? null : hoursAtMost(budget);
}

/**
 * 7. Le budget temps hebdomadaire déclaré par l'athlète, tenu semaine par
 * semaine.
 *
 * C'est une contrainte de **vie**, pas d'entraînement : elle vaut donc sur
 * toutes les semaines du plan, affûtage compris — et sur la première semaine
 * entamée elle aussi, **au prorata des jours qui y restent** dès que la semaine
 * en porte assez ({@link partialWeekTimeBudget}). Une semaine amputée de trois
 * jours ne consomme pas le budget d'une semaine entière, mais elle n'ouvre pas
 * non plus un droit de tout y concentrer.
 *
 * Semaine dont une seule séance ne déclare pas sa durée : aucun contrôle (cf.
 * {@link weekDurationMin}). Le régime avec table d'allures les pose toutes, donc
 * ce silence ne couvre en pratique que les plans ciblés en zones cardiaques.
 */
function weeklyTimeViolations(
  weeks: readonly PlanWeekOutput[],
  expected: PlanExpectations,
  context: PlanValidationContext,
): string[] {
  const budget = context.weeklyTimeMinutes ?? null;
  if (budget === null || budget <= 0) return [];

  const violations: string[] = [];
  const firstWeekFromDay = expected.firstWeekFromDay ?? 1;
  const remainingDays = remainingWeekDays(firstWeekFromDay);

  weeks.forEach((week, index) => {
    const total = weekDurationMin(week);
    if (total === null) return;

    const isPartial = index === 0 && firstWeekFromDay > 1;
    const prorated = isPartial ? partialWeekTimeBudget(budget, firstWeekFromDay) : null;
    // Semaine entamée trop courte pour qu'un plafond ait du sens : exemptée.
    if (isPartial && prorated === null) return;

    const weekBudget = prorated ?? budget;
    const ceiling = weekBudget * VOLUME_RULES.weeklyTimeTolerance;
    if (total <= ceiling) return;

    const where =
      prorated === null
        ? `Semaine ${index + 1}`
        : `Semaine 1 (déjà entamée, ${remainingDays} jour${remainingDays > 1 ? 's' : ''} restant${remainingDays > 1 ? 's' : ''})`;
    const declared =
      prorated === null ? hours(budget) : `${hours(budget)} ramené à ${hoursAtMost(prorated)} au prorata`;

    violations.push(
      `${where} : ${hoursAtLeast(total)} d'entraînement pour un budget déclaré de ${declared} — ` +
        `réduis distances ou séances (${hoursAtMost(ceiling)} au plus, tolérance comprise).`,
    );
  });

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
 * Ce que la validation sait de l'athlète, au-delà du plan proposé : ce à quoi
 * les allures sont confrontées, et les deux réalités qu'un plan ne peut pas
 * ignorer — le temps dont elle dispose, et ce qu'elle court réellement.
 *
 * Pour les allures, les deux sources sont exclusives dans les faits — quand la
 * table existe, c'est elle qui prescrit — mais l'appelant fournit ce qu'il a :
 * le service passe les deux, le corridor choisit ({@link paceCorridor}).
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
  /**
   * Temps d'entraînement hebdomadaire de l'athlète, en minutes — `null` ou
   * absent quand elle n'en a pas déclaré, et rien n'est alors contrôlé.
   *
   * Fourni sur les trois chemins (génération, ajustement, révision) : c'est une
   * contrainte de vie, elle ne cesse pas de valoir parce qu'un plan est en
   * cours.
   *
   * C'est le budget **effectif de la tentative jugée**, pas celui du plan
   * stocké : une sortie qui patche `settings.weeklyTimeMinutes` doit être jugée
   * sur le budget qu'elle déclare ({@link resolveWeeklyTimeBudget}), sans quoi
   * un élargissement demandé par l'athlète est réputé violé à chaque tentative.
   */
  weeklyTimeMinutes?: number | null;
  /**
   * Le **meilleur** volume hebdomadaire réellement couru récemment, en km —
   * `null`, absent ou `0` quand il n'y a pas d'historique, et le départ n'est
   * alors ancré à rien.
   *
   * Fourni à la **génération seule** : un ajustement ou une révision jugent la
   * suite d'un plan que l'athlète suit déjà, et son volume d'avant-plan n'a plus
   * rien à y dire.
   */
  recentWeeklyKm?: number | null;
};

/**
 * Le budget temps sur lequel une **sortie** se juge, en minutes — `null` quand
 * il n'y a rien à contrôler.
 *
 * Une modification et une révision peuvent changer le budget en même temps
 * qu'elles réécrivent les semaines (« je peux courir 4 h par semaine
 * maintenant ») : juger ces semaines-là contre le budget **stocké** les
 * déclarerait en violation à chaque tentative, et condamnerait l'ajustement aux
 * trois échecs. C'est donc la sortie qui décide, en trois états :
 *
 * - clé **absente** : l'instruction ne touche pas au budget → celui du plan ;
 * - clé à **`null`** : la contrainte est levée → plus aucun contrôle ;
 * - clé à une **valeur** : c'est le nouveau budget, et c'est lui qui juge.
 *
 * Les trois états sont exactement ceux que `PlanSettingsPatch` écrit en base :
 * la sortie est jugée sur le budget qu'elle va faire enregistrer, jamais sur un
 * autre.
 *
 * @param settings le patch de réglages de la sortie, `undefined` quand elle n'en
 * porte pas (une création, une révision qui conserve le plan).
 * @param stored le budget du plan tel qu'il est en base, `null` s'il n'en a pas.
 */
export function resolveWeeklyTimeBudget(
  settings: PlanSettingsOutput | undefined,
  stored: number | null,
): number | null {
  if (settings?.weeklyTimeMinutes === undefined) return stored;
  return settings.weeklyTimeMinutes;
}

/**
 * Ce qui, dans le plan proposé, contredit ce qui a été demandé.
 *
 * Retourne des phrases **en français**, telles quelles renvoyées au modèle pour
 * qu'il se corrige (cf. le retry de `plan-service.ts`) : elles sont écrites pour
 * être lues par lui, pas par un développeur. Liste vide = plan conforme.
 *
 * @param context ce que la validation sait de l'athlète ({@link
 * PlanValidationContext}) : la table VDOT si elle a donné un chrono, son allure
 * récente sinon, son budget temps hebdomadaire et son volume réel récent. Chaque
 * champ absent désarme la règle qu'il porte, jamais les autres — sans allure de
 * référence, aucune allure n'est jugée (le prompt impose alors de cibler par
 * zones cardiaques) ; sans budget déclaré, le temps n'est pas compté.
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
  violations.push(...volumeViolations(weeks, expected, context));

  return violations;
}
