/**
 * La **variété à l'intérieur des séances faciles**, écrite par l'appli.
 *
 * ## Le constat qui a ouvert ce module
 *
 * Première utilisatrice, premier plan généré : « pas trop de variété, beaucoup
 * de séances d'endurance ». La seconde moitié du reproche n'en est pas une — la
 * **proportion** d'endurance est juste et ne bouge pas d'ici (80/20, d'autant
 * plus fondé quand l'objectif est la perte de poids). La première, si : sur un
 * plan de 16 semaines à 4 séances, **tous les footings étaient écrits à
 * l'identique**. Semaine 3, lundi « Footing en endurance » 6,7 km ; jeudi
 * « Footing en endurance » 6,7 km. Deux jumeaux par semaine, seize semaines
 * durant, et une sortie longue toujours « en endurance » sans jamais un
 * progressif ni une fin appuyée.
 *
 * La cause était structurelle : le squelette écrivait ces séances avec un jour,
 * un `kind`, un titre et une distance, **sans `steps`**. Rien ne pouvait donc
 * varier. Ce module écrit ces déroulés-là — et rien d'autre : ni volume, ni
 * nombre de séances, ni proportion d'intensité.
 *
 * ## Ce que ces variations ne font pas
 *
 * **Elles ne fabriquent pas de qualité déguisée.** Le `kind` reste « Endurance
 * fondamentale » (donc `sessionPaceZone` = `easy`, donc `isIntensitySession` =
 * faux), et **aucune note ne déplace la zone d'une étape** : `STEP_NOTE_ZONES`
 * ne réagit qu'aux motifs « seuil/tempo » et « allure objectif / course /
 * spécifique / marathon », qu'aucun texte d'ici ne contient. Toutes les étapes
 * ressortent donc à l'allure d'endurance de la séance après `applyImposedPaces`.
 *
 * C'est délibéré, et c'est ce qui rend ces variations sûres : l'instruction
 * humaine vit dans la **note** (« accélère progressivement », « dans le haut de
 * la plage »), l'allure imposée reste prudente, et la répartition 80/20 du plan
 * est exactement celle d'avant. Une note « en tempo » aurait posé l'allure de
 * seuil sur ces blocs — un choix défendable pour un athlète confirmé, mais qui
 * déplace la proportion d'intensité que personne n'a demandé de bouger.
 *
 * Ce que la note ne peut pas faire, en revanche, c'est se prescrire : « dans le
 * haut de la plage » se lit, il ne se surveille pas. Les étapes concernées
 * portent donc un **sous-créneau** explicite ({@link EASY_HR_BANDS}) — deux
 * bornes en pourcentage de FC max, **à l'intérieur** de la plage d'endurance.
 * La cible change d'amplitude, jamais de zone : ni les durées, ni les distances,
 * ni le budget temps ne bougent, et un test le prouve.
 *
 * ## Une contrainte dure, et la seule exception qu'elle admet
 *
 * 1. **La couverture ne dépasse jamais la distance déclarée.** C'est la vraie
 *    règle, celle que la mesure impose : `imposedDistanceKm` remplace la
 *    distance déclarée par la couverture du déroulé dès que celle-ci lui est
 *    supérieure, et un déroulé en durée fait alors sortir 98,3 % des semaines de
 *    leur cible (matrice du test de propriété). D'où le principe : **une étape
 *    se mesure en distance dès que son intention est une distance**, et chaque
 *    constructeur pose son dernier segment par soustraction plutôt que par un
 *    second arrondi — la somme retombe au mètre près sur `distanceKm`.
 * 2. **L'exception est la ligne droite, et elle est bornée.** Son intention est
 *    une durée (« 20 s en accélérant »), donc sa mesure en est une
 *    ({@link STRIDE_S}) : la traduire en mètres écrivait sur la montre autre
 *    chose que ce que la séance prescrivait. Ce que sa durée coûte au budget
 *    kilométrique est réservé par un **majorant** ({@link STRIDE_RESERVE_M}),
 *    calculé sur le pire VDOT du domaine — la couverture d'un footing à lignes
 *    droites tombe donc légèrement *sous* sa distance déclarée, jamais au-dessus,
 *    et le piège des 98,3 % reste refermé.
 *
 * Module **pur** et strictement **déterministe** : la variation se décide du
 * numéro de semaine, de la phase et du rang du footing dans sa semaine — ni
 * horloge, ni aléa.
 */

