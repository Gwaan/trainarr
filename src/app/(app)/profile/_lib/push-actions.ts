'use server';

/**
 * Server Actions du bloc « Notifications » : enregistrer l'abonnement d'un
 * appareil, le retirer, basculer une catégorie, et déclencher la notification
 * de test.
 *
 * Minces par construction : vérifier la session → valider (Zod) → déléguer au
 * DAL → revalider.
 *
 * **Elles ne prennent pas de `FormData`, et c'est assumé.** Ce que le navigateur
 * a à transmettre ici, c'est un objet `PushSubscription` produit par une API du
 * navigateur au sein d'un gestionnaire de clic — il n'y a pas de formulaire, et
 * la permission système doit être demandée depuis le geste lui-même. L'écran les
 * appelle donc directement, dans une transition.
 *
 * Ces actions sont des endpoints publics appelables par POST direct : chacune
 * vérifie la session **dans son corps**, avant toute validation, et le DAL borne
 * ensuite tout à l'athlète de cette session — une endpoint fournie par le client
 * ne peut désigner l'abonnement de personne d'autre.
 *
 * **Ce qu'elles renvoient est sérialisé vers le client** : un statut et une
 * phrase. Jamais une trace d'exécution, jamais une clé.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { AthleteNotFoundError, getCurrentAthleteId } from '@/data/athlete';
import {
  countSubscriptions,
  PushEndpointOwnedError,
  removeSubscription,
  saveSubscription,
  setPushPreferences,
  type PushPreferences,
} from '@/data/push';
import { getSession } from '@/data/session';
import { SESSION_REQUIRED_MESSAGE } from '@/lib/auth/messages';
import { isKnownPushEndpoint, UNKNOWN_PUSH_HOST_MESSAGE } from '@/lib/push/endpoint';
import { scheduleTestNotification, TEST_NOTIFICATION_DELAY_MS } from '@/lib/push/test-notification';

import { PUSH_PREFERENCE_KEYS, type PushActionState } from './push-state';

/**
 * L'abonnement tel que le navigateur le remet — `subscription.toJSON()`, à
 * peine remis en forme par l'écran.
 *
 * Bornes hautes sur chaque champ : ces valeurs viennent d'un appel direct
 * possible, et rien n'oblige un appelant à envoyer ce qu'un vrai navigateur
 * enverrait. Les endpoints réelles font quelques centaines de caractères, les
 * clés moins de cent.
 */
const subscriptionSchema = z.object({
  endpoint: z
    .url({ error: 'Abonnement invalide.' })
    .max(2000, 'Abonnement invalide.')
    // Le protocole Web Push n'existe qu'en HTTPS : une endpoint en clair ne
    // serait pas une adresse de service de push.
    .refine((value) => value.startsWith('https://'), 'Abonnement invalide.')
    // **Et surtout : un hôte de service de push connu.** « Une URL https » ne
    // borne rien — `https://postgres:5432/` la satisfait, et c'est le serveur
    // qui postera dessus à chaque notification (SSRF aveugle). Le compromis de
    // l'allowlist est documenté dans `@/lib/push/endpoint`.
    .refine(isKnownPushEndpoint, UNKNOWN_PUSH_HOST_MESSAGE),
  p256dh: z.string().min(1, 'Abonnement invalide.').max(255, 'Abonnement invalide.'),
  auth: z.string().min(1, 'Abonnement invalide.').max(255, 'Abonnement invalide.'),
  // Purement descriptif (distinguer ses appareils dans l'UI) : tronqué plutôt
  // que refusé, un agent utilisateur exotique ne doit pas empêcher un abonnement.
  userAgent: z.string().trim().max(300).optional(),
});

/** Le désabonnement ne porte que l'endpoint : le DAL fait le reste sous l'athlète. */
const endpointSchema = z.object({
  endpoint: z.url({ error: 'Abonnement invalide.' }).max(2000, 'Abonnement invalide.'),
});

/** Un interrupteur : quelle catégorie, et sa nouvelle valeur. */
const preferenceSchema = z.object({
  key: z.enum(PUSH_PREFERENCE_KEYS, { error: 'Réglage inconnu.' }),
  value: z.boolean(),
});

const SUBSCRIBED_MESSAGE =
  'Notifications activées sur cet appareil. Tu peux tester juste en dessous.';
const UNSUBSCRIBED_MESSAGE =
  'Notifications désactivées sur cet appareil. Tes autres appareils, eux, continuent de recevoir.';
const PREFERENCE_MESSAGE = 'Réglage enregistré.';
const TEST_MESSAGE = `Notification envoyée dans ${Math.round(
  TEST_NOTIFICATION_DELAY_MS / 1000,
)} secondes — verrouille ton téléphone pour la voir arriver.`;

const NO_PROFILE_MESSAGE = "Aucun profil enregistré : crée-le d'abord, puis reviens ici.";

/**
 * Ce que voit l'utilisatrice quand l'appareil est déjà enregistré ailleurs.
 *
 * Il **ne dit pas** à quel compte : l'endpoint vient du client, et confirmer
 * qu'elle appartient à quelqu'un renseignerait celui qui l'a devinée. Il dit le
 * geste qui répare — le navigateur fabrique une nouvelle endpoint après un
 * désabonnement.
 */
const ENDPOINT_TAKEN_MESSAGE =
  'Cet appareil ne peut pas être enregistré ici. Désactive les notifications sur cet appareil, puis réactive-les.';

const NO_DEVICE_MESSAGE =
  'Aucun appareil ne reçoit tes notifications : active-les d’abord sur celui-ci.';

/**
 * Traduit une erreur du DAL en état d'écran. Aucune trace d'exécution ne
 * franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 */
