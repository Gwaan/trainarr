/**
 * Combien de temps un message garde du sens — la **durée de vie** confiée au
 * service de push, catégorie par catégorie.
 *
 * ## Pourquoi ce module existe
 *
 * `web-push` envoie sans TTL par défaut, ce qui vaut **quatre semaines** de
 * conservation chez le service de push : un téléphone éteint le mardi matin
 * recevrait « ta séance du jour » en le rallumant le samedi, pour une séance
 * qui n'existe plus. Le TTL est la seule pièce qui rende un message
 * **périssable** — le `tag` regroupe les bannières sur l'appareil, il n'efface
 * rien de ce qui attend dans la file du service.
 *
 * ## La règle : la durée de vie suit la nature de l'information
 *
 * - un **rappel du matin** est daté : il ne doit jamais survivre à sa journée ;
 * - une **analyse de séance** se périme lentement : la sortie reste lisible, et
 *   l'apprendre avec deux jours de retard reste une information ;
 * - une **décision à valider** attend : elle est toujours vraie tant qu'elle
 *   n'est pas tranchée ;
 * - un **test** ne prouve quelque chose que s'il arrive tout de suite ; livré
 *   une heure plus tard il ne prouve rien du tout.
 *
 * Module **pur** : rien que des durées, aucune dépendance serveur — c'est ce qui
 * permet à `./messages.ts` (pur lui aussi) de les porter dans ses payloads.
 */

/** Une heure, en secondes — l'unité de tous les TTL du protocole Web Push. */
const HOUR_S = 3_600;
const DAY_S = 24 * HOUR_S;

/**
 * Le rappel de la séance du jour : **12 heures**.
 *
 * Il part dans la fenêtre 7 h → 13 h (cf. `./reminder-plan.ts`) : au plus tard,
 * douze heures le portent jusqu'à 1 h du matin. Il ne peut donc jamais réveiller
 * quelqu'un le lendemain avec la séance de la veille — ce que le module de
 * fenêtre refuse déjà d'envoyer, et qu'un TTL trop long ferait rentrer par la
 * porte de derrière.
 */
export const DAILY_SESSION_TTL_S = 12 * HOUR_S;

/**
 * L'analyse d'une séance importée : **3 jours**.
 *
 * Elle se périme lentement — la sortie est écrite, ses chiffres ne bougent
 * plus. Trois jours couvrent un week-end passé sans téléphone ; au-delà,
 * l'application aura de toute façon été rouverte et la séance est visible dans
 * la liste, une bannière n'y ajouterait rien.
 */
export const ACTIVITY_ANALYZED_TTL_S = 3 * DAY_S;

/**
 * Les décisions à valider : **7 jours**.
 *
 * Une proposition en attente reste vraie tant qu'elle n'est pas tranchée : elle
 * n'est pas datée, et sa déduplication porte sur son contenu (cf.
 * `suggestionDedupeKey`) — une bannière perdue ne serait donc **pas** réémise.
 * D'où la durée la plus longue des quatre. Une semaine reste une borne : au-delà,
 * la valeur proposée aura probablement changé, et c'est une autre notification.
 */
export const SUGGESTION_TTL_S = 7 * DAY_S;

/**
 * La notification de test : **5 minutes**.
 *
 * Le bouton répond à « est-ce que la chaîne marche, maintenant ? ». Une bannière
 * qui arrive une heure plus tard répondrait à une autre question. Cinq minutes
 * plutôt qu'une : un appareil brièvement hors réseau ne doit pas faire conclure
 * à une panne de configuration.
 */
export const TEST_TTL_S = 5 * 60;

/**
 * Ce que vaut un payload qui n'a rien précisé : **24 heures**.
 *
 * Le choix par défaut n'est pas neutre — il s'applique à toute notification
 * future dont l'auteur n'aura pas tranché. Un jour est l'horizon au-delà duquel
 * une information d'entraînement quotidien devient du bruit, et c'est très en
 * deçà des quatre semaines de `web-push`.
 */
export const DEFAULT_PUSH_TTL_S = DAY_S;

/**
 * Le TTL par défaut de `web-push` quand aucune option n'est passée — quatre
 * semaines. Il n'est **jamais** utilisé par l'application ; il vit ici pour que
 * les tests vérifient que chacune de nos durées reste en dessous.
 */
export const WEB_PUSH_DEFAULT_TTL_S = 4 * 7 * DAY_S;
