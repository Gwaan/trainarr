import { describe, expect, it } from "vitest";

import { RANGE_OPTIONS, parseRangeParam, rangeHref, toProgressionRange } from "./range";

describe("parseRangeParam", () => {
  it("accepte les périodes proposées par le filtre", () => {
    for (const option of RANGE_OPTIONS) {
      expect(parseRangeParam(option.param)).toBe(option.param);
    }
  });

  it("retombe sur six mois pour tout ce qui vient du navigateur et n'en est pas", () => {
    // Le paramètre peut être absent, répété, ou franchement hostile.
    expect(parseRangeParam(undefined)).toBe("6m");
    expect(parseRangeParam("2 ans")).toBe("6m");
    expect(parseRangeParam(["3m", "1a"])).toBe("6m");
    expect(parseRangeParam({ periode: "3m" })).toBe("6m");
  });
});

describe("toProgressionRange", () => {
  it("traduit l'URL française vers le contrat du DAL", () => {
    expect(RANGE_OPTIONS.map((option) => toProgressionRange(option.param))).toEqual([
      "3m",
      "6m",
      "1y",
      "all",
    ]);
  });
});

describe("rangeHref", () => {
  it("laisse l'URL nue sur la période par défaut", () => {
    expect(rangeHref("6m")).toBe("/progression");
    expect(rangeHref("1a")).toBe("/progression?periode=1a");
  });
});
