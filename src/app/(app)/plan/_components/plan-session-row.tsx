import Link from "next/link";
import { CircleCheck } from "lucide-react";

import type { PlanSessionDto } from "@/data/plans";
import { cn } from "@/lib/utils";

import { formatDistance, formatDuration, formatPace } from "../../_lib/format";
import { formatSessionDay } from "../_lib/format-plan";
import { planSessionState } from "../_lib/plan-weeks";

/**
 * Une séance du plan.
 *
 * Quatre lectures possibles, portées par le seul style : réalisée (marqueur
 * `positive`, la ligne mène à l'activité), aujourd'hui (filet accent, comme
 * l'item actif de la navigation), manquée (atténuée), à venir (neutre).
 */

const DETAIL_LABELS = [
  { key: "warmup", label: "Échauffement" },
  { key: "recovery", label: "Récupération" },
  { key: "cooldown", label: "Retour au calme" },
] as const;

export function PlanSessionRow({
  session,
  today,
}: {
  session: PlanSessionDto;
  today: string;
}) {
  const state = planSessionState(session, today);
  const isToday = session.scheduledOn === today;

  const details: { label: string; value: string }[] = [];
  for (const detail of DETAIL_LABELS) {
    const value = session[detail.key];
    if (value !== null) details.push({ label: detail.label, value });
  }

  // Une seule ligne chiffrée, en mono : volume, durée, allure cible.
  const metrics = [
    session.volumeM === null ? null : formatDistance(session.volumeM),
    session.durationS === null ? null : formatDuration(session.durationS),
    session.targetPaceSecPerKm === null ? null : `@ ${formatPace(session.targetPaceSecPerKm)}`,
  ]
    .filter((metric): metric is string => metric !== null)
    .join(" · ");

  const body = (
    <>
      <span
        className={cn(
          "num w-[3.9rem] shrink-0 pt-0.5 text-[0.78rem]",
          isToday ? "text-accent" : "text-fg-faint",
        )}
      >
        {isToday ? <span className="sr-only">Aujourd&apos;hui, </span> : null}
        {formatSessionDay(session.scheduledOn)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="eyebrow block">{session.kind}</span>
        <span className="mt-1 block text-[0.9rem] leading-snug font-medium text-fg">
          {session.title}
        </span>

        {metrics.length > 0 ? (
          <span className="num mt-1.5 block text-[0.78rem] text-fg-muted">{metrics}</span>
        ) : null}

        {details.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.76rem] leading-snug text-fg-faint">
            {details.map((detail) => (
              <span key={detail.label}>
                {detail.label} : <span className="text-fg-muted">{detail.value}</span>
              </span>
            ))}
          </span>
        ) : null}
      </span>

      {state === "completed" ? (
        <>
          {/* Le marqueur est graphique : sa signification est dite au lecteur d'écran. */}
          <span className="sr-only">Séance réalisée — voir l&apos;activité</span>
          <CircleCheck
            aria-hidden="true"
            strokeWidth={1.8}
            className="mt-0.5 size-[1.05rem] shrink-0 text-positive"
          />
        </>
      ) : null}
    </>
  );

  return (
    <li
      className={cn(
        "border-b border-border last:border-b-0",
        isToday && "border-l-2 border-l-accent bg-accent-soft",
        // Une séance passée sans activité rapprochée n'a pas eu lieu : elle
        // reste lisible, mais ne dispute pas l'attention aux séances à venir.
        state === "missed" && "opacity-70",
      )}
    >
      {session.completedActivityId === null ? (
        <div className="flex gap-3 px-4 py-3 sm:px-5">{body}</div>
      ) : (
        <Link
          href={`/activities/${session.completedActivityId}`}
          className="flex gap-3 px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-2 sm:px-5"
        >
          {body}
        </Link>
      )}
    </li>
  );
}
