import { Settings2, Unplug, type LucideIcon } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";
import type { AiUnavailableReason } from "@/lib/ai/errors";

/**
 * Ce qu'un écran affiche à la place d'une fonction IA que le coach ne peut pas
 * rendre — création de plan, conversation.
 *
 * Règle produit : les fonctions IA sont **suspendues** et le disent, plutôt que
 * d'échouer au clic. Aucune action n'est proposée ici — il n'y a rien que
 * l'écran puisse tenter à la place de la personne qui l'utilise.
 *
 * ## Ce qui varie, et ce qui ne varie pas
 *
 * Le **diagnostic** (`unconfigured` = variable d'environnement absente,
 * `unreachable` = l'API ne répond pas) et la **marche à suivre** sont les mêmes
 * quel que soit l'écran : ils sont écrits ici, une fois, et aucun appelant ne
 * les recopie. Ne varient que le titre du panneau — l'écran nomme la section
 * que ce panneau occupe — et le nom de la fonction suspendue.
 */

/**
 * La fonction suspendue, dans les deux positions grammaticales où les phrases
 * ci-dessous l'emploient. Deux formes plutôt qu'une : « La création d'un plan
 * passe par le coach » et « la création de plan est suspendue » ne s'accordent
 * pas de la même manière, et une seule forme rendrait l'une des deux bancale.
 */
export type SuspendedAiFeature = {
  /** En tête de phrase, majuscule comprise : « La création d'un plan ». */
  subject: string;
  /**
   * Au fil d'une phrase : « …, la création de plan est suspendue. » Groupe
   * nominal **féminin singulier** — la phrase accorde « suspendue ».
   */
  inline: string;
};

const REASONS: Record<
  AiUnavailableReason,
  { icon: LucideIcon; title: string; describe: (feature: SuspendedAiFeature) => string }
> = {
  unconfigured: {
    icon: Settings2,
    title: "Coach IA non configuré",
    describe: ({ subject }) =>
      `${subject} passe par le coach. Renseigne AI_BASE_URL dans .env.local (adresse de ton serveur de modèle), puis relance l'application.`,
  },
  unreachable: {
    icon: Unplug,
    title: "Coach IA injoignable",
    describe: ({ inline }) =>
      `L'API IA configurée ne répond pas — le temps qu'elle revienne, ${inline} est suspendue. Cet écran se réactivera de lui-même dès qu'elle répondra.`,
  },
};

export type AiSuspendedPanelProps = {
  reason: AiUnavailableReason;
  /** Titre du panneau : la section de l'écran que ce panneau occupe. */
  panelTitle: string;
  feature: SuspendedAiFeature;
};

export function AiSuspendedPanel({ reason, panelTitle, feature }: AiSuspendedPanelProps) {
  const { icon, title, describe } = REASONS[reason];

  return (
    <Panel title={panelTitle} padded={false}>
      <EmptyState icon={icon} title={title} description={describe(feature)} />
    </Panel>
  );
}
