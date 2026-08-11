/**
 * Déroulé d'une séance du plan, mis en forme pour l'affichage — fonctions
 * pures, testées.
 *
 * Deux générations de séances cohabitent et doivent se lire aussi bien :
 * - les séances **structurées** (`steps`), qui portent des blocs d'étapes
 *   mesurées et ciblées — c'est d'elles que sortent le déroulé et les totaux ;
 * - les séances **historiques**, qui n'ont que trois textes libres
 *   (échauffement / récupération / retour au calme).
 *
 * Rien n'est inventé ici : un total ne s'affiche que si `sessionStepsTotals` le
 * juge calculable (toutes les étapes mesurées dans la même unité), sinon il
 * n'existe pas.
 */

import type { PlanSessionDto } from "@/data/plans";
import {
  sessionStepsTotals,
  type PlanStep,
  type PlanStepRole,
} from "@/lib/plan-steps/schema";

import { formatDuration, formatNumber, formatPace } from "../../_lib/format";

/** Rôle d'une étape, en français — l'ordre du schéma, la langue de l'UI. */
export const PLAN_STEP_ROLE_LABELS: Record<PlanStepRole, string> = {
  warmup: "Échauffement",
  run: "Course",
  recover: "Récupération",
  cooldown: "Retour au calme",
};

/** Textes libres des séances sans déroulé structuré, dans l'ordre de la séance. */
const NOTE_FIELDS = [
  { key: "warmup", label: "Échauffement" },
  { key: "recovery", label: "Récupération" },
  { key: "cooldown", label: "Retour au calme" },
] as const;

/**
 * Distance d'une étape, sans décimale inutile : `800 m`, `2 km`, `2,45 km`.
 *
 * `formatDistance` (celui du tableau de bord) écrirait `2,0 km` pour une étape
 * de 2 km — un dixième de trop pour une consigne qu'on lit en courant.
 */
export function formatStepDistance(meters: number): string {
  if (meters < 1000) return `${formatNumber(meters, 0)} m`;

  const fixed = formatNumber(meters / 1000, 2);
  const trimmed = fixed.includes(",")
    ? fixed.replace(/0+$/, "").replace(/,$/, "")
    : fixed;
  return `${trimmed} km`;
}

/** `mm:ss`, `h:mm:ss` — pour les durées qui ne tombent pas sur la minute. */
function formatStepClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  const hours = Math.floor(minutes / 60);

  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

/**
 * Durée d'une étape dans l'unité où on la court : `45 s`, `90 s`, `12 min`,
 * `12:30`, `1 h 05`.
 *
 * Une récupération de 90 s reste en secondes — `2 min` (ce que produirait
 * `formatDuration`) serait à la fois faux et inutilisable au chrono.
 */
export function formatStepDuration(seconds: number): string {
  const total = Math.round(seconds);

  if (total % 60 !== 0) return total < 600 ? `${total} s` : formatStepClock(total);

  const minutes = total / 60;
  return minutes < 60 ? `${minutes} min` : formatDuration(total);
}

/** La mesure de l'étape — distance ou durée, jamais les deux (cf. schéma). */
export function formatStepMeasure(step: PlanStep): string | null {
  if (step.distanceM !== null) return formatStepDistance(step.distanceM);
  if (step.durationS !== null) return formatStepDuration(step.durationS);
  return null;
}

/**
 * La cible de l'étape : fourchette d'allure (`4:25–4:35/km`), allure unique
 * (`4:30/km`) ou zone cardiaque (`Z2`). `null` quand l'étape n'en porte pas —
 * un footing se court sans consigne.
 */
export function formatStepTarget(step: PlanStep): string | null {
  const { paceMinSecPerKm: min, paceMaxSecPerKm: max } = step;

  if (min !== null && max !== null) {
    if (min === max) return formatPace(min);
    // Borne basse nue, borne haute avec l'unité : `4:25–4:35/km`.
    return `${formatPace(min).replace("/km", "")}–${formatPace(max)}`;
  }
  // Le DAL impose les deux bornes ensemble ; une seule reste affichable.
  if (min !== null) return formatPace(min);
  if (max !== null) return formatPace(max);

  return step.hrZone === null ? null : `Z${step.hrZone}`;
}

