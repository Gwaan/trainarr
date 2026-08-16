import { describe, expect, it } from "vitest";

import { niceStep } from "./model";
import {
  buildChartsModel,
  buildMultiChartsModel,
  multiPanelValueAt,
  type MultiPanelSpec,
  type PanelAxisSpec,
  type PanelSeriesSpec,
  type SeriesSpec,
  type XAxisSpec,
} from "./series";

type Sample = { x: number; a: number | null; b: number | null };

/** Axe décimal minimal : de quoi vérifier que le descripteur est bien branché. */
const LINEAR_AXIS: XAxisSpec = {
  step: niceStep,
  formatTick: (value) => String(value),
  label: (domain) => `${domain.max - domain.min} u`,
};

const LEFT_AXIS: PanelAxisSpec = {
  side: "left",
  stepKind: "decimal",
  hasZero: true,
  invertY: false,
  targetTicks: 4,
  formatTick: (value) => String(value),
};

const RIGHT_AXIS: PanelAxisSpec = { ...LEFT_AXIS, side: "right" };

const A_SERIES: PanelSeriesSpec<Sample> = {
  key: "a",
  label: "Série A",
  axis: "left",
  strokeClass: "stroke-accent",
  dotClass: "bg-accent",
  legendClass: "bg-accent",
  fill: null,
  format: (value) => `${value} u`,
  read: (point) => point.a,
};

const B_SERIES: PanelSeriesSpec<Sample> = {
  ...A_SERIES,
  key: "b",
  label: "Série B",
  strokeClass: "stroke-negative",
  dotClass: "bg-negative",
  legendClass: "bg-negative",
  read: (point) => point.b,
};

function samples(): Sample[] {
  return [
    { x: 0, a: 10, b: 5 },
    { x: 1, a: 20, b: 6 },
    { x: 2, a: 30, b: 7 },
    { x: 3, a: 40, b: 8 },
  ];
}

function panel(overrides: Partial<MultiPanelSpec<Sample>> = {}): MultiPanelSpec<Sample> {
  return {
    key: "panel",
    title: "Panneau",
    heightClass: "h-36",
    axes: { left: LEFT_AXIS },
    series: [A_SERIES, B_SERIES],
    ...overrides,
  };
}

function build(points: readonly Sample[], panels: readonly MultiPanelSpec<Sample>[] = [panel()]) {
  return buildMultiChartsModel({
    points,
    xs: points.map((point) => point.x),
    axis: LINEAR_AXIS,
    panels,
  });
}

describe("buildMultiChartsModel — un axe", () => {
  it("agrège l'étendue de toutes les séries d'un même axe", () => {
    // A va de 10 à 40, B de 5 à 8 : l'axe partagé doit contenir les deux, sinon
    // la superposition ferait mentir l'écart entre les courbes.
    const model = build(samples());
    expect(model?.panels[0].leftAxis.domain).toEqual({ min: 0, max: 40 });
  });

  it("projette chaque série sur le domaine agrégé, pas sur le sien", () => {
    const model = build(samples());
    const b = model?.panels[0].series[1];
    // 5 dans 0..40, axe non inversé : sept huitièmes du panneau vers le bas.
    expect(b?.projected[0]).toEqual({ x: 0, y: 87.5 });
  });

  it("rend les séries dans l'ordre du descripteur", () => {
    const model = build(samples());
    expect(model?.panels[0].series.map((series) => series.spec.key)).toEqual(["a", "b"]);
  });

  it("ne réserve pas de gouttière droite sans axe droit", () => {
    const model = build(samples());
    expect(model?.hasRightGutter).toBe(false);
    expect(model?.panels[0].hasRightAxis).toBe(false);
    expect(model?.panels[0].rightAxis).toBeNull();
  });

  it("décrit chaque série survivante, sous le titre du panneau", () => {
    expect(build(samples())?.panels[0].ariaLabel).toBe(
      "Panneau — Série A : de 10 u à 40 u, sur 3 u. Série B : de 5 u à 8 u, sur 3 u.",
    );
  });

  it("prend l'étendue de la première série survivante comme repère", () => {
    const points = samples().map((point, index) => ({
      ...point,
      a: index === 0 ? point.a : null,
    }));
    // A n'a plus qu'une mesure : c'est B qui devient la première survivante.
    expect(build(points)?.panels[0].rangeLabel).toBe("5 – 8 u");
  });
});

