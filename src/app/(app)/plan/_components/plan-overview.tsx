import { CalendarRange, Flag } from "lucide-react";

import { MarkdownLite } from "@/components/markdown-lite";
import type { PlanDto } from "@/data/plans";

import { formatDuration } from "../../_lib/format";
import {
  LEVEL_LABELS,
  REFERENCE_DISTANCE_LABELS,
  formatRaceTimeSeconds,
} from "../_lib/form-options";
import { formatCivilDay, formatIsoDay } from "../_lib/format-plan";
import { planEndsOn } from "../_lib/plan-weeks";

/**
 * La carte d'identité d'un plan : son objectif, sa fenêtre, ses contraintes
 * déclarées et l'approche rédigée par le coach.
 *
 * Partagée par le plan en cours et par la proposition soumise à l'athlète : les
 * deux doivent se lire exactement pareil, puisque toute la question est de
 * comparer l'un à l'autre. Le composant ne porte pas son propre panneau — c'est
 * l'appelant qui décide du titre et du contenu de son en-tête.
 */

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

export function PlanOverview({ plan }: { plan: PlanDto }) {
  const endsOn = planEndsOn(plan);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <GoalBadge plan={plan} />
        <span className="num text-[0.72rem] text-fg-faint">
          {formatCivilDay(plan.startsOn)} → {formatCivilDay(endsOn)}
        </span>
        {/* Les plans antérieurs au champ n'ont pas de niveau : rien ne s'affiche. */}
        {plan.level === null ? null : (
          <span className="text-[0.72rem] text-fg-faint">Niveau : {LEVEL_LABELS[plan.level]}</span>
        )}
      </div>

      <p className="mt-3 text-[1.15rem] leading-snug font-semibold text-balance text-fg">
        {plan.goalText}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Setting label="Séances / semaine" value={String(plan.sessionsPerWeek)} />
        <Setting label="Sortie longue" value={formatIsoDay(plan.longRunDay)} />
        {plan.weeklyTimeMinutes === null ? null : (
          <Setting label="Temps hebdo" value={formatDuration(plan.weeklyTimeMinutes * 60)} />
        )}
        {/*
          Le chrono qui a calculé les allures du plan. Rien ne s'affiche sans lui
          — ni sur les plans antérieurs au champ, ni quand l'athlète l'a laissé
          vide : c'est précisément l'information « tes allures sont calées sur
          ceci », et l'inventer serait mentir.
        */}
        {plan.referenceDistance === null || plan.referenceTimeS === null ? null : (
          <Setting
            label="Chrono de référence"
            value={`${REFERENCE_DISTANCE_LABELS[plan.referenceDistance]} · ${formatRaceTimeSeconds(plan.referenceTimeS)}`}
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
    </>
  );
}
