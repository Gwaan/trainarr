/**
 * Erreurs du socle IA.
 *
 * Nommées et typées, pour que l'appelant (Server Action, service métier)
 * distingue les trois échecs qui appellent des réactions différentes, sans
 * jamais inspecter un message :
 *
 * - {@link AiUnavailableError} — le coach n'est pas joignable : ce n'est pas une
 *   panne de l'application, l'UI le dit et suspend les fonctions IA ;
 * - {@link AiResponseError} — l'API a répondu, mais pas ce qu'elle devrait ;
 * - {@link AiInvalidOutputError} — le modèle a produit une sortie hors contrat.
 *
 * Module sans effet de bord ni lecture d'environnement : il n'est pas
 * `server-only`, pour qu'un service testable puisse s'y référer librement.
 */

import type { z } from 'zod';

/**
 * Pourquoi le coach est indisponible.
 *
 * - `unconfigured` : `AI_BASE_URL` n'est pas renseignée — aucune API à joindre,
 *   c'est un choix de configuration, pas un incident ;
 * - `unreachable` : l'API est configurée mais ne répond pas (hôte éteint, modèle
 *   en cours de chargement, réseau coupé).
 */
export type AiUnavailableReason = 'unconfigured' | 'unreachable';

/** Le coach IA n'est pas joignable : les fonctions IA sont suspendues. */
export class AiUnavailableError extends Error {
  readonly reason: AiUnavailableReason;

  constructor(reason: AiUnavailableReason, options?: ErrorOptions) {
    super(
      reason === 'unconfigured'
        ? "Coach IA non configuré : renseigner AI_BASE_URL pour activer les fonctions IA."
        : "Coach IA injoignable : l'API configurée par AI_BASE_URL n'a pas répondu.",
      options,
    );
    this.name = 'AiUnavailableError';
    this.reason = reason;
  }
}

/**
 * L'API a répondu, mais sa réponse est inexploitable : statut non-2xx, corps
 * illisible, ou enveloppe de chat completion qui n'a pas la forme attendue.
 */
export class AiResponseError extends Error {
  /** Code HTTP reçu, `null` quand l'échec ne se rattache à aucune réponse. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AiResponseError';
    this.status = status;
  }
}

/** Une anomalie relevée par Zod sur la sortie du modèle. */
export type AiOutputIssue = z.ZodError['issues'][number];

/**
 * Le modèle a généré du texte, mais il ne respecte pas le contrat demandé : JSON
 * illisible, ou JSON valide qui ne passe pas le schéma Zod de l'appelant.
 *
 * Distinguée de {@link AiResponseError} parce que la réaction diffère : là où une
 * réponse HTTP cassée signale une panne d'infrastructure, une sortie hors
 * contrat est le comportement attendu d'un petit modèle — l'appelant peut
 * relancer, dégrader, ou renoncer en le disant.
 */
export class AiInvalidOutputError extends Error {
  /** Anomalies remontées par Zod. Vide quand le contenu n'était même pas du JSON. */
  readonly issues: readonly AiOutputIssue[];

  constructor(message: string, issues: readonly AiOutputIssue[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = 'AiInvalidOutputError';
    this.issues = issues;
  }
}
