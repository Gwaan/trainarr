import { describe, expect, it } from "vitest";

import { toMaxHrSuggestionView } from "./max-hr-suggestion";

const SUGGESTION = {
  bpm: 192,
  activityId: 31,
  activityName: "10 km de Bordeaux",
  activityStartedAt: new Date("2026-08-12T16:20:00.000Z"),
};

describe("toMaxHrSuggestionView", () => {
  it("rend null quand il n’y a rien à proposer", () => {
    expect(toMaxHrSuggestionView(null)).toBe(null);
  });

  it("réduit le DTO à ce que la carte affiche", () => {
    expect(toMaxHrSuggestionView(SUGGESTION, new Date("2026-08-14T09:00:00.000Z"))).toEqual({
      bpm: 192,
      activityId: 31,
      activityName: "10 km de Bordeaux",
      observedOn: "12 août",
    });
  });

  it("ajoute l’année quand la séance n’est pas de l’année en cours", () => {
    expect(
      toMaxHrSuggestionView(SUGGESTION, new Date("2027-01-04T09:00:00.000Z"))?.observedOn,
    ).toBe("12 août 2026");
  });

  it("lit la date dans le fuseau de l’athlète, pas en UTC", () => {
    // 22 h 40 UTC, c'est déjà le lendemain à Paris : la séance est du 13.
    expect(
      toMaxHrSuggestionView(
        { ...SUGGESTION, activityStartedAt: new Date("2026-08-12T22:40:00.000Z") },
        new Date("2026-08-14T09:00:00.000Z"),
      )?.observedOn,
    ).toBe("13 août");
  });
});
