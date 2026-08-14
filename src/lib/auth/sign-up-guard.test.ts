import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAPIError } from 'better-auth/api';

import {
  SIGN_UP_CLOSED_CODE,
  SIGN_UP_CLOSED_MESSAGE,
  guardSignUp,
} from './sign-up-guard';
import { hasAnyUser } from '@/data/users';

vi.mock('server-only', () => ({}));

// Le crochet ne connaît de la base que cette question-là.
vi.mock('@/data/users', () => ({ hasAnyUser: vi.fn() }));

const hasAnyUserMock = vi.mocked(hasAnyUser);

beforeEach(() => {
  hasAnyUserMock.mockReset();
});

describe('guardSignUp', () => {
  it("laisse passer la création tant qu'aucun compte n'existe", async () => {
    hasAnyUserMock.mockResolvedValue(false);

    await expect(guardSignUp()).resolves.toEqual({ data: { isFirstAccount: true } });
  });

  it("marque le compte d'amorçage, ce qui est ce que l'index unique arbitre", async () => {
    hasAnyUserMock.mockResolvedValue(false);

    const { data } = await guardSignUp();

    // C'est cette valeur, et elle seule, qui entre dans l'index partiel
    // `auth_users_first_account_unique` : deux inscriptions simultanées la
    // posent toutes les deux, la base n'en garde qu'une.
    expect(data.isFirstAccount).toBe(true);
  });

  it("refuse dès qu'un compte existe", async () => {
    hasAnyUserMock.mockResolvedValue(true);

    await expect(guardSignUp()).rejects.toThrow(SIGN_UP_CLOSED_MESSAGE);
  });

  it('refuse avec une erreur d\'API reconnaissable (403 + code), pas une panne', async () => {
    hasAnyUserMock.mockResolvedValue(true);

    const error = await guardSignUp().catch((caught: unknown) => caught);

    expect(isAPIError(error)).toBe(true);
    expect(error).toMatchObject({
      statusCode: 403,
      body: { code: SIGN_UP_CLOSED_CODE, message: SIGN_UP_CLOSED_MESSAGE },
    });
  });

  it("interroge la base à chaque tentative, jamais un état mémorisé", async () => {
    hasAnyUserMock.mockResolvedValue(false);
    await guardSignUp();
    hasAnyUserMock.mockResolvedValue(true);
    await expect(guardSignUp()).rejects.toThrow(SIGN_UP_CLOSED_MESSAGE);

    expect(hasAnyUserMock).toHaveBeenCalledTimes(2);
  });
});
