import { describe, expect, it } from "vitest";

import type { PersonalBestDto } from "@/data/personal-bests";

import { buildPersonalBestRows, describePendingBests } from "./personal-bests-model";

/** Aujourd'hui, pour le millésime conditionnel des dates de record. */
const TODAY = "2026-08-16";

function best(targetM: number, timeS: number, activityId: number): PersonalBestDto {
  return {
    targetM,
    timeS,
    paceSecPerKm: (timeS / targetM) * 1000,
    achievedOn: "2026-05-17",
    activityId,
  };
}

describe("buildPersonalBestRows", () => {
  it("nomme la distance, met le chrono en horloge et date le record", () => {
    const [row] = buildPersonalBestRows([best(5_000, 1_248, 42)], TODAY);

    expect(row).toEqual({
      key: 5_000,
      distance: "5 km",
      time: "20:48",
      pace: "4:10/km",
      day: "dimanche 17 mai",
      href: "/activities/42",
    });
  });

  it("garde le libellé du mile, qui n'est pas un compte rond", () => {
    expect(buildPersonalBestRows([best(1_609.34, 312, 7)], TODAY)[0].distance).toBe("1 mile");
  });

  it("renvoie vers la séance qui porte le record", () => {
    const rows = buildPersonalBestRows([best(400, 78, 12), best(1_000, 214, 31)], TODAY);

    expect(rows.map((row) => row.href)).toEqual(["/activities/12", "/activities/31"]);
  });

  it("millésime un record d'une autre année, jamais celui de l'année en cours", () => {
    const rows = buildPersonalBestRows(
      [{ ...best(400, 78, 12), achievedOn: "2024-05-17" }],
      TODAY,
    );

    expect(rows[0].day).toBe("vendredi 17 mai 2024");
  });

  it("ne date rien plutôt que d'inventer un jour", () => {
    const rows = buildPersonalBestRows([{ ...best(400, 78, 12), achievedOn: "pas-une-date" }], TODAY);

    expect(rows[0].day).toBeNull();
  });
});

describe("describePendingBests", () => {
  it("se tait une fois l'historique entièrement balayé", () => {
    expect(describePendingBests(0)).toBeNull();
  });

  it("dit que les records sont provisoires, et nomme le rattrapage", () => {
    const note = describePendingBests(37);

    expect(note).toContain("provisoires");
    expect(note).toContain("37 séances n'ont pas encore été balayées");
    expect(note).toContain("pnpm db:backfill:best-segments");
  });

  it("accorde au singulier", () => {
    expect(describePendingBests(1)).toContain("1 séance n'a pas encore été balayée.");
  });
});
