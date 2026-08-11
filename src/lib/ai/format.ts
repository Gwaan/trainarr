/**
 * Mise en forme des données chiffrées **destinées aux prompts** du coach.
 *
 * Fonctions pures, sans `server-only` : elles ne lisent ni base ni
 * environnement, et les tests s'en saisissent directement.
 *
 * ## Pourquoi ne pas réutiliser `src/app/(app)/_lib/format.ts`
 *
 * Ces helpers-là sont colocalisés à des routes : `src/lib/` ne dépend pas de
 * `src/app/`, et les deux publics n'ont pas les mêmes exigences. L'affichage
 * peut se permettre « 1 h 05 » sans unité au bout ou un signe moins
 * typographique ; un prompt doit rester **non ambigu pour un petit modèle** et
 * aussi court que possible — chaque caractère se paie en tokens sur les 32 k de
 * contexte disponibles.
 *
 * Conventions retenues, cohérentes avec l'UI française du projet : virgule
 * décimale, allures `m:ss/km`, distances au dixième de kilomètre, durées
 * `h mm`.
 */

import type { TrainingSnapshotDto } from '@/data/coach-context';

/** Jours ISO en toutes lettres : `day` vaut 1 pour lundi … 7 pour dimanche. */
const ISO_DAY_NAMES = [
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
] as const;

const DAY_MS = 86_400_000;

/**
 * Dates civiles en toutes lettres. Fuseau UTC assumé : une date civile
 * `YYYY-MM-DD` est convertie en son repère de minuit UTC (cf.
 * `src/lib/dates/civil.ts`), formater dans un autre fuseau la décalerait d'un
 * jour.
 */
const civilDateFormatter = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Nombre arrondi à `fractionDigits`, virgule décimale, signe moins ASCII. */
export function formatNumber(value: number, fractionDigits = 0): string {
  return value.toFixed(fractionDigits).replace('.', ',');
}

/** Allure `m:ss/km`, ex. `4:18/km`. */
export function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}/km`;
}

/** Distance au dixième de kilomètre, ex. `18,2 km`. */
export function formatDistanceKm(meters: number): string {
  return `${formatNumber(meters / 1000, 1)} km`;
}

/** Durée lisible : `45 s`, `48 min`, `1 h 05`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;

  const minutes = Math.round(total / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${String(rest).padStart(2, '0')}` : `${rest} min`;
}

/** Jour ISO en toutes lettres — `1` → `lundi`. Hors bornes : le numéro brut. */
export function formatIsoDay(day: number): string {
  return ISO_DAY_NAMES[day - 1] ?? `jour ${day}`;
}

/** Date civile en toutes lettres, ex. `lundi 17 août 2026`. */
export function formatCivilDate(date: string): string {
  return civilDateFormatter.format(new Date(Date.parse(`${date}T00:00:00Z`)));
}

/** Pourcentage signé au dixième, ex. `+4,2 %` — le signe porte le sens (dérive). */
export function formatSignedPercent(value: number): string {
  return `${value >= 0 ? '+' : '-'}${formatNumber(Math.abs(value), 1)} %`;
}

/** Écart de jours entre deux dates civiles, pour dater une comparaison. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** « il y a 12 jours », « hier », « aujourd'hui ». */
export function formatDaysAgo(date: string, today: string): string {
  const days = daysBetween(date, today);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  return `il y a ${days} jours`;
}

/** Le profil sur une ligne. Les champs absents ne sont pas mentionnés. */
function formatProfile(profile: TrainingSnapshotDto['profile']): string {
  const parts: string[] = [];
  if (profile.ageYears !== undefined) parts.push(`${profile.ageYears} ans`);
  if (profile.sex !== undefined) parts.push(profile.sex === 'male' ? 'homme' : 'femme');
  if (profile.maxHrBpm !== undefined) parts.push(`FC max ${profile.maxHrBpm} bpm`);
  if (profile.restingHrBpm !== undefined) parts.push(`FC repos ${profile.restingHrBpm} bpm`);
  if (profile.weightKg !== undefined) parts.push(`${formatNumber(profile.weightKg, 1)} kg`);

  return parts.length === 0 ? 'Profil : non renseigné.' : `Profil : ${parts.join(' · ')}.`;
}

/**
 * L'état d'entraînement en quelques lignes — le bloc de contexte commun aux
 * prompts de génération de plan et de feedback.
 *
 * Ce qui n'est pas calculable est **dit comme tel**, jamais omis en silence :
 * c'est ce qui autorise le coach à annoncer un plan conservateur plutôt que
 * d'extrapoler une charge qu'il n'a pas. Comptez ~120 tokens.
 */
export function formatTrainingSnapshot(snapshot: TrainingSnapshotDto): string {
  const lines: string[] = [formatProfile(snapshot.profile)];

  lines.push(
    snapshot.fitness === null
      ? 'Charge (CTL/ATL/TSB) : non calculable, données insuffisantes.'
      : `Charge : CTL ${formatNumber(snapshot.fitness.ctl)} · ATL ${formatNumber(snapshot.fitness.atl)} · TSB ${formatNumber(snapshot.fitness.tsb)}.`,
  );

  lines.push(
    snapshot.vo2max === null
      ? 'VO2max estimée : non calculable.'
      : `VO2max estimée : ${formatNumber(snapshot.vo2max, 1)}.`,
  );

  if (snapshot.weeks.length > 0) {
    lines.push('Volume de course des dernières semaines :');
    for (const week of snapshot.weeks) {
      lines.push(
        `- semaine du ${week.startsOn} : ${formatNumber(week.distanceKm, 1)} km · ${formatDuration(week.movingTimeS)} · ${week.sessions} séance${week.sessions > 1 ? 's' : ''}`,
      );
    }
  }

  lines.push(
    snapshot.recentAvgPaceSecPerKm === null
      ? 'Allure de référence : inconnue (aucune course récente).'
      : `Allure moyenne des dernières sorties : ${formatPace(snapshot.recentAvgPaceSecPerKm)}.`,
  );

  return lines.join('\n');
}
