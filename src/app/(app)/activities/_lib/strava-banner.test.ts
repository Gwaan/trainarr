import { describe, expect, it } from 'vitest';

import { resolveStravaBanner } from './strava-banner';

describe('resolveStravaBanner', () => {
  it('annonce la connexion réussie et la synchronisation en cours', () => {
    const banner = resolveStravaBanner('connected');

    expect(banner?.tone).toBe('positive');
    expect(banner?.title).toBe('Strava connecté');
    expect(banner?.description).toContain('Synchronisation en cours');
  });

  it('reste neutre quand l’autorisation a été refusée', () => {
    expect(resolveStravaBanner('denied')?.tone).toBe('neutral');
  });

  it('signale une erreur d’échange en négatif', () => {
    expect(resolveStravaBanner('error')?.tone).toBe('negative');
  });

  it("liste les variables d'environnement manquantes", () => {
    const banner = resolveStravaBanner('unconfigured');

    expect(banner?.tone).toBe('negative');
    expect(banner?.envVars).toEqual([
      'STRAVA_CLIENT_ID',
      'STRAVA_CLIENT_SECRET',
      'APP_BASE_URL',
    ]);
  });

  it('explique la permission manquante et propose de relancer la connexion', () => {
    const banner = resolveStravaBanner('scope');

    expect(banner?.tone).toBe('negative');
    expect(banner?.title).toBe('Permission Strava insuffisante');
    expect(banner?.description).toContain('privées');
    expect(banner?.action).toEqual({
      href: '/api/strava/connect',
      label: 'Relancer la connexion Strava',
    });
  });

  it('signale qu’un autre compte Strava est déjà connecté', () => {
    const banner = resolveStravaBanner('foreign');

    expect(banner?.tone).toBe('negative');
    expect(banner?.title).toBe('Un autre compte Strava est déjà connecté');
    expect(banner?.action?.href).toBe('/api/strava/connect');
  });

  it('ne rend aucun bandeau sans paramètre', () => {
    expect(resolveStravaBanner(undefined)).toBeNull();
  });

  it('ignore une valeur inconnue plutôt que de la réafficher', () => {
    expect(resolveStravaBanner('<img src=x onerror=alert(1)>')).toBeNull();
    expect(resolveStravaBanner('constructor')).toBeNull();
    expect(resolveStravaBanner('__proto__')).toBeNull();
  });

  it('ignore un paramètre répété', () => {
    expect(resolveStravaBanner(['connected', 'error'])).toBeNull();
  });
});
