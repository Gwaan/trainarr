import { Panel } from "@/components/panel";
import type { PlanRevisionDetailDto } from "@/data/plan-revisions";
import type { PlanDto } from "@/data/plans";
import type { HrZoneAnchor } from "@/lib/metrics/hr-zones";

import {
  PLAN_REVISION_DIRECTIONS,
  PLAN_REVISION_SOURCE_LABELS,
  formatRevisionIntensity,
  formatRevisionVolume,
} from "../../_lib/plan-revision-view";
import { groupPlanWeeks } from "../_lib/plan-weeks";

import { PlanRevisionDecisionForm } from "./plan-revision-decision-form";
import { PlanWeekCard } from "./plan-week-card";

/**
 * La **réévaluation** que le coach propose, au-dessus du plan en cours.
 *
 * Elle emprunte le vocabulaire de {@link PlanProposal} — mêmes cartes de
 * semaine, mêmes séances, même déroulé détaillé, toutes les semaines dépliées —
 * parce que la question posée est la même : « est-ce que ce programme me
 * convient ? », et qu'y répondre suppose de le voir. La différence est
 * d'étendue : une proposition de plan remplace tout, une réévaluation ne
 * réécrit que la fin.
 *
 * ## Les semaines affichées sont celles de la fenêtre réécrite
 *
 * Le découpage part du jour de reprise, sur la grille de semaines du plan : la
 * première semaine est donc **entamée**, exactement comme dans le plan réel.
 * Leur numérotation est décalée pour retomber sur celle du plan — « Semaine 6 »
 * ici doit être la même que « Semaine 6 » dans le bloc du dessous, sans quoi la
 * comparaison, qui est tout l'objet de l'écran, ne se ferait pas.
 *
 * Les séances proposées portent des identifiants négatifs : elles n'existent pas
 * en base (cf. `data/plan-revisions.ts`), et rien ici n'en fait autre chose
 * qu'une clé de rendu.
 */
export function PlanRevisionProposal({
  detail,
  plan,
  today,
  hrAnchor,
}: {
  detail: PlanRevisionDetailDto;
  /** Le plan visé — sa longueur donne le numéro des semaines réécrites. */
  plan: PlanDto;
  /** Date civile du jour, calculée côté serveur dans le fuseau de l'athlète. */
  today: string;
  /** L'ancrage cardiaque du profil, `null` sans référence — cf. `PlanView`. */
  hrAnchor: HrZoneAnchor | null;
}) {
  const { revision } = detail;
  const direction = PLAN_REVISION_DIRECTIONS[revision.direction];
  const intensity = formatRevisionIntensity(revision.before, revision.after);

  // La fenêtre réécrite, vue comme un mini-plan qui démarrerait au jour de
  // reprise : `groupPlanWeeks` retombe alors sur la grille ISO du plan, et
  // n'affiche de la première semaine que les jours encore replanifiables.
  const offset = plan.weeks - revision.weeks;
  const weeks = groupPlanWeeks(
    { startsOn: detail.fromDate, weeks: revision.weeks },
    detail.sessions,
    today,
  ).map((week) => ({ ...week, number: week.number + offset, expanded: true }));

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Panel
        title="Réévaluation proposée"
        meta={<span className="num">{revision.weeks} semaines réécrites</span>}
      >
        <p className="eyebrow">{PLAN_REVISION_SOURCE_LABELS[revision.source]}</p>

        <h3 className="mt-1 flex items-baseline gap-2 text-[1.15rem] leading-snug font-semibold text-fg">
          {/* Le signe double la phrase, il ne la remplace pas : masqué aux
              lecteurs d'écran, qui n'ont pas à annoncer « flèche vers le haut ».
              Et aucun ton sémantique — baisser la charge n'est pas une erreur. */}
          <span aria-hidden="true" className="num text-accent">
            {direction.sign}
          </span>
          {direction.label}
        </h3>

        <p className="num mt-1.5 text-[0.85rem] text-fg-muted">
          {formatRevisionVolume(revision.before, revision.after, revision.weeks)}
          {intensity === null ? null : <> · {intensity}</>}
        </p>

        <p className="mt-3 text-[0.87rem] leading-relaxed text-fg-muted">{revision.reason}</p>

        <p className="mt-3 text-[0.78rem] leading-relaxed text-fg-faint">
          Rien n’est appliqué tant que tu n’as pas accepté : ton plan, ses allures et ton
          calendrier sont inchangés.
        </p>
      </Panel>

      <section className="flex flex-col gap-3">
        <h3 className="eyebrow px-0.5">Les semaines proposées</h3>
        {weeks.map((week) => (
          <PlanWeekCard key={week.startsOn} week={week} today={today} hrAnchor={hrAnchor} />
        ))}
      </section>

      <Panel title="Ta décision">
        <PlanRevisionDecisionForm revisionId={revision.id} />
      </Panel>
    </div>
  );
}
