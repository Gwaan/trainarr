/**
 * Lecture de la dérive cardiaque — fonction pure, testée.
 *
 * Le calcul (`computeDecoupling`) ne porte aucun jugement : il rend un
 * pourcentage. C'est ici que ce pourcentage devient une **lecture**, et les
 * seuils viennent de Joe Friel, « Aerobic Endurance and Decoupling »
 * (joefrielsblog.com, 2011), qui retient **5 %** comme frontière de l'endurance
 * aérobie établie. Au-delà de 10 %, la dérive est franche : chaleur,
 * déshydratation ou intensité trop haute pour la durée visée.
 *
 * Un découplage **négatif** (le cœur redescend à allure tenue) reste un couplage
 * stable : il n'y a rien à signaler quand l'efficience s'améliore.
 */

/** Sous ce seuil, l'endurance aérobie est dite « établie » (Friel). */
export const STABLE_MAX_PCT = 5;

/** Au-delà, la dérive n'est plus modérée. */
export const MODERATE_MAX_PCT = 10;

export type DecouplingVerdict = {
  /** Ton **d'état**, jamais une couleur de série. */
  tone: "positive" | "warning" | "negative";
  /** Libellé affiché : la couleur ne dit jamais rien seule. */
  label: string;
};

export function decouplingVerdict(decouplingPct: number): DecouplingVerdict {
  if (!Number.isFinite(decouplingPct) || decouplingPct <= STABLE_MAX_PCT) {
    return { tone: "positive", label: "Couplage stable" };
  }
  if (decouplingPct <= MODERATE_MAX_PCT) {
    return { tone: "warning", label: "Dérive modérée" };
  }
  return { tone: "negative", label: "Forte dérive" };
}

/**
 * Allure moyenne d'une moitié, en secondes par kilomètre.
 *
 * La moitié porte une vitesse (m/s) : la distance couverte en une seconde vaut
 * cette vitesse en mètres, ce qui ramène la conversion à `paceSecPerKm`.
 */
export function pacePerKmOf(avgSpeedMps: number): number | null {
  if (!Number.isFinite(avgSpeedMps) || avgSpeedMps <= 0) return null;
  return 1000 / avgSpeedMps;
}