import { PLAN_OUTPUT_BOUNDS } from '@/lib/ai/plan-schema';
import { EASY_HR_BANDS, type HrPercentBand } from '@/lib/metrics/hr-targets';
import type { PlanSessionSteps, PlanStep } from '@/lib/plan-steps/schema';

import type { PlanPhase } from './phases';

/**
 * Une étape mesurée en distance : toutes les clés, `null` pour le reste.
 *
 * @param band le **sous-créneau** d'endurance que l'étape vise, quand elle en
 * vise un autre que la plage entière. Ce n'est pas une cible posée — le module
 * n'en pose aucune, cf. l'en-tête — mais une précision que le post-traitement
 * honore en même temps qu'il pose la zone (`imposeStepPace`), et qu'il **efface**
 * quand la séance se prescrit finalement en allure. Sans elle, « le haut de la
 * plage » n'existe que dans la note, et la montre affiche la même cible du début
 * à la fin.
 */
export function distanceStep(
  role: PlanStep['role'],
  distanceM: number,
  note: string,
  band: HrPercentBand | null = null,
): PlanStep {
  return {
    role,
    distanceM,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    hrPercentMin: band === null ? null : band.minPercentOfMax,
    hrPercentMax: band === null ? null : band.maxPercentOfMax,
    note,
  };
}

/**
 * Une étape mesurée en **durée** : le pendant de {@link distanceStep}, pour ce
 * qui se prescrit au chrono et pas au mètre.
 *
 * Le module n'en écrit qu'une sorte, et c'est délibéré (cf. {@link STRIDE_S}) :
 * tout ce qui se compte dans le budget kilométrique d'une semaine reste en
 * mètres, seul ce dont l'intention *est* une durée passe ici. Sans sous-créneau
 * cardiaque : les étapes chronométrées de ce module sont trop brèves pour qu'une
 * fréquence cardiaque veuille dire quoi que ce soit (`isShortStep`, dans
 * `lib/ai/plan-schema`).
 */
function durationStep(role: PlanStep['role'], durationS: number, note: string): PlanStep {
  return {
    role,
    distanceM: null,
    durationS,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    hrPercentMin: null,
    hrPercentMax: null,
    note,
  };
}

/**
 * Ce qu'un footing peut porter en plus de ses kilomètres.
 *
 * - `plain` : le footing nu, celui d'avant ce module — et il reste majoritaire.
 * - `strides` : les **lignes droites** de fin de séance, le grand classique.
 * - `hillStrides` : les mêmes en côte, la variante de la phase de base.
 * - `progressive` : trois tranches d'effort croissant sur toute la séance.
 */
export type EasyVariation = 'plain' | 'strides' | 'hillStrides' | 'progressive';

/** La variation d'une semaine, et le rang du footing qui la porte. */
export type WeeklyEasyVariation = {
  variation: EasyVariation;
  /**
   * Le rang (0-based, dans l'ordre des jours) du footing enrichi — celui-là et
   * aucun autre.
   *
   * **Un seul footing enrichi par semaine**, jamais deux : la variété ne se
   * gagne pas en chargeant toutes les séances faciles, elle se gagne en les
   * rendant différentes les unes des autres. Un footing nu à côté d'un footing
   * à lignes droites, c'est déjà deux séances distinctes.
   */
  index: number;
};

/**
 * En deçà de cette distance, un footing ne porte aucun déroulé.
 *
 * Cinq kilomètres : les lignes droites occupent 10 à 15 % de la séance, et sous
 * ce seuil la section finale pèserait plus que le footing qu'elle est censée
 * conclure. C'est aussi ce qui met les plans à très petit volume — les footings
 * de 2,5 km d'une athlète à 12 km par semaine — hors de portée de tout ceci :
 * ces séances-là n'ont pas de place pour autre chose que de courir.
 */
const EASY_VARIATION_MIN_KM = 5;

