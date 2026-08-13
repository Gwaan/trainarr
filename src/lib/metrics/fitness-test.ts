/**
 * Ce qu'on accepte de conclure d'un **test chronométré**, et à quelles
 * conditions.
 *
 * Le plan pose des tests dans sa périodisation
 * (`plan-skeleton/fitness-test.ts`) ; ce module-ci décide de ce qu'on fait du
 * chrono qui en sort. C'est un module de **décision**, pur et sans base : il
 * reçoit ce que l'activité a mesuré et l'état du plan, il rend un verdict.
 *
 * ## Pourquoi une mise à jour automatique est légitime ici
 *
 * Parce qu'un test est une **mesure externe**. Le cliquet mesuré ailleurs sur ce
 * projet (42 → 215 km en neuf réadaptations) venait d'une boucle fermée sur
 * l'obéissance : « tu as couru ce que je t'ai prescrit, donc je prescris plus ».
 * Rien de tel ici — la sortie d'un test ne dépend pas de ce que le plan a
 * prescrit, elle dépend de ce que l'athlète vaut ce jour-là. Aucune boucle,
 * donc aucun emballement.
 *
 * ## L'asymétrie, et pourquoi elle est l'inverse de celle des volumes
 *
 * Les volumes, eux, ne se réadaptent qu'**à la baisse** : une semaine réalisée
 * au-delà du prescrit ne fait jamais monter la cible, précisément à cause de la
 * boucle. Le chrono de référence obéit à la règle **inverse**, et pour la même
 * raison de fond — ce qui est fiable, ici, c'est la mesure :
 *
 * - un test **meilleur** que la référence la met à jour. Un chrono qu'on vient
 *   de courir est une donnée plus récente et plus juste que celui d'il y a trois
 *   mois ;
 * - un test **moins bon** ne dégrade **rien**. Daniels est explicite : on ne
 *   baisse pas un VDOT sur une contre-performance isolée. Un mauvais jour, du
 *   vent, de la chaleur, une nuit courte, un parcours vallonné — toutes ces
 *   causes produisent le même chiffre qu'une perte de forme, et aucune ne la
 *   prouve. Il faudrait une confirmation sur un second test ou l'accord explicite
 *   de l'athlète, et ni l'un ni l'autre n'est une décision d'algorithme : le
 *   verdict le dit à l'athlète ({@link FitnessTestVerdict}), qui garde la main
 *   sur son chrono de référence dans les réglages du plan.
 *
 * ## Ce qu'on refuse de conclure, et pourquoi c'est la moitié du module
 *
 * Un chrono ne vaut que si l'effort était **maximal** : le VDOT de Daniels
 * déduit l'intensité de la seule durée, en postulant que l'athlète a donné tout
 * ce qu'elle pouvait tenir (cf. l'en-tête de `./vdot`). Appliqué à un 5 km couru
 * en tempo, il rend un VDOT très inférieur au vrai — et comme la règle
 * ci-dessus refuse toute baisse, le pire cas est inoffensif. Mais l'inverse
 * compte : accepter un chrono dont on ne sait rien reviendrait à laisser une
 * séance mal identifiée recalibrer tout un plan. D'où la validation par la
 * fréquence cardiaque ({@link MAXIMAL_EFFORT_HR_SHARE}), et le refus net quand
 * elle manque.
 *
 * ## Lacune assumée
 *
 * Aucun essai contrôlé ne montre qu'un plan avec tests intégrés bat un plan sans.
 * C'est une pratique consensuelle d'entraîneur, pas une intervention validée.
 */

import { estimateVdot } from './vdot';

/**
 * La part de la FC max du profil qu'un effort doit atteindre pour être tenu pour
 * **maximal**.
 *
 * 95 %. C'est le critère secondaire usuel de « effort maximal atteint » dans les
 * protocoles de VO2max de terrain, aux côtés de la perception d'effort et du
 * plateau de consommation : un 5 km à fond dure une vingtaine de minutes et se
 * termine à la fréquence cardiaque maximale ou tout près.
 *
 * Le seuil est **permissif à dessein**, et dans le bon sens : à 184 bpm de FC
 * max, il demande 175 bpm. Une athlète qui a réellement fini vidée les atteint ;
 * un footing rapide ou une séance de seuil, non — le seuil se court autour de
 * 85-90 % de FC max. Le placer plus haut (98 %) ferait rejeter des tests
 * parfaitement menés au motif que la FC max déclarée au profil est un peu
 * optimiste ; plus bas (90 %), une séance de seuil un peu appuyée passerait pour
 * un test.
 *
 * **Sans fréquence cardiaque, on ne conclut rien.** C'est la règle du projet —
 * ne jamais approximer une donnée physiologique manquante — et c'est aussi la
 * seule barrière entre « l'athlète a couru son test » et « l'athlète a couru
 * quelque chose ce jour-là ».
 */
