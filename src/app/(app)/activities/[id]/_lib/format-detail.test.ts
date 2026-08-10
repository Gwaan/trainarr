import { describe, expect, it } from "vitest";

import {
  formatAltitude,
  formatCadence,
  formatClock,
  formatDistanceTick,
  formatElevationGain,
  formatFullDateTime,
  formatPaceValue,
  formatTrimp,
} from "./format-detail";
import { parseActivityId } from "./activity-id";

describe("formatClock", () => {
  it("affiche la durée à la seconde", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59)).toBe("0:59");
    expect(formatClock(2892)).toBe("48:12");
    expect(formatClock(3872)).toBe("1:04:32");
    expect(formatClock(-10)).toBe("0:00");
  });
});

describe("formatPaceValue", () => {
  it("rend l'allure nue, secondes sur deux chiffres", () => {
    expect(formatPaceValue(275)).toBe("4:35");
    expect(formatPaceValue(240)).toBe("4:00");
    expect(formatPaceValue(605)).toBe("10:05");
  });
});

describe("formats d'unités", () => {
  it("signe le dénivelé et arrondit à l'entier", () => {
    expect(formatElevationGain(124.4)).toBe("+124 m");
    expect(formatElevationGain(-3)).toBe("+0 m");
  });

  it("formate altitude, cadence et TRIMP", () => {
    expect(formatAltitude(412.6)).toBe("413 m");
    expect(formatCadence(174.2)).toBe("174 spm");
    expect(formatTrimp(118.7)).toBe("119");
  });
});

describe("formatDistanceTick", () => {
  it("suit la précision du pas de graduation", () => {
    expect(formatDistanceTick(5000, 1000)).toBe("5");
    expect(formatDistanceTick(2500, 500)).toBe("2,5");
  });
});

describe("formatFullDateTime", () => {
  it("donne la date complète et l'heure locale de l'athlète", () => {
    // 9 août 2026 à 16:42 UTC, soit 18:42 à Paris.
    const formatted = formatFullDateTime(new Date("2026-08-09T16:42:00Z"));
    expect(formatted).toContain("9 août 2026");
    expect(formatted).toContain("18:42");
    expect(formatted.startsWith("D")).toBe(true);
  });
});

describe("parseActivityId", () => {
  it("accepte un identifiant canonique", () => {
    expect(parseActivityId("42")).toBe(42);
    expect(parseActivityId("1")).toBe(1);
  });

  it("refuse tout ce qui n'est pas un entier positif écrit sans fioriture", () => {
    for (const raw of ["0", "01", "-3", "1.5", " 1", "1e3", "abc", "", "9999999999"]) {
      expect(parseActivityId(raw)).toBeNull();
    }
  });
});
