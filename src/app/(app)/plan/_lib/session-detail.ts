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
import type { HrTargetBpm } from "@/lib/metrics/hr-targets";
import type { HrZoneAnchor } from "@/lib/metrics/hr-zones";
import { stepHrTargetBpm } from "@/lib/plan-steps/hr-target";
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

/** Habillage d'une étape sur la timeline : son segment de rail, son libellé. */
export type PlanStepRoleStyle = {
  /** Aplat du segment de rail — la géométrie (largeur, arrondi) reste à l'UI. */
  rail: string;
  /** Le libellé du rôle, en couleur pleine. */
  label: string;
};

/**
 * Code couleur des rôles : une étape se reconnaît avant d'être lue.
 *
 * Quatre tokens **existants** du système, aucun nouveau (cf. design.md) :
 * l'échauffement en `positive` (le vert de la mise en route), la course en
 * `accent` (la seule couleur d'intensité du système), la récupération en
 * `chart-cadence` (bleu ciel, le relâchement) et le retour au calme en
 * `chart-stride` (teal).
 *
 * La couleur ne se pose que sur deux surfaces minuscules — le segment de rail
 * et le libellé du rôle — jamais en aplat de fond : c'est ce qui laisse la
 * mesure chiffrée régner sur l'étape. Contre `surface-2` (le fond du panneau),
 * les quatre teintes tiennent les 3:1 de WCAG 1.4.11 pour le segment **et** les
 * 4,5:1 du texte pour le libellé : `positive` 11,4:1, `chart-stride` 9,2:1,
 * `chart-cadence` 8,0:1, `accent` 5,2:1.
 *
 * `Record<PlanStepRole, …>` volontaire : un rôle ajouté au contrat casse la
 * compilation ici tant qu'il n'a pas sa couleur.
 */
export const PLAN_STEP_ROLE_STYLES: Record<PlanStepRole, PlanStepRoleStyle> = {
  warmup: { rail: "bg-positive", label: "text-positive" },
  run: { rail: "bg-accent", label: "text-accent" },
  recover: { rail: "bg-chart-cadence", label: "text-chart-cadence" },
  cooldown: { rail: "bg-chart-stride", label: "text-chart-stride" },
};

/**
 * Textes libres des séances sans déroulé structuré, dans l'ordre de la séance.
 *
 * Chacun porte le rôle d'étape qui lui correspond : les séances historiques se
 * lisent avec le même code couleur que les séances structurées.
 */
const NOTE_FIELDS = [
  { key: "warmup", role: "warmup", label: "Échauffement" },
  { key: "recovery", role: "recover", label: "Récupération" },
  { key: "cooldown", role: "cooldown", label: "Retour au calme" },
] as const satisfies readonly { key: string; role: PlanStepRole; label: string }[];

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

/** Une cible cardiaque, telle qu'elle se lit sur la ligne d'une étape. */
export function formatHrTarget(target: HrTargetBpm): string {
  return `${target.minBpm}–${target.maxBpm} bpm`;
}

/**
 * La cible de l'étape : fourchette d'allure (`4:25–4:35/km`), allure unique
 * (`4:30/km`) ou cible cardiaque. `null` quand l'étape n'en porte pas — un
 * footing se court sans consigne.
 *
 * La cible cardiaque s'affiche en **battements** (`120–145 bpm`) dès que la FC
 * max est connue : c'est ce qui se surveille au poignet. Elle tient compte du
 * **sous-créneau** de l'étape quand elle en porte un — une fin de sortie longue
 * appuyée affiche `136–145 bpm` là où le reste du parcours affiche
 * `120–145 bpm`. « Z2 » ne se lit que faute de référence au profil — un rang de
 * zone nu ne dit rien à qui court.
 *
 * La conversion se fait **ici, à l'affichage**, et jamais à l'écriture du plan :
 * une FC max corrigée au profil, ou une FC seuil adoptée, met à jour tout le
 * plan d'un coup.
 */
export function formatStepTarget(
  step: PlanStep,
  anchor: HrZoneAnchor | null = null,
): string | null {
  const { paceMinSecPerKm: min, paceMaxSecPerKm: max } = step;

  if (min !== null && max !== null) {
    if (min === max) return formatPace(min);
    // Borne basse nue, borne haute avec l'unité : `4:25–4:35/km`.
    return `${formatPace(min).replace("/km", "")}–${formatPace(max)}`;
  }
  // Le DAL impose les deux bornes ensemble ; une seule reste affichable.
  if (min !== null) return formatPace(min);
  if (max !== null) return formatPace(max);

  const target = stepHrTargetBpm(step, anchor);
  if (target !== null) return formatHrTarget(target);

  return step.hrZone === null ? null : `Z${step.hrZone}`;
}

/**
 * La cible cardiaque de la **séance**, quand elle en porte une — `null` sinon.
 *
 * Elle se lit sur le déroulé, jamais sur un champ dédié : c'est la cible que
 * portent les étapes de **course**, et elle n'existe que si elles la portent
 * toutes. Une séance dont un bloc est prescrit autrement (le bloc à allure
 * objectif d'une sortie longue spécifique, par exemple) n'a pas de cible
 * cardiaque à annoncer — ses étapes disent chacune la leur.
 *
 * ## Des étapes à sous-créneaux différents ne cassent pas l'annonce
 *
 * C'est l'**enveloppe** des cibles d'étapes qui est rendue : la plus basse des
 * bornes basses, la plus haute des bornes hautes. Une sortie longue à fin
 * appuyée (120–145 puis 136–145 bpm) s'annonce donc toujours « 120–145 bpm » sur
 * sa ligne repliée, ce qui est exactement la plage dans laquelle elle se court,
 * et le déroulé déplié dit ensuite bloc par bloc. Quand toutes les étapes
 * portent la même cible — le cas de tous les footings — l'enveloppe *est* cette
 * cible, au bpm près : la ligne de séance ne bouge pas d'un battement.
 *
 * Fonction pure, exportée pour les tests.
 */
