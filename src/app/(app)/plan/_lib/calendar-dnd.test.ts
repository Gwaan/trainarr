import { describe, expect, it } from 'vitest';

import {
  announceDragCancel,
  announceDragEnd,
  announceDragOver,
  announceDragStart,
  CALENDAR_DRAG_INSTRUCTIONS,
  dayDropId,
  parseDayDropId,
  parseSessionDragId,
  sessionDragId,
} from './calendar-dnd';

describe('identifiants de glisser-déposer', () => {
  it('fait l’aller-retour sur un jour', () => {
    expect(dayDropId('2026-08-12')).toBe('jour:2026-08-12');
    expect(parseDayDropId(dayDropId('2026-08-12'))).toBe('2026-08-12');
  });

  it('fait l’aller-retour sur une séance', () => {
    expect(sessionDragId(42)).toBe('seance:42');
    expect(parseSessionDragId(sessionDragId(42))).toBe(42);
  });

  it('ne confond pas les deux familles', () => {
    expect(parseDayDropId(sessionDragId(42))).toBeNull();
    expect(parseSessionDragId(dayDropId('2026-08-12'))).toBeNull();
  });

  it('refuse ce qui n’est pas un identifiant du calendrier', () => {
    for (const value of [undefined, null, 7, '', 'jour:', 'jour:2026-8-12', 'seance:', 'seance:x']) {
      expect(parseDayDropId(value)).toBeNull();
      expect(parseSessionDragId(value)).toBeNull();
    }
  });
});

describe('annonces', () => {
  it('nomme les touches dans les instructions', () => {
    expect(CALENDAR_DRAG_INSTRUCTIONS).toContain('flèches');
    expect(CALENDAR_DRAG_INSTRUCTIONS).toContain('Échap');
  });

  it('annonce la prise', () => {
    expect(announceDragStart('Seuil, 6 × 800 m')).toBe(
      'Séance Seuil, 6 × 800 m soulevée. Choisis un jour avec les flèches, puis dépose avec Espace.',
    );
  });

  it('dit au survol si le dépôt est possible', () => {
    expect(announceDragOver('Seuil', 'mercredi 12 août', true)).toBe(
      'Séance Seuil sur mercredi 12 août. Dépôt possible.',
    );
    expect(announceDragOver('Seuil', 'mercredi 12 août', false)).toBe(
      'Séance Seuil sur mercredi 12 août. Dépôt impossible ce jour-là.',
    );
  });

  it('dit quand on est sorti du calendrier', () => {
    expect(announceDragOver('Seuil', null, false)).toBe('Séance Seuil en dehors du calendrier.');
  });

  it('distingue un dépôt d’un retour à la case départ', () => {
    expect(announceDragEnd('Seuil', 'jeudi 13 août', null)).toBe(
      'Séance Seuil déposée sur jeudi 13 août.',
    );
    expect(announceDragEnd('Seuil', null, null)).toBe('Séance Seuil reposée à sa place.');
  });

  it('n’annonce jamais réussi un dépôt que le jour refusait', () => {
    // Le survol disait « Dépôt impossible ce jour-là » : le relâchement ne peut
    // pas dire l'inverse, c'est la seule phrase que le clavier entend.
    expect(
      announceDragEnd(
        'Seuil',
        'jeudi 13 août',
        'Ton plan court du 27 juillet au 6 septembre : cette date en sort.',
      ),
    ).toBe(
      'Séance Seuil non déposée sur jeudi 13 août. Ton plan court du 27 juillet au 6 septembre : cette date en sort.',
    );
  });

  it('garde le retour à la case départ même quand un motif traîne', () => {
    // Relâchée hors du calendrier : il n'y a pas de jour, donc pas de refus à
    // motiver — la séance n'a simplement pas bougé.
    expect(announceDragEnd('Seuil', null, 'Cette séance est déjà planifiée ce jour-là.')).toBe(
      'Séance Seuil reposée à sa place.',
    );
  });

  it('annonce l’abandon', () => {
    expect(announceDragCancel('Seuil')).toBe(
      'Déplacement annulé : la séance Seuil reste à sa place.',
    );
  });
});
