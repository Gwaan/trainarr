import { describe, expect, it } from "vitest";

import { readTsb, toDelta } from "./metric-tone";

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
