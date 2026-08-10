import { describe, expect, it } from "vitest";

import { buildVo2maxChartModel, type Vo2maxPoint } from "./vo2max-model";

const POINTS: Vo2maxPoint[] = [
  { date: "2026-05-12", value: 48 },
  { date: "2026-06-20", value: 52 },
  { date: "2026-08-10", value: 50 },
];

const TREND: Vo2maxPoint[] = [
  { date: "2026-05-12", value: 48 },
  { date: "2026-06-20", value: 50 },
  { date: "2026-08-10", value: 51 },
];

describe("buildVo2maxChartModel", () => {
  it("pose une pastille par course, en pourcentage du panneau", () => {
    const model = buildVo2maxChartModel(POINTS, TREND);

    expect(model?.dots).toHaveLength(3);
    expect(model?.dots[0].leftPct).toBe(0);
    expect(model?.dots.at(-1)?.leftPct).toBe(100);
    for (const dot of model?.dots ?? []) {
      expect(dot.topPct).toBeGreaterThanOrEqual(0);
      expect(dot.topPct).toBeLessThanOrEqual(100);
    }
  });

  it("cadre l'axe Y sur le nuage **et** la tendance", () => {
    const model = buildVo2maxChartModel(POINTS, [
      { date: "2026-05-12", value: 30 },
      { date: "2026-08-10", value: 31 },
    ]);

    // La tendance descend à 30 : la graduation la plus basse doit l'englober,
    // et la plus haute couvrir le nuage, qui monte à 52.
    expect(model?.yTicks[0].value).toBeLessThanOrEqual(30);
    expect(model?.yTicks.at(-1)?.value).toBeGreaterThanOrEqual(52);
  });

  it("trace la tendance en un seul tronçon continu", () => {
    const path = buildVo2maxChartModel(POINTS, TREND)?.trendPath ?? "";
    expect(path.match(/M/g)).toHaveLength(1);
  });

  it("donne au curseur la date, la valeur de la course et la tendance du jour", () => {
    const model = buildVo2maxChartModel(POINTS, TREND);
    expect(model?.readouts[1]).toBe("20 juin 2026 · 52,0 · tendance 50,0");
  });

  it("omet la tendance quand elle ne couvre pas le jour de la course", () => {
    const model = buildVo2maxChartModel(POINTS, []);
    expect(model?.readouts[0]).toBe("12 mai 2026 · 48,0");
  });

  it("rend null quand il n'y a rien à tracer", () => {
    expect(buildVo2maxChartModel([], [])).toBeNull();
    expect(buildVo2maxChartModel(POINTS.slice(0, 1), TREND)).toBeNull();
    // Toutes les courses le même jour : l'axe des dates serait plat.
    expect(
      buildVo2maxChartModel(
        [
          { date: "2026-08-10", value: 48 },
          { date: "2026-08-10", value: 52 },
        ],
        [],
      ),
    ).toBeNull();
  });
});
