import { describe, expect, it } from "vitest";

import { planRecapEntries } from "./plan-recap";
import { initialPlanFormValues, type PlanFormValues } from "./plan-steps";

/**
 * Le récapitulatif précède plusieurs minutes d'attente : il doit relire les
 * réponses en français, sans quoi il ne sert à rien de le lire.
 */

const TODAY = "2026-08-11";

function values(overrides: Partial<PlanFormValues> = {}): PlanFormValues {
  return { ...initialPlanFormValues(TODAY), ...overrides };
}

function valueOf(entries: readonly { label: string; value: string }[], label: string): string {
  const entry = entries.find((candidate) => candidate.label === label);
  if (entry === undefined) throw new Error(`ligne absente du récapitulatif : ${label}`);
  return entry.value;
}

describe("planRecapEntries", () => {
  it("relit une course datée avec ses libellés humains", () => {
    const entries = planRecapEntries(
      values({ goalText: "  Semi de Nantes  ", raceDate: "2026-11-08", weeklyTimeHours: "4,5" }),
    );

    expect(valueOf(entries, "Type d'objectif")).toBe("Course datée");
    expect(valueOf(entries, "Ta course")).toBe("Semi de Nantes");
    expect(valueOf(entries, "Date de la course")).toBe("8 nov.");
    expect(valueOf(entries, "Ton niveau")).toBe("Intermédiaire");
    expect(valueOf(entries, "Chrono de référence")).toBe("Aucun — le coach restera prudent");
    expect(valueOf(entries, "Séances par semaine")).toBe("4 séances");
    expect(valueOf(entries, "Sortie longue")).toBe("Dimanche");
    expect(valueOf(entries, "Temps par semaine")).toBe("4,5 h");
    expect(valueOf(entries, "Début du programme")).toBe("11 août");
  });

  it("remplace la date de course par la durée sur un objectif libre", () => {
    const entries = planRecapEntries(
      values({ goalType: "free", goalText: "Améliorer mon endurance", weeks: "12" }),
    );

    expect(valueOf(entries, "Ton objectif")).toBe("Améliorer mon endurance");
    expect(valueOf(entries, "Durée du plan")).toBe("12 semaines");
    expect(entries.some((entry) => entry.label === "Date de la course")).toBe(false);
  });

  it("relit le chrono avec sa distance en toutes lettres", () => {
    const entries = planRecapEntries(
      values({ referenceDistance: "half", referenceTime: " 1:52:00 " }),
    );

    expect(valueOf(entries, "Chrono de référence")).toBe("Semi en 1:52:00");
  });

  it("relit le chrono normalisé, pas la frappe", () => {
    // `1:5:30` est accepté par le masque : la relecture montre ce que le service
    // va comprendre.
    const entries = planRecapEntries(values({ referenceDistance: "half", referenceTime: "1:5:30" }));

    expect(valueOf(entries, "Chrono de référence")).toBe("Semi en 1:05:30");
  });

  it("laisse une saisie que le masque refuse telle quelle", () => {
    // La corriger n'est pas le rôle de cette ligne, et l'afficher brute donne une
    // chance de voir l'erreur avant plusieurs minutes d'attente.
    const entries = planRecapEntries(values({ referenceTime: "48min" }));

    expect(valueOf(entries, "Chrono de référence")).toBe("10 km en 48min");
  });

  it("dit ce que devient un temps hebdomadaire laissé vide", () => {
    const entries = planRecapEntries(values({ weeklyTimeHours: "" }));
    expect(valueOf(entries, "Temps par semaine")).toBe("Au choix du coach");
  });

  it("écrit le point décimal à la française", () => {
    const entries = planRecapEntries(values({ weeklyTimeHours: "4.5" }));
    expect(valueOf(entries, "Temps par semaine")).toBe("4,5 h");
  });

  it("marque en chiffré ce qui doit s'afficher en mono, et rien d'autre", () => {
    const entries = planRecapEntries(
      values({ goalText: "Semi", raceDate: "2026-11-08", referenceTime: "48:30" }),
    );
    const numeric = entries.filter((entry) => entry.numeric).map((entry) => entry.label);

    expect(numeric).toEqual([
      "Date de la course",
      "Chrono de référence",
      "Séances par semaine",
      "Début du programme",
    ]);
  });
});
