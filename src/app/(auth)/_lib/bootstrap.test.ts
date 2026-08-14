import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isBootstrapOpen } from './bootstrap';
import { hasAnyUser } from '@/data/users';

vi.mock('server-only', () => ({}));
vi.mock('@/data/users', () => ({ hasAnyUser: vi.fn() }));

const hasAnyUserMock = vi.mocked(hasAnyUser);

beforeEach(() => {
  hasAnyUserMock.mockReset();
  vi.restoreAllMocks();
});

describe('isBootstrapOpen', () => {
  it("est ouverte tant qu'aucun compte n'existe", async () => {
    hasAnyUserMock.mockResolvedValue(false);

    await expect(isBootstrapOpen()).resolves.toBe(true);
  });

  it('se referme dès le premier compte créé', async () => {
    hasAnyUserMock.mockResolvedValue(true);

    await expect(isBootstrapOpen()).resolves.toBe(false);
  });

  it('se referme aussi quand la base est injoignable, et le journalise', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    hasAnyUserMock.mockRejectedValue(new Error('base injoignable'));

    // Dans le doute, aucune porte d'inscription ne s'affiche : une panne de
    // lecture ne doit jamais ressembler à une installation neuve.
    await expect(isBootstrapOpen()).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
