/**
 * Charge d'entraînement : modèle à impulsions-réponses de Banister.
 *
 * Source : Banister EW, Calvert TW, Savage MV, Bach T, « A systems model of
 * training for athletic performance », Aust J Sports Med 7, 1975, 57-61 —
 * décomposition de la réponse à l'entraînement en une composante lente
 * (fitness) et une composante rapide (fatigue). Constantes de temps de 42 et 7
 * jours telles que popularisées par la Performance Management Chart de
 * A. Coggan (TrainingPeaks) : CTL sur 42 jours, ATL sur 7 jours, TSB = CTL − ATL.
 *
 * Nuance : la Performance Management Chart de TrainingPeaks calcule le TSB du
 * jour à partir des valeurs de la *veille* (CTL(j−1) − ATL(j−1)). On utilise ici
 * les valeurs du jour même — écart d'un jour, choix courant et plus lisible pour
 * un affichage « où j'en suis maintenant ».
 */

export type DailyTrimp = { date: string; trimp: number };

export type LoadPoint = {
  date: string;
  /** Charge chronique — moyenne mobile exponentielle sur 42 jours. */
  ctl: number;
  /** Charge aiguë — moyenne mobile exponentielle sur 7 jours. */
  atl: number;
  /** Forme : ctl - atl. */
  tsb: number;
};

const CTL_TIME_CONSTANT_DAYS = 42;
const ATL_TIME_CONSTANT_DAYS = 7;
const MS_PER_DAY = 86_400_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Numéro de jour UTC (epoch / 86 400 000) pour une date `YYYY-MM-DD`, ou `null`
 * si la chaîne n'est pas une date calendaire réelle (`2026-02-30` inclus).
 */
function toEpochDay(date: string): number | null {
  const match = ISO_DATE.exec(date);
  if (match === null) return null;

  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const timestamp = Date.UTC(y, m - 1, d);
  const parsed = new Date(timestamp);

  // Rejette les dates qui « débordent » (31 février → 3 mars).
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    return null;
  }

  return timestamp / MS_PER_DAY;
}

function fromEpochDay(epochDay: number): string {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Série ATL/CTL/TSB, un point par jour, jours sans activité inclus (TRIMP = 0).
 *
 * L'entrée peut être creuse et non triée : la série est densifiée jour par jour
 * entre la première et la dernière date observée, sans quoi les moyennes
 * mobiles seraient calculées sur un axe temporel faussé. Plusieurs entrées sur
 * une même date sont sommées (la charge d'une journée est la somme de ses
 * séances). Les entrées dont la date n'est pas une date calendaire valide sont
 * ignorées : elles ne peuvent pas être placées sur l'axe du temps. Une charge
 * non finie ou négative compte pour 0.
 *
 * CTL et ATL démarrent à 0 : la série n'a pas de valeur de « warm-up », les
 * premiers points sont donc mécaniquement sous-estimés.
 */
export function computeLoadSeries(daily: readonly DailyTrimp[]): LoadPoint[] {
  const trimpByDay = new Map<number, number>();

  for (const entry of daily) {
    const epochDay = toEpochDay(entry.date);
    if (epochDay === null) continue;

    const trimp = Number.isFinite(entry.trimp) && entry.trimp > 0 ? entry.trimp : 0;
    trimpByDay.set(epochDay, (trimpByDay.get(epochDay) ?? 0) + trimp);
  }

  if (trimpByDay.size === 0) return [];

  let firstDay = Number.POSITIVE_INFINITY;
  let lastDay = Number.NEGATIVE_INFINITY;
  for (const day of trimpByDay.keys()) {
    if (day < firstDay) firstDay = day;
    if (day > lastDay) lastDay = day;
  }

  const series: LoadPoint[] = [];
  let ctl = 0;
  let atl = 0;

  for (let day = firstDay; day <= lastDay; day += 1) {
    const trimp = trimpByDay.get(day) ?? 0;

    ctl += (trimp - ctl) / CTL_TIME_CONSTANT_DAYS;
    atl += (trimp - atl) / ATL_TIME_CONSTANT_DAYS;

    series.push({ date: fromEpochDay(day), ctl, atl, tsb: ctl - atl });
  }

  return series;
}