/**
 * Une ligne droite : **20 secondes**, et c'est une durée parce que c'en est une.
 *
 * ## Le défaut que cela corrige
 *
 * L'étape valait 90 m, avec pour consigne « ~20 s en accélérant
 * progressivement ». La prose disait le temps, la mesure disait la distance, et
 * c'est la mesure qui part sur la montre : intervals.icu recevait `90mtr` là où
 * la séance prescrivait vingt secondes — reproché tel quel par l'utilisatrice.
 * Or 90 m ne veut pas dire vingt secondes pour tout le monde : c'est 41 s à
 * VDOT 30 et 18 s à VDOT 90. Une accélération se compte au chrono, elle ne se
 * mesure pas au décamètre — d'autant que personne ne borne une ligne droite au
 * sol.
 *
 * La syntaxe d'intervals.icu porte les deux mesures depuis toujours
 * (`formatDurationToken` de `lib/plan-steps/intervals-syntax`), et le contrat
 * d'étapes aussi : il n'y avait rien à construire, seulement une intention à
 * cesser de traduire.
 *
 * Ce n'est pas un sprint et ce n'est pas une répétition : c'est une accélération
 * progressive sur une foulée déjà chaude, qui entretient la mécanique sans coût
 * aérobie. Au-dessus du plancher de 5 s des étapes
 * (`PLAN_STEP_BOUNDS.durationS`), et sous les 60 s qu'`isShortStep` traite comme
 * trop brèves pour une cible cardiaque — ce qui laisse la ligne droite en
 * allure, comme il se doit.
 */
const STRIDE_S = 20;

/**
 * Ce qu'une ligne droite **coûte au budget kilométrique** de la séance, en
 * mètres.
 *
 * Une étape chronométrée ne porte pas de distance : la place qu'elle prend dans
 * une séance budgétée en kilomètres doit donc être réservée ici, à la main. Ce
 * n'est pas une conversion (la mesure de l'étape reste sa durée, du squelette
 * jusqu'à la montre), c'est le prix qu'on lui met de côté sur le corps du
 * footing.
 *
 * **100 m, et ce chiffre est un majorant, pas une moyenne.** La règle à ne pas
 * enfreindre est `couverture ≤ distance déclarée` : au-delà, `imposedDistanceKm`
 * remplace la distance de la séance par la couverture de son déroulé, et la
 * semaine sort de sa cible — c'est le piège mesuré à 98,3 % (cf. l'en-tête de
 * `skeleton.ts`), et les ancrages hebdomadaires ont par endroits 10 m de marge.
 * Le post-traitement convertit une étape chronométrée à l'allure qu'il lui a
 * posée, ici le milieu de la plage d'endurance ; sur tout le domaine de VDOT que
 * l'appli sait produire (30 à 90, bornes de `MAX_PLAUSIBLE_VO2MAX` dans
 * `lib/metrics/vdot`), 20 s couvrent de **41,6 m** (VDOT 30, E ≈ 8:01/km) à
 * **99,5 m** (VDOT 90, E ≈ 3:21/km). 100 m borne donc le pire cas, et le cas
 * courant sous-consomme sa réserve — une séance couvre un peu moins que sa
 * distance déclarée, jamais plus.
 *
 * **Exporté** parce que c'est un contrat, pas un détail : les tests qui
 * vérifient qu'un footing tombe sur son budget doivent compter la ligne droite
 * pour ce qu'elle réserve, et non pour ce qu'elle mesure.
 */
export const STRIDE_RESERVE_M = 100;

/**
 * Le trot entre deux lignes droites : 100 m, et **en distance**.
 *
 * Pourquoi celui-là reste au mètre quand l'accélération passe au chrono : sa
 * consigne ne promet aucune durée (« souffle complètement avant la suivante »),
 * et c'est lui qui garde l'arithmétique de la séance saine. Une réserve de plus
 * ({@link STRIDE_RESERVE_M}) devrait sinon majorer un second poste, et le corps
 * du footing paierait deux fois la prudence — pour un trot que personne ne
 * chronomètre. Il reste bien plus long que l'accélération : 100 m de trot font
 * une quarantaine de secondes à l'allure d'endurance, contre 20 s d'effort.
 *
 * **100 et non 110**, depuis que la réserve d'une ligne droite vaut 100 m : ce
 * qu'un passage coûte au budget (100 + 100) est ainsi un multiple de la centaine
 * de mètres, donc le corps du footing tombe sur la grille que tout ce module
 * respecte — « 7 km » et non « 6 950 m », qui ne se court pas. Accessoirement,
 * le dénominateur de {@link strideCount} ne bouge pas d'un mètre.
 */
const STRIDE_RECOVERY_M = 100;

