import type { Metadata } from "next";
import { Activity } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Activités",
};

export default function ActivitiesPage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <PageHeader
        title="Activités"
        subtitle="L'historique complet de tes sorties, distances, allures et fréquences cardiaques."
      />

      <Panel title="Historique" padded={false}>
        <EmptyState
          icon={Activity}
          title="Aucune activité synchronisée"
          description="Connecte ton compte Strava pour importer automatiquement tes sorties et retrouver ici tout ton historique."
          action={
            <Button variant="secondary" disabled>
              Connecter Strava
            </Button>
          }
        />
      </Panel>
    </div>
  );
}
