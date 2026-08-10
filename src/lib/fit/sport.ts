/**
 * Correspondance des sports FIT vers le vocabulaire déjà stocké en base
 * (`activities.sport_type`), qui est celui de Strava — les deux canaux d'import
 * doivent produire les mêmes libellés, sinon les agrégats du dashboard se
 * scindent en deux familles d'activités.
 *
 * Référence des valeurs FIT : profil 21.212 du SDK Garmin, types `sport` et
 * `sub_sport` (`node_modules/@garmin/fitsdk/src/profile.js`).
 */

/**
 * Sports (vocabulaire Strava, celui de la colonne `sport_type`) dont la cadence
 * brute compte les cycles d'une seule jambe. Les deux canaux d'import s'y
 * réfèrent : le FIT traduit d'abord son sport, Strava fournit déjà ce libellé.
 */
const FOOT_CADENCE_SPORT_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Walk', 'Hike']);

/** Libellés français de repli, quand la source ne nomme pas l'activité. */
const DEFAULT_ACTIVITY_NAMES: Record<string, string> = {
  Run: 'Course à pied',
  TrailRun: 'Trail',
  Ride: 'Vélo',
  Walk: 'Marche',
  Hike: 'Randonnée',
  Swim: 'Natation',
};

/**
 * Couples (sport, subSport) qui donnent un libellé plus précis que le sport
 * seul. Consultée en premier ; toute clé absente retombe sur {@link BY_SPORT}.
 */
const BY_SPORT_AND_SUB_SPORT: Record<string, string> = {
  'running/trail': 'TrailRun',
  'running/treadmill': 'VirtualRun',
  'running/indoorRunning': 'VirtualRun',
  'running/virtualActivity': 'VirtualRun',
  'cycling/mountain': 'MountainBikeRide',
  'cycling/downhill': 'MountainBikeRide',
  'cycling/gravelCycling': 'GravelRide',
  'cycling/cyclocross': 'GravelRide',
  'cycling/indoorCycling': 'VirtualRide',
  'cycling/spin': 'VirtualRide',
  'cycling/virtualActivity': 'VirtualRide',
  'training/strengthTraining': 'WeightTraining',
  'training/yoga': 'Yoga',
};

/** Sports FIT ayant un équivalent Strava dont le nom ne se déduit pas du libellé FIT. */
const BY_SPORT: Record<string, string> = {
  running: 'Run',
  cycling: 'Ride',
  eBiking: 'EBikeRide',
  walking: 'Walk',
  hiking: 'Hike',
  swimming: 'Swim',
  rowing: 'Rowing',
  crossCountrySkiing: 'NordicSki',
  alpineSkiing: 'AlpineSki',
  snowboarding: 'Snowboard',
  snowshoeing: 'Snowshoe',
  inlineSkating: 'InlineSkate',
  iceSkating: 'IceSkate',
  rockClimbing: 'RockClimbing',
  hiit: 'HighIntensityIntervalTraining',
  standUpPaddleboarding: 'StandUpPaddling',
  /** Fourre-tout Strava, pour les sports FIT qui ne décrivent aucune discipline. */
  generic: 'Workout',
  training: 'Workout',
  fitnessEquipment: 'Workout',
};

/**
 * Traduit le couple (`sport`, `sub_sport`) d'une session FIT.
 *
 * Le SDK rend la valeur brute (un nombre) quand le code n'existe pas dans son
 * profil — matériel plus récent que le SDK. On préfère alors un libellé
 * explicitement marqué `FitSport<n>` à un sport inventé : la donnée reste
 * traçable et l'import ne ment pas sur la discipline.
 */
export function mapFitSportType(
  sport: number | string | undefined,
  subSport: number | string | undefined,
): { sportType: string; warning: string | null } {
  if (typeof sport !== 'string') {
    if (typeof sport === 'number') {
      return {
        sportType: `FitSport${sport}`,
        warning: `Sport FIT inconnu du profil du SDK (code ${sport}) : conservé tel quel.`,
      };
    }
    return {
      sportType: 'Workout',
      warning: 'Sport absent de la session FIT : activité classée « Workout ».',
    };
  }

  if (typeof subSport === 'string') {
    const precise = BY_SPORT_AND_SUB_SPORT[`${sport}/${subSport}`];
    if (precise !== undefined) return { sportType: precise, warning: null };
  }

  const mapped = BY_SPORT[sport];
  if (mapped !== undefined) return { sportType: mapped, warning: null };

  // Les libellés FIT sont en camelCase : `windsurfing` → `Windsurfing`.
  return { sportType: sport.charAt(0).toUpperCase() + sport.slice(1), warning: null };
}

/**
 * `true` si la cadence brute du sport (vocabulaire Strava) compte les cycles
 * d'une seule jambe et doit donc être doublée pour obtenir des pas par minute.
 * Faux pour le vélo, dont la cadence est déjà un nombre de tours de pédalier.
 */
export function usesFootCadenceSportType(sportType: string): boolean {
  return FOOT_CADENCE_SPORT_TYPES.has(sportType);
}

/**
 * Même question, posée avec le `sport` brut d'une session FIT. Traduit d'abord
 * le libellé pour que la liste des sports à pied n'existe qu'à un seul endroit.
 */
export function usesFootCadence(sport: number | string | undefined): boolean {
  return usesFootCadenceSportType(mapFitSportType(sport, undefined).sportType);
}

/**
 * Libellé de repli d'une activité, quand la source n'en fournit aucun : le
 * profil FIT n'a pas de champ « titre ». On nomme la discipline en français
 * plutôt que d'inventer un titre — Gwen renommera si elle le souhaite. Un sport
 * hors de la liste garde son libellé technique : mieux vaut « GravelRide » qu'un
 * nom approximatif.
 */
export function defaultActivityName(sportType: string): string {
  return DEFAULT_ACTIVITY_NAMES[sportType] ?? sportType;
}