/**
 * La part de la séance consacrée à la section de lignes droites, récupérations
 * comprises.
 *
 * ~12 % : c'est « les derniers 10 % » de la consigne classique, un peu élargis
 * parce que la moitié de la section est du trot de récupération. Le nombre de
 * lignes droites s'en déduit puis se borne à {@link STRIDE_COUNT}, ce qui fait
 * que la section pèse 16 % sur un footing de 5 km et 10 % sur un footing de
 * 12 km — dans les deux cas, une fin de séance, pas une séance.
 */
const STRIDES_SECTION_SHARE = 0.12;

/** 4 à 6 lignes droites : en dessous la consigne n'existe pas, au-dessus c'est une séance. */
const STRIDE_COUNT = { min: 4, max: 6 } as const;

/**
 * Les parts des deux premières tranches d'un footing progressif — la troisième
 * prend le reste.
 *
 * Décroissantes (40 %, 35 %, 25 %) : plus l'effort monte, plus la tranche est
 * courte. C'est ce qui distingue un progressif d'un tempo mal déguisé — la
 * séance reste très majoritairement souple, et ne finit soutenue que sur son
 * dernier quart.
 */
const PROGRESSIVE_SHARES = [0.4, 0.35] as const;

/** La part de la sortie longue courue en fin de parcours, un cran plus appuyée. */
const LONG_RUN_FINISH_SHARE = 0.2;

/**
 * Une sortie longue sur trois se termine appuyée.
 *
 * Une sur trois, et pas une sur deux : la sortie longue est déjà la séance la
 * plus coûteuse de la semaine, et lui ajouter une fin soutenue trop souvent
 * reviendrait à en faire une séance de qualité hebdomadaire de plus. Une sur
 * trois laisse deux semaines de récupération entre deux.
 */
const LONG_RUN_FINISH_EVERY = 3;

/**
 * En deçà de cette distance, une sortie longue ne se découpe pas : son dernier
 * cinquième ferait moins d'un kilomètre.
 */
const LONG_RUN_FINISH_MIN_KM = 6;

/**
 * La variation que porte une semaine, et le footing qui l'emporte.
 *
 * ## Le cadencement, et ce qui le fonde
 *
 * - **Semaine entamée, affûtage, semaine de course : rien.** La première semaine
 *   d'un plan démarré en cours de route ne sait pas ce qui a déjà été couru ;
 *   l'affûtage et la semaine de course écrivent des footings de *récupération*,
 *   dont le seul contrat est « plus lent que l'endurance » — y ajouter des
 *   accélérations les contredirait.
 * - **Phase de base : lignes droites une semaine, côtes courtes la suivante.**
 *   Les deux travaillent la même chose (la foulée, pas la filière), la côte en
 *   ajoutant du renforcement sans ajouter de vitesse. Alterner les deux fait
 *   quatre semaines de base qui ne se ressemblent pas deux à deux.
 * - **Développement et spécificité : lignes droites une semaine, footing
 *   progressif la suivante.** Le progressif est le plus exigeant des trois : il
 *   arrive quand le socle est posé, et jamais plus d'une semaine sur deux.
 *
 * La parité du **numéro de semaine dans le plan entier** porte l'alternance :
 * c'est un chiffre que l'appelant connaît toujours, y compris quand il ne
 * reconstruit que la fin d'un plan en cours.
 *
 * @param easyCount le nombre de footings de la semaine — aucun, aucune variation.
 */
export function weeklyEasyVariation(
  phase: PlanPhase,
  weekNumber: number,
  easyCount: number,
): WeeklyEasyVariation {
  const plain: WeeklyEasyVariation = { variation: 'plain', index: 0 };
  if (easyCount <= 0) return plain;

  const odd = weekNumber % 2 === 1;

  switch (phase) {
    case 'partial':
    case 'taper':
    case 'race':
      return plain;
    case 'base':
      // Les lignes droites prennent le **premier** footing de la semaine : c'est
      // celui qui suit la sortie longue ou la séance dure, donc celui qu'on court
      // le plus lentement — le meilleur endroit pour quelques accélérations.
      return { variation: odd ? 'strides' : 'hillStrides', index: 0 };
    case 'build':
    case 'specific':
      // Le progressif prend le **dernier** footing : il demande des jambes
      // fraîches, et les jours de fin de semaine sont les plus éloignés de la
      // séance dure du milieu de semaine.
      return odd
        ? { variation: 'strides', index: 0 }
        : { variation: 'progressive', index: easyCount - 1 };
  }
}

/** Une distance à la centaine de mètres : ce qu'un athlète peut lire sur sa montre. */
function roundHundredM(meters: number): number {
  return Math.round(meters / 100) * 100;
}

