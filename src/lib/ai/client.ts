import 'server-only';

/**
 * Client HTTP du coach IA — format **chat completions d'OpenAI**, standard de
 * fait auquel llama.cpp (`llama-server`), Ollama, vLLM, OpenAI et Mistral
 * répondent nativement.
 *
 * Volontairement écrit sur `fetch` : aucun SDK, aucune dépendance ajoutée. Le
 * code métier ne connaît que {@link chatCompletion} et
 * {@link chatCompletionJson} — jamais un provider.
 *
 * ## Ce sur quoi le module s'appuie
 *
 * - `POST {AI_BASE_URL}/v1/chat/completions`, corps
 *   `{ model, messages, temperature?, max_tokens? }`, réponse
 *   `{ choices: [{ message: { content } }] }`.
 * - `response_format: { type: 'json_schema', json_schema: { name, schema, strict } }`
 *   pour la sortie structurée. Sur llama.cpp ce n'est pas une consigne mais une
 *   **contrainte de génération** : le schéma est converti en grammaire GBNF et
 *   le décodage ne peut plus produire de token hors grammaire. C'est le point
 *   qui rend une sortie structurée fiable avec un petit modèle — là où un
 *   « réponds en JSON » dans le prompt ne l'est pas.
 * - Le JSON Schema est fourni par l'appelant, jamais dérivé du schéma Zod : la
 *   dérivation automatique demanderait une dépendance de plus, et produirait des
 *   constructions que la grammaire de llama.cpp ne sait pas toujours traduire.
 *
 * ## `strict` n'est envoyé qu'à llama.cpp
 *
 * Le drapeau `strict` du `response_format` n'a pas le même sens des deux côtés.
 * Chez OpenAI, c'est un **contrat sur le schéma lui-même** : toute clé de
 * `properties` doit figurer dans `required` (l'optionalité s'exprimant par une
 * union avec `null`) et `additionalProperties: false` doit être posé partout —
 * sinon la requête est rejetée en HTTP 400 avant la moindre génération. Nos
 * schémas sont écrits pour la grammaire GBNF, où un champ facultatif se dit
 * simplement en le laissant hors de `required` (cf. `plan-schema.ts`) : les
 * envoyer en mode strict à OpenAI ferait échouer *toutes* les générations.
 *
 * `strict: true` n'est donc transmis que lorsque `AI_PROVIDER` vaut `llamacpp`,
 * où llama-server l'ignore et contraint de toute façon par grammaire. Pour les
 * providers cloud, le risque d'une sortie hors schéma reste couvert en aval :
 * validation Zod systématique ci-dessous, et boucle de correction du modèle dans
 * `plan-service.ts`.
 *
 * ## Streaming — uniquement quand quelqu'un écoute
 *
 * Un `onProgress` fourni bascule l'appel en `stream: true` et fait lire la
 * réponse en SSE (`data: {…}` par ligne, contenu dans `choices[0].delta.content`,
 * terminaison `data: [DONE]`) : le callback reçoit le nombre de caractères
 * accumulés à chaque chunk. La **chaîne finale est identique** à celle du mode
 * non-streaming — c'est le même contenu, reçu autrement, et la validation Zod
 * qui suit ne voit aucune différence.
 *
 * Sans callback, rien ne change : une seule réponse JSON, comme avant. Le
 * streaming ne se paie que là où il sert à quelque chose (la génération de plan,
 * qui dure des minutes et doit afficher une barre qui avance).
 *
 * ## Trois garde-fous
 *
 * - **Aucun appel ne peut rester suspendu** : chaque requête porte un délai de
 *   garde ({@link AI_REQUEST_TIMEOUT_MS} par défaut). Il est volontairement
 *   large — un petit modèle local (6 Go de VRAM) met des minutes à écrire un
 *   plan d'entraînement, et une génération lente n'est pas une panne.
 * - **Un flux muet est une panne** : en streaming, la durée totale ne dit plus
 *   rien de la santé de l'appel — un serveur qui a livré la moitié du plan puis
 *   se tait paraîtrait « en cours » jusqu'aux 5 minutes, et à l'inverse un flux
 *   qui avance normalement peut légitimement les dépasser. Le délai global cède
 *   donc la place, **une fois le premier chunk reçu**, à un délai d'**inactivité**
 *   entre deux chunks ({@link AI_STREAM_IDLE_TIMEOUT_MS}) : c'est l'absence de
 *   progression qui signale la panne, pas la durée.
 * - **La clé API ne vit que dans l'en-tête `Authorization`** : elle n'apparaît
 *   dans aucune URL ni aucun message d'erreur.
 *
 * Ce module ne vérifie **pas** la disponibilité du coach (c'est `requireAi()`,
 * en tête de Server Action) ; il se contente de traduire une panne réseau en
 * {@link AiUnavailableError}, pour que l'UI dise « coach injoignable » plutôt
 * que « erreur inattendue ».
 */

