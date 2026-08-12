/**
 * Contrat des **séances structurées en étapes** : « 1 km d'échauffement, puis
 * 3 × 2 km à 4:30–4:40/km avec 2 min de récupération ».
 *
 * Module **pur** — ni base, ni réseau, ni `server-only` : il est importé aussi
 * bien par le DAL (validation avant écriture en `jsonb`) que par les composants
 * d'affichage, et c'est la même définition qui servira à la génération par le
 * coach et à la synchronisation vers intervals.icu.
 *
 * ## Ce que la structure autorise, et pourquoi
 *
 * - **Une mesure par étape, jamais deux** : une étape se court soit sur une
 *   distance, soit sur une durée. Porter les deux obligerait à trancher laquelle
 *   fait foi le jour J, et à inventer une allure pour les réconcilier.
 * - **Allure *ou* zone cardiaque, jamais les deux** : deux cibles simultanées se
 *   contredisent dès la première côte. Aucune des deux n'est obligatoire — un
 *   footing n'a pas de cible.
 * - **Pas de répétition imbriquée** : un bloc répète une suite d'étapes, et un
 *   bloc ne contient pas de bloc. C'est la limite d'intervals.icu, destinataire
 *   de ces séances ; l'accepter ici évite d'avoir à l'aplatir (avec pertes) à
 *   l'export.
 * - **Une note tient sur une ligne** : la sérialisation vers intervals.icu est
 *   un format ligne à ligne, où un retour à la ligne dans une consigne ouvrirait
 *   une fausse étape — et une ligne vide découperait un bloc répété en deux. La
 *   contrainte est posée ici, à la source, plutôt que rattrapée à l'export.
 */

import { z } from 'zod';

/** Rôle d'une étape dans la séance — il pilote l'affichage et la couleur. */
export const PLAN_STEP_ROLES = ['warmup', 'run', 'recover', 'cooldown'] as const;

export type PlanStepRole = (typeof PLAN_STEP_ROLES)[number];

/**
 * Bornes de plausibilité.
 *
 * Elles ne décrivent pas ce qui est physiologiquement possible mais ce qui est
 * *crédible dans une séance planifiée* : au-delà, c'est une hallucination du
 * modèle ou une unité confondue (des secondes prises pour des minutes, des
 * kilomètres pour des mètres), et mieux vaut refuser que stocker.
 */
export const PLAN_STEP_BOUNDS = {
  /** 10 m (une ligne droite de récup) à 100 km (un ultra tient dans une étape). */
  distanceM: { min: 10, max: 100_000 },
  /** 5 s à 6 h. */
  durationS: { min: 5, max: 21_600 },
  /** 2:00/km (record du monde du 10 km) à 12:00/km (marche rapide). */
  paceSecPerKm: { min: 120, max: 720 },
  /**
   * Rang de zone cardiaque, de 1 à 5.
   *
   * C'est un **ordinal**, pas une référence à une table : les bornes en
   * battements ne sont jamais stockées ici. La **prescription** les résout à
   * l'affichage et à la publication depuis `lib/metrics/hr-targets` (zone 2 =
   * endurance fondamentale, 65–79 % de FC max chez Daniels) ; l'**analyse** du
   * temps passé en zone partitionne de son côté sur les bornes de
   * `lib/metrics/hr-zones`. Les deux tables sont documentées l'une par l'autre.
   */
  hrZone: { min: 1, max: 5 },
  /** 20 répétitions : au-delà, c'est un bloc mal découpé. */
  repeat: { min: 1, max: 20 },
  /** Un bloc répète une poignée d'étapes (typiquement effort + récup). */
  stepsPerBlock: { min: 1, max: 20 },
  /** Échauffement, corps de séance, retour au calme… 40 laisse large. */
  blocksPerSession: { min: 1, max: 40 },
  noteChars: 200,
} as const;

/** Suites de blancs, retours à la ligne compris. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Une consigne ramenée sur une seule ligne : blancs écrasés, extrémités
 * détourées.
 */
