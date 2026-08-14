import { describe, expect, it } from 'vitest';

import { parseRaceTimeSeconds } from './form-options';
import { formatRaceTimeDigits, formatRaceTimeInput } from './race-time-input';

/**
 * Le champ chrono se remplit au pavé numérique d'un iPhone, qui n'a pas de
 * deux-points : ces tests décrivent une saisie faite **de chiffres seulement**,
 * frappe après frappe, et ce qu'en fait le masque.
 */

/** Une frappe : le caractère s'ajoute en fin de valeur, curseur en fin de champ. */
function press(value: string, key: string): string {
  return formatRaceTimeInput(value, `${value}${key}`);
}

/** La touche retour, curseur en fin de champ : le dernier caractère disparaît. */
function backspace(value: string): string {
  return formatRaceTimeInput(value, value.slice(0, -1));
}

/** Une suite de frappes depuis un champ vide. */
function typeDigits(keys: string): string {
  return [...keys].reduce(press, '');
}

/** Un collage dans un champ vide : tout arrive d'un coup. */
function paste(pasted: string): string {
  return formatRaceTimeInput('', pasted);
}

describe('formatRaceTimeDigits', () => {
  it('lit les chiffres depuis la droite : secondes, minutes, puis heures', () => {
    expect(formatRaceTimeDigits('')).toBe('');
    expect(formatRaceTimeDigits('4')).toBe('4');
    expect(formatRaceTimeDigits('42')).toBe('42');
    expect(formatRaceTimeDigits('423')).toBe('4:23');
    expect(formatRaceTimeDigits('4230')).toBe('42:30');
    expect(formatRaceTimeDigits('12345')).toBe('1:23:45');
    expect(formatRaceTimeDigits('102345')).toBe('10:23:45');
  });

  it("garde les zéros de tête plutôt que de réécrire une saisie en cours", () => {
    expect(formatRaceTimeDigits('0')).toBe('0');
    expect(formatRaceTimeDigits('0423')).toBe('04:23');
    expect(formatRaceTimeDigits('012345')).toBe('01:23:45');
  });
});

describe('formatRaceTimeInput — la frappe', () => {
  it('place les deux-points seule, chiffre après chiffre', () => {
    expect(typeDigits('4')).toBe('4');
    expect(typeDigits('42')).toBe('42');
    expect(typeDigits('423')).toBe('4:23');
    expect(typeDigits('4230')).toBe('42:30');
    expect(typeDigits('12345')).toBe('1:23:45');
    expect(typeDigits('102345')).toBe('10:23:45');
  });

  it('réorganise la valeur à chaque chiffre ajouté', () => {
    // Le chemin complet d'un semi tapé au pavé numérique : 1 h 52 min 00 s.
    let value = '';
    const steps: string[] = [];
    for (const key of '15200') {
      value = press(value, key);
      steps.push(value);
    }

    expect(steps).toEqual(['1', '15', '1:52', '15:20', '1:52:00']);
  });

  it("ignore ce qui n'est pas un chiffre, deux-points compris", () => {
    // Un clavier matériel peut en produire ; le masque les remet où il faut.
    expect(press('42', ':')).toBe('42');
    expect(press('42', 'a')).toBe('42');
    expect(press('4:23', ' ')).toBe('4:23');
  });
});

describe('formatRaceTimeInput — la suppression', () => {
  it('défait la valeur chiffre à chiffre, sans rien réinsérer', () => {
    expect(backspace('10:23:45')).toBe('1:02:34');
    expect(backspace('42:30')).toBe('4:23');
    expect(backspace('4:23')).toBe('42');
    expect(backspace('42')).toBe('4');
    expect(backspace('4')).toBe('');
  });

  it('efface le chiffre de gauche quand la touche retour mord sur un deux-points', () => {
    // Curseur juste après le séparateur : sans traitement, le masque le
    // réinsérerait et la suppression paraîtrait sans effet.
    expect(formatRaceTimeInput('4:23', '423')).toBe('23');
    expect(formatRaceTimeInput('42:30', '4230')).toBe('4:30');
    // `hh:mm:ss` : le second séparateur emporte le chiffre des minutes qui le
    // précède, et le reste se relit depuis la droite (`1:2:45` → `12:45`).
    expect(formatRaceTimeInput('1:23:45', '1:2345')).toBe('12:45');
  });

  it('laisse vider le champ entièrement', () => {
    expect(formatRaceTimeInput('42:30', '')).toBe('');
    expect(formatRaceTimeInput('1:52:00', '')).toBe('');
  });

  it('accepte une sélection remplacée par une autre saisie', () => {
    // Tout sélectionner puis taper un chiffre : c'est une suppression qui
    // change les chiffres, donc une saisie ordinaire.
    expect(formatRaceTimeInput('42:30', '5')).toBe('5');
  });
});

describe('formatRaceTimeInput — le collage', () => {
  it('reformate une valeur collée qui porte déjà ses deux-points', () => {
    expect(paste('42:30')).toBe('42:30');
    expect(paste('1:52:00')).toBe('1:52:00');
    expect(paste('12:34:56')).toBe('12:34:56');
  });

  it('extrait les chiffres du bruit collé autour', () => {
    expect(paste('  48:30  ')).toBe('48:30');
    expect(paste('48 30')).toBe('48:30');
    expect(paste('1h52m00s')).toBe('1:52:00');
  });

  it('remplace la valeur en place plutôt que de s’y ajouter', () => {
    expect(formatRaceTimeInput('42:30', '48:30')).toBe('48:30');
  });
});

describe('formatRaceTimeInput — la borne des six chiffres', () => {
  it("n'accepte pas un septième chiffre plutôt que d'en faire une valeur absurde", () => {
    expect(press('10:23:45', '6')).toBe('10:23:45');
    expect(typeDigits('1023456')).toBe('10:23:45');
  });

  it('refuse en bloc un collage trop long', () => {
    expect(paste('1234567')).toBe('');
    expect(formatRaceTimeInput('42:30', '123:45:67')).toBe('42:30');
  });
});

describe('formatRaceTimeInput — ce qui reste à la charge du serveur', () => {
  it('produit une valeur que la validation serveur sait relire', () => {
    expect(parseRaceTimeSeconds(typeDigits('4230'))).toBe(2_550);
    expect(parseRaceTimeSeconds(typeDigits('15200'))).toBe(6_720);
    expect(parseRaceTimeSeconds(paste('  48:30  '))).toBe(2_910);
  });

  it("ne corrige pas un chrono impossible : c'est le schéma Zod qui refuse", () => {
    // 70 secondes n'existent pas, mais réécrire la valeur sous les doigts de
    // l'athlète serait pire. La Server Action reste l'autorité.
    expect(typeDigits('4270')).toBe('42:70');
    expect(parseRaceTimeSeconds('42:70')).toBeNull();
  });

  it('laisse intacte une valeur déjà formatée', () => {
    for (const value of ['', '4', '42', '4:23', '42:30', '1:52:00', '10:23:45']) {
      expect(formatRaceTimeInput(value, value)).toBe(value);
    }
  });
});
