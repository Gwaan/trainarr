import { describe, expect, it } from "vitest";

import { civilDateToMs } from "@/lib/dates/civil";
import { ticksIn } from "@/lib/chart/model";

import {
  DATE_AXIS,
  DATE_TARGET_TICKS,
  dateStep,
  formatDateTick,
  formatFullDay,
} from "./date-axis";

const DAY_MS = 86_400_000;

/** Étendue en jours entre deux dates civiles, telle que la voit l'axe. */
function span(from: string, to: string): number {
  return civilDateToMs(to) - civilDateToMs(from);
}

describe("dateStep", () => {
  it("borne l'axe à trois ou quatre intervalles sur chaque période de la page", () => {
    const cases: Array<[string, number, number]> = [
      // [période, étendue en jours, pas attendu en jours]
      ["3 mois", 90, 28],
      ["6 mois", 182, 56],
      ["1 an", 365, 91],
      ["3 ans", 1_095, 365],
      ["10 ans", 3_650, 730],
    ];

    for (const [, days, expected] of cases) {
      const step = dateStep(days * DAY_MS, DATE_TARGET_TICKS);
      expect(step).toBe(expected * DAY_MS);
      // Assez de repères pour lire l'axe, assez peu pour qu'ils tiennent côte à
      // côte sur un téléphone — sauf la décennie, qui sature l'échelle.
      const count = Math.floor((days * DAY_MS) / step);
      expect(count).toBeGreaterThanOrEqual(3);
      expect(count).toBeLessThanOrEqual(days > 3_000 ? 5 : DATE_TARGET_TICKS);
    }
  });

  it("descend sous la semaine quand l'historique est encore court", () => {
    expect(dateStep(12 * DAY_MS, DATE_TARGET_TICKS)).toBe(3 * DAY_MS);
  });

  it("retombe sur un jour pour une étendue inexploitable", () => {
    expect(dateStep(0, 6)).toBe(DAY_MS);
    expect(dateStep(Number.NaN, 6)).toBe(DAY_MS);
    expect(dateStep(90 * DAY_MS, 0)).toBe(DAY_MS);
  });

  it("aligne les graduations sur un même jour de semaine", () => {
    // Tous les pas jusqu'au trimestre sont des multiples de 7 jours : les
    // repères tombent au même jour de la semaine, l'axe ne « glisse » pas.
    const domain = { min: civilDateToMs("2026-05-12"), max: civilDateToMs("2026-08-10") };
    const ticks = ticksIn(domain, dateStep(domain.max - domain.min, DATE_TARGET_TICKS));

    expect(new Set(ticks.map((tick) => new Date(tick).getUTCDay()).values()).size).toBe(1);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });
});

describe("formatDateTick", () => {
  it("donne le jour tant que les repères sont rapprochés", () => {
    expect(formatDateTick(civilDateToMs("2026-05-12"), 14 * DAY_MS)).toBe("12 mai");
  });

  it("passe au mois dès que deux repères sont éloignés de plus de deux mois", () => {
    expect(formatDateTick(civilDateToMs("2025-05-12"), 91 * DAY_MS)).toBe("mai 25");
  });

  it("ne décale pas la date à cause du fuseau de l'athlète", () => {
    // Les repères tombent à minuit UTC ; Paris est en avance, donc le même jour.
    expect(formatDateTick(civilDateToMs("2026-01-01"), 7 * DAY_MS)).toBe("1 janv.");
  });
});

describe("DATE_AXIS", () => {
  it("décrit son étendue en toutes lettres", () => {
    expect(
      DATE_AXIS.label({ min: civilDateToMs("2026-05-12"), max: civilDateToMs("2026-08-10") }),
    ).toBe("du 12 mai 2026 au 10 août 2026");
  });

  it("branche le pas et le formatage de ce module", () => {
    expect(DATE_AXIS.targetTicks).toBe(DATE_TARGET_TICKS);
    expect(DATE_AXIS.step(span("2026-05-12", "2026-08-10"), DATE_TARGET_TICKS)).toBe(
      28 * DAY_MS,
    );
    expect(DATE_AXIS.formatTick(civilDateToMs("2026-08-10"), 28 * DAY_MS)).toBe("10 août");
  });
});

describe("formatFullDay", () => {
  it("écrit la date du curseur en entier", () => {
    expect(formatFullDay(civilDateToMs("2026-08-10"))).toBe("10 août 2026");
  });
});
