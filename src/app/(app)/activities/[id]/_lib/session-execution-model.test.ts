import { describe, expect, it } from "vitest";

import type { ExecutionRow, SessionExecution } from "@/lib/metrics";

import {
  EXECUTION_GAP_TEXTS,
  MIN_BAND_WIDTH_PCT,
  executionBars,
  executionGapTexts,
  executionHeadline,
} from "./session-execution-model";

function row(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    metric: "pace",
    repetition: null,
    band: { min: 260, max: 265 },
    target: null,
    actual: 272,
    delta: 7,
    standing: "over",
    ...overrides,
  };
}

function execution(overrides: Partial<SessionExecution> = {}): SessionExecution {
  return { repeats: null, rows: [row()], gaps: [], ...overrides };
}

describe("executionBars", () => {
  it("écrit la valeur, la cible et l’écart d’une allure hors bande", () => {
    const [bar] = executionBars(execution());

    expect(bar.label).toBe("Allure moyenne");
    expect(bar.value).toBe("4:32/km");
    expect(bar.target).toBe("cible 4:20–4:25/km");
    expect(bar.delta).toBe("+7 s/km");
    expect(bar.inBand).toBe(false);
  });

  it("remplace l’écart par la coche quand le réalisé est dans la bande", () => {
    const [bar] = executionBars(
      execution({ rows: [row({ actual: 262, delta: 0, standing: "in-band" })] }),
    );

    expect(bar.delta).toBeNull();
    expect(bar.inBand).toBe(true);
  });

  it("numérote les répétitions, et nomme le bloc quand il est seul", () => {
    const repeated = executionBars(
      execution({
        repeats: { count: 2, distanceM: 800 },
        rows: [row({ repetition: 1 }), row({ repetition: 2 })],
      }),
    );
    expect(repeated.map((bar) => bar.label)).toEqual(["Répétition 1", "Répétition 2"]);

    const single = executionBars(
      execution({ repeats: { count: 1, distanceM: 3000 }, rows: [row({ repetition: 1 })] }),
    );
    expect(single[0].label).toBe("Bloc d'effort");
  });

  it("écrit une FC en battements et une distance en kilomètres", () => {
    const [hr, distance] = executionBars(
      execution({
        rows: [
          row({ metric: "heart-rate", band: { min: 124, max: 150 }, actual: 158, delta: 8 }),
          row({
            metric: "distance",
            band: null,
            target: 10_000,
            actual: 9_780,
            delta: -220,
            standing: "no-band",
          }),
        ],
      }),
    );

    expect(hr).toMatchObject({
      label: "FC moyenne",
      value: "158 bpm",
      target: "cible 124–150 bpm",
      delta: "+8 bpm",
    });
    expect(distance).toMatchObject({
      label: "Distance",
      value: "9,8 km",
      target: "prescrit 10,0 km",
      delta: "−220 m",
    });
  });

  it("écrit une durée en horloge, écart signé compris", () => {
    const [bar] = executionBars(
      execution({
        rows: [
          row({
            metric: "duration",
            band: null,
            target: 2_700,
            actual: 2_800,
            delta: 100,
            standing: "no-band",
          }),
        ],
      }),
    );

    expect(bar).toMatchObject({ label: "Durée", value: "46:40", target: "prescrit 45:00", delta: "+1:40" });
  });

  it("place la bande et le marqueur dans le rail", () => {
    const [bar] = executionBars(
      execution({ rows: [row({ band: { min: 240, max: 250 }, actual: 250, delta: 0, standing: "in-band" })] }),
    );

    // Domaine 235–255 : marge d'un quart de l'écart, jamais moins que la
    // demi-largeur de bande (5 s ici).
    expect(bar.geometry).toEqual({
      kind: "band",
      bandStartPct: 25,
      bandWidthPct: 50,
      markerPct: 75,
    });
  });

  it("garde la bande visible quand le réalisé en est très loin", () => {
    const [bar] = executionBars(
      execution({ rows: [row({ band: { min: 240, max: 250 }, actual: 600, delta: 350 })] }),
    );

    expect(bar.geometry.kind).toBe("band");
    if (bar.geometry.kind !== "band") return;

    expect(bar.geometry.bandWidthPct).toBeGreaterThanOrEqual(MIN_BAND_WIDTH_PCT);
    expect(bar.geometry.markerPct).toBeLessThanOrEqual(100);
    expect(bar.geometry.markerPct).toBeGreaterThan(bar.geometry.bandStartPct);
  });

  it("part de zéro pour un volume : l’aplat est le prescrit, le marqueur le réalisé", () => {
    const [bar] = executionBars(
      execution({
        rows: [
          row({
            metric: "distance",
            band: null,
            target: 10_000,
            actual: 9_500,
            delta: -500,
            standing: "no-band",
          }),
        ],
      }),
    );

    expect(bar.geometry.kind).toBe("target");
    if (bar.geometry.kind !== "target") return;

    expect(bar.geometry.targetWidthPct).toBeCloseTo(94.3, 1);
    expect(bar.geometry.markerPct).toBeCloseTo(89.6, 1);
  });
});

