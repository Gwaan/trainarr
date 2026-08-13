import { Panel } from "@/components/panel";
import type { PlanDto, PlanSessionDto } from "@/data/plans";
import type { AiUnavailableReason } from "@/lib/ai/errors";

import { formatPlanProgress, groupPlanWeeks } from "../_lib/plan-weeks";

import { PlanAdjustForm } from "./plan-adjust-form";
import { PlanArchiveForm } from "./plan-archive-form";
import { PlanOverview } from "./plan-overview";
import { PlanSyncForm } from "./plan-sync-form";
import { PlanWeekCard } from "./plan-week-card";

/**
 * Le plan actif : son objectif, ses semaines, et les deux actions qui le font
 * évoluer.
 *
 * Le plan reste entièrement consultable quand le coach est injoignable — seul
 * l'ajustement, qui exige le modèle, disparaît au profit d'une note.
 */

/**
 * Ce que dit le panneau « Ajuster le plan » quand le coach ne répond pas.
 *
 * Exporté parce que la vue **calendrier** porte le même panneau : la note doit y
 * être la même au caractère près, sans quoi la même panne se raconterait de deux
 * façons selon l'onglet ouvert.
 */
export const SUSPENDED_NOTE: Record<AiUnavailableReason, string> = {
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
  /**
   * FC max du profil, `null` tant qu'elle n'est pas saisie. Lue une fois par la
   * page et descendue telle quelle : c'est elle qui traduit en battements les
   * zones cardiaques prescrites sur les séances faciles.
   */
  maxHrBpm: number | null;
  /** `null` quand le coach est joignable. */
  unavailableReason: AiUnavailableReason | null;
};

export function PlanView({
  plan,
  sessions,
  today,
  maxHrBpm,
  unavailableReason,
}: PlanViewProps) {
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

        {/*
          En pied des métadonnées du plan, et pas dans `PlanOverview` : cette
          carte est partagée avec la proposition du coach, qui n'a rien à
          synchroniser tant qu'elle n'est pas adoptée.
        */}
        <div className="mt-4 border-t border-border pt-3">
          <PlanSyncForm />
        </div>
      </Panel>

      {/* Les semaines forment une section à part entière : elles méritent un
          intitulé, pas d'être posées entre deux panneaux. */}
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow px-0.5">Programme</h2>
        {weeks.map((week) => (
          <PlanWeekCard key={week.startsOn} week={week} today={today} maxHrBpm={maxHrBpm} />
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
