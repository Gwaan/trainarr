import { describe, expect, it } from "vitest";

import {
  MIN_BAR_RATIO,
  fastestSplitIndex,
  paceExtent,
  splitBarRatio,
} from "./splits-model";

describe("paceExtent", () => {
  it("borne la séance sur ses kilomètres mesurés", () => {
    expect(paceExtent([300, null, 264, 320])).toEqual({ fastest: 264, slowest: 320 });
  });

  it("rend null quand aucun kilomètre n'a d'allure", () => {
    expect(paceExtent([null, null])).toBeNull();
    expect(paceExtent([0, Number.NaN])).toBeNull();
  });
});

describe("splitBarRatio", () => {
  const extent = { fastest: 264, slowest: 320 };

  it("donne la barre pleine au plus rapide et la barre minimale au plus lent", () => {
    expect(splitBarRatio(264, extent)).toBe(1);
    expect(splitBarRatio(320, extent)).toBeCloseTo(MIN_BAR_RATIO, 10);
  });

  it("interpole linéairement entre les deux bornes", () => {
    expect(splitBarRatio(292, extent)).toBeCloseTo(MIN_BAR_RATIO + (1 - MIN_BAR_RATIO) / 2, 10);
  });

  it("donne la barre pleine à tous quand la séance est parfaitement régulière", () => {
    expect(splitBarRatio(300, { fastest: 300, slowest: 300 })).toBe(1);
  });

  it("ne dessine rien sans allure mesurée", () => {
    expect(splitBarRatio(null, extent)).toBeNull();
    expect(splitBarRatio(300, null)).toBeNull();
  });
});

describe("fastestSplitIndex", () => {
  it("désigne le meilleur kilomètre, le premier en cas d'égalité", () => {
    expect(fastestSplitIndex([300, 264, 320])).toBe(1);
    expect(fastestSplitIndex([264, 264])).toBe(0);
  });

  it("ne désigne rien quand aucune allure n'est mesurée", () => {
    expect(fastestSplitIndex([null, null])).toBeNull();
    expect(fastestSplitIndex([])).toBeNull();
  });
});
