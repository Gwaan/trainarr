import { describe, expect, it } from "vitest";

import {
  PLAN_REVISION_DIRECTIONS,
  formatRevisionIntensity,
  formatRevisionKm,
  formatRevisionVolume,
  formatRevisionWeeks,
} from "./plan-revision-view";

describe("formatRevisionKm", () => {
  it("arrondit à l’unité dès la dizaine de kilomètres", () => {
    expect(formatRevisionKm(41.7)).toBe("42");
    expect(formatRevisionKm(36.2)).toBe("36");
    expect(formatRevisionKm(10)).toBe("10");
  });

  it("garde le dixième sous 10 km, où l’unité écraserait l’écart", () => {
    expect(formatRevisionKm(8.4)).toBe("8,4");
    expect(formatRevisionKm(0)).toBe("0");
    expect(formatRevisionKm(6)).toBe("6");
  });
});

describe("formatRevisionWeeks", () => {
  it("accorde en nombre", () => {
    expect(formatRevisionWeeks(3)).toBe("3 semaines restantes");
    expect(formatRevisionWeeks(1)).toBe("1 semaine restante");
  });
});

describe("formatRevisionVolume", () => {
  it("dit le kilométrage d’avant, celui d’après, et sur quoi", () => {
    expect(
      formatRevisionVolume({ volumeKm: 41.7, intensityKm: 9 }, { volumeKm: 36.2, intensityKm: 7 }, 3),
    ).toBe("42 → 36 km sur les 3 semaines restantes");
  });
});

describe("formatRevisionIntensity", () => {
  it("dit le volume d’intensité quand il y en a", () => {
    expect(
      formatRevisionIntensity({ volumeKm: 42, intensityKm: 9 }, { volumeKm: 36, intensityKm: 7 }),
    ).toBe("dont 9 → 7 km d’intensité");
  });

  it("se tait quand il n’y en a d’aucun côté", () => {
    // Un plan de reprise n'en porte aucune : « 0 → 0 km » ferait croire à une
    // donnée manquante plutôt qu'à une absence voulue.
    expect(
      formatRevisionIntensity({ volumeKm: 30, intensityKm: 0 }, { volumeKm: 34, intensityKm: 0 }),
    ).toBeNull();
  });

  it("parle dès qu’un seul des deux côtés en porte", () => {
    expect(
      formatRevisionIntensity({ volumeKm: 30, intensityKm: 0 }, { volumeKm: 34, intensityKm: 6 }),
    ).toBe("dont 0 → 6 km d’intensité");
  });
});

describe("PLAN_REVISION_DIRECTIONS", () => {
  it("nomme les trois sens sans jamais employer un ton d’alerte", () => {
    expect(PLAN_REVISION_DIRECTIONS.increase.label).toBe("Plus de charge");
    expect(PLAN_REVISION_DIRECTIONS.decrease.label).toBe("Moins de charge");
    expect(PLAN_REVISION_DIRECTIONS.neutral.label).toBe("Sans changement de charge");
  });

  it("porte un signe pour chacun : la couleur ne dit jamais le sens seule", () => {
    expect(PLAN_REVISION_DIRECTIONS.increase.sign).toBe("↑");
    expect(PLAN_REVISION_DIRECTIONS.decrease.sign).toBe("↓");
    expect(PLAN_REVISION_DIRECTIONS.neutral.sign).toBe("=");
  });
});
