import 'server-only';

/**
 * Les **trois déclencheurs métier** des notifications : ce qui décide qu'il y a
 * quelque chose à dire, et ce qui l'envoie.
 *
 * Le texte, lui, vit dans `./messages.ts` (pur, testé) ; la boucle qui appelle
 * deux de ces trois fonctions vit dans `./service.ts`. Découpage identique à
 * celui de la météo (`forecast-plan` / `forecast-service` / `service`), et pour
 * la même raison : la décision se teste sans base, l'orchestration se relit sans
 * le détail des phrases.
 *
 * ## Deux natures de déclencheur, et une seule mémoire
 *
 * - **Périodiques** — {@link runDailySessionNotice} et
 *   {@link runSuggestionNotices} sont posées à chaque cycle de la boucle. Rien
 *   n'est planifié : on redemande, et c'est `claimNotice` qui tranche.
 * - **Événementiel** — {@link notifyActivityAnalyzed} est appelée par
 *   l'ingestion d'un fichier FIT, une fois, pour l'activité qu'elle vient
 *   d'écrire.
 *
 * Les trois partagent la même idempotence : un `INSERT … ON CONFLICT DO NOTHING`
 * sur `push_notices`, atomique, dont la clé porte le sens métier de l'occurrence
 * (une matinée, une activité, un genre de proposition). **Aucune table nouvelle,
 * et aucun état en mémoire** : redémarrer le container ne renvoie rien.
 *
 * ## Réclamer, c'est s'engager
 *
 * Une réclamation obtenue puis suivie d'un envoi qui échoue est perdue : elle ne
 * sera pas reprise (cf. l'en-tête de `claimNotice`). C'est le compromis voulu —
 * mieux vaut une bannière manquée qu'une boucle qui en émet une par minute
 * jusqu'au retour du réseau. On réclame donc **le plus tard possible**, une fois
 * le message composé : une lecture qui échoue (base momentanément injoignable,
 * délai de garde) ne doit jamais brûler un marqueur pour un message qui n'a
 * même pas existé.
 *
 * ## Et pour les propositions, rendre ce qui n'a plus lieu d'être
 *
 * Les décisions à valider ({@link runSuggestionNotices}) sont la seule catégorie
 * dont la clé ne désigne pas une occurrence datée mais un **état** : « une
 * proposition de FC seuil est en cours ». Sa réservation vit donc aussi
 * longtemps que la proposition, et le cycle la **rend** (`releaseNotice`) dès
 * qu'elle disparaît. Ce qui notifie, c'est la transition « absente → présente »,
 * jamais un changement de valeur — deux des quatre sont des médianes glissantes
 * qui dérivent d'un battement d'un jour à l'autre.
 *
 * ## Ce que ces fonctions ne font jamais
 *
 * - **Faire échouer l'import.** {@link notifyActivityAnalyzed} ne lève pas : une
 *   séance dont la bannière n'est pas partie reste une séance valide, et le
 *   fichier ne doit pas repartir en `failed/` pour ça.
 * - **Déduire leur athlète.** Elles tournent hors requête — boucle de fond,
 *   watcher — et le reçoivent en paramètre. Il n'y a pas de session à
 *   interroger, et il ne peut pas y en avoir.
 */

import { selectAnalyzedActivity } from '@/data/activities';
import { getAthleteById } from '@/data/athlete';
import { selectTodaySession } from '@/data/dashboard';
import { selectLthrSuggestion } from '@/data/lthr-suggestion';
import { selectMaxHrSuggestion } from '@/data/max-hr-suggestion';
import { getPendingPlanRevision } from '@/data/plan-revisions';
import {
  claimNotice,
  getPushPreferencesFor,
  listSubscriptions,
  releaseNotice,
} from '@/data/push';
import { selectRestingHrSuggestion } from '@/data/resting-hr-suggestion';
import { selectWeatherForecast } from '@/data/weather-forecast';
import { toCivilDate } from '@/lib/dates/civil';
import { resolveDayForecast } from '@/lib/weather/forecast-plan';

import {
  activityAnalyzedPayload,
  dailySessionPayload,
  SUGGESTION_KINDS,
  suggestionsPayload,
  type SuggestionBoard,
  type SuggestionNotice,
} from './messages';
import { isReminderDue, reminderMarker } from './reminder-plan';
import { sendToAthlete, type PushSendReport } from './send';