function failure(error: unknown, generic: string): PushActionState {
  if (error instanceof AthleteNotFoundError) {
    return { status: 'error', message: NO_PROFILE_MESSAGE };
  }

  if (error instanceof PushEndpointOwnedError) {
    return { status: 'error', message: ENDPOINT_TAKEN_MESSAGE };
  }

  console.error('[profile] réglage des notifications impossible :', error);
  return { status: 'error', message: `${generic} Réessaie.` };
}

/**
 * Enregistre l'abonnement de l'appareil courant.
 *
 * L'entrée est typée `unknown` : elle vient du navigateur, et c'est Zod qui
 * décide de sa forme — pas la signature.
 */
export async function subscribeToPushAction(input: unknown): Promise<PushActionState> {
  if ((await getSession()) === null) {
    return { status: 'error', message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) {
    // Un seul motif de refus a sa propre phrase : l'hôte inconnu. C'est le seul
    // que l'utilisatrice puisse rencontrer avec un vrai navigateur (le jour où
    // un service de push change de domaine), et un « pas exploitable » générique
    // n'y laisserait aucune piste.
    const unknownHost = parsed.error.issues.some(
      (issue) => issue.message === UNKNOWN_PUSH_HOST_MESSAGE,
    );
    return {
      status: 'error',
      message: unknownHost ? UNKNOWN_PUSH_HOST_MESSAGE : "Cet abonnement n'est pas exploitable.",
    };
  }

  try {
    await saveSubscription(parsed.data);
  } catch (error) {
    return failure(error, "L'abonnement n'a pas été enregistré.");
  }

  revalidatePath('/', 'layout');
  return { status: 'success', message: SUBSCRIBED_MESSAGE };
}

/** Retire l'abonnement de cet appareil — et de lui seul. */
export async function unsubscribeFromPushAction(input: unknown): Promise<PushActionState> {
  if ((await getSession()) === null) {
    return { status: 'error', message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = endpointSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'error', message: "Cet abonnement n'est pas exploitable." };
  }

  try {
    await removeSubscription(parsed.data.endpoint);
  } catch (error) {
    return failure(error, "L'abonnement n'a pas été retiré.");
  }

  revalidatePath('/', 'layout');
  return { status: 'success', message: UNSUBSCRIBED_MESSAGE };
}

/**
 * Bascule **une** catégorie.
 *
 * Une seule, et pas les trois : deux onglets ouverts sur les réglages
 * écraseraient sinon les changements l'un de l'autre à chaque clic.
 */
export async function setPushPreferenceAction(input: unknown): Promise<PushActionState> {
  if ((await getSession()) === null) {
    return { status: 'error', message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = preferenceSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'error', message: "Ce réglage n'existe pas." };
  }

  const { key, value } = parsed.data;
  // Énuméré plutôt que construit par clé calculée : une propriété calculée
  // depuis une union produit un type à index libre, qui ne prouve plus que
  // seules ces trois colonnes peuvent être écrites.
  const change: Partial<PushPreferences> =
    key === 'dailySession'
      ? { dailySession: value }
      : key === 'activityAnalyzed'
        ? { activityAnalyzed: value }
        : { suggestions: value };

  try {
    await setPushPreferences(change);
  } catch (error) {
    return failure(error, "Le réglage n'a pas été enregistré.");
  }

  revalidatePath('/', 'layout');
  return { status: 'success', message: PREFERENCE_MESSAGE };
}

/**
 * Programme la notification de test, puis rend la main **aussitôt**.
 *
 * Le délai est tout l'intérêt du bouton : il laisse le temps de verrouiller le
 * téléphone, seul moyen de voir la vraie bannière système plutôt qu'un affichage
 * en premier plan. L'action, elle, ne reste pas ouverte cinq secondes — c'est un
 * timer du process serveur qui porte l'attente (cf.
 * `src/lib/push/test-notification.ts`).
 *
 * Elle ne passe **pas** par `claimNotice` : un test doit pouvoir se rejouer
 * autant de fois qu'on veut.
 *
 * ## Ce qu'elle refuse avant de promettre quoi que ce soit
 *
 * C'est le bouton dont le rôle est de **prouver** que la chaîne marche :
 * annoncer « envoyée dans 5 secondes » sans savoir s'il existe un abonnement
 * serait exactement le contraire de sa fonction. Un athlète sans aucun appareil
 * enregistré est donc refusé sur-le-champ, en le disant.
 *
 * Le reste de la chaîne (clés refusées, endpoint morte, service de push en
 * panne) ne se découvre qu'à l'envoi, cinq secondes plus tard, hors de cette
 * requête : ça reste dans les journaux du container, et l'absence de bannière
 * sur le téléphone est le signal. Attendre l'envoi ici tiendrait la requête
 * ouverte et retirerait au test sa seule raison d'être — le délai.
 */
export async function sendTestNotificationAction(): Promise<PushActionState> {
  if ((await getSession()) === null) {
    return { status: 'error', message: SESSION_REQUIRED_MESSAGE };
  }

  let athleteId: number | null;
  let deviceCount: number;
  try {
    athleteId = await getCurrentAthleteId();
    deviceCount = athleteId === null ? 0 : await countSubscriptions();
  } catch (error) {
    return failure(error, "La notification de test n'a pas pu être programmée.");
  }

  if (athleteId === null) {
    return { status: 'error', message: NO_PROFILE_MESSAGE };
  }

  if (deviceCount === 0) {
    return { status: 'error', message: NO_DEVICE_MESSAGE };
  }

  scheduleTestNotification(athleteId);
  return { status: 'success', message: TEST_MESSAGE };
}
