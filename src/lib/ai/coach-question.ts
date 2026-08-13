/**
 * Ce qu'une question au coach doit mesurer pour être recevable.
 *
 * Module volontairement **pas** `server-only`, et volontairement dans `lib/`
 * plutôt que dans le `_lib` de la route : la saisie du chat
 * (`(app)/coach/_components/coach-conversation.tsx`) borne son champ avec la
 * valeur que le serveur applique, et `lib/ai/coach-service.ts` la lit aussi —
 * le faire vivre sous `src/app/` obligerait la couche métier à dépendre d'une
 * route, ce qu'aucun module de `src/lib/` ne fait. Le client importe déjà
 * `@/lib/ai/errors` : la frontière est franchie dans ce sens-là, pas l'autre.
 *
 * Il ne doit donc jamais toucher à la base, à `env` ni à quoi que ce soit de
 * secret — seulement décrire l'échange.
 *
 * Ce que le client en fait n'est **jamais** une validation : `maxLength` et le
 * compteur de caractères sont du confort de saisie. La question est revalidée
 * par la route puis par le service, qui restent seuls à faire autorité (cf.
 * `.claude/rules/security.md`).
 */

/**
 * Bornes d'une question, en caractères, mesurées **après** détourage.
 *
 * Bien plus serrées que celles d'un message du fil (`COACH_MESSAGE_LIMITS`,
 * 8 000 caractères, qui couvrent aussi les réponses du coach) : une question de
 * 2 000 caractères est déjà une page entière, et au-delà c'est un collage qui
 * mangerait le contexte disponible pour l'historique et l'état d'entraînement.
 *
 * Source unique — `@/lib/ai/coach-service` les réexporte pour ses appelants
 * serveur plutôt que d'en tenir une seconde copie.
 */
export const COACH_QUESTION_LIMITS = { min: 1, max: 2_000 } as const;
