import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAPIError } from 'better-auth/api';

import {
  SIGN_UP_CLOSED_CODE,
  SIGN_UP_CLOSED_MESSAGE,
  guardSignUp,
} from './sign-up-guard';
import { withInvitationClaim } from './invitation-claim';
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

/**
 * L'invitation est la seconde porte — et il faut vérifier autant qu'elle
 * s'ouvre pour qui a dépensé un jeton, qu'elle reste close pour tout le reste.
 */
describe('guardSignUp, sous invitation', () => {
  it("laisse passer la création alors que la porte d'amorçage est fermée", async () => {
    hasAnyUserMock.mockResolvedValue(true);

    await expect(
      withInvitationClaim(42, () => guardSignUp()),
    ).resolves.toEqual({ data: { isFirstAccount: null } });
  });

  it("ne marque pas un compte invité comme compte d'amorçage", async () => {
    hasAnyUserMock.mockResolvedValue(true);

    const { data } = await withInvitationClaim(42, () => guardSignUp());

    // La marque entre dans l'index partiel unique : la poser ici ferait échouer
    // toutes les invitations sauf la première.
    expect(data.isFirstAccount).toBeNull();
  });

  it("n'a même pas besoin d'interroger la base : l'invitation tranche seule", async () => {
    hasAnyUserMock.mockResolvedValue(true);

    await withInvitationClaim(42, () => guardSignUp());

    expect(hasAnyUserMock).not.toHaveBeenCalled();
  });

  it('ne couvre qu\'une seule création — la seconde retombe sur le refus', async () => {
    hasAnyUserMock.mockResolvedValue(true);

    const outcome = await withInvitationClaim(42, async () => {
      await guardSignUp();
      return guardSignUp().catch((error: unknown) => error);
    });

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ body: { code: SIGN_UP_CLOSED_CODE } });
  });

  /**
   * Le contournement qu'un drapeau global aurait ouvert : marteler
   * `/api/auth/sign-up/email` pendant qu'une invitation légitime s'exécute. La
   * requête concurrente n'est pas dans la portée de la marque — elle est
   * refusée, et l'invitation aboutit quand même.
   */
  it("refuse une inscription concurrente lancée pendant qu'une invitation s'exécute", async () => {
    hasAnyUserMock.mockResolvedValue(true);

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const invited = withInvitationClaim(42, async () => {
      await gate;
      return guardSignUp();
    });
    const intruder = guardSignUp();

    await expect(intruder).rejects.toThrow(SIGN_UP_CLOSED_MESSAGE);
    openGate();
    await expect(invited).resolves.toEqual({ data: { isFirstAccount: null } });
  });
});
