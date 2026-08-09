import type { Metadata } from "next";
import { CalendarRange } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Plan",
};

export default function PlanPage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <PageHeader
        title="Plan"
        subtitle="Ton programme semaine par semaine, ajusté à ta charge réelle."
      />

      <Panel title="Programme en cours" padded={false}>
        <EmptyState
          icon={CalendarRange}
          title="Aucun plan actif"
          description="Choisis un objectif et une date de course : le plan se construira autour de ta charge actuelle, puis s'ajustera à chaque séance."
          action={
            <Button variant="secondary" disabled>
              Créer un plan
            </Button>
          }
        />
      </Panel>
    </div>
  );
}
