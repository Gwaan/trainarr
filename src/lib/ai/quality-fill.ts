import 'server-only';

/**
 * Le remplissage, par le modèle, d'**un** créneau de qualité.
 *
 * ## Ce que ce service fait, et pourquoi il est si petit
 *
 * L'appli écrit désormais le squelette du plan (`lib/plan-skeleton`) :
 * périodisation, volumes, jours, footings et sortie longue. Ce qui reste au
 * modèle tient dans une phrase — « écris-moi le déroulé de cette séance dure,
 * qui doit totaliser tant de kilomètres ». Une sortie de ~200 tokens au lieu
 * d'un plan entier, et c'est tout l'intérêt de la bascule : ce que le modèle
 * local sait faire, c'est du jugement d'entraîneur sur une séance ; ce qu'il ne
 * sait pas faire, c'est de l'arithmétique sur seize semaines (le constat
 * chiffré est en tête de `plan-skeleton/skeleton.ts`).
 *
 * ## Quatre choses que le modèle n'écrit pas, et qu'il ne *peut* pas écrire
 *
 * 1. **Le jour et le `kind`** : ils viennent du créneau. Ce sont eux qui font
 *    tenir la semaine (un jour) et qui décident de l'allure posée en aval (un
 *    `kind`, cf. `sessionPaceZone`). Le modèle n'a pas voix au chapitre, donc
 *    ils ne figurent pas dans son schéma.
 * 2. **Des étapes en durée** : contrainte dure et mesurée. `imposedDistanceKm`
 *    fait primer la couverture du déroulé sur la distance déclarée dès qu'elle
 *    lui est supérieure ; un déroulé en minutes couvre deux fois le budget de
 *    son créneau, et **2 973 semaines sur 3 024 (98,3 %)** sortent alors de leur
 *    cible. Le champ `durationS` n'existe pas dans le schéma donné au modèle :
 *    on ne compte pas sur sa discipline, on le lui rend impossible.
 * 3. **Une allure, une zone cardiaque, ou une note** : `applyImposedPaces` les
 *    pose, seule et depuis la table VDOT. Leçon de production coûteuse — le
 *    modèle encode « 6:40/km » par l'entier 640 au lieu de 400 s/km, et il
 *    ancre sur n'importe quel chiffre traînant dans son contexte. Les `note`
 *    sont exclues pour une raison de plus : `STEP_NOTE_ZONES` relit la note
 *    d'une étape pour lui poser un *autre* créneau que celui de sa séance — une
 *    note « en tempo » écrite au fil de la plume déplacerait l'allure d'un bloc
 *    de VMA. Une seule source décide des allures, et ce n'est pas le modèle.
 *    Le déroulé déterministe, lui, *écrit* des notes — mais les siennes sont
 *    choisies pour ce mécanisme, pas malgré lui (cf. `ZONE_NOTES` dans
 *    `plan-skeleton/quality-template.ts`).
 * 4. **Le titre.** Vu en production : « Seuil en 3 × 1,5 km + 1 × 1,0 km » sur
 *    une séance de 5 km dont le déroulé ne portait que **deux** efforts — un
 *    titre annonçant 5,5 km d'effort dans une séance de 5 km, que rien ne
 *    pouvait voir puisque rien ne comparait les deux champs. C'est le même
 *    arbitrage que ci-dessus : le titre est de l'arithmétique sur le déroulé,
 *    donc il revient à l'appli ({@link qualitySessionTitle}), qui l'écrit
 *    depuis les étapes — le repli déterministe compris, par le même
 *    générateur.
 *
 * ## Le modèle structure, l'appli chiffre
 *
 * Le modèle choisit la forme de la séance — combien de répétitions, de quelle
 * longueur, avec quelle récupération. Il ne décide pas de ce qu'elle **totalise**
 * : l'appli reporte la différence entre sa somme et le budget du créneau sur le
 * retour au calme ({@link absorbBudget}), et la séance sort d'ici couvrant son
 * budget au mètre près. La raison est mesurée, et le tableau est en tête de
 * {@link BUDGET_TOLERANCE_SHARE} : un plan reste à zéro violation quand chaque
 * créneau tombe pile, et en compte des milliers dès +50 m sur chacun. C'est le
 * même geste que celui du déroulé déterministe, qui donne son reliquat exact au
 * retour au calme.
 *
 * ## Le repli n'est pas un filet, c'est le régime nominal dégradé
 *
 * Quand le modèle échoue, ou qu'il est injoignable, la séance est écrite par
 * {@link qualitySessionTemplate} — un déroulé déterministe qui retombe
 * exactement sur le budget et passe les règles d'étapes. Aucune exception ne
 * remonte d'ici : une séance de qualité manquante trouerait le plan, alors
 * qu'une séance de qualité *convenue* ne coûte que du sur-mesure. C'est ce qui
 * autorise la boucle de reprise à être aussi courte ({@link MAX_ATTEMPTS}) :
 * insister auprès d'un modèle local lent coûte plus cher que ce qu'on y gagne.
 *
 * Module `server-only` (il appelle le provider), et sans aucun couplage à un
 * provider : tout passe par {@link chatCompletionJson}.
 */

import { z } from 'zod';

import type { PlanLevel } from '@/data/db/schema';
import type { PlanPhase, QualitySlot, QualityZone } from '@/lib/plan-skeleton';
import { qualityEffortCapKm, sessionEffortM } from '@/lib/plan-skeleton/quality-load';
import { qualitySessionTemplate } from '@/lib/plan-skeleton/quality-template';
import { LAST_RESORT_TITLE, qualitySessionTitle } from '@/lib/plan-skeleton/quality-title';
import {
  PLAN_STEP_BOUNDS,
  PLAN_STEP_ROLES,
  planSessionStepsSchema,
  sessionStepsTotals,
  type PlanSessionSteps,
  type PlanStep,
} from '@/lib/plan-steps/schema';

import { chatCompletionJson, type ChatMessage } from './client';
import { formatDistanceKm, formatIsoDay, formatNumber } from './format';
import {
  isIntensitySession,
  PLAN_OUTPUT_BOUNDS,
  sessionStepViolations,
  type PlanSessionOutput,
} from './plan-schema';

/*
 * Bornes et réglages de la génération.
 */

/**
 * Nombre de tentatives, repli compris dans le raisonnement.
 *
 * Deux, et c'est une conséquence du repli plutôt qu'un dosage. Là où une
 * génération de plan entier n'avait rien derrière elle — si elle abandonnait,
 * l'athlète n'avait pas de plan, et une troisième tentative valait ses trente
 * secondes —, une séance parfaitement acceptable attend ici déjà dans
 * {@link qualitySessionTemplate} : la troisième tentative ne
 * s'achète plus qu'un peu de sur-mesure, au prix d'une attente que l'athlète
 * paie sur *chaque* créneau du plan — une trentaine sur seize semaines.
 */
