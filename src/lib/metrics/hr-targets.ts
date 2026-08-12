/**
 * Résolution d'une **zone cardiaque prescrite** en battements par minute.
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`. C'est la **source
 * unique** de la conversion zone → bpm, appelée à l'affichage d'une séance et à
 * la publication vers intervals.icu — jamais en amont. Rien n'est figé dans une
 * étape de plan : une `hrZone` reste un ordinal, et la FC max vit au profil. Le
 * jour où l'athlète corrige sa FC max, tout le plan suit sans réécriture.
 *
 * ## Pourquoi prescrire en FC plutôt qu'en allure
 *
 * Une allure suppose des conditions constantes. Une fréquence cardiaque
 * s'auto-corrige : par 30 °C, en côte, ou sur une jambe fatiguée, 135 bpm reste
 * 135 bpm d'effort là où 7:10/km devient une séance de seuil. C'est pour
 * l'**endurance fondamentale** que l'écart compte le plus, parce que c'est là
 * que la faute — courir trop vite — est la plus fréquente et la plus coûteuse.
 *
 * L'inverse vaut pour la **qualité**, qui reste prescrite en allure : la FC met
 * une à deux minutes à monter (un 400 m est fini avant qu'elle soit arrivée) et
 * dérive à la hausse à effort constant sur une séance longue. Sur un
 * fractionné, l'allure *est* l'objet du travail.
 *
 * ## Les bornes : les fractions de Daniels, pas la table générique des montres
 *
 * | Zone | Créneau                 | % de FC max |
 * |------|-------------------------|-------------|
 * | 2    | Endurance fondamentale (E) | 65 – 79 |
 *
 * Source : Jack Daniels, *Daniels' Running Formula* — l'allure E s'y court à
 * 59–74 % de VO₂max, soit **65–79 % de FC max**.
 *
 * Ce n'est **pas** la table générique « Z2 = 60–70 % de FC max » qu'appliquent
 * les montres grand public, et l'écart n'est pas cosmétique : à 184 bpm de FC
 * max, elle donnerait 110–129 bpm, une plage où cette athlète marche. Les
 * fractions de Daniels donnent 120–145 bpm, qui est bien son endurance.
 *
 * ## Deux tables, un même entier — la lire sans se tromper
 *
 * `hr-zones.ts` partitionne le temps **enregistré** d'une séance sur les bornes
 * 50/60/70/80/90 (Z2 y vaut 60–70 %). Elle répond à « où est passé mon temps »
 * et doit couvrir toute la séance sans trou. Celle-ci répond à « à quelle
 * intensité courir » et ne décrit que le créneau **productif** d'un footing.
 *
 * Les deux disent donc des choses différentes du même ordinal 2, et c'est
 * assumé : `PlanStep.hrZone` n'est qu'un rang de 1 à 5, pas une référence à une
 * table. Le rang 2 est celui que tout le monde lit « endurance fondamentale »
 * — c'est le nom de la zone dans les deux tables — et c'est ce que la
 * prescription veut dire. Aucune conversion ne se fait ailleurs qu'ici : c'est
 * ce qui empêche les deux jeux de bornes de se croiser.
 *
 * ## Extension
 *
 * La table ne porte **que** la zone effectivement prescrite. Déclarer les cinq
 * créneaux « pour plus tard » reviendrait à publier des bornes que personne
 * n'aurait vérifiées et que rien ne consommerait. Ajouter le seuil ou la VMA le
 * jour où on les prescrira en FC est une ligne dans {@link PRESCRIBED_HR_ZONES}.
 */

import type { HrZoneNumber } from './hr-zones';

/** Un créneau de prescription : ses bornes en % de FC max, et son nom. */
export type PrescribedHrZone = {
  /** Le créneau en toutes lettres, tel que l'UI peut l'annoncer. */
  label: string;
  minPercentOfMax: number;
  maxPercentOfMax: number;
};

