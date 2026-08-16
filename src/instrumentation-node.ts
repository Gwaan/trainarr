import 'server-only';

/**
 * Démarrage des services de fond, côté runtime Node uniquement : l'import FIT
 * (surveillance du dossier, rapatriement intervals.icu) et le rattrapage de la
 * météo des séances.
 *
 * Module à effet de bord : le simple fait de l'importer démarre les services.
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
import { logPushActivation } from '@/lib/push/config';
import { startPushService } from '@/lib/push/service';
import { startWeatherService } from '@/lib/weather/service';

// Pas un service : aucune boucle, aucun arrêt à orchestrer. Juste une ligne au
// démarrage — une installation sans clés VAPID doit l'apprendre ici, et non au
// premier envoi silencieusement raté. Ne lève jamais.
logPushActivation();

// Ne lèvent jamais et rendent la main aussitôt : le serveur n'attend ni l'import,
// ni la météo, ni les notifications pour commencer à servir. Sans clés VAPID,
// `startPushService` ne démarre aucune boucle et rend un `stop()` inerte.
const services = [startFitService(), startWeatherService(), startPushService()];

// Un Ctrl+C dans un shell interactif envoie SIGINT à toute la descendance : le
// gestionnaire peut être appelé plusieurs fois, une seule ligne suffit.
let stopped = false;

const shutdown = (signal: NodeJS.Signals): void => {
  if (stopped) return;
  stopped = true;
  console.log(`[fit] ${signal} reçu — arrêt des services de fond.`);
  for (const service of services) void service.stop();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
