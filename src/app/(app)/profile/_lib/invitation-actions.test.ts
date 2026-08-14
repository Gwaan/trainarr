import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvitationAdminRequiredError } from '@/data/invitations';

import { createInvitationAction, revokeInvitationAction } from './invitation-actions';
import { REVOKE_FORM_IDLE } from './invitation-state';

vi.mock('server-only', () => ({}));

/**
 * Les actions sont minces : seuls la traduction formulaire → DAL, le rendu des
 * refus et l'invalidation du cache leur appartiennent. Le DAL est simulé, mais
 * ses erreurs typées restent les vraies — ce sont elles qu'elles reconnaissent.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    createInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    revalidatePath: vi.fn(),
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock('@/data/invitations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/invitations')>()),
  createInvitation: mocks.createInvitation,
  revokeInvitation: mocks.revokeInvitation,
}));

const TOKEN = 'a'.repeat(43);
const EXPIRES_AT = new Date('2026-08-14T18:42:00Z');

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createInvitationAction', () => {
  it('rend le chemin du lien et son échéance, et rafraîchit la liste', async () => {
    mocks.createInvitation.mockResolvedValue({ token: TOKEN, expiresAt: EXPIRES_AT });

    const state = await createInvitationAction();

    expect(state).toEqual({
      status: 'created',
      path: `/invitation/${TOKEN}`,
      expiresLabel: '14 août 2026 à 20:42',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it("rend un chemin, pas une URL absolue — le serveur ne devine pas son domaine", async () => {
    mocks.createInvitation.mockResolvedValue({ token: TOKEN, expiresAt: EXPIRES_AT });

    const state = await createInvitationAction();

    expect(state.status === 'created' && state.path.startsWith('/')).toBe(true);
    expect(JSON.stringify(state)).not.toContain('http');
  });

  it("refuse à qui n'est pas le premier compte, avec un message qui le dit", async () => {
    mocks.createInvitation.mockRejectedValue(new InvitationAdminRequiredError());

    const state = await createInvitationAction();

    expect(state).toEqual({
      status: 'error',
      message: "Seul le premier compte de l'installation peut gérer les invitations.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('reste générique sur une panne, sans en laisser filer la trace', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.createInvitation.mockRejectedValue(new Error('base injoignable'));

    const state = await createInvitationAction();

    expect(state).toEqual({ status: 'error', message: "Le lien n'a pas pu être créé. Réessaie." });
    expect(JSON.stringify(state)).not.toContain('base injoignable');
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it('ne journalise jamais le jeton émis', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.createInvitation.mockRejectedValue(new Error('panne'));

    await createInvitationAction();

    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TOKEN);
  });
});

describe('revokeInvitationAction', () => {
  it('révoque le lien désigné puis rafraîchit la liste', async () => {
    mocks.revokeInvitation.mockResolvedValue(true);

    const state = await revokeInvitationAction(REVOKE_FORM_IDLE, form({ invitationId: '7' }));

    expect(mocks.revokeInvitation).toHaveBeenCalledWith(7);
    expect(state).toEqual({ status: 'idle' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it("refuse un identifiant qui n'en est pas un, sans toucher au DAL", async () => {
    for (const invitationId of ['', 'sept', '-1', '1.5']) {
      const state = await revokeInvitationAction(REVOKE_FORM_IDLE, form({ invitationId }));

      expect(state.status).toBe('error');
    }

    expect(mocks.revokeInvitation).not.toHaveBeenCalled();
  });

  it("oppose le même message à un lien inexistant, déjà servi ou déjà révoqué", async () => {
    mocks.revokeInvitation.mockResolvedValue(false);

    const state = await revokeInvitationAction(REVOKE_FORM_IDLE, form({ invitationId: '7' }));

    expect(state).toEqual({ status: 'error', message: "Ce lien n'est plus en cours." });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuse à qui n'est pas le premier compte", async () => {
    mocks.revokeInvitation.mockRejectedValue(new InvitationAdminRequiredError());

    const state = await revokeInvitationAction(REVOKE_FORM_IDLE, form({ invitationId: '7' }));

    expect(state.message).toBe(
      "Seul le premier compte de l'installation peut gérer les invitations.",
    );
  });

  it('reste générique sur une panne', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.revokeInvitation.mockRejectedValue(new Error('base injoignable'));

    const state = await revokeInvitationAction(REVOKE_FORM_IDLE, form({ invitationId: '7' }));

    expect(state).toEqual({
      status: 'error',
      message: "Le lien n'a pas pu être révoqué. Réessaie.",
    });
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