export const MAXIMAL_EFFORT_HR_SHARE = 0.95;

/**
 * Le délai minimal entre deux mises à jour du chrono de référence, en jours.
 *
 * 28 jours : le bas de la fourchette de Daniels (« pas plus d'une mise à jour
 * toutes les 4 à 6 semaines »). Ce n'est pas de la prudence administrative — un
 * VDOT qui bougerait toutes les deux semaines ferait osciller **toutes** les
 * allures du plan, et l'athlète ne courrait jamais deux fois la même séance de
 * seuil.
 *
 * Le compteur part de la dernière mise à jour ; à défaut, du **premier jour du
 * plan**, date à laquelle le chrono de référence a été déclaré.
 */
export const REFERENCE_UPDATE_MIN_GAP_DAYS = 28;

/**
 * Le gain de VDOT en deçà duquel on ne bouge rien.
 *
 * **1,0 point**, et le chiffre sort de l'arithmétique de la mesure. Sur un 5 km
 * couru en 27:00 (VDOT 34,96) :
 *
 * - un point de VDOT vaut **38 s** de chrono ;
 * - une erreur de distance de 1 %, ordre de grandeur courant d'une trace GPS,
 *   vaut **0,42 point** (5 000 m lus pour 4 951 m réellement courus donnent
 *   35,38 au lieu de 34,96) ;
 * - il faut **2,4 %** de sur-lecture pour atteindre le point plein (35,96).
 *
 * Un demi-point — la valeur d'origine — était **sous** le bruit et non
 * au-dessus : mesuré, 1,2 % de sur-lecture suffisait à le franchir (+0,506).
 * Une montre qui mesure long systématiquement (tunnel, sous-bois, tapis) aurait
 * donc produit un `improved` fictif à chaque fenêtre de cadence, et fait
 * accélérer les allures sans progrès réel — une dérive lente vers des allures
 * intenables. Le point plein demande 38 s de mieux sur 5 km : une erreur de
 * trace ne les fabrique pas.
 *
 * Le point est aussi le **pas de la table de Daniels**, dont les entrées vont de
 * VDOT en VDOT : on ne prétend donc pas mesurer plus fin que la méthode dont on
 * se sert.
 */
export const MIN_VDOT_GAIN = 1;

/** Ce que l'appelant sait du test et de l'état du plan, au moment de décider. */
export type FitnessTestInput = {
  /**
   * Le temps du **meilleur 5 km continu** de l'activité, en secondes — `null`
   * quand l'activité n'en contient pas (moins de 5 km, ou pas de série de
   * distance exploitable).
   *
   * C'est `computeBestSegments` (`./best-segments`) qui l'isole, et c'est le
   * seul moyen honnête dont on dispose : le fichier FIT ne porte pas de
   * marqueur « ici commence le test », et les tours de montre sont ce que
   * l'auto-lap a découpé. Les limites de cette isolation sont écrites dans
   * {@link fitnessTestVerdict}.
   */
  bestFiveKTimeS: number | null;
  /** La FC max atteinte pendant l'activité, `null` sans capteur cardiaque. */
  activityMaxHrBpm: number | null;
  /** La FC max du **profil**, `null` quand l'athlète ne l'a pas saisie. */
  profileMaxHrBpm: number | null;
  /** Le VDOT du chrono de référence en vigueur sur le plan. */
  referenceVdot: number;
  /**
   * Jours écoulés depuis la dernière mise à jour du chrono de référence — ou,
   * à défaut, depuis le premier jour du plan, où il a été déclaré.
   */
  daysSinceReference: number;
};

/**
 * Ce qu'on conclut d'un test, et **pourquoi** — le motif fait partie du
 * verdict, parce que l'athlète doit pouvoir lire ce qui s'est passé même quand
 * rien ne bouge (« aucun recalcul silencieux »).
 */
export type FitnessTestVerdict =
  /** Le chrono de référence est mis à jour : 5 km en `timeS`, nouveau VDOT. */
  | { outcome: 'improved'; timeS: number; vdot: number; gain: number }
  /**
   * Le test a bien eu lieu, il n'est pas meilleur : **rien ne bouge**. Ni
   * dégradation, ni allures recalculées.
   */
  | { outcome: 'not-improved'; timeS: number; vdot: number }
  /** L'effort ne ressemble pas à un test maximal, ou la FC manque pour le dire. */
  | { outcome: 'not-maximal'; reason: string }
  /** La cadence de Daniels n'est pas respectée : trop tôt depuis la dernière mise à jour. */
  | { outcome: 'too-soon'; daysToWait: number }
  /** Rien d'exploitable : pas de 5 km continu, ou un chrono hors du domaine du modèle. */
  | { outcome: 'unmeasurable'; reason: string };

