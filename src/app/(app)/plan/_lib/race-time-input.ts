/**
 * Le masque de saisie du chrono a déménagé dans `(app)/_lib/race-time.ts` : la
 * déclaration d'une course, sur une autre route, en a besoin aussi, et deux
 * routes ne s'importent pas l'une l'autre.
 *
 * Ce module n'est plus qu'une réexportation, sous le nom que le formulaire de
 * plan et son test connaissent déjà.
 */

export { formatRaceTimeDigits, formatRaceTimeInput } from "../../_lib/race-time";
