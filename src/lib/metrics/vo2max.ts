/**
 * VO2max effective — estimée depuis l'allure **corrigée par la fréquence
 * cardiaque**, donc calculable sur une séance quelconque et pas seulement sur
 * une performance maximale.
 *
 * ## Méthode : celle de Runalyze, lue dans son code source
 *
 * Runalyze est open source ; la méthode a été relevée dans le dépôt plutôt que
 * dans la documentation (runalyze.com répond 403 aux robots). Fichiers de
 * référence, branche `support/4.3.x` :
 *
 *  - `src/CoreBundle/Bridge/Activity/Calculation/VO2maxCalculator.php`
 *    → https://github.com/Runalyze/Runalyze/blob/support/4.3.x/src/CoreBundle/Bridge/Activity/Calculation/VO2maxCalculator.php
 *  - `inc/core/Sports/Running/VO2max/Estimation/DanielsGilbertFormula.php`
 *    → https://github.com/Runalyze/Runalyze/blob/support/4.3.x/inc/core/Sports/Running/VO2max/Estimation/DanielsGilbertFormula.php
 *  - `inc/core/Calculation/JD/LegacyEffectiveVO2max.php` (même formule, documentée)
 *    → https://github.com/Runalyze/Runalyze/blob/support/4.3.x/inc/core/Calculation/JD/LegacyEffectiveVO2max.php
 *  - `tests/CoreBundle/Bridge/Activity/Calculation/VO2maxCalculatorTest.php` (cas de référence)
 *    → https://github.com/Runalyze/Runalyze/blob/support/4.3.x/tests/CoreBundle/Bridge/Activity/Calculation/VO2maxCalculatorTest.php
 *
 * `VO2maxCalculator::estimateVO2maxByHeartRate()`, transcrit :
 *
 * ```php
 * $heartRateInPercent = $this->Activity->getPulseAvg() / $this->HeartRateMaximum;
 * $speedReallyAchieved = 60.0 * 1000.0 * $distance / $duration;         // m/min
 * $percentageEstimateByHR = exp(($heartRateInPercent - 1.00466) / 0.68725);
 * $speedEstimateAt100Percent = $speedReallyAchieved / $percentageEstimateByHR;
 * return $this->EstimationFormula->estimateFromVelocity($speedEstimateAt100Percent);
 * ```
 *
 * Trois points comptent, et sont faciles à manquer :
 *
 * 1. **La correction porte sur la VITESSE, pas sur la VO2.** La fraction déduite
 *    de la FC est une fraction de *vVO2max* (la vitesse à VO2max) : on extrapole
 *    l'allure tenue jusqu'à celle de 100 %, puis on lui applique le coût en
 *    oxygène de Daniels & Gilbert. Diviser la demande en O2 par la fraction
 *    donnerait un autre nombre — le coût en oxygène n'est pas proportionnel à la
 *    vitesse (terme quadratique + ordonnée à l'origine de −4.6).
 * 2. **Aucun facteur « drop dead ».** La seconde régression de Daniels
 *    (fraction soutenable selon la durée) n'intervient pas ici : c'est la FC qui
 *    renseigne l'intensité, la durée n'a plus à la deviner. C'est précisément ce
 *    qui rend le calcul valable sur un footing.
 * 3. `exp((r − 1.00466) / 0.68725)` est la réciproque de la relation
 *    `%FCmax = 0.68725·ln(%vVO2max) + 1.00466`, que Runalyze présente comme
 *    « derived via regression from respective tables » (cf. `HRat()` /
 *    `percentageAt()` dans `LegacyEffectiveVO2max.php`). C'est une régression
 *    maison de Runalyze, de la même famille que celle de Swain et al. (1994) sur
 *    la relation %FCmax ↔ %VO2max, mais ce n'est pas la formule de Swain :
 *    inutile d'aller chercher celle-ci, elle donnerait d'autres valeurs.
 *
 * ## Ce que nous ne reprenons pas
 *
 * - **Le facteur correctif de Runalyze** (`VO2maxCorrectionFactorCalculation`,
 *   `RaceresultRepository::getEffectiveVO2maxCorrectionFactor`) vaut
 *   `max(VO2max_par_le_temps / VO2max_par_la_FC)` sur les meilleures courses
 *   déclarées, et **1.0 en l'absence de course déclarée**. Trainarr n'a pas
 *   encore de notion de course : le facteur serait 1.0 chez Runalyze aussi. Rien
 *   n'est donc appliqué. En pratique ce facteur vaut souvent 0.85–0.95, ce qui
 *   veut dire que nos valeurs peuvent lire un peu haut tant qu'aucune course
 *   n'est enregistrée — mieux vaut ça qu'un abattement inventé.
 * - **La correction par le dénivelé** (`VO2maxCalculator::…WithElevation`), que
 *   Runalyze laisse désactivée par défaut (`VO2MAX_USE_CORRECTION_FOR_ELEVATION`
 *   = `false`).
 *
 * ## Écart assumé sur un coefficient
 *
 * Runalyze écrit `-4.6 + 0.182253·v + …` là où Daniels & Gilbert publient
 * `0.182258`. Nous gardons `0.182258` (la source primaire, déjà utilisée par
 * `./vdot`) : l'écart est de l'ordre de 0.0015 ml/kg/min, sans portée pratique.
 */