const MAX_ATTEMPTS = 2;

/**
 * Le plafond de génération, en tokens.
 *
 * Une séance de six blocs pèse ~250 tokens de JSON ; 1 024 couvre la plus
 * bavarde sans laisser filer une génération qui partirait en boucle. Explicite,
 * comme partout ailleurs : un `max_tokens` absent laisse le serveur trancher, et
 * un JSON structuré coupé en route ne rend pas un JSON incomplet — il ne rend
 * pas de JSON du tout.
 */
const QUALITY_MAX_OUTPUT_TOKENS = 1_024;

/**
 * Même température que la génération de plan : le déroulé d'une séance est un
 * choix d'entraîneur (combien de répétitions, de quelle longueur), pas une
 * réponse unique — mais on ne cherche pas non plus l'originalité.
 */
const QUALITY_TEMPERATURE = 0.3;

/**
 * Délai de garde d'**un** créneau : 90 secondes.
 *
 * Le défaut du socle IA ({@link AI_REQUEST_TIMEOUT_MS}) vaut 5 minutes, et il
 * est taillé pour ce qu'il couvrait jusqu'ici : la génération d'un plan entier,
 * des milliers de tokens d'un coup. Le garder ici serait une faute d'échelle —
 * un plan compte une trentaine de créneaux, chacun retenté une fois, soit un
 * pire cas de **cinq heures** d'attente pour l'athlète.
 *
 * 90 s, parce qu'une séance pèse ~250 tokens de JSON (1 024 au plafond, cf.
 * {@link QUALITY_MAX_OUTPUT_TOKENS}) sur un prompt de ~300 : aux « quelques
 * tokens par seconde » du modèle cible, c'est une minute de génération, et le
 * pré-remplissage d'un prompt aussi court ne pèse rien. Un créneau qui n'a pas
 * répondu au bout de 90 s ne décrit donc pas une séance en cours d'écriture mais
 * un serveur en peine.
 *
 * Et le dépassement ne coûte pas la séance : une erreur du socle va droit au
 * repli déterministe ({@link fillQualitySlot}), sans même retenter. Le pire cas
 * d'un plan tombe à une trentaine de replis écrits en 90 s chacun — au lieu de
 * cinq heures pour le même résultat.
 */
export const QUALITY_REQUEST_TIMEOUT_MS = 90_000;

/** Nom du schéma transmis au serveur — identifiant libre, exigé par le format. */
const QUALITY_SCHEMA_NAME = 'quality_session';

/**
 * Nombre de blocs qu'une séance de qualité porte.
 *
 * **Trois au minimum, et c'est la grammaire qui le dit** : échauffement, corps
 * de séance, retour au calme. La règle d'entraîneur correspondante existe déjà
 * ({@link sessionStepViolations} refuse une séance dure sans échauffement ni
 * retour au calme), mais elle ne peut que la constater après coup, au prix d'une
 * régénération. Ce qu'une grammaire interdit d'écrire n'a pas à être corrigé.
 *
 * Six au maximum : deux corps de séance différents encadrés de leur enveloppe,
 * et un de rab. Au-delà, ce n'est plus une séance, c'est une liste.
 */
const QUALITY_BLOCKS = { min: 3, max: 6 } as const;

/**
 * Nombre d'étapes dans un bloc.
 *
 * Quatre au plus : un bloc répété porte un effort et sa récupération (deux), un
 * bloc en escalier deux paires. Les vingt qu'autorise le contrat général
 * ({@link PLAN_STEP_BOUNDS}) sont faits pour un déroulé importé, pas pour ce
 * qu'un modèle a besoin d'écrire ici.
 */
const QUALITY_STEPS_PER_BLOCK = { min: 1, max: 4 } as const;

/*
 * Le contrat de sortie : Zod et JSON Schema, aux mêmes exclusions.
 */

/**
 * Une étape **telle que le modèle l'écrit** : un rôle, des mètres, rien
 * d'autre — puis normalisée vers le contrat du projet, toutes clés présentes.
 *
 * Les clés interdites (durée, allures, zone cardiaque, note) ne sont pas
 * seulement absentes de la grammaire : elles sont **écrasées** ici, à `null`,
 * quoi qu'ait envoyé le provider. Un provider qui n'honore pas
 * `response_format` ne peut donc pas les faire entrer par la fenêtre, et la
 * séance qu'il rend reste utilisable — sa distance, elle, est obligatoire, donc
 * l'étape est complète. Rejeter aurait été plus spectaculaire et moins utile :
 * on aurait perdu une séance correcte pour un champ qu'on jette de toute façon.
 */
const qualityStepOutputSchema = z
  .object({
    role: z.enum(PLAN_STEP_ROLES),
    distanceM: z.number(),
  })
  .transform(
    (step): PlanStep => ({
      role: step.role,
      distanceM: step.distanceM,
      durationS: null,
      paceMinSecPerKm: null,
      paceMaxSecPerKm: null,
      hrZone: null,
      note: null,
    }),
  );

/**
 * Le déroulé complet, repassé par {@link planSessionStepsSchema} : c'est lui qui
 * vérifie les bornes réelles (une distance plausible, un `repeat` crédible, une
 * mesure et une seule par étape) — la même barrière que pour n'importe quelle
 * séance du plan, plutôt qu'une seconde définition qui pourrait en diverger.
 *
 * Les tailles, elles, sont **celles de la grammaire** ({@link QUALITY_BLOCKS},
 * {@link QUALITY_STEPS_PER_BLOCK}), reprises ici et pas seulement dans le JSON
 * Schema. La raison est le provider : `strict` n'est envoyé qu'à llama.cpp, et
 * ailleurs le JSON Schema n'est qu'une suggestion que rien n'oblige à honorer —
 * une séance à un seul bloc entrerait alors sans que rien ne l'arrête. Une
 * réponse de LLM est une entrée externe comme une autre : ce que la grammaire
 * impose, le contrat le vérifie.
 */
const qualityStepsOutputSchema = z
  .array(
    z.object({
      // Facultatif, comme ailleurs : `repeat: 1` partout est du bruit qu'un
      // petit modèle finit par mal recopier.
      repeat: z.number().optional(),
      steps: z
        .array(qualityStepOutputSchema)
        .min(QUALITY_STEPS_PER_BLOCK.min)
        .max(QUALITY_STEPS_PER_BLOCK.max),
    }),
  )
  .min(QUALITY_BLOCKS.min)
  .max(QUALITY_BLOCKS.max)
  .transform((blocks) =>
    blocks.map((block) => ({
      repeat: block.repeat === undefined ? 1 : Math.round(block.repeat),
      steps: block.steps,
    })),
  )
  .pipe(planSessionStepsSchema);

