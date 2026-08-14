import { describe, expect, it } from 'vitest';

import {
  EASY_HR_BANDS,
  EASY_HR_ZONE,
  PRESCRIBED_HR_ZONES,
  canPrescribeHeartRate,
  hrPercentTargetBpm,
  hrTargetPercentOfMax,
  hrZoneTargetBpm,
} from './hr-targets';
import type { HrZoneAnchor } from './hr-zones';

/**
 * L'ancrage par défaut : une FC max de profil. Les créneaux de ce module sont
 * écrits en pourcentage de FC max — c'est donc dans ce repère que la plupart des
 * cas se lisent, l'ancrage au seuil ayant sa propre section.
 */
function maxHr(bpm: number): HrZoneAnchor {
  return { kind: 'max-hr', bpm };
}

/** L'ancrage de l'athlète qui a adopté une FC seuil. */
function lthr(bpm: number): HrZoneAnchor {
  return { kind: 'lthr', bpm };
}

describe('EASY_HR_ZONE', () => {
  it("vaut 2 — la convention que PlanStep.hrZone porte pour l'endurance", () => {
    expect(EASY_HR_ZONE).toBe(2);
  });

  it('reste dans les bornes que le schéma des étapes accepte', () => {
    expect(EASY_HR_ZONE).toBeGreaterThanOrEqual(1);
    expect(EASY_HR_ZONE).toBeLessThanOrEqual(5);
  });
});

describe('PRESCRIBED_HR_ZONES', () => {
  it('ancre la zone 2 sur les fractions de Daniels (65-79 % de FC max)', () => {
    expect(PRESCRIBED_HR_ZONES[EASY_HR_ZONE]).toMatchObject({
      minPercentOfMax: 65,
      maxPercentOfMax: 79,
    });
  });

  it('ne déclare aucun autre créneau : rien de prescrit, rien de publié', () => {
    expect(Object.keys(PRESCRIBED_HR_ZONES)).toEqual([String(EASY_HR_ZONE)]);
  });
});

