import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  generateInvitationToken,
  invitationTokenFingerprint,
  invitationTokenSchema,
} from './invitation-token';

vi.mock('server-only', () => ({}));

describe('generateInvitationToken', () => {
  it('tire un jeton sûr en segment d\'URL, sans caractère à échapper', () => {
    expect(generateInvitationToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('ne rend jamais deux fois la même valeur', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateInvitationToken));

    // 256 bits de tirage : une répétition sur deux cents signalerait une source
    // d'aléa cassée, pas un coup de malchance.
    expect(tokens.size).toBe(200);
  });

  it('est accepté par le schéma qui garde la route et le formulaire', () => {
    expect(invitationTokenSchema.safeParse(generateInvitationToken()).success).toBe(true);
  });
});

describe('invitationTokenFingerprint', () => {
  it("est l'empreinte SHA-256 du jeton, en hexadécimal", () => {
    const token = generateInvitationToken();

    expect(invitationTokenFingerprint(token)).toBe(
      createHash('sha256').update(token, 'utf8').digest('hex'),
    );
  });

  it('ne laisse pas filer le jeton dans son résultat', () => {
    const token = generateInvitationToken();

    expect(invitationTokenFingerprint(token)).not.toContain(token);
  });

  it('est déterministe — c\'est ce qui permet la recherche par égalité', () => {
    const token = generateInvitationToken();

    expect(invitationTokenFingerprint(token)).toBe(invitationTokenFingerprint(token));
  });

  it('sépare deux jetons voisins', () => {
    expect(invitationTokenFingerprint('a')).not.toBe(invitationTokenFingerprint('b'));
  });
});

describe('invitationTokenSchema', () => {
  it('refuse ce qui n\'a pas la forme d\'un jeton', () => {
    for (const value of [
      '',
      'court',
      `${'a'.repeat(42)}`,
      `${'a'.repeat(44)}`,
      // Caractères hors base64url : chemin traversant, remplissage, espace.
      `${'a'.repeat(42)}/`,
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)} `,
    ]) {
      expect(invitationTokenSchema.safeParse(value).success).toBe(false);
    }
  });

  it('ne recopie jamais la valeur refusée dans son message', () => {
    const parsed = invitationTokenSchema.safeParse('../../etc/passwd');

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).not.toContain('etc/passwd');
  });
});
