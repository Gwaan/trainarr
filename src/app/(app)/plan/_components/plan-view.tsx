import { Panel } from "@/components/panel";
import type { PlanDto, PlanSessionDto } from "@/data/plans";
import type { AiUnavailableReason } from "@/lib/ai/errors";

import { formatPlanProgress, groupPlanWeeks } from "../_lib/plan-weeks";

import { PlanAdjustForm } from "./plan-adjust-form";
import { PlanArchiveForm } from "./plan-archive-form";
import { PlanOverview } from "./plan-overview";
import { PlanWeekCard } from "./plan-week-card";

/**
 * Le plan actif : son objectif, ses semaines, et les deux actions qui le font
 * évoluer.
 *
 * Le plan reste entièrement consultable quand le coach est injoignable — seul
 * l'ajustement, qui exige le modèle, disparaît au profit d'une note.
 */

const SUSPENDED_NOTE: Record<AiUnavailableReason, string> = {
  unconfigured:
    "Ajustement suspendu : aucune API IA n'est configurée (AI_BASE_URL). Ton plan reste consultable.",
  unreachable:
    "Ajustement suspendu : l'API IA ne répond pas. Il se réactivera de lui-même dès qu'elle sera de nouveau en ligne.",
};

export type PlanViewProps = {
  plan: PlanDto;
  sessions: PlanSessionDto[];
  /** Date civile du jour, calculée côté serveur dans le fuseau de l'athlète. */
  today: string;
  /** `null` quand le coach est joignable. */
  unavailableReason: AiUnavailableReason | null;
};

export function PlanView({ plan, sessions, today, unavailableReason }: PlanViewProps) {
  const weeks = groupPlanWeeks(plan, sessions, today);

  return (
    <>
      <Panel
        title="Objectif"
        // Où en est le plan, plutôt que sa seule longueur : c'est la première
        // question qu'on se pose en ouvrant la page.
        meta={<span className="num">{formatPlanProgress(weeks)}</span>}
      >
        <PlanOverview plan={plan} />
      </Panel>

      {/* Les semaines forment une section à part entière : elles méritent un
          intitulé, pas d'être posées entre deux panneaux. */}
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow px-0.5">Programme</h2>
        {weeks.map((week) => (
          <PlanWeekCard key={week.startsOn} week={week} today={today} />
        ))}
      </section>

      <Panel title="Ajuster le plan">
        {unavailableReason === null ? (
          <PlanAdjustForm />
        ) : (
          <p className="text-[0.82rem] leading-relaxed text-fg-faint">
            {SUSPENDED_NOTE[unavailableReason]}
          </p>
        )}

        <div className="mt-5 border-t border-border pt-4">
          <PlanArchiveForm />
        </div>
      </Panel>
    </>
  );
}
