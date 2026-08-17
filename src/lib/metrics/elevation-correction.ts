/**
 * Correction d'altitude de la distance — **formule de Peter Greif**, telle que
 * Runalyze l'applique.
 *
 * ## La règle
 *
 * Un mètre monté coûte comme si on avait couru plusieurs mètres de plat ; un
 * mètre descendu en fait gagner. La correction s'exprime donc en **distance
 * équivalente**, et non en temps ni en allure :
 *
 * ```
 * distance corrigée = distance + coefMontée × D+ + coefDescente × D−
 * ```
 *
 * C'est la distance corrigée qui entre ensuite dans l'estimation de VO₂max
 * (`./vo2max`) : la même durée sur une distance plus grande donne une vitesse
 * plus élevée, donc une VO₂max plus haute — ce qui est exactement le propos.
 *
 * ## Source, et pourquoi ces valeurs par défaut
 *
 * Runalyze expose ce réglage dans « Paramètres › Calculs », sous « Adapter
 * suivant le dénivelé », avec la mention **« Défaut : oui »** et deux
 * coefficients : **+2 m** de distance ajoutés par mètre monté, **−1 m** par
 * mètre descendu (relevé sur l'installation réelle de l'athlète le 17/08/2026).
 * L'en-tête de `./vo2max` porte le constat complet, y compris le fait que la
 * constante `VO2MAX_USE_CORRECTION_FOR_ELEVATION = false` lue dans la branche
 * `support/4.3.x` du dépôt **ne décrit pas** le comportement servi aujourd'hui.
 *
 * Effet mesuré sur la séance de référence (2 910 m, 19:57, 158 bpm, FC max 195,
 * D+ 32 m, boucle) : 34,6 → ≈ 35,1. Un demi-point sur du plat ; en trail, la
 * correction change l'ordre de grandeur.
 *
 * ## Ce que le module refuse de faire
 *
 * **Un dénivelé inconnu n'est pas un dénivelé nul.** Quand l'un des deux sens
 * manque, {@link correctedDistanceM} rend `null` et l'appelant garde la distance
 * réelle : la valeur reste alors celle d'avant la correction, ce qui n'est pas
 * la même chose qu'une correction calculée à zéro. Et la perte ne se déduit
 * jamais du gain — supposer une boucle serait inventer une donnée.
 */

/** Mètres de distance ajoutés par mètre monté. Défaut de Runalyze. */
export const DEFAULT_ASCENT_COEF_M = 2;

/** Mètres de distance ajoutés par mètre descendu — **négatif**. Défaut de Runalyze. */
export const DEFAULT_DESCENT_COEF_M = -1;

/**
 * Bornes des deux coefficients.
 *
 * Elles ne sortent d'aucune publication : elles encadrent le réglage pour qu'une
 * saisie (ou un appel direct à la Server Action) ne puisse pas transformer 30 m
 * de dénivelé en plusieurs kilomètres de distance fantôme. Dix mètres par mètre
 * monté, c'est déjà cinq fois le défaut de Greif — au-delà, c'est une erreur de
 * saisie, pas une préférence.
 *
 * Les signes sont contraints eux aussi : monter ne peut pas raccourcir une
 * course, descendre ne peut pas la rallonger. Zéro reste permis des deux côtés —
 * c'est la façon de ne corriger que dans un sens.
 */
export const ASCENT_COEF_BOUNDS = { min: 0, max: 10 } as const;
export const DESCENT_COEF_BOUNDS = { min: -10, max: 0 } as const;

/** Les deux coefficients de Greif, tels qu'ils sont réglés au profil. */
export type ElevationCorrection = {
  ascentCoefM: number;
  descentCoefM: number;
};

/**
 * Le dénivelé d'une séance, tel qu'il est persisté sur la ligne d'activité.
 * `null` = inconnu (ni champ de session dans le fichier FIT, ni flux d'altitude
 * exploitable) — surtout pas « zéro ».
 */
export type ActivityElevation = {
  gainM: number | null;
  /** Amplitude de descente, **positive**. */
  lossM: number | null;
};

/**
 * Distance corrigée du dénivelé, en mètres. `null` quand la correction ne
 * s'applique pas — l'appelant garde alors la distance réelle.
 *
 * Rend `null`, et jamais une approximation, si :
 *  - la correction est désactivée au profil (`correction` à `null`) ;
 *  - le dénivelé est inconnu, **d'un côté ou de l'autre** : la formule a besoin
 *    des deux sens, et la perte ne se déduit pas du gain ;
 *  - une des valeurs n'est pas un nombre exploitable (dénivelé négatif compris —
 *    un D+ ne peut pas l'être) ;
 *  - la distance corrigée tomberait à zéro ou en dessous. Le cas est théorique
 *    avec les bornes en vigueur (il faudrait une descente de plusieurs fois la
 *    distance courue), mais une vitesse négative n'a pas de rattrapage en aval.
 */
export function correctedDistanceM(
  distanceM: number,
  elevation: ActivityElevation | null,
  correction: ElevationCorrection | null,
): number | null {
  if (correction === null || elevation === null) return null;
  if (!Number.isFinite(distanceM)) return null;

  const { gainM, lossM } = elevation;
  if (gainM === null || lossM === null) return null;
  if (!Number.isFinite(gainM) || gainM < 0) return null;
  if (!Number.isFinite(lossM) || lossM < 0) return null;

  const { ascentCoefM, descentCoefM } = correction;
  if (!Number.isFinite(ascentCoefM) || !Number.isFinite(descentCoefM)) return null;

  const corrected = distanceM + ascentCoefM * gainM + descentCoefM * lossM;
  return corrected > 0 ? corrected : null;
}
