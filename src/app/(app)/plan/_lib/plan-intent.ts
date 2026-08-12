/**
 * Les quatre **intentions** de plan, côté écran : leurs libellés, ce qu'elles
 * annoncent honnêtement avant qu'on génère quoi que ce soit, et la seule
 * recommandation complémentaire que le plan se permet.
 *
 * ## Pourquoi les textes vivent ici, et pas dans le composant
 *
 * Parce qu'ils sont lus **deux fois** : par la modale de création, qui les
 * affiche avant de lancer la génération, et par la page du plan, qui rappelle la
 * reco de renforcement en encart. Recopiés des deux côtés, ils divergeraient à la
 * première retouche — et ce sont exactement les phrases qui n'ont pas le droit de
 * diverger.
 *
 * ## Ce que ces textes s'interdisent
 *
 * De promettre. Un plan d'entraînement ne fait pas perdre un nombre de kilos, ne
 * garantit pas l'absence de blessure et ne chiffre pas une progression
 * individuelle. Chaque texte dit donc ce que la littérature établit *en moyenne*,
 * ce que le plan apporte de mieux démontré, et ce qui reste hors de sa portée. Ils
 * sont pesés mot à mot : les modifier demande une source, pas une préférence de
 * ton.
 *
 * Module **pur** et importable par un composant client : ni schéma Drizzle, ni
 * `server-only`. L'union est redéclarée ici — comme `Level` dans `form-options` —
 * mais `satisfies` interdit qu'elle diverge du domaine (import de **type** seul,
 * effacé à la compilation, donc rien du module de calcul n'atterrit dans le
 * bundle).
 */

import type { PlanIntent as DomainPlanIntent } from "@/lib/plan-skeleton/intent";

/** Ce que l'athlète vient chercher — la valeur que le formulaire transmet. */
export type PlanIntent = "race" | "faster" | "weight_loss" | "return";

/** Les quatre intentions, dans l'ordre du sélecteur. */
export const PLAN_INTENTS = [
  "race",
  "faster",
  "weight_loss",
  "return",
] as const satisfies readonly DomainPlanIntent[];

/** Libellé français d'une intention — le formulaire et l'en-tête du plan le partagent. */
export const INTENT_LABELS: Record<PlanIntent, string> = {
  race: "Préparer une course",
  faster: "Courir plus vite",
  weight_loss: "Perdre du poids",
  return: "Reprendre la course",
};

/** Les quatre cartes du sélecteur : ce que chaque intention change au plan. */
export const INTENT_CHOICES: readonly { value: PlanIntent; label: string; hint: string }[] = [
  {
    value: "race",
    label: INTENT_LABELS.race,
    hint: "Une date à préparer : développement, spécificité, puis affûtage.",
  },
  {
    value: "faster",
    label: INTENT_LABELS.faster,
    hint: "Sans échéance : du seuil et de la VMA sur une base courte.",
  },
  {
    value: "weight_loss",
    label: INTENT_LABELS.weight_loss,
    hint: "Le volume facile d'abord, une seule séance dure par semaine.",
  },
  {
    value: "return",
    label: INTENT_LABELS.return,
    hint: "Une longue base, sans séance dure, en marche/course au départ.",
  },
];

/** Le cas le plus fréquent, et celui qui ouvrait déjà le formulaire. */
export const DEFAULT_INTENT: PlanIntent = "race";

/**
 * Ce que ce plan peut, et ne peut pas, donner — lu **avant** de générer.
 *
 * Les quatre textes sont repris tels quels du dossier de recherche du chantier
 * (méta-analyses sur la perte de poids par l'exercice seul, délais de
 * remodelage osseux et tendineux à la reprise, ordres de grandeur de progression
 * sur 8 à 16 semaines, effet de l'affûtage). Ils sont volontairement longs : c'est
 * le seul endroit de l'appli où l'athlète lit ce qu'on ne lui promet pas.
 */
export const INTENT_HONEST_NOTES: Record<PlanIntent, string> = {
  weight_loss:
    "Courir seul, sans changer ton alimentation, fait perdre environ 2 à 3 kg en moyenne — c'est le chiffre des grandes méta-analyses, très variable selon les personnes. Le levier principal reste l'assiette. Ce que ce plan va te donner, et qui est mieux démontré : de la condition physique, un tour de taille qui baisse, un meilleur profil cardiométabolique — même si la balance ne bouge pas. Attention : augmenter le volume ET réduire fortement l'alimentation en même temps expose à la faible disponibilité énergétique (troubles du cycle, os fragilisés). L'un ou l'autre, progressivement. En complément : 2 séances de renforcement par semaine préservent le muscle pendant la perte de poids.",
  return:
    "Cette phase de reprise est longue exprès : le cœur revient en quelques semaines, les tendons et les os en plusieurs mois. Ce plan progresse lentement et évite les à-coups — il ne peut pas garantir l'absence de blessure. Si tu manques des séances, elles sont perdues, pas reportées : reprends là où le plan en est. En complément : 2 séances de renforcement par semaine sont ce qui a la meilleure preuve de prévention.",
  faster:
    "Attends-toi à 2-7 % de progression sur 8 à 16 semaines : ce qui compte le plus, c'est le volume total et la régularité, pas la structure fine. En complément : 2 séances de renforcement par semaine (charges lourdes) sont le levier le mieux démontré après le volume.",
  race: "Les dernières semaines réduisent le volume sans toucher à l'intensité ni au nombre de séances : c'est le paramètre le mieux démontré de tout l'entraînement. Résiste à la tentation d'une dernière grosse séance.",
};

/**
 * La reco de renforcement, en une phrase — l'encart de la page du plan.
 *
 * Elle est **hors du plan** et le restera : ce module n'écrit que de la course à
 * pied, et prescrire des séances de musculation qu'il ne sait ni doser ni suivre
 * serait au mieux décoratif. Mais c'est, après le volume, le complément le mieux
 * étayé — le taire pour ne pas sortir du périmètre reviendrait à cacher ce qui
 * marche.
 */
export const INTENT_STRENGTH_NOTES: Record<PlanIntent, string> = {
  race: "2 séances de renforcement par semaine, charges lourdes : après le volume, c'est ce qui améliore le plus l'économie de course — et ça ne coûte pas un kilomètre au plan.",
  faster:
    "2 séances de renforcement par semaine, charges lourdes : c'est le levier le mieux démontré après le volume total.",
  weight_loss:
    "2 séances de renforcement par semaine : c'est ce qui préserve le muscle pendant une perte de poids. La course, elle, ne le fait pas.",
  return:
    "2 séances de renforcement par semaine : c'est ce qui a la meilleure preuve de prévention des blessures. Rien dans ce plan ne la remplace.",
};
