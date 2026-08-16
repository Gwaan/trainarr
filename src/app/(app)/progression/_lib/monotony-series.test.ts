import { describe, expect, it } from "vitest";

import type { MonotonyPoint } from "@/lib/metrics";

import { buildMonotonyChartsModel, monotonyReading } from "./monotony-series";

function point(
  date: string,
  monotony: number | null,
  strain: number | null,
  weeklyLoad = 0,
): MonotonyPoint {
  return { date, monotony, strain, weeklyLoad };
}

/** Quatre jours mesurés : de quoi tracer les deux séries, quoi qu'éprouve le test. */
const MEASURED: MonotonyPoint[] = [
  point("2026-08-10", 1.2, 480, 400),
  point("2026-08-11", 1.4, 630, 450),
  point("2026-08-12", 1.9, 950, 500),
  point("2026-08-13", 2.3, 1_265, 550),
];

describe("buildMonotonyChartsModel", () => {
  it("superpose les deux séries dans un seul panneau, sur deux axes", () => {
    const model = buildMonotonyChartsModel(MEASURED);
    if (model === null) throw new Error("Modèle attendu.");

    expect(model.panels).toHaveLength(1);
    const panel = model.panels[0];

    expect(panel.series.map((series) => series.spec.key)).toEqual(["monotony", "strain"]);
    // La contrainte se compte par centaines, la monotonie autour de 2 : sur un
    // axe commun, la seconde serait une ligne plate collée au zéro.
    expect(panel.hasRightAxis).toBe(true);
    expect(model.hasRightGutter).toBe(true);
  });

  it("gradue chaque axe à l'échelle de sa propre série", () => {
    const model = buildMonotonyChartsModel(MEASURED);
    if (model === null) throw new Error("Modèle attendu.");

    const panel = model.panels[0];
    expect(panel.leftAxis.domain.max).toBeLessThan(10);
    expect(panel.rightAxis?.domain.max).toBeGreaterThan(1_000);
  });

  it("laisse les fenêtres incomplètes en trous, jamais en zéros", () => {
    const model = buildMonotonyChartsModel([
      point("2026-08-08", null, null, 120),
      point("2026-08-09", null, null, 260),
      ...MEASURED,
    ]);
    if (model === null) throw new Error("Modèle attendu.");

    const monotony = model.panels[0].series[0];
    expect(monotony.values.slice(0, 2)).toEqual([null, null]);
    // Un `null` n'entre pas dans le domaine : la borne basse reste celle des
    // valeurs mesurées, pas un zéro fabriqué par la fenêtre incomplète.
    expect(monotony.values.filter((value) => value !== null)).toHaveLength(4);
  });

  it("ne rend rien quand une seule journée est mesurée", () => {
    expect(buildMonotonyChartsModel([MEASURED[0]])).toBeNull();
  });

  it("trace la contrainte seule quand la monotonie manque partout", () => {
    // Cas réel : une période dont toutes les semaines sont trop uniformes pour
    // que le quotient existe — la contrainte suit et disparaît avec elle.
    const model = buildMonotonyChartsModel([
      point("2026-08-10", null, null, 400),
      point("2026-08-11", null, null, 450),
    ]);

    expect(model).toBeNull();
  });
});

describe("monotonyReading", () => {
  it("lit le dernier jour de la période quand il est mesuré", () => {
    expect(monotonyReading(MEASURED)).toEqual({
      date: "2026-08-13",
      monotony: 2.3,
      atPeriodEnd: true,
    });
  });

  it("saute les trous de fin plutôt que de commenter un néant", () => {
    expect(
      monotonyReading([...MEASURED, point("2026-08-14", null, null, 0)]),
    ).toEqual({ date: "2026-08-13", monotony: 2.3, atPeriodEnd: false });
  });

  it("signale que la valeur ne décrit pas la fin de la période", () => {
    // Le scénario courant : dix jours de séances sans ceinture cardio. Aucun
    // TRIMP, donc sept jours de charge nulle, donc un écart-type nul, donc
    // `monotony === null` sur tous les points récents. La dernière valeur
    // mesurée date d'avant — l'afficher comme celle « des sept derniers jours »
    // lui attribuerait une période qu'elle ne décrit pas, ton d'alerte compris.
    const silent = Array.from({ length: 10 }, (_, day) =>
      point(`2026-08-${String(14 + day).padStart(2, "0")}`, null, null, 0),
    );

    expect(monotonyReading([...MEASURED, ...silent])).toEqual({
      date: "2026-08-13",
      monotony: 2.3,
      atPeriodEnd: false,
    });
  });

  it("ne rend rien quand aucun point n'est mesuré", () => {
    expect(monotonyReading([point("2026-08-10", null, null, 120)])).toBeNull();
  });
});
