"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { BellOff, BellRing, Loader2, RefreshCw, Send, Share } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import {
  sendTestNotificationAction,
  setPushPreferenceAction,
  subscribeToPushAction,
  unsubscribeFromPushAction,
} from "../_lib/push-actions";
import {
  PUSH_ACTION_IDLE,
  type PushActionState,
  type PushPreferenceKey,
  type PushSettings,
} from "../_lib/push-state";

/**
 * Section « Notifications ».
 *
 * ## Sept états, sept explications
 *
 * Un bouton inerte sans phrase est le pire résultat possible ici : le push
 * échoue pour des raisons parfaitement invisibles (clés absentes côté serveur,
 * navigateur sans API, permission refusée au niveau du système, et surtout
 * l'application iOS pas encore posée sur l'écran d'accueil). Chacune de ces
 * situations a donc son bandeau et sa marche à suivre.
 *
 * ## Le cas iOS, qui est le vrai sujet
 *
 * Sur iPhone, le push **n'existe pas** dans Safari : il n'existe que pour une
 * web app ajoutée à l'écran d'accueil et rouverte depuis son icône. Tant que
 * l'application n'est pas installée, `window.PushManager` est absent — et un
 * simple « ton navigateur ne gère pas les notifications » serait faux et sans
 * issue. On détecte donc l'appareil **avant** de conclure à l'absence de
 * support, et on affiche la manipulation exacte.
 *
 * ## Pourquoi pas `useActionState`
 *
 * Il n'y a pas de formulaire. L'abonnement est une séquence d'appels aux API du
 * navigateur (`Notification.requestPermission`, `serviceWorker.register`,
 * `pushManager.subscribe`) qui doit démarrer **dans le gestionnaire de clic** —
 * la permission ne se demande qu'à partir d'un geste de l'utilisatrice. Le
 * résultat des Server Actions vit donc dans un état local, et le panneau
 * n'affiche qu'un seul bandeau.
 *
 * ## L'état « abonné » ne se lit pas dans le seul navigateur
 *
 * Un `PushSubscription` côté navigateur ne prouve pas qu'une notification
 * arrivera : il faut que le serveur connaisse cette endpoint (`deviceCount`) et
 * que l'abonnement ait été signé avec la clé VAPID **courante**. Les deux se
 * désaccordent pour de vrai — une rotation des clés côté serveur, une ligne
 * purgée par un 410, une base restaurée — et le désaccord est silencieux :
 * l'envoi part, le service de push répond 403, et plus rien n'arrive jamais
 * alors que l'écran affiche « cet appareil reçoit tes notifications ». On
 * confronte donc les trois, et chaque désaccord a sa sortie.
 *
 * **Aucun bouton accent ici** : l'accent des réglages est l'enregistrement du
 * profil (cf. `forecast-location-panel.tsx`, même parti pris).
 */

const INTRO =
  "Trainarr peut te prévenir sur ton téléphone : ta séance du jour, l'analyse d'une sortie qui vient d'arriver, et les propositions du coach. Les notifications s'activent appareil par appareil.";

/**
 * Où en est cet appareil. Calculé après le montage — toutes ces réponses
 * dépendent d'API du navigateur, et les deviner au rendu serveur produirait une
 * erreur d'hydratation.
 */
type DeviceState =
  /** Avant la première inspection : ni bouton ni bandeau, rien à promettre. */
  | "checking"
  /** Le serveur n'a pas ses clés VAPID : rien n'est activable, où que ce soit. */
  | "server-disabled"
  /** Ni service worker ni PushManager — un navigateur qui ne sait pas faire. */
  | "unsupported"
  /** iPhone/iPad, application pas encore posée sur l'écran d'accueil. */
  | "ios-not-installed"
  /** Permission refusée : seuls les réglages du système peuvent la rendre. */
  | "denied"
  /** Tout est en place, cet appareil n'est pas encore abonné. */
  | "ready"
  /**
   * L'abonnement du navigateur a été signé avec une **autre** clé VAPID que
   * celle du serveur : les envois sont refusés (403) et rien n'arrive. Un
   * `subscribe()` avec la clé courante lèverait `InvalidStateError` tant que
   * l'ancien abonnement vit — le seul chemin est de le retirer d'abord.
   */
  | "stale-key"
  /** Cet appareil est abonné, et le serveur le sait. */
  | "subscribed";