export function sessionHrTarget(
  session: Pick<PlanSessionDto, "steps">,
  anchor: HrZoneAnchor | null = null,
): HrTargetBpm | null {
  const runs = (session.steps ?? []).flatMap((block) =>
    block.steps.filter((step) => step.role === "run"),
  );
  if (runs.length === 0) return null;

  const targets: HrTargetBpm[] = [];
  for (const step of runs) {
    const target = stepHrTargetBpm(step, anchor);
    // Une seule étape de course sans cible cardiaque, et la séance n'en a plus
    // à annoncer : c'est elle qui dirait autre chose que ce qu'on affiche.
    if (target === null) return null;
    targets.push(target);
  }

  return {
    minBpm: Math.min(...targets.map((target) => target.minBpm)),
    maxBpm: Math.max(...targets.map((target) => target.maxBpm)),
  };
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

/** Une consigne en texte libre, teintée comme l'étape qu'elle remplace. */
export type PlanSessionNote = { role: PlanStepRole; label: string; value: string };

export type PlanSessionDetail = {
  /** Vide pour une séance sans déroulé structuré. */
  blocks: PlanStepBlockView[];
  /** Textes libres de la séance, ceux qui sont renseignés. */
  notes: PlanSessionNote[];
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
 *
 * **Quand la séance est prescrite en fréquence cardiaque**, la cible cardiaque
 * passe devant et l'allure devient une indication : `7 km · 50 min ·
 * 120–145 bpm · ~7:08/km`. C'est la FC qu'on suit en courant — l'allure ne dit
 * plus que l'ordre de grandeur du temps qu'on y passera, et le `~` le dit.
 */
export function planSessionSummary(
  session: Pick<PlanSessionDto, "volumeM" | "durationS" | "steps" | "targetPaceSecPerKm">,
  anchor: HrZoneAnchor | null = null,
): string[] {
  const { distanceM, durationS } = planSessionTotals(session);
  const hrTarget = sessionHrTarget(session, anchor);
  const summary: string[] = [];

  if (distanceM !== null) summary.push(formatStepDistance(distanceM));
  if (durationS !== null) summary.push(formatDuration(durationS));
  if (hrTarget !== null) summary.push(formatHrTarget(hrTarget));
  if (session.targetPaceSecPerKm !== null) {
    const pace = formatPace(session.targetPaceSecPerKm);
    summary.push(hrTarget === null ? `@ ${pace}` : `~${pace}`);
  }

  return summary;
}

/**
 * Ce qu'il faut d'une séance pour en rendre le détail.
 *
 * Un `Pick` et non `PlanSessionDto` entier : le calendrier ouvre le même détail
 * depuis son propre DTO ({@link "@/data/calendar".CalendarSessionDto}), qui ne
 * porte ni `scheduledOn` ni les identifiants du plan. Deux lectures, un seul
 * rendu — c'est la condition pour qu'il n'existe qu'une implémentation.
 */
export type PlanSessionDetailInput = Pick<
  PlanSessionDto,
  "steps" | "warmup" | "recovery" | "cooldown" | "volumeM" | "durationS" | "targetPaceSecPerKm"
>;

/** Le contenu déplié d'une séance : déroulé, consignes, récapitulatif. */
export function planSessionDetail(
  session: PlanSessionDetailInput,
  anchor: HrZoneAnchor | null = null,
): PlanSessionDetail {
  const blocks: PlanStepBlockView[] = (session.steps ?? []).map((block) => ({
    repeat: block.repeat,
    steps: block.steps.map((step) => ({
      role: step.role,
      roleLabel: PLAN_STEP_ROLE_LABELS[step.role],
      measure: formatStepMeasure(step),
      target: formatStepTarget(step, anchor),
      note: step.note,
    })),
  }));

  const notes: PlanSessionNote[] = [];
  for (const field of NOTE_FIELDS) {
    const value = session[field.key];
    if (value !== null) notes.push({ role: field.role, label: field.label, value });
  }

  const { distanceM, durationS } = planSessionTotals(session);
  const hrTarget = sessionHrTarget(session, anchor);
  const totals: PlanSessionMetric[] = [];
  if (distanceM !== null) totals.push({ label: "Distance", value: formatStepDistance(distanceM) });
  if (durationS !== null) totals.push({ label: "Durée", value: formatDuration(durationS) });
  // La cible cardiaque passe **devant** l'allure : c'est elle la consigne, et
  // l'allure ne reste là que pour situer le temps que la séance prendra.
  if (hrTarget !== null) {
    totals.push({ label: "Cible FC", value: formatHrTarget(hrTarget) });
  }
  if (session.targetPaceSecPerKm !== null) {
    totals.push({
      label: hrTarget === null ? "Allure cible" : "Allure indicative",
      value:
        hrTarget === null
          ? formatPace(session.targetPaceSecPerKm)
          : `~${formatPace(session.targetPaceSecPerKm)}`,
    });
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
