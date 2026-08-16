import { describe, expect, it } from "vitest";

import { multiPanelValueAt } from "@/lib/chart/series";

import {
  buildActivityChartsModel,
  hasDistanceAxis,
  PANEL_SPECS,
  type ChartPoint,
} from "./chart-series";

/** Trois minutes de course, une mesure toutes les 60 s. */
function points(): ChartPoint[] {
  return [
    { timeS: 0, distanceM: 0, paceSecPerKm: 300, hrBpm: 120, altitudeM: 100, cadenceSpm: 170, strideM: 1.18 },
    { timeS: 60, distanceM: 200, paceSecPerKm: 288, hrBpm: 140, altitudeM: 110, cadenceSpm: 172, strideM: 1.21 },
    { timeS: 120, distanceM: 420, paceSecPerKm: 270, hrBpm: 155, altitudeM: 105, cadenceSpm: 176, strideM: 1.26 },
    { timeS: 180, distanceM: 640, paceSecPerKm: 264, hrBpm: 162, altitudeM: 95, cadenceSpm: 178, strideM: 1.28 },
  ];
}

describe("hasDistanceAxis", () => {
  it("refuse l'abscisse distance quand la séance n'en porte pas", () => {
    expect(hasDistanceAxis(points())).toBe(true);
    expect(
      hasDistanceAxis(points().map((point) => ({ ...point, distanceM: 0 }))),
    ).toBe(false);
    expect(hasDistanceAxis([])).toBe(false);
  });
});

