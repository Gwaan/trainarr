import { describe, expect, it } from "vitest";

import { panelValueAt } from "@/lib/chart/series";

import {
  buildActivityChartsModel,
  hasDistanceAxis,
  SERIES_SPECS,
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
  it("empile un panneau par mesure disponible, dans l'ordre de lecture", () => {
    const model = buildActivityChartsModel(points(), "distance");
    expect(model?.panels.map((panel) => panel.spec.key)).toEqual([
      "pace",
      "hr",
      "altitude",
      "cadence",
      "stride",
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
    expect(model?.panels.map((panel) => panel.spec.key)).toEqual(["pace", "altitude"]);
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
    expect(pace?.spec.key).toBe("pace");
    expect(pace?.ticks.map((tick) => tick.label)).toEqual([
      "4:20",
      "4:30",
      "4:40",
      "4:50",
      "5:00",
    ]);
    // Étiquettes du haut vers le bas : l'allure la plus rapide est la première.
    const offsets = pace?.ticks.map((tick) => tick.offsetPct) ?? [];
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
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
    expect(pace?.spec.key).toBe("pace");
    expect(pace?.domain.min).toBe(180);
    expect(pace?.ticks.every((tick) => tick.value > 0)).toBe(true);
  });

  it("laisse l'arrondi habituel tranquille sur une série resserrée", () => {
    // Le plancher ne doit mordre que là où l'arrondi s'effondre vers zéro.
    const pace = buildActivityChartsModel(points(), "time")?.panels[0];
    expect(pace?.domain).toEqual({ min: 260, max: 300 });
  });

  it("décrit chaque panneau pour les lecteurs d'écran", () => {
    const model = buildActivityChartsModel(points(), "distance");
    expect(model?.panels[1].ariaLabel).toBe(
      "Fréquence cardiaque (bpm) : de 120 bpm à 162 bpm, sur 0,6 km.",
    );
    expect(model?.panels[1].rangeLabel).toBe("120 – 162 bpm");
  });

  it("change d'abscisse sans changer les panneaux", () => {
    const byDistance = buildActivityChartsModel(points(), "distance");
    const byTime = buildActivityChartsModel(points(), "time");
    expect(byTime?.panels.map((panel) => panel.spec.key)).toEqual(
      byDistance?.panels.map((panel) => panel.spec.key),
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

describe("panelValueAt", () => {
  it("formate la valeur survolée avec son unité", () => {
    const model = buildActivityChartsModel(points(), "distance");
    const [pace, hr] = model?.panels ?? [];
    expect(panelValueAt(pace, 3)).toBe("4:24/km");
    expect(panelValueAt(hr, 0)).toBe("120 bpm");
  });

  it("affiche un tiret pour un trou — jamais une valeur interpolée", () => {
    const holed = points();
    holed[1] = { ...holed[1], hrBpm: null };
    const model = buildActivityChartsModel(holed, "distance");
    const hr = model?.panels.find((panel) => panel.spec.key === "hr");
    expect(hr && panelValueAt(hr, 1)).toBe("—");
    expect(hr && panelValueAt(hr, null)).toBe("—");
  });
});

describe("SERIES_SPECS", () => {
  it("n'inverse l'axe que pour l'allure", () => {
    expect(
      SERIES_SPECS.filter((spec) => spec.invertY).map((spec) => spec.key),
    ).toEqual(["pace"]);
  });

  it("ne prête un zéro physique ni à l'allure ni à la foulée", () => {
    expect(
      SERIES_SPECS.filter((spec) => !spec.hasZero).map((spec) => spec.key),
    ).toEqual(["pace", "stride"]);
  });
});
