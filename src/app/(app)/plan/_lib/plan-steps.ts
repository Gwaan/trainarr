/**
 * Découpage en étapes du formulaire de création d'un plan.
 *
 * Le formulaire pose une dizaine de questions : posées d'un bloc, elles se
 * lisent comme un dossier à remplir. La modale les sert une étape à la fois, et
 * c'est ce module qui tient la liste — déclarative, pour qu'une étape de plus se
 * glisse dans le tableau sans toucher au reste : rien ici, ni dans la modale, ne
 * numérote les étapes en dur. L'étape « Ton chrono » est arrivée par là.
 *
 * Tout est pur et sans dépendance React : la modale n'a plus qu'à afficher.
 *
 * Deux règles à garder en tête :
 * - la validation d'étape est **légère** (présence et forme), l'autorité reste
 *   la Server Action ; elle n'est là que pour ne pas laisser avancer sur une
 *   étape manifestement vide ;
 * - `fields` est ce qui ramène une erreur du serveur à son étape : un champ
 *   oublié de ce tableau afficherait son erreur sur une étape qu'on ne peut plus
 *   atteindre.
 */

import type { ReferenceDistance } from "@/lib/metrics/vdot";

import type { PlanFormField } from "./actions";
import {
  DEFAULT_LEVEL,
  DEFAULT_LONG_RUN_DAY,
  DEFAULT_REFERENCE_DISTANCE,
  DEFAULT_SESSIONS_PER_WEEK,
  DEFAULT_WEEKS,
  LEVEL_CHOICES,
  asReferenceDistance,
  parseRaceTimeSeconds,
  type Level,
} from "./form-options";
import { DEFAULT_INTENT, INTENT_CHOICES, type PlanIntent } from "./plan-intent";

/**
 * Les réponses de l'athlète, telles que la modale les tient en état.
 *
 * Tout est chaîne sauf les deux choix fermés : ce sont les valeurs que le
 * `FormData` portera, et les convertir ici ne ferait que déplacer la conversion.
 */
export type PlanFormValues = {
  /** Ce que l'athlète vient chercher : le sélecteur qui décide de tout le reste. */
  intent: PlanIntent;
  /** Note libre, facultative — l'ancien objectif en texte libre. */
  goalText: string;
  raceDate: string;
  weeks: string;
  /**
   * « J'ai eu une blessure ces derniers mois ». Une case, donc un booléen — les
   * autres réponses sont des chaînes parce qu'elles partent telles quelles dans
   * le `FormData` ; celle-ci n'y part que si elle est cochée.
   */
  returnInjuryHistory: boolean;
  level: Level;
  /** Distance du chrono de référence — toujours renseignée, c'est une liste. */
  referenceDistance: ReferenceDistance;
  /** Temps du chrono, `mm:ss` ou `hh:mm:ss`. Vide : pas de chrono déclaré. */
  referenceTime: string;
  sessionsPerWeek: string;
  longRunDay: string;
  weeklyTimeHours: string;
  startsOn: string;
};

export type PlanStepId =
  | "goal"
  | "expectations"
  | "profile"
  | "race"
  | "constraints"
  | "summary";

export type PlanStep = {
  id: PlanStepId;
  /** Titre de l'étape, en tête de son contenu et dans l'indicateur. */
  title: string;
  /** Une phrase qui dit ce que l'étape attend. */
  hint: string;
  /** Champs portés par l'étape — la table de retour des erreurs serveur. */
  fields: readonly PlanFormField[];
};

export const PLAN_STEPS = [
  {
    id: "goal",
    title: "Ton objectif",
    hint: "Ce que tu viens chercher : c'est ce choix qui décide de la forme du plan.",
    fields: ["intent", "raceDate", "weeks", "goalText"],
  },
  {
    /*
     * Ce que ce plan peut donner — et ce qu'il ne peut pas.
     *
     * Une étape à part entière, et placée **juste après le choix**, parce que
     * c'est la conséquence directe de ce qui vient d'être coché : l'athlète lit
     * ce que la littérature établit avant que le coach n'écrive quoi que ce
     * soit, pas après. Rien à saisir, donc aucun champ — l'étape ne peut pas
     * retenir l'avancement.
     */
    id: "expectations",
    title: "Ce que ce plan peut te donner",
    hint: "À lire avant de générer : ce qui est démontré, et ce qui ne se promet pas.",
    fields: [],
  },
  {
    id: "profile",
    title: "Ton profil",
    hint: "Où tu en es dans ta pratique : le coach cale la charge dessus.",
    fields: ["level"],
  },
  {
    id: "race",
    title: "Ton chrono",
    hint: "Un temps récent sur une distance connue : c'est lui qui calcule tes allures.",
    fields: ["referenceDistance", "referenceTime"],
  },
  {
    id: "constraints",
    title: "Tes contraintes",
    hint: "Ce que ta semaine peut absorber, sans forcer.",
    fields: ["sessionsPerWeek", "longRunDay", "weeklyTimeHours", "startsOn"],
  },
  {
    id: "summary",
    title: "Récapitulatif",
    hint: "Relis tes réponses avant de lancer la génération.",
    fields: [],
  },
] as const satisfies readonly PlanStep[];

/** Dernière étape : celle qui porte la soumission, et où l'on revient après un échec. */
export const SUMMARY_STEP_INDEX = PLAN_STEPS.length - 1;

/** Une date civile `AAAA-MM-JJ` — la forme seule ; le calendrier, c'est l'affaire de l'action. */
const CIVIL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Un nombre décimal écrit à la française ou à l'anglaise : « 4 », « 4,5 », « 4.5 ». */
const DECIMAL_SHAPE = /^\d+([.,]\d+)?$/;

