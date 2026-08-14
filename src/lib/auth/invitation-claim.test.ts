import { describe, expect, it, vi } from 'vitest';

import { takeInvitationClaim, withInvitationClaim } from './invitation-claim';

vi.mock('server-only', () => ({}));

/** Un verrou manuel, pour tenir une portée ouverte pendant qu'on regarde ailleurs. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('withInvitationClaim', () => {
  it('rend la marque à ce qui s\'exécute dedans', async () => {
    await expect(
      withInvitationClaim(7, async () => takeInvitationClaim()),
    ).resolves.toBe(7);
  });

  it('ne laisse aucune marque derrière elle', async () => {
    await withInvitationClaim(7, async () => takeInvitationClaim());

    expect(takeInvitationClaim()).toBeNull();
  });

  it('rend ce que rend son contenu, et laisse remonter ses erreurs', async () => {
    const failure = new Error('création refusée');

    await expect(
      withInvitationClaim(7, () => Promise.reject(failure)),
    ).rejects.toThrow(failure);
    expect(takeInvitationClaim()).toBeNull();
  });
});

describe('takeInvitationClaim', () => {
  it('ne rend rien hors de toute portée — le cas de toute requête entrante', () => {
    expect(takeInvitationClaim()).toBeNull();
  });

  it('ne sert qu\'une fois : une seconde inscription sous la même invitation est refusée', async () => {
    const taken = await withInvitationClaim(7, async () => [
      takeInvitationClaim(),
      takeInvitationClaim(),
    ]);

    expect(taken).toEqual([7, null]);
  });

  /**
   * Le test qui justifie l'`AsyncLocalStorage` plutôt qu'un drapeau de module :
   * une inscription lancée **pendant** qu'une invitation s'exécute ne doit rien
   * voir. Avec un booléen global, elle verrait la porte ouverte.
   */
  it("reste invisible d'une exécution concurrente du même processus", async () => {
    const held = gate();

    const invited = withInvitationClaim(42, async () => {
      await held.wait;
      return takeInvitationClaim();
    });

    // Démarrée hors de la portée, comme le serait une autre requête HTTP servie
    // par le même processus au même instant.
    const intruder = (async () => takeInvitationClaim())();

    await expect(intruder).resolves.toBeNull();
    held.open();
    await expect(invited).resolves.toBe(42);
  });

  it('garde deux invitations simultanées séparées', async () => {
    const [first, second] = await Promise.all([
      withInvitationClaim(1, async () => {
        await Promise.resolve();
        return takeInvitationClaim();
      }),
      withInvitationClaim(2, async () => takeInvitationClaim()),
    ]);

    expect([first, second]).toEqual([1, 2]);
  });
});