/**
 * `true` sur un appareil iOS.
 *
 * Deux familles à reconnaître : les iPhone/iPod et les iPad anciens, qui se
 * nomment ; et **iPadOS ≥ 13, qui se déclare « Macintosh »** — seul l'écran
 * tactile le trahit (un Mac n'a pas de points de contact multiples).
 */
function isIosDevice(): boolean {
  const agent = navigator.userAgent;
  if (/iPhone|iPod|iPad/.test(agent)) return true;

  return agent.includes("Macintosh") && navigator.maxTouchPoints > 1;
}

/**
 * `true` quand la page tourne en application installée.
 *
 * Deux réponses, parce qu'aucune n'est universelle : `display-mode: standalone`
 * est la forme standard (Android, desktop, iOS récents), et `navigator.standalone`
 * la forme historique d'iOS, seule disponible sur les versions antérieures.
 */
function isStandaloneDisplay(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;

  // `navigator.standalone` n'existe pas dans les types du DOM : le `in` le
  // narrow proprement, sans aucune assertion.
  return "standalone" in navigator && navigator.standalone === true;
}

/** `true` si le navigateur a les trois API sans lesquelles rien n'est possible. */
function supportsPush(): boolean {
  return (
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  );
}

/**
 * Convertit la clé publique VAPID (base64url) en octets, seule forme que
 * `pushManager.subscribe` accepte pour `applicationServerKey`.
 *
 * `atob` ne lit que du base64 standard : on rétablit le remplissage et on
 * retourne les deux caractères que l'alphabet URL-safe a substitués.
 */
function vapidKeyToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));

  // Tampon explicite : `new Uint8Array(longueur)` produit un `ArrayBufferLike`,
  // que `applicationServerKey` (qui exige un `BufferSource`) refuse.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * L'abonnement du navigateur a-t-il été signé avec la clé publique que le
 * serveur utilise **aujourd'hui** ?
 *
 * C'est la seule façon de voir venir une rotation des clés VAPID. Sans ce test,
 * l'écran affiche « cet appareil reçoit tes notifications » alors que chaque
 * envoi se fait refuser en 403 — un code que l'envoi ne purge pas (il n'efface
 * que sur 404/410, qui disent que l'endpoint n'existe plus), si bien que la
 * ligne survit et que le compte d'appareils continue d'annoncer 1.
 *
 * Rend `true` dans les deux cas où l'on **ne peut rien conclure** : un navigateur
 * qui n'expose pas la clé de l'abonnement, ou une clé serveur illisible.
 * Inventer un désaccord ferait proposer une réparation à qui n'a rien de cassé.
 */
function signedWithCurrentKey(subscription: PushSubscription, publicKey: string): boolean {
  const signed = subscription.options.applicationServerKey;
  if (signed === null) return true;

  let expected: Uint8Array;
  try {
    expected = vapidKeyToBytes(publicKey);
  } catch (error) {
    console.error("[push] clé publique illisible", error);
    return true;
  }

  const current = new Uint8Array(signed);
  if (current.length !== expected.length) return false;
  return current.every((byte, index) => byte === expected[index]);
}

/** Les trois interrupteurs, dans l'ordre où ils comptent au quotidien. */
const PREFERENCES: ReadonlyArray<{
  key: PushPreferenceKey;
  label: string;
  hint: string;
}> = [
  {
    key: "dailySession",
    label: "Séance du jour",
    hint: "Le matin, ce que ton plan prévoit aujourd'hui.",
  },
  {
    key: "activityAnalyzed",
    label: "Séance analysée",
    hint: "Quand une sortie vient d'être importée et analysée.",
  },
  {
    key: "suggestions",
    label: "Propositions du coach",
    hint: "Ajustements de plan, FC max ou FC seuil à confirmer.",
  },
];