describe("buildMultiChartsModel — deux axes", () => {
  const TWO_AXES = panel({
    axes: { left: LEFT_AXIS, right: RIGHT_AXIS },
    series: [A_SERIES, { ...B_SERIES, axis: "right" }],
  });

  it("gradue chaque axe sur les seules séries qui s'y rattachent", () => {
    const model = build(samples(), [TWO_AXES]);
    expect(model?.panels[0].leftAxis.domain).toEqual({ min: 10, max: 40 });
    expect(model?.panels[0].rightAxis?.domain).toEqual({ min: 5, max: 8 });
  });

  it("projette chaque série sur le domaine de son axe", () => {
    const model = build(samples(), [TWO_AXES]);
    // B occupe tout son axe droit (5..8) : son premier point touche le bas.
    expect(model?.panels[0].series[1].projected[0]).toEqual({ x: 0, y: 100 });
  });

  it("réserve la gouttière droite dès qu'un panneau porte un axe droit", () => {
    const model = build(samples(), [panel(), TWO_AXES]);
    expect(model?.hasRightGutter).toBe(true);
    expect(model?.panels.map((entry) => entry.hasRightAxis)).toEqual([false, true]);
  });

  it("gradue l'axe droit avec son propre formateur", () => {
    const model = build(samples(), [
      panel({
        axes: { left: LEFT_AXIS, right: { ...RIGHT_AXIS, formatTick: (value) => `${value}%` } },
        series: [A_SERIES, { ...B_SERIES, axis: "right" }],
      }),
    ]);
    expect(model?.panels[0].rightAxis?.ticks.map((tick) => tick.label)).toEqual([
      "5%",
      "6%",
      "7%",
      "8%",
    ]);
  });

  it("n'impose le zéro d'une série divergente qu'à son propre axe", () => {
    const points = [-30, -22, -18, -12].map((b, index) => ({ x: index, a: 10 * (index + 1), b }));
    const model = build(points, [
      panel({
        axes: { left: LEFT_AXIS, right: RIGHT_AXIS },
        series: [
          A_SERIES,
          {
            ...B_SERIES,
            axis: "right",
            diverging: {
              positiveClass: "fill-positive",
              negativeClass: "fill-negative",
              opacity: 0.15,
            },
          },
        ],
      }),
    ]);

    // L'axe droit remonte jusqu'à zéro — sans sa ligne, le signe du TSB ne se
    // lirait plus. L'axe gauche, lui, reste calé sur ses propres mesures.
    expect(model?.panels[0].rightAxis?.domain.max).toBe(0);
    expect(model?.panels[0].series[1].diverging?.zeroOffsetPct).toBe(0);
    expect(model?.panels[0].leftAxis.domain).toEqual({ min: 10, max: 40 });
  });

  it("bascule l'axe droit à gauche quand plus aucune série gauche ne survit", () => {
    // La grille s'ancre sur l'axe gauche : sans survivante à gauche, le panneau
    // n'aurait plus de repère du tout.
    const points = samples().map((point, index) => ({
      ...point,
      a: index === 0 ? point.a : null,
    }));
    const model = build(points, [
      panel({
        axes: { left: LEFT_AXIS, right: { ...RIGHT_AXIS, formatTick: (value) => `${value}%` } },
        series: [A_SERIES, { ...B_SERIES, axis: "right" }],
      }),
    ]);

    expect(model?.panels[0].leftAxis.domain).toEqual({ min: 5, max: 8 });
    expect(model?.panels[0].leftAxis.ticks[0].label).toBe("5%");
    expect(model?.panels[0].hasRightAxis).toBe(false);
    expect(model?.hasRightGutter).toBe(false);
  });
});

describe("buildMultiChartsModel — ce qui n'est pas traçable", () => {
  it("écarte la série sans deux mesures, et garde le panneau", () => {
    const points = samples().map((point, index) => ({
      ...point,
      b: index === 0 ? point.b : null,
    }));
    const model = build(points);
    expect(model?.panels[0].series.map((series) => series.spec.key)).toEqual(["a"]);
    // Une seule série survivante : le libellé accessible ne répète pas le titre.
    expect(model?.panels[0].ariaLabel).toBe("Série A : de 10 u à 40 u, sur 3 u.");
  });

  it("écarte le panneau dont plus aucune série ne survit", () => {
    const points = samples().map((point) => ({ ...point, a: null, b: null }));
    const model = build(points, [panel(), panel({ key: "autre", series: [A_SERIES] })]);
    expect(model).toBeNull();

    const partial = samples().map((point) => ({ ...point, a: null }));
    const kept = build(partial, [
      panel({ key: "vide", series: [A_SERIES] }),
      panel({ key: "plein", series: [B_SERIES] }),
    ]);
    expect(kept?.panels.map((entry) => entry.key)).toEqual(["plein"]);
  });

  it("rend null quand rien n'est traçable", () => {
    expect(build([])).toBeNull();
    expect(build(samples().slice(0, 1))).toBeNull();
    // Abscisse figée : aucune projection possible.
    expect(build(samples().map((point) => ({ ...point, x: 0 })))).toBeNull();
  });
});

