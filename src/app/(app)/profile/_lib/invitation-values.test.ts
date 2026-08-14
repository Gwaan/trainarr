import { describe, expect, it } from 'vitest';

import {
  NO_INVITATIONS_SETTINGS,
  formatInvitationDeadline,
  toInvitationRows,
} from './invitation-values';

describe('formatInvitationDeadline', () => {
  it("rend l'échéance dans le fuseau de l'athlète, pas en UTC", () => {
    // 18:42 UTC un 14 août = 20:42 à Paris (heure d'été).
    expect(formatInvitationDeadline(new Date('2026-08-14T18:42:00Z'))).toBe(
      '14 août 2026 à 20:42',
    );
  });

  it('bascule avec l\'heure d\'hiver', () => {
    expect(formatInvitationDeadline(new Date('2026-12-14T18:42:00Z'))).toBe(
      '14 décembre 2026 à 19:42',
    );
  });
});

describe('toInvitationRows', () => {
  it('ne laisse passer que la poignée et l\'échéance, déjà formatée', () => {
    expect(
      toInvitationRows([{ id: 3, expiresAt: new Date('2026-08-14T18:42:00Z') }]),
    ).toEqual([{ id: 3, expiresLabel: '14 août 2026 à 20:42' }]);
  });

  it('rend une liste vide telle quelle', () => {
    expect(toInvitationRows([])).toEqual([]);
  });
});

describe('NO_INVITATIONS_SETTINGS', () => {
  it("ne porte aucune donnée d'invitation — un compte invité n'en reçoit rien", () => {
    expect(NO_INVITATIONS_SETTINGS).toEqual({ canInvite: false });
  });
});
