/**
 * Le **texte** des notifications métier — pur, testé, sans base ni réseau.
 *
 * Séparé des déclencheurs (`./notices.ts`) pour la raison habituelle : ce qui se
 * lit sur un écran verrouillé mérite d'être éprouvé sur des cas limites qu'une
 * base ne produirait qu'au hasard — une séance sans allure cible, une prévision
 * dont il ne reste que le vent, quatre propositions le même matin.
 *
 * ## Trois règles, et elles ne sont pas cosmétiques
 *
 * 1. **Rien n'est inventé.** Chaque valeur affichée vient d'un champ non nul ;
 *    ce qui manque est **omis**, jamais approximé ni remplacé par un tiret. En
 *    particulier, aucune notion de « fenêtre sèche » n'est fabriquée : elle
 *    n'est calculée nulle part dans l'application, et une prévision de jour
 *    civil (`DailyForecast`) ne permet pas de la déduire — le cumul de pluie
 *    d'une journée ne dit rien de l'heure où elle tombe.
 * 2. **Le libellé dit exactement ce que la mesure est.** Les précipitations
 *    d'une prévision sont un **cumul de journée**, le vent un **maximum de
 *    journée** : les mêmes mots que `SessionForecast`, pour la même raison —
 *    écrire « pluie » au-dessus d'un cumul quotidien promet une averse à qui
 *    n'aura qu'un ciel gris.
 * 3. **Le titre ne promet que ce qui existe déjà.** L'analyse d'une séance est
 *    prête à l'ingestion ; le verdict du coach, non (`scheduleActivePlanFollowUp`
 *    est un appel LLM non attendu qui dure des minutes). Le titre parle donc de
 *    l'analyse, jamais de l'avis.
 * 4. **Une proposition se notifie quand elle apparaît, pas quand sa valeur
 *    bouge.** Deux des quatre sont des médianes sur fenêtre glissante : une clé
 *    de déduplication qui porterait leur valeur émettrait une bannière par jour
 *    pour une carte que personne n'a traitée. La clé porte donc le **genre**
 *    (cf. {@link SUGGESTION_KINDS}), et c'est la transition « absente →
 *    présente » qui parle.
 *
 * ## Pourquoi ce module importe le formatage des écrans
 *
 * `@/app/(app)/_lib/format` et `format-weather` sont **purs, testés, et déjà
 * partagés par tous les écrans du groupe `(app)`** — leur en-tête le dit. Une
 * notification de séance du jour est le panneau « Séance du jour » livré sur
 * l'écran verrouillé, et son clic ouvre précisément cet écran : les deux doivent
 * annoncer la même allure, la même distance et la même température, au caractère
 * près. Réécrire ici six formateurs (allure, distance, durée, température, vent,
 * précipitations) garantirait l'inverse dès la première divergence d'arrondi.
 * Ces modules ne portent ni `server-only`, ni JSX, ni état : rien n'est tiré
 * dans le service par cette dépendance.
 */

import {
  formatDistance,
  formatDuration,
  formatHeartRate,
  formatPace,
} from '@/app/(app)/_lib/format';
import {
  formatPercent,
  formatPrecipitation,
  formatTemperatureRange,
  formatWindSpeed,
} from '@/app/(app)/_lib/format-weather';
import {
  formatRevisionVolume,
  PLAN_REVISION_DIRECTIONS,
} from '@/app/(app)/_lib/plan-revision-view';
import type { AnalyzedActivityDto } from '@/data/activities';
import type { PlannedSessionDto } from '@/data/dashboard';
import type { PlanRevisionDirection, PlanRevisionTotals } from '@/lib/plan-revision/direction';
import type { DailyForecast } from '@/lib/weather/forecast-plan';
import { describeWeatherCode } from '@/lib/weather/wmo';

import type { PushPayload } from './send';
import { ACTIVITY_ANALYZED_TTL_S, DAILY_SESSION_TTL_S, SUGGESTION_TTL_S } from './ttl';

/** Le séparateur des faits d'une même ligne — celui des écrans. */
const DOT = ' · ';

/*
 * A. La séance du jour.
 */

