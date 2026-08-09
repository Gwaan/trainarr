import Link from "next/link";
import { ChevronRight, Play } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Sparkline } from "@/components/sparkline";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import {
  ATHLETE,
  KPI_CTL,
  KPI_TSB,
  KPI_VO2MAX,
  RECENT_ACTIVITIES,
  TODAY_LABEL,
  TODAY_SESSION,
  TRAINING_LOAD,
} from "./_lib/mock-data";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <PageHeader
        eyebrow={TODAY_LABEL}
        title={`Bonjour, ${ATHLETE.name}`}
        subtitle="Semaine 3 sur 12 — préparation 10 km."
      />

      <section
        aria-label="Indicateurs clés"
        className="grid grid-cols-2 gap-3 md:grid-cols-3"
      >
        <StatCard {...KPI_VO2MAX} />
        <StatCard {...KPI_CTL} />
        <StatCard {...KPI_TSB} className="col-span-2 md:col-span-1" />
      </section>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Panel
          title="Séance du jour"
          meta={<span className="num">{TODAY_SESSION.day}</span>}
          className="lg:col-span-2"
        >
          <p className="eyebrow">{TODAY_SESSION.kind}</p>

          <p className="mt-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="num text-[1.7rem] leading-none font-semibold text-fg">
              {TODAY_SESSION.block}
            </span>
            <span className="num text-[1.05rem] leading-none font-semibold text-accent">
              {TODAY_SESSION.target}
            </span>
          </p>

          <dl className="mt-4 border-t border-border">
            {TODAY_SESSION.details.map((detail) => (
              <div
                key={detail.label}
                className="flex items-baseline justify-between gap-3 border-b border-border py-2.5"
              >
                <dt className="text-[0.82rem] text-fg-muted">{detail.label}</dt>
                <dd className="num text-[0.82rem] text-fg">{detail.value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 grid grid-cols-2 gap-2">
            {TODAY_SESSION.summary.map((item) => (
              <div
                key={item.label}
                className="rounded-button bg-surface-2 px-3 py-2"
              >
                <p className="eyebrow">{item.label}</p>
                <p className="num mt-1.5 text-[0.95rem] font-semibold text-fg">
                  {item.value}
                </p>
              </div>
            ))}
          </div>

          <Button size="lg" className="mt-5 w-full">
            <Play aria-hidden="true" className="size-4 fill-current" />
            Démarrer la séance
          </Button>
        </Panel>

        <Panel
          title="Charge d'entraînement"
          meta={<span className="num">6 semaines</span>}
          className="lg:col-span-3"
        >
          <Sparkline
            className="max-h-72 min-h-32 flex-1 sm:min-h-40"
            data={TRAINING_LOAD.ctl}
            label={`Charge chronique (CTL) sur 6 semaines, de ${TRAINING_LOAD.ctl[0]} à ${TRAINING_LOAD.ctl[TRAINING_LOAD.ctl.length - 1]}`}
          />
          <div className="mt-3 flex justify-between">
            {TRAINING_LOAD.weeks.map((week) => (
              <span key={week} className="eyebrow num">
                {week}
              </span>
            ))}
          </div>
          <p className="mt-4 border-t border-border pt-3 text-[0.78rem] leading-snug text-fg-faint md:mt-auto">
            CTL — charge d&apos;entraînement chronique, lissée sur 42 jours.
          </p>
        </Panel>
      </div>

      <Panel
        title="Dernières activités"
        padded={false}
        meta={
          <Link
            href="/activities"
            className="inline-flex items-center gap-0.5 rounded-button text-fg-muted transition-colors duration-150 ease-out hover:text-accent"
          >
            Tout voir
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </Link>
        }
      >
        <ul>
          {RECENT_ACTIVITIES.map((activity) => (
            <li key={activity.id} className="border-b border-border last:border-b-0">
              <Link
                href="/activities"
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-2 sm:px-5"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[0.9rem] font-medium text-fg">
                    {activity.name}
                  </span>
                  <span className="eyebrow mt-1.5 block">{activity.day}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 sm:gap-6">
                  <span className="num w-[4.6rem] text-right text-[0.82rem] text-fg">
                    {activity.distance}
                  </span>
                  <span className="num w-[4.6rem] text-right text-[0.82rem] text-fg-muted">
                    {activity.pace}
                  </span>
                  <span className="num hidden w-[4.6rem] text-right text-[0.82rem] text-fg-muted sm:block">
                    {activity.heartRate}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
