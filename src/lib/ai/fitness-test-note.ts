/**
 * Ce que l'athlète **lit** d'un test chronométré, verdict par verdict.
 *
 * Module **pur** — ni base, ni réseau, ni `server-only` : c'est de la mise en
 * forme, et c'est ce qui permet de l'éprouver telle quelle. Il est séparé du
 * service qui l'appelle (`fitness-test-service.ts`) pour cette seule raison :
 * la phrase que l'athlète lit est le garde-fou du chantier, et un garde-fou se
 * teste.
 *
 * Une note est écrite pour **chaque** test, y compris ceux qui ne changent
 * rien. Pris dans les deux sens : ni un recalcul qui échapperait à l'athlète,
 * ni un refus qu'elle prendrait pour un oubli.
 */

import type { FitnessTestVerdict } from '@/lib/metrics/fitness-test';

import { formatCivilDate, formatNumber, formatPace } from './format';

/** `25:40` — un chrono de course, tel qu'on le lit sur un chronomètre. */
function formatRaceTime(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Ce que l'athlète lira sur la page de son plan — une phrase, en français, qui
 * dit ce qui s'est passé **et** ce que ça change.
 *
 * Écrite pour chaque verdict, y compris ceux qui ne changent rien : c'est le
 * garde-fou « aucun recalcul silencieux », pris dans les deux sens — ni un
 * recalcul qui échapperait à l'athlète, ni un refus qu'elle prendrait pour un
 * oubli.
 */
export function fitnessTestNote(
  verdict: FitnessTestVerdict,
  testedOn: string,
  paceChange: { fromSecPerKm: number; toSecPerKm: number } | null,
): string {
  const head = `Test du ${formatCivilDate(testedOn)}`;

  switch (verdict.outcome) {
    case 'improved': {
      const time = `${formatRaceTime(verdict.timeS)} sur 5 km`;
      const paces =
        paceChange === null
          ? 'Tes allures sont recalculées'
          : `Ton allure de seuil passe de ${formatPace(paceChange.fromSecPerKm)} à ` +
            `${formatPace(paceChange.toSecPerKm)} (${Math.round(paceChange.fromSecPerKm - paceChange.toSecPerKm)} s/km de moins)`;
      return (
        `${head} : ${time}, soit un VDOT de ${formatNumber(verdict.vdot, 1)}. ` +
        `${paces}, et la fin du plan est réécrite sur ce nouveau chrono.`
      );
    }
    case 'not-improved':
      return (
        `${head} : ${formatRaceTime(verdict.timeS)} sur 5 km, soit un VDOT de ` +
        `${formatNumber(verdict.vdot, 1)} — pas mieux que ton chrono de référence. ` +
        `Rien ne change : un mauvais jour, du vent ou de la chaleur donnent le même chiffre ` +
        `qu'une perte de forme, et on ne dégrade pas un chrono de référence là-dessus. ` +
        `Si ce niveau se confirme, tu peux le corriger toi-même dans les réglages du plan.`
      );
    case 'not-maximal':
      return (
        `${head} : chrono non retenu — ${verdict.reason}. ` +
        `Tes allures ne bougent pas. Le prochain test de ton plan retentera la mesure.`
      );
    case 'too-soon':
      return (
        `${head} : chrono non retenu — ton chrono de référence a moins de quatre semaines, ` +
        `et on ne le remet pas en cause plus souvent (méthode de Daniels). ` +
        `Il redeviendra ajustable dans ${verdict.daysToWait} jour${verdict.daysToWait > 1 ? 's' : ''}.`
      );
    case 'unmeasurable':
      return (
        `${head} : chrono non retenu — ${verdict.reason}. ` +
        `Tes allures ne bougent pas ; le prochain test retentera la mesure.`
      );
  }
}
