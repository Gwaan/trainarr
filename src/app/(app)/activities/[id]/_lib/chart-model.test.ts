import { describe, expect, it } from "vitest";

import {
  VIEW_H,
  VIEW_W,
  areaPath,
  chipSide,
  clampRatio,
  edgeAnchor,
  extentOf,
  linePath,
  nearestIndex,
  niceDomain,
  niceStep,
  normalize,
  projectSeries,
  projectY,
  ticksIn,
  timeStep,
} from "./chart-model";

describe("niceStep", () => {
  it("choisit un pas rond couvrant l'étendue", () => {
    expect(niceStep(100, 4)).toBe(25);
    expect(niceStep(37, 4)).toBe(10);
    expect(niceStep(0.42, 4)).toBe(0.2);
  });

  it("retombe sur 1 pour une étendue inexploitable", () => {
    expect(niceStep(0, 4)).toBe(1);
    expect(niceStep(Number.NaN, 4)).toBe(1);
    expect(niceStep(10, 0)).toBe(1);
  });
});

describe("timeStep", () => {
  it("choisit des durées lisibles, jamais de décimales de seconde", () => {
    expect(timeStep(120, 4)).toBe(30);
    expect(timeStep(3600, 5)).toBe(900);
    expect(timeStep(45, 4)).toBe(15);
  });

  it("plafonne au plus grand pas connu", () => {
    expect(timeStep(1_000_000, 4)).toBe(7200);
  });
});

describe("extentOf", () => {
  it("ignore les trous et les valeurs non finies", () => {
    expect(extentOf([null, 12, Number.NaN, 4, Number.POSITIVE_INFINITY])).toEqual({
      min: 4,
      max: 12,
    });
  });

  it("rend null quand rien n'est mesuré", () => {
    expect(extentOf([null, null])).toBeNull();
  });
});

describe("niceDomain", () => {
  it("élargit l'étendue aux multiples du pas", () => {
    expect(niceDomain({ min: 112, max: 178 }, 20)).toEqual({ min: 100, max: 180 });
  });

  it("centre une série plate au lieu de diviser par zéro", () => {
    expect(niceDomain({ min: 150, max: 150 }, 10)).toEqual({ min: 140, max: 160 });
  });
});

describe("ticksIn", () => {
  it("gradue aux multiples du pas, bornes incluses", () => {
    expect(ticksIn({ min: 100, max: 180 }, 20)).toEqual([100, 120, 140, 160, 180]);
  });

  it("ne laisse pas dériver les multiples flottants", () => {
    expect(ticksIn({ min: 0, max: 0.5 }, 0.1)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it("borne le nombre d'étiquettes", () => {
    expect(ticksIn({ min: 0, max: 10_000 }, 1).length).toBeLessThanOrEqual(24);
    expect(ticksIn({ min: 0, max: 10 }, 0)).toEqual([]);
  });
});

describe("projectY", () => {
  it("place la valeur haute en haut du panneau", () => {
    expect(projectY(180, { min: 100, max: 180 }, false)).toBe(0);
    expect(projectY(100, { min: 100, max: 180 }, false)).toBe(VIEW_H);
  });

  it("inverse l'axe des allures : plus rapide (valeur basse) = plus haut", () => {
    const domain = { min: 240, max: 360 };
    const fast = projectY(240, domain, true);
    const slow = projectY(360, domain, true);
    expect(fast).toBe(0);
    expect(slow).toBe(VIEW_H);
    expect(fast).toBeLessThan(slow);
  });
});

describe("projectSeries", () => {
  const xs = [0, 500, 1000];
  const xDomain = { min: 0, max: 1000 };
  const yDomain = { min: 0, max: 100 };

  it("projette dans le repère du panneau", () => {
    expect(projectSeries(xs, [0, 50, 100], xDomain, yDomain, false)).toEqual([
      { x: 0, y: VIEW_H },
      { x: VIEW_W / 2, y: VIEW_H / 2 },
      { x: VIEW_W, y: 0 },
    ]);
  });

  it("conserve les trous — jamais d'interpolation d'une mesure absente", () => {
    const projected = projectSeries(xs, [0, null, 100], xDomain, yDomain, false);
    expect(projected[1]).toBeNull();
  });
});

describe("linePath", () => {
  it("relie les points par des segments droits", () => {
    expect(
      linePath([
        { x: 0, y: 10 },
        { x: 50, y: 20 },
      ]),
    ).toBe("M 0.00 10.00 L 50.00 20.00");
  });

  it("rouvre un tracé après un trou", () => {
    const d = linePath([{ x: 0, y: 0 }, null, { x: 10, y: 5 }, { x: 20, y: 6 }]);
    expect(d).toBe("M 0.00 0.00M 10.00 5.00 L 20.00 6.00");
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("rend une chaîne vide sans donnée", () => {
    expect(linePath([null, null])).toBe("");
  });
});

describe("areaPath", () => {
  it("ferme l'aire sur le pied du panneau", () => {
    expect(
      areaPath([
        { x: 0, y: 10 },
        { x: 100, y: 20 },
      ]),
    ).toBe(`M 0.00 ${VIEW_H} L 0.00 10.00 L 100.00 20.00 L 100.00 ${VIEW_H} Z`);
  });

  it("ignore un tronçon d'un seul point : il n'a pas de surface", () => {
    expect(areaPath([{ x: 0, y: 10 }, null])).toBe("");
  });
});

describe("nearestIndex", () => {
  const xs = [0, 100, 200, 300];

  it("trouve le point le plus proche", () => {
    expect(nearestIndex(xs, 0)).toBe(0);
    expect(nearestIndex(xs, 149)).toBe(1);
    expect(nearestIndex(xs, 151)).toBe(2);
    expect(nearestIndex(xs, 10_000)).toBe(3);
    expect(nearestIndex(xs, -50)).toBe(0);
  });

  it("rend -1 sur une série vide", () => {
    expect(nearestIndex([], 5)).toBe(-1);
  });
});

describe("normalize et clampRatio", () => {
  it("centre une valeur dans un domaine plat", () => {
    expect(normalize(5, { min: 5, max: 5 })).toBe(0.5);
  });

  it("borne le ratio du pointeur", () => {
    expect(clampRatio(-0.3)).toBe(0);
    expect(clampRatio(1.4)).toBe(1);
    expect(clampRatio(Number.NaN)).toBe(0);
  });
});

describe("edgeAnchor et chipSide", () => {
  it("rabat les étiquettes des bords vers l'intérieur", () => {
    expect(edgeAnchor(0.02)).toBe("start");
    expect(edgeAnchor(0.5)).toBe("center");
    expect(edgeAnchor(0.99)).toBe("end");
    expect(edgeAnchor(0.1, 0.04)).toBe("center");
  });

  it("pose l'étiquette à l'opposé de la courbe", () => {
    expect(chipSide(5)).toBe("bottom");
    expect(chipSide(90)).toBe("top");
    expect(chipSide(null)).toBe("top");
  });
});
