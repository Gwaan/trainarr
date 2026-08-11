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
import { PLAN_STEP_BOUNDS, PLAN_STEP_ROLES, planSessionStepsSchema } from '@/lib/plan-steps/schema';

import { formatIsoDay, formatPace } from './format';

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
function normalizeKind(kind: string): string {
  return kind
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase();
}

function isIntensitySession(session: PlanSessionOutput): boolean {
  const kind = normalizeKind(session.kind);
  return INTENSITY_KIND_ROOTS.some((root) => kind.includes(root));
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

/** Les allures admissibles pour une athlète, en s/km. */
type PaceCorridor = { reference: number; min: number; max: number };

/** Le corridor dérivé de l'allure de référence, ou `null` quand elle est inconnue. */
function paceCorridor(referencePaceSecPerKm: number | null): PaceCorridor | null {
  if (referencePaceSecPerKm === null) return null;
  return {
    reference: referencePaceSecPerKm,
    min: referencePaceSecPerKm - PACE_CORRIDOR_MARGINS.faster,
    max: referencePaceSecPerKm + PACE_CORRIDOR_MARGINS.slower,
  };
}

/**
 * Toutes les allures que la séance prescrit : sa cible globale d'abord, puis les
 * bornes de chaque étape dans l'ordre du déroulé.
 */
function sessionPrescribedPaces(session: PlanSessionOutput): number[] {
  const paces: number[] = [];
  if (session.targetPaceSecPerKm !== undefined) paces.push(session.targetPaceSecPerKm);

  for (const block of session.steps ?? []) {
    for (const step of block.steps) {
      if (step.paceMinSecPerKm !== null) paces.push(step.paceMinSecPerKm);
      if (step.paceMaxSecPerKm !== null) paces.push(step.paceMaxSecPerKm);
    }
  }
  return paces;
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
  const outlier = sessionPrescribedPaces(session).find(
    (pace) => pace < corridor.min || pace > corridor.max,
  );
  if (outlier === undefined) return null;

  return (
    `${label}, séance du ${formatIsoDay(session.day)} (${session.kind}) : allure ${formatPace(outlier)} ` +
    `hors de la fourchette plausible [${formatPace(corridor.min)} – ${formatPace(corridor.max)}] ` +
    `dérivée de l'allure récente de l'athlète (${formatPace(corridor.reference)}).`
  );
}

/**
 * Ce qui, dans le plan proposé, contredit ce qui a été demandé.
 *
 * Retourne des phrases **en français**, telles quelles renvoyées au modèle pour
 * qu'il se corrige (cf. le retry de `plan-service.ts`) : elles sont écrites pour
 * être lues par lui, pas par un développeur. Liste vide = plan conforme.
 *
 * @param referencePaceSecPerKm allure d'entraînement récente de l'athlète, celle
 * dont le prompt fait dériver toutes les autres. Fournie, elle ouvre le corridor
 * de plausibilité ({@link PACE_CORRIDOR_MARGINS}) ; absente ou `null`, aucune
 * allure n'est jugée — le prompt impose alors de cibler par zones cardiaques,
 * et il n'existe plus rien à quoi comparer.
 */
export function validatePlanBusinessRules(
  weeks: readonly PlanWeekOutput[],
  expected: PlanExpectations,
  referencePaceSecPerKm: number | null = null,
): string[] {
  const corridor = paceCorridor(referencePaceSecPerKm);
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

  return violations;
}
