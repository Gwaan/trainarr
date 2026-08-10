/**
 * Lecture des fichiers FIT.
 *
 * Module pur (aucun accès base, fichier ou réseau) : il transforme les octets
 * d'un fichier d'activité en structure exploitable par l'import.
 */

export { MAX_FIT_FILE_BYTES, MAX_FIT_UPLOAD_BYTES } from './limits';
export { FitParseError, parseFitActivity } from './parse';
export type { FitStreamSet, ParsedFitActivity } from './parse';
export {
  defaultActivityName,
  mapFitSportType,
  usesFootCadence,
  usesFootCadenceSportType,
} from './sport';