function logError(message: string): void {
  console.error(`[push] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/*
 * A. Le rappel de la séance du jour.
 */

/** Ce qu'un rappel envoyé a donné — `null` quand il n'y avait rien à envoyer. */
export type DailyNoticeReport = {
  /** La matinée réclamée, date civile. */
  marker: string;
  send: PushSendReport;
};

/**
 * Le rappel du matin : la séance planifiée du jour, et ce que la météo en dit.
 *
 * Rend `null` — sans rien réclamer — dans les quatre cas où il n'y a rien à
 * dire, et l'ordre compte :
 *
 * 1. **hors fenêtre** ({@link isReminderDue}) : avant 7 h, ou après 13 h. Le
 *    marqueur du jour reste libre, ce qui est sans effet — la fenêtre ne
 *    rouvrira que demain, sur un autre marqueur ;
 * 2. **pas de séance ce jour-là** : une journée de repos ne se notifie pas, et
 *    le marqueur reste libre exprès — si le plan publiait une séance à 9 h, le
 *    rappel partirait encore ;
 * 3. **séance déjà courue** : sortie à 5 h 30, fichier importé à 6 h 05, et à
 *    7 h une bannière « Séance du jour » contredirait la bannière « Séance
 *    analysée » partie une heure plus tôt. Ici non plus **rien n'est réclamé**,
 *    et c'est délibéré : le marqueur est un engagement à envoyer, pas une trace
 *    de passage, et le laisser libre garde ouverte la seule évolution utile de
 *    la journée — un plan republié à 9 h qui pose une **autre** séance, pas
 *    encore réalisée, doit encore pouvoir se rappeler. Le prix est de relire
 *    l'état à chaque cycle jusqu'à 13 h : une lecture indexée par minute sur une
 *    base mono-utilisateur ;
 * 4. **déjà réclamé** : la bannière du matin est partie, la boucle repasse
 *    toutes les minutes.
 *
 * **La réclamation vient en dernier, une fois le message composé.** La prévision
 * ne conditionne pas l'envoi — une séance sans prévision se rappelle très bien —
 * mais sa lecture peut échouer, et un marqueur brûlé sur une erreur de lecture
 * supprimerait le rappel de toute la journée (cf. l'en-tête du module). Relire la
 * météo à chaque cycle de la fenêtre ne coûte rien de plus que la séance du
 * jour, déjà relue à chaque cycle, et la boucle s'arrête au premier cycle
 * réussi.
 */
export async function runDailySessionNotice(
  athleteId: number,
  now: Date = new Date(),
): Promise<DailyNoticeReport | null> {
  if (!isReminderDue(now)) return null;

  const today = toCivilDate(now);
  const session = await selectTodaySession(athleteId, today);
  if (session === null || session.completed) return null;

  // La même lecture que le tableau de bord, et le même arbitrage entre « il y a
  // une prévision » et « il n'y en a pas, voici pourquoi » : la bannière ne peut
  // donc pas annoncer une autre météo que l'écran qu'elle ouvre.
  const forecast = await selectWeatherForecast(athleteId, today);
  const resolved = resolveDayForecast({
    status: forecast.status,
    days: forecast.days,
    date: today,
    today,
  });
  const payload = dailySessionPayload(session, resolved.day);

  const marker = reminderMarker(now);
  if (!(await claimNotice(athleteId, 'daily-session', marker))) return null;

  const send = await sendToAthlete(athleteId, payload);
  return { marker, send };
}

/*
 * B. L'analyse d'une séance importée.
 */

/**
 * Ancienneté au-delà de laquelle une séance importée ne s'annonce plus —
 * **48 heures**.
 *
 * Le chiffre arbitre entre deux scénarios réels, et il n'y a pas de zone grise
 * entre eux :
 *
 * - **une sortie qu'on vient de faire** arrive par HealthFit → intervals.icu →
 *   poller, soit quelques minutes plus tard ; au pire, un iPhone resté sans
 *   réseau la synchronise le lendemain. Deux jours couvrent très largement ce
 *   trajet, week-end compris — elle doit s'annoncer ;
 * - **un rattrapage d'historique** rapatrie tout depuis 2000
 *   (`MAX_DOWNLOADS_PER_CYCLE` = 50 fichiers par minute). Il arrive dès que la
 *   clé intervals.icu est saisie, et les deux réglages vivent sur la même page :
 *   activer les notifications puis coller sa clé enverrait cinquante bannières
 *   aux tags tous distincts, empilées sur l'écran verrouillé. Ces séances ont
 *   des mois — aucune n'approche la borne.
 *
 * La garde d'abonnement ne suffisait pas : elle ne couvre que « aucun appareil
 * abonné », c'est à dire l'ordre inverse des deux réglages.
 */
const ANALYZED_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

/**
 * Annonce que la séance qui vient d'être importée est analysée. **Ne lève
 * jamais.**
 *
 * Appelée en fin d'ingestion, dans le moule de `recordActivityWeather` :
 * attendue (c'est une poignée de requêtes et un appel HTTP borné), journalisée,
 * et sans aucun pouvoir de faire échouer l'import.
 *
 * **Deux gardes précèdent la réclamation**, et aucune des deux ne réclame :
 *
 * - **l'abonnement**, sans quoi un rattrapage fait sur une installation neuve
 *   brûlerait un marqueur par activité avant même que le premier téléphone ne
 *   soit abonné — ces séances ne seraient plus jamais notifiables ;
 * - **la fraîcheur** ({@link ANALYZED_MAX_AGE_MS}), qui distingue une sortie du
 *   jour d'un rattrapage d'historique. Ne rien réclamer est ici sans risque : la
 *   séance ne rajeunira pas, un réimport la retrouvera tout aussi ancienne.
 *
 * Le contenu s'arrête à ce qui existe : distance, durée, allure, et la séance du
 * plan si le rapprochement vient d'aboutir. Le suivi du plan par le coach, lui,
 * part sans être attendu et durera des minutes — cf. `./messages.ts`.
 */
export async function notifyActivityAnalyzed(
  activityId: number,
  athleteId: number,
  now: Date = new Date(),
): Promise<void> {
  try {
    if ((await listSubscriptions(athleteId)).length === 0) return;

    const preferences = await getPushPreferencesFor(athleteId);
    if (!preferences.activityAnalyzed) return;

    const activity = await selectAnalyzedActivity(activityId, athleteId);
    if (activity === null) return;

    // La fraîcheur se juge sur le **départ de la séance**, jamais sur l'arrivée
    // du fichier : c'est la date d'arrivée qui vaut « maintenant » pour les
    // cinquante fichiers d'un rattrapage.
    if (now.getTime() - activity.startedAt.getTime() > ANALYZED_MAX_AGE_MS) return;

    if (!(await claimNotice(athleteId, 'activity-analyzed', String(activityId)))) return;

    await sendToAthlete(athleteId, activityAnalyzedPayload(activity));
  } catch (error) {
    logError(`activité ${activityId} : notification d’analyse impossible — ${errorMessage(error)}`);
  }
}

/*
 * C. Les décisions à valider.
 */

/** Ce qu'un envoi de propositions a donné — `null` quand il n'y en avait aucune. */
export type SuggestionNoticeReport = {
  /** Les propositions **réclamées** à ce cycle, celles-là mêmes qui sont parties. */
  notices: SuggestionNotice[];
  send: PushSendReport;
};

/**
 * L'état des quatre propositions d'un athlète, telles que les quatre lectures du
 * DAL les rendent — `null` quand le compte n'a pas d'athlète.
 *
 * **Les absentes comptent autant que les présentes**, d'où le tableau plutôt
 * qu'une liste : c'est leur absence qui libère leur clé, et donc ce qui rendra
 * une future proposition du même genre annonçable.
 *
 * Le profil est lu **une fois** et passé aux trois propositions cardiaques :
 * elles prennent la ligne athlète en paramètre exactement pour ça (cf. le
 * doublet `selectX(profile)` / `getX()`), et le tableau de bord fait déjà de
 * même. La réévaluation de plan, elle, est persistée et se lit par l'athlète.
 */
async function collectSuggestions(
  athleteId: number,
  now: Date,
): Promise<SuggestionBoard | null> {
  const profile = await getAthleteById(athleteId);
  if (profile === null) return null;

  const [maxHr, restingHr, lthr, revision] = await Promise.all([
    selectMaxHrSuggestion(profile),
    selectRestingHrSuggestion(profile, toCivilDate(now)),
    // Sa fenêtre porte sur des instants d'activité, pas sur des jours civils :
    // elle prend l'horloge, comme sur le tableau de bord.
    selectLthrSuggestion(profile, now),
    getPendingPlanRevision(athleteId),
  ]);

  return {
    'max-hr':
      maxHr === null ? null : { kind: 'max-hr', bpm: maxHr.bpm, profileBpm: profile.maxHrBpm },
    'resting-hr':
      restingHr === null
        ? null
        : {
            kind: 'resting-hr',
            bpm: restingHr.bpm,
            measuredNights: restingHr.measuredNights,
            profileBpm: restingHr.profileBpm,
          },
    lthr: lthr === null ? null : { kind: 'lthr', bpm: lthr.bpm, profileBpm: lthr.profileBpm },
    'plan-revision':
      revision === null
        ? null
        : {
            kind: 'plan-revision',
            id: revision.id,
            direction: revision.direction,
            weeks: revision.weeks,
            before: revision.before,
            after: revision.after,
          },
  };
}

/**
 * Les propositions que l'application sait faire mais ne peut pas trancher
 * seule : FC max, FC de repos, FC seuil, réévaluation de plan.
 *
 * **Une clé par genre, tenue à jour dans les deux sens, et un seul envoi.**
 *
 * - **réclamée quand la proposition apparaît** : c'est la transition « absente →
 *   présente » qui vaut information. La valeur, elle, ne fait plus de clé — deux
 *   des quatre sont des médianes glissantes qui bougent d'un battement d'un jour
 *   à l'autre, et une bannière quotidienne pour une carte déjà vue est du
 *   harcèlement, pas du service ;
 * - **rendue quand elle disparaît** — acceptée, écartée, ou devenue sans objet.
 *   Sans cette moitié, une proposition acceptée aujourd'hui interdirait
 *   d'annoncer la suivante, dans six mois. La libération est un `DELETE` indexé
 *   qui ne trouve le plus souvent rien : le prix d'un cycle qui n'a rien à dire
 *   reste de l'ordre de la lecture ;
 * - **envoyées ensemble**, parce que quatre bannières simultanées pour un seul
 *   geste à faire, au même endroit, ne valent pas mieux qu'une.
 *
 * **Chaque genre est isolé.** Une erreur sur la deuxième proposition ne doit ni
 * perdre le marqueur de la première (déjà réclamé, plus jamais rendu si
 * l'exception remonte) ni priver les deux suivantes de leur tour : elle se
 * journalise, et le cycle continue avec ce qu'il a. `sendToAthlete`, lui, ne
 * lève pas (cf. son en-tête).
 *
 * N'écrit rien du tout quand le compte n'a pas d'athlète : il n'y a alors ni
 * proposition ni réservation à son nom.
 */
export async function runSuggestionNotices(
  athleteId: number,
  now: Date = new Date(),
): Promise<SuggestionNoticeReport | null> {
  const board = await collectSuggestions(athleteId, now);
  if (board === null) return null;

  /** Tout ce que l'écran affichera — c'est ce que la bannière doit refléter. */
  const pending: SuggestionNotice[] = [];
  /** Ce qui vient d'être réclamé à ce cycle, et donc ce qui part. */
  const fresh: SuggestionNotice[] = [];

  for (const kind of SUGGESTION_KINDS) {
    const notice = board[kind];
    try {
      if (notice === null) {
        await releaseNotice(athleteId, 'suggestion', kind);
        continue;
      }

      pending.push(notice);
      if (await claimNotice(athleteId, 'suggestion', kind)) fresh.push(notice);
    } catch (error) {
      logError(`compte ${athleteId} : proposition « ${kind} » — ${errorMessage(error)}`);
    }
  }

  if (fresh.length === 0) return null;

  const send = await sendToAthlete(athleteId, suggestionsPayload(fresh, pending.length));
  return { notices: fresh, send };
}

/**
 * Rend toutes les clés de propositions d'un compte.
 *
 * Appelée quand la catégorie est **éteinte**. Sans elle, la moitié « rendue
 * quand elle disparaît » cesse de s'exécuter en même temps que l'envoi, et une
 * réclamation se fige : proposition annoncée, catégorie coupée, proposition
 * acceptée, une autre paraît, catégorie rallumée — la clé est toujours détenue
 * et la nouvelle ne s'annoncera jamais. Rien ne le réparerait, puisque le genre
 * n'est plus jamais absent.
 *
 * Tout rendre est aussi la lecture la plus honnête de l'extinction : une
 * catégorie éteinte ne garde pas d'états en réserve. Au rallumage, ce qui attend
 * s'annonce une fois — ce que veut quelqu'un qui vient de rouvrir le robinet.
 */
export async function releaseSuggestionNotices(athleteId: number): Promise<void> {
  for (const kind of SUGGESTION_KINDS) {
    try {
      await releaseNotice(athleteId, 'suggestion', kind);
    } catch (error) {
      logError(`compte ${athleteId} : libération de « ${kind} » — ${errorMessage(error)}`);
    }
  }
}
