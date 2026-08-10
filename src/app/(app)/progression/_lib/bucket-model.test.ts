import { describe, expect, it } from "vitest";

import { buildBucketBarsModel, type BucketBarInput } from "./bucket-model";

function bars(values: readonly number[]): BucketBarInput[] {
  return values.map((value, index) => ({
    label: `S${index + 1}`,
    value,
    detail: null,
    partial: index === values.length - 1,
  }));
}

function build(values: readonly number[]) {
  return buildBucketBarsModel({
    bars: bars(values),
    formatValue: (value) => `${value} u`,
    formatTick: (value) => String(value),
    seriesLabel: "Charge",
  });
}

describe("buildBucketBarsModel", () => {
  it("met le maximum à hauteur de la graduation la plus haute", () => {
    const model = build([120, 300, 240]);

    expect(model?.ticks.map((tick) => tick.value)).toEqual([0, 100, 200, 300]);
    expect(model?.bars[1].heightPct).toBe(100);
    expect(model?.ticks[0].offsetPct).toBe(100);
    expect(model?.ticks.at(-1)?.offsetPct).toBe(0);
  });

  it("n'étiquette directement que le maximum", () => {
    const model = build([120, 300, 240]);
    expect(model?.bars.map((bar) => bar.isMax)).toEqual([false, true, false]);
  });

  it("garde toutes les étiquettes d'axe jusqu'à treize seaux", () => {
    const model = build(Array.from({ length: 13 }, (_, index) => index + 1));
    expect(model?.bars.every((bar) => bar.axisLabel !== null)).toBe(true);
  });

  it("saute des étiquettes au-delà, sans jamais lâcher la plus récente", () => {
    const model = build(Array.from({ length: 26 }, (_, index) => index + 1));
    const shown = model?.bars.filter((bar) => bar.axisLabel !== null) ?? [];

    expect(shown.length).toBeLessThanOrEqual(13);
    expect(model?.bars.at(-1)?.axisLabel).toBe("S26");
  });

  it("laisse les seaux vides à zéro plutôt que de les retirer", () => {
    const model = build([0, 100, 0]);

    expect(model?.bars).toHaveLength(3);
    expect(model?.bars[0].heightPct).toBe(0);
  });

  it("reporte le caractère partiel du dernier seau", () => {
    expect(build([120, 300, 240])?.bars.map((bar) => bar.partial)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("rend null quand il n'y a rien à montrer", () => {
    expect(build([])).toBeNull();
    expect(build([0, 0, 0])).toBeNull();
  });

  it("élargit les seaux jusqu'à ce que l'étiquette la plus longue tienne", () => {
    const months = (count: number, label: string) =>
      buildBucketBarsModel({
        bars: Array.from({ length: count }, (_, index) => ({
          label,
          value: index + 1,
          detail: null,
          partial: false,
        })),
        formatValue: String,
        formatTick: String,
        seriesLabel: "Volume",
      });

    // Toutes les étiquettes montrées : « août 25 » réclame sa place.
    expect(months(12, "août 25")?.minBarPx).toBe(54);
    // Une étiquette sur trois : trois seaux se partagent la même largeur.
    expect(months(30, "août 25")?.minBarPx).toBe(24);
  });

  it("décrit la série pour les lecteurs d'écran", () => {
    expect(build([120, 300, 240])?.ariaLabel).toBe(
      "Charge : 3 périodes, de S1 à S3, maximum 300 u (S2).",
    );
  });

  it("énonce chaque seau en entier sur son bouton", () => {
    const model = buildBucketBarsModel({
      bars: [
        { label: "S32", value: 412, detail: null, partial: false },
        { label: "S33", value: 180, detail: "4 séances", partial: true },
      ],
      formatValue: String,
      formatTick: String,
      valueUnit: "TRIMP",
      seriesLabel: "Charge",
    });

    expect(model?.bars[0].ariaLabel).toBe("S32, 412 TRIMP");
    // L'opacité du seau entamé ne dit rien à voix haute : le mot le dit.
    expect(model?.bars[1].ariaLabel).toBe("S33, 180 TRIMP, 4 séances, en cours");
  });

  it("n'ajoute pas d'unité quand la valeur formatée la porte déjà", () => {
    const model = buildBucketBarsModel({
      bars: [{ label: "août", value: 182, detail: "14 séances", partial: false }],
      formatValue: (value) => `${value} km`,
      formatTick: String,
      seriesLabel: "Volume",
    });

    expect(model?.bars[0].ariaLabel).toBe("août, 182 km, 14 séances");
  });
});
