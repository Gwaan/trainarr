import { describe, expect, it } from "vitest";

import { buildGaugeModel } from "@/lib/chart/gauge";

import {
  TSB_GAUGE_BANDS,
  TSB_GAUGE_DOMAIN,
  TSB_THRESHOLDS,
  readTsb,
  toDelta,
} from "./metric-tone";

describe("toDelta", () => {
  it("colore la hausse en progression et la baisse selon la métrique", () => {
    expect(toDelta(2.4, 1, "negative")).toEqual({
      value: "2,4",
      direction: "up",
      tone: "positive",
    });
    expect(toDelta(-3, 0, "warning")).toEqual({
      value: "3",
      direction: "down",
      tone: "warning",
    });
  });

  it("n'affiche rien sans point de comparaison", () => {
    expect(toDelta(null, 0, "warning")).toBeUndefined();
  });

  it("n'affiche rien quand l'écart s'annule à l'arrondi", () => {
    // Une flèche « 0 » ferait passer un arrondi pour une stagnation mesurée.
    expect(toDelta(0.04, 1, "negative")).toBeUndefined();
    expect(toDelta(-0.4, 0, "warning")).toBeUndefined();
  });
});

describe("readTsb", () => {
  it("suit les bandes usuelles de la méthode Coggan", () => {
    expect(readTsb(-40).tone).toBe("negative");
    expect(readTsb(-30).tone).toBe("negative");
    expect(readTsb(-12).tone).toBe("warning");
    expect(readTsb(0).tone).toBe("default");
    expect(readTsb(12).tone).toBe("positive");
  });

  it("accompagne chaque bande d'une lecture en français", () => {
    expect(readTsb(20).note).toBe("Frais, bien récupéré.");
  });
});

describe("TSB_GAUGE_BANDS", () => {
  /** La phrase de la bande allumée — celle que la tuile jauge affiche. */
  function bandAt(tsb: number): string {
    const model = buildGaugeModel({ value: tsb, ...TSB_GAUGE_DOMAIN, bands: TSB_GAUGE_BANDS });
    if (model === null) throw new Error("Modèle attendu sur le domaine du TSB.");
    return model.activeBand.label;
  }

  it("dit chaque registre avec les mots de la glose", () => {
    expect([bandAt(-40), bandAt(-12), bandAt(0), bandAt(12)]).toEqual([
      readTsb(-40).note,
      readTsb(-12).note,
      readTsb(0).note,
      readTsb(12).note,
    ]);
  });

  it("ne peut plus contredire la note sur une valeur posée sur une borne", () => {
    // +5 pile : la borne appartient à la bande qu'elle ferme, donc c'est
    // l'équilibre qui s'allume. La tuile en affiche la phrase — celle que
    // `readTsb` donne juste en dessous du seuil — au lieu d'annoncer « frais »
    // sous une bande neutre.
    expect(bandAt(TSB_THRESHOLDS.fresh)).toBe(readTsb(TSB_THRESHOLDS.fresh - 1).note);
    expect(bandAt(TSB_THRESHOLDS.fresh)).not.toBe(readTsb(TSB_THRESHOLDS.fresh).note);
  });
});
