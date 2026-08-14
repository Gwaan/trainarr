import { describe, expect, it } from 'vitest';

import {
  describeWeatherCode,
  KNOWN_WEATHER_CODES,
  WEATHER_ICON_NAMES,
  type WeatherIconName,
} from './wmo';

/**
 * La table des codes WMO.
 *
 * Ce qui est éprouvé ici n'est pas la traduction d'un code en particulier, mais
 * la **propriété** qui fait tenir l'écran : rien de ce qui n'a pas été lu ne
 * doit ressortir en soleil.
 */
describe('describeWeatherCode', () => {
  it('couvre les vingt-huit codes émis par Open-Meteo', () => {
    // La liste documentée, recopiée depuis <https://open-meteo.com/en/docs>.
    expect(KNOWN_WEATHER_CODES).toEqual([
      0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82,
      85, 86, 95, 96, 99,
    ]);
  });

  it('donne à chaque code connu un libellé français et une icône du jeu', () => {
    for (const code of KNOWN_WEATHER_CODES) {
      const condition = describeWeatherCode(code);
      expect(condition.label).not.toBe('');
      expect(condition.label.startsWith('Temps inconnu')).toBe(false);
      expect(WEATHER_ICON_NAMES).toContain(condition.icon);
      expect(condition.icon).not.toBe('unknown');
    }
  });

  it('ne donne jamais deux fois le même libellé', () => {
    const labels = KNOWN_WEATHER_CODES.map((code) => describeWeatherCode(code).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('nomme le temps de quelques codes de référence', () => {
    expect(describeWeatherCode(0)).toEqual({ label: 'Ciel dégagé', icon: 'clear' });
    expect(describeWeatherCode(61)).toEqual({ label: 'Pluie faible', icon: 'rain' });
    expect(describeWeatherCode(95)).toEqual({ label: 'Orage', icon: 'thunderstorm' });
  });

  it('rend « inconnu » — et surtout pas du soleil — pour une mesure absente', () => {
    expect(describeWeatherCode(null)).toEqual({ label: 'Temps inconnu', icon: 'unknown' });
  });

  it('cite le code hors table, pour qu’une API enrichie se voie', () => {
    const condition = describeWeatherCode(42);
    expect(condition.icon).toBe('unknown');
    expect(condition.label).toContain('42');
  });

  it('ne prête pas un temps à une valeur qui n’en est pas une', () => {
    for (const code of [Number.NaN, Number.POSITIVE_INFINITY, 3.5]) {
      expect(describeWeatherCode(code).icon).toBe('unknown');
    }
  });

  it('n’a pas d’icône déclarée que personne n’utilise', () => {
    const used = new Set<WeatherIconName>(
      KNOWN_WEATHER_CODES.map((code) => describeWeatherCode(code).icon),
    );
    used.add('unknown');
    expect([...WEATHER_ICON_NAMES].sort()).toEqual([...used].sort());
  });
});
