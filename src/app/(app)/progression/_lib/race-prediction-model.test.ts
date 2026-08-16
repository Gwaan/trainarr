import { describe, expect, it } from "vitest";

import type { RaceAnchorDto } from "@/data/race-prediction";
import { predictedRaces, vdotFromRace, REFERENCE_DISTANCES } from "@/lib/metrics";

import {
  buildRacePredictionRows,
  describePredictionConfidence,
  describeRaceAnchor,
} from "./race-prediction-model";

/** Un 10 km en 48:30 — le chrono d'exemple du formulaire de plan. */
const REFERENCE = { distanceM: REFERENCE_DISTANCES["10k"], timeS: 2_910 };

const ANCHOR: RaceAnchorDto = {
  distance: "10k",
  distanceM: REFERENCE.distanceM,
  timeS: REFERENCE.timeS,
  vdot: vdotFromRace(REFERENCE.distanceM, REFERENCE.timeS),
  since: "2026-06-01",
  fromTest: false,
};

describe("buildRacePredictionRows", () => {
  it("nomme, chronomètre et allure les quatre distances de route", () => {
    const rows = buildRacePredictionRows(predictedRaces(ANCHOR.vdot));

    expect(rows.map((row) => row.distance)).toEqual([
      "5 km",
      "10 km",
      "Semi",
      "Marathon",
    ]);
    // Le 10 km prévu doit retomber sur le chrono qui a servi d'ancre : c'est
    // l'aller-retour du modèle, à la seconde d'arrondi près.
    expect(rows[1].time).toBe("48:30");
    expect(rows[1].pace).toBe("4:51/km");
  });

  it("porte le niveau de confiance de chaque ligne", () => {
    const rows = buildRacePredictionRows(predictedRaces(ANCHOR.vdot));

    // Résultat mesuré du socle : le marathon est spéculatif à tout niveau.
    expect(rows[0].confidence).toBe("calibrated");
    expect(rows[3].confidence).toBe("speculative");
  });

  it("n'invente aucune ligne : une prédiction absente n'apparaît pas", () => {
    expect(buildRacePredictionRows([])).toEqual([]);
  });
});

describe("describePredictionConfidence", () => {
  it("cite la fenêtre de calibration du modèle", () => {
    const note = describePredictionConfidence(
      buildRacePredictionRows(predictedRaces(ANCHOR.vdot)),
    );

    expect(note).toContain("15 à 50 minutes");
    expect(note).toContain("spéculative");
  });

  it("n'explique que les niveaux réellement présents", () => {
    const note = describePredictionConfidence([
      { key: "5k", distance: "5 km", time: "23:22", pace: "4:40/km", confidence: "calibrated" },
    ]);

    expect(note).not.toContain("spéculative");
    expect(note).not.toContain("extrapolée");
  });
});

describe("describeRaceAnchor", () => {
  it("dit le chrono, sa provenance et son âge", () => {
    const view = describeRaceAnchor(ANCHOR, "2026-06-15");

    expect(view.chrono).toBe("10 km · 48:30");
    expect(view.source).toContain("à l'ouverture de ton plan");
    expect(view.source).toContain("il y a 2 semaines");
    expect(view.note).toBeNull();
  });

  it("nomme un test pour ce qu'il est : évalué, pas retenu", () => {
    // `reference_updated_on` avance au dépôt de la proposition, qu'elle soit
    // ensuite acceptée ou refusée : dater le chrono par ce marqueur le ferait
    // paraître plus frais qu'il ne l'est.
    const view = describeRaceAnchor({ ...ANCHOR, fromTest: true }, "2026-06-15");

    expect(view.source).toContain("Dernier test chronométré évalué");
    expect(view.source).not.toContain("Chrono de référence déclaré");
  });

  it("réclame une recalibration passé la cadence de Daniels", () => {
    const view = describeRaceAnchor(ANCHOR, "2026-08-01");

    expect(view.source).toContain("il y a 9 semaines");
    expect(view.note).toContain("4 semaines");
  });

  it("ne réclame rien tant que la cadence n'est pas dépassée", () => {
    // 28 jours pile : la borne appartient encore à la fenêtre.
    expect(describeRaceAnchor(ANCHOR, "2026-06-29").note).toBeNull();
    expect(describeRaceAnchor(ANCHOR, "2026-06-30").note).not.toBeNull();
  });
});