describe('EASY_HR_BANDS', () => {
  const BANDS = [EASY_HR_BANDS.low, EASY_HR_BANDS.mid, EASY_HR_BANDS.high];

  /**
   * Le contrat non négociable : un sous-créneau **précise** l'endurance, il n'en
   * sort pas. Une bande qui déborderait déplacerait la répartition d'intensité
   * du plan — le 80/20 — sans que rien ne le signale.
   */
  it('reste à l’intérieur de la plage d’endurance', () => {
    const easy = PRESCRIBED_HR_ZONES[EASY_HR_ZONE];

    for (const band of BANDS) {
      expect(band.minPercentOfMax).toBeGreaterThanOrEqual(easy?.minPercentOfMax ?? 0);
      expect(band.maxPercentOfMax).toBeLessThanOrEqual(easy?.maxPercentOfMax ?? 0);
    }
    // Les deux bords de la plage sont bien atteints : sans cela, les bandes
    // décriraient autre chose que l'endurance.
    expect(EASY_HR_BANDS.low.minPercentOfMax).toBe(easy?.minPercentOfMax);
    expect(EASY_HR_BANDS.high.maxPercentOfMax).toBe(easy?.maxPercentOfMax);
  });

  it('monte du bas vers le haut, sans laisser de trou', () => {
    expect(EASY_HR_BANDS.low.minPercentOfMax).toBeLessThan(EASY_HR_BANDS.mid.minPercentOfMax);
    expect(EASY_HR_BANDS.mid.minPercentOfMax).toBeLessThan(EASY_HR_BANDS.high.minPercentOfMax);
    // Un recouvrement d'un point ou deux : une progression continue, pas trois
    // marches.
    expect(EASY_HR_BANDS.mid.minPercentOfMax).toBeLessThan(EASY_HR_BANDS.low.maxPercentOfMax);
    expect(EASY_HR_BANDS.high.minPercentOfMax).toBeLessThan(EASY_HR_BANDS.mid.maxPercentOfMax);
  });

  it('reste tenable au poignet : au moins 5 points de large', () => {
    for (const band of BANDS) {
      expect(band.maxPercentOfMax - band.minPercentOfMax).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('hrPercentTargetBpm', () => {
  it('rend le haut de l’endurance en battements — 136-145 bpm à 184', () => {
    expect(hrPercentTargetBpm(EASY_HR_BANDS.high, maxHr(184))).toEqual({ minBpm: 136, maxBpm: 145 });
  });

  it('rend le bas et le milieu, distincts du haut', () => {
    expect(hrPercentTargetBpm(EASY_HR_BANDS.low, maxHr(184))).toEqual({ minBpm: 120, maxBpm: 131 });
    expect(hrPercentTargetBpm(EASY_HR_BANDS.mid, maxHr(184))).toEqual({ minBpm: 129, maxBpm: 138 });
  });

  it('applique les mêmes gardes que la zone : rien sans FC max exploitable', () => {
    expect(hrPercentTargetBpm(EASY_HR_BANDS.high, null)).toBeNull();
    expect(hrPercentTargetBpm(EASY_HR_BANDS.high, maxHr(119))).toBeNull();
    expect(hrPercentTargetBpm(EASY_HR_BANDS.high, maxHr(184.5))).toBeNull();
  });
});

describe('hrZoneTargetBpm', () => {
  it('rend 120-145 bpm pour une FC max de 184 — le cas de référence', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(184))).toEqual({ minBpm: 120, maxBpm: 145 });
  });

  it("n'est PAS la table générique des montres (Z2 = 60-70 % donnerait 110-129)", () => {
    const target = hrZoneTargetBpm(EASY_HR_ZONE, maxHr(184));
    expect(target).not.toEqual({ minBpm: 110, maxBpm: 129 });
    // Le bas de la plage Daniels est au-dessus du haut de la plage générique :
    // les deux tables ne se recouvrent presque pas, l'écart n'est pas un arrondi.
    expect(target?.minBpm).toBeGreaterThan(110);
  });

  it('arrondit les deux bornes à l’entier', () => {
    // 190 × 0,65 = 123,5 → 124 ; 190 × 0,79 = 150,1 → 150.
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(190))).toEqual({ minBpm: 124, maxBpm: 150 });
  });

  it('rend null sans FC max — rien n’est deviné', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, null)).toBeNull();
  });

  it('rend null sur une FC max hors bornes de plausibilité', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(119))).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(231))).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(Number.NaN))).toBeNull();
  });

  it('rend null sur une FC max non entière — aucun cardio ne mesure 184,5 bpm', () => {
    // Le JSDoc le promet, et la règle du projet l'impose : une donnée qui n'en
    // est pas une ne se prescrit pas, même dans les bornes de plausibilité.
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(184.5))).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(183.999))).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(Number.POSITIVE_INFINITY))).toBeNull();
    expect(canPrescribeHeartRate(184.5)).toBe(false);
  });

  it('accepte les bornes elles-mêmes', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(120))).not.toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(230))).not.toBeNull();
  });

  it('rend null pour une zone sans créneau déclaré', () => {
    for (const zone of [1, 3, 4, 5]) {
      expect(hrZoneTargetBpm(zone, maxHr(184))).toBeNull();
    }
  });
});

describe('hrTargetPercentOfMax', () => {
  /** L'endurance de cette athlète : 120–145 bpm, prescrits sur une FC max de 184. */
  const ENDURANCE = { minBpm: 120, maxBpm: 145 };

  it('ramène les battements au pourcentage de la référence donnée', () => {
    // La FC max que porte le compte intervals.icu de l'athlète.
    expect(hrTargetPercentOfMax(ENDURANCE, 205)).toEqual({ minPercent: 59, maxPercent: 71 });
  });

  it('redonne le créneau prescrit quand la référence est celle du profil', () => {
    // L'aller-retour zone → bpm → pourcentage doit être neutre : c'est ce qui
    // dicte l'arrondi au plus proche plutôt qu'un resserrement vers l'intérieur.
    expect(hrTargetPercentOfMax(ENDURANCE, 184)).toEqual({ minPercent: 65, maxPercent: 79 });
    expect(PRESCRIBED_HR_ZONES[EASY_HR_ZONE]).toMatchObject({
      minPercentOfMax: 65,
      maxPercentOfMax: 79,
    });
  });

  it('reste à un demi-point de FC max de la cible, quelle que soit la référence', () => {
    // L'écart que l'arrondi à l'entier peut introduire, et rien de plus : un
    // demi-point de la référence, soit environ 1 bpm — le bruit d'un cardio.
    for (let reference = 150; reference <= 220; reference += 1) {
      const percent = hrTargetPercentOfMax(ENDURANCE, reference);
      if (percent === null) throw new Error(`référence ${reference} refusée`);

      const tolerance = reference / 200 + 1e-9;
      const min = (percent.minPercent / 100) * reference;
      const max = (percent.maxPercent / 100) * reference;
      expect(Math.abs(min - ENDURANCE.minBpm), `min à ${reference}`).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(max - ENDURANCE.maxBpm), `max à ${reference}`).toBeLessThanOrEqual(tolerance);
    }
  });

  it('rend null sur une référence absente ou aberrante', () => {
    expect(hrTargetPercentOfMax(ENDURANCE, null)).toBeNull();
    expect(hrTargetPercentOfMax(ENDURANCE, Number.NaN)).toBeNull();
    // Mêmes bornes de plausibilité que la prescription elle-même.
    expect(hrTargetPercentOfMax(ENDURANCE, 119)).toBeNull();
    expect(hrTargetPercentOfMax(ENDURANCE, 231)).toBeNull();
  });

  it('accepte une référence non entière — ce n’est qu’un dénominateur', () => {
    expect(hrTargetPercentOfMax(ENDURANCE, 184.5)).not.toBeNull();
  });
});

