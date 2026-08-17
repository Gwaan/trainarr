import { describe, expect, it } from "vitest";

import { formatRaceDistanceKm, raceFormValues } from "./race-model";

const ACTIVITY = {
  startedAt: new Date("2026-04-12T07:30:00.000Z"),
  distanceM: 10_124,
  // 45:12 de déplacement, mais 46:03 écoulées : l'auto-pause a mangé 51 s.
  elapsedTimeS: 2_763,
};

describe("formatRaceDistanceKm", () => {
  it("écrit un compte rond sans décimales inutiles", () => {
    expect(formatRaceDistanceKm(10_000)).toBe("10");
  });

  it("garde le mètre, virgule française", () => {
    expect(formatRaceDistanceKm(10_124)).toBe("10,124");
  });

  it("ne fait pas dériver une distance officielle par arrondi", () => {
    // Le semi : arrondi au centième de kilomètre, il se relisait « 21,1 », et
    // l'aller-retour dans le formulaire réécrivait 21 100 m en base. La
    // promesse du module est qu'une valeur saisie se relit telle quelle.
    expect(formatRaceDistanceKm(21_097.5)).toBe("21,098");
    expect(formatRaceDistanceKm(21_098)).toBe("21,098");
  });
});

describe("raceFormValues", () => {
  it("pré-remplit depuis la séance quand rien n’est déclaré", () => {
    expect(raceFormValues(ACTIVITY, null)).toEqual({
      racedOn: "2026-04-12",
      distanceKm: "10,124",
      // Le temps **écoulé**, pas le temps de déplacement : un chrono officiel
      // est un temps de puce. Proposer 45:12 sur une séance en auto-pause
      // serait un chrono plus court que celui du bulletin, validé sans être
      // relu — et le facteur correctif de la VO₂max en sortirait gonflé.
      time: "46:03",
      // Jamais le nom de la séance : ce n'est pas un nom d'épreuve.
      name: "",
    });
  });

  it("relit la déclaration telle qu’elle a été saisie, pas la montre", () => {
    // C'est le point du module : le chrono de la puce et la distance
    // homologuée ne doivent pas être réécrits par ceux de la séance.
    expect(
      raceFormValues(ACTIVITY, {
        racedOn: "2026-04-12",
        distanceM: 10_000,
        timeS: 2_700,
        name: "10 km de Bordeaux",
      }),
    ).toEqual({
      racedOn: "2026-04-12",
      distanceKm: "10",
      time: "45:00",
      name: "10 km de Bordeaux",
    });
  });

  it("rend un champ vide pour une course déclarée sans nom", () => {
    expect(
      raceFormValues(ACTIVITY, {
        racedOn: "2026-04-12",
        distanceM: 10_000,
        timeS: 2_700,
        name: null,
      }).name,
    ).toBe("");
  });
});
