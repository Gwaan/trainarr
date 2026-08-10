import { describe, expect, it, vi } from 'vitest';

// `oauth-flow.ts` commence par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

import { isForeignConnection } from './oauth-flow';

/** Identifiant Strava de Gwen, tel que la connexion l'a enregistré. */
const GWEN = 987_654;

describe('isForeignConnection', () => {
  it('laisse passer la première connexion : rien n’est encore enregistré', () => {
    expect(isForeignConnection(null, GWEN)).toBe(false);
  });

  it('laisse passer une reconnexion du même compte', () => {
    expect(isForeignConnection(GWEN, GWEN)).toBe(false);
  });

  it('refuse un autre compte Strava une fois la connexion établie', () => {
    // `/api/strava/connect` est anonyme : sans ce garde-fou, n'importe qui
    // déroulant l'OAuth écraserait la connexion de Gwen.
    expect(isForeignConnection(GWEN, 111_222)).toBe(true);
  });

  it('refuse un jeu de jetons dont l’athlète est inconnu', () => {
    // Ne rien savoir du compte entrant ne doit pas valoir laissez-passer.
    expect(isForeignConnection(GWEN, null)).toBe(true);
  });
});
