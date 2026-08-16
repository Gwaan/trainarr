import 'server-only';

import { sendToAthlete, type PushPayload } from './send';
import { TEST_TTL_S } from './ttl';

/**
 * La notification de test — celle qu'on déclenche depuis les réglages pour
 * vérifier qu'un vrai téléphone la reçoit vraiment.
 *
 * ## Pourquoi cinq secondes
 *
 * C'est tout l'intérêt du bouton. Une notification affichée alors que
 * l'application est au premier plan ne prouve rien : sur iOS, la bannière
 * système n'apparaît que si l'appli n'a pas le focus. Le délai laisse le temps
 * de verrouiller le téléphone ou de revenir à l'écran d'accueil, et c'est
 * seulement là qu'on voit ce que verra une vraie notification.
 *
 * ## Pourquoi un timer détaché, et pourquoi c'est acceptable
 *
 * La Server Action rend la main **immédiatement** : rester ouverte cinq
 * secondes tiendrait une requête pour rien et ferait tourner un spinner sans
 * raison. Le process Node est persistant (un seul container applicatif, qui
 * porte déjà le watcher FIT et le relevé météo — cf. `src/instrumentation.ts`),
 * un `setTimeout` y survit donc sans difficulté.
 *
 * Le risque d'un timer détaché, c'est une exception non rattrapée qui ferait
 * tomber le process : d'où le `try/catch` **et** le `.catch` ci-dessous.
 * `sendToAthlete` ne lève déjà jamais ; on ne s'en remet pas à cette promesse
 * pour la survie du serveur.
 *
 * Un redémarrage entre le clic et l'échéance perd la notification. C'est
 * assumé : c'est un test, il se rejoue d'un clic.
 */

/** Le délai, et la raison d'être du bouton. Exporté pour que l'écran l'annonce. */
export const TEST_NOTIFICATION_DELAY_MS = 5_000;

/**
 * Le contenu du test.
 *
 * `url: '/profile'` ramène là d'où le test est parti — le clic sur la
 * notification doit rouvrir l'écran qui l'a déclenchée, pas le tableau de bord.
 * `tag: 'test'` fait qu'un second test **remplace** le premier sur l'appareil
 * plutôt que d'empiler des bannières identiques.
 *
 * La durée de vie est la plus courte de toutes (cf. `./ttl.ts`) : le bouton
 * répond à « est-ce que la chaîne marche, maintenant ? », et une bannière livrée
 * une heure plus tard répondrait à une autre question.
 */
const TEST_PAYLOAD: PushPayload = {
  title: 'Test Trainarr',
  body: 'Tout fonctionne : tes notifications arrivent bien sur cet appareil.',
  url: '/profile',
  tag: 'test',
  ttlSeconds: TEST_TTL_S,
};

/**
 * Programme la notification de test et rend la main aussitôt.
 *
 * Ne lève jamais, et ne peut rien faire tomber : ni la Server Action qui
 * l'appelle, ni le process qui portera le timer.
 */
export function scheduleTestNotification(athleteId: number): void {
  setTimeout(() => {
    try {
      void sendToAthlete(athleteId, TEST_PAYLOAD).catch((error: unknown) => {
        console.error('[push] notification de test impossible :', error);
      });
    } catch (error) {
      console.error('[push] notification de test impossible :', error);
    }
  }, TEST_NOTIFICATION_DELAY_MS);
}