import {
  MAX_PLAUSIBLE_VO2MAX,
  MIN_EFFORT_DISTANCE_M,
  MIN_EFFORT_DURATION_MIN,
  MIN_PLAUSIBLE_VO2MAX,
  oxygenCostAtVelocity,
} from './vdot';

export type EffectiveVo2maxInput = {
  distanceM: number;
  movingTimeS: number;
  /** FC moyenne de la séance, `null` si le capteur n'a rien enregistré. */
  avgHrBpm: number | null;
  /** FC max de l'athlète — donnée de profil, sans laquelle rien n'est calculable. */
  maxHrBpm: number | null;
};

/**
 * Plage de rapports FC moyenne / FC max exploitables.
 *
 * En dessous de 0.5, la fraction de vVO2max déduite tombe sous 0.48 : on
 * extrapolerait l'allure d'un facteur supérieur à deux, et la moindre imprécision
 * de FC ou de FC max se retrouverait doublée dans le résultat. Au-dessus de 1,
 * la FC moyenne dépasse la FC max déclarée — soit le profil est faux, soit la
 * ceinture a décroché ; dans les deux cas ce n'est pas une donnée.
 */
const MIN_HR_RATIO = 0.5;
const MAX_HR_RATIO = 1;

/**
 * Fraction de vVO2max soutenue à `hrRatio` (= FC moyenne / FC max).
 * Régression de Runalyze, cf. en-tête du module.
 */
function velocityFractionAtHrRatio(hrRatio: number): number {
  return Math.exp((hrRatio - 1.00466) / 0.68725);
}

/**
 * VO2max effective d'une séance de course, en ml/kg/min.
 *
 * Renvoie `null` — jamais une approximation — si :
 *  - la FC moyenne ou la FC max manque, ou n'est pas un nombre exploitable ;
 *  - le rapport FC moyenne / FC max sort de [0.5, 1] (données aberrantes) ;
 *  - la distance ou la durée est invalide, ou l'effort trop court pour être
 *    représentatif (< 1500 m ou < 4 min) ;
 *  - le résultat sort de la plage physiologiquement plausible [20, 90].
 */
export function estimateEffectiveVo2max(input: EffectiveVo2maxInput): number | null {
  const { distanceM, movingTimeS, avgHrBpm, maxHrBpm } = input;

  if (!Number.isFinite(distanceM) || distanceM <= 0) return null;
  if (!Number.isFinite(movingTimeS) || movingTimeS <= 0) return null;
  if (distanceM < MIN_EFFORT_DISTANCE_M) return null;

  const durationMin = movingTimeS / 60;
  if (durationMin < MIN_EFFORT_DURATION_MIN) return null;

  if (avgHrBpm === null || !Number.isFinite(avgHrBpm) || avgHrBpm <= 0) return null;
  if (maxHrBpm === null || !Number.isFinite(maxHrBpm) || maxHrBpm <= 0) return null;

  const hrRatio = avgHrBpm / maxHrBpm;
  if (hrRatio < MIN_HR_RATIO || hrRatio > MAX_HR_RATIO) return null;

  // Allure tenue, puis allure extrapolée à 100 % de vVO2max : c'est là qu'agit
  // la correction par la FC, avant le passage au coût en oxygène.
  const velocityMPerMin = distanceM / durationMin;
  const velocityAtVo2max = velocityMPerMin / velocityFractionAtHrRatio(hrRatio);

  const vo2max = oxygenCostAtVelocity(velocityAtVo2max);
  if (!Number.isFinite(vo2max)) return null;
  if (vo2max < MIN_PLAUSIBLE_VO2MAX || vo2max > MAX_PLAUSIBLE_VO2MAX) return null;

  return vo2max;
}
