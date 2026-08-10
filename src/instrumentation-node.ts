import 'server-only';

/**
 * Démarrage du service d'import FIT, côté runtime Node uniquement.
 *
 * Module à effet de bord : le simple fait de l'importer démarre le service.
 * C'est `src/instrumentation.ts` qui le fait, une fois, et seulement quand
 * `NEXT_RUNTIME === 'nodejs'`.
 *
 * ## L'arrêt doit être synchrone
 *
 * Next installe son propre gestionnaire de SIGTERM/SIGINT, qui termine par
 * `process.exit(143)` dès sa fermeture faite. Mesuré sur un build standalone :
 * une continuation asynchrone de 5 ms placée après le signal **n'a déjà plus la
 * main**. Tout ce qui compte dans `stop()` se fait donc synchroniquement (lever
 * le drapeau d'arrêt, annuler les appels réseau en vol) ; la promesse qu'il
 * retourne est un confort, pas une garantie.
 *
 * Ce n'est pas un problème : le dépôt d'un fichier rapatrié passe par
 * `.part` + renommage atomique, et l'idempotence de l'ingestion tient à
 * l'empreinte SHA-256 en base. Une coupure au pire moment laisse un temporaire
 * que le prochain scan balaiera.
 */

import { startFitService } from '@/lib/fit/service';

// Ne lève jamais et rend la main aussitôt : le serveur n'attend pas l'import
// pour commencer à servir.
const service = startFitService();

// Un Ctrl+C dans un shell interactif envoie SIGINT à toute la descendance : le
// gestionnaire peut être appelé plusieurs fois, une seule ligne suffit.
let stopped = false;

const shutdown = (signal: NodeJS.Signals): void => {
  if (stopped) return;
  stopped = true;
  console.log(`[fit] ${signal} reçu — arrêt du service FIT.`);
  void service.stop();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
