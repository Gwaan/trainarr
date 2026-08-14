import { describe, expect, it, vi } from 'vitest';

import {
  AUTH_DISABLED_MESSAGES,
  AUTH_SECRET_MIN_LENGTH,
  planAuthActivation,
} from './config';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/** Un secret plausible : la longueur exacte du seuil. */
const VALID_SECRET = 'x'.repeat(AUTH_SECRET_MIN_LENGTH);

describe('planAuthActivation', () => {
  it("désactive l'authentification quand le secret est absent", () => {
    expect(planAuthActivation(undefined)).toEqual({
      status: 'disabled',
      reason: 'missing-secret',
    });
  });

  it('désactive quand le secret est plus court que le seuil', () => {
    expect(planAuthActivation('x'.repeat(AUTH_SECRET_MIN_LENGTH - 1))).toEqual({
      status: 'disabled',
      reason: 'weak-secret',
    });
  });

  it('accepte un secret exactement à la longueur du seuil', () => {
    expect(planAuthActivation(VALID_SECRET)).toEqual({
      status: 'ready',
      secret: VALID_SECRET,
    });
  });

  it('accepte un secret plus long', () => {
    const secret = 'y'.repeat(AUTH_SECRET_MIN_LENGTH + 12);
    expect(planAuthActivation(secret)).toEqual({ status: 'ready', secret });
  });

  it('nomme la variable à renseigner dans chaque diagnostic, sans jamais citer de valeur', () => {
    for (const message of Object.values(AUTH_DISABLED_MESSAGES)) {
      expect(message).toContain('BETTER_AUTH_SECRET');
      expect(message).not.toContain(VALID_SECRET);
    }
  });
});