/**
 * Ce que la météo du jour dit, ou `null` quand elle ne dit rien.
 *
 * Trois faits au plus, et exactement ceux que le panneau de la séance affiche :
 * l'amplitude de température de la journée, le vent maximal, le cumul de pluie
 * assorti de sa probabilité la plus forte. Le ressenti est laissé à l'écran :
 * une bannière se lit d'un coup d'œil, et une quatrième mesure la ferait
 * tronquer par le système avant la fin de la phrase.
 *
 * Chaque fait est indépendamment omis quand sa mesure manque — et si tout
 * manque, il n'y a **pas de ligne du tout** plutôt qu'une phrase d'absence :
 * « prévisions pas encore relevées » n'aide personne à s'habiller, alors que
 * l'écran que la bannière ouvre, lui, l'explique.
 */
function forecastLine(day: DailyForecast): string | null {
  const parts: string[] = [];

  // Un code absent n'est pas « temps inconnu » à annoncer : c'est une mesure
  // qu'on n'a pas, donc un mot qu'on n'écrit pas. Un code présent mais hors
  // table, si — `describeWeatherCode` le cite, et c'est ainsi qu'on verrait
  // qu'Open-Meteo s'est enrichi.
  if (day.weatherCode !== null) parts.push(describeWeatherCode(day.weatherCode).label);

  if (day.temperatureMinC !== null && day.temperatureMaxC !== null) {
    parts.push(formatTemperatureRange(day.temperatureMinC, day.temperatureMaxC));
  }
  if (day.windSpeedMaxKmh !== null) {
    parts.push(`vent max ${formatWindSpeed(day.windSpeedMaxKmh)}`);
  }
  if (day.precipitationSumMm !== null) {
    const probability =
      day.precipitationProbabilityMaxPct === null
        ? ''
        : ` (${formatPercent(day.precipitationProbabilityMaxPct)})`;
    // « du jour » : c'est un cumul de journée civile, pas la pluie pendant la
    // séance — une séance planifiée porte une date, jamais une heure.
    parts.push(`pluie du jour ${formatPrecipitation(day.precipitationSumMm)}${probability}`);
  }

  return parts.length === 0 ? null : parts.join(DOT);
}

/** Ce que la séance prescrit, en une ligne : le type, puis l'allure et les volumes. */
function sessionLine(session: PlannedSessionDto): string {
  const details: string[] = [];
  if (session.targetPaceSecPerKm !== null) {
    details.push(`@ ${formatPace(session.targetPaceSecPerKm)}`);
  }
  if (session.volumeM !== null) details.push(formatDistance(session.volumeM));
  if (session.durationS !== null) details.push(formatDuration(session.durationS));

  // Le type contient déjà des points médians (« VMA courte · piste ») : un tiret
  // le sépare de ses chiffres, sans quoi la ligne se lirait comme une seule
  // énumération.
  return details.length === 0 ? session.kind : `${session.kind} — ${details.join(DOT)}`;
}

/**
 * Le rappel du matin : la séance planifiée du jour, et ce que la météo en dit.
 *
 * `url: '/'` — c'est le tableau de bord qui porte le panneau « Séance du jour »,
 * avec son déroulé complet et sa prévision détaillée. `tag: 'daily-session'` :
 * un rappel remplace le précédent sur l'appareil, une semaine d'absence ne
 * produit donc pas sept bannières empilées.
 *
 * @param forecast la prévision du jour, `null` quand il n'y en a pas pour cette
 *   date (relevé pas encore fait, échoué, ou hors horizon). La bannière se
 *   contente alors de la séance : le « pourquoi » est sur l'écran qu'elle ouvre.
 */
export function dailySessionPayload(
  session: PlannedSessionDto,
  forecast: DailyForecast | null,
): PushPayload {
  const weather = forecast === null ? null : forecastLine(forecast);
  const lines = [sessionLine(session), weather].filter((line) => line !== null);

  return {
    title: `Séance du jour : ${session.title}`,
    body: lines.join('\n'),
    url: '/',
    tag: 'daily-session',
    // Un rappel du matin n'a plus de sens le lendemain — cf. `./ttl.ts`.
    ttlSeconds: DAILY_SESSION_TTL_S,
  };
}

/*
 * B. L'analyse d'une séance importée.
 */

/**
 * L'analyse d'une séance qui vient d'être importée.
 *
 * **Le titre parle de l'analyse, pas du coach** : à cet instant, seuls les
 * scalaires du fichier et le rapprochement au plan sont acquis. La relecture du
 * plan part sans être attendue et durera des minutes ; promettre « ton coach a
 * jugé ta séance » ferait ouvrir un écran qui n'a rien de plus à montrer.
 *
 * `tag: 'activity-<id>'` — propre à la séance : deux imports rapprochés méritent
 * deux bannières, mais un même import réaffiché n'en empile pas deux.
 */
