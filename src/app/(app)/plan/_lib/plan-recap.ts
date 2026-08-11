/**
 * Relecture des réponses avant génération.
 *
 * Le récapitulatif est la dernière chose que l'athlète lit avant plusieurs
 * minutes d'attente : il doit dire ce qui va être demandé au coach en français,
 * pas répéter les valeurs brutes du formulaire (« 7 », « race », « 2026-09-13 »).
 *
 * Fonction pure, donc testable : c'est le seul endroit où ces libellés se
 * décident.
 */

import { formatCivilDay, formatIsoDay } from "./format-plan";
import {
  GOAL_TYPE_CHOICES,
  LEVEL_LABELS,
  type GoalType,
} from "./form-options";
import type { PlanFormValues } from "./plan-steps";

export type PlanRecapEntry = {
  label: string;
  value: string;
  /** Valeur chiffrée : elle s'affiche en mono, comme partout dans l'appli. */
  numeric: boolean;
};

/** Libellé français d'un type d'objectif. Le repli ne sert jamais : les deux types sont listés. */
function goalTypeLabel(goalType: GoalType): string {
  return GOAL_TYPE_CHOICES.find((choice) => choice.value === goalType)?.label ?? "Objectif";
}

/** Une date civile bien formée s'écrit en clair, une saisie douteuse reste telle quelle. */
function civilDayOrRaw(civilDate: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(civilDate) ? formatCivilDay(civilDate) : civilDate;
}

/**
 * Les réponses relues, dans l'ordre où la modale les a posées.
 *
 * `startsOn` est toujours rempli par la modale ; vide, il vaut « aujourd'hui »,
 * ce que le service applique de son côté.
 */
export function planRecapEntries(values: PlanFormValues): readonly PlanRecapEntry[] {
  const entries: PlanRecapEntry[] = [
    { label: "Type d'objectif", value: goalTypeLabel(values.goalType), numeric: false },
    {
      label: values.goalType === "race" ? "Ta course" : "Ton objectif",
      value: values.goalText.trim(),
      numeric: false,
    },
  ];

  if (values.goalType === "race") {
    entries.push({
      label: "Date de la course",
      value: civilDayOrRaw(values.raceDate),
      numeric: true,
    });
  } else {
    entries.push({ label: "Durée du plan", value: `${values.weeks} semaines`, numeric: true });
  }

  entries.push(
    { label: "Ton niveau", value: LEVEL_LABELS[values.level], numeric: false },
    { label: "Séances par semaine", value: `${values.sessionsPerWeek} séances`, numeric: true },
    { label: "Sortie longue", value: longRunDayLabel(values.longRunDay), numeric: false },
    {
      label: "Temps par semaine",
      value:
        values.weeklyTimeHours.trim() === ""
          ? "Au choix du coach"
          : `${values.weeklyTimeHours.trim().replace(".", ",")} h`,
      numeric: values.weeklyTimeHours.trim() !== "",
    },
    {
      label: "Début du programme",
      value: values.startsOn.trim() === "" ? "Aujourd'hui" : civilDayOrRaw(values.startsOn),
      numeric: values.startsOn.trim() !== "",
    },
  );

  return entries;
}

/** Jour ISO (1 = lundi) tel que le `<select>` le transmet, en toutes lettres. */
function longRunDayLabel(longRunDay: string): string {
  const day = Number(longRunDay);
  return Number.isInteger(day) && day >= 1 && day <= 7 ? formatIsoDay(day) : longRunDay;
}
