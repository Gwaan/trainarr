import { ChartSpline } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";

/**
 * Séance sans séries temporelles exploitables : la page reste digne — en-tête et
 * chiffres de la séance restent affichés, et ce bloc dit ce qui manque plutôt
 * que de laisser un cadre vide.
 *
 * Les deux-points sont précédés d'une espace fine insécable (U+202F) : la
 * typographie française l'exige, et elle évite un « : » rejeté en début de ligne
 * sur les écrans étroits.
 */
export function NoDetailedData() {
  return (
    <Panel title="Analyse de la séance" padded={false}>
      <EmptyState
        icon={ChartSpline}
        title="Pas de données détaillées pour cette séance"
        description="Aucune série temporelle n'a été enregistrée : ni allure, ni fréquence cardiaque, ni altitude seconde par seconde. Les chiffres ci-dessus restent, eux, ceux du fichier importé."
      />
    </Panel>
  );
}