/** Le nombre de lignes droites que porte un footing de cette longueur. */
function strideCount(totalM: number): number {
  const raw = Math.round((totalM * STRIDES_SECTION_SHARE) / (STRIDE_RESERVE_M + STRIDE_RECOVERY_M));
  return Math.min(Math.max(raw, STRIDE_COUNT.min), STRIDE_COUNT.max);
}

/**
 * Le corps du footing, puis la section de lignes droites — deux blocs, pas un de
 * plus : ces séances partent vers intervals.icu en syntaxe native, et se lisent
 * sur une montre.
 *
 * Le bloc répété porte son étape de récupération, ce que
 * `sessionStepViolations` exige de tout bloc répété — et ce qu'un athlète
 * attend : une ligne droite se court sur un souffle refait.
 *
 * **La seule section du module qui mélange les deux mesures**, et c'est
 * l'intention de chaque étape qui tranche : l'accélération au chrono
 * ({@link STRIDE_S}), le trot au mètre ({@link STRIDE_RECOVERY_M}). Les notes ne
 * répètent plus la mesure — c'était le défaut d'origine, deux sources pour un
 * même fait, dont une seule arrivait sur la montre.
 */
function stridesSteps(totalM: number, uphill: boolean): PlanSessionSteps {
  const count = strideCount(totalM);
  const bodyM = totalM - count * (STRIDE_RESERVE_M + STRIDE_RECOVERY_M);

  return [
    { repeat: 1, steps: [distanceStep('run', bodyM, 'Footing en endurance, souple et régulier')] },
    {
      repeat: count,
      steps: [
        durationStep(
          'run',
          STRIDE_S,
          uphill
            ? 'Ligne droite en côte : accélère en montée, appui dynamique, buste droit'
            : 'Ligne droite : accélère progressivement, épaules relâchées',
        ),
        distanceStep(
          'recover',
          STRIDE_RECOVERY_M,
          uphill
            ? 'Redescends en trottinant, souffle complètement avant la suivante'
            : 'Trot de récupération, souffle complètement avant la suivante',
        ),
      ],
    },
  ];
}

/**
 * Le footing progressif : trois tranches, de plus en plus courtes et de plus en
 * plus soutenues.
 *
 * ## Les trois tranches sont de la course, y compris la première
 *
 * Elle portait le rôle `warmup`, ce qui la rendait **invisible** : sur une
 * séance d'endurance, l'enveloppe ne reçoit aucune cible (`envelopePaceZone`),
 * et cette tranche-là pèse 40 % de la séance. Quarante pour cent d'une séance
 * n'est pas une mise en route, c'est de la vraie course — elle prend donc le
 * rôle `run` et la cible qui va avec. Rien ne s'en trouve cassé :
 * `sessionStepViolations` n'exige d'échauffement que des séances d'intensité,
 * qu'un footing n'est pas (`isIntensitySession` se lit sur le `kind`).
 *
 * La progression se lit désormais dans les cibles elles-mêmes — bas, milieu,
 * haut de la plage d'endurance ({@link EASY_HR_BANDS}) — et plus seulement dans
 * les notes. Trois consignes distinctes, dont trois cibles distinctes, sans que
 * la séance sorte de l'endurance : le 80/20 du plan ne bouge pas d'un
 * pourcent.
 */
function progressiveSteps(totalM: number): PlanSessionSteps {
  // Des tranches à la centaine de mètres : « 2,3 km puis 2,0 km puis 1,4 km » se
  // court, « 1 995 m » ne se court pas. La dernière absorbe le reste des
  // arrondis, ce qui garde la couverture exacte.
  const firstM = roundHundredM(totalM * PROGRESSIVE_SHARES[0]);
  const secondM = roundHundredM(totalM * PROGRESSIVE_SHARES[1]);
  const thirdM = totalM - firstM - secondM;

  return [
    {
      repeat: 1,
      steps: [
        distanceStep(
          'run',
          firstM,
          'Départ très souple, sans regarder la montre',
          EASY_HR_BANDS.low,
        ),
      ],
    },
    {
      repeat: 1,
      steps: [
        distanceStep('run', secondM, 'Installe-toi en endurance, régulière', EASY_HR_BANDS.mid),
      ],
    },
    {
      repeat: 1,
      steps: [
        distanceStep(
          'run',
          thirdM,
          'Dernière tranche plus soutenue, dans le haut de la plage',
          EASY_HR_BANDS.high,
        ),
      ],
    },
  ];
}