/**
 * Valeurs de départ de la modale. `startsOn` est pré-rempli à aujourd'hui : le
 * champ vide vaudrait la même chose côté action, mais l'athlète doit voir la
 * date à laquelle son plan démarre.
 */
export function initialPlanFormValues(defaultStartDate: string): PlanFormValues {
  return {
    intent: DEFAULT_INTENT,
    goalText: "",
    raceDate: "",
    weeks: String(DEFAULT_WEEKS),
    returnInjuryHistory: false,
    level: DEFAULT_LEVEL,
    referenceDistance: DEFAULT_REFERENCE_DISTANCE,
    referenceTime: "",
    sessionsPerWeek: String(DEFAULT_SESSIONS_PER_WEEK),
    longRunDay: String(DEFAULT_LONG_RUN_DAY),
    weeklyTimeHours: "",
    startsOn: defaultStartDate,
  };
}

/**
 * Ce champ laisse-t-il continuer ?
 *
 * Un champ facultatif (temps hebdomadaire, date de démarrage) ne bloque que s'il
 * est rempli de travers, et un champ qui ne concerne pas le type d'objectif
 * choisi ne bloque jamais.
 */
function isFieldComplete(field: PlanFormField, values: PlanFormValues): boolean {
  switch (field) {
    case "intent":
      return INTENT_CHOICES.some((choice) => choice.value === values.intent);
    case "goalText":
      // Note libre : elle ne retient jamais l'avancement depuis que
      // l'intention dit ce que le plan prépare.
      return true;
    case "raceDate":
      // La date de course n'existe que pour une course datée.
      return values.intent !== "race" || CIVIL_DATE_SHAPE.test(values.raceDate);
    case "weeks":
      // La durée, elle, n'existe que pour les intentions sans échéance.
      return values.intent === "race" || values.weeks.trim() !== "";
    case "level":
      return LEVEL_CHOICES.some((choice) => choice.value === values.level);
    case "referenceDistance":
      return asReferenceDistance(values.referenceDistance) !== null;
    case "referenceTime":
      // Facultatif, et fortement encouragé : sans chrono le coach reste prudent,
      // mais un chrono mal écrit ne doit pas partir au serveur.
      return (
        values.referenceTime.trim() === "" || parseRaceTimeSeconds(values.referenceTime) !== null
      );
    case "sessionsPerWeek":
      return values.sessionsPerWeek.trim() !== "";
    case "longRunDay":
      return values.longRunDay.trim() !== "";
    case "weeklyTimeHours":
      // Facultatif : vide, le coach choisit le volume qu'il juge tenable.
      return values.weeklyTimeHours.trim() === "" || DECIMAL_SHAPE.test(values.weeklyTimeHours.trim());
    case "startsOn":
      // Facultatif aussi : vide vaut aujourd'hui pour le service.
      return values.startsOn.trim() === "" || CIVIL_DATE_SHAPE.test(values.startsOn);
  }
}

/** Les champs de l'étape qui empêchent encore de passer à la suivante. */
export function incompleteStepFields(
  step: PlanStep,
  values: PlanFormValues,
): readonly PlanFormField[] {
  return step.fields.filter((field) => !isFieldComplete(field, values));
}

/** L'étape est-elle en état de laisser avancer ? */
export function isStepComplete(step: PlanStep, values: PlanFormValues): boolean {
  return incompleteStepFields(step, values).length === 0;
}

/** Index de l'étape qui porte ce champ, `null` s'il n'appartient à aucune. */
export function stepIndexOfField(field: PlanFormField): number | null {
  const index = PLAN_STEPS.findIndex((step) =>
    step.fields.some((candidate) => candidate === field),
  );
  return index === -1 ? null : index;
}

/**
 * Première étape (dans l'ordre de la modale) touchée par les erreurs de la
 * Server Action, ou `null` quand l'échec ne désigne aucun champ — coach
 * injoignable, sortie inexploitable : il n'y a rien à corriger dans le
 * formulaire, l'athlète reste alors sur le récapitulatif où la bannière l'attend.
 */
export function firstStepIndexWithError(
  fieldErrors: Partial<Record<PlanFormField, string>> | undefined,
): number | null {
  if (fieldErrors === undefined) return null;

  let earliest: number | null = null;
  for (const key of Object.keys(fieldErrors)) {
    const field = asPlanFormField(key);
    if (field === null || fieldErrors[field] === undefined) continue;

    const index = stepIndexOfField(field);
    if (index !== null && (earliest === null || index < earliest)) earliest = index;
  }
  return earliest;
}

/** Les champs déclarés par les étapes — l'ensemble sur lequel une clé inconnue est écartée. */
const KNOWN_FIELDS: readonly PlanFormField[] = PLAN_STEPS.flatMap((step) => step.fields);

/**
 * `Object.keys` rend des `string` : cette garde ramène la clé à un champ connu,
 * plutôt que de l'affirmer par une assertion de type.
 */
function asPlanFormField(key: string): PlanFormField | null {
  return KNOWN_FIELDS.find((field) => field === key) ?? null;
}

/**
 * L'athlète a-t-elle déjà saisi quelque chose ?
 *
 * Sert la confirmation de fermeture : une saisie de plusieurs étapes ne se perd
 * pas sur une touche `Esc` malheureuse, mais une modale ouverte par erreur se
 * referme sans cérémonie.
 */
export function hasPlanFormInput(values: PlanFormValues, initial: PlanFormValues): boolean {
  return (Object.keys(initial) as (keyof PlanFormValues)[]).some(
    (key) => values[key] !== initial[key],
  );
}
