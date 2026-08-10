/**
 * Message d'un indicateur non calculable — fonctions pures, testées.
 *
 * Le tableau de bord affichait « la charge se calcule dès que ton profil est
 * complet *et* que des séances avec FC sont importées » : deux conditions, aucun
 * moyen de savoir laquelle manquait. Ça a coûté une session de debug. Le DAL
 * calcule désormais la cause réelle (`FitnessUnavailableDto`,
 * `Vo2maxUnavailableDto`) ; ici on la met en français, **une seule à la fois**,
 * la plus actionnable d'abord — un champ de profil se remplit en dix secondes,
 * une séance manquante non.
 */

import type { FitnessUnavailableDto, Vo2maxUnavailableDto } from "@/data/dashboard";

export type MetricUnavailableCopy = {
  title: string;
  description: string;
  action?: { href: string; label: string };
};

const PROFILE_ACTION = { href: "/profile", label: "Compléter mon profil" } as const;

const PROFILE_FIELD_LABELS: Record<
  FitnessUnavailableDto["missingProfileFields"][number],
  string
> = {
  sex: "ton sexe",
  maxHrBpm: "ta FC max",
  restingHrBpm: "ta FC de repos",
};

/** Énumération française : « a », « a et b », « a, b et c ». */
function joinFrench(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}`;
}

/**
 * Pourquoi la charge (CTL, ATL, TSB) manque. `cause` est `null` quand aucun
 * athlète n'existe — le placeholder n'est alors pas affiché, mais la fonction
 * reste totale.
 */
export function describeFitnessUnavailable(
  cause: FitnessUnavailableDto | null,
): MetricUnavailableCopy {
  if (cause && cause.missingProfileFields.length > 0) {
    const fields = joinFrench(
      cause.missingProfileFields.map((field) => PROFILE_FIELD_LABELS[field]),
    );
    return {
      title: "Profil incomplet",
      description: `Renseigne ${fields} dans ton profil pour activer le calcul de charge.`,
      action: PROFILE_ACTION,
    };
  }

  if (cause?.noHeartRateData) {
    return {
      title: "Aucune séance avec fréquence cardiaque",
      description:
        "La charge se calcule à partir du TRIMP, qui repose entièrement sur la FC : il faut au moins une séance enregistrée avec un cardio.",
    };
  }

  /*
   * Profil complet, séances avec FC, et pourtant rien : leurs FC moyennes sont
   * toutes hors de la plage définie par le profil. Cas résiduel, mais le dire
   * vaut mieux que de renvoyer l'athlète vers des conditions déjà remplies.
   */
  return {
    title: "Charge indisponible",
    description:
      "Aucune séance importée n'a de fréquence cardiaque exploitable au regard de ta FC de repos et de ta FC max.",
  };
}

/** Pourquoi la VO₂max manque — même logique que `describeFitnessUnavailable`. */
export function describeVo2maxUnavailable(
  cause: Vo2maxUnavailableDto | null,
): MetricUnavailableCopy {
  if (cause?.missingMaxHrBpm) {
    return {
      title: "FC max manquante",
      description:
        "L'estimation corrige ton allure par ta fréquence cardiaque : sans ta FC max, elle n'a pas de référence. Renseigne-la dans ton profil.",
      action: PROFILE_ACTION,
    };
  }

  if (cause?.noRecentRunWithHeartRate) {
    return {
      title: "Aucune course avec FC sur 30 jours",
      description:
        "L'estimation ne retient que les courses des trente derniers jours enregistrées avec un cardio.",
    };
  }

  if (cause) {
    return {
      title: "Pas encore d'effort exploitable",
      description:
        "Les courses des trente derniers jours sont trop courtes (moins de 1,5 km ou de 4 min), ou leur fréquence cardiaque est incohérente avec ta FC max.",
    };
  }

  // Aucun athlète : la carte d'accueil porte déjà l'invitation à créer le profil.
  return {
    title: "VO₂max indisponible",
    description:
      "L'estimation corrige ton allure par ta fréquence cardiaque : elle demande ta FC max et des courses enregistrées avec un cardio.",
  };
}
