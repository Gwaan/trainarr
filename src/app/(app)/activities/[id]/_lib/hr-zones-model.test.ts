import { describe, expect, it } from "vitest";

import {
  MIN_ZONE_BAR_PCT,
  totalZoneSeconds,
  zoneBarClass,
  zoneBarWidthPct,
} from "./hr-zones-model";

describe("totalZoneSeconds", () => {
  it("somme les temps de zone en écartant l'aberrant", () => {
    expect(totalZoneSeconds([600, 300, 0, Number.NaN, -5])).toBe(900);
  });
});

describe("zoneBarWidthPct", () => {
  it("suit la part rendue par le DAL", () => {
    expect(zoneBarWidthPct(0.5)).toBe(50);
    expect(zoneBarWidthPct(1)).toBe(100);
  });

  it("garde une amorce visible pour une zone marginale", () => {
    expect(zoneBarWidthPct(0.0001)).toBe(MIN_ZONE_BAR_PCT);
  });

  it("ne dessine aucune barre pour une zone à zéro", () => {
    expect(zoneBarWidthPct(0)).toBe(0);
    expect(zoneBarWidthPct(Number.NaN)).toBe(0);
  });
});

describe("zoneBarClass", () => {
  it("suit la rampe séquentielle Z1 → Z5", () => {
    expect([1, 2, 3, 4, 5].map(zoneBarClass)).toEqual([
      "bg-zone-1",
      "bg-zone-2",
      "bg-zone-3",
      "bg-zone-4",
      "bg-zone-5",
    ]);
  });
});
