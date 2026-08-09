import type { Metadata } from "next";
import { Sparkles } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Coach",
};

export default function CoachPage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <PageHeader
        title="Coach"
        subtitle="Un regard sur tes données d'entraînement, disponible à toute heure."
      />

      <Panel title="Conversation" padded={false}>
        <EmptyState
          icon={Sparkles}
          title="Le coach attend tes premières données"
          description="Dès que tes séances seront synchronisées, le coach pourra commenter ta charge, ta forme et te suggérer des ajustements."
          action={
            <Button variant="secondary" disabled>
              Démarrer une conversation
            </Button>
          }
        />
      </Panel>
    </div>
  );
}