import { z } from 'zod';

import { env } from '@/config/env';

import {
  AiInvalidOutputError,
  AiResponseError,
  AiUnavailableError,
  type AiOutputIssue,
} from './errors';

/**
 * Délai de garde par défaut d'une génération : 5 minutes.
 *
 * Le modèle cible tient dans 6 Go de VRAM avec 32 k de contexte — quelques
 * tokens par seconde sur une longue sortie. Couper à 30 s ferait échouer des
 * générations parfaitement en cours.
 */
export const AI_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Délai d'inactivité d'un flux : 60 s entre deux chunks, **à partir du premier**.
 *
 * Le chiffre se lit à l'échelle d'un chunk, pas d'une génération : une fois
 * parti, llama-server émet quelques tokens par seconde, et une minute de silence
 * signifie qu'il ne produit plus rien — attendre les cinq minutes du délai
 * global n'apprendrait alors rien de plus à l'athlète.
 *
 * Le silence qui **précède** le premier chunk est d'une autre nature : le
 * serveur y traite le prompt entier (pré-remplissage du contexte) avant de
 * pouvoir émettre quoi que ce soit, et ce travail-là peut dépasser la minute sur
 * CPU ou sur un GPU chargé. Le mesurer à l'aune de l'inactivité tuerait un appel
 * parfaitement sain — que le régime non streamé, lui, laisserait courir cinq
 * minutes. C'est donc le délai global ({@link AI_REQUEST_TIMEOUT_MS}) qui couvre
 * la phase de pré-remplissage, et l'inactivité qui prend le relais ensuite.
 */
export const AI_STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Modèle envoyé quand `AI_MODEL` n'est pas renseigné : llama-server ne sert de toute façon que celui qu'il a chargé. */
const DEFAULT_MODEL = 'default';

/**
 * URL absolue d'un endpoint de l'API, à partir de `AI_BASE_URL`.
 *
 * `AI_BASE_URL` désigne la **racine** du serveur (`http://192.168.1.20:8080`) et
 * non son préfixe OpenAI : les endpoints natifs de llama-server vivent hors de
 * `/v1` (`/health`, `/props`). Un `/v1` final est donc retiré — c'est l'erreur
 * de recopie la plus probable, et elle produirait sinon un
 * `/v1/v1/chat/completions` sans message compréhensible.
 *
 * Un préfixe de chemin (reverse proxy : `https://ia.exemple/llama`) est préservé,
 * d'où la concaténation plutôt qu'un `new URL(path, base)` qui l'écraserait.
 */
