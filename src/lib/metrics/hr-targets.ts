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
 * ## Les créneaux sont écrits en % de FC max, la résolution suit l'ancrage
 *
 * Toutes les bornes de ce module — la table ci-dessus, les sous-créneaux, et
 * celles que les étapes de plan portent déjà en base (`PlanStep.hrPercentMin`) —
 * sont exprimées en **pourcentage de FC max**. C'est la forme dans laquelle
 * elles ont été publiées par Daniels, et c'est celle qu'un `jsonb` écrit il y a
 * des mois contient : les réinterpréter comme des pourcentages d'autre chose
 * ferait mentir tous les plans existants.
 *
 * La **résolution en battements**, elle, passe par l'ancrage du profil
 * ({@link HrZoneAnchor}) : quand une FC seuil est adoptée, les bornes sont
 * portées dans le repère du seuil avant d'être multipliées, via
 * {@link LTHR_SHARE_OF_MAX_HR}. C'est le même geste que pour les zones
 * d'analyse, et c'est ce qui fait qu'une séance facile se prescrit dans le même
 * cadre que celui où elle sera relue.
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
 * ## Le rang ne dit pas tout : les sous-créneaux
 *
 * Un entier ne peut pas exprimer « le haut de l'endurance ». C'est ce que
 * {@link EASY_HR_BANDS} ajoute — des bornes en pourcentage, portées par l'étape
 * elle-même ({@link PlanStep.hrPercentMin}), qui **précisent** la plage sans
 * jamais en sortir. Un rang de plus dans cette table aurait été le contraire :
 * un nouvel ordinal à faire cohabiter avec `hr-zones.ts`, où le 3 veut déjà
 * dire autre chose.
 *
 * ## Extension
 *
 * La table ne porte **que** la zone effectivement prescrite. Déclarer les cinq
 * créneaux « pour plus tard » reviendrait à publier des bornes que personne
 * n'aurait vérifiées et que rien ne consommerait. Ajouter le seuil ou la VMA le
 * jour où on les prescrira en FC est une ligne dans {@link PRESCRIBED_HR_ZONES}.
 */

import type { HrZoneAnchor, HrZoneNumber } from './hr-zones';
import { LTHR_BOUNDS } from './lthr';

/**
 * Un créneau cardiaque **nu** : deux bornes en pourcentage de FC max.
 *
 * C'est la forme la plus expressive que le projet manipule — un rang de zone
 * n'en désigne qu'une par entier, là où une bande dit exactement ce qu'elle
 * veut dire. {@link EASY_HR_BANDS} en tire les sous-créneaux de l'endurance.
 */
export type HrPercentBand = {
  minPercentOfMax: number;
  maxPercentOfMax: number;
};