describe("buildActivityChartsModel", () => {
  it("empile trois panneaux, dans l'ordre de lecture", () => {
    const model = buildActivityChartsModel(points(), "distance");
    expect(model?.panels.map((panel) => panel.key)).toEqual([
      "pace-hr",
      "altitude",
      "cadence-stride",
    ]);
    expect(model?.panels.map((panel) => panel.series.map((series) => series.spec.key))).toEqual([
      ["pace", "hr"],
      ["altitude"],
      ["cadence", "stride"],
    ]);
  });

  it("écarte les panneaux sans données plutôt que d'afficher un cadre vide", () => {
    const withoutHr = points().map((point) => ({
      ...point,
      hrBpm: null,
      cadenceSpm: null,
      strideM: null,
    }));
    const model = buildActivityChartsModel(withoutHr, "distance");
    expect(model?.panels.map((panel) => panel.key)).toEqual(["pace-hr", "altitude"]);
    // L'allure reste seule dans son panneau, sur son axe et sa graduation.
    expect(model?.panels[0].series.map((series) => series.spec.key)).toEqual(["pace"]);
    expect(model?.panels[0].hasRightAxis).toBe(false);
    expect(model?.hasRightGutter).toBe(false);
    // Et le titre ne nomme plus la FC : sans ceinture, il annoncerait une
    // courbe qu'aucun capteur n'a tracée.
    expect(model?.panels[0].title).toBe("Allure");
  });

  it("ne laisse pas un titre annoncer une série absente", () => {
    // Cas courant : montre sans capteur de foulée. Le panneau survit par la
    // cadence, son titre le dit.
    const withoutStride = points().map((point) => ({ ...point, strideM: null }));
    const model = buildActivityChartsModel(withoutStride, "distance");
    expect(model?.panels[2].title).toBe("Cadence");
    // Les deux mesures présentes : le titre complet, lui, ne ment pas.
    expect(buildActivityChartsModel(points(), "distance")?.panels[2].title).toBe(
      "Cadence et foulée",
    );
  });

  it("rend null quand rien n'est traçable", () => {
    expect(buildActivityChartsModel([], "time")).toBeNull();
    expect(buildActivityChartsModel(points().slice(0, 1), "time")).toBeNull();
    // Une abscisse figée (tapis sans distance) n'autorise aucune projection.
    const frozen = points().map((point) => ({ ...point, distanceM: 0 }));
    expect(buildActivityChartsModel(frozen, "distance")).toBeNull();
    // Une distance partielle ne fait pas un axe.
    const partial = points().map((point, index) => ({
      ...point,
      distanceM: index === 2 ? null : point.distanceM,
    }));
    expect(buildActivityChartsModel(partial, "distance")).toBeNull();
  });

  it("colle l'abscisse aux bornes réelles de la séance", () => {
    const model = buildActivityChartsModel(points(), "distance");
    expect(model?.xDomain).toEqual({ min: 0, max: 640 });
    expect(model?.xTicks.at(0)?.offsetPct).toBe(0);
    expect(model?.xTicks.every((tick) => tick.offsetPct <= 100)).toBe(true);
  });

  it("gradue l'axe des allures en sexagésimal, du plus rapide en haut", () => {
    const model = buildActivityChartsModel(points(), "time");
    const pace = model?.panels[0];
    expect(pace?.key).toBe("pace-hr");
    expect(pace?.leftAxis.ticks.map((tick) => tick.label)).toEqual([
      "4:20",
      "4:30",
      "4:40",
      "4:50",
      "5:00",
    ]);
    // Étiquettes du haut vers le bas : l'allure la plus rapide est la première.
    const offsets = pace?.leftAxis.ticks.map((tick) => tick.offsetPct) ?? [];
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("gradue la FC sur sa propre gouttière droite, en bpm sans unité", () => {
    const model = buildActivityChartsModel(points(), "distance");
    const pace = model?.panels[0];
    expect(model?.hasRightGutter).toBe(true);
    expect(pace?.hasRightAxis).toBe(true);
    expect(pace?.rightAxis?.ticks.map((tick) => tick.label)).toEqual([
      "120",
      "140",
      "160",
      "180",
    ]);
    // Chaque série se projette sur son axe : la FC touche le bas de son domaine
    // au premier point (120 bpm), là où l'allure y est à 5:00/km.
    expect(pace?.series[1].projected[0]?.y).toBe(100);
  });

  it("ne gradue jamais l'axe d'allure jusqu'à 0:00/km", () => {
    // Trail : on marche à 27:47/km (1 667 s) et on lâche à 3:20/km (200 s).
    // Le pas retenu vaut 10 min ; arrondir la borne basse au multiple inférieur
    // la posait à 0 — une vitesse infinie, et un sixième de panneau vide.
    const trail: ChartPoint[] = [1667, 900, 420, 200].map((paceSecPerKm, index) => ({
      timeS: index * 300,
      distanceM: index * 300,
      paceSecPerKm,
      hrBpm: null,
      altitudeM: null,
      cadenceSpm: null,
      strideM: null,
    }));

    const pace = buildActivityChartsModel(trail, "time")?.panels[0];
    expect(pace?.key).toBe("pace-hr");
    expect(pace?.leftAxis.domain.min).toBe(180);
    expect(pace?.leftAxis.ticks.every((tick) => tick.value > 0)).toBe(true);
  });

  it("laisse l'arrondi habituel tranquille sur une série resserrée", () => {
    // Le plancher ne doit mordre que là où l'arrondi s'effondre vers zéro.
    const pace = buildActivityChartsModel(points(), "time")?.panels[0];
    expect(pace?.leftAxis.domain).toEqual({ min: 260, max: 300 });
  });

  it("gradue cadence et foulée chacune sur son axe", () => {
    const mechanics = buildActivityChartsModel(points(), "distance")?.panels[2];
    expect(mechanics?.leftAxis.ticks.map((tick) => tick.label)).toEqual(["170", "175", "180"]);
    expect(mechanics?.rightAxis?.ticks.map((tick) => tick.label)).toEqual([
      "1,15",
      "1,20",
      "1,25",
      "1,30",
    ]);
  });

  it("décrit chaque panneau pour les lecteurs d'écran, série par série", () => {
    const model = buildActivityChartsModel(points(), "distance");
    expect(model?.panels[0].ariaLabel).toBe(
      "Allure et fréquence cardiaque — Allure : de 4:24/km à 5:00/km, sur 0,6 km." +
        " FC : de 120 bpm à 162 bpm, sur 0,6 km.",
    );
    // Panneau à série unique : son étendue reste affichée, le titre suffit.
    expect(model?.panels[1].ariaLabel).toBe("Altitude : de 95 m à 110 m, sur 0,6 km.");
    expect(model?.panels[1].rangeLabel).toBe("95 – 110 m");
  });

  it("change d'abscisse sans changer les panneaux", () => {
    const byDistance = buildActivityChartsModel(points(), "distance");
    const byTime = buildActivityChartsModel(points(), "time");
    expect(byTime?.panels.map((panel) => panel.key)).toEqual(
      byDistance?.panels.map((panel) => panel.key),
    );
    expect(byTime?.xTicks.map((tick) => tick.label)).toEqual([
      "0:00",
      "0:30",
      "1:00",
      "1:30",
      "2:00",
      "2:30",
      "3:00",
    ]);
  });
});

describe("multiPanelValueAt", () => {
  it("formate la valeur survolée avec son unité, série par série", () => {
    const model = buildActivityChartsModel(points(), "distance");
    const [paceHr, , mechanics] = model?.panels ?? [];
    expect(paceHr && multiPanelValueAt(paceHr, "pace", 3)).toBe("4:24/km");
    expect(paceHr && multiPanelValueAt(paceHr, "hr", 0)).toBe("120 bpm");
    expect(mechanics && multiPanelValueAt(mechanics, "cadence", 0)).toBe("170 spm");
    expect(mechanics && multiPanelValueAt(mechanics, "stride", 0)).toBe("1,18 m");
  });

  it("affiche un tiret pour un trou — jamais une valeur interpolée", () => {
    const holed = points();
    holed[1] = { ...holed[1], hrBpm: null };
    const model = buildActivityChartsModel(holed, "distance");
    const paceHr = model?.panels.find((panel) => panel.key === "pace-hr");
    expect(paceHr && multiPanelValueAt(paceHr, "hr", 1)).toBe("—");
    expect(paceHr && multiPanelValueAt(paceHr, "hr", null)).toBe("—");
    // L'allure, elle, est mesurée au même point : le trou est par série.
    expect(paceHr && multiPanelValueAt(paceHr, "pace", 1)).toBe("4:48/km");
  });
});

describe("PANEL_SPECS", () => {
  const axes = PANEL_SPECS.flatMap((panel) =>
    [panel.axes.left, panel.axes.right].filter((axis) => axis !== undefined),
  );

  it("n'inverse que l'axe des allures", () => {
    expect(axes.filter((axis) => axis.invertY)).toHaveLength(1);
    expect(PANEL_SPECS[0].axes.left.invertY).toBe(true);
  });

  it("ne prête un zéro physique ni à l'allure ni à la foulée", () => {
    expect(axes.filter((axis) => !axis.hasZero)).toHaveLength(2);
    expect(PANEL_SPECS[0].axes.left.hasZero).toBe(false);
    expect(PANEL_SPECS[2].axes.right?.hasZero).toBe(false);
  });

  it("rattache chaque série à un axe déclaré par son panneau", () => {
    for (const panel of PANEL_SPECS) {
      for (const series of panel.series) {
        if (series.axis === "right") expect(panel.axes.right).toBeDefined();
      }
    }
  });
});