/**
 * Le déroulé d'un footing enrichi — `undefined` quand la variation est `plain`
 * ou que la séance est trop courte pour porter quoi que ce soit
 * ({@link EASY_VARIATION_MIN_KM}), auquel cas l'appelant écrit un footing nu.
 *
 * Le déroulé **rend compte** de `distanceKm` au mètre près : le dernier segment
 * de chaque forme est posé par soustraction. Sur les lignes droites, la part
 * chronométrée y figure pour sa réserve ({@link STRIDE_RESERVE_M}) et non pour
 * une distance qu'elle n'a pas — la couverture réelle passe donc juste en
 * dessous, jamais au-dessus.
 */
export function easySessionSteps(
  variation: EasyVariation,
  distanceKm: number,
): PlanSessionSteps | undefined {
  if (variation === 'plain' || distanceKm < EASY_VARIATION_MIN_KM) return undefined;

  const totalM = Math.round(distanceKm * 1_000);
  if (variation === 'progressive') return progressiveSteps(totalM);
  return stridesSteps(totalM, variation === 'hillStrides');
}

/**
 * Le déroulé d'une sortie longue à fin appuyée — `undefined` partout ailleurs.
 *
 * Deux blocs : le parcours en endurance, puis son dernier cinquième un cran plus
 * haut. « Un cran plus haut » se dit désormais dans la **cible** et plus
 * seulement dans la note : le bloc final vise le haut de la plage d'endurance
 * ({@link EASY_HR_BANDS.high}), là où il portait exactement la même cible que
 * les 80 % qui le précèdent — donc rien de discernable sur la montre. Toujours
 * dans l'endurance, jamais un bloc à allure objectif, qui n'aurait aucun sens
 * sur un objectif libre.
 *
 * Les deux segments tombent sur la **centaine de mètres**, comme partout
 * ailleurs dans ce module : « 8,64 km puis 2,16 km » est sorti en production, et
 * un centième de kilomètre ne se court pas. Le corps est arrondi, la fin prend
 * le complément exact — la couverture vaut la distance déclarée au mètre, et
 * quand la distance est au dixième de kilomètre (ce que les budgets écrivent
 * toujours) les deux segments sont ronds.
 *
 * Réservé au développement et à la spécificité : la base construit, elle ne
 * finit pas ses sorties longues en appuyant.
 */
export function longRunFinishSteps(
  phase: PlanPhase,
  weekNumber: number,
  distanceKm: number,
): PlanSessionSteps | undefined {
  if (phase !== 'build' && phase !== 'specific') return undefined;
  if (weekNumber % LONG_RUN_FINISH_EVERY !== 0) return undefined;
  if (distanceKm < LONG_RUN_FINISH_MIN_KM) return undefined;

  const totalM = Math.round(distanceKm * 1_000);
  const bodyM = roundHundredM(totalM * (1 - LONG_RUN_FINISH_SHARE));
  const finishM = totalM - bodyM;

  return [
    {
      repeat: 1,
      steps: [distanceStep('run', bodyM, 'Sortie longue en endurance, allure régulière')],
    },
    {
      repeat: 1,
      steps: [
        distanceStep(
          'run',
          finishM,
          'Fin de parcours plus appuyée, dans le haut de la plage',
          EASY_HR_BANDS.high,
        ),
      ],
    },
  ];
}

/**
 * De combien le footing enrichi cède du terrain à un autre, en part de sa propre
 * distance.
 *
 * 10 % : assez pour que deux footings ne se lisent plus comme des jumeaux (6,4
 * et 6,3 km deviennent 5,8 et 6,9), assez peu pour qu'aucun des deux ne cesse
 * d'être un footing.
 */
const EASY_SPREAD_SHARE = 0.1;

