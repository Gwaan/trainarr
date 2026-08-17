import { describe, expect, it } from "vitest";

import { describePendingElevation, vo2maxTileNote } from "./pending-elevation";

describe("describePendingElevation", () => {
  it("se tait quand tout l’historique porte son dénivelé", () => {
    expect(describePendingElevation(0)).toBeNull();
    // Un compteur négatif n'existe pas, mais il ne doit surtout pas produire une
    // alerte « -1 séance ».
    expect(describePendingElevation(-3)).toBeNull();
  });

  it("dit le nombre, la cause et la commande — les trois", () => {
    const note = describePendingElevation(37);

    expect(note).toContain("37 séances");
    // La cause : ces séances ne portent pas la correction que portent les
    // récentes. Sans elle, l'avertissement ne s'apprend rien.
    expect(note).toContain("correction d'altitude");
    // Le geste : l'application ne lance pas ce rattrapage elle-même.
    expect(note).toContain("pnpm db:backfill:elevation");
  });

  it("accorde le singulier", () => {
    const note = describePendingElevation(1);

    expect(note).toContain("1 séance ");
    expect(note).toContain("cette séance ne porte");
  });
});

describe("vo2maxTileNote", () => {
  it("rend la fenêtre seule quand il n’y a rien à rattraper", () => {
    expect(vo2maxTileNote(0, "Moyenne des 30 derniers jours.")).toBe(
      "Moyenne des 30 derniers jours.",
    );
  });

  it("accole l’avertissement sans faire disparaître la fenêtre", () => {
    // La tuile n'a qu'une ligne : l'avertissement s'ajoute, il ne remplace pas.
    const note = vo2maxTileNote(4, "Moyenne des 30 derniers jours.");

    expect(note).toContain("Moyenne des 30 derniers jours.");
    expect(note).toContain("Provisoire");
    expect(note).toContain("4 séances");
  });
});
