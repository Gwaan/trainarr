import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { COACH_CHAT_MAX_PER_MINUTE, resetCoachChatGuard } from '@/lib/ai/chat-guard';
import { AiResponseError, AiUnavailableError } from '@/lib/ai/errors';

// La route importe le service, `server-only` et branché au DAL.
vi.mock('server-only', () => ({}));

const { answerCoachQuestion } = vi.hoisted(() => ({ answerCoachQuestion: vi.fn() }));
vi.mock('@/lib/ai/coach-service', async () => {
  // Les bornes de la question sont du vrai code : la route doit refuser
  // exactement ce que le service refuserait.
  const actual =
    await vi.importActual<typeof import('@/lib/ai/coach-service')>('@/lib/ai/coach-service');
  return { ...actual, answerCoachQuestion };
});

const { POST } = await import('./route');

const ENDPOINT = 'http://localhost/api/coach/chat';

/** Une requête de chat, corps brut pour pouvoir aussi envoyer du non-JSON. */
function chatRequest(body: unknown, signal?: AbortSignal): NextRequest {
  return new NextRequest(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

/** Une réponse écrite d'un fragment, puis persistée. */
function answersWith(content: string, messageId = 123): void {
  answerCoachQuestion.mockImplementation(
    async (input: { onDelta: (delta: string) => void }) => {
      input.onDelta(content);
      return { content, messageId };
    },
  );
}

let errored: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  // Le verrou vit sur `globalThis` : sans remise à zéro, un scénario laisserait
  // le suivant refusé d'office.
  resetCoachChatGuard();
  errored = vi.spyOn(console, 'error').mockImplementation(() => {});
  answersWith('Repose-toi.');
});

afterEach(() => {
  errored.mockRestore();
});

describe('POST /api/coach/chat — entrée', () => {
  it('refuse un corps qui n’est pas du JSON', async () => {
    const response = await POST(chatRequest('pas du json'));

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(answerCoachQuestion).not.toHaveBeenCalled();
  });

  it('refuse un corps sans question, ou dont la question est vide', async () => {
    expect((await POST(chatRequest({}))).status).toBe(400);
    expect((await POST(chatRequest({ question: 42 }))).status).toBe(400);
    expect((await POST(chatRequest({ question: '   ' }))).status).toBe(400);
    expect(answerCoachQuestion).not.toHaveBeenCalled();
  });

  it('refuse une question au-delà des bornes du service', async () => {
    const response = await POST(chatRequest({ question: 'a'.repeat(2_001) }));

    expect(response.status).toBe(400);
    expect(answerCoachQuestion).not.toHaveBeenCalled();
  });

  it('ne consomme pas la garde de charge sur une entrée invalide', async () => {
    await POST(chatRequest({}));

    // La requête suivante, valide, doit passer : le refus précédent n'a rien
    // occupé du tout.
    const response = await POST(chatRequest({ question: 'Je cours demain ?' }));
    await response.text();

    expect(response.status).toBe(200);
  });

  it('détoure la question avant de la transmettre', async () => {
    await (await POST(chatRequest({ question: '  Je cours demain ?  ' }))).text();

    expect(answerCoachQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Je cours demain ?' }),
    );
  });
});

