import { describe, expect, it } from 'vitest';

import { REMINDER_HOUR, REMINDER_WINDOW_HOURS } from './reminder-plan';
import {
  ACTIVITY_ANALYZED_TTL_S,
  DAILY_SESSION_TTL_S,
  DEFAULT_PUSH_TTL_S,
  SUGGESTION_TTL_S,
  TEST_TTL_S,
  WEB_PUSH_DEFAULT_TTL_S,
} from './ttl';

/**
 * Les durées de vie des notifications.
 *
 * Ce ne sont pas des constantes décoratives : le TTL est la seule pièce qui
 * empêche un service de push de livrer un message des jours plus tard. Trois
 * propriétés, et la première est la seule qui décrive un vrai bug évité.
 */

const ALL_TTLS = {
  test: TEST_TTL_S,
  'daily-session': DAILY_SESSION_TTL_S,
  'activity-analyzed': ACTIVITY_ANALYZED_TTL_S,
  suggestion: SUGGESTION_TTL_S,
  défaut: DEFAULT_PUSH_TTL_S,
};

describe('les durées de vie des notifications', () => {
  it('ne laisse jamais le rappel du matin déborder sur le lendemain matin', () => {
    // Le pire cas : un rappel parti à la dernière minute de la fenêtre d'envoi.
    // S'il survivait jusqu'à l'heure du rappel suivant, un téléphone rallumé le
    // lendemain à 7 h afficherait la séance de la veille — précisément ce que la
    // fenêtre de `reminder-plan` refuse d'envoyer.
    const lastSendHour = REMINDER_HOUR + REMINDER_WINDOW_HOURS;
    const expiryHour = lastSendHour + DAILY_SESSION_TTL_S / 3_600;

    expect(expiryHour).toBeLessThan(24 + REMINDER_HOUR);
  });

  it('raccourcit toujours le défaut de web-push', () => {
    // Sans option, `sendNotification` demande quatre semaines de conservation.
    // Chacune de nos durées existe pour être **plus courte** que ça.
    for (const [name, ttl] of Object.entries(ALL_TTLS)) {
      expect(ttl, name).toBeLessThan(WEB_PUSH_DEFAULT_TTL_S);
    }
  });

  it('classe les catégories de la plus périssable à la plus patiente', () => {
    // Un test ne vaut que maintenant, un rappel vaut sa journée, une analyse
    // reste lisible, une décision attend qu'on la tranche.
    expect(TEST_TTL_S).toBeLessThan(DAILY_SESSION_TTL_S);
    expect(DAILY_SESSION_TTL_S).toBeLessThan(ACTIVITY_ANALYZED_TTL_S);
    expect(ACTIVITY_ANALYZED_TTL_S).toBeLessThan(SUGGESTION_TTL_S);
  });

  it('exprime des secondes entières et positives', () => {
    // Le champ `TTL` de l'en-tête est un entier de secondes : une fraction
    // serait tronquée par le service de push, un zéro voudrait dire « livre
    // maintenant ou jette ».
    for (const [name, ttl] of Object.entries(ALL_TTLS)) {
      expect(Number.isInteger(ttl), name).toBe(true);
      expect(ttl, name).toBeGreaterThan(0);
    }
  });
});
