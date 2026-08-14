/**
 * Codes de temps WMO 4677 — le seul endroit où un code devient une phrase.
 *
 * Open-Meteo ne rend le **temps qu'il fait** que par ce nombre : toutes ses
 * autres variables quantifient (des degrés, des millimètres), lui seul qualifie.
 * Un écran qui l'afficherait brut (« 61 ») ne dirait rien à personne.
 *
 * ## La table est exhaustive, et le repli n'est pas du soleil
 *
 * Les vingt-huit codes ci-dessous sont **tous** ceux qu'Open-Meteo documente
 * (<https://open-meteo.com/en/docs>, « WMO Weather interpretation codes »). La
 * norme 4677 en compte bien davantage ; le service n'en émet pas d'autres.
 *
 * Un code hors table — API qui s'enrichit, valeur aberrante — ne retombe donc
 * **pas** sur un défaut ensoleillé : il rend `unknown`, dit qu'il est inconnu et
 * cite sa valeur. Prêter un ciel dégagé à ce qu'on n'a pas su lire serait
 * exactement le mensonge que cette table existe pour éviter.
 *
 * ## Pourquoi dix icônes pour vingt-huit codes
 *
 * L'icône **résume**, le libellé **précise**. Chaque nom d'icône a un glyphe
 * distinct : deux codes ne partagent une icône que lorsqu'ils décrivent le même
 * temps à une intensité près (« Pluie faible » et « Pluie forte »), et c'est le
 * libellé, lui, qui les sépare. Un jeu d'icônes qui tenterait de rendre
 * « verglaçante » à 16 px ne rendrait rien du tout.
 *
 * Module pur : ni React, ni `lucide-react`. Le nom d'icône est une valeur, que
 * `src/components/weather-icon.tsx` traduit en composant — c'est ce qui rend
 * cette table testable sans monter le moindre rendu.
 */

/** Les familles de temps que l'interface sait dessiner. */
export const WEATHER_ICON_NAMES = [
  'clear',
  'mostly-clear',
  'cloudy',
  'fog',
  'drizzle',
  'rain',
  'showers',
  'snow',
  'thunderstorm',
  'unknown',
] as const;

export type WeatherIconName = (typeof WEATHER_ICON_NAMES)[number];

/** Ce qu'un code de temps veut dire, à l'écran. */
export type WeatherCondition = {
  /** Libellé français, prêt à être affiché tel quel. */
  label: string;
  icon: WeatherIconName;
};

/**
 * Les vingt-huit codes émis par Open-Meteo, et rien d'autre.
 *
 * `Map` plutôt qu'objet indexé : la clé est un nombre, et une recherche dans un
 * objet passerait par une conversion en chaîne qui accepterait n'importe quoi.
 */
const CONDITIONS = new Map<number, WeatherCondition>([
  [0, { label: 'Ciel dégagé', icon: 'clear' }],
  [1, { label: 'Plutôt dégagé', icon: 'mostly-clear' }],
  [2, { label: 'Partiellement nuageux', icon: 'mostly-clear' }],
  [3, { label: 'Couvert', icon: 'cloudy' }],
  [45, { label: 'Brouillard', icon: 'fog' }],
  [48, { label: 'Brouillard givrant', icon: 'fog' }],
  [51, { label: 'Bruine faible', icon: 'drizzle' }],
  [53, { label: 'Bruine modérée', icon: 'drizzle' }],
  [55, { label: 'Bruine dense', icon: 'drizzle' }],
  [56, { label: 'Bruine verglaçante faible', icon: 'drizzle' }],
  [57, { label: 'Bruine verglaçante dense', icon: 'drizzle' }],
  [61, { label: 'Pluie faible', icon: 'rain' }],
  [63, { label: 'Pluie modérée', icon: 'rain' }],
  [65, { label: 'Pluie forte', icon: 'rain' }],
  [66, { label: 'Pluie verglaçante faible', icon: 'rain' }],
  [67, { label: 'Pluie verglaçante forte', icon: 'rain' }],
  [71, { label: 'Neige faible', icon: 'snow' }],
  [73, { label: 'Neige modérée', icon: 'snow' }],
  [75, { label: 'Neige forte', icon: 'snow' }],
  [77, { label: 'Grains de neige', icon: 'snow' }],
  [80, { label: 'Averses faibles', icon: 'showers' }],
  [81, { label: 'Averses modérées', icon: 'showers' }],
  [82, { label: 'Averses violentes', icon: 'showers' }],
  [85, { label: 'Averses de neige faibles', icon: 'snow' }],
  [86, { label: 'Averses de neige fortes', icon: 'snow' }],
  [95, { label: 'Orage', icon: 'thunderstorm' }],
  [96, { label: 'Orage et grêle faible', icon: 'thunderstorm' }],
  [99, { label: 'Orage et grêle forte', icon: 'thunderstorm' }],
]);

/** Les codes connus, dans l'ordre croissant — pour les tests et rien d'autre. */
export const KNOWN_WEATHER_CODES: readonly number[] = [...CONDITIONS.keys()].sort(
  (left, right) => left - right,
);

/** Temps non relevé : le code est absent, et ça se dit. */
const UNREADABLE: WeatherCondition = { label: 'Temps inconnu', icon: 'unknown' };

/**
 * Ce que dit un code de temps.
 *
 * `null` (mesure absente) et code hors table sont **deux absences distinctes**,
 * et aucune des deux ne se déguise en beau temps : la première ne sait rien, la
 * seconde cite le nombre qu'elle n'a pas su lire — c'est par là qu'on verrait
 * qu'Open-Meteo s'est enrichi.
 */
export function describeWeatherCode(code: number | null): WeatherCondition {
  if (code === null || !Number.isFinite(code)) return UNREADABLE;

  const condition = CONDITIONS.get(code);
  if (condition !== undefined) return condition;

  return { label: `Temps inconnu (code ${code})`, icon: 'unknown' };
}
