import 'server-only';

/**
 * La boucle des notifications : un cycle par minute, un passage par athlète.
 *
 * ## Ce qu'elle porte, et ce qu'elle ne porte pas
 *
 * Deux des trois déclencheurs (cf. `./notices.ts`) sont **périodiques** et
 * passent par ici : le rappel de la séance du jour, puis les décisions à
 * valider. Le troisième — l'analyse d'une séance importée — est
 * **événementiel** : l'ingestion l'appelle elle-même, il n'a rien à faire dans
 * une boucle qui repasse toutes les minutes.
 *
 * Elle porte en plus un **entretien** : `push_notices` est de l'anti-doublon,
 * pas de l'historique, et la boucle est le seul endroit du système qui repasse
 * régulièrement sans requête. Une fois par jour, elle efface ce qui est périmé
 * (cf. {@link maybePurgeNotices}).
 *
 * ## Rien n'est planifié
 *
 * Même parti pris que la météo et le bien-être : aucun ordonnanceur, aucun état
 * en mémoire. Le cycle repasse et **redemande** ; ce qui empêche de renvoyer,
 * c'est `push_notices` en base (cf. `claimNotice`). C'est ce qui donne le
 * rattrapage gratuitement — une application redéployée à 7 h 30 notifie au
 * premier cycle qui suit son retour — et ce qui rend un redémarrage inoffensif.
 *
 * ## L'ordre des gardes n'est pas négociable
 *
 * Par athlète et par cycle :
 *
 * 1. **aucun abonnement → on sort sans rien réclamer.** C'est la garde la plus
 *    importante du module. Sans elle, une installation qui tourne une semaine
 *    avant que Gwen n'active les notifications sur son téléphone aurait brûlé
 *    sept marqueurs de séance du jour et toutes ses propositions en attente : le
 *    jour où elle s'abonne, plus rien ne part ;
 * 2. **catégorie désactivée → on la saute sans rien réclamer**, pour la même
 *    raison — un interrupteur remis sur « oui » doit redonner ses notifications,
 *    pas un silence hérité de la période où il était sur « non » ;
 * 3. le rappel du jour, puis les propositions.
 *
 * ## Elle ne peut pas emporter le serveur HTTP
 *
 * Trois filets, comme les deux autres services : chaque déclencheur attrape ce
 * qu'il sait nommer, chaque tour de boucle attrape le reste, et
 * {@link runForever} relance ce qui aurait dû la tuer. Une bannière non partie
 * ne coûte jamais une application.
 */

import { listAthleteIds } from '@/data/athlete';
import { getPushPreferencesFor, listSubscriptions, purgeStaleNotices } from '@/data/push';
import { createStopControls, type StopControls } from '@/lib/services/stop-controls';

import { resolvePushConfig, type PushConfig } from './config';
import {
  releaseSuggestionNotices,
  runDailySessionNotice,
  runSuggestionNotices,
} from './notices';
import { REMINDER_HOUR, REMINDER_WINDOW_HOURS } from './reminder-plan';

/**
 * Cadence du cycle — la même que la météo et le rapatriement intervals.icu.
 *
 * Une minute est très en dessous de ce que ces déclencheurs demandent (le rappel
 * a six heures de fenêtre, une proposition n'est pas pressée), mais aligner les
 * trois services évite d'avoir à se demander lequel tourne à quelle cadence
 * quand on lit les journaux — et le cycle ne coûte que quelques lectures
 * indexées quand il n'y a rien à faire.
 */
const CYCLE_INTERVAL_MS = 60_000;

/**
 * Délai avant de relancer la boucle sur une erreur qu'aucun de ses gardes
 * n'avait prévue — même valeur et même raison que dans les deux autres services.
 */
const LOOP_RESTART_DELAY_MS = 30_000;

/**
 * Cadence de l'entretien de `push_notices` — **une fois par jour**, et surtout
 * pas à chaque cycle.
 *
 * La table est de l'anti-doublon, pas de l'historique : elle gagne une ligne par
 * matinée et par athlète, plus une par séance importée (cf.
 * `NOTICE_RETENTION_DAYS`). Un `DELETE` par minute pour effacer, au mieux, une
 * ligne par jour serait une requête d'écriture gratuite toutes les soixante
 * secondes ; une par jour suffit très largement à empêcher la table de croître.
 */
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

function log(message: string): void {
  console.log(`[push] ${message}`);
}