describe("executionHeadline", () => {
  it("compte les répétitions dans la bande", () => {
    const headline = executionHeadline(
      execution({
        repeats: { count: 6, distanceM: 800 },
        rows: [
          row({ repetition: 1, delta: 0, standing: "in-band" }),
          row({ repetition: 2, delta: 0, standing: "in-band" }),
          row({ repetition: 3 }),
          row({ repetition: 4, delta: 0, standing: "in-band" }),
          row({ repetition: 5, delta: 0, standing: "in-band" }),
          row({ repetition: 6, delta: 0, standing: "in-band" }),
        ],
      }),
    );

    expect(headline).toBe("5 répétitions sur 6 dans la bande d'allure.");
  });

  it("accorde le singulier", () => {
    const headline = executionHeadline(
      execution({
        repeats: { count: 3, distanceM: 800 },
        rows: [row({ repetition: 1, delta: 0, standing: "in-band" }), row({ repetition: 2 }), row({ repetition: 3 })],
      }),
    );

    expect(headline).toBe("1 répétition sur 3 dans la bande d'allure.");
  });

  it("nomme le bloc unique plutôt que de le compter", () => {
    expect(
      executionHeadline(
        execution({ repeats: { count: 1, distanceM: 3000 }, rows: [row({ repetition: 1 })] }),
      ),
    ).toBe("Le bloc d'effort est hors de la bande d'allure.");
  });

  it("nomme la cible quand la séance n’en porte qu’une", () => {
    expect(
      executionHeadline(
        execution({
          rows: [row({ metric: "heart-rate", band: { min: 124, max: 150 }, actual: 140, delta: 0, standing: "in-band" })],
        }),
      ),
    ).toBe("FC moyenne dans la bande.");
  });

  it("compte les cibles d’une séance simple", () => {
    expect(
      executionHeadline(
        execution({
          rows: [
            row({ delta: 0, standing: "in-band" }),
            row({ metric: "heart-rate", band: { min: 124, max: 150 }, actual: 158, delta: 8 }),
          ],
        }),
      ),
    ).toBe("1 cible sur 2 dans la bande.");
  });

  it("ne résume rien quand aucune ligne ne porte de bande", () => {
    expect(
      executionHeadline(
        execution({
          rows: [
            row({
              metric: "distance",
              band: null,
              target: 10_000,
              actual: 9_500,
              delta: -500,
              standing: "no-band",
            }),
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("executionGapTexts", () => {
  it("rend une phrase par motif, dans l’ordre du modèle", () => {
    expect(
      executionGapTexts(execution({ gaps: ["streams-missing", "heart-rate-not-measured"] })),
    ).toEqual([
      EXECUTION_GAP_TEXTS["streams-missing"],
      EXECUTION_GAP_TEXTS["heart-rate-not-measured"],
    ]);
  });

  it("écrit chaque motif en une phrase complète", () => {
    for (const text of Object.values(EXECUTION_GAP_TEXTS)) {
      expect(text.trim()).not.toBe("");
      expect(text).toMatch(/\.$/);
    }
  });
});