/**
 * Ce que le modèle rend pour un créneau : **un déroulé, et rien d'autre**.
 *
 * Le titre n'y est plus, et ce n'est pas une économie de tokens (il en coûtait
 * une dizaine) : c'est la même règle que pour les durées et les allures. Vu en
 * production, « Seuil en 3 × 1,5 km + 1 × 1,0 km » sur une séance de 5 km dont
 * le déroulé ne portait que deux efforts — le titre annonçait 5,5 km d'effort
 * dans une séance de 5 km, et rien ne pouvait le voir puisque rien ne comparait
 * les deux champs. L'appli l'écrit désormais depuis les étapes
 * ({@link qualitySessionTitle}), où il ne peut plus les contredire.
 */
export const qualitySessionOutputSchema = z.object({
  steps: qualityStepsOutputSchema,
});

export type QualitySessionOutput = z.infer<typeof qualitySessionOutputSchema>;

/**
 * Le JSON Schema donné au modèle — la grammaire qui le contraint token par
 * token chez llama.cpp.
 *
 * Écrit à la main, comme dans `plan-schema.ts`, et pour les mêmes raisons : la
 * dérivation depuis Zod produirait des constructions que la conversion GBNF ne
 * traduit pas toujours. `additionalProperties: false` partout — sans lui, la
 * grammaire autorise des champs inventés, que le modèle s'empresse d'inventer.
 *
 * Ce qui compte ici est autant ce qui **n'y est pas** : ni `title`, ni
 * `durationS`, ni `paceMinSecPerKm`, ni `paceMaxSecPerKm`, ni `hrZone`, ni
 * `note`, ni `day`, ni `kind`, ni `distanceKm`. Une clé absente de la grammaire
 * ne peut pas être écrite, là où une consigne de prompt se discute (et se perd,
 * mesuré). À l'inverse, `distanceM` est **obligatoire** sur chaque étape : c'est
 * ce qui rend un déroulé chronométré littéralement inexprimable.
 */
export const qualitySessionJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      minItems: QUALITY_BLOCKS.min,
      maxItems: QUALITY_BLOCKS.max,
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
            minItems: QUALITY_STEPS_PER_BLOCK.min,
            maxItems: QUALITY_STEPS_PER_BLOCK.max,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['role', 'distanceM'],
              properties: {
                role: {
                  type: 'string',
                  enum: [...PLAN_STEP_ROLES],
                  description:
                    'warmup = échauffement, run = effort, recover = récupération, cooldown = retour au calme',
                },
                distanceM: {
                  type: 'number',
                  minimum: PLAN_STEP_BOUNDS.distanceM.min,
                  maximum: PLAN_STEP_BOUNDS.distanceM.max,
                  description: 'longueur de l’étape, en mètres',
                },
              },
            },
          },
        },
      },
    },
  },
};

/*
 * Le prompt.
 *
 * Trois leçons de production le gouvernent, et elles ont toutes coûté cher :
 *
 * - **une seule source par sujet**. Jamais deux sections concurrentes avec une
 *   règle de préséance (« X prime sur Y ») : le modèle local suit
 *   systématiquement la mauvaise ;
 * - **les erreurs de format se corrigent par un exemple à recopier**, pas par
 *   une règle abstraite ;
 * - **aucun chiffre dont il n'a pas besoin**. Il ancre sur n'importe quel nombre
 *   traînant dans le contexte, d'où un prompt qui n'en porte qu'un seul : le
 *   budget. Les zones et les phases y sont décrites qualitativement — « efforts
 *   courts et durs », jamais « 400 m à 95 % de VMA ».
 */

/**
 * L'exemple à recopier : la forme exacte attendue, sur une séance dont le total
 * est **annoncé** (8 km) et **atteint** (1 500 + 3 × 1 800 + 1 100 = 8 000 m).
 *
 * Sans titre, comme la grammaire : un exemple qui en porterait un ferait écrire
 * une clé que `additionalProperties: false` refuse, et le créneau tomberait au
 * repli.
 *
 * L'annonce n'est pas décorative : c'est elle qui montre la relation que la
 * consigne demande — la somme des étapes, répétitions comprises, fait le total.
 * Un exemple sans son total serait un exemple de forme, pas de contrat.
 */
const QUALITY_EXAMPLE_JSON =
  '{"steps":[' +
  '{"steps":[{"role":"warmup","distanceM":1500}]},' +
  '{"repeat":3,"steps":[{"role":"run","distanceM":1500},{"role":"recover","distanceM":300}]},' +
  '{"steps":[{"role":"cooldown","distanceM":1100}]}]}';

const QUALITY_SYSTEM_PROMPT = [
  "Tu es entraîneur de course à pied. Tu écris le déroulé d'UNE séance : la suite des blocs qui la composent.",
  '',
  'Chaque étape porte un rôle et une distance en mètres :',
  'warmup = échauffement, run = effort, recover = récupération trottée, cooldown = retour au calme.',
  "Un bloc dont `repeat` vaut plus de 1 répète ses étapes : il porte l'effort ET sa récupération.",
  '',
  'Trois règles, sans exception :',
  '- la séance commence par un warmup et se termine par un cooldown ;',
  '- tout bloc répété contient une étape recover ;',
  '- la somme des distances, répétitions comprises, fait le total demandé.',
  '',
  "Tu n'écris aucune allure, aucune fréquence cardiaque, aucune durée, et aucun titre : l'application les calcule et les pose elle-même.",
  '',
  "Réponds par un objet de cette forme exacte. Exemple pour un total demandé de 8 km, en seuil :",
  QUALITY_EXAMPLE_JSON,
].join('\n');

/**
 * Ce que chaque zone demande, **en mots**.
 *
 * Aucune longueur, aucun pourcentage, aucune allure : ces chiffres-là seraient
 * repris tels quels dans le déroulé, quel que soit le budget du créneau. Ce
 * qu'on décrit est la *forme* de l'effort — c'est ce qui distingue une séance de
 * VMA d'une séance de seuil, et c'est tout ce dont le modèle a besoin pour
 * choisir un découpage.
 */
const QUALITY_ZONE_BRIEFS: Record<QualityZone, string> = {
  threshold: 'des efforts longs et continus, soutenus mais jamais en force, récupérations courtes',
  interval: "des efforts courts et durs, avec une récupération à peu près aussi longue que l'effort",
  repetition: 'des efforts très courts et très rapides, avec une récupération complète entre chacun',
  marathon: "un ou deux blocs longs à l'allure de la course, sans fractionnement serré",
};

