import { Settings2, Unplug, type LucideIcon } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";
import type { AiUnavailableReason } from "@/lib/ai/errors";

/**
 * Aucun plan actif, et le coach n'est pas joignable.
 *
 * Règle produit : les fonctions IA sont **suspendues** et le disent, plutôt que
 * d'échouer au clic. Aucune action n'est proposée ici — il n'y a rien que
 * l'écran puisse tenter à la place de l'utilisatrice.
 */

const REASONS: Record<
  AiUnavailableReason,
  { icon: LucideIcon; title: string; description: string }
> = {
  unconfigured: {
    icon: Settings2,
    title: "Coach IA non configuré",
    description:
      "La création d'un plan passe par le coach. Renseigne AI_BASE_URL dans .env.local (adresse de ton serveur de modèle), puis relance l'application.",
  },
  unreachable: {
    icon: Unplug,
    title: "Coach IA injoignable",
    description:
      "L'API IA configurée ne répond pas — le temps qu'elle revienne, la création de plan est suspendue. Cet écran se réactivera de lui-même dès qu'elle répondra.",
  },
};

export function AiSuspendedPanel({ reason }: { reason: AiUnavailableReason }) {
  const { icon, title, description } = REASONS[reason];

  return (
    <Panel title="Programme en cours" padded={false}>
      <EmptyState icon={icon} title={title} description={description} />
    </Panel>
  );
}
