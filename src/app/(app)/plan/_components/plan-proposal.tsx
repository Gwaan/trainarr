import { Panel } from "@/components/panel";
import type { PlanDto, PlanSessionDto } from "@/data/plans";
import type { HrZoneAnchor } from "@/lib/metrics/hr-zones";

import { PLAN_PROPOSAL_ANCHOR_ID } from "../_lib/anchors";
import { groupPlanWeeks } from "../_lib/plan-weeks";

import { PlanDecisionForm } from "./plan-decision-form";
import { PlanOverview } from "./plan-overview";
import { PlanWeekCard } from "./plan-week-card";

/**
 * La proposition du coach, soumise à l'athlète.
 *
 * Elle s'affiche exactement comme un plan — mêmes cartes de semaine, mêmes
 * séances, même déroulé détaillé — parce que la décision se prend sur le plan
 * réel, pas sur un résumé : ce qu'elle voit ici est ce qu'elle suivra.
 *
 * Une seule différence : **toutes** les semaines sont dépliées. Sur le plan en
 * cours, seule la semaine courante s'ouvre (une pile de douze semaines ouvertes
 * n'est pas lisible au quotidien) ; ici, la question posée est « est-ce que ce
 * plan me convient ? », et y répondre suppose de tout voir sans avoir à ouvrir
 * douze cartes.
 *
 * Les boutons ferment le bloc, après le détail : on tranche une fois qu'on a lu.
 */
export function PlanProposal({
  plan,
  sessions,
  today,
  hrAnchor,
  hasActivePlan,
}: {
  plan: PlanDto;
  sessions: PlanSessionDto[];
  /** Date civile du jour, calculée côté serveur dans le fuseau de l'athlète. */
  today: string;
  /** L'ancrage cardiaque du profil, `null` sans référence — cf. `PlanView`. */
  hrAnchor: HrZoneAnchor | null;
  /** Un plan actif que l'adoption archiverait. */
  hasActivePlan: boolean;
}) {
  const weeks = groupPlanWeeks(plan, sessions, today).map((week) => ({
    ...week,
    expanded: true,
  }));

  return (
    // `tabIndex={-1}` et l'id : la modale de création vise ce conteneur pour y
    // poser le focus dès que la proposition remplace le formulaire (cf.
    // `_lib/anchors.ts`). Pas de contour au focus — le déplacement sert
    // l'annonce, pas la navigation au clavier, et il n'est jamais atteint par
    // `Tab`.
    <div
      id={PLAN_PROPOSAL_ANCHOR_ID}
      tabIndex={-1}
      className="flex flex-col gap-5 focus:outline-none sm:gap-6"
    >
      <Panel
        title="Proposition du coach"
        meta={<span className="num">{weeks.length} semaines</span>}
      >
        <p className="mb-4 text-[0.85rem] leading-relaxed text-fg-muted">
          Le coach a écrit ce plan à partir de ton objectif et de ta charge des dernières
          semaines. Parcours-le : rien n&apos;est engagé tant que tu ne l&apos;as pas adopté.
        </p>

        <PlanOverview plan={plan} />
      </Panel>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow px-0.5">Le programme proposé</h2>
        {weeks.map((week) => (
          <PlanWeekCard key={week.startsOn} week={week} today={today} hrAnchor={hrAnchor} />
        ))}
      </section>

      <Panel title="Ta décision">
        <PlanDecisionForm planId={plan.id} replacesActivePlan={hasActivePlan} />
      </Panel>
    </div>
  );
}
