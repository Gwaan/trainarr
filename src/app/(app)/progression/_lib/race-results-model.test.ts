import { describe, expect, it } from "vitest";

import type { RaceCalibrationDto, Vo2maxCorrectionDto } from "@/data/vo2max-correction";

import {
  buildRaceRows,
  describeCorrection,
  formatCorrectionFactor,
} from "./race-results-model";

const TODAY = "2026-08-17";

function race(overrides: Partial<RaceCalibrationDto> = {}): RaceCalibrationDto {
  return {
    id: 3,
    racedOn: "2026-04-12",
    name: "10 km de Bordeaux",
    distanceM: 10_000,
    timeS: 2_700,
    activityId: 42,
    timeVo2max: 45.3,
    hrVo2max: 40.8,
    factor: 1.11,
    status: "eligible",
    ...overrides,
  };
}

function correction(overrides: Partial<Vo2maxCorrectionDto> = {}): Vo2maxCorrectionDto {
  return {
    factor: 1.11,
    source: "race",
    manualFactor: null,
    automaticFactor: 1.11,
    unavailable: null,
    calibratedOnRaceId: 3,
    races: [race()],
    ...overrides,
  };
}

describe("formatCorrectionFactor", () => {
  it("écrit le facteur comme il se lit", () => {
    expect(formatCorrectionFactor(1.128)).toBe("×1,128");
    expect(formatCorrectionFactor(1)).toBe("×1");
  });
});

describe("buildRaceRows", () => {
  it("désigne la course qui calibre", () => {
    const [row] = buildRaceRows(correction(), TODAY);

    expect(row.calibrating).toBe(true);
    expect(row.calibration).toBe("×1,11");
    expect(row.href).toBe("/activities/42");
    expect(row.day).toBe("dimanche 12 avril");
  });

  it("nomme une course sans intitulé par sa distance", () => {
    // Une ligne sans intitulé ne se lit pas.
    expect(buildRaceRows(correction({ races: [race({ name: null })] }), TODAY)[0].name).toBe(
      "10,0 km",
    );
  });

  it("n’ouvre aucune séance pour une course courue sans montre", () => {
    expect(
      buildRaceRows(correction({ races: [race({ activityId: null })] }), TODAY)[0].href,
    ).toBeNull();
  });

  it.each([
    ["no-heart-rate", "sans FC"],
    ["not-computable", "non exploitable"],
  ] as const)("dit pourquoi une course ne calibre pas (%s)", (status, expected) => {
    expect(
      buildRaceRows(
        correction({ races: [race({ status, factor: null })], calibratedOnRaceId: null }),
        TODAY,
      )[0].calibration,
    ).toBe(expected);
  });

  it("garde lisible le rapport d’une course écartée : c’est ce qui explique le rejet", () => {
    expect(
      buildRaceRows(
        correction({
          races: [race({ status: "out-of-bounds", factor: 0.55 })],
          calibratedOnRaceId: null,
        }),
        TODAY,
      )[0].calibration,
    ).toBe("×0,55 — écartée");
  });

  it("date les courses anciennes avec leur millésime", () => {
    expect(
      buildRaceRows(correction({ races: [race({ racedOn: "2024-10-06" })] }), TODAY)[0].day,
    ).toContain("2024");
  });
});

describe("describeCorrection", () => {
  it("nomme la course qui calibre et les deux VO₂max comparées", () => {
    const copy = describeCorrection(correction());

    expect(copy.title).toBe("VO₂max recalée ×1,11");
    expect(copy.description).toContain("10 km de Bordeaux");
    expect(copy.description).toContain("45,3");
    expect(copy.description).toContain("40,8");
  });

  it.each([
    ["no-race", "Aucune course déclarée"],
    ["no-race-with-heart-rate", "aucune fréquence cardiaque"],
    ["no-usable-race", "ne produit un écart crédible"],
  ] as const)("distingue les trois façons de n’avoir aucun facteur (%s)", (unavailable, needle) => {
    const copy = describeCorrection(
      correction({
        factor: 1,
        source: "default",
        automaticFactor: 1,
        unavailable,
        calibratedOnRaceId: null,
        races: [],
      }),
    );

    expect(copy.title).toBe("VO₂max non recalée");
    expect(copy.description).toContain(needle);
  });

  it("dit qu’un facteur manuel remplace le calcul, et ce qu’il remplace", () => {
    const copy = describeCorrection(
      correction({ factor: 1.05, source: "manual", manualFactor: 1.05 }),
    );

    expect(copy.title).toContain("×1,05");
    expect(copy.title).toContain("imposé");
    expect(copy.description).toContain("×1,11");
  });

  it("ne prétend rien des courses quand le manuel s’applique sans elles", () => {
    const copy = describeCorrection(
      correction({
        factor: 1.05,
        source: "manual",
        manualFactor: 1.05,
        automaticFactor: 1,
        unavailable: "no-race",
        calibratedOnRaceId: null,
        races: [],
      }),
    );

    expect(copy.description).toContain("Tes courses n’en produisent aucun");
  });
});
