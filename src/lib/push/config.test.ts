import { describe, expect, it, vi } from 'vitest';

import { planPushActivation, PUSH_DISABLED_MESSAGES } from './config';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * L'activation des notifications, décidée sur les seules variables
 * d'environnement.
 *
 * Deux propriétés :
 *
 * 1. **les trois valeurs sont indissociables** — une paire de clés sans sujet ne
 *    passe pas plus qu'un sujet sans clés ;
 * 2. **un sujet mal formé se refuse ici**, pas au premier envoi : `web-push`
 *    lèverait alors dans un journal de container, des semaines plus tard.
 */

const PUBLIC_KEY = 'BE-cle-publique-factice';
const PRIVATE_KEY = 'cle-privee-factice';

describe('planPushActivation', () => {
  it('active les notifications quand les trois valeurs sont là', () => {
    expect(planPushActivation(PUBLIC_KEY, PRIVATE_KEY, 'mailto:gwen@exemple.fr')).toEqual({
      status: 'enabled',
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      subject: 'mailto:gwen@exemple.fr',
    });
  });

  it('accepte une URL https comme identité d’expéditeur', () => {
    expect(planPushActivation(PUBLIC_KEY, PRIVATE_KEY, 'https://exemple.fr/contact')).toEqual({
      status: 'enabled',
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      subject: 'https://exemple.fr/contact',
    });
  });

  it('désactive dès qu’une des trois valeurs manque', () => {
    const missing = { status: 'disabled', reason: 'missing-keys' } as const;

    expect(planPushActivation(undefined, PRIVATE_KEY, 'mailto:gwen@exemple.fr')).toEqual(missing);
    expect(planPushActivation(PUBLIC_KEY, undefined, 'mailto:gwen@exemple.fr')).toEqual(missing);
    expect(planPushActivation(PUBLIC_KEY, PRIVATE_KEY, undefined)).toEqual(missing);
    expect(planPushActivation(undefined, undefined, undefined)).toEqual(missing);
  });

  it('refuse un sujet qui n’est ni mailto: ni https://', () => {
    const invalid = { status: 'disabled', reason: 'invalid-subject' } as const;

    expect(planPushActivation(PUBLIC_KEY, PRIVATE_KEY, 'gwen@exemple.fr')).toEqual(invalid);
    expect(planPushActivation(PUBLIC_KEY, PRIVATE_KEY, 'http://exemple.fr')).toEqual(invalid);
    expect(planPushActivation(PUBLIC_KEY, PRIVATE_KEY, 'Trainarr')).toEqual(invalid);
  });

  it('refuse un préfixe sans rien derrière', () => {
    // Il passerait le test du préfixe, et le service de push le rejetterait
    // plus tard sans que personne ne sache pourquoi.
    expect(planPushActivation(PUBLIC_KEY, PRIVATE_KEY, 'mailto:')).toEqual({
      status: 'disabled',
      reason: 'invalid-subject',
    });
    expect(planPushActivation(PUBLIC_KEY, PRIVATE_KEY, 'https://')).toEqual({
      status: 'disabled',
      reason: 'invalid-subject',
    });
  });

  it('nomme les variables à renseigner dans chaque diagnostic, sans citer de valeur', () => {
    for (const message of Object.values(PUSH_DISABLED_MESSAGES)) {
      expect(message).toContain('VAPID_');
      expect(message).not.toContain(PRIVATE_KEY);
      expect(message).not.toContain(PUBLIC_KEY);
    }

    // Celui qui manque de clés doit dire comment en fabriquer : sans la
    // commande, le message décrit un problème sans issue.
    expect(PUSH_DISABLED_MESSAGES['missing-keys']).toContain(
      'pnpm exec web-push generate-vapid-keys',
    );
  });
});