describe("buildMultiChartsModel — titre d'un panneau amputé", () => {
  /** Un troisième descripteur, qui lit la même mesure que A : il survit avec elle. */
  const C_SERIES: PanelSeriesSpec<Sample> = { ...A_SERIES, key: "c", label: "Série C" };

  const NAMED = panel({ titleFor: (labels) => labels.join(" et ") });

  /** B n'a plus qu'une mesure : elle ne fait plus une ligne, donc plus une série. */
  function withoutB(): Sample[] {
    return samples().map((point, index) => ({ ...point, b: index === 0 ? point.b : null }));
  }

  it("garde le titre déclaré tant que toutes les séries survivent", () => {
    expect(build(samples(), [NAMED])?.panels[0].title).toBe("Panneau");
  });

  it("renomme le panneau sur les seules séries survivantes", () => {
    expect(build(withoutB(), [NAMED])?.panels[0].title).toBe("Série A");
  });

  it("passe les survivantes dans l'ordre du descripteur, titre accessible compris", () => {
    const target = build(withoutB(), [
      panel({ series: [A_SERIES, B_SERIES, C_SERIES], titleFor: (labels) => labels.join(" et ") }),
    ])?.panels[0];

    expect(target?.title).toBe("Série A et Série C");
    expect(target?.ariaLabel).toBe(
      "Série A et Série C — Série A : de 10 u à 40 u, sur 3 u. Série C : de 10 u à 40 u, sur 3 u.",
    );
  });

  it("garde le titre déclaré quand la page n'en propose pas d'autre", () => {
    // Un titre qui ne nomme aucune série (une unité, par exemple) ne ment pas
    // quand l'une d'elles tombe : le descripteur n'a alors rien à fournir.
    expect(build(withoutB())?.panels[0].title).toBe("Panneau");
  });
});

describe("multiPanelValueAt", () => {
  it("formate la valeur de la série demandée", () => {
    const target = build(samples())?.panels[0];
    expect(target && multiPanelValueAt(target, "b", 2)).toBe("7 u");
  });

  it("affiche un tiret pour un trou — jamais une valeur interpolée", () => {
    const points = samples();
    points[1] = { ...points[1], b: null };
    const target = build(points)?.panels[0];

    expect(target && multiPanelValueAt(target, "b", 1)).toBe("—");
    expect(target && multiPanelValueAt(target, "b", null)).toBe("—");
    expect(target && multiPanelValueAt(target, "b", 99)).toBe("—");
  });

  it("affiche un tiret pour une série écartée, sans que l'appelant ait à le savoir", () => {
    const points = samples().map((point, index) => ({
      ...point,
      b: index === 0 ? point.b : null,
    }));
    const target = build(points)?.panels[0];
    expect(target && multiPanelValueAt(target, "b", 0)).toBe("—");
  });
});

describe("buildChartsModel — non-régression du modèle mono-série", () => {
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

  /**
   * Cas de référence, valeurs relevées **avant** la bascule sur le modèle
   * multi-séries : le wrapper doit rendre exactement la même géométrie.
   */
  it("rend la même géométrie qu'avant sur un cas de référence", () => {
    const points = samples();
    const model = buildChartsModel({
      points,
      xs: points.map((point) => point.x),
      axis: LINEAR_AXIS,
      specs: [A_SPEC],
    });
    const target = model?.panels[0];

    expect(target?.spec).toBe(A_SPEC);
    expect(target?.domain).toEqual({ min: 10, max: 40 });
    expect(target?.ticks.map((tick) => [tick.value, tick.offsetPct, tick.label])).toEqual([
      [10, 100, "10"],
      [20, 200 / 3, "20"],
      [30, 100 / 3, "30"],
      [40, 0, "40"],
    ]);
    expect(target?.line).toBe("M 0.00 100.00 L 333.33 66.67 L 666.67 33.33 L 1000.00 0.00");
    expect(target?.area).toBeNull();
    expect(target?.diverging).toBeNull();
    expect(target?.values).toEqual([10, 20, 30, 40]);
    expect(target?.rangeLabel).toBe("10 – 40 u");
    expect(target?.ariaLabel).toBe("Série A : de 10 u à 40 u, sur 3 u.");
    expect(model?.xDomain).toEqual({ min: 0, max: 3 });
  });

  it("garde le zéro et les aires d'une série divergente", () => {
    const spec: SeriesSpec<Sample> = {
      ...A_SPEC,
      diverging: { positiveClass: "fill-positive", negativeClass: "fill-negative", opacity: 0.15 },
    };
    const points = [-20, -10, 10, 20].map((a, index) => ({ x: index, a, b: null }));
    const target = buildChartsModel({
      points,
      xs: points.map((point) => point.x),
      axis: LINEAR_AXIS,
      specs: [spec],
    })?.panels[0];

    expect(target?.diverging?.zeroOffsetPct).toBe(50);
    expect(target?.diverging?.above).not.toBe("");
    expect(target?.diverging?.below).not.toBe("");
  });
});
