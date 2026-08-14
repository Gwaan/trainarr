import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAuthConfig, type AuthConfig } from '@/lib/auth/config';

import { decryptStoredSecret, encryptStoredSecret } from './app-secret';
import { SecretDecryptionError, SecretKeyUnavailableError } from './secret-box';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

vi.mock('@/lib/auth/config', () => ({ resolveAuthConfig: vi.fn() }));

const resolveAuthConfigMock = vi.mocked(resolveAuthConfig);

const SECRET = 'x'.repeat(44);
const API_KEY = 'abcdef0123456789ghijkl';

const NO_SECRET: AuthConfig = { status: 'disabled', reason: 'missing-secret' };
const WEAK_SECRET: AuthConfig = { status: 'disabled', reason: 'weak-secret' };

function withSecret(secret: string): void {
  resolveAuthConfigMock.mockReturnValue({ status: 'ready', secret });
}

/** Récupère l'erreur d'un appel qu'on attend refusé. */
function rejectionOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('appel accepté alors qu’il devait être refusé');
}

beforeEach(() => {
  resolveAuthConfigMock.mockReset();
  withSecret(SECRET);
});

describe('encryptStoredSecret / decryptStoredSecret', () => {
  it('fait l’aller-retour avec le secret de l’installation', () => {
    expect(decryptStoredSecret(encryptStoredSecret(API_KEY))).toBe(API_KEY);
  });

  it('ne stocke jamais la valeur en clair', () => {
    expect(encryptStoredSecret(API_KEY)).not.toContain(API_KEY);
  });
});

describe("quand l'installation n'a pas de secret exploitable", () => {
  it.each([
    ['aucun secret', NO_SECRET],
    ['un secret trop court', WEAK_SECRET],
  ])('refuse de chiffrer avec %s', (_label, config) => {
    resolveAuthConfigMock.mockReturnValue(config);

    expect(rejectionOf(() => encryptStoredSecret(API_KEY))).toBeInstanceOf(
      SecretKeyUnavailableError,
    );
  });

  it('refuse de déchiffrer, plutôt que de rendre une valeur douteuse', () => {
    const envelope = encryptStoredSecret(API_KEY);
    resolveAuthConfigMock.mockReturnValue(NO_SECRET);

    expect(rejectionOf(() => decryptStoredSecret(envelope))).toBeInstanceOf(
      SecretKeyUnavailableError,
    );
  });

  it('nomme la variable à renseigner sans jamais citer de valeur', () => {
    resolveAuthConfigMock.mockReturnValue(NO_SECRET);

    const error = rejectionOf(() => encryptStoredSecret(API_KEY));

    expect(error).toBeInstanceOf(SecretKeyUnavailableError);
    if (error instanceof SecretKeyUnavailableError) {
      expect(error.message).toContain('BETTER_AUTH_SECRET');
      expect(error.message).not.toContain(SECRET);
    }
  });
});

describe('quand le secret de l’installation a changé', () => {
  it('rend une erreur typée « illisible », jamais une panne ni un silence', () => {
    const envelope = encryptStoredSecret(API_KEY);
    withSecret('y'.repeat(44));

    const error = rejectionOf(() => decryptStoredSecret(envelope));

    expect(error).toBeInstanceOf(SecretDecryptionError);
    if (error instanceof SecretDecryptionError) {
      expect(error.reason).toBe('authentication');
    }
  });
});