/** La distance du test, en mètres — l'invariant du format (cf. `plan-skeleton/fitness-test.ts`). */
const TEST_DISTANCE_M = 5_000;

/**
 * Ce qu'on fait du chrono d'un test — le verdict complet, motif compris.
 *
 * L'ordre des refus n'est pas indifférent : on vérifie d'abord ce qui ne dépend
 * pas de la mesure (la cadence), puis ce qui la rend exploitable (l'effort
 * maximal), puis la mesure elle-même. Un test couru trop tôt n'a pas besoin
 * qu'on discute de sa fréquence cardiaque.
 *
 * ## Comment l'effort est isolé, et ce que cette méthode ne garantit pas
 *
 * L'activité contient l'échauffement, les 5 km et le retour au calme : le chrono
 * cherché est celui du **meilleur 5 km continu** de la séance
 * (`computeBestSegments`). Sur une séance dont le seul bloc rapide est le test,
 * cette fenêtre coïncide avec l'effort à quelques mètres près — tout décalage
 * l'obligerait à mordre sur l'échauffement ou le retour au calme, donc à
 * ralentir.
 *
 * Trois limites, et il faut les avoir en tête avant de croire le chiffre :
 *
 * 1. **La fenêtre est par construction au plus égale à l'effort réel.** Si
 *    l'athlète a couru 5,2 km à fond, on retient ses 5 000 m les plus rapides —
 *    donc un chrono légèrement meilleur que son « départ-arrivée ». Le biais est
 *    du côté optimiste, et il est petit ; il est borné par ce qui suit.
 * 2. **La précision de la trace.** Une erreur de 1 % sur la distance mesurée
 *    vaut 0,42 point de VDOT, et il en faut 2,4 % pour atteindre le point plein
 *    (cf. {@link MIN_VDOT_GAIN}) — c'est ce que le seuil de gain absorbe.
 * 3. **Rien ne prouve que la fenêtre est le test.** Si l'athlète a couru autre
 *    chose ce jour-là (une sortie longue rapide, une course), c'est cette
 *    séance-là qu'on mesure. La validation d'effort maximal est ce qui rend le
 *    cas inoffensif : une séance qui atteint 95 % de FC max sur cinq kilomètres
 *    **est** un effort maximal, quel que soit le nom qu'on lui donne.
 */
export function fitnessTestVerdict(input: FitnessTestInput): FitnessTestVerdict {
  const {
    bestFiveKTimeS,
    activityMaxHrBpm,
    profileMaxHrBpm,
    referenceVdot,
    daysSinceReference,
  } = input;

  if (daysSinceReference < REFERENCE_UPDATE_MIN_GAP_DAYS) {
    return {
      outcome: 'too-soon',
      daysToWait: REFERENCE_UPDATE_MIN_GAP_DAYS - daysSinceReference,
    };
  }

  if (profileMaxHrBpm === null || !Number.isFinite(profileMaxHrBpm) || profileMaxHrBpm <= 0) {
    return {
      outcome: 'not-maximal',
      reason:
        "aucune FC max au profil : sans elle, rien ne dit que l'effort était maximal, et un chrono dont on ne sait rien ne recalibre pas un plan",
    };
  }
  if (activityMaxHrBpm === null || !Number.isFinite(activityMaxHrBpm)) {
    return {
      outcome: 'not-maximal',
      reason: "la séance ne porte aucune fréquence cardiaque : l'effort n'est pas vérifiable",
    };
  }

  const required = profileMaxHrBpm * MAXIMAL_EFFORT_HR_SHARE;
  if (activityMaxHrBpm < required) {
    return {
      outcome: 'not-maximal',
      reason:
        `FC max atteinte ${Math.round(activityMaxHrBpm)} bpm, sous les ` +
        `${Math.round(required)} bpm attendus d'un effort maximal ` +
        `(${Math.round(MAXIMAL_EFFORT_HR_SHARE * 100)} % de ${Math.round(profileMaxHrBpm)} bpm)`,
    };
  }

  if (bestFiveKTimeS === null || !Number.isFinite(bestFiveKTimeS) || bestFiveKTimeS <= 0) {
    return {
      outcome: 'unmeasurable',
      reason: "la séance ne contient aucun 5 km continu mesurable (distance absente ou trop courte)",
    };
  }

  const vdot = estimateVdot({ distanceM: TEST_DISTANCE_M, movingTimeS: bestFiveKTimeS });
  if (vdot === null) {
    return {
      outcome: 'unmeasurable',
      reason: `5 km en ${Math.round(bestFiveKTimeS)} s : hors du domaine de validité du modèle de Daniels`,
    };
  }

  const gain = vdot - referenceVdot;
  if (gain < MIN_VDOT_GAIN) return { outcome: 'not-improved', timeS: bestFiveKTimeS, vdot };

  return { outcome: 'improved', timeS: bestFiveKTimeS, vdot, gain };
}