describe('canPrescribeHeartRate', () => {
  it('est le seul interrupteur de la fonctionnalité', () => {
    expect(canPrescribeHeartRate(184)).toBe(true);
    expect(canPrescribeHeartRate(null)).toBe(false);
    expect(canPrescribeHeartRate(90)).toBe(false);
  });
});

describe('prescription ancrée sur la FC seuil', () => {
  it('porte les bornes de Daniels dans le repère du seuil', () => {
    // 65-79 % de FC max deviennent 73-89 % du seuil (÷ 0,89). Sur un seuil de
    // 165 : 121-146 bpm.
    expect(hrZoneTargetBpm(EASY_HR_ZONE, lthr(165))).toEqual({ minBpm: 121, maxBpm: 146 });
  });

  it('donne des cibles plus basses à qui a un seuil bas, plus hautes à qui l’a haut', () => {
    // Deux coureurs à 190 de FC max : l'un a son seuil à 165, l'autre à 178. En
    // % de FC max, ils reçoivent la même prescription (124-150) ; ancrés sur
    // leur seuil, ils reçoivent la leur.
    const generic = hrZoneTargetBpm(EASY_HR_ZONE, maxHr(190));
    const low = hrZoneTargetBpm(EASY_HR_ZONE, lthr(165));
    const high = hrZoneTargetBpm(EASY_HR_ZONE, lthr(178));

    expect(generic).toEqual({ minBpm: 124, maxBpm: 150 });
    expect(low?.maxBpm).toBeLessThan(generic?.maxBpm ?? 0);
    expect(high?.maxBpm).toBeGreaterThan(generic?.maxBpm ?? 0);
  });

  it('place le plafond de l’endurance au plafond de la Z2 de Friel', () => {
    // La conversion est calée pour que 79 % de FC max tombe sur 89 % du seuil —
    // c'est-à-dire exactement la frontière que Friel place entre l'endurance et
    // le travail actif. La vérification tient en une division.
    const target = hrZoneTargetBpm(EASY_HR_ZONE, lthr(170));
    expect(target).not.toBeNull();
    expect(((target?.maxBpm ?? 0) / 170) * 100).toBeCloseTo(89, 0);
  });

  it('porte aussi les sous-créneaux, qui restent ordonnés et dans la plage', () => {
    const anchor = lthr(170);
    const low = hrPercentTargetBpm(EASY_HR_BANDS.low, anchor);
    const high = hrPercentTargetBpm(EASY_HR_BANDS.high, anchor);
    const zone = hrZoneTargetBpm(EASY_HR_ZONE, anchor);

    expect(low?.minBpm).toBe(zone?.minBpm);
    expect(high?.maxBpm).toBe(zone?.maxBpm);
    expect(low?.maxBpm).toBeLessThan(high?.maxBpm ?? 0);
  });

  it('applique les bornes de plausibilité d’un seuil, pas celles d’une FC max', () => {
    // 110 bpm est une FC max invraisemblable mais un seuil possible ; 220 bpm
    // est une FC max plausible et un seuil qui ne l'est pas. Refuser l'un au nom
    // de l'autre n'aurait pas de sens.
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(110))).toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, lthr(110))).not.toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, maxHr(220))).not.toBeNull();
    expect(hrZoneTargetBpm(EASY_HR_ZONE, lthr(220))).toBeNull();
  });

  it('refuse un seuil non entier, comme une FC max non entière', () => {
    expect(hrZoneTargetBpm(EASY_HR_ZONE, lthr(170.5))).toBeNull();
  });
});
