/**
 * Bornes des champs d'identité (mot de passe, nom du compte).
 *
 * Module volontairement **sans `server-only`** — comme `src/lib/fit/limits.ts` :
 * ce sont les seules valeurs d'authentification que le navigateur a le droit de
 * connaître, et le formulaire de création de compte (composant client) doit les
 * afficher. Tout le reste de `src/lib/auth/` reste hors de sa portée.
 *
 * Écrites ici pour n'exister qu'une fois : l'instance les repasse en option à
 * better-auth, le formulaire les affiche et l'action les vérifie. Sans ça, un
 * refus du serveur pourrait contredire le message lu à l'écran.
 *
 * Le minimum est relevé au-dessus des 8 caractères que propose better-auth par
 * défaut : l'application est exposée sur le réseau et ce mot de passe est le
 * **seul** identifiant qui la garde — ni second facteur, ni fournisseur tiers,
 * ni limite de tentatives pour l'instant. Douze caractères ne coûtent rien à
 * qui se connecte deux fois par an depuis une PWA qui garde sa session.
 */

export const AUTH_PASSWORD_MIN_LENGTH = 12;
export const AUTH_PASSWORD_MAX_LENGTH = 128;

/**
 * Longueur maximale du nom du compte.
 *
 * Deux écrans écrivent cette même colonne — la création du premier compte et la
 * section « Ton compte » du profil. Sans borne commune, l'un accepterait ce que
 * l'autre refuse.
 */
export const AUTH_NAME_MAX_LENGTH = 100;
