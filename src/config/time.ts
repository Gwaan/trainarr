/**
 * Fuseau de référence de l'athlète.
 *
 * Les instants sont stockés en UTC, mais la notion de « jour » — agrégation
 * quotidienne de la charge, séance du jour, libellés « hier »/« aujourd'hui » —
 * est civile. Le DAL et le formatage d'affichage doivent impérativement partager
 * ce même fuseau : sinon, entre minuit et l'aube, le serveur (en UTC dans le
 * container) et l'agrégat ne désignent pas le même jour, et le panneau
 * « Séance du jour » affiche « Demain ».
 *
 * Application mono-utilisateur : constante, pas encore un réglage de profil.
 * Ce module est volontairement sans `server-only` — le formatage d'affichage
 * l'utilise aussi.
 */
export const APP_TIME_ZONE = 'Europe/Paris';
