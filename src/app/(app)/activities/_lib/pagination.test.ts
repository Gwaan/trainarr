import { describe, expect, it } from "vitest";

import {
  formatWeekSpan,
  MAX_PAGE,
  pageOffset,
  parsePageParam,
  WEEKS_PER_PAGE,
} from "./pagination";

describe("parsePageParam", () => {
  it("lit un rang de page", () => {
    expect(parsePageParam("3")).toBe(3);
  });

  it("retombe sur la première page quand le paramètre est absent", () => {
    expect(parsePageParam(undefined)).toBe(1);
  });

  it("ignore un paramètre répété plutôt que d'en deviner un", () => {
    // `?page=2&page=9` arrive en tableau : rien n'y désigne la page voulue.
    expect(parsePageParam(["2", "9"])).toBe(1);
  });

  it("refuse ce qui n'est pas un rang de page", () => {
    expect(parsePageParam("")).toBe(1);
    expect(parsePageParam("deux")).toBe(1);
    expect(parsePageParam("2,5")).toBe(1);
    expect(parsePageParam("2.5")).toBe(1);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-4")).toBe(1);
    expect(parsePageParam("1e9")).toBe(1);
    expect(parsePageParam("9007199254740993")).toBe(1);
  });

  it("refuse une injection au lieu de la laisser filer vers la requête", () => {
    expect(parsePageParam("1; drop table activities")).toBe(1);
    expect(parsePageParam("1 offset 100000")).toBe(1);
  });

  it("plafonne la profondeur demandée", () => {
    expect(parsePageParam(String(MAX_PAGE))).toBe(MAX_PAGE);
    expect(parsePageParam(String(MAX_PAGE + 1))).toBe(1);
  });
});

describe("pageOffset", () => {
  it("compte les semaines déjà passées", () => {
    expect(pageOffset(1)).toBe(0);
    expect(pageOffset(2)).toBe(WEEKS_PER_PAGE);
    expect(pageOffset(5)).toBe(4 * WEEKS_PER_PAGE);
  });

  it("reste dans les bornes que le DAL accepte", () => {
    // Le plafond de l'URL et celui du DAL doivent rester d'accord : sinon une
    // page atteignable par un lien serait ramenée ailleurs par la requête.
    expect(pageOffset(MAX_PAGE)).toBeLessThanOrEqual(1_600);
  });
});

describe("formatWeekSpan", () => {
  it("va du lundi de la plus ancienne au dimanche de la plus récente", () => {
    // Semaines du 15 juin au 3 août 2026 : la borne haute est le dimanche 9.
    expect(formatWeekSpan("2026-06-15", "2026-08-03")).toBe("Du 15 juin au 9 août 2026");
  });

  it("porte l'année sur les deux bornes quand la plage en change", () => {
    expect(formatWeekSpan("2025-12-22", "2026-01-05")).toBe(
      "Du 22 déc. 2025 au 11 janv. 2026",
    );
  });

  it("tient sur une seule semaine", () => {
    expect(formatWeekSpan("2026-08-10", "2026-08-10")).toBe("Du 10 août au 16 août 2026");
  });
});
