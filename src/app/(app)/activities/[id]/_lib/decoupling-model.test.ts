import { describe, expect, it } from "vitest";

import { decouplingVerdict, pacePerKmOf } from "./decoupling-model";

describe("decouplingVerdict", () => {
  it("applique les seuils de Friel, bornes incluses", () => {
    expect(decouplingVerdict(0).tone).toBe("positive");
    expect(decouplingVerdict(5).tone).toBe("positive");
    expect(decouplingVerdict(5.1).tone).toBe("warning");
    expect(decouplingVerdict(10).tone).toBe("warning");
    expect(decouplingVerdict(10.1).tone).toBe("negative");
  });

  it("ne signale rien quand l'efficience s'améliore", () => {
    expect(decouplingVerdict(-4.2)).toEqual({
      tone: "positive",
      label: "Couplage stable",
    });
  });

  it("porte toujours un libellé : la couleur ne dit rien seule", () => {
    for (const pct of [-10, 0, 7, 20]) {
      expect(decouplingVerdict(pct).label.length).toBeGreaterThan(0);
    }
  });
});

describe("pacePerKmOf", () => {
  it("convertit une vitesse moyenne en allure", () => {
    expect(pacePerKmOf(4)).toBe(250);
    expect(pacePerKmOf(1000 / 300)).toBeCloseTo(300, 9);
  });

  it("ne convertit pas une vitesse impossible", () => {
    expect(pacePerKmOf(0)).toBeNull();
    expect(pacePerKmOf(-2)).toBeNull();
    expect(pacePerKmOf(Number.NaN)).toBeNull();
  });
});
