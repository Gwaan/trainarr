import { CalendarRange, Flag } from "lucide-react";

import { MarkdownLite } from "@/components/markdown-lite";
import { Panel } from "@/components/panel";
import type { PlanDto, PlanSessionDto } from "@/data/plans";
import type { AiUnavailableReason } from "@/lib/ai/errors";

import { formatDuration } from "../../_lib/format";
import { formatCivilDay, formatIsoDay } from "../_lib/format-plan";
import { groupPlanWeeks, planEndsOn } from "../_lib/plan-weeks";

import { PlanAdjustForm } from "./plan-adjust-form";
import { PlanArchiveForm } from "./plan-archive-form";
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

/** Étiquette du type d'objectif, avec l'échéance quand il y en a une. */
function GoalBadge({ plan }: { plan: PlanDto }) {
  const isRace = plan.goalType === "race" && plan.raceDate !== null;
  const Icon = isRace ? Flag : CalendarRange;

  return (
    <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-surface-2 px-2 py-1 text-[0.72rem] text-fg-muted">
      <Icon aria-hidden="true" strokeWidth={1.8} className="size-3.5 text-fg-faint" />
      {isRace && plan.raceDate !== null ? (
        <>
          Course le <span className="num text-fg">{formatCivilDay(plan.raceDate)}</span>
        </>
      ) : (
        "Objectif libre"
      )}
    </span>
  );
}

/** Une contrainte du plan : label discret, valeur chiffrée en mono. */
function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-button bg-surface-2 px-3 py-2">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1.5 text-[0.95rem] font-semibold text-fg">{value}</p>
    </div>
  );
}

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
  const endsOn = planEndsOn(plan);

  return (
    <>
      <Panel
        title="Objectif"
        meta={<span className="num">{plan.weeks} semaines</span>}
      >
        <div className="flex flex-wrap items-center gap-2">
          <GoalBadge plan={plan} />
          <span className="num text-[0.72rem] text-fg-faint">
            {formatCivilDay(plan.startsOn)} → {formatCivilDay(endsOn)}
          </span>
        </div>

        <p className="mt-3 text-[1.15rem] leading-snug font-semibold text-balance text-fg">
          {plan.goalText}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Setting label="Séances / semaine" value={String(plan.sessionsPerWeek)} />
          <Setting label="Sortie longue" value={formatIsoDay(plan.longRunDay)} />
          {plan.weeklyTimeMinutes === null ? null : (
            <Setting
              label="Temps hebdo"
              value={formatDuration(plan.weeklyTimeMinutes * 60)}
            />
          )}
        </div>

        {/*
          Le résumé vient du modèle : rien ne l'empêche d'y glisser du markdown,
          qui s'afficherait sinon avec ses astérisques. Même rendu sûr que le
          feedback du coach — aucun HTML injecté.
        */}
        {plan.summary === null ? null : (
          <div className="mt-4 border-t border-border pt-4">
            <MarkdownLite source={plan.summary} className="text-[0.87rem]" />
          </div>
        )}
      </Panel>

      <div className="flex flex-col gap-3">
        {weeks.map((week) => (
          <PlanWeekCard key={week.startsOn} week={week} today={today} />
        ))}
      </div>

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
