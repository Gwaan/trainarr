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
 * ## Deux garde-fous
 *
 * - **Aucun appel ne peut rester suspendu** : chaque requête porte un délai de
 *   garde ({@link AI_REQUEST_TIMEOUT_MS} par défaut). Il est volontairement
 *   large — un petit modèle local (6 Go de VRAM) met des minutes à écrire un
 *   plan d'entraînement, et une génération lente n'est pas une panne.
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

/** Chemins des champs en défaut, pour un message d'erreur exploitable. */
function describeIssues(issues: readonly AiOutputIssue[]): string {
  return issues.map((issue) => issue.path.join('.') || '(racine)').join(', ');
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

  const body = {
    model: env.AI_MODEL ?? DEFAULT_MODEL,
    messages: options.messages,
    // `JSON.stringify` écarte les valeurs `undefined` : un paramètre non
    // renseigné n'est pas transmis, le serveur applique son propre défaut.
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    response_format: options.responseFormat,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...aiAuthHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS),
      // Une génération n'est jamais une réponse à mettre en cache.
      cache: 'no-store',
    });
  } catch (cause) {
    // Panne réseau, hôte injoignable ou délai de garde dépassé : du point de vue
    // de l'appelant, c'est un coach indisponible — pas une erreur applicative.
    throw new AiUnavailableError('unreachable', { cause });
  }

  if (!response.ok) {
    throw new AiResponseError(
      `Le coach IA a répondu HTTP ${response.status}.`,
      response.status,
    );
  }

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

  const content = parsed.data.choices[0].message.content;
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