export function activityAnalyzedPayload(activity: AnalyzedActivityDto): PushPayload {
  const facts: string[] = [];
  // Une distance nulle n'est pas une distance : un tapis sans capteur, une séance
  // de renforcement. On dit la durée, et rien d'autre.
  if (activity.distanceM > 0) facts.push(formatDistance(activity.distanceM));
  facts.push(formatDuration(activity.movingTimeS));
  if (activity.avgPaceSecPerKm !== null) facts.push(formatPace(activity.avgPaceSecPerKm));

  const lines = [facts.join(DOT)];
  if (activity.plannedSession !== null) {
    lines.push(
      `Séance du plan : ${activity.plannedSession.kind} — ${activity.plannedSession.title}`,
    );
  }

  return {
    title: `Séance analysée : ${activity.name}`,
    body: lines.join('\n'),
    url: `/activities/${activity.id}`,
    tag: `activity-${activity.id}`,
    // Une analyse se périme lentement : la séance reste lisible — cf. `./ttl.ts`.
    ttlSeconds: ACTIVITY_ANALYZED_TTL_S,
  };
}

/*
 * C. Les décisions à valider.
 */

/**
 * Une proposition que l'application sait calculer mais ne peut pas trancher
 * seule, réduite à ce qui la **nomme** et à ce qui la **distingue**.
 *
 * Forme close et non les DTOs du DAL : c'est ce qui garde ce module pur et ses
 * cas limites éprouvables. Les trois propositions cardiaques se déduisent à la
 * lecture (rien n'est persisté) ; la réévaluation de plan, elle, est une ligne
 * en base — d'où son `id`.
 */
export type SuggestionNotice =
  | { kind: 'max-hr'; bpm: number; profileBpm: number | null }
  | { kind: 'resting-hr'; bpm: number; measuredNights: number; profileBpm: number | null }
  | { kind: 'lthr'; bpm: number; profileBpm: number | null }
  | {
      kind: 'plan-revision';
      /** L'identifiant de la ligne en attente, pour le seul message. */
      id: number;
      direction: PlanRevisionDirection;
      weeks: number;
      before: PlanRevisionTotals;
      after: PlanRevisionTotals;
    };

/**
 * Les quatre genres de proposition, dans l'ordre où une bannière les énumère —
 * le même que celui des cartes du tableau de bord.
 *
 * **C'est aussi la clé de déduplication de chacune** : ni sa valeur, ni la date,
 * et le choix n'est pas cosmétique. Deux des quatre valeurs sont des médianes
 * sur fenêtre glissante (14 jours pour la FC de repos, 90 pour la FC seuil) :
 * elles bougent d'un battement d'un jour à l'autre sans qu'aucune décision n'ait
 * changé. Une clé qui portait la valeur fabriquait alors une bannière quotidienne
 * pour une carte que personne n'avait traitée — le harcèlement même que cette
 * fonctionnalité doit éviter.
 *
 * Ce qui déclenche une notification devient donc une **transition** : « aucune
 * proposition de ce genre » → « il y en a une ». La réservation vit exactement
 * aussi longtemps que la proposition, parce que le déclencheur la rend
 * (`releaseNotice`) dès qu'elle n'est plus calculée — acceptée, écartée, ou
 * devenue sans objet. Une nouvelle proposition du même genre, des mois plus tard,
 * retrouve une clé libre et s'annonce. Ce que cette clé ne dit **plus** : « 191
 * bpm après 188 » ne renotifie pas tant que la carte est là. C'est voulu — la
 * carte, elle, affiche la valeur du jour, et c'est sur elle que se prend la
 * décision.
 *
 * L'énumération existe parce que le déclencheur a besoin de parler des
 * **absentes** autant que des présentes. Les deux sens de la correspondance sont
 * tenus à la compilation : le `satisfies` interdit d'inscrire ici un genre qui
 * n'existe pas, et {@link SuggestionBoard} — dont `collectSuggestions` rend un
 * littéral — interdit d'en calculer un qui ne serait pas inscrit.
 */
export const SUGGESTION_KINDS = [
  'max-hr',
  'resting-hr',
  'lthr',
  'plan-revision',
] as const satisfies readonly SuggestionNotice['kind'][];

