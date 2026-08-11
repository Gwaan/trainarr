import { describe, expect, it } from "vitest";

import { PLAN_FORM_FIELDS } from "./form-options";
import {
  PLAN_STEPS,
  SUMMARY_STEP_INDEX,
  firstStepIndexWithError,
  hasPlanFormInput,
  incompleteStepFields,
  initialPlanFormValues,
  isStepComplete,
  stepIndexOfField,
  type PlanFormValues,
} from "./plan-steps";

/**
 * La modale ne décide de rien : elle affiche l'étape que ce module désigne.
 * Ce qui est éprouvé ici, c'est donc ce sur quoi elle s'appuie — l'ordre des
 * étapes, ce qui bloque « Suivant », et le chemin de retour d'une erreur du
 * serveur vers l'étape du champ fautif.
 */

const TODAY = "2026-08-11";

function values(overrides: Partial<PlanFormValues> = {}): PlanFormValues {
  return { ...initialPlanFormValues(TODAY), ...overrides };
}

/** L'étape désignée par son identifiant — aucun test ne numérote une étape en dur. */
function step(id: (typeof PLAN_STEPS)[number]["id"]) {
  const found = PLAN_STEPS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`étape inconnue : ${id}`);
  return found;
}

describe("PLAN_STEPS", () => {
  it("va de l'objectif au récapitulatif, qui ferme la marche", () => {
    expect(PLAN_STEPS.map((candidate) => candidate.id)).toEqual([
      "goal",
      "profile",
      "constraints",
      "summary",
    ]);
    expect(PLAN_STEPS[SUMMARY_STEP_INDEX].id).toBe("summary");
  });

  it("place chaque champ du formulaire sur une étape et une seule", () => {
    const fields = PLAN_STEPS.flatMap((candidate) => candidate.fields);
    expect(new Set(fields).size).toBe(fields.length);
    // Égalité stricte des deux ensembles avec la liste que parcourt la Server
    // Action, pas une liste recopiée à la main : un champ qui manquerait aux
    // étapes verrait son erreur s'afficher sur une étape inatteignable, un champ
    // en trop désignerait une étape pour une erreur qui ne viendra jamais.
    expect(new Set(fields)).toEqual(new Set(PLAN_FORM_FIELDS));
  });

  it("ne pose aucun champ sur le récapitulatif, qui ne fait que relire", () => {
    expect(step("summary").fields).toEqual([]);
  });
});

describe("incompleteStepFields", () => {
  it("retient l'objectif tant que sa phrase et sa date manquent", () => {
    expect(incompleteStepFields(step("goal"), values())).toEqual(["goalText", "raceDate"]);
  });

  it("laisse passer une course datée complète", () => {
    const complete = values({ goalText: "10 km sous 50 min", raceDate: "2026-11-08" });
    expect(isStepComplete(step("goal"), complete)).toBe(true);
  });

  it("n'exige pas de date de course pour un objectif libre, ni de durée pour une course", () => {
    const free = values({ goalType: "free", goalText: "Améliorer mon endurance", raceDate: "" });
    expect(isStepComplete(step("goal"), free)).toBe(true);

    const race = values({ goalText: "Semi de Nantes", raceDate: "2026-11-08", weeks: "" });
    expect(isStepComplete(step("goal"), race)).toBe(true);
  });

  it("refuse une date de course qui n'a pas la forme d'une date", () => {
    const wrong = values({ goalText: "Semi de Nantes", raceDate: "08/11/2026" });
    expect(incompleteStepFields(step("goal"), wrong)).toEqual(["raceDate"]);
  });

  it("laisse passer le profil et les contraintes, qui partent avec leurs défauts", () => {
    expect(isStepComplete(step("profile"), values())).toBe(true);
    expect(isStepComplete(step("constraints"), values())).toBe(true);
  });

  it("accepte un temps hebdomadaire vide, ou écrit avec une virgule", () => {
    expect(isStepComplete(step("constraints"), values({ weeklyTimeHours: "" }))).toBe(true);
    expect(isStepComplete(step("constraints"), values({ weeklyTimeHours: "4,5" }))).toBe(true);
    expect(isStepComplete(step("constraints"), values({ weeklyTimeHours: "4.5" }))).toBe(true);
  });

  it("bloque un temps hebdomadaire qui n'est pas un nombre", () => {
    expect(incompleteStepFields(step("constraints"), values({ weeklyTimeHours: "quatre" }))).toEqual(
      ["weeklyTimeHours"],
    );
  });

  it("bloque une date de démarrage mal formée, mais pas une date effacée", () => {
    expect(incompleteStepFields(step("constraints"), values({ startsOn: "demain" }))).toEqual([
      "startsOn",
    ]);
    expect(isStepComplete(step("constraints"), values({ startsOn: "" }))).toBe(true);
  });

  it("ne bloque jamais le récapitulatif", () => {
    expect(isStepComplete(step("summary"), values({ goalText: "" }))).toBe(true);
  });
});

describe("stepIndexOfField", () => {
  it("ramène chaque champ à l'étape qui le pose", () => {
    expect(stepIndexOfField("raceDate")).toBe(PLAN_STEPS.indexOf(step("goal")));
    expect(stepIndexOfField("level")).toBe(PLAN_STEPS.indexOf(step("profile")));
    expect(stepIndexOfField("longRunDay")).toBe(PLAN_STEPS.indexOf(step("constraints")));
  });
});

describe("firstStepIndexWithError", () => {
  it("renvoie l'étape la plus en amont parmi les champs fautifs", () => {
    const index = firstStepIndexWithError({
      longRunDay: "Sortie longue : choisis un jour de la semaine.",
      goalText: "Décris ton objectif en une phrase.",
    });
    expect(index).toBe(PLAN_STEPS.indexOf(step("goal")));
  });

  it("renvoie null quand l'échec ne désigne aucun champ", () => {
    expect(firstStepIndexWithError(undefined)).toBeNull();
    expect(firstStepIndexWithError({})).toBeNull();
  });

  it("ignore une clé inconnue plutôt que de renvoyer une étape au hasard", () => {
    // Ce que renverrait une action dont les champs auraient changé de nom.
    const foreign: Record<string, string> = { inventé: "erreur" };
    expect(firstStepIndexWithError(foreign)).toBeNull();
  });
});

describe("hasPlanFormInput", () => {
  it("ne voit aucune saisie sur des valeurs intactes", () => {
    const initial = initialPlanFormValues(TODAY);
    expect(hasPlanFormInput({ ...initial }, initial)).toBe(false);
  });

  it("voit la moindre réponse, y compris un choix fermé changé", () => {
    const initial = initialPlanFormValues(TODAY);
    expect(hasPlanFormInput({ ...initial, goalText: "S" }, initial)).toBe(true);
    expect(hasPlanFormInput({ ...initial, level: "advanced" }, initial)).toBe(true);
    expect(hasPlanFormInput({ ...initial, startsOn: "2026-09-01" }, initial)).toBe(true);
  });
});