describe('POST /api/coach/chat — fil d’événements', () => {
  it('écrit les fragments puis l’identifiant du message, au format imposé', async () => {
    answerCoachQuestion.mockImplementation(async (input: { onDelta: (d: string) => void }) => {
      input.onDelta('Repose-toi');
      input.onDelta(" aujourd'hui.");
      return { content: "Repose-toi aujourd'hui.", messageId: 123 };
    });

    const response = await POST(chatRequest({ question: 'Je cours demain ?' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(
      'event: delta\ndata: {"text":"Repose-toi"}\n\n' +
        'event: delta\ndata: {"text":" aujourd\'hui."}\n\n' +
        'event: done\ndata: {"messageId":123}\n\n',
    );
  });

  it('garde un fragment multiligne sur une seule ligne `data:`', async () => {
    answersWith('### Demain\n- footing');

    const body = await (await POST(chatRequest({ question: 'Alors ?' }))).text();

    expect(body).toContain('event: delta\ndata: {"text":"### Demain\\n- footing"}\n\n');
    // Une ligne vide sépare les événements, et rien d'autre n'en produit.
    expect(body.split('\n\n').filter((block) => block !== '')).toHaveLength(2);
  });
});

describe('POST /api/coach/chat — garde de charge', () => {
  it('refuse une seconde génération concurrente sans ouvrir de flux', async () => {
    let finish: (answer: { content: string; messageId: number }) => void = () => {};
    answerCoachQuestion.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const first = await POST(chatRequest({ question: 'Première' }));
    const second = await POST(chatRequest({ question: 'Seconde' }));

    // 409 : le GPU est occupé, ce n'est pas un quota — la requête repassera dès
    // que la réponse en cours sera écrite.
    expect(second.status).toBe(409);
    expect(second.headers.get('content-type')).toContain('application/json');
    expect(await second.json()).toEqual({
      message:
        "Le coach écrit déjà une réponse. Attends qu'il ait terminé avant de lui reposer une question.",
    });
    expect(answerCoachQuestion).toHaveBeenCalledTimes(1);

    finish({ content: 'Repose-toi.', messageId: 1 });
    await first.text();

    // Le droit est rendu : la question suivante repart.
    answersWith('Repose-toi.');
    const third = await POST(chatRequest({ question: 'Troisième' }));
    await third.text();
    expect(third.status).toBe(200);
  });

  it('plafonne les générations à la minute glissante', async () => {
    for (let index = 0; index < COACH_CHAT_MAX_PER_MINUTE; index += 1) {
      const response = await POST(chatRequest({ question: `Question ${index}` }));
      await response.text();
      expect(response.status).toBe(200);
    }

    const refused = await POST(chatRequest({ question: 'Une de trop' }));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await refused.json()).toEqual({
      message: 'Trop de questions coup sur coup. Laisse une minute au coach.',
    });
    expect(answerCoachQuestion).toHaveBeenCalledTimes(COACH_CHAT_MAX_PER_MINUTE);
  });

  it('rouvre le plafond une fois la fenêtre passée', async () => {
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);

    for (let index = 0; index < COACH_CHAT_MAX_PER_MINUTE; index += 1) {
      await (await POST(chatRequest({ question: `Question ${index}` }))).text();
    }
    expect((await POST(chatRequest({ question: 'Une de trop' }))).status).toBe(429);

    clock.mockReturnValue(startedAt + 60_001);
    const response = await POST(chatRequest({ question: 'Une minute plus tard' }));
    await response.text();

    expect(response.status).toBe(200);
    clock.mockRestore();
  });

  it('rend le droit de générer même quand la génération échoue', async () => {
    answerCoachQuestion.mockRejectedValue(new AiUnavailableError('unreachable'));
    await (await POST(chatRequest({ question: 'Première' }))).text();

    answersWith('Repose-toi.');
    const response = await POST(chatRequest({ question: 'Seconde' }));
    await response.text();

    expect(response.status).toBe(200);
  });
});

describe('POST /api/coach/chat — échec après ouverture du flux', () => {
  it('dit la panne dans le flux, sans changer le statut ni fuiter de trace', async () => {
    answerCoachQuestion.mockImplementation(async (input: { onDelta: (d: string) => void }) => {
      input.onDelta('Repose-');
      throw new AiUnavailableError('unreachable');
    });

    const response = await POST(chatRequest({ question: 'Je cours demain ?' }));
    const body = await response.text();

    // Les en-têtes sont partis : le statut ne peut plus dire l'échec.
    expect(response.status).toBe(200);
    expect(body).toBe(
      'event: delta\ndata: {"text":"Repose-"}\n\n' +
        'event: error\ndata: {"message":"Le coach ne répond pas — la machine qui l\'héberge est peut-être éteinte. Ta question t\'est rendue dans la saisie : renvoie-la dans un moment."}\n\n',
    );
    // Rien de technique ne franchit la frontière ; le détail reste au serveur.
    expect(body).not.toContain('AI_BASE_URL');
    expect(body).not.toContain('AiUnavailableError');
    expect(errored).toHaveBeenCalledWith('[coach/chat] génération en échec :', expect.anything());
  });

  it('distingue un coach non configuré d’un coach injoignable', async () => {
    answerCoachQuestion.mockRejectedValue(new AiUnavailableError('unconfigured'));

    const body = await (await POST(chatRequest({ question: 'Alors ?' }))).text();

    expect(body).toContain("Le coach IA n'est pas configuré sur cette installation");
    expect(body).not.toContain('AI_BASE_URL');
  });

  it('distingue une réponse hors contrat d’une panne de disponibilité', async () => {
    answerCoachQuestion.mockRejectedValue(new AiResponseError('HTTP 500', 500));

    const body = await (await POST(chatRequest({ question: 'Alors ?' }))).text();

    expect(body).toContain(
      'event: error\ndata: {"message":"Le coach a bien répondu, mais sa réponse est inexploitable. Repose ta question."}\n\n',
    );
    expect(body).not.toContain('HTTP 500');
  });

  it('ne rend qu’un message générique sur une panne inattendue', async () => {
    answerCoachQuestion.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

    const body = await (await POST(chatRequest({ question: 'Alors ?' }))).text();

    expect(body).toBe(
      'event: error\ndata: {"message":"Le coach n\'a pas pu répondre. Réessaie dans un moment."}\n\n',
    );
    expect(body).not.toContain('ECONNREFUSED');
  });
});

describe('POST /api/coach/chat — abandon du client', () => {
  it('confie la coupure au signal de la requête, transmis au service', async () => {
    const aborter = new AbortController();
    const request = chatRequest({ question: 'Alors ?' }, aborter.signal);
    let received: AbortSignal | undefined;

    answerCoachQuestion.mockImplementation(
      async (input: { onDelta: (d: string) => void; signal?: AbortSignal }) => {
        received = input.signal;
        input.onDelta('Repose-');
        // L'athlète ferme l'onglet pendant que le modèle écrit. Plus rien ne lève
        // depuis `onDelta` : c'est le signal qui rompt la génération en amont —
        // y compris quand aucun fragment n'est encore sorti de la retenue de
        // tête de `client.ts`, cas où `onDelta` n'est jamais appelé.
        aborter.abort();
        input.onDelta('toi.');
        return { content: 'Repose-toi.', messageId: 1 };
      },
    );

    const body = await (await POST(request)).text();

    expect(received).toBe(request.signal);
    // Ni le second fragment, ni `done` : il n'y a plus personne pour les lire.
    expect(body).toBe('event: delta\ndata: {"text":"Repose-"}\n\n');
    expect(errored).not.toHaveBeenCalled();
  });

  it('voit un signal déjà avorté à l’entrée du handler', async () => {
    // Un signal déjà avorté n'émettra plus jamais son événement `abort` :
    // s'y abonner sans avoir lu son état laisserait écrire dans le vide toute une
    // réponse — le cas du client parti pendant qu'il attendait son tour.
    const request = chatRequest({ question: 'Alors ?' }, AbortSignal.abort());
    let received: AbortSignal | undefined;

    answerCoachQuestion.mockImplementation(
      async (input: { onDelta: (d: string) => void; signal?: AbortSignal }) => {
        received = input.signal;
        input.onDelta('Repose-toi.');
        return { content: 'Repose-toi.', messageId: 1 };
      },
    );

    const body = await (await POST(request)).text();

    expect(request.signal.aborted).toBe(true);
    expect(received?.aborted).toBe(true);
    // Pas un octet, pas même `done` : le flux n'a jamais eu de lecteur.
    expect(body).toBe('');
    expect(errored).not.toHaveBeenCalled();
  });

  it('rend le droit de générer après un abandon', async () => {
    const aborter = new AbortController();
    answerCoachQuestion.mockImplementation(async (input: { onDelta: (d: string) => void }) => {
      aborter.abort();
      input.onDelta('Repose-');
      return { content: 'Repose-toi.', messageId: 1 };
    });

    await (await POST(chatRequest({ question: 'Alors ?' }, aborter.signal))).text();

    answersWith('Repose-toi.');
    const response = await POST(chatRequest({ question: 'Encore ?' }));
    await response.text();

    expect(response.status).toBe(200);
  });
});

describe('POST /api/coach/chat — battement de cœur', () => {
  /**
   * Ce que le proxy compte comme un silence : nginx coupe à 60 s de
   * `proxy_read_timeout` par défaut, et le pré-remplissage du prompt suivi de la
   * retenue de tête peut largement les atteindre sans qu'un seul `delta` ne
   * parte.
   */
  const PROXY_READ_TIMEOUT_MS = 60_000;

  /** Une génération que le test tient en suspens aussi longtemps qu'il veut. */
  function pendingAnswer(): { answer: () => void } {
    let release: () => void = () => {};
    answerCoachQuestion.mockImplementation(
      async (input: { onDelta: (d: string) => void }) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        input.onDelta('Repose-toi.');
        return { content: 'Repose-toi.', messageId: 7 };
      },
    );
    return { answer: () => release() };
  }

  it('tient la connexion ouverte pendant que le coach réfléchit', async () => {
    vi.useFakeTimers();
    try {
      const { answer } = pendingAnswer();
      const response = await POST(chatRequest({ question: 'Alors ?' }));

      // Toute une fenêtre de proxy sans le moindre fragment.
      await vi.advanceTimersByTimeAsync(PROXY_READ_TIMEOUT_MS - 1);
      answer();
      const body = await response.text();

      const pings = body.split(': ping\n\n').length - 1;
      expect(pings).toBeGreaterThanOrEqual(2);
      // Le décodeur ignore les commentaires SSE : le fil utile est intact.
      expect(body.endsWith(
        'event: delta\ndata: {"text":"Repose-toi."}\n\n' +
          'event: done\ndata: {"messageId":7}\n\n',
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('arrête l’horloge au premier fragment, et à la fin du flux', async () => {
    vi.useFakeTimers();
    try {
      const { answer } = pendingAnswer();
      const response = await POST(chatRequest({ question: 'Alors ?' }));

      answer();
      const body = await response.text();
      // Le flux est clos : aucune horloge ne doit plus tourner derrière lui.
      await vi.advanceTimersByTimeAsync(PROXY_READ_TIMEOUT_MS * 10);

      // Le fragment est parti tout de suite : la réponse elle-même tient
      // désormais la connexion, le battement n'a plus lieu d'être.
      expect(body).toBe(
        'event: delta\ndata: {"text":"Repose-toi."}\n\n' +
          'event: done\ndata: {"messageId":7}\n\n',
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
