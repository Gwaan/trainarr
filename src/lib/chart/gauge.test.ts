import { describe, expect, it } from "vitest";

import {
  GAUGE_START_ANGLE,
  GAUGE_SWEEP_ANGLE,
  buildGaugeModel,
  type GaugeBand,
} from "./gauge";

/** Trois bandes contiguës couvrant 0..100, comme un référentiel de quartiles. */
const BANDS: GaugeBand[] = [
  { upTo: 25, className: "stroke-zone-1", label: "légère" },
  { upTo: 60, className: "stroke-zone-2", label: "habituelle" },
  { upTo: 100, className: "stroke-zone-4", label: "très élevée" },
];

function model(value: number, bands: GaugeBand[] = BANDS, min = 0, max = 100) {
  const built = buildGaugeModel({ value, min, max, bands });
  if (built === null) throw new Error("Modèle attendu pour ce domaine.");
  return built;
}

describe("buildGaugeModel", () => {
  it("place l'aiguille sur l'arc de 240°, du minimum au maximum", () => {
    expect(model(0).valueAngle).toBe(GAUGE_START_ANGLE);
    expect(model(50).valueAngle).toBe(GAUGE_START_ANGLE + GAUGE_SWEEP_ANGLE / 2);
    expect(model(100).valueAngle).toBe(GAUGE_START_ANGLE + GAUGE_SWEEP_ANGLE);
  });

  it("trace une aiguille partant du moyeu", () => {
    // Au milieu du domaine, l'aiguille pointe droit vers le haut : même
    // abscisse que le centre, ordonnée plus petite (l'axe Y du SVG descend).
    const needle = model(50).needlePath;
    expect(needle).toMatch(/^M 50 56 L 50\.00 (\d+\.\d+)$/);
    const tipY = Number(needle.split("L 50.00 ")[1]);
    expect(tipY).toBeLessThan(56);
  });

  it("tire un arc par bande, séparé de ses voisines", () => {
    const bands = model(10).bands;
    expect(bands).toHaveLength(3);
    expect(bands.map((band) => band.className)).toEqual([
      "stroke-zone-1",
      "stroke-zone-2",
      "stroke-zone-4",
    ]);
    // Un arc, pas une surface : jamais de `Z` qui refermerait la corde.
    for (const band of bands) expect(band.path).toMatch(/^M [\d.]+ [\d.]+ A 40 40 0 [01] 1 /);
  });

  it("allume la bande où tombe la valeur, et elle seule", () => {
    expect(model(40).activeBand.label).toBe("habituelle");
    expect(model(40).bands.map((band) => band.active)).toEqual([false, true, false]);
  });

  it("range une valeur posée sur une borne dans la bande inférieure", () => {
    // La borne appartient à la bande qu'elle ferme : `readTsb` lit ses seuils
    // de la même façon (`tsb <= -30` est déjà de la fatigue marquée).
    expect(model(25).activeBand.label).toBe("légère");
    expect(model(60).activeBand.label).toBe("habituelle");
  });

  it("pose une valeur hors domaine sur la borne, et le dit", () => {
    const below = model(-40);
    expect(below.clamped).toBe(true);
    expect(below.valueAngle).toBe(GAUGE_START_ANGLE);
    expect(below.activeBand.label).toBe("légère");

    const above = model(180);
    expect(above.clamped).toBe(true);
    expect(above.valueAngle).toBe(GAUGE_START_ANGLE + GAUGE_SWEEP_ANGLE);
    expect(above.activeBand.label).toBe("très élevée");

    expect(model(50).clamped).toBe(false);
  });

  it("accepte une bande unique couvrant tout le domaine", () => {
    const single = model(30, [{ upTo: 100, className: "stroke-accent", label: "tout" }]);
    expect(single.bands).toHaveLength(1);
    expect(single.bands[0].active).toBe(true);
    expect(single.activeBand.label).toBe("tout");
  });

  it("ignore les bandes hors domaine sans décaler les autres", () => {
    // La première borne est sous le minimum : elle ne trace rien, et la bande
    // suivante part quand même du minimum.
    const built = model(10, [
      { upTo: -5, className: "stroke-negative", label: "hors échelle" },
      { upTo: 100, className: "stroke-positive", label: "tout" },
    ]);
    expect(built.bands.map((band) => band.className)).toEqual(["stroke-positive"]);
    expect(built.activeBand.label).toBe("tout");
  });

  it("rend un modèle nul quand rien n'est plaçable", () => {
    // Domaine sans amplitude : aucune position n'existe sur l'échelle.
    expect(buildGaugeModel({ value: 5, min: 5, max: 5, bands: BANDS })).toBeNull();
    expect(buildGaugeModel({ value: 5, min: 10, max: 0, bands: BANDS })).toBeNull();
    expect(buildGaugeModel({ value: 5, min: 0, max: Number.NaN, bands: BANDS })).toBeNull();
    // Valeur inexploitable, ou échelle absente.
    expect(buildGaugeModel({ value: Number.NaN, min: 0, max: 100, bands: BANDS })).toBeNull();
    expect(buildGaugeModel({ value: 5, min: 0, max: 100, bands: [] })).toBeNull();
    // Toutes les bandes sous le domaine : il ne reste aucun arc à tracer.
    expect(
      buildGaugeModel({
        value: 5,
        min: 0,
        max: 100,
        bands: [{ upTo: -1, className: "stroke-fg-faint", label: "néant" }],
      }),
    ).toBeNull();
  });
});
