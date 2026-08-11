import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// `server-only` lève hors contexte serveur React : neutralisé pour les tests.
vi.mock('server-only', () => ({}));

import { resetEnvCache } from '@/config/env';

import {
  AI_REQUEST_TIMEOUT_MS,
  AI_STREAM_IDLE_TIMEOUT_MS,
  aiEndpointUrl,
  chatCompletion,
  chatCompletionJson,
  type ChatMessage,
} from './client';
import { AiInvalidOutputError, AiResponseError, AiUnavailableError } from './errors';

const BASE_URL = 'http://ia.test:8080';
const API_KEY = 'cle-ia-de-test-a-ne-jamais-journaliser';

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'Tu es le coach.' },
  { role: 'user', content: 'Résume ma semaine.' },
];

type Call = { url: string; init: RequestInit | undefined };

function stubFetch(response: Response | (() => Response | Promise<never>)): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : response;
  });
  return { calls };
}

/** Enveloppe de chat completion telle que la rend une API compatible OpenAI. */
function completion(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Réponse SSE telle que la streame une API compatible OpenAI.
 *
 * Les morceaux sont enfilés **tels quels** : c'est ce qui permet d'éprouver une
 * ligne coupée en deux par la frontière d'un chunk réseau, cas parfaitement
 * banal sur un flux réel. `stall` laisse le flux ouvert sans jamais le fermer —
 * le serveur muet du test de délai d'inactivité.
 */
function sseResponse(parts: string[], options: { stall?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      if (options.stall !== true) controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Un événement de flux portant un fragment de contenu. */
function deltaEvent(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

function bodyOf(call: Call): Record<string, unknown> {
  const raw = call.init?.body;
  if (typeof raw !== 'string') throw new Error('Corps de requête absent ou non textuel.');
  return z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
}

function authorizationOf(call: Call): string | null {
  return new Headers(call.init?.headers).get('authorization');
}

beforeEach(() => {
  resetEnvCache();
  vi.stubEnv('AI_BASE_URL', BASE_URL);
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe('aiEndpointUrl', () => {
  it('concatène le chemin à la racine configurée', () => {
    expect(aiEndpointUrl(BASE_URL, '/v1/chat/completions')).toBe(
      'http://ia.test:8080/v1/chat/completions',
    );
  });

  it('tolère les barres finales et un /v1 déjà présent', () => {
    expect(aiEndpointUrl(`${BASE_URL}/`, '/health')).toBe('http://ia.test:8080/health');
    expect(aiEndpointUrl(`${BASE_URL}/v1`, '/health')).toBe('http://ia.test:8080/health');
    expect(aiEndpointUrl(`${BASE_URL}/v1/`, '/health')).toBe('http://ia.test:8080/health');
  });

  it('préserve un préfixe de chemin (reverse proxy)', () => {
    expect(aiEndpointUrl('https://ia.exemple/llama', '/v1/chat/completions')).toBe(
      'https://ia.exemple/llama/v1/chat/completions',
    );
  });
});

describe('chatCompletion', () => {
  it("poste sur l'endpoint compatible OpenAI et rend le contenu", async () => {
    const { calls } = stubFetch(completion('Bonne semaine : 42 km, dont une sortie longue.'));

    const answer = await chatCompletion({ messages: MESSAGES });

    expect(answer).toBe('Bonne semaine : 42 km, dont une sortie longue.');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://ia.test:8080/v1/chat/completions');
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/json');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('transmet messages, modèle et paramètres de génération', async () => {
    vi.stubEnv('AI_MODEL', 'qwen3-4b-instruct');
    resetEnvCache();
    const { calls } = stubFetch(completion('ok'));

    await chatCompletion({ messages: MESSAGES, temperature: 0.2, maxTokens: 512 });

    expect(bodyOf(calls[0])).toEqual({
      model: 'qwen3-4b-instruct',
      messages: MESSAGES,
      temperature: 0.2,
      max_tokens: 512,
    });
  });

  it("laisse le serveur décider quand AI_MODEL et les paramètres sont absents", async () => {
    const { calls } = stubFetch(completion('ok'));

    await chatCompletion({ messages: MESSAGES });

    const body = bodyOf(calls[0]);
    expect(body.model).toBe('default');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('response_format');
  });

  it("ajoute l'en-tête Bearer quand une clé est configurée", async () => {
    vi.stubEnv('AI_API_KEY', API_KEY);
    resetEnvCache();
    const { calls } = stubFetch(completion('ok'));

    await chatCompletion({ messages: MESSAGES });

    expect(authorizationOf(calls[0])).toBe(`Bearer ${API_KEY}`);
  });

  it("omet l'en-tête sans clé — llama.cpp local n'en demande pas", async () => {
    const { calls } = stubFetch(completion('ok'));

    await chatCompletion({ messages: MESSAGES });

    expect(authorizationOf(calls[0])).toBeNull();
  });

  it('pose le délai de garde demandé, 5 minutes par défaut', async () => {
    expect(AI_REQUEST_TIMEOUT_MS).toBe(300_000);
    const { calls } = stubFetch(completion('ok'));

    await chatCompletion({ messages: MESSAGES, timeoutMs: 1_000 });

    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('traduit une panne réseau en coach injoignable', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));

    const error = await chatCompletion({ messages: MESSAGES }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).reason).toBe('unreachable');
  });

  it('lève « unconfigured » sans AI_BASE_URL, sans rien appeler', async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    const { calls } = stubFetch(completion('ok'));

    const error = await chatCompletion({ messages: MESSAGES }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).reason).toBe('unconfigured');
    expect(calls).toHaveLength(0);
  });

  it('lève AiResponseError sur un statut non-2xx, en portant le code', async () => {
    stubFetch(new Response('boom', { status: 500 }));

    const error = await chatCompletion({ messages: MESSAGES }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiResponseError);
    expect((error as AiResponseError).status).toBe(500);
  });

  it('lève AiResponseError sur un corps illisible', async () => {
    stubFetch(new Response('pas du json', { status: 200 }));

    await expect(chatCompletion({ messages: MESSAGES })).rejects.toBeInstanceOf(AiResponseError);
  });

  it.each([
    ['enveloppe sans choices', { object: 'chat.completion' }],
    ['liste de choix vide', { choices: [] }],
    ['choix sans message', { choices: [{ finish_reason: 'stop' }] }],
    ['contenu non textuel', { choices: [{ message: { content: 42 } }] }],
  ])('lève AiResponseError sur une %s', async (_label, payload) => {
    stubFetch(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(chatCompletion({ messages: MESSAGES })).rejects.toBeInstanceOf(AiResponseError);
  });

  it('lève AiResponseError sur un contenu vide', async () => {
    stubFetch(completion('   \n '));

    await expect(chatCompletion({ messages: MESSAGES })).rejects.toBeInstanceOf(AiResponseError);
  });

  it('ignore les champs supplémentaires de la réponse (usage, timings…)', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { total_tokens: 12 },
          timings: { predicted_per_second: 8.4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(chatCompletion({ messages: MESSAGES })).resolves.toBe('ok');
  });
});

describe('chatCompletion — streaming', () => {
  /** Le flux nominal : rôle, trois fragments, sentinelle de fin. */
  const NOMINAL = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
    deltaEvent('Bonne '),
    deltaEvent('semaine : '),
    deltaEvent('42 km.'),
    'data: [DONE]\n\n',
  ];

  it('demande le flux et rend exactement le même contenu', async () => {
    const { calls } = stubFetch(sseResponse(NOMINAL));

    const answer = await chatCompletion({ messages: MESSAGES, onProgress: () => {} });

    expect(answer).toBe('Bonne semaine : 42 km.');
    expect(bodyOf(calls[0]).stream).toBe(true);
  });

  it('signale le nombre de caractères accumulés, chunk après chunk', async () => {
    stubFetch(sseResponse(NOMINAL));
    const received: number[] = [];

    await chatCompletion({ messages: MESSAGES, onProgress: (chars) => received.push(chars) });

    // Cumulatif, jamais par delta : c'est ce que le pourcentage attend.
    expect(received).toEqual(['Bonne '.length, 'Bonne semaine : '.length, 'Bonne semaine : 42 km.'.length]);
  });

  it("recolle une ligne coupée entre deux chunks réseau", async () => {
    const event = deltaEvent('Bonne semaine.');
    stubFetch(sseResponse([event.slice(0, 20), event.slice(20), 'data: [DONE]\n\n']));

    await expect(
      chatCompletion({ messages: MESSAGES, onProgress: () => {} }),
    ).resolves.toBe('Bonne semaine.');
  });

  it('ignore les lignes qui ne portent pas de données (ping, séparateurs)', async () => {
    stubFetch(
      sseResponse([': ping\n\n', deltaEvent('ok'), '\n', 'event: message\n', 'data: [DONE]\n\n']),
    );

    await expect(chatCompletion({ messages: MESSAGES, onProgress: () => {} })).resolves.toBe('ok');
  });

  it("s'arrête à [DONE] et ignore ce qui suivrait", async () => {
    stubFetch(sseResponse([deltaEvent('ok'), 'data: [DONE]\n\n', deltaEvent(' et la suite')]));

    await expect(chatCompletion({ messages: MESSAGES, onProgress: () => {} })).resolves.toBe('ok');
  });

  it('garde le dernier événement quand le flux se ferme sans sentinelle', async () => {
    // Ni `[DONE]`, ni saut de ligne final : le fragment dort dans le tampon de
    // recollage. Perdu, il produirait un JSON tronqué inexplicable.
    stubFetch(sseResponse([deltaEvent('Bonne '), `data: ${JSON.stringify({
      choices: [{ delta: { content: 'semaine.' } }],
    })}`]));

    await expect(chatCompletion({ messages: MESSAGES, onProgress: () => {} })).resolves.toBe(
      'Bonne semaine.',
    );
  });

  it("ne lit pas le flux quand le statut n'est pas 2xx, et libère la connexion", async () => {
    const { calls } = stubFetch(new Response('boom', { status: 503 }));
    const onProgress = vi.fn();

    const error = await chatCompletion({ messages: MESSAGES, onProgress }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AiResponseError);
    expect((error as AiResponseError).status).toBe(503);
    expect(onProgress).not.toHaveBeenCalled();
    // Corps d'erreur jamais lu : sans abandon, la requête resterait ouverte.
    expect(calls[0].init?.signal?.aborted).toBe(true);
  });

  it('lève AiResponseError en portant le message d\'un événement d\'erreur du flux', async () => {
    // llama-server publie ainsi une panne survenue après les en-têtes (contexte
    // dépassé, par exemple) : statut 200, puis un événement d'erreur.
    stubFetch(
      sseResponse([
        deltaEvent('Semaine 1'),
        `data: ${JSON.stringify({
          error: { code: 500, message: 'the request exceeds the available context size', type: 'server_error' },
        })}\n\n`,
      ]),
    );

    const error = await chatCompletion({ messages: MESSAGES, onProgress: () => {} }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AiResponseError);
    expect((error as AiResponseError).message).toContain(
      'the request exceeds the available context size',
    );
  });

  it("ne prend pas un `error: null` de chunk sain pour une panne", async () => {
    stubFetch(
      sseResponse([
        `data: ${JSON.stringify({ error: null, choices: [{ delta: { content: 'ok' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );

    await expect(chatCompletion({ messages: MESSAGES, onProgress: () => {} })).resolves.toBe('ok');
  });

  it('lève AiResponseError sur un chunk hors protocole', async () => {
    stubFetch(sseResponse(['data: {ceci n\'est pas du json}\n\n', 'data: [DONE]\n\n']));

    await expect(
      chatCompletion({ messages: MESSAGES, onProgress: () => {} }),
    ).rejects.toBeInstanceOf(AiResponseError);
  });

  it('lève AiResponseError quand le flux se termine sans rien avoir dit', async () => {
    stubFetch(sseResponse(['data: [DONE]\n\n']));

    await expect(
      chatCompletion({ messages: MESSAGES, onProgress: () => {} }),
    ).rejects.toBeInstanceOf(AiResponseError);
  });

  it('abandonne un flux qui se tait plus longtemps que le délai d\'inactivité', async () => {
    vi.useFakeTimers();
    try {
      // Un premier fragment, puis plus rien : le délai de garde global (5 min)
      // laisserait attendre quatre minutes de plus pour rien.
      stubFetch(sseResponse([deltaEvent('Bonne ')], { stall: true }));

      const pending = chatCompletion({ messages: MESSAGES, onProgress: () => {} }).catch(
        (caught: unknown) => caught,
      );
      await vi.advanceTimersByTimeAsync(AI_STREAM_IDLE_TIMEOUT_MS + 1);
      const error = await pending;

      expect(error).toBeInstanceOf(AiUnavailableError);
      expect((error as AiUnavailableError).reason).toBe('unreachable');
    } finally {
      vi.useRealTimers();
    }
  });

  /** Un flux laissé ouvert, dont le test décide quand et quoi émettre. */
  function openStream(): { calls: Call[]; push: (part: string) => void; close: () => void } {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const { calls } = stubFetch(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );

    return {
      calls,
      push: (part) => stream.enqueue(encoder.encode(part)),
      close: () => stream.close(),
    };
  }

  it('laisse courir un flux vivant au-delà du délai de garde global', async () => {
    vi.useFakeTimers();
    try {
      // Un flux qui n'a pas fini de parler ne doit pas être coupé sur la seule
      // durée : c'est le cas nominal d'un plan de douze semaines écrit par un
      // petit modèle local. Passé le premier chunk, seul le silence entre deux
      // chunks fait foi.
      const { calls, push, close } = openStream();

      const pending = chatCompletion({
        messages: MESSAGES,
        timeoutMs: 1_000,
        onProgress: () => {},
      });

      push(deltaEvent('Bonne '));
      for (const fragment of ['semaine : ', '42 km.']) {
        // Chaque silence reste sous le délai d'inactivité, mais leur somme
        // dépasse très largement le délai de garde demandé.
        await vi.advanceTimersByTimeAsync(AI_STREAM_IDLE_TIMEOUT_MS / 2);
        push(deltaEvent(fragment));
      }
      push('data: [DONE]\n\n');
      close();

      await expect(pending).resolves.toBe('Bonne semaine : 42 km.');
      expect(calls[0].init?.signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("laisse au pré-remplissage du prompt tout le délai de garde global", async () => {
    vi.useFakeTimers();
    try {
      // Avant le premier chunk, le serveur charge le prompt dans son contexte
      // sans rien pouvoir émettre : sur CPU, ce silence-là dépasse la minute
      // d'inactivité. Le mesurer ainsi tuerait une génération parfaitement
      // saine, que le régime non streamé laisserait courir cinq minutes.
      const { calls, push, close } = openStream();

      const pending = chatCompletion({ messages: MESSAGES, onProgress: () => {} });

      await vi.advanceTimersByTimeAsync(AI_STREAM_IDLE_TIMEOUT_MS + 1);
      push(deltaEvent('Bonne semaine.'));
      push('data: [DONE]\n\n');
      close();

      await expect(pending).resolves.toBe('Bonne semaine.');
      expect(calls[0].init?.signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne streame pas sans callback — le mode par défaut est inchangé', async () => {
    const { calls } = stubFetch(completion('ok'));

    await chatCompletion({ messages: MESSAGES });

    expect(bodyOf(calls[0])).not.toHaveProperty('stream');
  });
});

describe('chatCompletionJson', () => {
  const sessionSchema = z.object({
    distanceKm: z.number().positive(),
    intensity: z.enum(['facile', 'seuil', 'vma']),
  });

  const jsonSchema = {
    type: 'object',
    properties: {
      distanceKm: { type: 'number' },
      intensity: { type: 'string', enum: ['facile', 'seuil', 'vma'] },
    },
    required: ['distanceKm', 'intensity'],
    additionalProperties: false,
  };

  function callJson(content: unknown) {
    const { calls } = stubFetch(completion(content));
    return {
      calls,
      run: () =>
        chatCompletionJson({
          messages: MESSAGES,
          schemaName: 'seance',
          jsonSchema,
          schema: sessionSchema,
        }),
    };
  }

  it('contraint la génération par le JSON Schema fourni, sous le nom donné', async () => {
    vi.stubEnv('AI_PROVIDER', 'llamacpp');
    resetEnvCache();
    const { calls, run } = callJson('{"distanceKm": 12.5, "intensity": "seuil"}');

    await run();

    expect(bodyOf(calls[0]).response_format).toEqual({
      type: 'json_schema',
      // `strict` : llama-server l'ignore et contraint par grammaire de toute façon.
      json_schema: { name: 'seance', schema: jsonSchema, strict: true },
    });
  });

  it.each(['openai', 'anthropic'])(
    'omet `strict` sur %s, dont le mode strict rejetterait nos schémas en HTTP 400',
    async (provider) => {
      vi.stubEnv('AI_PROVIDER', provider);
      resetEnvCache();
      const { calls, run } = callJson('{"distanceKm": 12.5, "intensity": "seuil"}');

      await run();

      expect(bodyOf(calls[0]).response_format).toEqual({
        type: 'json_schema',
        json_schema: { name: 'seance', schema: jsonSchema },
      });
    },
  );

  it('rend une valeur typée par le schéma Zod', async () => {
    const { run } = callJson('{"distanceKm": 12.5, "intensity": "seuil"}');

    await expect(run()).resolves.toEqual({ distanceKm: 12.5, intensity: 'seuil' });
  });

  it('lève AiInvalidOutputError quand le contenu n\'est pas du JSON', async () => {
    const { run } = callJson('Voici ta séance : 12 km au seuil.');

    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiInvalidOutputError);
    expect((error as AiInvalidOutputError).issues).toEqual([]);
  });

  it('lève AiInvalidOutputError, issues à l\'appui, sur un JSON hors schéma', async () => {
    const { run } = callJson('{"distanceKm": -3, "intensity": "sprint"}');

    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiInvalidOutputError);
    const { issues } = error as AiInvalidOutputError;
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['distanceKm', 'intensity']);
  });

  it('valide un JSON reçu au fil de l\'eau exactement comme un JSON reçu d\'un coup', async () => {
    const json = '{"distanceKm": 12.5, "intensity": "seuil"}';
    stubFetch(
      sseResponse([deltaEvent(json.slice(0, 15)), deltaEvent(json.slice(15)), 'data: [DONE]\n\n']),
    );
    const received: number[] = [];

    await expect(
      chatCompletionJson({
        messages: MESSAGES,
        schemaName: 'seance',
        jsonSchema,
        schema: sessionSchema,
        onProgress: (chars) => received.push(chars),
      }),
    ).resolves.toEqual({ distanceKm: 12.5, intensity: 'seuil' });
    expect(received).toEqual([15, json.length]);
  });

  it('propage les erreurs de transport sans les requalifier', async () => {
    stubFetch(new Response('boom', { status: 503 }));

    await expect(
      chatCompletionJson({
        messages: MESSAGES,
        schemaName: 'seance',
        jsonSchema,
        schema: sessionSchema,
      }),
    ).rejects.toBeInstanceOf(AiResponseError);
  });
});
