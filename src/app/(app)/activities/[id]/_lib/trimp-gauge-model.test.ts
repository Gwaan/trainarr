import { describe, expect, it } from "vitest";

import type { TrimpContextDto } from "@/data/activities";

import { trimpGaugeModel, trimpGaugeView } from "./trimp-gauge-model";

/** Trois mois d'entraînement : médiane à 80, quart supérieur au-delà de 120. */
const CONTEXT: TrimpContextDto = {
  p25: 50,
  p50: 80,
  p75: 120,
  max: 200,
  sampleSize: 18,
};

function bandOf(trimp: number, context: TrimpContextDto = CONTEXT): string {
  const model = trimpGaugeModel(trimp, context);
  if (model === null) throw new Error("Modèle attendu pour ce référentiel.");
  return model.activeBand.label;
}

describe("trimpGaugeModel", () => {
  it("situe la séance dans les quartiles de l'athlète", () => {
    expect(bandOf(30)).toBe("légère");
    expect(bandOf(65)).toBe("habituelle");
    expect(bandOf(100)).toBe("soutenue");
    expect(bandOf(160)).toBe("très élevée");
  });

  it("range une séance posée sur un quartile dans le registre inférieur", () => {
    expect(bandOf(50)).toBe("légère");
    expect(bandOf(120)).toBe("soutenue");
  });

  it("étire l'échelle jusqu'à une séance record, plutôt que de la sortir de l'arc", () => {
    const model = trimpGaugeModel(260, CONTEXT);
    expect(model?.clamped).toBe(false);
    expect(model?.activeBand.label).toBe("très élevée");
    // L'aiguille est au bout de l'arc : la séance est le nouveau maximum.
    expect(model?.valueAngle).toBe(30);
  });

  it("colore les quatre registres dans la rampe d'intensité", () => {
    expect(trimpGaugeModel(100, CONTEXT)?.bands.map((band) => band.className)).toEqual([
      "stroke-zone-1",
      "stroke-zone-2",
      "stroke-zone-3",
      "stroke-zone-4",
    ]);
  });
});

describe("trimpGaugeView", () => {
  it("nomme le registre et l'effectif du référentiel", () => {
    const view = trimpGaugeView(100, CONTEXT);

    expect(view?.value).toBe("100");
    expect(view?.note).toBe("Soutenue — vs tes 90 derniers jours (18 séances)");
    expect(view?.ariaLabel).toBe(
      "Charge de la séance : TRIMP 100, charge soutenue au regard de tes 90 derniers jours (18 séances).",
    );
  });

  it("n'affiche pas de jauge sans charge ni sans référentiel", () => {
    // Les deux cas de la page : profil incomplet (pas de TRIMP) et historique
    // trop court (pas de quartiles). La tuile chiffrée reprend la main.
    expect(trimpGaugeView(null, CONTEXT)).toBeNull();
    expect(trimpGaugeView(100, null)).toBeNull();
  });

  it("écarte une charge nulle, comme le fait le référentiel", () => {
    // `trimpContextOf` refuse les TRIMP nuls (une FC moyenne sous la FC de repos
    // est une aberration de mesure) : la séance affichée suit la même règle,
    // sinon elle décrocherait une jauge « 0 — Légère ».
    expect(trimpGaugeView(0, CONTEXT)).toBeNull();
  });
});
