/**
 * La longueur du **bloc d'effort** d'une séance structurée — ce qu'il faut
 * savoir pour aller le retrouver dans l'activité qui l'a réalisée.
 *
 * Module **pur**, sans `server-only` : il ne lit que le déroulé prescrit.
 *
 * ## Pourquoi une longueur, et pas un emplacement
 *
 * Un fichier FIT ne porte aucun marqueur « ici commence le bloc de seuil » : les
 * tours sont ce que l'auto-lap a découpé, pas ce que l'athlète a couru. Ce que
 * le plan sait, en revanche, c'est **la longueur prescrite** du bloc. C'est elle
 * qui permet à `fastestSegmentWindow` (`lib/metrics/best-segments`) de retrouver
 * la portion correspondante dans la séance réalisée — la même mécanique que le
 * « meilleur 5 km » d'un test chronométré, et les mêmes limites.
 *
 * ## Le plus long bloc, et un seul
 *
 * Une séance de seuil s'écrit « 3 × 2 km » : trois étapes identiques, dont on ne
 * retient qu'**une** longueur. Mesurer les trois répétitions supposerait de les
 * localiser toutes les trois sans chevauchement, pour une information qu'on
 * réduirait de toute façon à un nombre — alors que la robustesse recherchée vient
 * de la médiane **entre séances** (cf. `lib/metrics/lthr`), pas entre
 * répétitions d'une même séance.
 *
 * Le **plus long** des efforts, parce qu'une séance mixte (« 2 km puis 1 km »)
 * doit être mesurée sur celui qui a eu le temps d'installer un plateau
 * cardiaque, et parce que le plancher de durée (`THRESHOLD_BLOCK_MIN_S`) s'y
 * applique ensuite.
 */

import { flattenSteps, type PlanSessionSteps } from './schema';

/**
 * La distance du plus long effort de la séance, en mètres — `null` quand la
 * séance n'en porte aucun d'exploitable.
 *
 * Seules les étapes de rôle `run` comptent : l'échauffement, les récupérations
 * et le retour au calme ne sont pas l'objet de la séance, et la FC qu'on y lit
 * n'est celle d'aucun seuil.
 *
 * Seules les étapes mesurées en **distance** comptent : c'est la seule mesure
 * qu'on sait retrouver dans une trace (par la fenêtre la plus rapide de cette
 * longueur), et c'est de toute façon la seule que l'appli écrit sur une séance
 * de qualité (`plan-skeleton/quality-template.ts`). Une étape en durée rend
 * `null` plutôt qu'une localisation devinée.
 */
export function longestEffortDistanceM(steps: PlanSessionSteps): number | null {
  let longest: number | null = null;

  for (const step of flattenSteps(steps)) {
    if (step.role !== 'run') continue;
    if (step.distanceM === null || !Number.isFinite(step.distanceM) || step.distanceM <= 0) {
      continue;
    }
    if (longest === null || step.distanceM > longest) longest = step.distanceM;
  }

  return longest;
}
