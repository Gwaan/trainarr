import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { METRIC_SHEETS, metricSheet, type MetricSheetId } from "./metric-sheets";

/**
 * Deux garanties, et elles sont de nature différente.
 *
 * 1. **Complétude** : une fiche à moitié écrite est pire qu'une fiche absente —
 *    une modale qui s'ouvre sur une section vide donne l'impression que
 *    l'explication a été perdue, pas qu'elle n'existe pas.
 * 2. **Intégrité des renvois** : chaque `id` cité par un déclencheur `ⓘ` dans
 *    l'arbre `src/app/` existe dans le registre. Le typage l'assure déjà à la
 *    compilation, mais il ne dit rien d'un identifiant écrit dans une chaîne
 *    (`sheet="pace-distribution"` passé à `DistributionPanel`), et surtout il ne
 *    survit pas à un `id` retiré du registre pendant qu'un appelant le cite.
 */

const SHEET_IDS = Object.keys(METRIC_SHEETS);

/** Chaque fiche avec la clé sous laquelle le registre la range. */
const SHEET_ENTRIES = Object.entries(METRIC_SHEETS);

/** Les identifiants cités dans le JSX : `id="…"` de `MetricInfo`, `sheet="…"`. */
const REFERENCE_PATTERNS = [
  /<MetricInfo\s+id="([^"]+)"/g,
  /\bsheet:\s*"([^"]+)"/g,
  /\bsheet="([^"]+)"/g,
];

const APP_DIR = join(process.cwd(), "src", "app");

function walkTsx(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsx(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".tsx")) files.push(path);
  }

  return files;
}

describe("registre des fiches de métriques", () => {
  it("expose au moins les métriques abrégées de l'appli", () => {
    expect(SHEET_IDS).toEqual(
      expect.arrayContaining(["ctl", "atl", "tsb", "trimp", "vo2max", "vdot"]),
    );
  });

  it.each(SHEET_ENTRIES)("la fiche « %s » est complète", (id, sheet) => {
    // La clé du registre et l'`id` de la fiche ne doivent jamais diverger : le
    // composant lit l'un et affiche l'autre.
    expect(sheet.id).toBe(id);

    expect(sheet.abbreviation.trim()).not.toBe("");
    expect(sheet.name.trim()).not.toBe("");
    expect(sheet.question.trim()).not.toBe("");
    // Une question, pas une étiquette : c'est l'`aria-label` du déclencheur.
    expect(sheet.question).toMatch(/\?$/);

    // « Deux phrases » : le vérifier au mot près serait fragile, mais une
    // définition d'une poignée de caractères n'en est pas une.
    expect(sheet.what.length).toBeGreaterThan(60);

    expect(sheet.interpret.length).toBeGreaterThan(0);
    expect(sheet.computed.length).toBeGreaterThan(0);
    for (const line of [...sheet.interpret, ...sheet.computed]) {
      expect(line.trim()).not.toBe("");
    }

    // `caveat` est optionnel, mais jamais présent et vide.
    if (sheet.caveat !== undefined) expect(sheet.caveat.trim()).not.toBe("");
  });

  const ESTIMATED: readonly MetricSheetId[] = ["vo2max", "vdot", "ctl", "atl", "tsb", "trimp"];

  it.each(ESTIMATED)("la métrique estimée « %s » porte sa limite", (id) => {
    expect(metricSheet(id).caveat).toBeDefined();
  });
});

describe("renvois depuis l'UI", () => {
  const files = walkTsx(APP_DIR);

  it("balaie bien l'arbre des routes", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("chaque identifiant cité par un déclencheur existe dans le registre", () => {
    const cited = new Map<string, string>();

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of REFERENCE_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          cited.set(match[1], file);
        }
      }
    }

    // Un balayage qui ne trouve rien passerait ce test sans rien vérifier.
    expect(cited.size).toBeGreaterThan(0);

    const unknown = [...cited].filter(([id]) => !SHEET_IDS.includes(id));
    expect(unknown).toEqual([]);
  });
});
