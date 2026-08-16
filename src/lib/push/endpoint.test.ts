import { describe, expect, it } from 'vitest';

import { isKnownPushEndpoint, UNKNOWN_PUSH_HOST_MESSAGE } from './endpoint';

/**
 * L'allowlist des services de push.
 *
 * Deux propriétés à tenir en même temps, et c'est tout l'exercice :
 *
 * 1. **les vraies endpoints passent** — un navigateur légitime ne doit jamais se
 *    voir refuser son abonnement ;
 * 2. **rien d'autre ne passe**, et surtout pas une adresse interne au réseau du
 *    container : c'est le serveur qui postera dessus, à chaque notification.
 */

describe('isKnownPushEndpoint', () => {
  it('accepte les endpoints des quatre services de push', () => {
    const real = [
      'https://web.push.apple.com/QOsX8k1p2Q3wD4',
      'https://fcm.googleapis.com/fcm/send/dGhpcy1lc3QtdW4tZmF1eA',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
      'https://par02p.notify.windows.com/w/?token=abc',
    ];

    for (const endpoint of real) {
      expect(isKnownPushEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it('accepte un sous-domaine des services qui en répartissent', () => {
    // Apple, Mozilla et Microsoft servent depuis des sous-domaines qui varient
    // (région, génération) : les figer casserait l'abonnement sans prévenir.
    expect(isKnownPushEndpoint('https://autre.push.apple.com/x')).toBe(true);
    expect(isKnownPushEndpoint('https://autre.push.services.mozilla.com/x')).toBe(true);
  });

  it('refuse un sous-domaine là où le service n’en utilise pas', () => {
    // Google sert tout depuis un hôte unique : ouvrir ses sous-domaines
    // élargirait la cible sans rien permettre de plus.
    expect(isKnownPushEndpoint('https://evil.fcm.googleapis.com/fcm/send/x')).toBe(false);
  });

  it('refuse une adresse interne au réseau du container', () => {
    // Le cœur du sujet : sans allowlist, un compte authentifié fait poster le
    // serveur sur ce qu'il veut, y compris ce qui n'est joignable que de
    // l'intérieur.
    const internal = [
      'https://postgres:5432/',
      'https://localhost/admin',
      'https://127.0.0.1/',
      'https://169.254.169.254/latest/meta-data/',
      'https://trainarr/api/fit/upload',
    ];

    for (const endpoint of internal) {
      expect(isKnownPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('ne se laisse pas tromper par un hôte qui ressemble', () => {
    const lookalikes = [
      // Le domaine attendu, mais en fin de chaîne d'un autre domaine.
      'https://fcm.googleapis.com.exemple.fr/x',
      'https://push.apple.com.exemple.fr/x',
      // Le domaine attendu collé sans point : `endsWith` seul l'accepterait.
      'https://notpush.apple.com/x',
      // Le domaine attendu dans le chemin, dans l'utilisateur, ou en fragment.
      'https://exemple.fr/https://web.push.apple.com/x',
      'https://web.push.apple.com@exemple.fr/x',
    ];

    for (const endpoint of lookalikes) {
      expect(isKnownPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('refuse tout ce qui n’est pas https sur son port', () => {
    expect(isKnownPushEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    // Un port arbitraire sur un hôte connu ne désigne plus un service de push.
    expect(isKnownPushEndpoint('https://web.push.apple.com:8080/x')).toBe(false);
    // Écrit explicitement, le port du protocole reste le même service.
    expect(isKnownPushEndpoint('https://web.push.apple.com:443/x')).toBe(true);
  });

  it('refuse ce qui n’est pas une URL', () => {
    expect(isKnownPushEndpoint('')).toBe(false);
    expect(isKnownPushEndpoint('web.push.apple.com/x')).toBe(false);
    expect(isKnownPushEndpoint('pas une url')).toBe(false);
  });

  it('refuse sans recopier l’adresse dans le message', () => {
    // La phrase part vers le navigateur : y remettre l'URL rendrait au client ce
    // que le refus vient de lui cacher.
    expect(UNKNOWN_PUSH_HOST_MESSAGE).not.toContain('http');
  });
});
