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
  LEVEL_LABELS,
  REFERENCE_DISTANCE_LABELS,
  formatRaceTimeSeconds,
  parseRaceTimeSeconds,
} from "./form-options";
import { INTENT_LABELS } from "./plan-intent";
import type { PlanFormValues } from "./plan-steps";

export type PlanRecapEntry = {
  label: string;
  value: string;
  /** Valeur chiffrée : elle s'affiche en mono, comme partout dans l'appli. */
  numeric: boolean;
};

/**
 * Le chrono relu **normalisé** : `1:5:30` saisi se relit `1:05:30`.
 *
 * Le récapitulatif est la dernière relecture avant plusieurs minutes d'attente —
 * il doit montrer le chrono tel que le service va le comprendre, pas la frappe.
 * Une saisie que le masque refuse reste telle quelle : la corriger n'est pas le
 * rôle de cette ligne, et l'afficher brute donne une chance de voir l'erreur.
 */
function raceTimeOrRaw(input: string): string {
  const seconds = parseRaceTimeSeconds(input);
  return seconds === null ? input : formatRaceTimeSeconds(seconds);
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
    { label: "Ton intention", value: INTENT_LABELS[values.intent], numeric: false },
  ];

  if (values.intent === "race") {
    entries.push({
      label: "Date de la course",
      value: civilDayOrRaw(values.raceDate),
      numeric: true,
    });
  } else {
    entries.push({ label: "Durée du plan", value: `${values.weeks} semaines`, numeric: true });
  }

  // La case ne se relit que là où elle a un sens : hors reprise, l'antécédent ne
  // déplace aucun paramètre du plan (cf. `plan-skeleton/intent.ts`).
  if (values.intent === "return") {
    entries.push({
      label: "Blessure récente",
      value: values.returnInjuryHistory ? "Oui" : "Non",
      numeric: false,
    });
  }

  entries.push({
    label: "Note pour le coach",
    value: values.goalText.trim() === "" ? "Aucune" : values.goalText.trim(),
    numeric: false,
  });

  const referenceTime = values.referenceTime.trim();

  entries.push(
    { label: "Ton niveau", value: LEVEL_LABELS[values.level], numeric: false },
    {
      label: "Chrono de référence",
      // Sans chrono, la ligne dit ce que ça coûte plutôt que « — » : c'est la
      // dernière occasion de revenir en arrière pour le renseigner.
      value:
        referenceTime === ""
          ? "Aucun — le coach restera prudent"
          : `${REFERENCE_DISTANCE_LABELS[values.referenceDistance]} en ${raceTimeOrRaw(referenceTime)}`,
      numeric: referenceTime !== "",
    },
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
