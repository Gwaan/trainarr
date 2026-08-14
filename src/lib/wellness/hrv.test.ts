import { describe, expect, it } from 'vitest';

import { hrvLabel, hrvVariantName, majorityHrvVariant, readHrv } from './hrv';

/** Une journée dont chaque test ne renseigne que la variante qu'il éprouve. */
function sample(measures: { rmssd?: number; sdnn?: number } = {}) {
  return {
    hrvRmssdMs: measures.rmssd ?? null,
    hrvSdnnMs: measures.sdnn ?? null,
  };
}

describe('readHrv', () => {
  it('rend la variante disponible, avec ce qu’elle est', () => {
    expect(readHrv(sample({ rmssd: 63 }))).toEqual({ value: 63, variant: 'rmssd' });
    expect(readHrv(sample({ sdnn: 45 }))).toEqual({ value: 45, variant: 'sdnn' });
  });

  it('fait primer le rMSSD quand la montre pousse les deux', () => {
    // Référence du domaine en récupération : c'est elle qu'on montre, et le SDNN
    // du même jour ne vient jamais s'y substituer.
    expect(readHrv(sample({ rmssd: 63, sdnn: 45 }))).toEqual({ value: 63, variant: 'rmssd' });
  });

  it('rend `null` sur une nuit sans HRV — jamais un zéro', () => {
    expect(readHrv(sample())).toBeNull();
  });
});

describe('majorityHrvVariant', () => {
  it('rend la variante du plus grand nombre de nuits mesurées', () => {
    const days = [sample({ sdnn: 44 }), sample({ sdnn: 46 }), sample({ rmssd: 63 })];

    expect(majorityHrvVariant(days)).toBe('sdnn');
  });

  it('tranche en faveur du rMSSD à égalité — changement de montre en cours de période', () => {
    expect(majorityHrvVariant([sample({ sdnn: 44 }), sample({ rmssd: 63 })])).toBe('rmssd');
  });

  it('ignore les nuits sans mesure plutôt que de les compter contre une variante', () => {
    expect(majorityHrvVariant([sample(), sample({ sdnn: 44 }), sample()])).toBe('sdnn');
  });

  it('rend `null` quand la fenêtre ne porte aucune HRV', () => {
    expect(majorityHrvVariant([sample(), sample()])).toBeNull();
    expect(majorityHrvVariant([])).toBeNull();
  });
});

describe('les libellés', () => {
  it('nomme la grandeur comme le domaine l’écrit', () => {
    expect(hrvVariantName('rmssd')).toBe('rMSSD');
    expect(hrvVariantName('sdnn')).toBe('SDNN');
  });

  it('étiquette toujours la variante affichée', () => {
    expect(hrvLabel('rmssd')).toBe('HRV (rMSSD)');
    expect(hrvLabel('sdnn')).toBe('HRV (SDNN)');
  });

  it('n’annonce aucune variante quand rien n’a été mesuré', () => {
    expect(hrvLabel(null)).toBe('HRV');
  });
});