export function aiEndpointUrl(baseUrl: string, path: `/${string}`): string {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${root}${path}`;
}

/**
 * Racine configurée de l'API.
 *
 * @throws {AiUnavailableError} `unconfigured` si `AI_BASE_URL` est absente — il
 * n'y a alors littéralement aucune adresse à appeler.
 */
function requireBaseUrl(): string {
  const baseUrl = env.AI_BASE_URL;
  if (baseUrl === undefined) throw new AiUnavailableError('unconfigured');
  return baseUrl;
}

/** En-tête d'authentification, absent tant qu'aucune clé n'est configurée (llama.cpp local n'en demande pas). */
export function aiAuthHeaders(): Record<string, string> {
  const apiKey = env.AI_API_KEY;
  return apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };
}

/** Un tour de conversation, au format d'échange OpenAI. */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatCompletionOptions = {
  messages: ChatMessage[];
  temperature?: number;
  /** Plafond de tokens générés. Omis, c'est le serveur qui décide. */
  maxTokens?: number;
  /** Délai de garde de l'appel. Défaut : {@link AI_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Appelé à chaque chunk reçu, avec le **nombre total** de caractères
   * accumulés depuis le début de la génération.
   *
   * Sa seule présence bascule l'appel en streaming (cf. l'en-tête) : le contenu
   * rendu reste le même, il arrive simplement par morceaux. Le callback doit
   * être bon marché — il est appelé des centaines de fois sur un plan.
   */
  onProgress?: (receivedChars: number) => void;
};

/**
 * Enveloppe de réponse, réduite à ce que le module consomme.
 *
 * Les champs inconnus (`usage`, `timings` de llama.cpp…) sont ignorés ; une
 * enveloppe de **forme** inattendue lève, plutôt que de rendre une chaîne vide
 * qui se propagerait comme une réponse du coach.
 */
const chatCompletionEnvelopeSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

/**
 * Un chunk de flux, réduit à ce que le module consomme.
 *
 * Beaucoup plus permissif que l'enveloppe non-streamée, et c'est délibéré : le
 * premier chunk ne porte souvent que le rôle (`delta: { role: 'assistant' }`),
 * le dernier que `finish_reason`, et certains serveurs intercalent un chunk
 * d'`usage` sans le moindre choix. Aucun de ces cas n'est une anomalie — seule
 * une forme franchement inattendue (un `content` non textuel) doit lever.
 */
const chatCompletionChunkSchema = z.object({
  choices: z
    .array(z.object({ delta: z.object({ content: z.string().nullish() }).optional() }))
    .optional(),
});

/**
 * Le message d'un événement d'**erreur** émis dans le flux, s'il y en a un.
 *
 * Une panne survenue après les en-têtes ne peut plus se dire par un statut HTTP :
 * llama-server la publie comme un événement de plus (`data: {"error":{…}}`,
 * typiquement un contexte dépassé), puis ferme. Ce payload traverse sans bruit le
 * schéma de chunk — `choices` y est facultatif — et l'appel finirait en « réponse
 * vide » statut 200, en perdant justement la seule explication disponible.
 *
 * Garde à la main plutôt que schéma Zod : la forme du champ n'est pas
 * standardisée (chaîne chez les uns, objet `{ message, type, code }` chez les
 * autres), et une union qui n'épouserait pas exactement le cas rencontré
 * retomberait dans le silence qu'on cherche à supprimer. Ici, la **présence**
 * d'un `error` non vide suffit à lever ; son contenu ne sert qu'à formuler.
 */
function streamErrorMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return null;

  const { error } = payload;
  // Certains relais posent `error: null` sur les chunks sains : ce n'est pas une panne.
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return 'cause non précisée par le serveur';
}

/** Chemins des champs en défaut, pour un message d'erreur exploitable. */
function describeIssues(issues: readonly AiOutputIssue[]): string {
  return issues.map((issue) => issue.path.join('.') || '(racine)').join(', ');
}

/** Préfixe d'une ligne d'événement SSE porteuse de données. */
const SSE_DATA_PREFIX = 'data:';

/** Sentinelle de fin de flux du format OpenAI. */
const SSE_DONE = '[DONE]';

/** Ce qu'une ligne du flux apporte : un fragment de contenu, la fin, ou rien. */
type StreamEvent = { content: string } | 'done' | null;

/**
 * Décode une ligne du flux.
 *
 * Tout ce qui n'est pas une ligne `data:` est ignoré sans bruit : lignes vides
 * de séparation des événements, commentaires de maintien de connexion (`: ping`)
 * et champs `event:`/`id:` du protocole SSE. Une ligne `data:` illisible, en
 * revanche, est une vraie anomalie de protocole — la taire produirait un plan
 * amputé de ce chunk, sans que rien ne le signale. Idem pour un événement
 * d'erreur du serveur (cf. {@link streamErrorMessage}), qui met fin au flux.
 */
function parseStreamLine(line: string, status: number): StreamEvent {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith(SSE_DATA_PREFIX)) return null;

  const payload = trimmed.slice(SSE_DATA_PREFIX.length).trim();
  if (payload === SSE_DONE) return 'done';

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new AiResponseError('Flux du coach IA illisible (chunk JSON invalide).', status, {
      cause,
    });
  }

  const failure = streamErrorMessage(parsed);
  if (failure !== null) {
    throw new AiResponseError(
      `Le coach IA a interrompu la génération : ${failure}`,
      status,
    );
  }

  const chunk = chatCompletionChunkSchema.safeParse(parsed);
  if (!chunk.success) {
    throw new AiResponseError(
      `Chunk du coach IA inattendu (champs en défaut : ${describeIssues(chunk.error.issues)}).`,
      status,
    );
  }
  return { content: chunk.data.choices?.[0]?.delta?.content ?? '' };
}

/**
 * Accumule le contenu d'une réponse streamée, en signalant l'avancement.
 *
 * Le délai de silence est **couru contre la lecture** plutôt que confié au seul
 * `AbortController` : un flux peut se taire sans que la socket ne meure, et la
 * lecture attendrait alors indéfiniment un chunk qui ne vient plus. La course
 * garantit la sortie ; `abort` derrière elle libère la requête HTTP.
 *
 * Deux durées, parce que deux silences différents : `firstChunkMs` couvre le
 * pré-remplissage du prompt (le reste du délai de garde global), `idleMs` le
 * silence entre deux chunks une fois la génération partie — cf.
 * {@link AI_STREAM_IDLE_TIMEOUT_MS}.
 *
 * @throws {AiResponseError} corps absent, ou chunk hors protocole.
 * @throws {AiUnavailableError} `unreachable` si le flux se tait trop longtemps.
 */
async function readStreamedContent(
  response: Response,
  onProgress: (receivedChars: number) => void,
  timeouts: { firstChunkMs: number; idleMs: number },
  abort: () => void,
): Promise<string> {
  const body = response.body;
  if (body === null) {
    throw new AiResponseError('Flux du coach IA vide (aucun corps de réponse).', response.status);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();

  let rejectIdle: (error: unknown) => void = () => {};
  const idle = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  // La course peut être déjà finie quand le minuteur tombe : sans ce `catch`, le
  // rejet serait « non traité » et abattrait le processus Node.
  void idle.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Vrai dès le premier chunk : le pré-remplissage est fini, la génération parle. */
  let started = false;

  const armSilenceGuard = (): void => {
    const delayMs = started ? timeouts.idleMs : timeouts.firstChunkMs;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      abort();
      rejectIdle(
        new AiUnavailableError('unreachable', {
          cause: new Error(
            started
              ? `Flux interrompu : aucun chunk reçu depuis ${delayMs} ms.`
              : `Flux muet : rien n'est arrivé dans les ${delayMs} ms du délai de garde.`,
          ),
        }),
      );
    }, delayMs);
  };

  let buffer = '';
  let content = '';

  /** Accumule un fragment et signale l'avancement. Rend `true` sur `[DONE]`. */
  const consume = (line: string): boolean => {
    const event = parseStreamLine(line, response.status);
    if (event === null) return false;
    if (event === 'done') return true;
    if (event.content === '') return false;
    content += event.content;
    onProgress(content.length);
    return false;
  };

  try {
    armSilenceGuard();

    reading: for (;;) {
      const result = await Promise.race([reader.read(), idle]);
      if (result.done) {
        // Flux clos sans sentinelle : le dernier événement peut n'avoir jamais
        // reçu son saut de ligne, et il dort alors dans le tampon. L'y laisser
        // amputerait la réponse d'un fragment, silencieusement — c'est-à-dire
        // produirait un JSON tronqué que rien n'expliquerait.
        buffer += decoder.decode();
        consume(buffer);
        break;
      }
      // Le premier octet reçu fait basculer la garde du délai global vers le
      // délai d'inactivité : à partir d'ici, c'est le silence qui est suspect.
      started = true;
      armSilenceGuard();

      buffer += decoder.decode(result.value, { stream: true });
      // Un chunk réseau ne s'aligne pas sur les lignes du flux : le dernier
      // morceau, peut-être incomplet, reste en attente du chunk suivant.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (consume(line)) break reading;
      }
    }
  } catch (cause) {
    if (cause instanceof AiResponseError || cause instanceof AiUnavailableError) throw cause;
    // Connexion rompue en plein flux : du point de vue de l'appelant, c'est la
    // même panne qu'un `fetch` qui n'aboutit pas.
    throw new AiUnavailableError('unreachable', { cause });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Sans `await` : une annulation en concurrence d'une lecture pendante peut
    // ne jamais se régler, et l'appel est de toute façon déjà terminé pour nous.
    void reader.cancel().catch(() => {});
  }

  return content;
}

