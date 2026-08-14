import 'server-only';

/**
 * Feedback du coach sur une séance réalisée.
 *
 * ## Ce qui part au modèle, et surtout ce qui n'y part pas
 *
 * `getActivityFull` rend, entre autres, les points des graphes (jusqu'à 600
 * échantillons × 6 séries) et la trace GPS. Envoyer cela ferait exploser les
 * 32 k de contexte du modèle cible — et n'apporterait rien : un LLM ne lit pas
 * une courbe, il lit des agrégats. Le prompt ne porte donc que des **résumés
 * déjà calculés** : splits kilométriques (échantillonnés à
 * {@link FEEDBACK_MAX_SPLITS}), zones de FC, découplage, TRIMP, VO₂max
 * effective, meilleurs segments. Comptez ~1 200 tokens pour une sortie longue,
 * loin du plafond.
 *
 * ## Une donnée absente ne se commente pas
 *
 * Le prompt omet purement et simplement les blocs non calculables (pas de
 * ceinture cardio = pas une ligne sur la FC) et l'interdiction d'inventer est
 * répétée dans le rôle. C'est la règle du projet appliquée au maillon le plus
 * susceptible de la violer : un modèle à qui l'on montre « FC : null » écrira
 * volontiers une phrase sur la FC.
 */

import { getActivityFull, type ActivityFullDto, type ActivitySplitDto } from '@/data/activities';
import { getCurrentAthleteId } from '@/data/athlete';
import {
  ActivityNotFoundError,
  getActivityFeedback,
  saveActivityFeedback,
  type ActivityFeedbackDto,
} from '@/data/activity-feedback';
import {
  getComparableActivities,
  getTrainingSnapshot,
  type ComparableActivityDto,
  type TrainingSnapshotDto,
} from '@/data/coach-context';
import { getPlannedSessionForActivity, type PlanSessionDto } from '@/data/plans';
import { env } from '@/config/env';
import { toCivilDate } from '@/lib/dates/civil';

import { requireAi } from './availability';
import { chatCompletion, type ChatMessage } from './client';
import {
  formatDaysAgo,
  formatDistanceKm,
  formatDuration,
  formatNumber,
  formatPace,
  formatSignedPercent,
  formatTrainingSnapshot,
} from './format';

/**
 * Au-delà de 30 splits, on échantillonne : un marathon en produit 43, et le
 * détail du 27ᵉ kilomètre n'apporte rien qu'une tendance ne dise déjà.
 */
export const FEEDBACK_MAX_SPLITS = 30;

/** Un peu de latitude rédactionnelle, sans laisser le modèle broder. */
const FEEDBACK_TEMPERATURE = 0.5;

/** Le feedback tient en une page : au-delà, il n'est plus lu. */
const FEEDBACK_MAX_TOKENS = 900;

/** Tout ce dont la rédaction du feedback a besoin. */
export type FeedbackContext = {
  activity: ActivityFullDto;
  snapshot: TrainingSnapshotDto;
  comparables: ComparableActivityDto[];
  /** La séance du plan que cette activité a réalisée, `null` si aucune. */
  plannedSession: PlanSessionDto | null;
};

/**
 * Réduit les splits à `max` lignes, en conservant le premier et le dernier
 * kilomètre — le début (mise en route) et la fin (ce qu'il restait) sont
 * précisément ce qu'un coach regarde.
 */