export type PlanStepView = {
  role: PlanStepRole;
  roleLabel: string;
  /** `null` si l'étape ne porte aucune mesure exploitable. */
  measure: string | null;
  target: string | null;
  note: string | null;
};

export type PlanStepBlockView = {
  /** Répétitions du bloc ; `1` = bloc simple, affiché sans en-tête. */
  repeat: number;
  steps: PlanStepView[];
};

/** Une valeur du récapitulatif : libellé discret, valeur chiffrée en mono. */
export type PlanSessionMetric = { label: string; value: string };

export type PlanSessionDetail = {
  /** Vide pour une séance sans déroulé structuré. */
  blocks: PlanStepBlockView[];
  /** Textes libres de la séance, ceux qui sont renseignés. */
  notes: PlanSessionMetric[];
  /** Totaux et allure cible — uniquement ce qui est calculable ou annoncé. */
  totals: PlanSessionMetric[];
  /** Rien à déplier : ni déroulé, ni consigne. */
  isEmpty: boolean;
};

/**
 * Distance et durée de la séance.
 *
 * Le volume annoncé par le plan prime, et le déroulé prend le relais quand il
 * est muet : la somme des étapes est une donnée du plan, pas une estimation.
 */
export function planSessionTotals(
  session: Pick<PlanSessionDto, "volumeM" | "durationS" | "steps">,
): { distanceM: number | null; durationS: number | null } {
  const fromSteps =
    session.steps === null
      ? { distanceM: null, durationS: null }
      : sessionStepsTotals(session.steps);

  return {
    distanceM: session.volumeM ?? fromSteps.distanceM,
    durationS: session.durationS ?? fromSteps.durationS,
  };
}

/**
 * Ligne chiffrée de la séance repliée : `8,4 km · 45 min · @ 4:30/km`, réduite
 * à ce qui est connu.
 */
export function planSessionSummary(
  session: Pick<PlanSessionDto, "volumeM" | "durationS" | "steps" | "targetPaceSecPerKm">,
): string[] {
  const { distanceM, durationS } = planSessionTotals(session);
  const summary: string[] = [];

  if (distanceM !== null) summary.push(formatStepDistance(distanceM));
  if (durationS !== null) summary.push(formatDuration(durationS));
  if (session.targetPaceSecPerKm !== null) {
    summary.push(`@ ${formatPace(session.targetPaceSecPerKm)}`);
  }

  return summary;
}

/** Le contenu déplié d'une séance : déroulé, consignes, récapitulatif. */
export function planSessionDetail(session: PlanSessionDto): PlanSessionDetail {
  const blocks: PlanStepBlockView[] = (session.steps ?? []).map((block) => ({
    repeat: block.repeat,
    steps: block.steps.map((step) => ({
      role: step.role,
      roleLabel: PLAN_STEP_ROLE_LABELS[step.role],
      measure: formatStepMeasure(step),
      target: formatStepTarget(step),
      note: step.note,
    })),
  }));

  const notes: PlanSessionMetric[] = [];
  for (const field of NOTE_FIELDS) {
    const value = session[field.key];
    if (value !== null) notes.push({ label: field.label, value });
  }

  const { distanceM, durationS } = planSessionTotals(session);
  const totals: PlanSessionMetric[] = [];
  if (distanceM !== null) totals.push({ label: "Distance", value: formatStepDistance(distanceM) });
  if (durationS !== null) totals.push({ label: "Durée", value: formatDuration(durationS) });
  if (session.targetPaceSecPerKm !== null) {
    totals.push({ label: "Allure cible", value: formatPace(session.targetPaceSecPerKm) });
  }

  return {
    blocks,
    notes,
    totals,
    // Les totaux seuls ne justifient pas un dépliage : ils sont déjà sur la
    // ligne repliée.
    isEmpty: blocks.length === 0 && notes.length === 0,
  };
}
