import { describe, expect, it } from 'vitest';

import { decideWebhookOutcome, verifySubscription } from './webhook';

const VERIFY_TOKEN = 'jeton-de-verification-trainarr';

function handshakeQuery(overrides: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string | null> = {
    'hub.mode': 'subscribe',
    'hub.verify_token': VERIFY_TOKEN,
    'hub.challenge': 'defi-strava-15f3',
    ...overrides,
  };

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (value !== null) query.set(key, value);
  }
  return query;
}

/** Payload conforme à la documentation Strava (webhook events). */
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aspect_type: 'create',
    event_time: 1_516_126_040,
    object_id: 1_360_128_428,
    object_type: 'activity',
    owner_id: 134_815,
    subscription_id: 120_475,
    ...overrides,
  };
}

describe('verifySubscription', () => {
  it('renvoie le challenge quand le token correspond', () => {
    const result = verifySubscription(handshakeQuery(), VERIFY_TOKEN);

    expect(result).toEqual({ ok: true, challenge: 'defi-strava-15f3' });
  });

  it('refuse un token qui ne correspond pas', () => {
    const result = verifySubscription(handshakeQuery({ 'hub.verify_token': 'pirate' }), VERIFY_TOKEN);

    expect(result.ok).toBe(false);
  });

  it('refuse une requête sans token', () => {
    const result = verifySubscription(handshakeQuery({ 'hub.verify_token': null }), VERIFY_TOKEN);

    expect(result.ok).toBe(false);
  });

  it("refuse tout le monde quand le token n'est pas configuré", () => {
    // Sans token attendu, un appelant qui n'en envoie pas ne doit surtout pas
    // se retrouver validé par une comparaison `undefined === undefined`.
    expect(verifySubscription(handshakeQuery({ 'hub.verify_token': null }), undefined).ok).toBe(false);
    expect(verifySubscription(handshakeQuery(), undefined).ok).toBe(false);
  });

  it('refuse un hub.mode autre que subscribe', () => {
    const result = verifySubscription(handshakeQuery({ 'hub.mode': 'unsubscribe' }), VERIFY_TOKEN);

    expect(result.ok).toBe(false);
  });

  it('refuse un handshake sans challenge', () => {
    const result = verifySubscription(handshakeQuery({ 'hub.challenge': null }), VERIFY_TOKEN);

    expect(result.ok).toBe(false);
  });

  it('ne recopie jamais la valeur reçue dans le motif de refus', () => {
    const result = verifySubscription(
      handshakeQuery({ 'hub.verify_token': 'valeur-hostile-a-ne-pas-logger' }),
      VERIFY_TOKEN,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('valeur-hostile-a-ne-pas-logger');
      expect(result.reason).not.toContain(VERIFY_TOKEN);
    }
  });
});

describe('decideWebhookOutcome', () => {
  it('demande la synchronisation sur une création d’activité', () => {
    expect(decideWebhookOutcome(event())).toEqual({
      kind: 'sync-activity',
      stravaActivityId: 1_360_128_428,
      ownerId: 134_815,
    });
  });

  it('demande la synchronisation sur une mise à jour d’activité', () => {
    const payload = event({ aspect_type: 'update', updates: { title: 'Sortie longue' } });

    expect(decideWebhookOutcome(payload)).toEqual({
      kind: 'sync-activity',
      stravaActivityId: 1_360_128_428,
      ownerId: 134_815,
    });
  });

  it('transmet l’owner_id annoncé : la sync doit pouvoir le confronter à l’athlète connecté', () => {
    // Payload forgé : l'activité d'un tiers, postée sur notre URL de webhook.
    const outcome = decideWebhookOutcome(event({ owner_id: 999_999 }));

    expect(outcome).toMatchObject({ kind: 'sync-activity', ownerId: 999_999 });
  });

  it('ignore une suppression d’activité (non gérée pour l’instant)', () => {
    const outcome = decideWebhookOutcome(event({ aspect_type: 'delete' }));

    expect(outcome.kind).toBe('ignored');
  });

  it('ignore les événements d’athlète', () => {
    const payload = event({
      object_type: 'athlete',
      aspect_type: 'update',
      object_id: 134_815,
      updates: { authorized: 'false' },
    });

    expect(decideWebhookOutcome(payload).kind).toBe('ignored');
  });

  it('rejette un aspect_type inconnu', () => {
    expect(decideWebhookOutcome(event({ aspect_type: 'archive' })).kind).toBe('invalid');
  });

  it('rejette un object_type inconnu', () => {
    expect(decideWebhookOutcome(event({ object_type: 'segment' })).kind).toBe('invalid');
  });

  it('rejette un object_id qui n’est pas un entier positif', () => {
    expect(decideWebhookOutcome(event({ object_id: '1360128428' })).kind).toBe('invalid');
    expect(decideWebhookOutcome(event({ object_id: -1 })).kind).toBe('invalid');
    expect(decideWebhookOutcome(event({ object_id: 12.5 })).kind).toBe('invalid');
  });

  it('rejette un owner_id absent', () => {
    const withoutOwner = event();
    delete withoutOwner.owner_id;

    expect(decideWebhookOutcome(withoutOwner).kind).toBe('invalid');
  });

  it('rejette un updates dont les valeurs ne sont pas des chaînes', () => {
    const payload = event({ aspect_type: 'update', updates: { private: true } });

    expect(decideWebhookOutcome(payload).kind).toBe('invalid');
  });

  it('rejette les payloads non conformes sans lever', () => {
    for (const payload of [null, undefined, 'texte', 42, [], {}]) {
      expect(decideWebhookOutcome(payload).kind).toBe('invalid');
    }
  });

  it('décrit le champ fautif pour le log serveur', () => {
    const outcome = decideWebhookOutcome(event({ object_id: 'pas-un-nombre' }));

    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') {
      expect(outcome.reason).toContain('object_id');
    }
  });
});