export function sampleSplits(
  splits: readonly ActivitySplitDto[],
  max = FEEDBACK_MAX_SPLITS,
): ActivitySplitDto[] {
  if (splits.length <= max) return [...splits];

  const step = Math.ceil(splits.length / max);
  const sampled = splits.filter((_, index) => index % step === 0);

  const last = splits[splits.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

/** Le bloc « séance », toujours présent : ce sont les données de l'en-tête FIT. */
function formatActivityBlock(activity: ActivityFullDto): string {
  const { detail } = activity;
  const lines = [
    `Séance : « ${detail.name} » (${detail.sportType}), le ${toCivilDate(detail.startedAt)}.`,
    `Distance ${formatDistanceKm(detail.distanceM)} · temps de déplacement ${formatDuration(detail.movingTimeS)}.`,
  ];

  if (detail.avgPaceSecPerKm !== null) {
    lines.push(`Allure moyenne ${formatPace(detail.avgPaceSecPerKm)}.`);
  }
  if (detail.avgHrBpm !== null) {
    const max = detail.maxHrBpm === null ? '' : ` (max ${detail.maxHrBpm} bpm)`;
    lines.push(`FC moyenne ${detail.avgHrBpm} bpm${max}.`);
  }
  if (detail.elevationGainM !== null) {
    lines.push(`Dénivelé positif ${formatNumber(detail.elevationGainM)} m.`);
  }
  if (detail.avgCadenceSpm !== null) {
    lines.push(`Cadence moyenne ${formatNumber(detail.avgCadenceSpm)} ppm.`);
  }
  if (activity.trimp !== null) lines.push(`TRIMP ${formatNumber(activity.trimp)}.`);
  if (activity.effectiveVo2max !== null) {
    lines.push(`VO2max effective de la séance ${formatNumber(activity.effectiveVo2max, 1)}.`);
  }

  return lines.join('\n');
}

/** Un split par ligne : `km 3 · 4:52/km · 152 bpm · +12 m`. */
function formatSplitsBlock(splits: readonly ActivitySplitDto[]): string | null {
  if (splits.length === 0) return null;

  const sampled = sampleSplits(splits);
  const lines = sampled.map((split) => {
    const parts = [`km ${split.km}`, formatPace(split.paceSecPerKm)];
    if (split.avgHrBpm !== null) parts.push(`${Math.round(split.avgHrBpm)} bpm`);
    if (split.elevationGainM !== null) parts.push(`+${formatNumber(split.elevationGainM)} m`);
    return `- ${parts.join(' · ')}`;
  });

  const header =
    sampled.length < splits.length
      ? `Splits kilométriques (${sampled.length} des ${splits.length}, échantillonnés) :`
      : 'Splits kilométriques :';
  return [header, ...lines].join('\n');
}

/** Temps par zone de FC, en pourcentage de la séance. */
function formatHrZonesBlock(activity: ActivityFullDto): string | null {
  if (activity.hrZones === null) return null;

  const parts = activity.hrZones
    .filter((zone) => zone.timeS > 0)
    .map(
      (zone) => `Z${zone.zone} ${formatDuration(zone.timeS)} (${formatNumber(zone.share * 100)} %)`,
    );
  return parts.length === 0 ? null : `Temps par zone de FC : ${parts.join(' · ')}.`;
}

/** La dérive cardiaque, avec le sens du signe rappelé au modèle. */
function formatDecouplingBlock(activity: ActivityFullDto): string | null {
  const { decoupling } = activity;
  if (decoupling === null) return null;

  return `Découplage aérobie (Pa:HR) : ${formatSignedPercent(decoupling.decouplingPct)} — positif = le rendement se dégrade sur la seconde moitié ; au-delà de 5 %, l'endurance aérobie n'est pas établie sur cette durée.`;
}

/** Meilleurs efforts de la séance sur les distances de référence. */
function formatBestSegmentsBlock(activity: ActivityFullDto): string | null {
  if (activity.bestSegments.length === 0) return null;

  const parts = activity.bestSegments.map(
    (segment) =>
      `${formatDistanceKm(segment.targetM)} en ${formatDuration(segment.timeS)} (${formatPace(segment.paceSecPerKm)})`,
  );
  return `Meilleurs efforts de la séance : ${parts.join(' · ')}.`;
}

/** Le prévu, quand la séance a été rapprochée d'une séance du plan. */
function formatPlannedBlock(session: PlanSessionDto | null): string | null {
  if (session === null) return null;

  const parts: string[] = [];
  if (session.volumeM !== null) parts.push(formatDistanceKm(session.volumeM));
  if (session.durationS !== null) parts.push(formatDuration(session.durationS));
  if (session.targetPaceSecPerKm !== null) parts.push(formatPace(session.targetPaceSecPerKm));

  const target = parts.length === 0 ? '' : ` — cible : ${parts.join(' · ')}`;
  return `Séance prévue au plan ce jour-là : ${session.kind} — ${session.title}${target}. Compare le réalisé au prévu.`;
}

/** Les sorties comparables, pour situer la séance sans rien extrapoler. */
function formatComparablesBlock(
  comparables: readonly ComparableActivityDto[],
  today: string,
): string | null {
  if (comparables.length === 0) return null;

  const lines = comparables.map((activity) => {
    const parts = [formatDaysAgo(activity.date, today), formatDistanceKm(activity.distanceM)];
    if (activity.avgPaceSecPerKm !== null) parts.push(formatPace(activity.avgPaceSecPerKm));
    if (activity.avgHrBpm !== null) parts.push(`${activity.avgHrBpm} bpm`);
    if (activity.elevationGainM !== null) parts.push(`+${formatNumber(activity.elevationGainM)} m`);
    if (activity.trimp !== null) parts.push(`TRIMP ${formatNumber(activity.trimp)}`);
    return `- ${parts.join(' · ')}`;
  });

  return ['Sorties comparables antérieures (même sport, distance voisine) :', ...lines].join('\n');
}

/** Le rôle : la structure imposée, le ton, et l'interdiction d'inventer. */
const FEEDBACK_SYSTEM_PROMPT = [
  "Tu es le coach de course à pied de l'athlète. Tu analyses une séance qu'elle vient de réaliser.",
  '',
  'Tu réponds en français, en markdown, avec exactement ces trois sections et dans cet ordre :',
  "### Ce qui s'est bien passé",
  "### Points d'attention",
  '### Pour la suite',
  '',
  'Règles :',
  "- tu n'utilises que les données fournies ci-dessous ; une donnée absente ne se commente pas et ne s'invente jamais (aucune fréquence cardiaque fournie = pas un mot sur la fréquence cardiaque) ;",
  '- tu appuies chaque constat sur un chiffre du contexte ;',
  '- 2 à 4 puces par section, une phrase par puce ;',
  '- ton bienveillant et factuel : pas de superlatif, pas de flatterie, pas de diagnostic médical ;',
  "- la dernière section propose une suite concrète pour les prochains jours, cohérente avec l'état de forme fourni.",
].join('\n');

/**
 * Les messages du feedback. Exportée pour que les tests vérifient ce qui part
 * réellement : les agrégats attendus, et **aucune** série de points.
 */
export function buildFeedbackMessages(context: FeedbackContext): ChatMessage[] {
  const blocks = [
    formatActivityBlock(context.activity),
    formatSplitsBlock(context.activity.splits),
    formatHrZonesBlock(context.activity),
    formatDecouplingBlock(context.activity),
    formatBestSegmentsBlock(context.activity),
    formatPlannedBlock(context.plannedSession),
    formatComparablesBlock(context.comparables, context.snapshot.today),
    `État de forme au ${context.snapshot.today} :\n${formatTrainingSnapshot(context.snapshot)}`,
    'Rédige le feedback de cette séance.',
  ].filter((block): block is string => block !== null);

  return [
    { role: 'system', content: FEEDBACK_SYSTEM_PROMPT },
    { role: 'user', content: blocks.join('\n\n') },
  ];
}

/**
 * Rédige — et enregistre — le feedback d'une activité. Régénérer écrase le
 * feedback précédent (upsert côté DAL) : une séance n'a qu'une analyse courante.
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable.
 * @throws {ActivityNotFoundError} si l'activité n'existe pas ou n'est pas celle
 * de l'athlète.
 * @throws {AiResponseError} si l'API répond hors contrat.
 */
export async function generateActivityFeedback(activityId: number): Promise<ActivityFeedbackDto> {
  await requireAi();

  const activity = await getActivityFull(activityId);
  if (activity === null) throw new ActivityNotFoundError();

  // Chemin de **requête** (la page d'une activité) : l'athlète vient de la
  // session. `null` — onboarding non fait — rend un snapshot vide, comme avant.
  const [snapshot, comparables, plannedSession] = await Promise.all([
    getTrainingSnapshot(await getCurrentAthleteId()),
    getComparableActivities(activityId),
    getPlannedSessionForActivity(activityId),
  ]);

  const content = await chatCompletion({
    messages: buildFeedbackMessages({ activity, snapshot, comparables, plannedSession }),
    temperature: FEEDBACK_TEMPERATURE,
    maxTokens: FEEDBACK_MAX_TOKENS,
  });

  // `AI_MODEL` est facultatif (llama-server ne sert que le modèle chargé) : la
  // provenance est alors inconnue, et le DAL la stocke comme telle.
  await saveActivityFeedback(activityId, content.trim(), env.AI_MODEL ?? null);

  const saved = await getActivityFeedback(activityId);
  // L'écriture vient de réussir : `null` ici ne peut venir que d'une suppression
  // concurrente de l'activité — c'est le même cas métier qu'une activité absente.
  if (saved === null) throw new ActivityNotFoundError();
  return saved;
}
