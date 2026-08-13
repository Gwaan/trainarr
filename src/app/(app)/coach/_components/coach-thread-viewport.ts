/**
 * Le fil de la conversation est une fenêtre à défilement propre, pas une liste
 * qui pousse la page. Ces classes-là sont la fenêtre ; elles sont partagées par
 * le fil réel (`coach-conversation.tsx`) et son squelette
 * (`coach-skeleton.tsx`), qui doivent avoir exactement la même géométrie — sans
 * quoi l'arrivée des données ferait sauter la page.
 *
 * ## Pourquoi un plafond, et pourquoi celui-ci
 *
 * `max-h`, jamais `h` : une conversation de deux messages doit occuper deux
 * messages, pas une zone vide de la taille d'un écran.
 *
 * Le plafond vise le moment où la page est descendue au bas du fil — c'est là
 * qu'on écrit, et c'est ce moment-là qui doit tenir dans le viewport. Ce qui
 * reste alors à l'écran autour du fil, sur mobile :
 *
 * | `MobileHeader`, `sticky` en haut          | 3,5rem + `safe-area-inset-top`    |
 * | en-tête du `Panel` (« Conversation »)     | ~2,25rem                          |
 * | la saisie, une ligne                      | ~8,5rem                           |
 * | `pb` du `<main>` (bottom-nav `fixed`)     | 5rem + `safe-area-inset-bottom`   |
 *
 * Soit 19,25rem de décor, arrondis à **20rem** pour un peu d'air, plus les deux
 * encoches — qui ne sont pas négligeables en PWA installée (59 px en haut sur un
 * iPhone à Dynamic Island) et qu'il faut donc retrancher explicitement. Sur
 * desktop, la sidebar est latérale, le header mobile disparaît et le `pb` tombe
 * à 4rem : le décor y est plus léger que la formule, qui reste donc valable.
 *
 * `dvh` et non `vh` : en PWA `standalone` les deux coïncident, mais dans Safari
 * `vh` mesure le viewport barres d'outils masquées, donc un fil plus haut que
 * l'écran réel — exactement ce qu'on veut éviter.
 *
 * Le plancher de 14rem est là pour le paysage sur téléphone, où la soustraction
 * passerait sous zéro et ferait disparaître le fil. La page redevient alors
 * défilante, ce qui est le comportement acceptable dans 390 px de haut.
 */
export const COACH_THREAD_VIEWPORT_CLASS =
  "flex flex-col gap-5 overflow-y-auto p-4 sm:p-5 max-h-[max(14rem,calc(100dvh-20rem-env(safe-area-inset-top)-env(safe-area-inset-bottom)))]";