export type PushPanelProps = {
  push: PushSettings;
};

export function PushPanel({ push }: PushPanelProps) {
  const uid = useId();

  const [device, setDevice] = useState<DeviceState>("checking");
  const [feedback, setFeedback] = useState<PushActionState>(PUSH_ACTION_IDLE);
  const [preferences, setPreferences] = useState(push.preferences);
  const [pending, startTransition] = useTransition();
  /**
   * L'attente d'une **séquence** — activation, réparation, désactivation.
   *
   * `useTransition` ne couvre que l'appel serveur ; or la moitié lente de
   * l'activation est côté navigateur (`requestPermission`, `register`,
   * `serviceWorker.ready`, `subscribe`), et peut durer plusieurs secondes. Sans
   * cet état, le bouton reste actif tout ce temps et un second appui relance la
   * séquence depuis le début.
   */
  const [busy, setBusy] = useState(false);
  const working = busy || pending;
  /** Le verrou du double appui : synchrone, là où `busy` attend un rendu. */
  const running = useRef(false);

  /**
   * Inspection au montage : on ne s'abonne à rien, on regarde seulement où en
   * est cet appareil. `getRegistration` plutôt que `register` — poser un service
   * worker est un effet de bord, et il n'a lieu qu'à l'activation.
   */
  useEffect(() => {
    let cancelled = false;
    const settle = (next: DeviceState) => {
      if (!cancelled) setDevice(next);
    };

    const inspect = async (): Promise<void> => {
      const publicKey = push.publicKey;
      if (publicKey === null) return settle("server-disabled");

      // **Avant** le test de support : sur iPhone non installé, `PushManager`
      // est absent, et conclure « navigateur incompatible » serait faux.
      if (isIosDevice() && !isStandaloneDisplay()) return settle("ios-not-installed");

      if (!supportsPush()) return settle("unsupported");
      if (Notification.permission === "denied") return settle("denied");

      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = (await registration?.pushManager.getSubscription()) ?? null;
        if (subscription === null) return settle("ready");

        // Le désaccord de clé **avant** le compte d'appareils, et l'ordre n'est
        // pas cosmétique : avec un abonnement signé par l'ancienne clé, « prêt »
        // proposerait un bouton « Activer » dont le `subscribe()` lèverait
        // `InvalidStateError`. Il faut retirer l'abonnement d'abord.
        if (!signedWithCurrentKey(subscription, publicKey)) return settle("stale-key");

        // Le navigateur est abonné, le serveur ne connaît aucun appareil : la
        // ligne a été purgée (410) ou la base restaurée. On ne se ré-enregistre
        // **pas** en douce — une écriture déclenchée par le seul affichage d'un
        // écran est exactement ce que le projet interdit, et elle masquerait la
        // panne qu'elle vient de constater. On revient à « prêt » : le bouton
        // « Activer » réenregistre l'abonnement existant en un geste, visible.
        if (push.deviceCount === 0) return settle("ready");

        settle("subscribed");
      } catch (error) {
        console.error("[push] inspection de l'abonnement impossible", error);
        settle("ready");
      }
    };

    void inspect();
    return () => {
      cancelled = true;
    };
  }, [push.publicKey, push.deviceCount]);

  /**
   * Une action serveur, son résultat dans le bandeau. Jamais d'exception qui
   * remonte — et le résultat est **rendu**, pour que l'appelant enchaîne
   * (retirer puis réabonner) sans deviner si la première moitié a marché.
   *
   * La transition entoure l'appel : c'est elle qui garde la page réactive
   * pendant la revalidation qui suit.
   */
  const run = useCallback((action: () => Promise<PushActionState>): Promise<PushActionState> => {
    return new Promise<PushActionState>((resolve) => {
      startTransition(async () => {
        try {
          const result = await action();
          setFeedback(result);
          resolve(result);
        } catch (error) {
          console.error("[push] action impossible", error);
          const failed: PushActionState = {
            status: "error",
            message: "Le réglage n'a pas pu être enregistré. Réessaie.",
          };
          setFeedback(failed);
          resolve(failed);
        }
      });
    });
  }, []);

  /**
   * Lance une séquence sous un seul état d'attente, et refuse le second appui.
   *
   * Le verrou est un `ref` : `busy` ne devient vrai qu'au rendu suivant, ce qui
   * laisse passer deux appuis rapprochés — et deux `subscribe()` concurrents.
   */
  const startSequence = useCallback((sequence: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFeedback(PUSH_ACTION_IDLE);

    void sequence()
      .catch((error: unknown) => {
        console.error("[push] séquence impossible", error);
        setFeedback({
          status: "error",
          message: "Les notifications n'ont pas pu être réglées. Réessaie.",
        });
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }, []);

  /**
   * Activation, **depuis le clic** : `Notification.requestPermission()` doit
   * partir du geste de l'utilisatrice, un appel au montage serait ignoré (et,
   * sur certains navigateurs, compté comme un refus).
   *
   * La séquence brute, sans son état d'attente : {@link startSequence} le porte,
   * et la réparation la réutilise telle quelle après avoir retiré l'abonnement
   * périmé.
   */
  const runEnable = useCallback(async (): Promise<void> => {
    const publicKey = push.publicKey;
    if (publicKey === null) return;

    // `PushSubscriptionJSON` (type du DOM) ne garantit **aucun** de ses champs :
    // ils sont tous optionnels. C'est vérifié plus bas, avant l'envoi.
    let subscriptionJson: PushSubscriptionJSON;
    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setDevice("denied");
        return;
      }
      if (permission !== "granted") {
        // « default » : la demande a été refermée sans répondre. Rien à dire de
        // définitif, l'appui suivant reposera la question.
        setFeedback({
          status: "error",
          message: "Permission non accordée : réessaie et accepte la demande du système.",
        });
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      // Le worker doit être actif avant qu'on lui demande un abonnement.
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        // Obligatoire : engage l'application à afficher une notification à
        // chaque message reçu. `public/sw.js` en affiche une même quand le
        // payload est illisible, précisément pour tenir cet engagement.
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToBytes(publicKey),
      });
      subscriptionJson = subscription.toJSON();
    } catch (error) {
      console.error("[push] abonnement impossible", error);
      setFeedback({
        status: "error",
        message: "Cet appareil n'a pas pu s'abonner. Réessaie dans un instant.",
      });
      return;
    }

    const endpoint = subscriptionJson.endpoint;
    const p256dh = subscriptionJson.keys?.p256dh;
    const auth = subscriptionJson.keys?.auth;
    if (endpoint === undefined || p256dh === undefined || auth === undefined) {
      setFeedback({
        status: "error",
        message: "Cet abonnement est incomplet : réessaie depuis l'application installée.",
      });
      return;
    }

    const result = await run(() =>
      subscribeToPushAction({ endpoint, p256dh, auth, userAgent: navigator.userAgent }),
    );
    if (result.status === "success") setDevice("subscribed");
  }, [push.publicKey, run]);

  /**
   * Retire cet appareil : la ligne en base d'abord, l'abonnement du navigateur
   * ensuite. Dans cet ordre — un `unsubscribe()` réussi suivi d'un échec serveur
   * laisserait une endpoint morte que plus rien ne désignerait.
   *
   * Rend `false` quand le serveur a refusé : rien n'a bougé, et l'appelant ne
   * doit ni annoncer un retrait ni enchaîner un réabonnement.
   */
  const forget = useCallback(async (): Promise<boolean> => {
    let existing: PushSubscription | null = null;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      existing = (await registration?.pushManager.getSubscription()) ?? null;
    } catch (error) {
      console.error("[push] lecture de l'abonnement impossible", error);
    }

    // Rien côté navigateur : il n'y a rien à retirer, l'écran se remet d'aplomb.
    if (existing === null) return true;

    const subscription = existing;
    const result = await run(() => unsubscribeFromPushAction({ endpoint: subscription.endpoint }));
    if (result.status !== "success") return false;

    try {
      await subscription.unsubscribe();
    } catch (error) {
      // La ligne est partie : l'appareil ne recevra plus rien, quoi qu'il
      // arrive à cet abonnement orphelin côté navigateur.
      console.error("[push] désabonnement du navigateur impossible", error);
    }
    return true;
  }, [run]);

  /** Activation, sous son état d'attente. */
  const enable = useCallback(() => {
    startSequence(runEnable);
  }, [runEnable, startSequence]);

  /** Désactivation, sous le même état d'attente. */
  const disable = useCallback(() => {
    startSequence(async () => {
      if (await forget()) setDevice("ready");
    });
  }, [forget, startSequence]);

  /**
   * Réparation après une rotation des clés VAPID : **retirer, puis réabonner**.
   *
   * Les deux moitiés sont obligatoires et dans cet ordre : tant que l'abonnement
   * signé par l'ancienne clé vit, un `subscribe()` avec la nouvelle lève
   * `InvalidStateError`. C'est aussi pour ça que la réparation est un bouton et
   * non une consigne : personne ne devinerait qu'il faut désactiver pour
   * réactiver.
   */
  const repair = useCallback(() => {
    startSequence(async () => {
      if (!(await forget())) return;
      await runEnable();
    });
  }, [forget, runEnable, startSequence]);

  /** Bascule locale immédiate, puis écriture — remise en place si elle échoue. */
  const togglePreference = useCallback(
    (key: PushPreferenceKey, value: boolean) => {
      const previous = preferences[key];
      setPreferences((current) => ({ ...current, [key]: value }));

      startTransition(async () => {
        try {
          const result = await setPushPreferenceAction({ key, value });
          setFeedback(result);
          if (result.status !== "success") {
            setPreferences((current) => ({ ...current, [key]: previous }));
          }
        } catch (error) {
          console.error("[push] réglage impossible", error);
          setPreferences((current) => ({ ...current, [key]: previous }));
          setFeedback({
            status: "error",
            message: "Le réglage n'a pas pu être enregistré. Réessaie.",
          });
        }
      });
    },
    [preferences],
  );

  return (
    <Panel title="Notifications">
      <div aria-live="polite" className={feedback.status === "idle" ? "sr-only" : "mb-4"}>
        {feedback.status === "success" ? (
          <Banner tone="positive" title={feedback.message ?? "Réglage enregistré."} />
        ) : null}
        {feedback.status === "error" ? (
          <Banner
            tone="negative"
            title={feedback.message ?? "Le réglage n'a pas été enregistré."}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-5">
        <p className="text-[0.82rem] leading-relaxed text-fg-muted">{INTRO}</p>

        {/* 1. Le serveur n'a pas ses clés : aucun appareil ne peut s'abonner,
            et ça ne se répare que dans l'environnement du serveur. */}
        {device === "server-disabled" ? (
          <Banner tone="neutral" title="Notifications inactives sur ce serveur.">
            {push.disabledMessage ??
              "Les clés VAPID ne sont pas renseignées dans l'environnement du serveur."}
          </Banner>
        ) : null}

        {/* 2. Un navigateur qui ne sait pas faire — Firefox iOS, un vieux
            desktop, un contexte non sécurisé. */}
        {device === "unsupported" ? (
          <Banner tone="neutral" title="Ce navigateur ne gère pas les notifications.">
            Ouvre Trainarr depuis Safari (iPhone), Chrome ou Firefox : ce sont eux qui
            savent recevoir des notifications.
          </Banner>
        ) : null}

        {/* 3. Le cas important : iPhone, application pas encore installée. */}
        {device === "ios-not-installed" ? (
          <Banner tone="neutral" title="Ajoute d'abord Trainarr à ton écran d'accueil.">
            <p>
              Sur iPhone et iPad, les notifications n’existent que pour une application
              installée — pas dans un onglet Safari.
            </p>
            <ol className="mt-2 flex list-decimal flex-col gap-1 pl-4">
              <li className="flex items-center gap-1.5">
                <span>Touche le bouton Partager</span>
                <Share aria-hidden="true" strokeWidth={1.7} className="size-3.5" />
                <span>en bas de Safari.</span>
              </li>
              <li>Choisis « Sur l’écran d’accueil ».</li>
              <li>Rouvre Trainarr depuis son icône, puis reviens ici.</li>
            </ol>
          </Banner>
        ) : null}

        {/* 4. Permission refusée : l'application ne peut plus redemander. */}
        {device === "denied" ? (
          <Banner tone="negative" title="Notifications refusées sur cet appareil.">
            Une fois refusée, la permission ne peut plus être redemandée par
            l’application : elle se réactive dans les réglages du système (iPhone :
            Réglages → Notifications → Trainarr), puis reviens ici.
          </Banner>
        ) : null}

        {/* 5. Prêt : le seul geste possible est d'activer. */}
        {device === "ready" ? (
          <div className="flex flex-col gap-3">
            <Banner tone="neutral" title="Cet appareil ne reçoit pas encore de notification.">
              Le système va te demander l’autorisation : c’est le seul moment où il peut
              le faire.
            </Banner>
            <Button
              type="button"
              variant="secondary"
              disabled={working}
              aria-busy={working}
              onClick={enable}
              className="w-full sm:w-auto"
            >
              {working ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <BellRing aria-hidden="true" />
              )}
              Activer les notifications
            </Button>
          </div>
        ) : null}

        {/* 6. Les clés du serveur ont changé : l'abonnement de cet appareil
            signe avec l'ancienne, tout est refusé, et rien ne le dirait. */}
        {device === "stale-key" ? (
          <div className="flex flex-col gap-3">
            <Banner tone="negative" title="Cet appareil doit être réenregistré.">
              Les clés de notification du serveur ont changé depuis que cet appareil s’est
              abonné : ses notifications sont refusées et n’arrivent plus. Le bouton
              ci-dessous retire l’ancien abonnement et en crée un nouveau.
            </Banner>
            <Button
              type="button"
              variant="secondary"
              disabled={working}
              aria-busy={working}
              onClick={repair}
              className="w-full sm:w-auto"
            >
              {working ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              Réenregistrer cet appareil
            </Button>
          </div>
        ) : null}

        {/* 7. Abonné : les appareils, les catégories, le test, la sortie. */}
        {device === "subscribed" ? (
          <div className="flex flex-col gap-5">
            <Banner
              tone="positive"
              title={
                push.deviceCount <= 1
                  ? "Cet appareil reçoit tes notifications."
                  : `Tes notifications partent vers ${push.deviceCount} appareils.`
              }
            >
              Les catégories ci-dessous valent pour tous tes appareils ; le bouton du bas
              ne désactive que celui-ci.
            </Banner>

            <fieldset className="min-w-0">
              <legend className="text-[0.85rem] font-medium text-fg">Ce que tu reçois</legend>
              <div className="mt-2 flex flex-col divide-y divide-border">
                {PREFERENCES.map((preference) => {
                  const id = `${uid}-${preference.key}`;
                  return (
                    <div key={preference.key} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <label
                          htmlFor={id}
                          className="block text-[0.85rem] font-medium text-fg"
                        >
                          {preference.label}
                        </label>
                        <p
                          id={`${id}-hint`}
                          className="text-[0.76rem] leading-snug text-fg-faint"
                        >
                          {preference.hint}
                        </p>
                      </div>
                      <Switch
                        id={id}
                        checked={preferences[preference.key]}
                        disabled={working}
                        aria-describedby={`${id}-hint`}
                        onCheckedChange={(next) => togglePreference(preference.key, next)}
                      />
                    </div>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex flex-col gap-2">
              <p className="text-[0.76rem] leading-snug text-fg-faint">
                Le test part cinq secondes après l’appui : de quoi verrouiller ton
                téléphone et voir la vraie bannière du système.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={working}
                  aria-busy={working}
                  onClick={() => void run(() => sendTestNotificationAction())}
                  className="w-full sm:w-auto"
                >
                  {working ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                  Envoyer une notification de test
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  disabled={working}
                  aria-busy={working}
                  onClick={disable}
                  className="w-full sm:w-auto"
                >
                  <BellOff aria-hidden="true" />
                  Désactiver sur cet appareil
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
