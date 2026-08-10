import { describe, expect, it } from "vitest";

import type { DistributionBin } from "@/lib/metrics";

import {
  LABEL_HEADROOM_PCT,
  distributionScale,
  hrDistributionModel,
  paceDistributionModel,
  tickIndexes,
} from "./distribution-model";

/** Colonnes et graduations partagent la bande réservée à l'étiquette directe. */
const SCALE = (100 - LABEL_HEADROOM_PCT) / 100;

/** Tranches d'allure de 15 s/km à partir de 4:30/km. */
function paceBins(seconds: readonly number[], from = 270): DistributionBin[] {
  return seconds.map((value, index) => ({
    from: from + index * 15,
    to: from + (index + 1) * 15,
    seconds: value,
  }));
}

describe("distributionScale", () => {
  it("choisit un pas rond en minutes, pas en secondes", () => {
    // 650 s de pointe : un pas décimal en secondes donnerait 250 s (« 4,2 min »).
    expect(distributionScale(650)).toEqual({ topSeconds: 900, ticks: [300, 600, 900] });
    expect(distributionScale(1_500)).toEqual({ topSeconds: 1_800, ticks: [600, 1_200, 1_800] });
  });

  it("ne rend aucune échelle sans temps à représenter", () => {
    expect(distributionScale(0)).toEqual({ topSeconds: 0, ticks: [] });
    expect(distributionScale(Number.NaN)).toEqual({ topSeconds: 0, ticks: [] });
  });
});

describe("tickIndexes", () => {
  it("étiquette toutes les colonnes tant qu'elles tiennent", () => {
    expect(tickIndexes(1)).toEqual([0]);
    expect(tickIndexes(4)).toEqual([0, 1, 2, 3]);
  });

  it("espace les graduations et garde toujours la dernière", () => {
    expect(tickIndexes(12)).toEqual([0, 2, 4, 6, 8, 10, 11]);
    expect(tickIndexes(24)).toEqual([0, 4, 8, 12, 16, 20, 23]);
  });

  it("retire la graduation régulière trop proche de la dernière", () => {
    // 13 colonnes, une sur 3 : 0, 3, 6, 9, 12 — 12 *est* la dernière.
    expect(tickIndexes(13)).toEqual([0, 3, 6, 9, 12]);
    // 14 colonnes, une sur 3 : 12 et 13 se chevaucheraient, 12 saute.
    expect(tickIndexes(14)).toEqual([0, 3, 6, 9, 13]);
  });
});

describe("paceDistributionModel", () => {
  it("met les colonnes à l'échelle du sommet, pas du total", () => {
    const model = paceDistributionModel(paceBins([120, 650, 0, 300]));

    expect(model.totalSeconds).toBe(1_070);
    // Sommet 650 s, pas de 5 min → échelle arrondie à 900 s.
    expect(model.gridLines.map((line) => line.label)).toEqual(["5 min", "10 min", "15 min"]);
    expect(model.bars.map((bar) => bar.heightPct)).toEqual([
      (120 / 900) * 100 * SCALE,
      (650 / 900) * 100 * SCALE,
      0,
      (300 / 900) * 100 * SCALE,
    ]);
    expect(model.bars[1].sharePct).toBeCloseTo(60.75, 2);
  });

  it("laisse la place de l'étiquette directe au-dessus de la colonne la plus longue", () => {
    // Sommet exactement sur une graduation : sans réserve, la colonne toucherait
    // le haut du cadre et son étiquette serait rognée par le conteneur défilant.
    const model = paceDistributionModel(paceBins([600]));

    expect(model.bars[0].heightPct).toBe(100 * SCALE);
    expect(model.bars[0].heightPct).toBeLessThan(100);
    // La graduation du sommet suit la même échelle : la grille reste juste.
    expect(model.gridLines.at(-1)).toEqual({
      seconds: 600,
      label: "10 min",
      bottomPct: 100 * SCALE,
    });
  });

  it("n'étiquette directement que la tranche la plus longue", () => {
    const model = paceDistributionModel(paceBins([120, 650, 0, 300]));
    expect(model.bars.map((bar) => bar.isPeak)).toEqual([false, true, false, false]);
  });

  it("nomme la tranche avec son unité et sa borne basse", () => {
    const model = paceDistributionModel(paceBins([60, 60]));

    expect(model.bars[0].rangeLabel).toBe("4:30–4:45 /km");
    expect(model.bars[0].tickLabel).toBe("4:30");
    expect(model.bars[1].rangeLabel).toBe("4:45–5:00 /km");
  });

  it("dit « < » et « > » sur les tranches de bord ouvertes", () => {
    const model = paceDistributionModel([
      { from: Number.NEGATIVE_INFINITY, to: 180, seconds: 30 },
      { from: 180, to: 195, seconds: 60 },
      { from: 720, to: Number.POSITIVE_INFINITY, seconds: 45 },
    ]);

    expect(model.bars.map((bar) => bar.rangeLabel)).toEqual([
      "< 3:00 /km",
      "3:00–3:15 /km",
      "> 12:00 /km",
    ]);
    expect(model.bars.map((bar) => bar.tickLabel)).toEqual(["< 3:00", "3:00", "> 12:00"]);
  });

  it("garde l'accent sur toute la série : l'allure a une seule couleur", () => {
    const model = paceDistributionModel(paceBins([60, 600, 120]));

    expect(model.bars.every((bar) => bar.fillClass === "bg-accent")).toBe(true);
    expect(model.bars.every((bar) => bar.zoneLabel === null)).toBe(true);
  });
});

describe("hrDistributionModel", () => {
  const bins: DistributionBin[] = [
    { from: 110, to: 115, seconds: 60 },
    { from: 140, to: 145, seconds: 300 },
    { from: 185, to: 190, seconds: 90 },
  ];

  it("colore chaque tranche dans la zone de son milieu", () => {
    // FC max 200 : 112,5 → 56 % (Z1), 142,5 → 71 % (Z3), 187,5 → 94 % (Z5).
    const model = hrDistributionModel(bins, 200);

    expect(model.bars.map((bar) => bar.fillClass)).toEqual([
      "bg-zone-1",
      "bg-zone-3",
      "bg-zone-5",
    ]);
    expect(model.bars.map((bar) => bar.zoneLabel)).toEqual(["Z1", "Z3", "Z5"]);
    expect(model.bars[0].rangeLabel).toBe("110–115 bpm");
  });

  it("ne devine aucune zone sans FC max au profil", () => {
    const model = hrDistributionModel(bins, null);

    expect(model.bars.every((bar) => bar.fillClass === "bg-negative")).toBe(true);
    expect(model.bars.every((bar) => bar.zoneLabel === null)).toBe(true);
  });
});