function logError(message: string): void {
  console.error(`[push] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/*
 * Un cycle.
 */

/** Ce qu'un cycle a envoyé, tous comptes confondus. */
type CycleReport = {
  reminders: number;
  suggestions: number;
};

function emptyReport(): CycleReport {
  return { reminders: 0, suggestions: 0 };
}

function totalOf(report: CycleReport): number {
  return report.reminders + report.suggestions;
}

/** Compte rendu d'un cycle, dans l'ordre où ça intéresse quelqu'un qui lit les logs. */
function cycleSummary(report: CycleReport): string {
  const parts: string[] = [];
  if (report.reminders > 0) parts.push(`${report.reminders} rappel(s) de séance`);
  if (report.suggestions > 0) parts.push(`${report.suggestions} envoi(s) de propositions`);
  return parts.join(', ');
}

/**
 * Un cycle pour un athlète.
 *
 * Ses erreurs sont attrapées **par l'appelant**, athlète par athlète : un compte
 * dont la lecture échoue ne doit pas priver les autres de leurs notifications.
 */
async function runCycleForAthlete(athleteId: number, report: CycleReport): Promise<void> {
  // La garde précoce : aucun appareil, donc aucun message possible — et surtout
  // aucun marqueur à brûler (cf. l'en-tête du module).
  if ((await listSubscriptions(athleteId)).length === 0) return;

  const preferences = await getPushPreferencesFor(athleteId);

  // Le compte porte sur les notifications **réclamées**, pas sur les appareils
  // servis : un envoi qui échoue journalise déjà son propre motif (`sendToAthlete`),
  // et un cycle qui a brûlé un marqueur ne doit pas se lire « rien à envoyer ».
  if (preferences.dailySession) {
    if ((await runDailySessionNotice(athleteId)) !== null) report.reminders += 1;
  }

  if (preferences.suggestions) {
    if ((await runSuggestionNotices(athleteId)) !== null) report.suggestions += 1;
  } else {
    // Éteindre la catégorie coupe l'envoi **et** la tenue des clés : sans ce
    // balayage, une réclamation faite avant l'extinction resterait détenue pour
    // toujours et bâillonnerait la proposition suivante (cf. l'en-tête de
    // `releaseSuggestionNotices`).
    await releaseSuggestionNotices(athleteId);
  }
}

type LoopState = {
  /** Le premier cycle annonce toujours son résultat, même vide : c'est la réponse à « est-ce que ça marche ? ». */
  announcedFirstCycle: boolean;
  /**
   * Quand `push_notices` a été balayée pour la dernière fois, `null` tant que ça
   * n'a pas eu lieu — l'entretien passe donc au premier cycle après un
   * démarrage, puis une fois par jour.
   */
  lastPurgeAtMs: number | null;
};

/**
 * L'entretien de la table d'idempotence, à cadence lente.
 *
 * Ne peut pas priver un cycle de ses notifications : il a lieu **après** le
 * passage des athlètes, et son erreur est attrapée ici. La date est notée
 * **avant** l'appel — une base momentanément injoignable ne doit pas faire
 * réessayer la purge à chaque cycle de soixante secondes.
 */
async function maybePurgeNotices(state: LoopState): Promise<void> {
  const now = Date.now();
  if (state.lastPurgeAtMs !== null && now - state.lastPurgeAtMs < PURGE_INTERVAL_MS) return;
  state.lastPurgeAtMs = now;

  try {
    const removed = await purgeStaleNotices();
    if (removed > 0) log(`${removed} réservation(s) de notification périmée(s) effacée(s).`);
  } catch (error) {
    logError(`entretien des réservations impossible — ${errorMessage(error)}`);
  }
}

/**
 * La boucle : un tour = un cycle **par athlète**.
 *
 * Aucun athlète n'en fait échouer un autre. Une base injoignable ne dit **rien**
 * de ce qu'il y avait à envoyer : elle se journalise comme une panne, jamais
 * comme un service au repos.
 */
async function pushLoop(controls: StopControls, state: LoopState): Promise<void> {
  while (!controls.stopping) {
    const report = emptyReport();
    let scanned = false;

    try {
      for (const athleteId of await listAthleteIds()) {
        if (controls.stopping) break;
        try {
          await runCycleForAthlete(athleteId, report);
        } catch (error) {
          if (!controls.stopping) {
            logError(`compte ${athleteId} : cycle impossible — ${errorMessage(error)}`);
          }
        }
      }
      scanned = true;
    } catch (error) {
      // L'énumération des comptes elle-même a échoué : ce n'est pas « rien à
      // envoyer », c'est une base injoignable, et ça se dit.
      if (!controls.stopping) logError(`cycle impossible — ${errorMessage(error)}`);
    }

    if (!controls.stopping) await maybePurgeNotices(state);

    if (!controls.stopping && scanned) {
      // Un cycle sans rien à dire se tait pour ne pas noyer les journaux — sauf
      // le premier après un démarrage, qui annonce toujours son résultat.
      if (totalOf(report) > 0) {
        log(cycleSummary(report) + '.');
      } else if (!state.announcedFirstCycle) {
        log('aucune notification à envoyer pour le moment.');
      }
      state.announcedFirstCycle = true;
    }

    if (controls.stopping) break;
    await controls.sleep(CYCLE_INTERVAL_MS);
  }
}

/**
 * Dernier recours : ce qui aurait dû tuer la boucle la relance à la place. Rien
 * des notifications ne doit pouvoir faire tomber le serveur HTTP.
 */
async function runForever(loop: () => Promise<void>, controls: StopControls): Promise<void> {
  while (!controls.stopping) {
    try {
      await loop();
      return;
    } catch (error) {
      if (controls.stopping) return;
      logError(
        `erreur inattendue (${errorMessage(error)}) — reprise dans ${LOOP_RESTART_DELAY_MS / 1_000} s.`,
      );
      await controls.sleep(LOOP_RESTART_DELAY_MS);
    }
  }
}

export type PushService = {
  /**
   * Demande l'arrêt : le drapeau est levé **synchroniquement**. La promesse
   * rendue se résout quand la boucle a rendu la main — un confort, pas une
   * garantie (Next appelle `process.exit` dès sa propre fermeture faite). Sans
   * conséquence ici : une notification réclamée puis interrompue est perdue, ce
   * qui est déjà le contrat de `claimNotice`.
   */
  stop(): Promise<void>;
};

/** Un service inerte : le contrat est rendu, mais aucune boucle ne tourne. */
const IDLE_SERVICE: PushService = { stop: () => Promise.resolve() };

/**
 * Démarre la boucle des notifications et rend la main aussitôt.
 *
 * **Ne démarre rien sans clés VAPID** : sans elles aucun envoi ne peut aboutir,
 * et faire tourner une boucle qui réclamerait des marqueurs pour des messages
 * qui ne partiront jamais serait pire que de ne rien faire — le jour où les clés
 * arrivent, tout aurait déjà été « déjà envoyé ». Le service rend alors un
 * `stop()` inerte, comme le service FIT quand sa configuration est illisible.
 *
 * Ne lève jamais : tout ce qui peut mal se passer est journalisé et laisse le
 * serveur HTTP intact.
 */
export function startPushService(): PushService {
  let config: PushConfig;
  try {
    config = resolvePushConfig();
  } catch (error) {
    logError(
      `rappels inactifs — environnement illisible : ${errorMessage(error)}. L'application continue de servir.`,
    );
    return IDLE_SERVICE;
  }

  if (config.status === 'disabled') {
    // `logPushActivation` vient de journaliser le motif **et** la marche à
    // suivre au démarrage (cf. `src/instrumentation-node.ts`) : le répéter mot
    // pour mot ferait deux fois la même ligne au boot. Ici on dit seulement ce
    // que devient **la boucle**.
    logError('rappels inactifs — notifications non configurées. L’application continue de servir.');
    return IDLE_SERVICE;
  }

  const controls = createStopControls();

  log(
    `rappels démarrés — séance du jour à ${REMINDER_HOUR} h locales (fenêtre de ${REMINDER_WINDOW_HOURS} h), décisions à valider à chaque cycle de ${CYCLE_INTERVAL_MS / 1_000} s.`,
  );

  const state: LoopState = { announcedFirstCycle: false, lastPurgeAtMs: null };
  const running = runForever(() => pushLoop(controls, state), controls)
    .then(() => {
      log('rappels arrêtés.');
    })
    .catch((error: unknown) => {
      // Filet ultime : `runForever` attrape déjà tout ce qu'il sait nommer.
      logError(`rappels arrêtés sur une erreur imprévue : ${errorMessage(error)}`);
    });

  return {
    stop(): Promise<void> {
      controls.requestStop();
      return running;
    },
  };
}