/** Un kilométrage au dixième — la précision des budgets, et celle qui les fait tomber juste. */
function tenthKm(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Les distances des footings d'une semaine, **différenciées** : le footing qui
 * porte le déroulé cède {@link EASY_SPREAD_SHARE} de sa distance à un autre.
 *
 * ## Pourquoi différencier, et pourquoi comme ça
 *
 * `weeklySessionBudgets` partage ce qui reste après la sortie longue et la
 * qualité à parts égales : deux footings d'une même semaine en sortent égaux ou
 * séparés d'un dixième de kilomètre — 6,7 et 6,7 km, seize semaines durant.
 * Ce sont deux séances identiques sur la timeline, et c'est la moitié du
 * reproche de l'utilisatrice.
 *
 * Le footing **enrichi** est celui qui raccourcit : il porte déjà des
 * accélérations ou une fin soutenue, donc plus de sollicitation à distance
 * égale. L'autre absorbe les kilomètres et devient le footing long de la
 * semaine. Quand la semaine ne porte aucune variation (affûtage, semaine
 * entamée), `shortIndex` vaut 0 : le donneur est le premier **budget de
 * footing** reçu, ce qui est le premier footing écrit dans le cas courant —
 * court en début de semaine, long ensuite — mais le **deuxième** sur une
 * semaine entamée dont la sortie longue n'est pas plaçable, l'appelant empilant
 * alors son budget en tête des footings sans le soumettre au rééquilibrage.
 *
 * **La somme ne bouge pas** : ce qui est retiré à l'un est donné à l'autre, au
 * dixième près, sans quoi la semaine sortirait de sa cible.
 *
 * Quatre bornes, et chacune protège une règle ou l'intention même de la
 * différenciation :
 *
 * - le receveur ne dépasse pas `ceilingKm` — la sortie longue reste la séance la
 *   plus longue de sa semaine ;
 * - le donneur ne descend pas sous la plus petite distance du contrat de sortie
 *   (`PLAN_OUTPUT_BOUNDS.distanceKm.min`) ;
 * - **le donneur ne descend pas sous {@link EASY_VARIATION_MIN_KM} quand il
 *   porte un déroulé** : sous ce seuil `easySessionSteps` n'écrit plus rien, et
 *   le rééquilibrage détruirait exactement la différence qu'il cherche à créer —
 *   deux footings nus séparés d'un kilomètre au lieu d'un footing à lignes
 *   droites et d'un footing long. Mesuré sur le plan de l'utilisatrice après le
 *   dépeuplement des semaines de test : deux budgets de 5,2 km devenaient 5,7 et
 *   **4,7**, et la semaine du test était la seule du plan sans aucune variation.
 *   Ce plancher-là ne joue que s'il y a quelque chose à protéger : un donneur
 *   déjà sous le seuil ne porte aucun déroulé, et la différenciation par les
 *   distances reste alors sa seule variété ;
 * - un écart nul ne différencie rien : les budgets ressortent alors tels quels,
 *   ce qui est le cas des toutes petites semaines.
 *
 * @param shortIndex le rang du footing qui cède.
 * @param ceilingKm la distance à ne pas dépasser — celle de la sortie longue.
 * @param variation la variation que porte le donneur, dont dépend le plancher
 * qui lui est appliqué.
 */
export function spreadEasyDistances(
  kms: readonly number[],
  shortIndex: number,
  ceilingKm: number,
  variation: EasyVariation = 'plain',
): number[] {
  if (kms.length < 2) return [...kms];

  const giver = Math.min(Math.max(shortIndex, 0), kms.length - 1);
  // Le receveur est le footing le plus éloigné du donneur dans la semaine : le
  // dernier, ou le premier quand c'est le dernier qui cède.
  const taker = giver === kms.length - 1 ? 0 : kms.length - 1;

  // Le plancher de déroulé ne protège que ce qui existe : un donneur déjà trop
  // court pour porter quoi que ce soit n'a rien à perdre, et le lui appliquer
  // reviendrait à renoncer à la différenciation au nom d'un déroulé qui n'aurait
  // pas été écrit de toute façon.
  const keepsSteps = variation !== 'plain' && kms[giver] >= EASY_VARIATION_MIN_KM;
  const giverFloorKm = keepsSteps
    ? Math.max(PLAN_OUTPUT_BOUNDS.distanceKm.min, EASY_VARIATION_MIN_KM)
    : PLAN_OUTPUT_BOUNDS.distanceKm.min;

  const wanted = tenthKm(kms[giver] * EASY_SPREAD_SHARE);
  const room = tenthKm(ceilingKm - kms[taker]);
  const floor = tenthKm(kms[giver] - giverFloorKm);
  const delta = Math.min(wanted, room, floor);
  if (delta <= 0) return [...kms];

  return kms.map((km, index) => {
    if (index === giver) return tenthKm(km - delta);
    if (index === taker) return tenthKm(km + delta);
    return km;
  });
}
