import { CalendarRange, Dumbbell, Flag } from "lucide-react";

import { MarkdownLite } from "@/components/markdown-lite";
import type { PlanDto } from "@/data/plans";
import { toCivilDate } from "@/lib/dates/civil";

import { formatDuration } from "../../_lib/format";
import {
  LEVEL_LABELS,
  REFERENCE_DISTANCE_LABELS,
  formatRaceTimeSeconds,
} from "../_lib/form-options";
import { formatCivilDay, formatIsoDay } from "../_lib/format-plan";
import { INTENT_LABELS, INTENT_STRENGTH_NOTES } from "../_lib/plan-intent";
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

/** Étiquette de l'échéance : la date de la course, ou l'absence de date. */
function GoalBadge({ plan }: { plan: PlanDto }) {
  const isRace = plan.intent === "race" && plan.raceDate !== null;
  const Icon = isRace ? Flag : CalendarRange;

  return (
    <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-surface-2 px-2 py-1 text-[0.72rem] text-fg-muted">
      <Icon aria-hidden="true" strokeWidth={1.8} className="size-3.5 text-fg-faint" />
      {isRace && plan.raceDate !== null ? (
        <>
          Course le <span className="num text-fg">{formatCivilDay(plan.raceDate)}</span>
        </>
      ) : (
        "Sans échéance"
      )}
    </span>
  );
}

/**
 * La recommandation de renforcement, en encart discret.
 *
 * Elle n'est pas dans le calendrier et n'y sera pas : ce plan n'écrit que de la
 * course, et prescrire des séances qu'il ne sait ni doser ni suivre serait
 * décoratif. Mais c'est le complément le mieux étayé après le volume — le taire
 * pour rester dans son périmètre reviendrait à cacher ce qui marche.
 */
function StrengthNote({ plan }: { plan: PlanDto }) {
  return (
    <div className="mt-4 flex gap-2.5 rounded-button bg-surface-2 px-3 py-2.5">
      <Dumbbell
        aria-hidden="true"
        strokeWidth={1.8}
        className="mt-0.5 size-4 shrink-0 text-fg-faint"
      />
      <div className="min-w-0">
        <p className="eyebrow">En complément du plan</p>
        <p className="mt-1 text-[0.8rem] leading-relaxed text-fg-muted">
          {INTENT_STRENGTH_NOTES[plan.intent]}
        </p>
      </div>
    </div>
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

      {/* L'intention, et non plus le texte libre : c'est elle qui dit ce que ce
          plan est. La note de l'athlète, quand elle en a écrit une, se lit en
          dessous — une précision, pas un titre. */}
      <p className="mt-3 text-[1.15rem] leading-snug font-semibold text-balance text-fg">
        {INTENT_LABELS[plan.intent]}
      </p>
      {plan.goalText.trim() === "" ? null : (
        <p className="mt-1 text-[0.85rem] leading-snug text-fg-muted">{plan.goalText}</p>
      )}

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

      <StrengthNote plan={plan} />

      {/*
        La dernière relecture automatique du plan. Rien ne s'affiche tant qu'il
        n'y en a pas eu : une ligne « jamais révisé » n'apprendrait rien, et
        dater la révision par la création du plan serait faux.
      */}
      {plan.reviewedAt === null ? null : (
        <p className="mt-3 text-[0.72rem] text-fg-faint">
          Révisé par le coach le{" "}
          <span className="num">{formatCivilDay(toCivilDate(new Date(plan.reviewedAt)))}</span>
        </p>
      )}
    </>
  );
}