/**
 * Ce que le **niveau** de l'athlète change à la forme de la séance, en une ligne
 * et en mots.
 *
 * ## Pourquoi cette ligne existe
 *
 * Elle remplace une règle qui vivait dans le prompt du plan entier, disparu
 * avec la bascule sur squelette (« NIVEAU DÉBUTANT — au plus une séance de
 * qualité, courte et douce […] Jamais de bloc de seuil long » contre
 * « CONFIRMÉ — blocs de seuil plus longs »). Sans elle, mesuré sur un semi en
 * 1 h 45 à 4 séances : une **débutante** recevait 9 séances de seuil à la
 * structure exacte d'une confirmée, et `advanced` produisait un plan strictement
 * identique à `intermediate`. Seul le *nombre* de créneaux distinguait encore
 * les niveaux.
 *
 * ## Pourquoi elle ne porte aucun chiffre
 *
 * Même raison que pour les zones et les phases, et c'est la leçon la plus chère
 * de ce prompt : le modèle ancre sur n'importe quel nombre traînant dans son
 * contexte. « 6 à 8 × 30 s » se retrouverait recopié tel quel dans un créneau de
 * 12 km. On décrit donc le **sens** du réglage — plus court / plus long, plus
 * récupéré / plus serré —, et le budget reste le seul nombre du prompt.
 *
 * Ce que ces trois lignes décrivent est exactement ce que le déroulé
 * déterministe applique de son côté (`LEVEL_RECOVERY_FACTOR` dans
 * `plan-skeleton/quality-template.ts`) : les deux chemins doivent prescrire la
 * même chose, sans quoi une séance changerait de nature selon que le coach a
 * répondu ou non.
 */
const QUALITY_LEVEL_BRIEFS: Record<PlanLevel, string> = {
  beginner:
    "Athlète débutante : des efforts nettement plus courts que d'ordinaire, et une récupération généreuse entre chacun — jamais de bloc long.",
  intermediate: 'Athlète intermédiaire : le format habituel de la zone, ni durci ni dilué.',
  advanced:
    "Athlète confirmée : des efforts plus longs que d'ordinaire, et une récupération serrée entre chacun.",
};

/** La phase, en français — ce qui situe la séance dans la préparation. */
const QUALITY_PHASE_LABELS: Record<PlanPhase, string> = {
  partial: 'reprise',
  base: 'base',
  build: 'développement',
  specific: 'spécificité',
  taper: 'affûtage',
  race: 'semaine de course',
};

/**
 * Les messages d'un créneau : le système, puis la demande.
 *
 * Le budget est la **dernière** ligne, et le seul nombre de tout le prompt :
 * c'est la contrainte qui se perd le plus facilement, et un modèle relit mieux
 * ce qu'il vient de lire.
 *
 * Exporté pour que le prompt se juge sur pièce dans les tests — c'est la partie
 * la plus fragile du service, et la seule qu'on ne peut pas prouver par un type.
 */
