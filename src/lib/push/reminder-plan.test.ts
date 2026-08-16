import { describe, expect, it } from 'vitest';

import { FORECAST_READING_HOUR } from '@/lib/weather/forecast-plan';

import {
  isReminderDue,
  REMINDER_HOUR,
  REMINDER_WINDOW_HOURS,
  reminderMarker,
} from './reminder-plan';

/**
 * Le rendez-vous du rappel matinal — l'heure, la fenêtre, et le fuseau.
 *
 * Trois propriétés, et elles ne se déduisent pas les unes des autres :
 *
 * 1. **le rappel arrive après le relevé météo**, sans quoi la moitié des
 *    bannières partirait avec la prévision de la veille ;
 * 2. **il se périme** : passé la fenêtre, plus rien — c'est ce qui distingue ce
 *    module de ses deux aînés (`forecast-plan`, `wellness-plan`), qui, eux,
 *    rattrapent à n'importe quelle heure ;
 * 3. **tout se lit dans le fuseau de l'application**, pas en UTC. Le container
 *    tourne en UTC : un test qui ne franchirait pas un changement d'heure ne
 *    prouverait rien.
 */

/**
 * Un instant local, exprimé en UTC.
 *
 * Europe/Paris est à UTC+2 en août (heure d'été) et à UTC+1 en janvier : les
 * deux décalages sont utilisés ci-dessous, et c'est le but.
 */
const AUGUST_UTC_OFFSET = 2;
const JANUARY_UTC_OFFSET = 1;

function parisInstant(day: string, localHour: number, offset: number): Date {
  // Construit en millisecondes plutôt qu'en chaîne : `localHour - offset` est
  // négatif avant l'aube, et une heure « -2 » n'est pas une date ISO.
  const midnightUtc = new Date(`${day}T00:00:00.000Z`).getTime();
  return new Date(midnightUtc + (localHour - offset) * 3_600_000 + 30 * 60_000);
}

/** Un instant d'été, à l'heure locale voulue. */
function summer(localHour: number, day = '2026-08-16'): Date {
  return parisInstant(day, localHour, AUGUST_UTC_OFFSET);
}

/** Le même, en hiver — l'offset change, la décision ne doit pas. */
function winter(localHour: number, day = '2026-01-15'): Date {
  return parisInstant(day, localHour, JANUARY_UTC_OFFSET);
}

describe('REMINDER_HOUR', () => {
  /*
   * Ce n'est pas un réglage de confort : les prévisions du jour sont écrites par
   * la boucle météo à `FORECAST_READING_HOUR`, et le rappel les lit. Les fixer à
   * la même heure ferait courir les deux services l'un contre l'autre.
   */
  it('tombe après le relevé des prévisions', () => {
    expect(REMINDER_HOUR).toBeGreaterThan(FORECAST_READING_HOUR);
  });

  /** La fenêtre ne doit pas pouvoir déborder sur le lendemain. */
  it('a une fenêtre qui se referme dans la même journée', () => {
    expect(REMINDER_HOUR + REMINDER_WINDOW_HOURS).toBeLessThanOrEqual(24);
  });
});

describe('isReminderDue', () => {
  it('est dû dès l’heure du rappel', () => {
    expect(isReminderDue(summer(REMINDER_HOUR))).toBe(true);
  });

  it('ne l’est pas avant', () => {
    expect(isReminderDue(summer(REMINDER_HOUR - 1))).toBe(false);
    expect(isReminderDue(summer(0))).toBe(false);
  });

  /*
   * Le rattrapage voulu : une application redéployée en fin de matinée notifie
   * encore, parce que la séance n'a pas encore eu lieu.
   */
  it('l’est encore à la dernière heure de la fenêtre', () => {
    expect(isReminderDue(summer(REMINDER_HOUR + REMINDER_WINDOW_HOURS - 1))).toBe(true);
  });

  /*
   * La péremption : prévenir le soir d'une séance non faite est inutile et
   * culpabilisant. La borne haute est **exclue**.
   */
  it('ne l’est plus une fois la fenêtre refermée', () => {
    expect(isReminderDue(summer(REMINDER_HOUR + REMINDER_WINDOW_HOURS))).toBe(false);
    expect(isReminderDue(summer(23))).toBe(false);
  });

  /*
   * En hiver, 7 h locales font 6 h UTC. Une décision prise sur l'heure UTC
   * répondrait « pas encore » à un instant où le rappel est dû — et l'inverse à
   * 6 h locales.
   */
  it('lit l’heure du fuseau de l’application, pas celle du container', () => {
    expect(isReminderDue(winter(REMINDER_HOUR))).toBe(true);
    expect(isReminderDue(winter(REMINDER_HOUR - 1))).toBe(false);
  });
});

describe('reminderMarker', () => {
  it('est la date civile du jour une fois l’heure passée', () => {
    expect(reminderMarker(summer(REMINDER_HOUR))).toBe('2026-08-16');
    expect(reminderMarker(summer(23))).toBe('2026-08-16');
  });

  /*
   * « Dernier passage révolu » : avant l'heure, le rendez-vous courant est
   * encore celui d'hier. Sans conséquence pratique — `isReminderDue` interdit
   * alors tout envoi — mais c'est ce qui empêche un appelant hors fenêtre de
   * brûler le marqueur de la matinée à venir.
   */
  it('est celle de la veille avant l’heure du rappel', () => {
    expect(reminderMarker(summer(REMINDER_HOUR - 1))).toBe('2026-08-15');
    expect(reminderMarker(summer(0))).toBe('2026-08-15');
  });

  /** Deux cycles de la même matinée réclament exactement la même clé. */
  it('ne change pas d’un cycle à l’autre dans la fenêtre', () => {
    expect(reminderMarker(summer(REMINDER_HOUR))).toBe(
      reminderMarker(summer(REMINDER_HOUR + REMINDER_WINDOW_HOURS - 1)),
    );
  });

  it('suit le fuseau de l’application au passage de minuit', () => {
    // 00 h 30 locales le 15 janvier, soit 23 h 30 UTC le 14 : la date civile en
    // UTC serait la veille de celle que l'application affiche.
    expect(reminderMarker(winter(0))).toBe('2026-01-14');
    expect(reminderMarker(winter(REMINDER_HOUR))).toBe('2026-01-15');
  });
});
