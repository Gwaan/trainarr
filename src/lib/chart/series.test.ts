import { describe, expect, it } from "vitest";

import { niceStep } from "./model";
import {
  buildChartsModel,
  panelValueAt,
  type SeriesSpec,
  type XAxisSpec,
} from "./series";

type Sample = { x: number; a: number | null; b: number | null };

const A_SPEC: SeriesSpec<Sample> = {
  key: "a",
  title: "Série A",
  strokeClass: "stroke-accent",
  dotClass: "bg-accent",
  fill: null,
  invertY: false,
  stepKind: "decimal",
  hasZero: true,
  targetTicks: 4,
  heightClass: "h-36",
  format: (value) => `${value} u`,
  formatTick: (value) => String(value),
  read: (point) => point.a,
};

const B_SPEC: SeriesSpec<Sample> = {
  ...A_SPEC,
  key: "b",
  title: "Série B",
  read: (point) => point.b,
};

/** Axe décimal minimal : de quoi vérifier que le descripteur est bien branché. */
const LINEAR_AXIS: XAxisSpec = {
  step: niceStep,
  formatTick: (value) => String(value),
  label: (domain) => `${domain.max - domain.min} u`,
};

function samples(): Sample[] {
  return [
    { x: 0, a: 10, b: 5 },
    { x: 1, a: 20, b: 6 },
    { x: 2, a: 30, b: 7 },
    { x: 3, a: 40, b: 8 },
  ];
}

function build(points: readonly Sample[], specs = [A_SPEC, B_SPEC]) {
  return buildChartsModel({
    points,
    xs: points.map((point) => point.x),
    axis: LINEAR_AXIS,
    specs,
  });
}

describe("buildChartsModel", () => {
  it("empile un panneau par série, dans l'ordre des specs", () => {
    expect(build(samples())?.panels.map((panel) => panel.spec.key)).toEqual(["a", "b"]);
  });

  it("écarte les panneaux sans deux mesures plutôt que d'afficher un cadre vide", () => {
    const points = samples().map((point, index) => ({
      ...point,
      b: index === 0 ? point.b : null,
    }));
    expect(build(points)?.panels.map((panel) => panel.spec.key)).toEqual(["a"]);
  });

  it("rend null quand rien n'est traçable", () => {
    expect(build([])).toBeNull();
    expect(build(samples().slice(0, 1))).toBeNull();
    // Abscisse figée : aucune projection possible.
    const frozen = samples().map((point) => ({ ...point, x: 0 }));
    expect(build(frozen)).toBeNull();
    // Aucune série mesurée : pas de panneau, donc pas de modèle.
    const empty = samples().map((point) => ({ ...point, a: null, b: null }));
    expect(build(empty)).toBeNull();
  });

  it("colle l'abscisse aux bornes réelles, sans arrondir le domaine", () => {
    const model = build(samples());
    expect(model?.xDomain).toEqual({ min: 0, max: 3 });
    expect(model?.xTicks.at(0)?.offsetPct).toBe(0);
    expect(model?.xTicks.every((tick) => tick.offsetPct <= 100)).toBe(true);
  });

  it("vise six intervalles sur l'abscisse, pas cinq", () => {
    // Étendue de 12,7 : avec cinq intervalles le pas vaudrait 5 et l'axe
    // n'aurait plus que trois graduations ; avec six il tombe à 2,5.
    const points = [0, 4.2, 8.4, 12.7].map((x) => ({ x, a: x, b: null }));
    const model = build(points);
    expect(model?.xTicks.map((tick) => tick.value)).toEqual([0, 2.5, 5, 7.5, 10, 12.5]);
  });

  it("gradue l'abscisse avec le descripteur d'axe fourni", () => {
    const axis: XAxisSpec = {
      step: () => 1,
      formatTick: (value, step) => `${value}/${step}`,
      label: () => "toute la série",
    };
    const points = samples();
    const model = buildChartsModel({
      points,
      xs: points.map((point) => point.x),
      axis,
      specs: [A_SPEC],
    });
    expect(model?.xTicks.map((tick) => tick.label)).toEqual(["0/1", "1/1", "2/1", "3/1"]);
    expect(model?.panels[0].ariaLabel).toBe("Série A : de 10 u à 40 u, sur toute la série.");
  });

  it("décrit l'étendue mesurée de chaque panneau", () => {
    expect(build(samples())?.panels[0].rangeLabel).toBe("10 – 40 u");
  });

  it("planche un axe sans zéro physique sous sa valeur la plus basse", () => {
    // Allures d'un trail : de 27:47/km (1 667 s) à 3:20/km (200 s). Le pas vaut
    // 10 min, et l'arrondi habituel poserait la borne basse à 0 — une vitesse
    // infinie, et un sixième de panneau vide.
    const spec: SeriesSpec<Sample> = {
      ...A_SPEC,
      stepKind: "time",
      hasZero: false,
      invertY: true,
    };
    const points = [1667, 900, 420, 200].map((a, index) => ({ x: index, a, b: null }));
    const panel = build(points, [spec])?.panels[0];
    expect(panel?.domain.min).toBe(180);
    expect(panel?.ticks.every((tick) => tick.value > 0)).toBe(true);
  });

  it("laisse l'arrondi habituel tranquille sur une série resserrée", () => {
    const spec: SeriesSpec<Sample> = { ...A_SPEC, hasZero: false };
    expect(build(samples(), [spec])?.panels[0].domain).toEqual({ min: 10, max: 40 });
  });

  it("n'attache d'aires divergentes qu'aux séries qui le demandent", () => {
    expect(build(samples())?.panels[0].diverging).toBeNull();
  });
});

describe("buildChartsModel — série divergente", () => {
  const DIVERGING_SPEC: SeriesSpec<Sample> = {
    ...A_SPEC,
    diverging: { positiveClass: "fill-positive", negativeClass: "fill-negative", opacity: 0.15 },
  };

  function buildDiverging(values: readonly number[]) {
    const points = values.map((a, index) => ({ x: index, a, b: null }));
    return build(points, [DIVERGING_SPEC])?.panels[0];
  }

  it("garde la ligne de zéro dans le panneau même si tout est du même signe", () => {
    const panel = buildDiverging([-30, -22, -18, -12]);

    expect(panel?.domain.max).toBe(0);
    expect(panel?.diverging?.zeroOffsetPct).toBe(0);
  });

  it("sépare l'aire positive de l'aire négative", () => {
    const panel = buildDiverging([-20, -10, 10, 20]);

    expect(panel?.diverging?.above).not.toBe("");
    expect(panel?.diverging?.below).not.toBe("");
    // Domaine symétrique −20…20 : la ligne de zéro tombe à mi-hauteur.
    expect(panel?.diverging?.zeroOffsetPct).toBe(50);
  });
});

describe("panelValueAt", () => {
  it("formate la valeur survolée avec son unité", () => {
    const panel = build(samples())?.panels[0];
    expect(panel && panelValueAt(panel, 3)).toBe("40 u");
  });

  it("affiche un tiret pour un trou — jamais une valeur interpolée", () => {
    const points = samples();
    points[1] = { ...points[1], a: null };
    const panel = build(points)?.panels[0];
    expect(panel && panelValueAt(panel, 1)).toBe("—");
    expect(panel && panelValueAt(panel, null)).toBe("—");
    expect(panel && panelValueAt(panel, 99)).toBe("—");
  });
});
