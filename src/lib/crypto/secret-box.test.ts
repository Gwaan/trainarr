import { describe, expect, it } from 'vitest';

import {
  deriveSecretKey,
  openSecret,
  sealSecret,
  SecretDecryptionError,
  SecretKeyUnavailableError,
} from './secret-box';

/** Deux secrets d'installation distincts, de longueur plausible. */
const SECRET = 'x'.repeat(44);
const OTHER_SECRET = 'y'.repeat(44);

const KEY = deriveSecretKey(SECRET);
const OTHER_KEY = deriveSecretKey(OTHER_SECRET);

/** Une clé API intervals.icu a cette allure. */
const API_KEY = 'abcdef0123456789ghijkl';

/** Récupère l'erreur typée d'une ouverture qu'on attend refusée. */
function rejectionOf(envelope: string, key: Buffer = KEY): SecretDecryptionError {
  try {
    openSecret(envelope, key);
  } catch (error) {
    if (error instanceof SecretDecryptionError) return error;
    throw error;
  }
  throw new Error('enveloppe acceptée alors quelle devait être refusée');
}

/** Remplace un octet du contenu chiffré, sans toucher au format de l'enveloppe. */
function tamperWith(envelope: string, byteIndex: number): string {
  const [version, payload] = envelope.split(':');
  const bytes = Buffer.from(payload ?? '', 'base64');
  bytes[byteIndex] ^= 0xff;
  return `${version}:${bytes.toString('base64')}`;
}

describe('deriveSecretKey', () => {
  it('rend une clé AES-256 (32 octets)', () => {
    expect(KEY).toHaveLength(32);
  });

  it('est déterministe : même secret, même clé', () => {
    expect(deriveSecretKey(SECRET).equals(KEY)).toBe(true);
  });

  it('sépare les secrets : deux secrets donnent deux clés', () => {
    expect(OTHER_KEY.equals(KEY)).toBe(false);
  });

  it("ne rend jamais le secret tel quel — la clé n'en est pas la recopie", () => {
    expect(KEY.toString('utf8')).not.toBe(SECRET);
    expect(KEY.toString('base64')).not.toContain(SECRET);
  });

  it.each([
    ['vide', ''],
    ['réduit à des espaces', '   '],
  ])('refuse un secret %s plutôt que de chiffrer avec n’importe quoi', (_label, secret) => {
    expect(() => deriveSecretKey(secret)).toThrow(SecretKeyUnavailableError);
  });
});

describe('sealSecret / openSecret', () => {
  it('fait l’aller-retour', () => {
    expect(openSecret(sealSecret(API_KEY, KEY), KEY)).toBe(API_KEY);
  });

  it('supporte les caractères non ASCII et une valeur vide', () => {
    for (const value of ['clé-à-préserver — ½', '']) {
      expect(openSecret(sealSecret(value, KEY), KEY)).toBe(value);
    }
  });

  it('produit une enveloppe versionnée, en une seule chaîne stockable', () => {
    const envelope = sealSecret(API_KEY, KEY);

    expect(envelope.startsWith('v1:')).toBe(true);
    expect(envelope).not.toContain('\n');
    // IV (12) + tag (16) + chiffré (22) = 50 octets.
    expect(Buffer.from(envelope.slice(3), 'base64')).toHaveLength(12 + 16 + API_KEY.length);
  });

  it('ne laisse jamais transparaître le clair', () => {
    const envelope = sealSecret(API_KEY, KEY);

    expect(envelope).not.toContain(API_KEY);
    expect(Buffer.from(envelope.slice(3), 'base64').toString('utf8')).not.toContain(API_KEY);
  });

  it('tire un vecteur d’initialisation neuf à chaque appel', () => {
    const first = sealSecret(API_KEY, KEY);
    const second = sealSecret(API_KEY, KEY);

    expect(first).not.toBe(second);
    expect(openSecret(second, KEY)).toBe(API_KEY);
  });
});

describe('openSecret — refus', () => {
  it('refuse une enveloppe chiffrée avec un autre secret (BETTER_AUTH_SECRET changé)', () => {
    expect(rejectionOf(sealSecret(API_KEY, KEY), OTHER_KEY).reason).toBe('authentication');
  });

  it.each([
    ['le contenu chiffré', 12 + 16],
    ['le marqueur d’authenticité', 12],
    ['le vecteur d’initialisation', 0],
  ])('refuse une enveloppe dont %s a été altéré', (_label, byteIndex) => {
    const tampered = tamperWith(sealSecret(API_KEY, KEY), byteIndex);

    expect(rejectionOf(tampered).reason).toBe('authentication');
  });

  it('refuse une enveloppe réétiquetée dans une autre version', () => {
    const envelope = sealSecret(API_KEY, KEY);

    expect(rejectionOf(`v2${envelope.slice(2)}`).reason).toBe('malformed');
  });

  it.each([
    ['une chaîne vide', ''],
    ['une valeur sans préfixe de version', 'ZGVzIG9jdGV0cw=='],
    ['du base64 illisible', 'v1:!!!!'],
    ['une enveloppe trop courte pour porter un IV et un tag', `v1:${Buffer.alloc(27).toString('base64')}`],
  ])('refuse %s comme mal formée', (_label, envelope) => {
    expect(rejectionOf(envelope).reason).toBe('malformed');
  });

  it('ne cite ni la clé, ni le contenu chiffré dans ses messages', () => {
    const envelope = sealSecret(API_KEY, KEY);
    const messages = [rejectionOf(envelope, OTHER_KEY).message, rejectionOf('bruit').message];

    for (const message of messages) {
      expect(message).not.toContain(envelope);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(KEY.toString('base64'));
    }
  });
});