/** Un créneau de prescription : ses bornes en % de FC max, et son nom. */
export type PrescribedHrZone = HrPercentBand & {
  /** Le créneau en toutes lettres, tel que l'UI peut l'annoncer. */
  label: string;
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

/**
 * Les **sous-créneaux de l'endurance** : le bas, le milieu, le haut de la plage.
 *
 * ## Ce qu'ils réparent
 *
 * Un rang de zone ne dit qu'une chose, et la même pour toute la séance : les
 * deux blocs d'une sortie longue à fin appuyée recevaient exactement la même
 * cible (124–150 bpm sur une FC max de 190), donc la fin appuyée était
 * **indiscernable** sur la montre — la distinction ne vivait que dans la note.
 * Symétriquement, la première tranche d'un footing progressif ne recevait
 * aucune cible du tout. Une bande explicite dit ce qu'un rang ne peut pas dire :
 * « la même zone, mais son haut ».
 *
 * ## Les bornes, et pourquoi elles ne déplacent pas le 80/20
 *
 * Tout reste **dans** la plage d'endurance (65–79 % de FC max, cf.
 * {@link PRESCRIBED_HR_ZONES}) : la borne haute du sous-créneau haut est celle
 * de la zone elle-même, au point de pourcentage près. Chez Daniels, l'allure
 * marathon commence vers 80 % et le seuil vers 86–88 % — 79 % en reste à neuf
 * points, et aucune de ces trois bandes n'est de la qualité déguisée. La
 * répartition des intensités du plan est, au pourcent près, celle d'avant.
 *
 * Trois bandes de 5 à 6 points (9 à 11 bpm sur une FC max de 184), qui se
 * **recouvrent d'un point ou deux** : une progression continue plutôt que trois
 * marches, et une largeur qu'on peut réellement tenir au poignet — une bande de
 * deux points vaudrait 4 bpm, soit le bruit d'un cardio.
 *
 * | Bande | % de FC max | À 184 bpm | Où elle sert |
 * |-------|-------------|-----------|--------------|
 * | `low`  | 65–71 | 120–131 | 1ʳᵉ tranche d'un footing progressif |
 * | `mid`  | 70–75 | 129–138 | 2ᵉ tranche d'un footing progressif |
 * | `high` | 74–79 | 136–145 | 3ᵉ tranche, et fin appuyée d'une sortie longue |
 */
export const EASY_HR_BANDS = {
  low: { minPercentOfMax: 65, maxPercentOfMax: 71 },
  mid: { minPercentOfMax: 70, maxPercentOfMax: 75 },
  high: { minPercentOfMax: 74, maxPercentOfMax: 79 },
} as const satisfies Record<'low' | 'mid' | 'high', HrPercentBand>;

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
 * La part de la FC max qu'occupe la FC seuil chez un coureur entraîné : **89 %**.
 *
 * ## À quoi elle sert, et à quoi elle ne sert pas
 *
 * Uniquement à **porter les bornes de Daniels dans le repère du seuil**, une
 * fois pour toutes, dans ce module. Ce n'est ni une estimation du seuil d'un
 * athlète (le seuil se **mesure**, cf. `./lthr` — c'est tout l'objet du
 * chantier), ni une valeur qui entre dans une zone d'analyse.
 *
 * ## D'où vient le chiffre
 *
 * Le seuil lactique se situe couramment entre 85 et 92 % de FC max chez le
 * coureur entraîné (fourchette de praticien, reprise par Friel) ; 89 % est le
 * haut-milieu de cette fourchette, et il a une propriété qui a décidé du choix :
 * le plafond de l'endurance de Daniels (79 % de FC max) devient alors
 * **89 % de LTHR**, c'est-à-dire exactement le plafond de la zone 2 de Friel.
 * Les deux méthodes — l'une écrite en % de FC max, l'autre en % de seuil —
 * placent donc la frontière entre l'endurance et le travail actif au même
 * endroit, ce qui est la meilleure vérification qu'on puisse demander à une
 * conversion.
 *
 * Le créneau d'endurance devient ainsi **73–89 % de LTHR** (65 % ÷ 0,89 = 73).
 *
 * ## Ce que ça change, et pourquoi c'est le but
 *
 * Pour un athlète dont le seuil est bas (165 sur 190 de FC max, soit 87 %), les
 * cibles d'endurance descendent de quelques battements ; pour un athlète dont le
 * seuil est haut (178 sur 190, soit 94 %), elles montent. C'est exactement la
 * correction que l'ancrage au seuil existe pour apporter — le même pourcentage
 * de FC max ne décrit pas le même effort chez deux coureurs
 * (Scharhag-Rosenberger et al. 2010).
 */
export const LTHR_SHARE_OF_MAX_HR = 0.89;

/**
 * Bornes de plausibilité de la référence, selon l'ancrage.
 *
 * Une FC seuil et une FC max ne vivent pas dans le même intervalle : refuser une
 * FC seuil de 110 au motif qu'elle serait une FC max invraisemblable n'aurait
 * pas de sens, et l'inverse non plus.
 */
function anchorBounds(anchor: HrZoneAnchor): { min: number; max: number } {
  return anchor.kind === 'lthr' ? LTHR_BOUNDS : PRESCRIPTION_MAX_HR_BOUNDS;
}

/**
 * La cible en bpm d'une zone prescrite — `null` quand rien n'est calculable :
 * aucun ancrage au profil, ancrage hors bornes ou non entier, zone sans créneau
 * déclaré.
 *
 * `null` n'est pas un cas dégradé à rattraper : c'est la réponse honnête. Sans
 * référence au profil, l'appli ne prescrit pas en fréquence cardiaque du tout,
 * et l'affichage retombe sur le rang de zone nu.
 *
 * Les deux bornes sont **arrondies à l'entier** : un plan se lit au bpm près, et
 * `119,6 bpm` ne se surveille sur aucune montre. À 184 bpm de FC max, la zone 2
 * rend donc 120–145 bpm ; à 165 bpm de FC seuil, 120–147 bpm.
 *
 * Une référence **non entière** est refusée plutôt qu'arrondie : aucun cardio ne
 * mesure `184,5 bpm`, donc la valeur ne vient pas d'une mesure mais d'une saisie
 * ou d'un calcul fautif — et le profil, seul point d'entrée légitime, n'accepte
 * que des entiers. En dériver une plage donnerait l'illusion d'une prescription
 * fondée sur une donnée qui n'en est pas une.
 */
export function hrZoneTargetBpm(zone: number, anchor: HrZoneAnchor | null): HrTargetBpm | null {
  const band = PRESCRIBED_HR_ZONES[zone as HrZoneNumber];
  return band === undefined ? null : hrPercentTargetBpm(band, anchor);
}

/**
 * La cible en bpm d'une bande **explicite** — les mêmes règles que
 * {@link hrZoneTargetBpm}, à ceci près que les bornes viennent de l'étape et
 * non de la table.
 *
 * C'est la seule façon d'exprimer un sous-créneau ({@link EASY_HR_BANDS}) : le
 * rang de zone, lui, est un entier et ne distingue pas le haut d'une plage de
 * son bas.
 *
 * La bande est **toujours** écrite en pourcentage de FC max (c'est ce que porte
 * `PlanStep.hrPercentMin`) ; quand l'ancrage est le seuil, elle y est portée par
 * {@link LTHR_SHARE_OF_MAX_HR} avant d'être multipliée.
 */
export function hrPercentTargetBpm(
  band: HrPercentBand,
  anchor: HrZoneAnchor | null,
): HrTargetBpm | null {
  if (anchor === null || !Number.isInteger(anchor.bpm)) return null;

  const bounds = anchorBounds(anchor);
  if (anchor.bpm < bounds.min || anchor.bpm > bounds.max) return null;

  // En repère de seuil, le pourcentage de FC max est d'abord porté en
  // pourcentage de seuil ; en repère de FC max, le facteur vaut 1.
  const share = anchor.kind === 'lthr' ? LTHR_SHARE_OF_MAX_HR : 1;

  return {
    minBpm: Math.round((anchor.bpm * band.minPercentOfMax) / (100 * share)),
    maxBpm: Math.round((anchor.bpm * band.maxPercentOfMax) / (100 * share)),
  };
}

/** Une cible cardiaque exprimée en **pourcentage d'une FC max de référence**. */
export type HrTargetPercentOfMax = {
  minPercent: number;
  maxPercent: number;
};

/**
 * La même cible, ramenée en pourcentage d'une FC max **de référence** — `null`
 * quand cette référence est inutilisable (absente, non finie, hors des bornes de
 * plausibilité {@link PRESCRIPTION_MAX_HR_BOUNDS}).
 *
 * ## Pourquoi une deuxième FC max
 *
 * La prescription, elle, ne dépend que du profil : `hrZoneTargetBpm` en tire des
 * **battements**, qui sont la vérité de la séance. Mais certains destinataires
 * n'acceptent pas de battements et ne savent lire qu'un pourcentage de *leur*
 * propre FC max — c'est le cas du dialecte de séance d'intervals.icu, dont le
 * parseur ignore toute forme en bpm absolus (vérifié le 12/08/2026 sur le compte
 * réel, cf. `lib/plan-steps/intervals-syntax`). Repasser par le pourcentage de
 * **leur** référence est alors le seul moyen que la cible se résolve chez eux sur
 * les battements que nous avons prescrits — et non sur une zone qu'ils auraient
 * configurée à leur idée.
 *
 * La référence n'est donc **pas** une source de prescription : c'est un
 * dénominateur. Elle n'a aucune raison d'égaler la FC max du profil (le compte
 * intervals.icu de cette athlète porte 205 là où son profil porte 184), et c'est
 * précisément l'écart que cette conversion absorbe.
 *
 * ## L'arrondi
 *
 * Les deux bornes sont arrondies **au plus proche**, et pas resserrées vers
 * l'intérieur : le pourcentage émis doit redonner les battements d'origine quand
 * la référence est celle du profil — 120–145 bpm sur une FC max de 184 valent
 * 65–79 %, exactement les bornes du créneau prescrit. Resserrer donnerait
 * 66–78 %, c'est-à-dire une plage plus étroite que celle que le plan prescrit,
 * sans que rien ne l'ait décidé. L'écart maximal introduit est d'un demi-point
 * de FC max, soit environ 1 bpm — l'ordre de grandeur du bruit d'un cardio.
 *
 * Contrairement à {@link hrZoneTargetBpm}, la référence n'a pas à être entière :
 * un entier y signale une saisie humaine saine, alors qu'ici la valeur vient
 * d'un service tiers et ne sert qu'à diviser.
 */
export function hrTargetPercentOfMax(
  target: HrTargetBpm,
  referenceMaxHrBpm: number | null,
): HrTargetPercentOfMax | null {
  if (referenceMaxHrBpm === null || !Number.isFinite(referenceMaxHrBpm)) return null;
  if (
    referenceMaxHrBpm < PRESCRIPTION_MAX_HR_BOUNDS.min ||
    referenceMaxHrBpm > PRESCRIPTION_MAX_HR_BOUNDS.max
  ) {
    return null;
  }

  return {
    minPercent: Math.round((target.minBpm / referenceMaxHrBpm) * 100),
    maxPercent: Math.round((target.maxBpm / referenceMaxHrBpm) * 100),
  };
}

/**
 * `true` quand l'appli est en mesure de prescrire en fréquence cardiaque.
 *
 * L'unique interrupteur de la fonctionnalité : sans FC max exploitable au
 * profil, tout le reste de la chaîne retrouve son comportement d'avant, à
 * l'étape près.
 *
 * **L'interrupteur reste sur la FC max**, et pas sur l'ancrage courant, parce
 * que ce qu'il autorise est l'**écriture** d'une cible cardiaque dans une étape
 * de plan — et une étape écrit ses bornes en pourcentage de FC max (cf.
 * l'en-tête). L'ancrage, lui, intervient plus tard, quand ces bornes sont
 * résolues en battements. Un athlète qui aurait une FC seuil sans FC max ne
 * verrait donc pas ses séances prescrites en FC : c'est le comportement
 * conservateur d'avant, et le cas n'existe pas en pratique (le profil porte sa
 * FC max avant tout le reste — le TRIMP, la VO₂max et la validation des tests en
 * dépendent).
 */
export function canPrescribeHeartRate(maxHrBpm: number | null): boolean {
  if (maxHrBpm === null) return false;
  return hrZoneTargetBpm(EASY_HR_ZONE, { kind: 'max-hr', bpm: maxHrBpm }) !== null;
}