export function buildQualitySessionMessages(slot: QualitySlot): ChatMessage[] {
  return [
    { role: 'system', content: QUALITY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Séance de ${slot.kind} : ${QUALITY_ZONE_BRIEFS[slot.zone]}.`,
        `Phase : ${QUALITY_PHASE_LABELS[slot.phase]}.`,
        QUALITY_LEVEL_BRIEFS[slot.level],
        `Total de la séance, échauffement et retour au calme compris : ${formatDistanceKm(slot.budgetKm * 1_000)}.`,
      ].join('\n'),
    },
  ];
}

/*
 * Validation d'une séance remplie.
 */

/**
 * Part du budget que l'appli accepte de **retoucher** sur un déroulé.
 *
 * ## Ce que ce nombre dit, et surtout ce qu'il ne dit plus
 *
 * Ce n'est **pas** un écart acceptable dans le plan. Aucun écart ne l'est : le
 * déroulé rendu par ce service retombe sur le budget de son créneau au mètre
 * près, parce que l'appli reporte la différence sur le retour au calme
 * ({@link absorbBudget}). Cette tolérance-là dit uniquement **jusqu'où l'appli
 * va corriger le modèle sans lui redemander** : au-delà, ce n'est plus une
 * retouche, c'est que le modèle a écrit une autre séance que celle qui était
 * demandée, et on la lui fait réécrire.
 *
 * ## Pourquoi une tolérance passive était une faute, et le chiffre qui le dit
 *
 * Le raisonnement précédent — « l'écart ne se paie que sur la bande de ±10 % de
 * la semaine » — est faux, et c'est mesuré. Trois règles à marge quasi nulle
 * cassent bien avant cette bande : l'ancrage de la première semaine pleine,
 * celui de la semaine allégée, et la part de la sortie longue. Sur 111 134
 * semaines / 99 895 créneaux de squelettes réels, post-traités puis soumis à
 * `validatePlanBusinessRules` :
 *
 * | écart appliqué à chaque créneau | violations |
 * | --- | --- |
 * | pile au budget | **0** |
 * | ±20 m | 0 |
 * | +50 m | 6 024 |
 * | ±300 m | ~22 000 |
 * | ± la tolérance ci-dessous | **21 270 (haute) / 24 988 (basse)** |
 *
 * Cas reproductible : 16 semaines, 5 séances, `intermediate`, 42 km/sem
 * récents, 420 min, 5:30/km, objectif 10 km. Les cibles sont 58,6 puis 49,8 km
 * et 0,85 × 58,6 = 49,81 — soit **10 m de marge**. Un créneau de 8,0 km rendu à
 * 8,4 km met la semaine 1 à 50,7 km quand l'ancrage plafonne à 50,4, et casse en
 * plus la semaine allégée. **+50 m sur un seul créneau suffisent.**
 *
 * D'où la forme de la correction, et pourquoi ce n'est pas « resserrer » :
 * à 20 m près, aucun modèle ne tiendrait, tous les créneaux tomberaient dans le
 * repli et l'appel au modèle ne servirait plus à rien. On garde donc une bande
 * large — mais on la fait payer à l'appli, pas au plan.
 *
 * **Si quelqu'un est tenté de « simplifier » en revenant à une tolérance
 * passive : le tableau ci-dessus est la réponse.**
 *
 * 5 % : un modèle compose avec des blocs entiers (un 400 m de plus ou de moins),
 * et lui redemander une séance pour 100 m ferait tomber la plupart des créneaux
 * dans le repli déterministe — on paierait un appel au modèle pour n'en jamais
 * garder la sortie.
 */
const BUDGET_TOLERANCE_SHARE = 0.05;

/**
 * Le plancher de cette retouche, en kilomètres.
 *
 * En dessous de 6 km de budget, 5 % descendent sous 300 m — moins qu'un tour de
 * piste, soit moins que le grain avec lequel une séance s'écrit. Un modèle à qui
 * on demande 4 km n'écrira pas « 3 × 950 m » pour tomber juste : il écrira des
 * nombres ronds, et c'est à l'appli de faire la monnaie.
 */
const BUDGET_TOLERANCE_FLOOR_KM = 0.3;

/**
 * L'écart que l'appli accepte de reporter sur le retour au calme, en kilomètres
 * — au-delà, la séance est à réécrire.
 */
export function budgetToleranceKm(budgetKm: number): number {
  return Math.max(BUDGET_TOLERANCE_FLOOR_KM, budgetKm * BUDGET_TOLERANCE_SHARE);
}

/** Un volume en kilomètres, arrondi au dixième — la précision qu'un plan écrit. */
function roundKm(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Ce que le déroulé totalise, en kilomètres.
 *
 * `sessionStepsTotals` rend `null` dès qu'une étape est mesurée en durée — ce
 * que le schéma rend inexprimable. Le zéro de repli n'est donc pas un cas à
 * traiter mais une lecture sûre : une séance qui totaliserait `null` serait
 * jugée hors budget, reprise, puis remplacée par le déroulé déterministe.
 */
function stepsKm(steps: PlanSessionSteps): number {
  return (sessionStepsTotals(steps).distanceM ?? 0) / 1_000;
}

/**
 * La séance telle qu'elle entrera dans le plan : le jour et le `kind` du
 * créneau, le déroulé du modèle, et le titre que l'appli en tire.
 *
 * `distanceKm` vaut **exactement la somme du déroulé**, arrondie au dixième, et
 * c'est ce qui verrouille le piège à 98,3 % : `imposedDistanceKm` compare la
 * distance déclarée à la couverture du déroulé et garde la plus grande. Les deux
 * étant ici la même valeur (toutes les étapes sont en mètres, la couverture est
 * la somme), le post-traitement ne peut plus rien changer — la séance sort
 * d'`applyImposedPaces` avec la distance qu'elle y est entrée.
 */
function qualitySessionFor(slot: QualitySlot, output: QualitySessionOutput): PlanSessionOutput {
  return {
    // Imposés par l'appli : le jour tient la semaine, le `kind` décide de
    // l'allure posée en aval.
    day: slot.day,
    kind: slot.kind,
    // Écrit depuis le déroulé, jamais recopié du modèle : c'est ce qui rend
    // impossible un titre qui contredit ses propres étapes.
    title: qualitySessionTitle(slot.zone, output.steps),
    distanceKm: roundKm(stepsKm(output.steps)),
    steps: output.steps,
  };
}

/** Ce qui, dans une séance remplie, désigne le créneau qu'elle prétend remplir. */
const QUALITY_VIOLATION_LABEL = 'Séance de qualité';

/**
 * Comment nommer l'allure d'une zone **dans une phrase** — « à l'allure seuil ».
 *
 * Distinct de {@link QUALITY_ZONE_KINDS}, qui nomme la *séance* et s'écrit avec
 * une capitale (« Seuil », « Spécifique allure course ») : recopier ces libellés
 * ici donnerait « à l'allure Spécifique allure course ». Le message de reprise
 * est lu par le modèle, et une phrase bancale est une consigne qu'il suit mal.
 */
const EFFORT_ZONE_LABELS: Record<QualityZone, string> = {
  threshold: 'seuil',
  interval: 'VMA',
  repetition: 'des répétitions',
  marathon: 'objectif',
};

/**
 * Ce qui cloche dans une séance remplie — la liste vide valant « bonne ».
 *
 * Trois familles :
 *
 * - les **règles d'étapes** du projet ({@link sessionStepViolations}) :
 *   échauffement, retour au calme, récupération dans tout bloc répété. Elles
 *   sont reprises telles quelles plutôt que réécrites ici — une séance de
 *   qualité se juge exactement comme n'importe quelle séance du plan, et deux
 *   définitions finiraient par diverger ;
 * - l'**enveloppe, quel que soit le `kind`** — cf. ci-dessous ;
 * - le **budget**, qui n'a de sens qu'ici : la validation de plan juge des
 *   volumes hebdomadaires, elle ne sait rien du budget d'un créneau isolé.
 *
 * ## Pourquoi l'enveloppe est réclamée une seconde fois
 *
 * `sessionStepViolations` ne l'exige que d'une séance qu'`isIntensitySession`
 * reconnaît, et ce classement se fait **par libellé** : ses motifs couvrent le
 * seuil, la VMA et les répétitions, pas « Spécifique allure course » — le `kind`
 * d'un créneau `marathon`. Vérifié : sur un tel créneau, trois blocs de `run`
 * nus passaient sans une violation, et l'athlète recevait 8 km à l'allure
 * objectif sans une foulée d'échauffement. Le même déroulé sur un créneau
 * `threshold` était refusé. Ce n'est pas un cas de bord : sur une préparation
 * marathon, `marathon` est la **première** zone de la grille en `build`,
 * `specific` et `taper`, et le repli déterministe, lui, écrit toujours son
 * enveloppe — les deux chemins divergeaient là où le modèle est le moins fiable.
 *
 * La règle est donc posée ici, où elle ne dépend d'aucun libellé : **un créneau
 * de qualité en est un par construction**, c'est le squelette qui l'a écrit.
 * `sessionStepViolations` reste la source pour les séances qu'elle reconnaît (on
 * ne dédouble pas ses messages), et cette fonction couvre les autres.
 *
 * ## Le quatrième juge : le volume d'effort
 *
 * Les trois familles ci-dessus bornent la *forme* et le *total* d'une séance.
 * Aucune ne bornait ce qu'elle fait **courir à l'allure dure** — la seule
 * dimension dont l'excès mène au surentraînement. Rien n'empêchait donc une
 * séance de seuil budgétée 6 km d'en porter 5 d'effort, soit 17 % d'une semaine
 * de 30 km quand la référence en plafonne 10. Les plafonds et leur niveau de
 * preuve vivent dans `plan-skeleton/quality-load.ts` ; ici, ils sont une
 * contrainte dure comme les autres : reprise du modèle, puis repli déterministe.
 */
function qualitySessionViolations(session: PlanSessionOutput, slot: QualitySlot): string[] {
  const violations = sessionStepViolations(session, QUALITY_VIOLATION_LABEL);
  const where = `${QUALITY_VIOLATION_LABEL}, séance du ${formatIsoDay(slot.day)} (${slot.kind})`;

  // Uniquement là où `sessionStepViolations` ne l'a pas déjà dit : les deux
  // messages seraient le même, et le répéter dilue la consigne de reprise.
  if (!isIntensitySession(session)) {
    const roles = new Set((session.steps ?? []).flatMap((block) => block.steps.map((s) => s.role)));
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

  const totalKm = stepsKm(session.steps ?? []);
  if (Math.abs(totalKm - slot.budgetKm) > budgetToleranceKm(slot.budgetKm)) {
    violations.push(
      `${where} : le déroulé totalise ${formatNumber(totalKm, 1)} km au lieu de ${formatNumber(slot.budgetKm, 1)} km — ajuste la longueur ou le nombre des efforts pour retomber sur ce total, échauffement et retour au calme compris.`,
    );
  }

  const capKm = qualityEffortCapKm(slot.zone, slot.weeklyTargetKm);
  if (capKm !== null) {
    const effortM = sessionEffortM(slot.zone, session.steps ?? []);
    // Comparé en **mètres entiers**, comme tout le reste du projet : le plafond
    // est un produit de flottants (0,1 × 29 vaut 2,9000000000000004) et l'arrondir
    // au mètre supprime ce bruit-là sans rien accorder — au plus un demi-mètre.
    const capM = Math.round(capKm * 1_000);
    if (effortM > capM) {
      violations.push(
        `${where} : ta séance contient ${formatNumber(effortM / 1_000, 1)} km à l'allure ${EFFORT_ZONE_LABELS[slot.zone]}, le maximum est ${formatNumber(capM / 1_000, 1)} km pour cette semaine — réduis le nombre ou la longueur des efforts. L'échauffement, les récupérations et le retour au calme ne comptent pas dans ce total.`,
      );
    }
  }

  return violations;
}

/*
 * L'absorption : ramener le déroulé du modèle sur le budget, au mètre près.
 */

/**
 * La bande dans laquelle le retour au calme doit tomber **après** absorption, en
 * part du budget du créneau.
 *
 * L'absorption reporte l'écart au budget sur une seule étape : sans garde, elle
 * rendrait une séance bancale à la place d'une séance approximative, ce qui
 * serait un mauvais échange. Deux dérives à empêcher, et la bande les couvre
 * toutes les deux :
 *
 * - **par le bas**, un retour au calme réduit à quelques mètres. 5 % du budget,
 *   soit 400 m sur un créneau de 8 km — de l'ordre de trois minutes de trot,
 *   le minimum en dessous duquel l'étape ne ramène plus personne au calme ;
 * - **par le haut**, un retour au calme devenu l'essentiel de la séance. 35 % :
 *   c'est déjà plus que ce que le déroulé déterministe écrit (~20 à 25 % du
 *   budget, cf. `COOLDOWN_SHARE` dans `plan-skeleton/quality-template.ts`) et
 *   deux fois et demie l'exemple donné au modèle (1 100 m sur 8 km, 14 %).
 *
 * Volontairement large, donc : la bande n'arbitre pas le style d'un entraîneur,
 * elle attrape les résultats dégénérés. Elle est bornée en dur par
 * {@link PLAN_STEP_BOUNDS.distanceM}, qui reste le contrat d'une étape.
 *
 * Elle juge la valeur **rendue**, que l'appli l'ait déplacée de 400 m ou de
 * zéro : c'est celle-là que l'athlète court. Une séance dont le retour au calme
 * sort de cette bande est une séance que le déroulé déterministe écrit mieux, et
 * c'est là qu'on se replie.
 */
const COOLDOWN_BAND_SHARE = { min: 0.05, max: 0.35 } as const;

/** Le budget d'un créneau en mètres entiers — {@link weeklySessionBudgets} les pose au demi-kilomètre. */
function budgetMeters(slot: QualitySlot): number {
  return Math.round(slot.budgetKm * 1_000);
}

/**
 * L'étape qui portera l'écart : le **dernier `cooldown` d'un bloc joué une seule
 * fois**.
 *
 * Le dernier, parce que c'est celui qui termine la séance. D'un bloc à `repeat`
 * 1, parce qu'une étape répétée compte autant de fois dans la couverture : lui
 * ajouter l'écart l'ajouterait `repeat` fois, et la somme retomberait à côté.
 * Faute d'une telle étape, il n'y a pas d'absorption — et donc pas de séance du
 * modèle : on se replie.
 */
function absorbingStepIndex(steps: PlanSessionSteps): { block: number; step: number } | null {
  for (let block = steps.length - 1; block >= 0; block -= 1) {
    if (steps[block].repeat !== 1) continue;
    const step = steps[block].steps.findLastIndex((candidate) => candidate.role === 'cooldown');
    if (step >= 0) return { block, step };
  }

  return null;
}

/**
 * Le déroulé du modèle, ramené **au mètre près** sur le budget de son créneau —
 * ou `null` quand ça ne peut pas se faire proprement.
 *
 * ## Pourquoi l'appli retouche plutôt que de tolérer
 *
 * Parce qu'un plan ne supporte pas l'à-peu-près : les mesures consignées sur
 * {@link BUDGET_TOLERANCE_SHARE} montrent qu'un plan reste à zéro violation
 * quand chaque créneau tombe pile sur son budget, et qu'il en compte des
 * milliers dès +50 m. Le seul écart qui ne coûte rien est celui qui n'existe
 * pas.
 *
 * C'est la division du travail habituelle du projet — **le modèle structure,
 * l'appli chiffre** — et exactement ce que le déroulé déterministe fait déjà de
 * son propre reliquat (`quality-template.ts`, « le retour au calme prend le
 * reliquat exact »). Ce n'est pas le redimensionnement abandonné : on ajuste une
 * étape d'une séance pour retomber sur un budget que l'appli a elle-même posé,
 * sans aucune interaction entre semaines, et le résultat est arithmétiquement
 * identique au cas de référence mesuré à zéro violation.
 *
 * L'écart va au retour au calme parce que c'est l'étape élastique de la séance :
 * personne ne chronomètre son retour au calme au décamètre, là où « 3 × 1 500 m »
 * est le contenu même de la séance et ne se rogne pas.
 *
 * Rendu à `null` — et donc repli déterministe — dans trois cas : pas d'étape où
 * absorber, un retour au calme qui sortirait de {@link COOLDOWN_BAND_SHARE}, ou
 * un déroulé retouché que le contrat d'étapes refuserait. Ce dernier est
 * revérifié plutôt que supposé.
 */
function absorbBudget(steps: PlanSessionSteps, slot: QualitySlot): PlanSessionSteps | null {
  const target = absorbingStepIndex(steps);
  if (target === null) return null;

  const coveredM = sessionStepsTotals(steps).distanceM;
  const currentM = steps[target.block].steps[target.step].distanceM;
  // Une étape en durée est inexprimable dans la grammaire de ce service, et le
  // contrat d'étapes l'a de toute façon déjà validée : ces `null` ne sont pas un
  // cas à traiter, seulement une lecture sûre qui se replie plutôt que de
  // calculer sur du vide.
  if (coveredM === null || currentM === null) return null;

  const budgetM = budgetMeters(slot);
  // Arrondi au mètre : les distances d'un déroulé s'écrivent en mètres entiers,
  // et le résidu (au plus 50 cm, et nul dès que le modèle écrit des entiers) est
  // deux ordres de grandeur sous le ±20 m mesuré à zéro violation.
  const cooldownM = Math.round(currentM + (budgetM - coveredM));

  const bandMinM = Math.max(PLAN_STEP_BOUNDS.distanceM.min, budgetM * COOLDOWN_BAND_SHARE.min);
  const bandMaxM = Math.min(PLAN_STEP_BOUNDS.distanceM.max, budgetM * COOLDOWN_BAND_SHARE.max);
  if (cooldownM < bandMinM || cooldownM > bandMaxM) return null;

  const absorbed = steps.map((block, blockIndex) =>
    blockIndex !== target.block
      ? block
      : {
          repeat: block.repeat,
          steps: block.steps.map((step, stepIndex) =>
            stepIndex === target.step ? { ...step, distanceM: cooldownM } : step,
          ),
        },
  );

  const parsed = planSessionStepsSchema.safeParse(absorbed);
  return parsed.success ? parsed.data : null;
}

/**
 * Le message de reprise : ce qui ne va pas, puis quoi refaire.
 *
 * Sans jamais renvoyer la sortie fautive : la redonner doublerait la facture de
 * contexte pour une information que le modèle vient d'écrire.
 */
export function buildQualityViolationsMessage(violations: readonly string[]): string {
  return [
    "Cette séance ne respecte pas ce qui était demandé :",
    ...violations.map((violation) => `- ${violation}`),
    'Réécris la séance entière en corrigeant ces points, dans le même format.',
  ].join('\n');
}

/*
 * Le repli déterministe.
 */

/**
 * Les parts de l'ultime recours : échauffement, effort, retour au calme.
 *
 * Approximativement celles du déroulé déterministe (25 % d'échauffement, 20 à
 * 30 % de retour au calme) : ce n'est pas le lieu d'inventer une doctrine, c'est
 * le lieu de rendre quelque chose de valide.
 */
const LAST_RESORT_SHARES = { warmup: 0.25, cooldown: 0.3 } as const;

/** Une étape mesurée en distance, sans consigne : toutes les clés, `null` pour le reste. */
function distanceStep(role: PlanStep['role'], distanceM: number): PlanStep {
  return {
    role,
    distanceM,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    hrPercentMin: null,
    hrPercentMax: null,
    // Aucune note : `STEP_NOTE_ZONES` en relit le texte pour poser un créneau
    // d'allure, et une séance écrite dans ces circonstances n'a rien à lui dire.
    note: null,
  };
}

/**
 * Le déroulé de l'ultime recours : trois étapes, **valides par construction**.
 *
 * Il n'existe que pour tenir la promesse de {@link fillQualitySlot} — ne jamais
 * lever — quand {@link qualitySessionTemplate} lui-même n'a rien rendu
 * d'utilisable. Rien de tout cela n'est atteignable aujourd'hui : il faudrait
 * une zone hors contrat (le template lève un `TypeError` dessus) ou un budget
 * sous 0,1 km, que {@link weeklySessionBudgets} ne pose jamais. C'était pourtant
 * le seul chemin du service qui pouvait encore lever.
 *
 * « Valides par construction » et non « validées » : le budget est ramené dans
 * {@link PLAN_OUTPUT_BOUNDS.distanceKm} (au moins 500 m), donc la plus courte
 * des trois étapes vaut au moins 125 m — bien au-dessus du plancher d'une étape
 * — et la plus longue au plus 36 km, bien en dessous de son plafond. Aucun
 * `parse` ici, donc, qui rouvrirait la porte que cette fonction est là pour
 * fermer.
 *
 * Contrepartie assumée : sur un budget hors bornes, la séance rendue ne vaut
 * plus le budget demandé. Une séance valide qui ne fait pas le compte vaut mieux
 * qu'une exception au milieu d'un plan.
 */
function lastResortSteps(budgetKm: number): PlanSessionSteps {
  const boundedKm = Number.isFinite(budgetKm)
    ? Math.min(
        Math.max(budgetKm, PLAN_OUTPUT_BOUNDS.distanceKm.min),
        PLAN_OUTPUT_BOUNDS.distanceKm.max,
      )
    : PLAN_OUTPUT_BOUNDS.distanceKm.min;

  const totalM = Math.round(boundedKm * 1_000);
  const warmupM = Math.round(totalM * LAST_RESORT_SHARES.warmup);
  const cooldownM = Math.round(totalM * LAST_RESORT_SHARES.cooldown);

  return [
    { repeat: 1, steps: [distanceStep('warmup', warmupM)] },
    // Le reliquat exact, comme partout ailleurs : la somme *est* le total.
    { repeat: 1, steps: [distanceStep('run', totalM - warmupM - cooldownM)] },
    { repeat: 1, steps: [distanceStep('cooldown', cooldownM)] },
  ];
}

/**
 * Le déroulé déterministe d'un créneau, **repassé par le contrat d'étapes** — ou
 * `null` s'il n'a rien rendu d'utilisable.
 *
 * C'était le seul chemin du service qui ne traversait aucun schéma et qui
 * pouvait lever : {@link qualitySessionTemplate} lève un `TypeError` sur une
 * zone inattendue, et produit des étapes nulles ou négatives sous 0,1 km de
 * budget. Ni l'un ni l'autre n'est atteignable par le squelette d'aujourd'hui,
 * mais « inatteignable » n'est pas une garantie : c'en est une ici.
 */
function templateSteps(slot: QualitySlot): PlanSessionSteps | null {
  try {
    const parsed = planSessionStepsSchema.safeParse(
      qualitySessionTemplate({
        zone: slot.zone,
        budgetKm: slot.budgetKm,
        phase: slot.phase,
        level: slot.level,
        weeklyTargetKm: slot.weeklyTargetKm,
      }),
    );
    if (parsed.success) return parsed.data;

    logQualityFallback(slot, `déroulé déterministe hors contrat : ${parsed.error.message}`);
    return null;
  } catch (error) {
    logQualityFallback(slot, `déroulé déterministe en échec : ${errorReason(error)}`);
    return null;
  }
}

/**
 * La séance qu'écrit l'appli quand le modèle n'a rien rendu d'utilisable.
 *
 * {@link qualitySessionTemplate} retombe exactement sur le budget et passe les
 * règles d'étapes : cette séance-là est *correcte*, elle est seulement moins
 * fine que ce qu'un entraîneur aurait écrit. C'est le bon compromis — un plan
 * troué ne l'est pas.
 *
 * Et s'il échoue lui aussi, {@link lastResortSteps} tient la promesse : cette
 * fonction rend une séance, toujours.
 *
 * **Exportée** pour la dégradation en escalier de `plan-service.ts` : quand un
 * plan assemblé viole malgré tout une règle métier, le service réécrit *tous*
 * ses créneaux avec cette fonction et revalide. C'est le cas de référence mesuré
 * à zéro violation sur des dizaines de milliers de plans — et le seul recours
 * possible, puisqu'il n'y a personne à qui redemander un plan que l'appli a
 * écrit elle-même.
 */
export function deterministicQualitySession(slot: QualitySlot): PlanSessionOutput {
  const template = templateSteps(slot);
  const steps = template ?? lastResortSteps(slot.budgetKm);

  return {
    day: slot.day,
    kind: slot.kind,
    /*
     * Le **même** générateur que pour la séance du modèle, et c'est tout
     * l'intérêt : le repli avait ses titres fixes, si bien qu'une séance écrite
     * par l'appli et la même séance écrite par le modèle ne s'annonçaient pas
     * pareil. Le déroulé de l'ultime recours, lui, n'a rien à annoncer — un
     * bloc de course nu entre deux étapes d'enveloppe —, et son titre est celui
     * qui ne nomme aucune zone.
     */
    title: template === null ? LAST_RESORT_TITLE : qualitySessionTitle(slot.zone, steps),
    distanceKm: roundKm(stepsKm(steps)),
    steps,
  };
}

/**
 * Journalise un repli, avec sa cause.
 *
 * Sans cette trace, un plan dont tous les créneaux sont écrits par l'appli est
 * indiscernable d'un plan dont le modèle a tout écrit : les deux sortent
 * valides. C'est pourtant la seule façon de voir qu'un coach est en panne, ou
 * qu'un modèle a cessé de respecter le format.
 */
function logQualityFallback(slot: QualitySlot, reason: string): void {
  console.error(
    `[plan] créneau ${formatIsoDay(slot.day)} (${slot.kind}, ${formatNumber(slot.budgetKm, 1)} km) : déroulé écrit par l'appli — ${reason}`,
  );
}

/** Ce qu'on inscrit au journal d'une erreur, sans supposer sa forme. */
function errorReason(error: unknown): string {
  return error instanceof Error ? `${error.name} : ${error.message}` : String(error);
}

/*
 * Le remplissage.
 */

/**
 * Remplit **un** créneau : rend la séance à écrire dans le plan.
 *
 * Ne lève jamais. Trois issues, dans cet ordre de préférence :
 *
 * 1. le modèle rend un déroulé conforme — on garde sa **structure**, et l'appli
 *    ramène la somme sur le budget au mètre près ({@link absorbBudget}) ;
 * 2. il rend un déroulé fautif : on lui renvoie ses violations et on redemande,
 *    dans la limite de {@link MAX_ATTEMPTS} ;
 * 3. il échoue jusqu'au bout, il n'est pas joignable, ou sa séance ne se laisse
 *    pas ramener au budget proprement : l'appli écrit la séance
 *    ({@link deterministicQualitySession}).
 *
 * L'absorption ne donne pas lieu à une reprise : le modèle a écrit une séance
 * *acceptable*, l'écart restant est de l'ordre de ce qu'on lui a demandé de ne
 * pas savoir faire (de l'arithmétique), et lui redemander la même chose coûte
 * une génération pour un ajustement que l'appli fait exactement.
 *
 * Une **erreur** du socle IA, quelle qu'elle soit, va directement au repli, et
 * c'est délibéré : la grammaire encadre ici un objet de deux champs, donc une
 * sortie hors contrat n'y signale pas un modèle qui a mal lu une consigne mais
 * un provider qui n'applique pas le schéma du tout — et redemander la même
 * chose au même provider n'a aucune raison de mieux marcher. Seules les
 * violations *métier* d'une séance valent une reprise (cf. {@link MAX_ATTEMPTS}).
 */
export async function fillQualitySlot(slot: QualitySlot): Promise<PlanSessionOutput> {
  const messages = buildQualitySessionMessages(slot);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const last = attempt === MAX_ATTEMPTS;

    let output: QualitySessionOutput;
    try {
      output = await chatCompletionJson<QualitySessionOutput>({
        messages,
        schemaName: QUALITY_SCHEMA_NAME,
        jsonSchema: qualitySessionJsonSchema,
        schema: qualitySessionOutputSchema,
        temperature: QUALITY_TEMPERATURE,
        maxTokens: QUALITY_MAX_OUTPUT_TOKENS,
        timeoutMs: QUALITY_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      logQualityFallback(slot, errorReason(error));
      return deterministicQualitySession(slot);
    }

    const session = qualitySessionFor(slot, output);
    const violations = qualitySessionViolations(session, slot);
    if (violations.length === 0) {
      const absorbed = absorbBudget(output.steps, slot);
      if (absorbed !== null) {
        const adjusted = qualitySessionFor(slot, { steps: absorbed });
        // Revalidée, pas supposée : c'est cette séance-là qui entre dans le
        // plan, et l'absorption a déplacé une de ses étapes.
        if (qualitySessionViolations(adjusted, slot).length === 0) return adjusted;
      }

      logQualityFallback(
        slot,
        "l'écart au budget ne se reporte pas proprement sur le retour au calme",
      );
      return deterministicQualitySession(slot);
    }

    if (last) {
      logQualityFallback(slot, violations.join(' '));
      return deterministicQualitySession(slot);
    }

    messages.push({ role: 'user', content: buildQualityViolationsMessage(violations) });
  }

  // Inatteignable : la dernière tentative se replie ou rend sa séance. Le
  // compilateur, lui, ne lit pas la boucle.
  return deterministicQualitySession(slot);
}

/**
 * Remplit une liste de créneaux, **l'un après l'autre**.
 *
 * Séquentiel, et ce n'est pas une facilité d'écriture : le serveur local sert
 * une requête à la fois (llama.cpp, un slot), donc paralléliser ne ferait
 * qu'empiler les appels dans sa file — sans rien gagner, et en rendant le
 * journal illisible quand plusieurs créneaux se replient.
 *
 * Ne lève jamais, par construction : chaque créneau se replie pour son propre
 * compte, et un modèle tombé au milieu d'un plan ne coûte que le sur-mesure des
 * séances restantes.
 *
 * @param onFilled appelé après **chaque** créneau, avec le nombre de créneaux
 * déjà écrits et leur total. C'est la seule mesure honnête de l'avancement d'une
 * génération de plan depuis la bascule : le créneau est l'unité de travail du
 * modèle, et le reste du plan est écrit avant même le premier appel.
 */
export async function fillQualitySlots(
  slots: readonly QualitySlot[],
  onFilled?: (filled: number, total: number) => void,
): Promise<PlanSessionOutput[]> {
  const sessions: PlanSessionOutput[] = [];
  for (const slot of slots) {
    sessions.push(await fillQualitySlot(slot));
    onFilled?.(sessions.length, slots.length);
  }
  return sessions;
}
