import { describe, expect, it, vi } from 'vitest';

// `server-only` lève hors contexte serveur React : neutralisé pour les tests.
vi.mock('server-only', () => ({}));

import { parseEnv } from './env';

const VALID_DATABASE_URL = 'postgres://trainarr:secret@localhost:5432/trainarr';

describe('parseEnv — cas nominal', () => {
  it('accepte une configuration minimale et applique les valeurs par défaut', () => {
    const env = parseEnv({ DATABASE_URL: VALID_DATABASE_URL });

    expect(env.DATABASE_URL).toBe(VALID_DATABASE_URL);
    expect(env.APP_BASE_URL).toBeUndefined();
    expect(env.AI_PROVIDER).toBe('llamacpp');
    expect(env.AI_BASE_URL).toBeUndefined();
    expect(env.AI_MODEL).toBeUndefined();
    expect(env.AI_API_KEY).toBeUndefined();
    expect(env.WEBDAV_USERNAME).toBeUndefined();
    expect(env.WEBDAV_PASSWORD).toBeUndefined();
    // Sans identifiant d'athlète ni clé, le poller intervals.icu reste inactif.
    expect(env.INTERVALS_ATHLETE_ID).toBeUndefined();
    expect(env.INTERVALS_API_KEY).toBeUndefined();
    expect(env.INTERVALS_POLL_INTERVAL_S).toBe(300);
    expect(env.INTERVALS_LOOKBACK_DAYS).toBe(30);
    // Seule variable à défaut hors AI_PROVIDER : la boîte de dépôt FIT.
    expect(env.FIT_INBOX_DIR).toBe('/data/fit-inbox');
  });

  it("valide le format de l'identifiant d'athlète intervals.icu", () => {
    expect(
      parseEnv({ DATABASE_URL: VALID_DATABASE_URL, INTERVALS_ATHLETE_ID: 'i123456' })
        .INTERVALS_ATHLETE_ID,
    ).toBe('i123456');

    // Le préfixe « i » fait partie de l'identifiant tel que l'API l'attend.
    expect(() =>
      parseEnv({ DATABASE_URL: VALID_DATABASE_URL, INTERVALS_ATHLETE_ID: '123456' }),
    ).toThrow(/INTERVALS_ATHLETE_ID/);
  });

  it('accepte une configuration complète', () => {
    const env = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      AI_PROVIDER: 'anthropic',
      AI_BASE_URL: 'https://api.anthropic.com',
      AI_MODEL: 'claude-opus-5',
      AI_API_KEY: 'cle-de-test',
      APP_BASE_URL: 'https://exemple.test',
      FIT_INBOX_DIR: '/tmp/fit',
      WEBDAV_USERNAME: 'gwen',
      WEBDAV_PASSWORD: 'mot-de-passe-de-test',
    });

    expect(env.AI_PROVIDER).toBe('anthropic');
    expect(env.AI_BASE_URL).toBe('https://api.anthropic.com');
    expect(env.APP_BASE_URL).toBe('https://exemple.test');
    expect(env.FIT_INBOX_DIR).toBe('/tmp/fit');
    expect(env.WEBDAV_USERNAME).toBe('gwen');
  });

  it('traite une variable définie mais vide comme absente', () => {
    const env = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      AI_BASE_URL: '',
      AI_MODEL: '   ',
    });

    expect(env.AI_BASE_URL).toBeUndefined();
    expect(env.AI_MODEL).toBeUndefined();
  });

  it("ne recopie aucune variable d'environnement hors schéma", () => {
    const env = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      GITHUB_PAT: 'ne-doit-pas-fuiter',
    });

    expect(Object.keys(env)).not.toContain('GITHUB_PAT');
    // La variable fournie mise à part, il ne reste que les clés à valeur par défaut.
    expect(Object.keys(env).sort()).toEqual([
      'AI_PROVIDER',
      'DATABASE_URL',
      'FIT_INBOX_DIR',
      'INTERVALS_LOOKBACK_DAYS',
      'INTERVALS_POLL_INTERVAL_S',
    ]);
  });

  it('retourne un objet figé', () => {
    const env = parseEnv({ DATABASE_URL: VALID_DATABASE_URL });

    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('parseEnv — erreurs', () => {
  it('échoue explicitement quand DATABASE_URL est absente', () => {
    expect(() => parseEnv({})).toThrowError(/DATABASE_URL/);
  });

  it('échoue quand DATABASE_URL est vide', () => {
    expect(() => parseEnv({ DATABASE_URL: '' })).toThrowError(/DATABASE_URL/);
  });

  it("échoue quand DATABASE_URL n'est pas une URL", () => {
    expect(() => parseEnv({ DATABASE_URL: 'pas-une-url' })).toThrowError(/DATABASE_URL/);
  });

  it('échoue quand AI_PROVIDER est inconnu', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: VALID_DATABASE_URL, AI_PROVIDER: 'gemini' }),
    ).toThrowError(/AI_PROVIDER/);
  });

  it('liste toutes les variables en défaut dans le message', () => {
    let message = '';
    try {
      parseEnv({ AI_PROVIDER: 'gemini', AI_BASE_URL: 'pas-une-url' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('AI_PROVIDER');
    expect(message).toContain('AI_BASE_URL');
    expect(message).toContain('.env.local');
  });
});

describe('env', () => {
  it('est résolu depuis process.env au premier accès, et en lecture seule', async () => {
    vi.stubEnv('DATABASE_URL', VALID_DATABASE_URL);
    vi.stubEnv('AI_PROVIDER', 'openai');
    vi.resetModules();

    try {
      const { env } = await import('./env');
      expect(env.DATABASE_URL).toBe(VALID_DATABASE_URL);
      expect(env.AI_PROVIDER).toBe('openai');
      expect(() => {
        (env as unknown as Record<string, string>).DATABASE_URL = 'postgres://autre/db';
      }).toThrow(TypeError);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("ne valide pas à l'import — le build doit passer sans variables", async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();

    try {
      // L'import seul ne doit pas lever : `next build` importe les modules
      // applicatifs sans disposer des variables runtime.
      const mod = await import('./env');
      expect(mod.env).toBeDefined();
      // ...mais le premier accès à une variable lève bien.
      expect(() => mod.env.DATABASE_URL).toThrow(/DATABASE_URL/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