export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/**
 * L'état des quatre propositions à un instant : celle qui tient, ou `null`.
 *
 * Exhaustif par construction — un genre qu'on oublie de calculer ne compile pas.
 * C'est ce qui garantit qu'aucune clé ne restera réservée indéfiniment parce
 * qu'une proposition aura été ajoutée sans que sa libération le soit.
 */
export type SuggestionBoard = {
  [K in SuggestionKind]: Extract<SuggestionNotice, { kind: K }> | null;
};

/** « (profil : 188) », ou rien quand le profil n'en porte pas encore. */
function versusProfile(profileBpm: number | null): string {
  return profileBpm === null ? '' : ` (profil : ${formatHeartRate(profileBpm)})`;
}

/** Ce que dit une proposition, en une ligne — la valeur, et d'où elle sort. */
function suggestionLine(notice: SuggestionNotice): string {
  switch (notice.kind) {
    case 'max-hr':
      return `FC max : ${formatHeartRate(notice.bpm)} tenus en séance${versusProfile(notice.profileBpm)}`;
    case 'resting-hr': {
      // Le nombre de nuits est ce qui rend la médiane crédible : une valeur
      // sortie de deux nuits ne se juge pas comme une valeur sortie de
      // quatorze, et la carte du tableau de bord le dit déjà.
      const nights = notice.measuredNights > 1 ? 'nuits' : 'nuit';
      return `FC de repos : ${formatHeartRate(notice.bpm)} sur ${notice.measuredNights} ${nights}${versusProfile(notice.profileBpm)}`;
    }
    case 'lthr':
      return `FC seuil : ${formatHeartRate(notice.bpm)} mesurés${versusProfile(notice.profileBpm)}`;
    case 'plan-revision':
      return `Plan : ${PLAN_REVISION_DIRECTIONS[notice.direction].label.toLowerCase()} — ${formatRevisionVolume(notice.before, notice.after, notice.weeks)}`;
  }
}

/** « 3 autres décisions restent en attente. » — l'accord se fait sur le nombre. */
function othersLine(others: number): string {
  return others === 1
    ? 'Une autre décision reste en attente.'
    : `${others} autres décisions restent en attente.`;
}

/**
 * Une **seule** bannière pour toutes les propositions apparues au même cycle.
 *
 * Quatre notifications simultanées ne donneraient pas quatre fois plus
 * d'information : elles se disputeraient l'écran verrouillé pour un seul geste à
 * faire, au même endroit.
 *
 * **La bannière annonce ce qui est nouveau, et dit ce qui l'attend en plus.**
 * Les deux sont nécessaires : détailler les quatre cartes à chaque apparition
 * d'une seule ferait relire trois lignes déjà vues, mais n'annoncer que la
 * nouvelle donnait « Une décision à valider » devant un écran qui en montre
 * quatre. Les nouvelles sont donc détaillées, les autres comptées.
 *
 * `url: '/'` : les quatre cartes vivent sur le tableau de bord.
 * `tag: 'suggestion'` : une bannière remplace la précédente.
 *
 * @param fresh les propositions qui viennent d'être réclamées — au moins une, un
 *   appel sans proposition n'a rien à envoyer et c'est à l'appelant de ne pas le
 *   faire.
 * @param pendingCount le nombre **total** de propositions en attente, `fresh`
 *   comprises : c'est ce que l'écran affichera quand la bannière l'ouvrira.
 */
export function suggestionsPayload(
  fresh: readonly SuggestionNotice[],
  pendingCount: number,
): PushPayload {
  const others = pendingCount - fresh.length;

  // « nouvelles » n'apparaît que s'il y a de l'ancien à en distinguer : sur un
  // écran qui ne montrera que ça, le mot ne dirait rien de plus.
  const noun = others > 0 ? 'nouvelles décisions' : 'décisions';
  const title =
    fresh.length > 1
      ? `${fresh.length} ${noun} à valider`
      : `Une ${others > 0 ? 'nouvelle décision' : 'décision'} à valider`;

  const lines = fresh.map(suggestionLine);
  if (others > 0) lines.push(othersLine(others));

  return {
    title,
    body: lines.join('\n'),
    url: '/',
    tag: 'suggestion',
    // Une décision attend qu'on la tranche, et ne sera pas réémise — cf. `./ttl.ts`.
    ttlSeconds: SUGGESTION_TTL_S,
  };
}
