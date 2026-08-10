import { describe, expect, it } from "vitest";

import { describeFitnessUnavailable, describeVo2maxUnavailable } from "./metric-unavailable";

const PROFILE_ACTION = { href: "/profile", label: "Compléter mon profil" };

describe("describeFitnessUnavailable", () => {
  it("nomme le champ de profil manquant et renvoie vers le profil", () => {
    const copy = describeFitnessUnavailable({
      missingProfileFields: ["sex"],
      noHeartRateData: false,
    });

    expect(copy.title).toBe("Profil incomplet");
    expect(copy.description).toBe(
      "Renseigne ton sexe dans ton profil pour activer le calcul de charge.",
    );
    expect(copy.action).toEqual(PROFILE_ACTION);
  });

  it.each([
    [["maxHrBpm"], "ta FC max"],
    [["restingHrBpm"], "ta FC de repos"],
    [["sex", "maxHrBpm"], "ton sexe et ta FC max"],
    [["maxHrBpm", "restingHrBpm"], "ta FC max et ta FC de repos"],
    [["sex", "maxHrBpm", "restingHrBpm"], "ton sexe, ta FC max et ta FC de repos"],
  ] as const)("énumère %j en français (« %s »)", (fields, expected) => {
    const copy = describeFitnessUnavailable({
      missingProfileFields: [...fields],
      noHeartRateData: false,
    });

    expect(copy.description).toBe(
      `Renseigne ${expected} dans ton profil pour activer le calcul de charge.`,
    );
  });

  it("fait passer le profil avant les données quand les deux manquent", () => {
    const copy = describeFitnessUnavailable({
      missingProfileFields: ["sex"],
      noHeartRateData: true,
    });

    // Un champ se remplit en dix secondes ; une séance manquante, non.
    expect(copy.title).toBe("Profil incomplet");
    expect(copy.action).toEqual(PROFILE_ACTION);
  });

  it("désigne l’absence de fréquence cardiaque, sans lien vers le profil", () => {
    const copy = describeFitnessUnavailable({
      missingProfileFields: [],
      noHeartRateData: true,
    });

    expect(copy.title).toBe("Aucune séance avec fréquence cardiaque");
    expect(copy.action).toBeUndefined();
  });

  it("reste explicite quand aucune cause franche n’est identifiée", () => {
    const copy = describeFitnessUnavailable({
      missingProfileFields: [],
      noHeartRateData: false,
    });

    expect(copy.title).toBe("Charge indisponible");
    expect(copy.description).toContain("exploitable");
    expect(copy.action).toBeUndefined();
  });

  it("retombe sur un message générique sans athlète", () => {
    const copy = describeFitnessUnavailable(null);

    expect(copy.title).toBe("Charge indisponible");
    expect(copy.action).toBeUndefined();
  });
});

describe("describeVo2maxUnavailable", () => {
  it("réclame la FC max, dont la correction dépend, et renvoie vers le profil", () => {
    const copy = describeVo2maxUnavailable({
      missingMaxHrBpm: true,
      noRecentRunWithHeartRate: false,
    });

    expect(copy.title).toBe("FC max manquante");
    expect(copy.description).toContain("FC max");
    expect(copy.action).toEqual(PROFILE_ACTION);
  });

  it("fait passer la FC max avant l’absence de course récente", () => {
    const copy = describeVo2maxUnavailable({
      missingMaxHrBpm: true,
      noRecentRunWithHeartRate: true,
    });

    expect(copy.title).toBe("FC max manquante");
    expect(copy.action).toEqual(PROFILE_ACTION);
  });

  it("désigne l’absence de course avec FC sur trente jours", () => {
    const copy = describeVo2maxUnavailable({
      missingMaxHrBpm: false,
      noRecentRunWithHeartRate: true,
    });

    expect(copy.title).toBe("Aucune course avec FC sur 30 jours");
    expect(copy.action).toBeUndefined();
  });

  it("explique le cas des courses présentes mais inexploitables", () => {
    const copy = describeVo2maxUnavailable({
      missingMaxHrBpm: false,
      noRecentRunWithHeartRate: false,
    });

    expect(copy.title).toBe("Pas encore d'effort exploitable");
    expect(copy.description).toContain("1,5 km");
    expect(copy.action).toBeUndefined();
  });

  it("retombe sur un message générique sans athlète", () => {
    const copy = describeVo2maxUnavailable(null);

    expect(copy.title).toBe("VO₂max indisponible");
    expect(copy.action).toBeUndefined();
  });
});
