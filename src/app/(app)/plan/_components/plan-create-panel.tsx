import { Wand } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";

import { PlanCreateDialog } from "./plan-create-dialog";
import type { PlanDateBounds } from "./plan-form-steps";

/**
 * Aucun plan actif, coach joignable : l'écran n'a qu'une chose à proposer, et il
 * la propose en une phrase et un bouton — les questions, elles, arrivent une
 * étape à la fois dans la modale.
 *
 * Le seul accent de l'écran dans cet état, comme le veut la règle : un CTA par
 * écran.
 */
export function PlanCreatePanel(bounds: PlanDateBounds) {
  return (
    <Panel title="Programme en cours" padded={false}>
      <EmptyState
        icon={Wand}
        title="Pas encore de plan"
        description="Quatre questions et le coach écrit ton programme, appuyé sur ta charge d'entraînement des dernières semaines."
        action={<PlanCreateDialog {...bounds} />}
      />
    </Panel>
  );
}