/**
 * Le contenu d'une réponse non streamée : une enveloppe JSON, un seul message.
 *
 * @throws {AiResponseError} corps illisible ou enveloppe de forme inattendue.
 */
async function readJsonContent(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new AiResponseError('Réponse du coach IA illisible (JSON invalide).', response.status, {
      cause,
    });
  }

  const parsed = chatCompletionEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AiResponseError(
      `Réponse du coach IA inattendue (champs en défaut : ${describeIssues(parsed.error.issues)}).`,
      response.status,
    );
  }
  return parsed.data.choices[0].message.content;
}

/**
 * Un appel de génération, du POST au contenu textuel.
 *
 * `response_format` est passé tel quel quand il est fourni : c'est le seul
 * paramètre que {@link chatCompletionJson} ajoute.
 */
async function postChatCompletion(
  options: ChatCompletionOptions & { responseFormat?: Record<string, unknown> },
): Promise<string> {
  const url = aiEndpointUrl(requireBaseUrl(), '/v1/chat/completions');
  const { onProgress } = options;
  const streaming = onProgress !== undefined;

  const body = {
    model: env.AI_MODEL ?? DEFAULT_MODEL,
    messages: options.messages,
    // `JSON.stringify` écarte les valeurs `undefined` : un paramètre non
    // renseigné n'est pas transmis, le serveur applique son propre défaut.
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    response_format: options.responseFormat,
    stream: streaming ? true : undefined,
  };

  // Deux régimes de garde, un seul à la fois.
  //
  // Hors streaming, le délai global couvre l'appel entier : faute de savoir ce
  // qui se passe pendant l'attente, la durée totale est la seule mesure
  // disponible.
  //
  // En streaming, il couvre l'établissement de la réponse **et** l'attente du
  // premier chunk : entre les deux, le serveur pré-remplit son contexte avec le
  // prompt, un silence qui peut durer sans qu'il se passe quoi que ce soit
  // d'anormal (cf. `AI_STREAM_IDLE_TIMEOUT_MS`). C'est seulement à partir du
  // premier chunk que la durée totale cesse de vouloir dire quelque chose — un
  // plan de douze semaines écrit par un petit modèle local dépasse
  // légitimement cinq minutes — et que le délai d'inactivité prend le relais.
  const timeoutMs = options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const startedAt = Date.now();
  const headersTimer = streaming ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...aiAuthHeaders() },
      body: JSON.stringify(body),
      signal: streaming ? controller.signal : AbortSignal.timeout(timeoutMs),
      // Une génération n'est jamais une réponse à mettre en cache.
      cache: 'no-store',
    });
  } catch (cause) {
    // Panne réseau, hôte injoignable ou délai de garde dépassé : du point de vue
    // de l'appelant, c'est un coach indisponible — pas une erreur applicative.
    throw new AiUnavailableError('unreachable', { cause });
  } finally {
    // Les en-têtes sont là (ou l'appel a échoué) : la garde passe le relais à
    // celle de la lecture, qui court sur ce qu'il reste du délai global.
    clearTimeout(headersTimer);
  }

  // Avant toute lecture du corps : en streaming comme en JSON, un statut d'erreur
  // porte un message, pas un flux d'événements.
  if (!response.ok) {
    // Le corps d'erreur ne sera jamais lu, mais la requête, elle, est ouverte :
    // sans abandon explicite, la connexion resterait à la charge du pool undici
    // jusqu'au ramassage. Hors streaming, `AbortSignal.timeout` tient le signal
    // et ce contrôleur ne pilote rien — l'abandonner ne libérerait rien.
    if (streaming) controller.abort();
    throw new AiResponseError(
      `Le coach IA a répondu HTTP ${response.status}.`,
      response.status,
    );
  }

  const content = streaming
    ? await readStreamedContent(
        response,
        onProgress,
        {
          // Ce qu'il reste du délai global une fois les en-têtes obtenus : le
          // pré-remplissage n'a pas droit à un second budget de cinq minutes.
          firstChunkMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
          idleMs: AI_STREAM_IDLE_TIMEOUT_MS,
        },
        () => controller.abort(),
      )
    : await readJsonContent(response);

  if (content.trim() === '') {
    throw new AiResponseError('Le coach IA a renvoyé une réponse vide.', response.status);
  }
  return content;
}