export function toSingleLine(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Une étape d'une séance structurée.
 *
 * Toutes les clés sont présentes, éventuellement à `null` : un champ absent et
 * un champ nul se liraient pareil côté affichage, mais pas côté `jsonb` — une
 * forme unique évite d'avoir à tester les deux partout.
 */
const planStepSchema = z
  .object({
    role: z.enum(PLAN_STEP_ROLES),
    distanceM: z
      .number()
      .min(PLAN_STEP_BOUNDS.distanceM.min)
      .max(PLAN_STEP_BOUNDS.distanceM.max)
      .nullable(),
    durationS: z
      .number()
      .int()
      .min(PLAN_STEP_BOUNDS.durationS.min)
      .max(PLAN_STEP_BOUNDS.durationS.max)
      .nullable(),
    /** Borne basse de l'allure cible, en s/km (plus petit = plus rapide). */
    paceMinSecPerKm: z
      .number()
      .int()
      .min(PLAN_STEP_BOUNDS.paceSecPerKm.min)
      .max(PLAN_STEP_BOUNDS.paceSecPerKm.max)
      .nullable(),
    paceMaxSecPerKm: z
      .number()
      .int()
      .min(PLAN_STEP_BOUNDS.paceSecPerKm.min)
      .max(PLAN_STEP_BOUNDS.paceSecPerKm.max)
      .nullable(),
    hrZone: z
      .number()
      .int()
      .min(PLAN_STEP_BOUNDS.hrZone.min)
      .max(PLAN_STEP_BOUNDS.hrZone.max)
      .nullable(),
    /**
     * Consigne courte affichée telle quelle (« footing très souple »).
     *
     * Ramenée à une seule ligne avant validation : la longueur se juge sur le
     * texte réellement stocké, et une note qui ne contenait que des blancs est
     * refusée par `min(1)` plutôt que stockée vide.
     */
    note: z
      .string()
      .transform(toSingleLine)
      .pipe(z.string().min(1).max(PLAN_STEP_BOUNDS.noteChars))
      .nullable(),
  })
  .superRefine((step, ctx) => {
    if ((step.distanceM === null) === (step.durationS === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'une étape se mesure soit en distance, soit en durée — exactement une des deux.',
      });
    }

    const hasPace = step.paceMinSecPerKm !== null || step.paceMaxSecPerKm !== null;

    if ((step.paceMinSecPerKm === null) !== (step.paceMaxSecPerKm === null)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'une allure cible porte ses deux bornes (allure unique : les deux bornes égales).',
      });
    } else if (
      step.paceMinSecPerKm !== null &&
      step.paceMaxSecPerKm !== null &&
      step.paceMinSecPerKm > step.paceMaxSecPerKm
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'bornes d’allure inversées : la borne rapide doit précéder la borne lente.',
      });
    }

    if (hasPace && step.hrZone !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'allure et zone cardiaque sont exclusives — une seule cible par étape.',
      });
    }
  });

/**
 * Un bloc d'étapes, répété `repeat` fois (1 = pas de répétition).
 *
 * Pas d'imbrication : `steps` ne contient que des étapes, jamais un bloc.
 */
const planStepBlockSchema = z.object({
  repeat: z.number().int().min(PLAN_STEP_BOUNDS.repeat.min).max(PLAN_STEP_BOUNDS.repeat.max),
  steps: z
    .array(planStepSchema)
    .min(PLAN_STEP_BOUNDS.stepsPerBlock.min)
    .max(PLAN_STEP_BOUNDS.stepsPerBlock.max),
});

/** Le contenu structuré d'une séance : suite ordonnée de blocs, au moins un. */
export const planSessionStepsSchema = z
  .array(planStepBlockSchema)
  .min(PLAN_STEP_BOUNDS.blocksPerSession.min)
  .max(PLAN_STEP_BOUNDS.blocksPerSession.max);

export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanStepBlock = z.infer<typeof planStepBlockSchema>;
export type PlanSessionSteps = z.infer<typeof planSessionStepsSchema>;

/**
 * Déroule les blocs : chaque bloc rend ses étapes `repeat` fois, dans l'ordre.
 *
 * C'est la vue « liste » d'une séance, celle qu'on affiche ligne à ligne et
 * celle sur laquelle les totaux se calculent.
 */
export function flattenSteps(steps: PlanSessionSteps): PlanStep[] {
  const flattened: PlanStep[] = [];

  for (const block of steps) {
    for (let repetition = 0; repetition < block.repeat; repetition += 1) {
      flattened.push(...block.steps);
    }
  }

  return flattened;
}

/**
 * Distance et durée totales d'une séance structurée, répétitions comprises.
 *
 * Chaque total vaut `null` dès qu'**une seule** étape est mesurée dans l'autre
 * unité : convertir une durée en distance (ou l'inverse) exigerait une allure
 * dont on n'a pas la certitude, et l'appli ne produit pas de métrique inventée.
 * Une séance « 1 km d'échauffement puis 3 × 2 min » n'a donc ni distance ni
 * durée totale — c'est la réponse honnête.
 */
export function sessionStepsTotals(steps: PlanSessionSteps): {
  distanceM: number | null;
  durationS: number | null;
} {
  const flattened = flattenSteps(steps);

  let distanceM = 0;
  let durationS = 0;
  let allDistance = true;
  let allDuration = true;

  for (const step of flattened) {
    if (step.distanceM === null) allDistance = false;
    else distanceM += step.distanceM;

    if (step.durationS === null) allDuration = false;
    else durationS += step.durationS;
  }

  return {
    // Arrondi au millimètre : une somme de flottants sort sinon en
    // `12400.000000000002`, qui n'est pas une précision mais un artefact.
    distanceM: allDistance ? Math.round(distanceM * 1000) / 1000 : null,
    durationS: allDuration ? durationS : null,
  };
}
