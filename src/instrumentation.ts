/**
 * Code exécuté une fois au démarrage du serveur — c'est ici que naît le service
 * d'import FIT.
 *
 * ## Pourquoi ici et pas dans un container à part
 *
 * L'import tourne dans le process du serveur Next : **un seul container
 * applicatif**. `register()` est appelée une fois par instance de serveur, avant
 * qu'elle n'accepte la première requête, et le service qu'elle démarre vit aussi
 * longtemps que le process.
 *
 * ## Ce qui a été vérifié empiriquement (Next 16.3.0)
 *
 * - `register()` s'exécute bien en **build standalone** (`node server.js`), dans
 *   le runtime Node, une seule fois : le serveur standalone est un process
 *   unique, il n'y a pas un worker par cœur.
 * - Elle ne s'exécute **pas** pendant `next build` — aucun risque de démarrer
 *   des boucles d'import au moment de construire l'image.
 * - Elle s'exécute aussi en `pnpm dev`, une fois. C'est accepté : sans
 *   configuration exploitable, le service se désactive de lui-même en le disant.
 * - Un `process.on('SIGTERM')` posé depuis ici **est bien appelé** sur un `kill`
 *   du process standalone (cf. `./instrumentation-node`).
 *
 * Ce fichier-ci est compilé pour **tous** les runtimes, Edge compris : il ne
 * doit contenir aucune API Node. Tout le reste vit dans `instrumentation-node`,
 * importé dynamiquement depuis la seule branche qui le concerne.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  await import('./instrumentation-node');
}