/**
 * Une génération de texte libre.
 *
 * @throws {AiUnavailableError} `unconfigured` sans `AI_BASE_URL`, `unreachable`
 * sur panne réseau ou délai de garde dépassé.
 * @throws {AiResponseError} sur statut non-2xx, enveloppe illisible ou contenu vide.
 */
export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
  return postChatCompletion(options);
}

export type ChatCompletionJsonOptions<T> = ChatCompletionOptions & {
  /** Nom du schéma transmis au serveur (identifiant libre, exigé par le format). */
  schemaName: string;
  /** JSON Schema **fourni par l'appelant**, qui contraint la génération. */
  jsonSchema: Record<string, unknown>;
  /** Schéma Zod qui valide et type le résultat côté application. */
  schema: z.ZodType<T>;
};

/**
 * Une génération structurée : la sortie est contrainte par `jsonSchema` côté
 * serveur, puis re-validée par `schema` côté application.
 *
 * La double validation n'est pas redondante : la grammaire garantit la
 * **forme** du JSON, pas ses invariants métier (bornes, énumérations
 * dépendantes), et rien ne dit qu'un provider tiers honore réellement
 * `response_format`.
 *
 * @throws {AiUnavailableError} / {@link AiResponseError} — cf. {@link chatCompletion}.
 * @throws {AiInvalidOutputError} si le contenu n'est pas du JSON, ou ne satisfait
 * pas `schema` (les anomalies Zod sont portées par l'erreur).
 */
export async function chatCompletionJson<T>(options: ChatCompletionJsonOptions<T>): Promise<T> {
  const content = await postChatCompletion({
    messages: options.messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    // Le streaming ne change ni la contrainte de grammaire ni la validation qui
    // suit : c'est le même JSON, reçu au fil de l'eau.
    onProgress: options.onProgress,
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: options.schemaName,
        schema: options.jsonSchema,
        // Omis hors llama.cpp : cf. « `strict` n'est envoyé qu'à llama.cpp »
        // en tête de module.
        ...(env.AI_PROVIDER === 'llamacpp' ? { strict: true } : {}),
      },
    },
  });

  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (cause) {
    throw new AiInvalidOutputError(
      `Le coach IA n'a pas produit du JSON pour « ${options.schemaName} ».`,
      [],
      { cause },
    );
  }

  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    throw new AiInvalidOutputError(
      `Sortie du coach IA hors schéma « ${options.schemaName} » (champs en défaut : ${describeIssues(parsed.error.issues)}).`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}
