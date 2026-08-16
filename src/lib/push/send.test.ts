import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendToAthlete } from './send';
import { DAILY_SESSION_TTL_S, DEFAULT_PUSH_TTL_S } from './ttl';

/**
 * L'envoi — la promesse tenue par l'en-tête du module : **il ne lève jamais**.
 *
 * Ses appelants sont l'ingestion FIT et des boucles de fond, qui font par
 * ailleurs un vrai travail. Deux propriétés :
 *
 * 1. **une clé VAPID mal recopiée ne remonte pas** — `setVapidDetails` valide
 *    synchroniquement et lève sur ce qui n'est pas du base64url strict (un `=`
 *    de remplissage, une espace, un retour à la ligne), et le schéma Zod de
 *    l'environnement ne vérifie qu'une longueur non nulle : c'est la faute la
 *    plus facile à commettre dans un `.env` ;
 * 2. **chaque message porte une durée de vie**, sans quoi le service de push le
 *    garderait quatre semaines en file.
 */

// Le module est `server-only` ; `./config` lit l'environnement validé.
vi.mock('server-only', () => ({}));

const { envState, dataState, sendNotificationMock } = vi.hoisted(() => ({
  /**
   * `web-push` **réel**, sauf l'envoi lui-même : c'est sa vraie validation de
   * clés qu'on veut voir lever, et c'est tout l'intérêt du test. Seul le POST
   * vers un service de push est remplacé.
   */
  sendNotificationMock:
    vi.fn<(subscription: unknown, body: string, options: { TTL: number }) => Promise<void>>(),
  envState: {
    VAPID_PUBLIC_KEY: undefined as string | undefined,
    VAPID_PRIVATE_KEY: undefined as string | undefined,
    VAPID_SUBJECT: 'mailto:gwen@exemple.fr' as string | undefined,
  },
  dataState: {
    subscriptions: [] as Array<{ id: number; endpoint: string; p256dh: string; auth: string }>,
    listCalls: 0,
  },
}));

vi.mock('@/config/env', () => ({ env: envState }));

vi.mock('@/data/push', () => ({
  listSubscriptions: () => {
    dataState.listCalls += 1;
    return Promise.resolve(dataState.subscriptions);
  },
  dropSubscription: () => Promise.resolve(),
  touchSubscription: () => Promise.resolve(),
}));

vi.mock('web-push', async (importOriginal) => {
  // `web-push` est un module CommonJS : ses fonctions vivent sous `default`,
  // et c'est de là que l'interop de Vite tire les imports nommés. On remonte
  // donc les deux niveaux avant de substituer le seul envoi réseau.
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual.default, ...actual, sendNotification: sendNotificationMock };
});

// Des vraies clés : c'est le seul moyen de prouver que le chemin nominal passe
// la validation de `web-push`, et donc que le test suivant échoue bien à cause
// du caractère en trop.
const { generateVAPIDKeys } = await vi.importActual<typeof import('web-push')>('web-push');
const VALID_KEYS = generateVAPIDKeys();

const DEVICE = {
  id: 1,
  endpoint: 'https://web.push.apple.com/abc',
  p256dh: 'cle-publique-appareil',
  auth: 'secret-abonnement',
};

const PAYLOAD = {
  title: 'Séance du jour : 6 × 800 m',
  body: 'VMA courte',
  url: '/',
  tag: 'daily-session',
};

beforeEach(() => {
  envState.VAPID_PUBLIC_KEY = VALID_KEYS.publicKey;
  envState.VAPID_PRIVATE_KEY = VALID_KEYS.privateKey;
  envState.VAPID_SUBJECT = 'mailto:gwen@exemple.fr';
  dataState.subscriptions = [DEVICE];
  dataState.listCalls = 0;
  sendNotificationMock.mockClear();
});

describe('sendToAthlete', () => {
  it('ne lève pas sur une clé VAPID mal recopiée, et dit pourquoi rien n’est parti', async () => {
    // Un `=` de remplissage suffit : c'est ce que produit une recopie depuis un
    // outil qui encode en base64 standard.
    envState.VAPID_PUBLIC_KEY = `${VALID_KEYS.publicKey}=`;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendToAthlete(7, PAYLOAD)).resolves.toEqual({
      delivered: 0,
      removed: 0,
      skipped: 'disabled',
    });

    // Une faute de configuration doit être lisible dans les journaux du
    // container : c'est le seul endroit où elle apparaîtra.
    expect(errors).toHaveBeenCalled();
    // Et rien n'a été tenté : ni lecture en base, ni envoi.
    expect(dataState.listCalls).toBe(0);
    expect(sendNotificationMock).not.toHaveBeenCalled();

    errors.mockRestore();
  });

  it('ne lève pas non plus sur une clé privée avec un retour à la ligne', async () => {
    envState.VAPID_PRIVATE_KEY = `${VALID_KEYS.privateKey}\n`;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendToAthlete(7, PAYLOAD)).resolves.toEqual({
      delivered: 0,
      removed: 0,
      skipped: 'disabled',
    });

    errors.mockRestore();
  });

  it('porte la durée de vie de la catégorie, et ne l’envoie pas à l’appareil', async () => {
    await expect(
      sendToAthlete(7, { ...PAYLOAD, ttlSeconds: DAILY_SESSION_TTL_S }),
    ).resolves.toEqual({ delivered: 1, removed: 0, skipped: null });

    const call = sendNotificationMock.mock.calls[0];
    expect(call?.[2]).toEqual({ TTL: DAILY_SESSION_TTL_S });
    // Le corps chiffré est ce que `public/sw.js` lit : quatre champs
    // d'affichage, et pas une consigne destinée au service de push.
    expect(JSON.parse(call?.[1] ?? 'null')).toEqual(PAYLOAD);
  });

  it('retombe sur la durée par défaut quand le payload n’en porte pas', async () => {
    await sendToAthlete(7, PAYLOAD);

    expect(sendNotificationMock.mock.calls[0]?.[2]).toEqual({ TTL: DEFAULT_PUSH_TTL_S });
  });
});
