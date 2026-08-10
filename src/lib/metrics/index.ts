/**
 * Calculs physiologiques.
 *
 * Fonctions pures, sans accès base ni réseau. Règle du projet : ne jamais
 * approximer — toute valeur non calculable faute de données renvoie `null`.
 * Chaque implémentation cite la source de sa formule dans son module.
 */

export { computeTrimp, type Sex, type TrimpInput } from './trimp';
export { computeLoadSeries, type DailyTrimp, type LoadPoint } from './load';
export { estimateVdot, type EffortInput } from './vdot';
export { paceSecPerKm } from './pace';