/**
 * La zone de l'**endurance fondamentale**, celle que le plan prescrit sur ses
 * séances faciles.
 *
 * Le 2 n'est pas un choix libre : c'est le rang que `PlanStep.hrZone` accepte
 * (1 à 5) et celui que les deux tables du projet nomment « endurance
 * fondamentale ». Constante nommée pour que la convention se lise partout où
 * elle est posée, plutôt qu'un `2` nu semé dans le code.
 */
export const EASY_HR_ZONE = 2 satisfies HrZoneNumber;

/**
 * Les créneaux prescriptibles, indexés par leur rang.
 *
 * Volontairement incomplet : seule la zone que l'appli prescrit réellement y
 * figure (cf. l'en-tête). {@link hrZoneTargetBpm} rend `null` pour tout autre
 * rang — une étape en Z4 s'affichera « Z4 » faute de bornes vérifiées, ce qui
 * est plus honnête que d'inventer un intervalle.
 */
export const PRESCRIBED_HR_ZONES: Partial<Record<HrZoneNumber, PrescribedHrZone>> = {
  [EASY_HR_ZONE]: {
    label: 'Endurance fondamentale',
    minPercentOfMax: 65,
    maxPercentOfMax: 79,
  },
};

/** Une cible cardiaque, en battements par minute — bornes incluses. */
export type HrTargetBpm = {
  minBpm: number;
  maxBpm: number;
};

/**
 * Bornes de plausibilité de la FC max, en bpm.
 *
 * Le filet du module, pas un jugement physiologique : hors de ces bornes, la
 * valeur n'est pas une FC max mais une saisie fautive ou une donnée corrompue,
 * et en dériver une prescription ferait courir l'athlète à côté de sa zone.
 * Elles doublent celles du profil (`ATHLETE_PROFILE_LIMITS.maxHrBpm`) : ce
 * module est pur et n'a aucune raison de faire confiance à son appelant.
 */
export const PRESCRIPTION_MAX_HR_BOUNDS = { min: 120, max: 230 } as const;

/**
 * La cible en bpm d'une zone prescrite — `null` quand rien n'est calculable :
 * FC max absente, hors bornes ou non entière, zone sans créneau déclaré.
 *
 * `null` n'est pas un cas dégradé à rattraper : c'est la réponse honnête. Sans
 * FC max au profil, l'appli ne prescrit pas en fréquence cardiaque du tout, et
 * l'affichage retombe sur le rang de zone nu.
 *
 * Les deux bornes sont **arrondies à l'entier** : un plan se lit au bpm près, et
 * `119,6 bpm` ne se surveille sur aucune montre. À 184 bpm de FC max, la zone 2
 * rend donc 120–145 bpm.
 *
 * Une FC max **non entière** est refusée plutôt qu'arrondie : aucun cardio ne
 * mesure `184,5 bpm`, donc la valeur ne vient pas d'une mesure mais d'une saisie
 * ou d'un calcul fautif — et le profil, seul point d'entrée légitime, n'accepte
 * que des entiers. En dériver une plage donnerait l'illusion d'une prescription
 * fondée sur une donnée qui n'en est pas une.
 */
export function hrZoneTargetBpm(zone: number, maxHrBpm: number | null): HrTargetBpm | null {
  if (maxHrBpm === null || !Number.isInteger(maxHrBpm)) return null;
  if (maxHrBpm < PRESCRIPTION_MAX_HR_BOUNDS.min || maxHrBpm > PRESCRIPTION_MAX_HR_BOUNDS.max) {
    return null;
  }

  const band = PRESCRIBED_HR_ZONES[zone as HrZoneNumber];
  if (band === undefined) return null;

  return {
    minBpm: Math.round((maxHrBpm * band.minPercentOfMax) / 100),
    maxBpm: Math.round((maxHrBpm * band.maxPercentOfMax) / 100),
  };
}

/**
 * `true` quand l'appli est en mesure de prescrire en fréquence cardiaque.
 *
 * L'unique interrupteur de la fonctionnalité : sans FC max exploitable au
 * profil, tout le reste de la chaîne retrouve son comportement d'avant, à
 * l'étape près.
 */
export function canPrescribeHeartRate(maxHrBpm: number | null): boolean {
  return hrZoneTargetBpm(EASY_HR_ZONE, maxHrBpm) !== null;
}
